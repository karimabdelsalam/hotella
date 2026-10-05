import { sql } from 'drizzle-orm';
import { GUEST_SESSION_HEADER } from '@hotella/domain-guest/public';
import { newId } from '@hotella/platform-database';
import { RequestContext } from '@hotella/platform-observability';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentCatalog } from './application/agent-catalog';
import { ConciergeRuntime } from './application/concierge.runtime';
import { EvaluationService } from './application/evaluation.service';
import { ModelProviderRegistry } from './application/provider-registry';
import { FakeModelProvider } from './application/providers/fake';
import type { CompletionRequest } from './application/providers/types';
import { type BuiltInAgent, HANDOFF_REASONS } from './domain/agents';
import { inCanary } from './domain/release';
import {
  ADMIN,
  type AiHarness,
  createHotel,
  guestToken,
  type Hotel,
  staff,
  startAiApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();
const CODE = `REL_TEST_${stamp}`;
const STAFF_CODE = `REL_STAFF_${stamp}`;

/** A small guest concierge, deployed as v1 and later as v2 (BUILD_PLAN 12.2). */
const agent = (versionNo: number): BuiltInAgent => ({
  code: CODE,
  kind: 'CONVERSATION',
  versionNo,
  capability: 'REASONING_HIGH',
  prompt: {
    versionNo,
    layers: [{ layer: 'agent', text: `You are the release test concierge, version ${versionNo}.` }],
  },
  tools: [
    'catalog.list_services',
    'operations.create_service_request',
    'communication.send_message',
  ],
  runtimeTools: ['communication.send_message'],
  context: { providers: ['guest.current_stay'], recentMessages: 4 },
  autonomy: { autoMediumTools: ['operations.create_service_request'] },
  output: { maxReplyChars: 500, handoffReasons: [...HANDOFF_REASONS] },
  maxSteps: 5,
});

/** A staff assistant: it answers staff, so it has no guest conversations to try a version on. */
const staffAgent = (versionNo: number): BuiltInAgent => ({
  ...agent(versionNo),
  code: STAFF_CODE,
  kind: 'ASSIST',
  tools: ['catalog.list_services'],
  runtimeTools: [],
  context: { providers: [], recentMessages: 0 },
  autonomy: { autoMediumTools: [] },
});

/**
 * The model: v1 creates the AC request straight away; v2 first looks at the services, then creates it. Both answer
 * with the version that wrote the reply, so the test sees who answered the guest.
 */
function model(request: CompletionRequest) {
  const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
  const version = /release test concierge, version (\d)/.exec(system)?.[1];
  const tools = request.messages.filter((m) => m.role === 'tool').length;
  const reply = (text: string) => ({ content: JSON.stringify({ reply: text, handoff: null }) });
  const create = {
    toolCalls: [
      {
        id: `c${tools}`,
        name: 'operations__create_service_request',
        arguments: { service_code: 'AC_PROBLEM', fields: { issue: 'TOO_HOT' } },
      },
    ],
  };
  if (version === '1') return tools === 0 ? create : reply('v1: an engineer is on the way.');
  if (version === '2') {
    if (tools === 0)
      return { toolCalls: [{ id: 'l0', name: 'catalog__list_services', arguments: {} }] };
    return tools === 1 ? create : reply('v2: an engineer is on the way.');
  }
  return reply('?');
}

describe.skipIf(needsInfra())(`Agent shadow, canary and rollback (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const fake = new FakeModelProvider();
  const definitions: BuiltInAgent[] = [agent(1), staffAgent(1)];
  let h: AiHarness;
  let hotel: Hotel;
  let token: string;
  let conversationId: string;
  let v1: string;
  let v2: string;
  let canaries = 0;
  const gm = () => staff(gmId, hotel.tenantId);

  const release = (body: object, actor = ADMIN, code = CODE) =>
    h.http().post(`/ai/agents/${code}/releases`).set('X-Test-Actor', actor).send(body);
  const rollback = (reason = 'Trial over') =>
    h.http().post(`/ai/agents/${CODE}/rollback`).set('X-Test-Actor', ADMIN).send({ reason });
  const candidate = async (code: string) => {
    const versions = (
      await h.http().get(`/ai/agents/${code}/versions`).set('X-Test-Actor', ADMIN).expect(200)
    ).body as Array<{ id: string; versionNo: number; status: string }>;
    return versions;
  };
  const requests = async () =>
    (
      await h.db.execute(
        sql`select count(*)::int as n from catalog.service_requests where tenant_id = ${hotel.tenantId}`,
      )
    ).rows[0]!.n as number;

  /** The guest writes, the worker runs the concierge; returns who answered and the executions it made. */
  const guestTurn = async (body: string) => {
    await h
      .http()
      .post('/guest/conversation/messages')
      .set(GUEST_SESSION_HEADER, token)
      .send({ body })
      .expect(201);
    conversationId = (
      await h.http().get('/guest/conversation').set(GUEST_SESSION_HEADER, token).expect(200)
    ).body.conversation.id;
    const [message] = (
      await h.db.execute(
        sql`select id from comms.messages where tenant_id = ${hotel.tenantId} and conversation_id = ${conversationId} and direction = 'INBOUND' order by id desc limit 1`,
      )
    ).rows as Array<{ id: string }>;
    const outcome = await h.app
      .get(RequestContext)
      .run({ correlation_id: `release-${stamp}`, tenant_id: hotel.tenantId }, () =>
        h.app.get(ConciergeRuntime).onGuestMessage({
          tenantId: hotel.tenantId,
          conversationId,
          messageId: message!.id,
        }),
      );
    const executions = (
      await h.db.execute(
        sql`select id, agent_version_id, trigger, status from ai.executions
             where tenant_id = ${hotel.tenantId} and conversation_id = ${conversationId}
             order by id desc limit 2`,
      )
    ).rows as Array<{ id: string; agent_version_id: string; trigger: string; status: string }>;
    const detail = (
      await h
        .http()
        .get(`/properties/${hotel.propertyId}/conversations/${conversationId}`)
        .set('X-Test-Actor', gm())
        .expect(200)
    ).body;
    const replies = (detail.messages as Array<{ direction: string; body: string }>).filter(
      (m) => m.direction === 'OUTBOUND',
    );
    return { outcome, executions, reply: replies.at(-1)?.body ?? '' };
  };

  beforeAll(async () => {
    const grants = [
      'org.property.read',
      'org.property.manage',
      'org.location.manage',
      'org.department.manage',
      'catalog.read',
      'catalog.manage',
      'catalog.publish',
      'request.read',
      'inbox.read',
      'ai.routing.manage',
      'ai.execution.read',
      'ai.evaluation.read',
    ];
    h = await startAiApp(
      url,
      'hotella_app_ai_release',
      { [gmId]: grants },
      { definitions, conciergeAgent: CODE },
    );
    fake.reply(...Array.from({ length: 300 }, () => model));
    h.app.get(ModelProviderRegistry).register(fake);
    hotel = await createHotel(h, `ai-rel-${stamp}`, gmId);
    const providerId = (
      await h
        .http()
        .post('/ai/providers')
        .set('X-Test-Actor', ADMIN)
        .send({ code: `REL_${stamp}`, kind: 'FAKE', egress: 'ON_PREM', maxDataClass: 'SENSITIVE' })
        .expect(201)
    ).body.id;
    const modelId = (
      await h
        .http()
        .post('/ai/models')
        .set('X-Test-Actor', ADMIN)
        .send({ providerId, code: `rel-${stamp}`, capabilities: ['REASONING_HIGH'] })
        .expect(201)
    ).body.id;
    await h
      .http()
      .put('/ai/routing-rules')
      .set('X-Test-Actor', gm())
      .send({ capability: 'REASONING_HIGH', modelIds: [modelId], propertyId: hotel.propertyId })
      .expect(200);
    await h
      .http()
      .put('/config/values/comms.ai_mode.default')
      .set('X-Test-Actor', ADMIN)
      .send({
        scope: 'PROPERTY',
        tenantId: hotel.tenantId,
        propertyId: hotel.propertyId,
        value: 'AUTO',
      })
      .expect(200);
    token = await guestToken(h, hotel);

    // v1 runs; v2 (and a staff assistant's v2) arrive later as candidates.
    const catalog = h.app.get(AgentCatalog);
    v1 = (await catalog.published(CODE)).versionId;
    await catalog.published(STAFF_CODE);
    definitions[0] = agent(2);
    definitions[1] = staffAgent(2);
    catalog.invalidate();
    await catalog.published(CODE);
    await catalog.published(STAFF_CODE);
    v2 = (await candidate(CODE)).find((v) => v.versionNo === 2)!.id;

    // The release gate: v2 passes the platform regression set (dry run, fixtures for every tool).
    const setId = (
      await h
        .http()
        .post('/ai/evaluation-sets')
        .set('X-Test-Actor', ADMIN)
        .send({ agentCode: CODE, code: 'CORE', name: 'Core guest asks' })
        .expect(201)
    ).body.id;
    await h
      .http()
      .post(`/ai/evaluation-sets/${setId}/cases`)
      .set('X-Test-Actor', ADMIN)
      .send({
        code: 'TOO_HOT',
        critical: true,
        input: { locale: 'en', turns: [{ from: 'person', text: 'It is too hot in here' }] },
        toolFixtures: {
          'catalog.list_services': { status: 'OK', result: { services: [] } },
          'operations.create_service_request': {
            status: 'OK',
            result: { request_id: 'r-1', status: 'OPEN', related_to_open_request: false },
          },
        },
        expectations: {
          toolsCalled: [{ tool: 'operations.create_service_request', outcome: 'OK' }],
          handoff: 'NONE',
        },
      })
      .expect(201);
    const [run] = (
      await h
        .http()
        .post(`/ai/agents/${CODE}/versions/${v2}/evaluations`)
        .set('X-Test-Actor', ADMIN)
        .send({ propertyId: hotel.propertyId })
        .expect(201)
    ).body as Array<{ id: string }>;
    expect(await h.app.get(EvaluationService).execute(run!.id)).toBe('PASSED');
  });
  afterAll(() => h?.app.close());

  it('refuses a trial of a staff assistant, and a release a hotel or an invalid share asks for', async () => {
    const staffV2 = (await candidate(STAFF_CODE)).find((v) => v.versionNo === 2)!.id;
    await release({ versionId: staffV2, stage: 'SHADOW' }, ADMIN, STAFF_CODE)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('ai.agent.trial_not_supported'));
    await release({ versionId: v2, stage: 'SHADOW' }, gm()).expect(403);
    await release({ versionId: v2, stage: 'CANARY' }).expect(400);
    await release({ versionId: v2, stage: 'SHADOW', canaryPercent: 20 }).expect(400);
    await release({ versionId: v2, stage: 'CANARY', canaryPercent: 100 }).expect(400);
  });

  it('SHADOW: v1 answers and acts; v2 runs beside it on the same input, reads for real and changes nothing', async () => {
    const shadow = (
      await release({ versionId: v2, stage: 'SHADOW', reason: 'Try the new prompt' }).expect(201)
    ).body;
    expect(shadow).toMatchObject({ versionId: v2, stage: 'SHADOW', previousVersionId: v1 });
    const before = await requests();
    const turn = await guestTurn('It is too hot in my room');
    expect(turn.outcome).toBe('REPLIED');
    expect(turn.reply).toBe('v1: an engineer is on the way.');
    // Exactly one request: the active version's. The shadow's create came back without being performed.
    expect(await requests()).toBe(before + 1);
    const [shadowRun, activeRun] = turn.executions;
    expect(activeRun).toMatchObject({
      agent_version_id: v1,
      trigger: 'MESSAGE',
      status: 'COMPLETED',
    });
    expect(shadowRun).toMatchObject({
      agent_version_id: v2,
      trigger: 'SHADOW',
      status: 'COMPLETED',
    });
    const steps = (
      await h.db.execute(
        sql`select name, outcome, summary->>'dry_run' as dry from ai.execution_steps
             where execution_id = ${shadowRun!.id} and type = 'TOOL_CALL' order by created_at`,
      )
    ).rows;
    expect(steps).toEqual([
      { name: 'catalog.list_services', outcome: 'OK', dry: null },
      { name: 'operations.create_service_request', outcome: 'OK', dry: 'true' },
    ]);
    // The shadow never replied: no send_message step, one outbound message only.
    const runs = (
      await h
        .http()
        .get(`/ai/agents/${CODE}/versions/${v2}/runs`)
        .set('X-Test-Actor', gm())
        .expect(200)
    ).body as Array<{ id: string; mode: string; status: string; totals: Record<string, number> }>;
    const shadowRuns = runs.filter((r) => r.mode === 'SHADOW');
    expect(shadowRuns).toHaveLength(1);
    expect(shadowRuns[0]).toMatchObject({
      status: 'RUNNING',
      totals: { cases: 1, passed: 0, failed: 1, errored: 0 },
    });
    const [result] = (
      await h.db.execute(
        sql`select outcome, checks, execution_id, compared_execution_id from ai.evaluation_results
             where run_id = ${shadowRuns[0]!.id}`,
      )
    ).rows as Array<{
      outcome: string;
      checks: Array<{ expectation: string; outcome: string; detail?: string }>;
      execution_id: string;
      compared_execution_id: string;
    }>;
    // v2 looked at the services first: the comparison names the difference with a code.
    expect(result).toMatchObject({
      outcome: 'FAIL',
      execution_id: shadowRun!.id,
      compared_execution_id: activeRun!.id,
    });
    expect(result!.checks.filter((c) => c.outcome === 'FAIL')).toEqual([
      { expectation: 'SAME_TOOLS', outcome: 'FAIL', detail: 'TOOLS_DIFFER' },
    ]);

    // Rolling back the trial stops the shadow; the shadow run closes with what it found.
    const ended = (await rollback().expect(200)).body;
    expect(ended).toMatchObject({ rolledBackVersionId: v2, activeVersionId: v1 });
    const again = await guestTurn('Still too hot');
    expect(again.executions[0]).toMatchObject({ agent_version_id: v1, trigger: 'MESSAGE' });
    const closed = (
      await h
        .http()
        .get(`/ai/agents/${CODE}/versions/${v2}/runs`)
        .set('X-Test-Actor', ADMIN)
        .expect(200)
    ).body.filter((r: { mode: string }) => r.mode === 'SHADOW');
    expect(closed).toMatchObject([{ status: 'FAILED' }]);
  });

  it('CANARY: the candidate answers a fixed share of conversations', async () => {
    await release({ versionId: v2, stage: 'CANARY', canaryPercent: 99 }).expect(201);
    canaries++;
    const expected = inCanary(conversationId, 99) ? v2 : v1;
    const turn = await guestTurn('It is way too hot');
    expect(turn.executions[0]).toMatchObject({ agent_version_id: expected, trigger: 'MESSAGE' });
    expect(turn.reply).toBe(
      expected === v2 ? 'v2: an engineer is on the way.' : 'v1: an engineer is on the way.',
    );
    // No shadow beside a canary.
    expect(turn.executions[1]?.trigger).not.toBe('SHADOW');

    // A share the conversation is outside of: v1 answers.
    let percent = 1;
    while (inCanary(conversationId, percent) && percent < 99) percent++;
    if (!inCanary(conversationId, percent)) {
      await release({ versionId: v2, stage: 'CANARY', canaryPercent: percent }).expect(201);
      canaries++;
      const outside = await guestTurn('Hot again');
      expect(outside.executions[0]).toMatchObject({ agent_version_id: v1 });
    }
    // The same conversation always lands on the same side while the share holds.
    await release({ versionId: v2, stage: 'CANARY', canaryPercent: 99 }).expect(201);
    canaries++;
    if (inCanary(conversationId, 99))
      expect((await guestTurn('Please hurry')).executions[0]).toMatchObject({
        agent_version_id: v2,
      });
  });

  it('ACTIVE then rollback: the previous version runs again, unchanged; there is nothing more to undo', async () => {
    const promoted = (
      await release({ versionId: v2, stage: 'ACTIVE', reason: 'Canary looked good' }).expect(201)
    ).body;
    expect(promoted).toMatchObject({ versionId: v2, stage: 'ACTIVE', previousVersionId: v1 });
    expect((await guestTurn('Too hot, sorry to bother')).reply).toBe(
      'v2: an engineer is on the way.',
    );

    const content = async (id: string) =>
      (
        await h.db.execute(
          sql`select prompt_version_id, tool_codes, autonomy_policy, output_contract from ai.agent_versions where id = ${id}`,
        )
      ).rows[0];
    const v1Before = await content(v1);
    const undone = (await rollback('Complaints went up').expect(200)).body;
    expect(undone).toMatchObject({ rolledBackVersionId: v2, activeVersionId: v1 });
    expect((await h.app.get(AgentCatalog).published(CODE)).versionId).toBe(v1);
    expect(await content(v1)).toEqual(v1Before);
    expect((await guestTurn('Hot hot hot')).reply).toBe('v1: an engineer is on the way.');
    expect((await candidate(CODE)).map((v) => `${v.versionNo}:${v.status}`)).toEqual([
      '1:PUBLISHED',
      '2:SUPERSEDED',
    ]);

    await rollback()
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('ai.agent.nothing_to_roll_back'));
    // A superseded version cannot be released again.
    await release({ versionId: v2, stage: 'ACTIVE' })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('ai.agent.not_a_candidate'));

    const history = (
      await h.http().get(`/ai/agents/${CODE}/releases`).set('X-Test-Actor', ADMIN).expect(200)
    ).body as Array<{ stage: string; versionId: string }>;
    expect(history.map((r) => r.stage).reverse()).toEqual([
      'SHADOW',
      'ROLLED_BACK',
      ...Array<string>(canaries).fill('CANARY'),
      'ACTIVE',
      'ROLLED_BACK',
    ]);
    const audit = await h.db.execute(
      sql`select action from audit.audit_log where entity_id in (${v1}, ${v2}) and action like 'ai.agent.%' order by occurred_at`,
    );
    expect(audit.rows.filter((r) => r.action === 'ai.agent.rollback')).toHaveLength(2);
  });
});
