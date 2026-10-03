import { and, asc, eq, like, sql } from 'drizzle-orm';
import type { EventEnvelope } from '@hotella/contracts-events';
import { CATALOG_API, type CatalogPublicApi } from '@hotella/domain-catalog/public';
import { GUEST_SESSION_HEADER } from '@hotella/domain-guest/public';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { newId } from '@hotella/platform-database';
import { eventsSchema } from '@hotella/platform-events';
import { RequestContext } from '@hotella/platform-observability';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConciergeRuntime } from './application/concierge.runtime';
import { ModelProviderRegistry } from './application/provider-registry';
import { FakeModelProvider } from './application/providers/fake';
import type { CompletionRequest } from './application/providers/types';
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

/** The last tool result the model received, parsed. */
const lastToolResult = (request: CompletionRequest) => {
  const tool = [...request.messages].reverse().find((m) => m.role === 'tool');
  return tool ? (JSON.parse(tool.content) as Record<string, unknown>) : null;
};

/**
 * Milestone M2 (BUILD_PLAN §1.5, Phase 6): the same guest flow in natural language. A guest writes "الجو حر أوي هنا";
 * the Guest Concierge (scripted FAKE model, ADR-0018) looks at the services, creates AC_PROBLEM for Engineering and
 * answers in Arabic; asking to cancel becomes a HIGH-risk proposal that runs only after a person approves it. Worker
 * steps run the way the worker runs them (the message event's correlation id), and every execution is on record.
 */
