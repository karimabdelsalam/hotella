import { sql } from 'drizzle-orm';
import { newId } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentCatalog } from './application/agent-catalog';
import { EvaluationService } from './application/evaluation.service';
import { ModelProviderRegistry } from './application/provider-registry';
import { FakeModelProvider } from './application/providers/fake';
import type { CompletionRequest } from './application/providers/types';
import { type BuiltInAgent, HANDOFF_REASONS } from './domain/agents';
import {
  ADMIN,
  type AiHarness,
  createHotel,
  type Hotel,
  staff,
  startAiApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();
const CODE = `EVAL_TEST_${stamp}`;

/** A small concierge-like agent, deployed as v1 and later as v2 (BUILD_PLAN 12.1). */
const agent = (versionNo: number): BuiltInAgent => ({
  code: CODE,
  kind: 'CONVERSATION',
  versionNo,
  capability: 'REASONING_HIGH',
  prompt: {
    versionNo,
    layers: [
      { layer: 'agent', text: `You are the evaluation test concierge, version ${versionNo}.` },
    ],
  },
  tools: [
    'catalog.list_services',
    'operations.create_service_request',
    'operations.cancel_service_request',
  ],
  runtimeTools: [],
  context: { providers: [], recentMessages: 0 },
  autonomy: { autoMediumTools: ['operations.create_service_request'] },
  output: { maxReplyChars: 500, handoffReasons: [...HANDOFF_REASONS] },
  maxSteps: 4,
});

/** The model under test: v2 behaves when `good`, and forgets to create the request otherwise. */
function model(good: { value: boolean }) {
  return (request: CompletionRequest) => {
    const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const answered = request.messages.at(-1)?.role === 'tool';
    const reply = (text: string, handoff: string | null = null) => ({
      content: JSON.stringify({ reply: text, handoff }),
    });
    if (!system.includes('evaluation test concierge')) return reply('?');
    if (/cancel/i.test(user))
      return answered
        ? reply('I asked a colleague to cancel it; they will confirm shortly.')
        : {
            toolCalls: [
              {
                id: 'c1',
                name: 'operations__cancel_service_request',
                arguments: {
                  request_id: '01900000-0000-7000-8000-0000000000aa',
                  reason: 'Guest asked',
                },
              },
            ],
          };
    if (/towel/i.test(user)) {
      if (!good.value) return reply('Sure, towels are coming.');
      return answered
        ? reply('Two fresh towels are on the way to your room.')
        : {
            toolCalls: [
              {
                id: 't1',
                name: 'operations__create_service_request',
                arguments: { service_code: 'EXTRA_TOWELS', fields: { quantity: 2 } },
              },
            ],
          };
    }
    return reply('I am sorry about that, a colleague will help you right away.', 'COMPLAINT');
  };
}

describe.skipIf(needsInfra())(`Agent evaluation and release (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const otherGmId = newId();
  const fake = new FakeModelProvider();
  const good = { value: false };
  const definitions: BuiltInAgent[] = [agent(1)];
  let h: AiHarness;
  let hotel: Hotel;
  let other: Hotel;
  let setId: string;
  let v1: string;
  let v2: string;
  const gm = () => staff(gmId, hotel.tenantId);
  const evaluation = () => h.app.get(EvaluationService);

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
      'ai.routing.manage',
      'ai.execution.read',
      'ai.evaluation.read',
      'ai.evaluation.manage',
    ];
    h = await startAiApp(
      url,
      'hotella_app_ai_eval',
      { [gmId]: grants, [otherGmId]: grants },
      { definitions },
    );
    fake.reply(...Array.from({ length: 200 }, () => model(good)));
    h.app.get(ModelProviderRegistry).register(fake);
    hotel = await createHotel(h, `ai-eval-${stamp}`, gmId);
    other = await createHotel(h, `ai-eval-b-${stamp}`, otherGmId);
    const providerId = (
      await h
        .http()
        .post('/ai/providers')
        .set('X-Test-Actor', ADMIN)
        .send({
          code: `EVAL_${stamp}`,
          kind: 'FAKE',
          egress: 'ON_PREM',
          maxDataClass: 'CONFIDENTIAL',
        })
        .expect(201)
    ).body.id;
    const modelId = (
      await h
        .http()
        .post('/ai/models')
        .set('X-Test-Actor', ADMIN)
        .send({ providerId, code: `eval-${stamp}`, capabilities: ['REASONING_HIGH'] })
        .expect(201)
    ).body.id;
    await h
      .http()
      .put('/ai/routing-rules')
      .set('X-Test-Actor', gm())
      .send({ capability: 'REASONING_HIGH', modelIds: [modelId], propertyId: hotel.propertyId })
      .expect(200);
  });
  afterAll(() => h?.app.close());

  it('the first version runs at once; a later deployed version waits as a candidate', async () => {
    const catalog = h.app.get(AgentCatalog);
    v1 = (await catalog.published(CODE)).versionId;
    definitions[0] = agent(2);
    catalog.invalidate(CODE);
    expect((await catalog.published(CODE)).versionId).toBe(v1);
    const versions = (
      await h.http().get(`/ai/agents/${CODE}/versions`).set('X-Test-Actor', ADMIN).expect(200)
    ).body as Array<{ id: string; versionNo: number; status: string }>;
    expect(versions.map((v) => [v.versionNo, v.status])).toEqual([
      [1, 'PUBLISHED'],
      [2, 'CANDIDATE'],
    ]);
    v2 = versions[1]!.id;
    // No evaluation set yet: nothing can be released.
    await h
      .http()
      .post(`/ai/agents/${CODE}/versions/${v2}/publish`)
      .set('X-Test-Actor', ADMIN)
      .send({})
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('ai.evaluation.no_sets'));
  });

  it('platform sets hold synthetic cases; a hotel cannot change them but keeps its own', async () => {
    setId = (
      await h
        .http()
        .post('/ai/evaluation-sets')
        .set('X-Test-Actor', ADMIN)
        .send({ agentCode: CODE, code: 'CORE', name: 'Core guest asks' })
        .expect(201)
    ).body.id;
    const add = (body: object, actor = ADMIN, set = setId) =>
      h.http().post(`/ai/evaluation-sets/${set}/cases`).set('X-Test-Actor', actor).send(body);
    await add({
      code: 'TOWELS',
      critical: true,
      input: { locale: 'en', turns: [{ from: 'person', text: 'Could I have two more towels?' }] },
      toolFixtures: {
        'operations.create_service_request': {
          status: 'OK',
          result: { request_id: 'r-1', status: 'OPEN', related_to_open_request: false },
        },
      },
      expectations: {
        toolsCalled: [
          {
            tool: 'operations.create_service_request',
            args: { service_code: { equals: 'EXTRA_TOWELS' } },
            outcome: 'OK',
          },
        ],
        handoff: 'NONE',
        replyContains: ['towels'],
      },
    }).expect(201);
    await add({
      code: 'CANCEL_NEEDS_A_PERSON',
      input: { locale: 'en', turns: [{ from: 'person', text: 'Please cancel my towel order' }] },
      expectations: {
        toolsCalled: [{ tool: 'operations.cancel_service_request', outcome: 'PROPOSED' }],
        toolsNotCalled: ['operations.create_service_request'],
      },
    }).expect(201);
    await add({
      code: 'COMPLAINT',
      input: {
        locale: 'en',
        turns: [
          { from: 'person', text: 'The room was dirty when we arrived, this is unacceptable.' },
        ],
        context: [{ name: 'stay', text: 'Room 504, 3 nights.', dataClass: 'CONFIDENTIAL' }],
      },
      expectations: { handoff: 'COMPLAINT', replyNotContains: ['complaint filed'] },
    }).expect(201);
    // A case without expectations, or with a real guest's data class, is refused.
    await add({
      code: 'EMPTY',
      input: { locale: 'en', turns: [{ from: 'person', text: 'Hi' }] },
      expectations: {},
    }).expect(400);
    await add({
      code: 'SENSITIVE',
      dataClass: 'SENSITIVE',
      input: { locale: 'en', turns: [{ from: 'person', text: 'Hi' }] },
      expectations: { handoff: 'NONE' },
    }).expect(400);

    // The hotel sees the platform set but cannot change it; it can keep a set of its own.
    await add(
      {
        code: 'MINE',
        input: { locale: 'en', turns: [{ from: 'person', text: 'Hi' }] },
        expectations: { handoff: 'NONE' },
      },
      gm(),
    ).expect(404);
    const own = (
      await h
        .http()
        .post('/ai/evaluation-sets')
        .set('X-Test-Actor', gm())
        .send({ agentCode: CODE, code: 'HOTEL', name: 'Our own asks' })
        .expect(201)
    ).body;
    expect(own.scope).toBe('TENANT');
    const listed = (
      await h
        .http()
        .get(`/ai/evaluation-sets?agentCode=${CODE}`)
        .set('X-Test-Actor', gm())
        .expect(200)
    ).body as Array<{ code: string; scope: string }>;
    expect(listed.map((s) => `${s.scope}:${s.code}`)).toEqual(['PLATFORM:CORE', 'TENANT:HOTEL']);
    // Another hotel sees the platform set only.
    const theirs = (
      await h
        .http()
        .get(`/ai/evaluation-sets?agentCode=${CODE}`)
        .set('X-Test-Actor', staff(otherGmId, other.tenantId))
        .expect(200)
    ).body as Array<{ code: string }>;
    expect(theirs.map((s) => s.code)).toEqual(['CORE']);
    await h
      .http()
      .get(`/ai/evaluation-sets/${own.id}`)
      .set('X-Test-Actor', staff(otherGmId, other.tenantId))
      .expect(404);
    // Retire the hotel's empty set so runs pick the platform set.
    await h
      .http()
      .patch(`/ai/evaluation-sets/${own.id}`)
      .set('X-Test-Actor', gm())
      .send({ version: own.version, status: 'RETIRED' })
      .expect(200);
  });

  it('a failing run blocks the release; a passing run releases the candidate, and dry runs change nothing', async () => {
    const before = async () =>
      (
        await h.db.execute(
          sql`select (select count(*) from catalog.service_requests where tenant_id = ${hotel.tenantId})::int as requests,
                     (select count(*) from ops.approval_requests where tenant_id = ${hotel.tenantId})::int as approvals`,
        )
      ).rows[0];
    const untouched = await before();
    const start = async () => {
      const runs = (
        await h
          .http()
          .post(`/ai/agents/${CODE}/versions/${v2}/evaluations`)
          .set('X-Test-Actor', ADMIN)
          .send({ propertyId: hotel.propertyId })
          .expect(201)
      ).body as Array<{ id: string; status: string }>;
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe('RUNNING');
      return runs[0]!.id;
    };

    good.value = false;
    const failing = await start();
    expect(await evaluation().execute(failing)).toBe('FAILED');
    const failed = (
      await h.http().get(`/ai/evaluation-runs/${failing}`).set('X-Test-Actor', ADMIN).expect(200)
    ).body;
    expect(failed.totals).toMatchObject({ cases: 3, passed: 2, failed: 1, critical_failed: 1 });
    expect(failed.results.find((r: { case: string }) => r.case === 'TOWELS')).toMatchObject({
      outcome: 'FAIL',
      critical: true,
      checks: expect.arrayContaining([
        {
          expectation: 'TOOL_CALLED:operations.create_service_request',
          outcome: 'FAIL',
          detail: 'NOT_CALLED',
        },
      ]),
    });
    await h
      .http()
      .post(`/ai/agents/${CODE}/versions/${v2}/publish`)
      .set('X-Test-Actor', ADMIN)
      .send({})
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('ai.evaluation.not_passed'));

    good.value = true;
    const passing = await start();
    expect(await evaluation().execute(passing)).toBe('PASSED');
    // Running a finished run again changes nothing.
    expect(await evaluation().execute(passing)).toBe('PASSED');
    const passed = (
      await h.http().get(`/ai/evaluation-runs/${passing}`).set('X-Test-Actor', gm()).expect(200)
    ).body;
    expect(
      passed.results.map((r: { case: string; outcome: string }) => `${r.case}:${r.outcome}`),
    ).toEqual(['CANCEL_NEEDS_A_PERSON:PASS', 'COMPLAINT:PASS', 'TOWELS:PASS']);
    // The cases ran as recorded executions with dry-run tool calls; no request, no approval was made.
    expect(await before()).toEqual(untouched);
    const steps = await h.db.execute(
      sql`select e.trigger, s.name, s.outcome, s.summary->>'dry_run' as dry
            from ai.execution_steps s join ai.executions e on e.id = s.execution_id
           where e.agent_version_id = ${v2} and s.type = 'TOOL_CALL' order by s.created_at`,
    );
    expect(steps.rows).toContainEqual({
      trigger: 'EVALUATION',
      name: 'operations.cancel_service_request',
      outcome: 'PROPOSED',
      dry: 'true',
    });
    // Another hotel cannot read the run.
    await h
      .http()
      .get(`/ai/evaluation-runs/${passing}`)
      .set('X-Test-Actor', staff(otherGmId, other.tenantId))
      .expect(404);

    // A hotel cannot release a platform agent version.
    await h
      .http()
      .post(`/ai/agents/${CODE}/versions/${v2}/publish`)
      .set('X-Test-Actor', gm())
      .send({})
      .expect(403);
    const released = (
      await h
        .http()
        .post(`/ai/agents/${CODE}/versions/${v2}/publish`)
        .set('X-Test-Actor', ADMIN)
        .send({ reason: 'Better towel handling' })
        .expect(200)
    ).body;
    expect(released).toMatchObject({
      versionId: v2,
      versionNo: 2,
      stage: 'ACTIVE',
      previousVersionId: v1,
    });
    expect((await h.app.get(AgentCatalog).published(CODE)).versionId).toBe(v2);
    const versions = (
      await h.http().get(`/ai/agents/${CODE}/versions`).set('X-Test-Actor', ADMIN).expect(200)
    ).body as Array<{ versionNo: number; status: string }>;
    expect(versions.map((v) => `${v.versionNo}:${v.status}`)).toEqual([
      '1:SUPERSEDED',
      '2:PUBLISHED',
    ]);
    await h
      .http()
      .post(`/ai/agents/${CODE}/versions/${v2}/publish`)
      .set('X-Test-Actor', ADMIN)
      .send({})
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('ai.agent.not_a_candidate'));
    const releases = (
      await h.http().get(`/ai/agents/${CODE}/releases`).set('X-Test-Actor', ADMIN).expect(200)
    ).body;
    expect(releases).toEqual([
      expect.objectContaining({
        versionId: v2,
        stage: 'ACTIVE',
        runIds: [passing],
        previousVersionId: v1,
      }),
    ]);
    const events = await h.db.execute(
      sql`select event_type from platform.outbox
           where event_type in ('ai.evaluation.completed', 'ai.agent.released')
             and envelope->'payload'->>'agent_version_id' = ${v2} order by id`,
    );
    expect(events.rows.map((r) => r.event_type)).toEqual([
      'ai.evaluation.completed',
      'ai.evaluation.completed',
      'ai.agent.released',
    ]);
    // Release history is append-only.
    await expect(
      h.db.execute(sql`update ai.agent_releases set reason = 'edited' where agent_code = ${CODE}`),
    ).rejects.toThrow();
  });
});
