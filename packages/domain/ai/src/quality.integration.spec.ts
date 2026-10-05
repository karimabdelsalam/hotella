import { sql } from 'drizzle-orm';
import {
  type EventEnvelope,
  ServiceRequestCreated,
  ServiceRequestStatusChanged,
} from '@hotella/contracts-events';
import { newId } from '@hotella/platform-database';
import { IdempotentConsumer } from '@hotella/platform-events';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI_TWIN_CONSUMER } from './ai.module';
import { AgentCatalog } from './application/agent-catalog';
import { SignalRecorder } from './application/signal-recorder';
import { TwinProjector } from './application/twin.service';
import { GUEST_SESSION_HEADER } from '@hotella/domain-guest/public';
import {
  type AiHarness,
  createHotel,
  guestToken,
  type Hotel,
  staff,
  startAiApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();
const DAY = '2026-09-30';
const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 8, 30, hour, minute));

describe.skipIf(needsInfra())(`AI quality metrics (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const clerkId = newId();
  const otherId = newId();
  let h: AiHarness;
  let hotel: Hotel;
  let other: Hotel;
  let version: string;
  let conversation: string;
  const gm = () => staff(gmId, hotel.tenantId);
  const base = () => `/properties/${hotel.propertyId}/ai/quality`;

  const execution = async (values: {
    trigger?: string;
    status: string;
    startedAt: Date;
    cost?: number;
    conversationId?: string | null;
  }) => {
    const id = newId();
    await h.db.execute(sql`insert into ai.executions
      (id, tenant_id, property_id, agent_code, agent_version_id, trigger, actor_type, actor_id, conversation_id, status, cost_minor, started_at)
      values (${id}, ${hotel.tenantId}, ${hotel.propertyId}, 'GUEST_CONCIERGE', ${version}, ${values.trigger ?? 'MESSAGE'},
              'GUEST', null, ${values.conversationId === undefined ? conversation : values.conversationId}, ${values.status},
              ${values.cost ?? 10}, ${values.startedAt})`);
    return id;
  };
  const step = (executionId: string, outcome: string) =>
    h.db
      .execute(sql`insert into ai.execution_steps (id, tenant_id, execution_id, type, name, outcome)
      values (${newId()}, ${hotel.tenantId}, ${executionId}, 'TOOL_CALL', 'catalog.list_services', ${outcome})`);
  const proposal = (executionId: string, status: string) =>
    h.db.execute(sql`insert into ai.action_proposals
      (id, tenant_id, property_id, execution_id, tool_code, arguments, context, risk, status, expires_at)
      values (${newId()}, ${hotel.tenantId}, ${hotel.propertyId}, ${executionId}, 'operations.cancel_service_request',
              '{}'::jsonb, '{}'::jsonb, 'HIGH', ${status}, now())`);
  const deliver = (def: { type: string; version: number }, payload: unknown, when: Date) => {
    const envelope: EventEnvelope = {
      event_id: newId(),
      event_type: def.type,
      event_version: def.version,
      tenant_id: hotel.tenantId,
      property_id: hotel.propertyId,
      source: 'test',
      source_reference: null,
      occurred_at: when.toISOString(),
      received_at: when.toISOString(),
      correlation_id: `quality-${stamp}`,
      payload,
    };
    return h.app.get(IdempotentConsumer).once(AI_TWIN_CONSUMER, envelope, async (e) => {
      await h.app.get(TwinProjector).project(e);
      await h.app.get(SignalRecorder).record(e);
    });
  };

  beforeAll(async () => {
    const base = [
      'org.property.read',
      'org.property.manage',
      'org.location.manage',
      'org.department.manage',
      'catalog.read',
      'catalog.manage',
    ];
    h = await startAiApp(url, 'hotella_app_ai_quality', {
      [gmId]: [...base, 'ai.quality.read'],
      [clerkId]: ['org.property.read'],
      [otherId]: [...base, 'ai.quality.read'],
    });
    hotel = await createHotel(h, `ai-q-${stamp}`, gmId);
    other = await createHotel(h, `ai-q-b-${stamp}`, otherId);
    version = (await h.app.get(AgentCatalog).published('GUEST_CONCIERGE')).versionId;
    const token = await guestToken(h, hotel);
    await h
      .http()
      .post('/guest/conversation/messages')
      .set(GUEST_SESSION_HEADER, token)
      .send({ body: 'Hello' })
      .expect(201);
    conversation = (
      await h.http().get('/guest/conversation').set(GUEST_SESSION_HEADER, token).expect(200)
    ).body.conversation.id;

    // A day of the concierge in one conversation: a reply the guest followed up within the hour, a failure, and a last
    // reply nobody followed up.
    const first = await execution({ status: 'COMPLETED', startedAt: at(9) });
    await execution({ status: 'FAILED', startedAt: at(10) });
    await execution({ status: 'COMPLETED', startedAt: at(15) });
    // Evaluation runs are not service to anyone.
    await execution({
      trigger: 'EVALUATION',
      status: 'FAILED',
      startedAt: at(11),
      conversationId: null,
      cost: 999,
    });
    await step(first, 'OK');
    await step(first, 'OK');
    await step(first, 'ERROR');
    await proposal(first, 'REJECTED');
    await proposal(first, 'EXECUTED');
    await proposal(first, 'PENDING');
    await h.db
      .execute(sql`insert into ai.feedback (id, tenant_id, property_id, execution_id, kind, edit_distance, actor_type, source_ref)
      values (${newId()}, ${hotel.tenantId}, ${hotel.propertyId}, ${first}, 'DRAFT_EDIT', 12, 'USER', ${newId()})`);
    // The concierge created two requests; the guest cancelled one of them twenty minutes later.
    const cancelled = newId();
    for (const request of [cancelled, newId()])
      await deliver(
        ServiceRequestCreated,
        {
          request_id: request,
          service_code: 'EXTRA_TOWELS',
          service_version_id: newId(),
          stay_id: hotel.stayId,
          guest_id: hotel.guestId,
          room_id: hotel.roomId,
          work_item_id: newId(),
          source: 'AI',
        },
        at(9, 5),
      );
    await deliver(
      ServiceRequestStatusChanged,
      {
        request_id: cancelled,
        service_code: 'EXTRA_TOWELS',
        stay_id: hotel.stayId,
        guest_id: hotel.guestId,
        from: 'OPEN',
        to: 'CANCELLED',
      },
      at(9, 25),
    );
  });
  afterAll(() => h?.app.close());

  it('computes the day per agent and version from what was recorded, the same every time', async () => {
    const recompute = () =>
      h.http().post(`${base()}/recompute`).set('X-Test-Actor', gm()).send({ day: DAY }).expect(200);
    expect((await recompute()).body).toEqual({ day: DAY, metrics: 8 });
    const read = async () =>
      (await h.http().get(`${base()}?from=${DAY}&to=${DAY}`).set('X-Test-Actor', gm()).expect(200))
        .body as Array<{
        agentCode: string;
        agentVersionId: string | null;
        metric: string;
        value: number;
        samples: number;
      }>;
    const rows = await read();
    expect(
      rows.map(
        (r) => `${r.agentVersionId === version ? 'v' : '-'}:${r.metric}=${r.value}/${r.samples}`,
      ),
    ).toEqual([
      '-:task_creation_accuracy=0.5/2',
      'v:cost_per_execution_minor=10/3',
      'v:draft_edit_distance=12/1',
      'v:executions=3/3',
      'v:fallback_rate=0.3333/3',
      'v:guest_recontact_rate=0.5/2',
      'v:human_override_rate=0.5/2',
      'v:tool_failure_rate=0.3333/3',
    ]);
    await recompute();
    expect(await read()).toEqual(rows);
  });

  it('is the hotel’s own and needs ai.quality.read', async () => {
    await h
      .http()
      .get(`${base()}?from=${DAY}&to=${DAY}`)
      .set('X-Test-Actor', staff(clerkId, hotel.tenantId))
      .expect(403);
    await h
      .http()
      .get(`${base()}?from=${DAY}&to=${DAY}`)
      .set('X-Test-Actor', staff(otherId, other.tenantId))
      .expect(404);
    expect(
      (
        await h
          .http()
          .get(`/properties/${other.propertyId}/ai/quality?from=${DAY}&to=${DAY}`)
          .set('X-Test-Actor', staff(otherId, other.tenantId))
          .expect(200)
      ).body,
    ).toEqual([]);
    await h
      .http()
      .get(`${base()}?from=2026-10-01&to=2026-09-01`)
      .set('X-Test-Actor', gm())
      .expect(400);
  });
});