describe.skipIf(needsInfra())(
  `M2: the guest flow in natural language (${infraSkipReason()})`,
  () => {
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
      'approval.read',
      'approval.decide',
      'ai.routing.manage',
      'ai.execution.read',
    ];
    let h: AiHarness;
    let hotel: Hotel;
    let token: string;
    let conversationId: string;
    let acRequestId: string;
    let catalog: CatalogPublicApi;
    const gm = () => staff(gmId, hotel.tenantId);
    const base = () => `/properties/${hotel.propertyId}`;

    /** The guest writes on the guest web with a correlation id; returns the `comms.message.received` envelope. */
    const guestSays = async (body: string, correlationId: string): Promise<EventEnvelope> => {
      await h
        .http()
        .post('/guest/conversation/messages')
        .set(GUEST_SESSION_HEADER, token)
        .set('X-Correlation-Id', correlationId)
        .send({ body })
        .expect(201);
      const [row] = await h.db
        .select()
        .from(eventsSchema.outbox)
        .where(
          and(
            eq(eventsSchema.outbox.tenantId, hotel.tenantId),
            eq(eventsSchema.outbox.eventType, 'comms.message.received'),
            eq(eventsSchema.outbox.correlationId, correlationId),
          ),
        );
      return row!.envelope as EventEnvelope;
    };
    /** What the worker does: the consumer queues the job with the event's context, the job runs the concierge. */
    const asWorker = (envelope: EventEnvelope) => {
      const p = envelope.payload as { conversation_id: string; message_id: string };
      conversationId = p.conversation_id;
      return h.app.get(RequestContext).run(
        {
          correlation_id: envelope.correlation_id ?? undefined,
          tenant_id: envelope.tenant_id,
          property_id: envelope.property_id,
        },
        () =>
          h.app.get(ConciergeRuntime).onGuestMessage({
            tenantId: envelope.tenant_id!,
            conversationId: p.conversation_id,
            messageId: p.message_id,
          }),
      );
    };
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

    beforeAll(async () => {
      h = await startAiApp(url, 'hotella_app_ai_m2', { [gmId]: STAFF });
      h.app.get(ModelProviderRegistry).register(fake);
      catalog = h.app.get(CATALOG_API);
      hotel = await createHotel(h, `m2-${stamp}`, gmId);
      const providerId = (
        await h
          .http()
          .post('/ai/providers')
          .set('X-Test-Actor', ADMIN)
          .send({ code: `M2_${stamp}`, kind: 'FAKE', egress: 'ON_PREM', maxDataClass: 'SENSITIVE' })
          .expect(201)
      ).body.id;
      const modelId = (
        await h
          .http()
          .post('/ai/models')
          .set('X-Test-Actor', ADMIN)
          .send({ providerId, code: `m2-${stamp}`, capabilities: ['REASONING_HIGH'] })
          .expect(201)
      ).body.id;
      await h
        .http()
        .put('/ai/routing-rules')
        .set('X-Test-Actor', gm())
        .send({ capability: 'REASONING_HIGH', modelIds: [modelId] })
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
    });
    afterAll(() => h?.app.close());

    it('"الجو حر أوي هنا" → AC_PROBLEM for Engineering → an Arabic answer, all under one correlation id', async () => {
      fake.reset();
      fake.reply(
        { toolCalls: [{ id: 's', name: 'catalog__list_services', arguments: {} }] },
        (request) => {
          const services = lastToolResult(request) as unknown as {
            status: string;
            result: Array<{ code: string }>;
          };
          expect(services.status).toBe('OK');
          expect(services.result.map((s) => s.code)).toContain('AC_PROBLEM');
          return {
            toolCalls: [
              {
                id: 'c',
                name: 'operations__create_service_request',
                arguments: { service_code: 'AC_PROBLEM', fields: { issue: 'TOO_HOT' } },
              },
            ],
          };
        },
        {
          content: JSON.stringify({
            reply: 'آسفين على الحر! بلّغت فريق الصيانة وهيظبطوا التكييف في أسرع وقت.',
            handoff: null,
          }),
        },
      );
      const envelope = await guestSays('الجو حر أوي هنا', `m2-hot-${stamp}`);
      expect(await asWorker(envelope)).toBe('REPLIED');

      const [request] = (await catalog.serviceRequestsOfStay(hotel.tenantId, hotel.stayId)).filter(
        (r) => r.serviceCode === 'AC_PROBLEM',
      );
      expect(request).toMatchObject({ status: 'OPEN', source: 'AI', locale: 'ar' });
      acRequestId = request!.id;
      const work = await h.app
        .get<OperationsPublicApi>(OPERATIONS_API)
        .getWorkItem(hotel.tenantId, request!.workItemId!);
      expect(work).toMatchObject({ departmentCode: 'ENG', priority: 'HIGH' });

      const thread = (
        await h.http().get('/guest/conversation').set(GUEST_SESSION_HEADER, token).expect(200)
      ).body.messages as Array<{ senderType: string; body: string }>;
      expect(thread.at(-1)).toMatchObject({ senderType: 'AI' });
      expect(thread.at(-1)!.body).toContain('التكييف');

      // One correlation id from the guest's message to the work, the audit and the reply.
      const correlated = await h.db
        .select({ type: eventsSchema.outbox.eventType })
        .from(eventsSchema.outbox)
        .where(
          and(
            eq(eventsSchema.outbox.tenantId, hotel.tenantId),
            eq(eventsSchema.outbox.correlationId, `m2-hot-${stamp}`),
          ),
        )
        .orderBy(asc(eventsSchema.outbox.createdAt), asc(eventsSchema.outbox.id));
      expect(correlated.map((e) => e.type)).toEqual(
        expect.arrayContaining([
          'comms.message.received',
          'catalog.service_request.created',
          'ops.work_item.created',
        ]),
      );
      const audit = (
        await h.db.execute(
          sql`select actor_type, correlation_id from audit.audit_log where tenant_id = ${hotel.tenantId} and action = 'catalog.request.create' and entity_id = ${acRequestId}`,
        )
      ).rows[0] as { actor_type: string; correlation_id: string };
      expect(audit).toEqual({ actor_type: 'AI_AGENT', correlation_id: `m2-hot-${stamp}` });
      const execution = await lastExecution();
      expect(execution).toMatchObject({
        status: 'COMPLETED',
        agentCode: 'GUEST_CONCIERGE',
        correlationId: `m2-hot-${stamp}`,
      });
    });

    it('cancelling is HIGH risk: a proposal waits for a person, then runs exactly as proposed', async () => {
      fake.reset();
      fake.reply(
        { toolCalls: [{ id: 'o', name: 'operations__find_open_requests', arguments: {} }] },
        (request) => {
          const open = lastToolResult(request) as unknown as { result: Array<{ id: string }> };
          return {
            toolCalls: [
              {
                id: 'x',
                name: 'operations__cancel_service_request',
                arguments: { request_id: open.result[0]!.id, reason: 'الضيفة قالت التكييف اشتغل' },
              },
            ],
          };
        },
        (request) => {
          expect(lastToolResult(request)).toMatchObject({ status: 'PROPOSED' });
          return {
            content: JSON.stringify({
              reply: 'تمام، طلبت من الزملاء يأكدوا إلغاء طلب التكييف.',
              handoff: null,
            }),
          };
        },
      );
      const envelope = await guestSays(
        'خلاص التكييف اشتغل، الغي الطلب لو سمحت',
        `m2-cancel-${stamp}`,
      );
      expect(await asWorker(envelope)).toBe('REPLIED');
      // Nothing happened yet: a person decides.
      expect((await catalog.getServiceRequest(hotel.tenantId, acRequestId))!.status).toBe('OPEN');
      const pending = (
        await h
          .http()
          .get(`${base()}/approvals?status=PENDING`)
          .set('X-Test-Actor', gm())
          .expect(200)
      ).body as Array<{ id: string; kind: string; requestedBy: { type: string } }>;
      const approval = pending.find((a) => a.kind === 'AI_ACTION')!;
      expect(approval.requestedBy.type).toBe('AI_AGENT');
      await h
        .http()
        .post(`${base()}/approvals/${approval.id}/decision`)
        .set('X-Test-Actor', gm())
        .send({ decision: 'APPROVE', reason: 'الضيفة أكدت' })
        .expect(200);
      expect((await catalog.getServiceRequest(hotel.tenantId, acRequestId))!.status).toBe(
        'CANCELLED',
      );

      // The execution record holds every step, the proposal and its execution, and what the model calls cost.
      const execution = await lastExecution();
      expect(
        execution.steps.map((s: { type: string; outcome: string }) => `${s.type}:${s.outcome}`),
      ).toEqual([
        'CONTEXT:OK',
        'MODEL_CALL:TOOL_CALLS',
        'TOOL_CALL:OK',
        'MODEL_CALL:TOOL_CALLS',
        'TOOL_CALL:PROPOSED',
        'MODEL_CALL:STOP',
        'DECISION:ANSWER',
        'TOOL_CALL:OK',
        'RESPONSE:OK',
        'APPROVAL:EXECUTED',
      ]);
      expect(execution.proposals).toMatchObject([
        { toolCode: 'operations.cancel_service_request', risk: 'HIGH', status: 'EXECUTED' },
      ]);
      expect(execution.modelCalls).toHaveLength(3);
      const cancelAudit = (
        await h.db.execute(
          sql`select actor_type, actor_id from audit.audit_log where tenant_id = ${hotel.tenantId} and action = 'catalog.request.cancel' and entity_id = ${acRequestId}`,
        )
      ).rows[0] as { actor_type: string; actor_id: string };
      expect(cancelAudit).toEqual({ actor_type: 'AI_AGENT', actor_id: execution.id });
      const decided = (
        await h.db
          .select({ type: eventsSchema.outbox.eventType })
          .from(eventsSchema.outbox)
          .where(
            and(
              eq(eventsSchema.outbox.tenantId, hotel.tenantId),
              like(eventsSchema.outbox.eventType, 'ops.approval.%'),
            ),
          )
      ).map((e) => e.type);
      expect(decided).toEqual(
        expect.arrayContaining(['ops.approval.requested', 'ops.approval.decided']),
      );
    });
  },
);
