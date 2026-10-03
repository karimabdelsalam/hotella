import { and, asc, eq, like, sql } from 'drizzle-orm';
import type { EventEnvelope } from '@hotella/contracts-events';
import {
  ChannelAdapterRegistry,
  ConversationService,
  FakeWhatsAppProvider,
} from '@hotella/domain-communications';
import { projectOnce, StayProjector } from '@hotella/domain-guest';
import { IngestService } from '@hotella/domain-integrations';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations';
import { newId } from '@hotella/platform-database';
import { IdempotentConsumer, eventsSchema } from '@hotella/platform-events';
import { RequestContext } from '@hotella/platform-observability';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestLifecycle } from './application/request-lifecycle';
import { createHotel, type Harness, type Hotel, staff, startCatalogApp } from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();
const PHONE = '+201001112233';
const STAFF = [
  'org.property.read',
  'org.property.manage',
  'org.location.manage',
  'org.department.manage',
  'integration.read',
  'integration.configure',
  'integration.mapping.confirm',
  'catalog.read',
  'catalog.manage',
  'catalog.publish',
  'request.read',
  'request.create',
  'request.manage',
  'task.read',
  'task.accept',
  'task.complete',
  'sla.manage',
  'channel.manage',
  'guest.read',
  'stay.read',
  'guest.activation.issue',
];

/**
 * Milestone M1 (BUILD_PLAN §1.5, §9.4): a PMS check-in (canonical events from the simulator's connector) → activation
 * → EXTRA_TOWELS asked in Arabic → housekeeping work with SLA → staff completes → the guest is told in Arabic on
 * WhatsApp (fake provider) → every step carries a correlation id; a second identical ask is related, not duplicated.
 * Worker steps run the way the worker runs them: the event's correlation id becomes the request context.
 */
