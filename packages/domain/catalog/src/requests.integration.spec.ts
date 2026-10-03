import { sql } from 'drizzle-orm';
import {
  createEnvelope,
  type EventEnvelope,
  GuestAnonymized,
  StayStatusChanged,
} from '@hotella/contracts-events';
import { OPERATIONS_API, type OperationsPublicApi, WorkService } from '@hotella/domain-operations';
import { newId } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RequestLifecycle } from './application/request-lifecycle';
import {
  createHotel,
  guestSession,
  type Harness,
  type Hotel,
  seedStay,
  type SeededStay,
  staff,
  startCatalogApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();
const STAFF = [
  'org.property.read',
  'org.property.manage',
  'org.location.manage',
  'org.department.manage',
  'catalog.read',
  'catalog.manage',
  'catalog.publish',
  'request.read',
  'request.create',
  'request.manage',
  'task.read',
  'task.accept',
  'task.complete',
  'task.assign',
  'sla.manage',
];

interface Created {
  request: { id: string; status: string; relatedCount: number; workItemId: string; source: string };
  related: boolean;
}

describe.skipIf(needsInfra())(`Service requests against PostgreSQL (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const clerkId = newId();
  const otherId = newId();
  const grants: Record<string, string[]> = {
    [gmId]: STAFF,
    [clerkId]: ['request.read'],
    [otherId]: STAFF,
  };
  let h: Harness;
  let hotel: Hotel;
  let stay: SeededStay;
  let mona: string;
  let ali: string;
  const gm = () => staff(gmId, hotel.tenantId);
  const base = () => `/properties/${hotel.propertyId}`;
  const ask = (token: string, body: Record<string, unknown>, lang = 'ar') =>
    h
      .http()
      .post('/guest/requests')
      .set('X-Guest-Session', token)
      .set('Accept-Language', lang)
      .send(body);
  /** Delivers what the worker would: outbox events of these types, in order, to the request lifecycle. */
  const deliver = async (eventType: string, aggregateId?: string) => {
    const rows = (
      await h.db.execute(sql`select envelope from platform.outbox where event_type = ${eventType}
        and tenant_id = ${hotel.tenantId} ${aggregateId ? sql`and aggregate_id = ${aggregateId}` : sql``} order by id`)
    ).rows as Array<{ envelope: EventEnvelope }>;
    for (const r of rows) await h.app.get(RequestLifecycle).apply(r.envelope);
  };

  beforeAll(async () => {
    h = await startCatalogApp(url, 'hotella_app_catalog_req', grants);
    hotel = await createHotel(h, `req-a-${stamp}`, gmId, ['504', '505']);
    stay = await seedStay(h.db, hotel, '504');
    mona = await guestSession(h, hotel, stay.stayId, stay.primary);
    ali = await guestSession(h, hotel, stay.stayId, stay.companion);
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

  it('a guest asks for towels in Arabic: request, housekeeping work with SLA, audit and event share one correlation id', async () => {
    const res = await ask(mona, {
      serviceCode: 'EXTRA_TOWELS',
      fields: { quantity: 2, notes: 'قرب الشباك' },
    })
      .set('X-Correlation-Id', `corr-${stamp}`)
      .expect(201);
    const created = res.body as Created;
    expect(created).toMatchObject({
      related: false,
      request: { status: 'OPEN', source: 'GUEST_WEB' },
    });

    const work = await h.app
      .get<OperationsPublicApi>(OPERATIONS_API)
      .getWorkItem(hotel.tenantId, created.request.workItemId);
    expect(work).toMatchObject({
      kind: 'SERVICE_REQUEST',
      status: 'OPEN',
      departmentCode: 'HK',
      serviceCode: 'EXTRA_TOWELS',
      stayId: stay.stayId,
      guestId: stay.primary,
      locationId: hotel.rooms['504'],
      source: { module: 'catalog', entityType: 'service_request', entityId: created.request.id },
    });
    expect(work!.tasks).toHaveLength(1);
    expect(work!.tasks[0]).toMatchObject({ departmentCode: 'HK', assignee: null });
    const [sla] = (
      await h.db.execute(sql`select response_minutes, resolution_minutes from ops.sla_instances
        where work_item_id = ${created.request.workItemId}`)
    ).rows as Array<{ response_minutes: number; resolution_minutes: number }>;
    expect(sla).toEqual({ response_minutes: 10, resolution_minutes: 30 });
    // The work title is a key with the service name and the room — never the guest's words.
    const [title] = (
      await h.db.execute(
        sql`select title, title_key, title_params from ops.work_items where id = ${created.request.workItemId}`,
      )
    ).rows as Array<{
      title: string | null;
      title_key: string;
      title_params: Record<string, string>;
    }>;
    expect(title).toEqual({
      title: null,
      title_key: 'catalog.request.work_title',
      title_params: { service: 'Extra towels', room: '504' },
    });

    const audit = (
      await h.db.execute(sql`select correlation_id, actor_type from audit.audit_log
        where entity_id = ${created.request.id} and action = 'catalog.request.create'`)
    ).rows as Array<{ correlation_id: string; actor_type: string }>;
    expect(audit).toEqual([{ correlation_id: `corr-${stamp}`, actor_type: 'GUEST' }]);
    const outbox = (
      await h.db.execute(sql`select event_type, correlation_id from platform.outbox
        where correlation_id = ${`corr-${stamp}`} order by id`)
    ).rows as Array<{ event_type: string }>;
    expect(outbox.map((r) => r.event_type)).toEqual(
      expect.arrayContaining(['ops.work_item.created', 'catalog.service_request.created']),
    );
    const [event] = (
      await h.db.execute(sql`select envelope->'payload' as payload from platform.outbox
        where event_type = 'catalog.service_request.created' and aggregate_id = ${created.request.id}`)
    ).rows as Array<{ payload: Record<string, unknown> }>;
    expect(JSON.stringify(event!.payload)).not.toContain('الشباك');

    // The guest sees it in their language.
    const mine = await h
      .http()
      .get('/guest/requests')
      .set('X-Guest-Session', mona)
      .set('Accept-Language', 'ar')
      .expect(200);
    expect(mine.body[0]).toMatchObject({
      id: created.request.id,
      serviceName: 'مناشف إضافية',
      status: 'OPEN',
    });
  });

  it('asking again while it is open relates to the first request instead of duplicating it — also under concurrency', async () => {
    const first = (
      await ask(mona, { serviceCode: 'EXTRA_TOWELS', fields: { quantity: 1 } }).expect(201)
    ).body as Created;
    expect(first.related).toBe(true);
    const again = (
      await ask(ali, { serviceCode: 'EXTRA_TOWELS', fields: { quantity: 3 } }, 'en').expect(201)
    ).body as Created;
    expect(again).toMatchObject({
      related: true,
      request: { id: first.request.id, relatedCount: 2 },
    });
    const [count] = (
      await h.db
        .execute(sql`select count(*)::int as n from ops.work_items where tenant_id = ${hotel.tenantId}
        and service_code = 'EXTRA_TOWELS'`)
    ).rows as Array<{ n: number }>;
    expect(count!.n).toBe(1);

    // Two asks for room cleaning at the same moment: one request, one related ask.
    const both = await Promise.all([
      ask(mona, { serviceCode: 'ROOM_CLEANING', fields: { preferred_time: 'NOW' } }),
      ask(ali, { serviceCode: 'ROOM_CLEANING', fields: { preferred_time: 'LATER_TODAY' } }),
    ]);
    expect(both.map((r) => r.status)).toEqual([201, 201]);
    expect(both.map((r) => (r.body as Created).related).sort()).toEqual([false, true]);
    expect(new Set(both.map((r) => (r.body as Created).request.id)).size).toBe(1);

    const detail = await h
      .http()
      .get(`${base()}/service-requests/${first.request.id}`)
      .set('X-Test-Actor', gm())
      .expect(200);
    expect(detail.body.history.map((e: { type: string }) => e.type)).toEqual([
      'CREATED',
      'RELATED',
      'RELATED',
    ]);
    expect(detail.body.history[2]).toMatchObject({ actorType: 'GUEST', fields: { quantity: 3 } });
  });

  it('refuses what the guest may not ask for, with a localized reason', async () => {
    // Fields are validated before anything else, even when an open request would absorb the ask.
    const tooMany = await ask(
      mona,
      { serviceCode: 'EXTRA_TOWELS', fields: { quantity: 9 } },
      'en',
    ).expect(422);
    expect(tooMany.body).toMatchObject({
      code: 'catalog.request.field_invalid',
      detail: 'Please check "quantity".',
    });
    const invalid = await ask(
      mona,
      { serviceCode: 'AC_PROBLEM', fields: { issue: 'WARM' } },
      'en',
    ).expect(422);
    expect(invalid.body).toMatchObject({ code: 'catalog.request.field_invalid' });
    const companion = await ask(
      ali,
      { serviceCode: 'LATE_CHECKOUT_REQUEST', fields: { until: 'H14' } },
      'ar',
    ).expect(422);
    expect(companion.body.code).toBe('catalog.request.guest_not_eligible');
    expect(companion.body.detail).toBe('لا يطلب هذه الخدمة إلا النزيل الرئيسي في الحجز.');
    await ask(mona, { serviceCode: 'NO_SUCH_SERVICE', fields: {} }).expect(404);
    await ask(mona, {
      serviceCode: 'AC_PROBLEM',
      fields: { issue: 'TOO_HOT' },
      requestedForAt: '2030-01-01T10:00:00+02:00',
    }).expect(422);
    await h
      .http()
      .post('/guest/requests')
      .send({ serviceCode: 'AC_PROBLEM', fields: {} })
      .expect(401);
  });

  it('the request follows its work: staff take and finish the task, the request completes', async () => {
    const created = (
      await ask(mona, { serviceCode: 'AC_PROBLEM', fields: { issue: 'TOO_HOT' } }).expect(201)
    ).body as Created;
    const work = await h.app
      .get<OperationsPublicApi>(OPERATIONS_API)
      .getWorkItem(hotel.tenantId, created.request.workItemId);
    expect(work!.departmentCode).toBe('ENG');
    const task = work!.tasks[0]!;
    await h
      .http()
      .post(`${base()}/tasks/${task.id}/accept`)
      .set('X-Test-Actor', gm())
      .send({})
      .expect(200);
    await h
      .http()
      .post(`${base()}/tasks/${task.id}/start`)
      .set('X-Test-Actor', gm())
      .send({})
      .expect(200);
    await deliver('ops.work_item.status_changed', created.request.workItemId);
    let view = await h
      .http()
      .get(`/guest/requests/${created.request.id}`)
      .set('X-Guest-Session', mona)
      .expect(200);
    expect(view.body.status).toBe('IN_PROGRESS');
    // Nobody can withdraw it from the guest side once started.
    await h
      .http()
      .post(`/guest/requests/${created.request.id}/cancel`)
      .set('X-Guest-Session', mona)
      .expect(409);

    await h
      .http()
      .post(`${base()}/tasks/${task.id}/complete`)
      .set('X-Test-Actor', gm())
      .send({})
      .expect(200);
    await deliver('ops.work_item.status_changed', created.request.workItemId);
    await deliver('ops.work_item.status_changed', created.request.workItemId); // redelivery is harmless
    view = await h
      .http()
      .get(`/guest/requests/${created.request.id}`)
      .set('X-Guest-Session', mona)
      .set('Accept-Language', 'ar')
      .expect(200);
    expect(view.body).toMatchObject({ status: 'COMPLETED', serviceName: 'مشكلة في التكييف' });
    expect(view.body.closedAt).not.toBeNull();
    const statuses = (
      await h.db.execute(sql`select envelope->'payload'->>'to' as "to" from platform.outbox
        where event_type = 'catalog.service_request.status_changed' and aggregate_id = ${created.request.id} order by id`)
    ).rows as Array<{ to: string }>;
    expect(statuses.map((r) => r.to)).toEqual(['IN_PROGRESS', 'COMPLETED']);
    // The companion does not see the primary guest's requests; the primary sees the stay's.
    await h
      .http()
      .get(`/guest/requests/${created.request.id}`)
      .set('X-Guest-Session', ali)
      .expect(404);
  });

  it('cancelling: the guest while open, staff with a reason; the work is cancelled with it', async () => {
    const wifi = (
      await ask(ali, { serviceCode: 'WIFI_HELP', fields: { issue: 'SLOW' } }).expect(201)
    ).body as Created;
    const cancelled = await h
      .http()
      .post(`/guest/requests/${wifi.request.id}/cancel`)
      .set('X-Guest-Session', ali)
      .expect(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(
      (await h.app
        .get<OperationsPublicApi>(OPERATIONS_API)
        .getWorkItem(hotel.tenantId, wifi.request.workItemId))!.status,
    ).toBe('CANCELLED');
    await h
      .http()
      .post(`/guest/requests/${wifi.request.id}/cancel`)
      .set('X-Guest-Session', ali)
      .expect(409);
    // The cancellation also comes back as a work item event: nothing changes twice.
    await deliver('ops.work_item.status_changed', wifi.request.workItemId);

    const transfer = (
      await h
        .http()
        .post(`${base()}/stays/${stay.stayId}/service-requests`)
        .set('X-Test-Actor', gm())
        .set('Accept-Language', 'en')
        .send({
          serviceCode: 'AIRPORT_TRANSFER',
          fields: { pickup_at: '2030-05-01T10:00:00+02:00', passengers: 2 },
        })
        .expect(201)
    ).body as Created;
    expect(transfer.request).toMatchObject({ source: 'STAFF', status: 'OPEN' });
    await h
      .http()
      .post(`${base()}/stays/${stay.stayId}/service-requests`)
      .set('X-Test-Actor', staff(clerkId, hotel.tenantId))
      .send({ serviceCode: 'AIRPORT_TRANSFER', fields: {} })
      .expect(403);
    const byStaff = await h
      .http()
      .post(`${base()}/service-requests/${transfer.request.id}/cancel`)
      .set('X-Test-Actor', gm())
      .send({ reason: 'Guest arranged their own car' })
      .expect(200);
    expect(byStaff.body.status).toBe('CANCELLED');

    const board = await h
      .http()
      .get(`${base()}/service-requests?status=CANCELLED`)
      .set('X-Test-Actor', staff(clerkId, hotel.tenantId))
      .set('Accept-Language', 'en')
      .expect(200);
    expect(board.body.map((r: { serviceCode: string }) => r.serviceCode).sort()).toEqual([
      'AIRPORT_TRANSFER',
      'WIFI_HELP',
    ]);
    expect(board.body[0]).toMatchObject({
      roomNumber: '504',
      serviceName: 'Airport transfer',
      guestName: 'Mona Delta',
    });
  });

  it('when the stay leaves the house, asks nobody started are withdrawn', async () => {
    const other = await seedStay(h.db, hotel, '505');
    const token = await guestSession(h, hotel, other.stayId, other.primary);
    const open = (
      await ask(token, { serviceCode: 'EXTRA_TOWELS', fields: { quantity: 1 } }).expect(201)
    ).body as Created;
    const envelope = createEnvelope(StayStatusChanged, {
      eventId: newId(),
      tenantId: hotel.tenantId,
      propertyId: hotel.propertyId,
      source: 'guest',
      correlationId: null,
      payload: {
        stay_id: other.stayId,
        primary_guest_id: other.primary,
        from: 'IN_HOUSE',
        to: 'CHECKED_OUT',
        at: new Date().toISOString(),
        room_id: hotel.rooms['505']!,
      },
    });
    await h.app.get(RequestLifecycle).apply(envelope);
    const [row] = (
      await h.db.execute(
        sql`select status from catalog.service_requests where id = ${open.request.id}`,
      )
    ).rows as Array<{ status: string }>;
    expect(row!.status).toBe('CANCELLED');
  });

  it('anonymization removes the guest’s words from requests, asks and their work; history stays', async () => {
    const towels = (
      (
        await h.db
          .execute(sql`select id from catalog.service_requests where stay_id = ${stay.stayId}
        and service_code = 'EXTRA_TOWELS'`)
      ).rows as Array<{ id: string }>
    )[0]!;
    const quoted = await h.app.get<OperationsPublicApi>(OPERATIONS_API).createWorkItem({
      tenantId: hotel.tenantId,
      propertyId: hotel.propertyId,
      kind: 'SERVICE_REQUEST',
      source: { module: 'catalog', entityType: 'note', entityId: null },
      title: { text: 'Mona Delta wants the minibar emptied' },
      stayId: stay.stayId,
      guestId: stay.primary,
      departmentCode: 'HK',
    });
    const envelope = createEnvelope(GuestAnonymized, {
      eventId: newId(),
      tenantId: hotel.tenantId,
      propertyId: null,
      source: 'guest',
      correlationId: null,
      payload: { guest_id: stay.primary },
    });
    await h.app.get(RequestLifecycle).apply(envelope);
    await h.app.get(WorkService).redactGuestText(hotel.tenantId, stay.primary);

    const [request] = (
      await h.db.execute(sql`select fields from catalog.service_requests where id = ${towels.id}`)
    ).rows as Array<{ fields: Record<string, unknown> }>;
    expect(request!.fields).toEqual({ quantity: 2 });
    const [item] = (
      await h.db.execute(sql`select title, title_key from ops.work_items where id = ${quoted.id}`)
    ).rows as Array<{ title: string | null; title_key: string }>;
    expect(item).toEqual({ title: null, title_key: 'ops.work.title_redacted' });
    // History rows cannot be rewritten, only emptied of the guest's words.
    await expect(
      h.db.execute(
        sql`update catalog.service_request_events set fields = '{"quantity": 99}' where request_id = ${towels.id} and type = 'RELATED'`,
      ),
    ).rejects.toThrow();
    await expect(
      h.db.execute(sql`delete from catalog.service_request_events where request_id = ${towels.id}`),
    ).rejects.toThrow();
  });

  it('tenants never reach each other’s requests (404)', async () => {
    const other = await createHotel(h, `req-b-${stamp}`, otherId);
    const otherStaff = staff(otherId, other.tenantId);
    const [mine] = (
      await h.db.execute(
        sql`select id from catalog.service_requests where tenant_id = ${hotel.tenantId} limit 1`,
      )
    ).rows as Array<{ id: string }>;
    await h
      .http()
      .get(`/properties/${other.propertyId}/service-requests/${mine!.id}`)
      .set('X-Test-Actor', otherStaff)
      .expect(404);
    await h
      .http()
      .post(`/properties/${other.propertyId}/service-requests/${mine!.id}/cancel`)
      .set('X-Test-Actor', otherStaff)
      .send({})
      .expect(404);
    await h.http().get(`${base()}/service-requests`).set('X-Test-Actor', otherStaff).expect(404);
    const theirs = await h
      .http()
      .get(`/properties/${other.propertyId}/service-requests`)
      .set('X-Test-Actor', otherStaff)
      .expect(200);
    expect(theirs.body).toEqual([]);
  });
});
