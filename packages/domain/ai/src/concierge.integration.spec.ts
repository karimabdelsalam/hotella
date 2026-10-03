import { and, desc, eq, sql } from 'drizzle-orm';
import type { EventEnvelope } from '@hotella/contracts-events';
import { CATALOG_API, type CatalogPublicApi } from '@hotella/domain-catalog/public';
import { GUEST_SESSION_HEADER } from '@hotella/domain-guest/public';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { newId } from '@hotella/platform-database';
import { eventsSchema } from '@hotella/platform-events';
import { RequestContext } from '@hotella/platform-observability';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConciergeRuntime } from './application/concierge.runtime';
import { FeedbackRecorder } from './application/feedback-recorder';
import { ModelProviderRegistry } from './application/provider-registry';
import { FakeModelProvider } from './application/providers/fake';
import { ModelProviderError } from './application/providers/types';
import { replyLocale } from './domain/agents';
import { killSwitch } from './domain/settings';
import { AiRepositories } from './infrastructure/repositories';
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

describe('reply language', () => {
  it('follows the script of the guest message, else the conversation language', () => {
    expect(replyLocale('الجو حر أوي هنا', 'en')).toBe('ar');
    expect(replyLocale('It is too hot in room 504', 'ar')).toBe('en');
    expect(replyLocale('عايزة towels لو سمحت', 'en')).toBe('ar');
    expect(replyLocale('504 ?', 'ar')).toBe('ar');
    expect(replyLocale('👍', 'fr')).toBe('en');
  });
});