describe.skipIf(needsInfra())(`M1: a guest is served from PMS data (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const whatsapp = new FakeWhatsAppProvider();
  let h: Harness;
  let hotel: Hotel;
  let instanceId: string;
  let stayId: string;
  let session: string;
  let request: { id: string; workItemId: string };
  const gm = () => staff(gmId, hotel.tenantId);
  const base = () => `/properties/${hotel.propertyId}`;
  let seq = 0;

  /** Runs a worker step inside the context the queue would give it (the event's correlation id). */
  const asWorker = <T>(envelope: EventEnvelope, fn: () => Promise<T>) =>
    h.app.get(RequestContext).run(
      {
        correlation_id: envelope.correlation_id ?? undefined,
        tenant_id: envelope.tenant_id,
        property_id: envelope.property_id,
      },
      fn,
    );
  const outbox = (type: string) =>
    h.db
      .select()
      .from(eventsSchema.outbox)
      .where(
        and(
          eq(eventsSchema.outbox.tenantId, hotel.tenantId),
          like(eventsSchema.outbox.eventType, type),
        ),
      )
      .orderBy(asc(eventsSchema.outbox.createdAt), asc(eventsSchema.outbox.id));

  beforeAll(async () => {
    h = await startCatalogApp(url, 'hotella_app_catalog_m1', { [gmId]: STAFF });
    h.app.get(ChannelAdapterRegistry).register(whatsapp);
    hotel = await createHotel(h, `m1-${stamp}`, gmId);
    instanceId = (
      await h
        .http()
        .post(`${base()}/integrations`)
        .set('X-Test-Actor', gm())
        .send({
          connectorCode: 'SIM_PMS',
          name: 'Simulator',
          capabilities: [
            'CHECKIN_EVENT',
            'CHECKOUT_EVENT',
            'ROOM_MOVE_EVENT',
            'PROFILE_EVENT',
            'RESERVATION_READ',
            'GUEST_READ',
          ],
        })
        .expect(201)
    ).body.id;
    await h
      .http()
      .patch(`${base()}/integrations/${instanceId}`)
      .set('X-Test-Actor', gm())
      .send({ version: 1, status: 'ACTIVE' })
      .expect(200);
    await h
      .http()
      .post(`${base()}/integrations/${instanceId}/mappings/rooms-by-number`)
      .set('X-Test-Actor', gm())
      .expect(200);
    await h
      .http()
      .post(`${base()}/channels`)
      .set('X-Test-Actor', gm())
      .send({
        type: 'WHATSAPP',
        name: 'WhatsApp',
        providerCode: 'FAKE_WHATSAPP',
        credentialRef: 'env://FAKE_SECRET',
      })
      .expect(201);
    await h.http().post(`${base()}/catalog/starter`).set('X-Test-Actor', gm()).send({}).expect(200);
    await h
      .http()
      .post(`${base()}/sla-policies`)
      .set('X-Test-Actor', gm())
      .send({
        code: 'TOWELS',
        matchServiceCode: 'EXTRA_TOWELS',
        responseMinutes: 10,
        resolutionMinutes: 30,
        pauseReasons: [],
        escalationRules: [],
      })
      .expect(201);
  });
  afterAll(() => h?.app.close());

  it('the PMS checks the guest in (simulator connector → canonical events → stay in house)', async () => {
    const ingest = h.app.get(IngestService);
    const send = (message_type: string, payload: unknown) =>
      ingest.ingest(instanceId, {
        message_type,
        source_message_id: `${stamp}-${++seq}`,
        sequence_no: seq,
        payload,
      });
    const today = new Date();
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    const fiasDate = (d: Date) => ymd(d).slice(2).replaceAll('-', '');
    const departure = new Date(today.getTime() + 3 * 86_400_000);
    expect(
      (
        await send('OWS_RESERVATION', {
          action: 'NEW',
          modifiedAt: today.toISOString(),
          reservation: {
            reservationId: `M1-${stamp}`,
            confirmationNo: `CM1-${stamp}`,
            arrivalDate: ymd(today),
            departureDate: ymd(departure),
            adults: 1,
            roomNumber: '504',
            guest: {
              profileId: `PM1-${stamp}`,
              firstName: 'Mona',
              lastName: 'Delta',
              language: 'ar',
              phone: PHONE,
            },
          },
        })
      ).status,
    ).toBe('PROCESSED');
    expect(
      (
        await send('FIAS_RECORD', {
          record: `GI|RN504|G#M1-${stamp}|GNDelta|GFMona|GLar|GA${fiasDate(today)}|GD${fiasDate(departure)}|DA${fiasDate(today)}|TI090000|`,
        })
      ).status,
    ).toBe('PROCESSED');
    const project = projectOnce(h.app.get(IdempotentConsumer), h.app.get(StayProjector));
    for (const row of await outbox('hotel.%')) await project(row.envelope as EventEnvelope);
    const [stay] = (
      await h.db.execute(
        sql`select id, status from guest.stays where tenant_id = ${hotel.tenantId}`,
      )
    ).rows as Array<{ id: string; status: string }>;
    expect(stay!.status).toBe('IN_HOUSE');
    stayId = stay!.id;
  });

  it('front desk sends the link; the guest activates with the WhatsApp code (no PMS change)', async () => {
    const link = (
      await h
        .http()
        .post(`${base()}/stays/${stayId}/activation-tokens`)
        .set('X-Test-Actor', gm())
        .send({})
        .expect(201)
    ).body as { token: string };
    await h.http().post('/guest/activation/start').send({ token: link.token }).expect(200);
    const otp = await h
      .http()
      .post('/guest/activation/otp/request')
      .set('Accept-Language', 'ar')
      .send({ token: link.token, phone: '0100 111 2233' })
      .expect(200);
    expect(otp.body.sentVia).toBe('WHATSAPP');
    const code = whatsapp.sent.at(-1)!.parameters![0]!;
    const verified = await h
      .http()
      .post('/guest/activation/otp/verify')
      .send({ handle: otp.body.handle, code, device: 'm1' })
      .expect(200);
    expect(verified.body.scopes).toEqual(expect.arrayContaining(['SERVICE_REQUEST', 'CHAT']));
    session = verified.body.sessionToken;
  });

  it('the guest asks for towels in Arabic: housekeeping gets the work with its SLA; asking again relates', async () => {
    const created = await h
      .http()
      .post('/guest/requests')
      .set('X-Guest-Session', session)
      .set('Accept-Language', 'ar')
      .set('X-Correlation-Id', `m1-ask-${stamp}`)
      .send({ serviceCode: 'EXTRA_TOWELS', fields: { quantity: 2 } })
      .expect(201);
    expect(created.body.related).toBe(false);
    request = created.body.request;
    const work = await h.app
      .get<OperationsPublicApi>(OPERATIONS_API)
      .getWorkItem(hotel.tenantId, request.workItemId);
    expect(work).toMatchObject({ kind: 'SERVICE_REQUEST', departmentCode: 'HK', status: 'OPEN' });
    const [sla] = (
      await h.db.execute(
        sql`select resolution_minutes from ops.sla_instances where work_item_id = ${request.workItemId}`,
      )
    ).rows as Array<{ resolution_minutes: number }>;
    expect(sla!.resolution_minutes).toBe(30);

    const again = await h
      .http()
      .post('/guest/requests')
      .set('X-Guest-Session', session)
      .set('Accept-Language', 'ar')
      .send({ serviceCode: 'EXTRA_TOWELS', fields: { quantity: 2 } })
      .expect(201);
    expect(again.body).toMatchObject({
      related: true,
      request: { id: request.id, relatedCount: 1 },
    });
  });

  it('staff complete the task; the request completes and the guest is told in Arabic on WhatsApp', async () => {
    const work = await h.app
      .get<OperationsPublicApi>(OPERATIONS_API)
      .getWorkItem(hotel.tenantId, request.workItemId);
    const task = work!.tasks[0]!;
    whatsapp.reset();
    // Each staff action, then what the worker does with it: the work item's events are followed in their own
    // context, then the outbound job sends.
    const delivered = new Set<string>();
    for (const action of ['accept', 'start', 'complete']) {
      await h
        .http()
        .post(`${base()}/tasks/${task.id}/${action}`)
        .set('X-Test-Actor', gm())
        .set('X-Correlation-Id', `m1-${action}-${stamp}`)
        .send({})
        .expect(200);
      for (const row of (await outbox('ops.work_item.status_changed')).filter(
        (r) => r.aggregateId === request.workItemId && !delivered.has(r.id),
      )) {
        delivered.add(row.id);
        const envelope = row.envelope as EventEnvelope;
        await asWorker(envelope, () => h.app.get(RequestLifecycle).apply(envelope));
      }
      await h.app.get(ConversationService).sendDue(new Date(Date.now() + 1000));
    }

    const mine = await h
      .http()
      .get('/guest/requests')
      .set('X-Guest-Session', session)
      .set('Accept-Language', 'ar')
      .expect(200);
    expect(mine.body[0]).toMatchObject({
      id: request.id,
      status: 'COMPLETED',
      serviceName: 'مناشف إضافية',
    });
    expect(whatsapp.sent.map((m) => [m.to, m.template, m.parameters])).toEqual([
      [PHONE, 'service_update', ['مناشف إضافية', 'في الطريق إليك']],
      [PHONE, 'service_update', ['مناشف إضافية', 'تم']],
    ]);
    const thread = await h
      .http()
      .get('/guest/conversation')
      .set('X-Guest-Session', session)
      .expect(200);
    expect(thread.body.messages.map((m: { body: string }) => m.body)).toContain(
      'تم: مناشف إضافية. هل يمكننا مساعدتك في شيء آخر؟',
    );
  });

  it('the audit trail and the events link every step by correlation id', async () => {
    const audit = (
      await h.db.execute(sql`select action, actor_type, correlation_id from audit.audit_log
        where tenant_id = ${hotel.tenantId} and entity_id = ${request.id} order by occurred_at, id`)
    ).rows as Array<{ action: string; actor_type: string; correlation_id: string }>;
    expect(audit.map((a) => [a.action, a.actor_type, a.correlation_id])).toEqual([
      ['catalog.request.create', 'GUEST', `m1-ask-${stamp}`],
      ['catalog.request.relate', 'GUEST', expect.any(String)],
      // Taking the task on starts the work (the first step that moves the work item), completing it ends it.
      ['catalog.request.status', 'SYSTEM', `m1-accept-${stamp}`],
      ['catalog.request.status', 'SYSTEM', `m1-complete-${stamp}`],
    ]);
    const byCorrelation = async (id: string) =>
      (
        await h.db
          .execute(sql`select event_type from platform.outbox where tenant_id = ${hotel.tenantId}
          and correlation_id = ${id} order by created_at, id`)
      ).rows.map((r) => (r as { event_type: string }).event_type);
    // Asking: the request and its work item, in one transaction and under one id.
    expect(await byCorrelation(`m1-ask-${stamp}`)).toEqual(
      expect.arrayContaining(['ops.work_item.created', 'catalog.service_request.created']),
    );
    // Completing: the task, the work item, the request following it and the guest's notification.
    expect(await byCorrelation(`m1-complete-${stamp}`)).toEqual(
      expect.arrayContaining([
        'ops.task.status_changed',
        'ops.work_item.status_changed',
        'catalog.service_request.status_changed',
        'comms.message.sent',
      ]),
    );
  });
});
