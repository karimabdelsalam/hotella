import { sql } from 'drizzle-orm';
import {
  ComplaintOpened,
  type EventEnvelope,
  RoomRestrictionChanged,
  SlaBreached,
  WorkItemCreated,
  WorkOrderClosed,
} from '@hotella/contracts-events';
import { newId } from '@hotella/platform-database';
import { IdempotentConsumer } from '@hotella/platform-events';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI_TWIN_CONSUMER } from './ai.module';
import { PulseService } from './application/pulse.service';
import { ModelProviderRegistry } from './application/provider-registry';
import { FakeModelProvider } from './application/providers/fake';
import type { CompletionRequest } from './application/providers/types';
import { SignalRecorder } from './application/signal-recorder';
import { ToolRegistry } from './application/tools/registry';
import { TwinProjector } from './application/twin.service';
import {
  ADMIN,
  type AiHarness,
  createHotel,
  type Hotel,
  staff,
  startAiApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

/** The model: the Manager assistant reads the pulse and insights, consults the copilot (or compares), then answers. */
function model(plan: { compare: boolean }) {
  return (request: CompletionRequest) => {
    const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
    const tools = request.messages.filter((m) => m.role === 'tool').length;
    const answer = (text: string) => ({ content: JSON.stringify({ answer: text }) });
    if (system.includes('You are the Engineering Copilot'))
      return answer('The AC in room 504 keeps leaking refrigerant: replace the compressor seal.');
    if (!system.includes('You are the Manager assistant')) return answer('?');
    const call = (name: string, args: Record<string, unknown>) => ({
      toolCalls: [{ id: `t${tools}`, name, arguments: args }],
    });
    if (plan.compare) return tools === 0 ? call('intelligence__compare', {}) : answer('Compared.');
    if (tools === 0) return call('intelligence__pulse', {});
    if (tools === 1) return call('intelligence__insights', {});
    if (tools === 2)
      return call('agents__consult', {
        agent: 'ENGINEERING_COPILOT',
        question: 'Why does the AC of room 504 keep failing?',
      });
    return answer(
      'Room 504’s AC failed three times this month; engineering suggests a new compressor seal.',
    );
  };
}

describe.skipIf(needsInfra())(`Manager assistant (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const groupId = newId();
  const clerkId = newId();
  const otherId = newId();
  const fake = new FakeModelProvider();
  const plan = { compare: false };
  let h: AiHarness;
  let hotel: Hotel;
  let other: Hotel;
  const asset = newId();
  const workItem = newId();
  const gm = () => staff(gmId, hotel.tenantId);

  const deliver = (def: { type: string; version: number }, payload: unknown, at: string) => {
    const envelope: EventEnvelope = {
      event_id: newId(),
      event_type: def.type,
      event_version: def.version,
      tenant_id: hotel.tenantId,
      property_id: hotel.propertyId,
      source: 'test',
      source_reference: null,
      occurred_at: at,
      received_at: at,
      correlation_id: `manager-${stamp}`,
      payload,
    };
    return h.app.get(IdempotentConsumer).once(AI_TWIN_CONSUMER, envelope, async (e) => {
      await h.app.get(TwinProjector).project(e);
      await h.app.get(SignalRecorder).record(e);
    });
  };
  const ask = (question: string, actor = gm()) =>
    h
      .http()
      .post(`/properties/${hotel.propertyId}/ai/manager`)
      .set('X-Test-Actor', actor)
      .send({ question });
  const steps = async (executionId: string) =>
    (
      await h.db.execute(
        sql`select type, name, outcome, summary from ai.execution_steps where execution_id = ${executionId} order by created_at, id`,
      )
    ).rows as Array<{
      type: string;
      name: string;
      outcome: string;
      summary: Record<string, unknown>;
    }>;

  beforeAll(async () => {
    const base = [
      'org.property.read',
      'org.property.manage',
      'org.location.manage',
      'org.department.manage',
      'catalog.read',
      'catalog.manage',
      'ai.routing.manage',
    ];
    const manager = ['ai.manager.use', 'ai.insight.read', 'ai.insight.act', 'ai.twin.read'];
    h = await startAiApp(url, 'hotella_app_ai_manager', {
      [gmId]: [...base, ...manager, 'eng.asset.read', 'eng.work_order.read'],
      [groupId]: [...base, ...manager, 'ai.intelligence.cross_property'],
      [clerkId]: ['org.property.read', 'ai.insight.read'],
      [otherId]: [...base, ...manager, 'ai.intelligence.cross_property'],
    });
    fake.reply(...Array.from({ length: 100 }, () => model(plan)));
    h.app.get(ModelProviderRegistry).register(fake);
    hotel = await createHotel(h, `ai-mgr-${stamp}`, gmId);
    other = await createHotel(h, `ai-mgr-b-${stamp}`, otherId);
    const providerId = (
      await h
        .http()
        .post('/ai/providers')
        .set('X-Test-Actor', ADMIN)
        .send({ code: `MGR_${stamp}`, kind: 'FAKE', egress: 'ON_PREM', maxDataClass: 'SENSITIVE' })
        .expect(201)
    ).body.id;
    const modelId = (
      await h
        .http()
        .post('/ai/models')
        .set('X-Test-Actor', ADMIN)
        .send({ providerId, code: `mgr-${stamp}`, capabilities: ['REASONING_HIGH'] })
        .expect(201)
    ).body.id;
    await h
      .http()
      .put('/ai/routing-rules')
      .set('X-Test-Actor', gm())
      .send({ capability: 'REASONING_HIGH', modelIds: [modelId], propertyId: hotel.propertyId })
      .expect(200);

    // Today at the hotel: open engineering work that breached, an open complaint, a room out of order, and the AC
    // of room 504 repaired three times this month.
    await deliver(
      WorkItemCreated,
      {
        work_item_id: workItem,
        kind: 'ENG_WORK_ORDER',
        source_module: 'eng',
        source_entity_type: 'work_order',
        source_entity_id: newId(),
        priority: 'HIGH',
        department_code: 'ENG',
        location_id: hotel.roomId,
        stay_id: null,
        task_ids: [],
      },
      ago(6),
    );
    await deliver(
      SlaBreached,
      { sla_instance_id: newId(), work_item_id: workItem, target: 'RESPONSE', due_at: ago(2) },
      ago(2),
    );
    await deliver(
      ComplaintOpened,
      {
        complaint_id: newId(),
        number: 1,
        category_code: 'NOISE',
        severity: 'HIGH',
        source: 'STAFF',
        stay_id: null,
      },
      ago(3),
    );
    await deliver(
      RoomRestrictionChanged,
      { restriction_id: newId(), room_id: hotel.roomId, kind: 'OOO', active: true },
      ago(1),
    );
    for (const days of [3, 10, 20])
      await deliver(
        WorkOrderClosed,
        {
          work_order_id: newId(),
          asset_id: asset,
          type: 'CORRECTIVE',
          status: 'DONE',
          symptom_code: null,
          failure_mode_code: 'REFRIGERANT_LEAK',
          cause_code: 'WEAR',
          resolution_code: 'RECHARGED',
          downtime_minutes: 30,
        },
        ago(days * 24),
      );
    await h
      .http()
      .post(`/properties/${hotel.propertyId}/insights/detect`)
      .set('X-Test-Actor', gm())
      .expect(200);
  });
  afterAll(() => h?.app.close());

  it('the pulse counts what is happening, deterministically', async () => {
    const pulse = await h.app
      .get(PulseService)
      .pulse({ tenantId: hotel.tenantId, propertyId: hotel.propertyId });
    expect(pulse).toMatchObject({
      openWork: { total: 1, byDepartment: { ENG: 1 } },
      slaBreaches24h: { total: 1, byDepartment: { ENG: 1 } },
      openComplaints: { total: 1, bySeverity: { HIGH: 1 } },
      roomsRestricted: { total: 1, byKind: { OOO: 1 } },
      arrivalsTomorrow: { count: 0 },
      liveInsights: { total: 1, bySeverity: { MEDIUM: 1 } },
    });
  });

  it('the Intelligence screen reads the same pulse over HTTP (ai.insight.read)', async () => {
    const pulse = (
      await h
        .http()
        .get(`/properties/${hotel.propertyId}/ai/pulse`)
        .set('X-Test-Actor', gm())
        .expect(200)
    ).body;
    expect(pulse.openWork).toEqual({ total: 1, byDepartment: { ENG: 1 } });
    await h
      .http()
      .get(`/properties/${hotel.propertyId}/ai/pulse`)
      .set('X-Test-Actor', staff(otherId, other.tenantId))
      .expect(404);
  });

  it('answers "what needs my attention today" from tools only, consulting the Engineering Copilot once', async () => {
    const body = (await ask('What needs my attention today?').expect(200)).body;
    expect(body).toMatchObject({ outcome: 'ANSWERED' });
    expect(body.answer).toContain('compressor seal');
    const mine = await steps(body.executionId);
    expect(mine.filter((s) => s.type === 'TOOL_CALL').map((s) => `${s.name}:${s.outcome}`)).toEqual(
      ['intelligence.pulse:OK', 'intelligence.insights:OK', 'agents.consult:OK'],
    );
    const consult = mine.find((s) => s.type === 'DECISION' && s.name === 'consult')!;
    expect(consult).toMatchObject({
      outcome: 'ANSWERED',
      summary: { agent: 'ENGINEERING_COPILOT' },
    });
    const child = (
      await h.db.execute(
        sql`select agent_code, parent_execution_id, actor_type, actor_id, status from ai.executions where id = ${consult.summary.child_execution_id as string}`,
      )
    ).rows[0];
    expect(child).toEqual({
      agent_code: 'ENGINEERING_COPILOT',
      parent_execution_id: body.executionId,
      actor_type: 'USER',
      actor_id: gmId,
      status: 'COMPLETED',
    });
    // The model saw the exact pulse numbers as a tool result.
    const sawPulse = fake.requests.some((r) =>
      r.request.messages.some((m) => m.role === 'tool' && m.content.includes('"slaBreaches24h"')),
    );
    expect(sawPulse).toBe(true);
  });

  it('consults only from the Manager assistant, one level deep', async () => {
    const consult = h.app.get(ToolRegistry).get('agents.consult')!;
    const [manager] = (
      await h.db.execute(
        sql`select id from ai.executions where tenant_id = ${hotel.tenantId} and agent_code = 'MANAGER_ASSIST' order by started_at limit 1`,
      )
    ).rows as Array<{ id: string }>;
    const [child] = (
      await h.db.execute(
        sql`select id from ai.executions where parent_execution_id = ${manager!.id} limit 1`,
      )
    ).rows as Array<{ id: string }>;
    const ctx = (agentCode: string, executionId: string) => ({
      tenantId: hotel.tenantId,
      propertyId: hotel.propertyId,
      executionId,
      agentCode,
      locale: 'en',
      guest: null,
      conversationId: null,
    });
    const args = { agent: 'ENGINEERING_COPILOT', question: 'Anything?' };
    await expect(consult.handle(args, ctx('ENGINEERING_COPILOT', child!.id))).rejects.toMatchObject(
      {
        code: 'ai.consult.not_allowed',
      },
    );
    await expect(consult.handle(args, ctx('MANAGER_ASSIST', child!.id))).rejects.toMatchObject({
      code: 'ai.consult.too_deep',
    });
  });

  it('compares the group only for a person allowed to; the report never crosses tenants', async () => {
    plan.compare = true;
    const refused = (await ask('How do our hotels compare?').expect(200)).body;
    expect(
      (await steps(refused.executionId)).find((s) => s.name === 'intelligence.compare')?.outcome,
    ).not.toBe('OK');
    const allowed = (
      await ask('How do our hotels compare?', staff(groupId, hotel.tenantId)).expect(200)
    ).body;
    expect(
      (await steps(allowed.executionId)).find((s) => s.name === 'intelligence.compare')?.outcome,
    ).toBe('OK');
    plan.compare = false;

    const report = (
      await h
        .http()
        .get(`/tenants/${hotel.tenantId}/intelligence/compare`)
        .set('X-Test-Actor', staff(groupId, hotel.tenantId))
        .expect(200)
    ).body;
    expect(report.properties.map((p: { property_id: string }) => p.property_id)).toEqual([
      hotel.propertyId,
    ]);
    expect(report.properties[0].pulse.openWork.total).toBe(1);
    await h
      .http()
      .get(`/tenants/${hotel.tenantId}/intelligence/compare`)
      .set('X-Test-Actor', gm())
      .expect(403);
    await h
      .http()
      .get(`/tenants/${hotel.tenantId}/intelligence/compare`)
      .set('X-Test-Actor', staff(otherId, other.tenantId))
      .expect(404);
    // A clerk without ai.manager.use cannot ask at all.
    await ask('Hello?', staff(clerkId, hotel.tenantId)).expect(403);
  });
});