describe.skipIf(needsInfra())(`Guest Concierge v1 (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const fake = new FakeModelProvider();
  const STAFF = [
    'org.property.read',
    'org.property.manage',
    'org.location.manage',
    'org.department.manage',
    'catalog.read',
    'catalog.manage',
    'catalog.publish',
    'request.read',
    'inbox.read',
    'inbox.reply',
    'inbox.takeover',
    'ai.routing.manage',
    'ai.execution.read',
  ];
  let h: AiHarness;
  let hotel: Hotel;
  let token: string;
  let conversationId: string;
  let catalog: CatalogPublicApi;
  let previousMessageId: string;
  const gm = () => staff(gmId, hotel.tenantId);
  const base = () => `/properties/${hotel.propertyId}`;

  /** The guest writes on the guest web; returns the stored message id. */
  const guestSays = async (body: string) => {
    await h
      .http()
      .post('/guest/conversation/messages')
      .set(GUEST_SESSION_HEADER, token)
      .send({ body })
      .expect(201);
    const conversation = await h
      .http()
      .get('/guest/conversation')
      .set(GUEST_SESSION_HEADER, token)
      .expect(200);
    conversationId = conversation.body.conversation.id;
    const [row] = (
      await h.db.execute(
        sql`select id from comms.messages where tenant_id = ${hotel.tenantId} and conversation_id = ${conversationId} and direction = 'INBOUND' order by id desc limit 1`,
      )
    ).rows as Array<{ id: string }>;
    return row!.id;
  };
  /** What the worker does for `comms.message.received.v1` (the job runs in the event's context). */
  const run = (messageId: string) =>
    h.app
      .get(RequestContext)
      .run({ correlation_id: `concierge-${stamp}`, tenant_id: hotel.tenantId }, () =>
        h.app.get(ConciergeRuntime).onGuestMessage({
          tenantId: hotel.tenantId,
          conversationId,
          messageId,
        }),
      );
  const conversation = async () =>
    (
      await h
        .http()
        .get(`${base()}/conversations/${conversationId}`)
        .set('X-Test-Actor', gm())
        .expect(200)
    ).body;
  const lastExecution = async () => {
    const list = await h
      .http()
      .get(`${base()}/ai/executions?conversationId=${conversationId}&limit=1`)
      .set('X-Test-Actor', gm())
      .expect(200);
    return (
      await h
        .http()
        .get(`${base()}/ai/executions/${list.body[0].id}`)
        .set('X-Test-Actor', gm())
        .expect(200)
    ).body;
  };
  const systemOf = (i: number) =>
    fake.requests[i]!.request.messages.filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');

  beforeAll(async () => {
    h = await startAiApp(url, 'hotella_app_ai_concierge', { [gmId]: STAFF });
    h.app.get(ModelProviderRegistry).register(fake);
    catalog = h.app.get(CATALOG_API);
    hotel = await createHotel(h, `ai-conc-${stamp}`, gmId);
    // An on-prem model serves the concierge for this tenant (ADR-0018: no external provider).
    const providerId = (
      await h
        .http()
        .post('/ai/providers')
        .set('X-Test-Actor', ADMIN)
        .send({ code: `CONC_${stamp}`, kind: 'FAKE', egress: 'ON_PREM', maxDataClass: 'SENSITIVE' })
        .expect(201)
    ).body.id;
    const modelId = (
      await h
        .http()
        .post('/ai/models')
        .set('X-Test-Actor', ADMIN)
        .send({ providerId, code: `concierge-${stamp}`, capabilities: ['REASONING_HIGH'] })
        .expect(201)
    ).body.id;
    await h
      .http()
      .put('/ai/routing-rules')
      .set('X-Test-Actor', gm())
      .send({ capability: 'REASONING_HIGH', modelIds: [modelId] })
      .expect(200);
    // New verified conversations of this property start with the concierge answering.
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
  });
  afterAll(() => h?.app.close());
  beforeEach(() => fake.reset());

  it('"الجو حر أوي هنا": finds the service, creates AC_PROBLEM for Engineering and answers in Arabic', async () => {
    const messageId = await guestSays('الجو حر أوي هنا');
    expect((await conversation()).aiMode).toBe('AUTO');
    fake.reply(
      { toolCalls: [{ id: 'c1', name: 'catalog__list_services', arguments: {} }] },
      {
        toolCalls: [
          {
            id: 'c2',
            name: 'operations__create_service_request',
            arguments: { service_code: 'AC_PROBLEM', fields: { issue: 'TOO_HOT' } },
          },
        ],
      },
      (request) => {
        // The model saw the request it made being created.
        const created = request.messages.find(
          (m) => m.role === 'tool' && m.content.includes('request_id'),
        );
        expect(created).toBeDefined();
        return {
          content: JSON.stringify({
            reply: 'آسفين على الإزعاج! بلّغنا فريق الصيانة وهيجيلك حد يظبط التكييف حالًا.',
            handoff: null,
          }),
        };
      },
    );
    expect(await run(messageId)).toBe('REPLIED');

    // Arabic instruction, Arabic guest words reached the on-prem model, structured live data came from tools.
    expect(systemOf(0)).toContain('Reply in Arabic');
    expect(systemOf(0)).toContain('<context name="guest.current_stay">');
    expect(fake.requests[0]!.request.tools?.map((t) => t.name)).not.toContain(
      'communication__send_message',
    );
    const [request] = (await catalog.serviceRequestsOfStay(hotel.tenantId, hotel.stayId)).filter(
      (r) => r.serviceCode === 'AC_PROBLEM',
    );
    expect(request).toMatchObject({ source: 'AI', locale: 'ar', status: 'OPEN' });
    const work = await h.app
      .get<OperationsPublicApi>(OPERATIONS_API)
      .getWorkItem(hotel.tenantId, request!.workItemId!);
    expect(work?.departmentCode).toBe('ENG');
    const detail = await conversation();
    const last = detail.messages[detail.messages.length - 1];
    expect(last).toMatchObject({
      direction: 'OUTBOUND',
      senderType: 'AI',
      senderRef: 'GUEST_CONCIERGE',
    });
    expect(last.body).toContain('التكييف');

    const execution = await lastExecution();
    expect(execution).toMatchObject({
      status: 'COMPLETED',
      agentCode: 'GUEST_CONCIERGE',
      trigger: 'MESSAGE',
      actorType: 'GUEST',
      conversationId,
    });
    expect(execution.agentVersionId).toBeTruthy();
    expect(
      execution.steps.map((s: { type: string; name: string }) => `${s.type}:${s.name}`),
    ).toEqual([
      'CONTEXT:context',
      'MODEL_CALL:REASONING_HIGH',
      'TOOL_CALL:catalog.list_services',
      'MODEL_CALL:REASONING_HIGH',
      'TOOL_CALL:operations.create_service_request',
      'MODEL_CALL:REASONING_HIGH',
      'DECISION:output',
      'TOOL_CALL:communication.send_message',
      'RESPONSE:reply',
    ]);
    expect(execution.modelCalls).toHaveLength(3);
    expect(execution.tokensIn).toBe(300);
    // The execution record never holds the guest's words.
    expect(JSON.stringify(execution.steps)).not.toContain('الجو حر');
    previousMessageId = messageId;
  });

  it('answers in English when the guest writes in English; an older message is not answered again', async () => {
    const messageId = await guestSays('Can I get the Wi-Fi password?');
    // The newest guest message has its own run; a late job for an older one does nothing.
    expect(await run(previousMessageId)).toBe('SKIPPED');
    fake.reply({
      content: JSON.stringify({ reply: 'Of course! Let me check that for you.', handoff: null }),
    });
    expect(await run(messageId)).toBe('REPLIED');
    expect(systemOf(0)).toContain('Reply in English.');
  });

  it('a step budget that runs out hands the guest to a person', async () => {
    const messageId = await guestSays('ممكن تشوفلي طلباتي؟');
    for (let i = 0; i < 6; i++)
      fake.reply({
        toolCalls: [{ id: `l${i}`, name: 'operations__find_open_requests', arguments: {} }],
      });
    expect(await run(messageId)).toBe('HANDED_OFF');
    expect(await conversation()).toMatchObject({ status: 'HANDED_OFF', aiMode: 'OFF' });
    const execution = await lastExecution();
    expect(execution.status).toBe('HANDED_OFF');
    expect(execution.steps.at(-1)).toMatchObject({
      type: 'DECISION',
      name: 'handoff',
      summary: { reason: 'AI_FAILURE' },
    });
    // Once a person has it, the AI stays quiet.
    const next = await guestSays('؟');
    expect(await run(next)).toBe('SKIPPED');
  });

  it('the model may hand off itself; staff can give the conversation back', async () => {
    await h
      .http()
      .post(`${base()}/conversations/${conversationId}/ai-mode`)
      .set('X-Test-Actor', gm())
      .send({ mode: 'AUTO' })
      .expect(200);
    const messageId = await guestSays('عايزة أكلم حد من الاستقبال لو سمحت');
    fake.reply({
      content: JSON.stringify({
        reply: 'حاضر، هحوّلك لزميلي في الاستقبال حالًا.',
        handoff: 'GUEST_REQUESTED_HUMAN',
      }),
    });
    expect(await run(messageId)).toBe('HANDED_OFF');
    const detail = await conversation();
    expect(detail.status).toBe('HANDED_OFF');
    expect(detail.messages.at(-1).body).toContain('هحوّلك');
    const [row] = (
      await h.db.execute(
        sql`select handoff_reason from comms.conversations where id = ${conversationId}`,
      )
    ).rows as Array<{ handoff_reason: string }>;
    expect(row!.handoff_reason).toBe('GUEST_REQUESTED_HUMAN');
  });

  it('ASSIST mode drafts for staff; sending the edited draft records the edit distance', async () => {
    await h
      .http()
      .post(`${base()}/conversations/${conversationId}/ai-mode`)
      .set('X-Test-Actor', gm())
      .send({ mode: 'ASSIST' })
      .expect(200);
    const messageId = await guestSays('الفوطة اللي في الحمام وسخة');
    fake.reply({
      content: JSON.stringify({ reply: 'آسفين جدًا! هنبعتلك فوط نضيفة حالًا.', handoff: null }),
    });
    expect(await run(messageId)).toBe('DRAFTED');
    const detail = await conversation();
    expect(detail.messages.at(-1).direction).toBe('INBOUND');
    expect(detail.aiDraft).toMatchObject({ body: 'آسفين جدًا! هنبعتلك فوط نضيفة حالًا.' });
    const sent = 'آسفين جدًا يا مدام منى! هنبعتلك فوط نضيفة حالًا.';
    await h
      .http()
      .post(`${base()}/conversations/${conversationId}/messages`)
      .set('X-Test-Actor', gm())
      .send({ body: sent, draftId: detail.aiDraft.id })
      .expect(201);
    expect((await conversation()).aiDraft).toBeNull();
    // A used draft cannot be used twice.
    await h
      .http()
      .post(`${base()}/conversations/${conversationId}/messages`)
      .set('X-Test-Actor', gm())
      .send({ body: 'x', draftId: detail.aiDraft.id })
      .expect(409);
    const [event] = await h.db
      .select()
      .from(eventsSchema.outbox)
      .where(
        and(
          eq(eventsSchema.outbox.tenantId, hotel.tenantId),
          eq(eventsSchema.outbox.eventType, 'comms.reply_draft.used'),
        ),
      )
      .orderBy(desc(eventsSchema.outbox.createdAt));
    const envelope = event!.envelope as EventEnvelope;
    expect(envelope.payload).toMatchObject({ edit_distance: 12, draft_id: detail.aiDraft.id });
    const recorder = h.app.get(FeedbackRecorder);
    expect(await recorder.onDraftUsed(envelope)).toBe(true);
    expect(await recorder.onDraftUsed(envelope)).toBe(false);
    const execution = await lastExecution();
    expect(execution.feedback).toMatchObject([{ kind: 'DRAFT_EDIT', editDistance: 12 }]);
  });

  it('a failing model or the guest-AI kill switch hands off in AUTO mode', async () => {
    await h
      .http()
      .post(`${base()}/conversations/${conversationId}/ai-mode`)
      .set('X-Test-Actor', gm())
      .send({ mode: 'AUTO' })
      .expect(200);
    fake.failWith = new ModelProviderError('REJECTED', false);
    expect(await run(await guestSays('مرحبا'))).toBe('HANDED_OFF');
    expect(
      (await lastExecution()).steps.find((s: { type: string }) => s.type === 'MODEL_CALL'),
    ).toMatchObject({ outcome: 'ai.gateway.unavailable' });
    fake.reset();
    await h
      .http()
      .post(`${base()}/conversations/${conversationId}/ai-mode`)
      .set('X-Test-Actor', gm())
      .send({ mode: 'AUTO' })
      .expect(200);
    h.flags.set(killSwitch.guestAi, true);
    expect(await run(await guestSays('مرحبا تاني'))).toBe('HANDED_OFF');
    h.flags.delete(killSwitch.guestAi);
    expect(fake.requests).toHaveLength(0);
    // The kill switch decided before any model call.
    expect(
      (
        await h.app
          .get(AiRepositories)
          .steps({ tenantId: hotel.tenantId }, (await lastExecution()).id)
      ).map((s) => s.outcome),
    ).toEqual(['DISABLED', 'HANDED_OFF']);
  });
});
