import { sql } from 'drizzle-orm';
import type { EventEnvelope } from '@hotella/contracts-events';
import type { ToolContext } from '@hotella/domain-ai/public';
import { newId } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecoveryService } from './application/recovery.service';
import { RELATIONS_API, type RelationsPublicApi } from './public';
import {
  createHotel,
  type Hotel,
  type RelationsHarness,
  staff,
  startRelationsApp,
  TOOLS,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();

describe.skipIf(needsInfra())(`Guest relations (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const grId = newId();
  const deskId = newId();
  const GM = [
    'org.property.read',
    'org.property.manage',
    'org.location.manage',
    'complaint.read',
    'complaint.manage',
    'complaint.category.manage',
    'complaint.recovery.manage',
    'approval.read',
    'approval.decide',
  ];
  let h: RelationsHarness;
  let hotel: Hotel;
  let other: Hotel;
  let complaintId: string;
  const gm = () => staff(gmId, hotel.tenantId);
  const gr = () => staff(grId, hotel.tenantId);
  const desk = () => staff(deskId, hotel.tenantId);
  const base = () => `/properties/${hotel.propertyId}`;
  const outbox = async (type: string) =>
    (
      (
        await h.db.execute(
          sql`select envelope from platform.outbox where tenant_id = ${hotel.tenantId} and event_type = ${type} order by id`,
        )
      ).rows as Array<{ envelope: EventEnvelope }>
    ).map((r) => r.envelope.payload as Record<string, unknown>);
  const categories = async () =>
    new Map(
      (
        (await h.http().get('/relations/categories').set('X-Test-Actor', gm()).expect(200))
          .body as Array<{ code: string; id: string }>
      ).map((c) => [c.code, c.id]),
    );
  const toolCtx = (): ToolContext => ({
    tenantId: hotel.tenantId,
    propertyId: hotel.propertyId,
    executionId: newId(),
    agentCode: 'GUEST_CONCIERGE',
    locale: 'ar',
    guest: { guestId: hotel.guestId, stayId: hotel.stayId },
    conversationId: newId(),
  });

  beforeAll(async () => {
    h = await startRelationsApp(url, 'hotella_app_relations', {
      [gmId]: GM,
      [grId]: ['complaint.read', 'complaint.manage', 'complaint.recovery.manage'],
      [deskId]: ['complaint.read'],
    });
    hotel = await createHotel(h, `rel-a-${stamp}`, gmId);
    other = await createHotel(h, `rel-b-${stamp}`, gmId);
  });
  afterAll(() => h?.app.close());

  it('sets up categories: the starter set once, in English and Arabic, and the tenant’s own', async () => {
    const first = await h
      .http()
      .post('/relations/categories/starter')
      .set('X-Test-Actor', gm())
      .expect(200);
    expect(first.body.created).toBeGreaterThanOrEqual(8);
    const again = await h
      .http()
      .post('/relations/categories/starter')
      .set('X-Test-Actor', gm())
      .expect(200);
    expect(again.body).toEqual({ created: 0 });
    await h
      .http()
      .post('/relations/categories')
      .set('X-Test-Actor', gm())
      .send({
        code: 'POOL',
        defaultSeverity: 'LOW',
        names: [
          { locale: 'en', name: 'Pool' },
          { locale: 'ar', name: 'حمام السباحة' },
        ],
      })
      .expect(201);
    await h
      .http()
      .post('/relations/categories')
      .set('X-Test-Actor', gm())
      .send({ code: 'POOL', names: [{ locale: 'en', name: 'Pool' }] })
      .expect(409);
    await h
      .http()
      .post('/relations/categories')
      .set('X-Test-Actor', gr())
      .send({ code: 'SPA', names: [{ locale: 'en', name: 'Spa' }] })
      .expect(403);
    const ar = await h
      .http()
      .get('/relations/categories')
      .set('X-Test-Actor', gm())
      .set('Accept-Language', 'ar')
      .expect(200);
    expect(ar.body.find((c: { code: string }) => c.code === 'POOL').name).toBe('حمام السباحة');
    expect(ar.body.find((c: { code: string }) => c.code === 'NOISE').name).toBe('الضوضاء');
  });

  it('records a complaint against a stay and a room, numbered per property, with every status change kept', async () => {
    const cats = await categories();
    const opened = await h
      .http()
      .post(`${base()}/complaints`)
      .set('X-Test-Actor', gr())
      .send({
        categoryId: cats.get('NOISE'),
        summary: 'Loud music from the next room after midnight',
        stayId: hotel.stayId,
        roomId: hotel.roomId,
      })
      .expect(201);
    complaintId = opened.body.id;
    expect(opened.body).toMatchObject({
      number: 1,
      status: 'OPEN',
      source: 'STAFF',
      guestId: hotel.guestId,
      severity: 'MEDIUM',
    });
    await h
      .http()
      .post(`${base()}/complaints`)
      .set('X-Test-Actor', desk())
      .send({ categoryId: cats.get('NOISE'), summary: 'x x x' })
      .expect(403);
    await h
      .http()
      .post(`${base()}/complaints`)
      .set('X-Test-Actor', gr())
      .send({ categoryId: cats.get('NOISE'), summary: 'Other stay', stayId: other.stayId })
      .expect(404);
    expect(await outbox('relations.complaint.opened')).toEqual([
      expect.objectContaining({ complaint_id: complaintId, number: 1, category_code: 'NOISE' }),
    ]);

    const move = (to: string, version: number) =>
      h
        .http()
        .post(`${base()}/complaints/${complaintId}/status`)
        .set('X-Test-Actor', gr())
        .send({ to, version });
    await move('CLOSED', 1).expect(409);
    await move('IN_PROGRESS', 5).expect(409);
    await move('IN_PROGRESS', 1).expect(200);
    await h
      .http()
      .post(`${base()}/complaints/${complaintId}/notes`)
      .set('X-Test-Actor', gr())
      .send({ text: 'Called the neighbouring room; music stopped.' })
      .expect(201);

    const detail = await h
      .http()
      .get(`${base()}/complaints/${complaintId}`)
      .set('X-Test-Actor', desk())
      .expect(200);
    expect(detail.body).toMatchObject({
      status: 'IN_PROGRESS',
      roomNumber: '504',
      categoryCode: 'NOISE',
      version: 2,
    });
    expect(detail.body.history.map((s: { toStatus: string }) => s.toStatus)).toEqual([
      'OPEN',
      'IN_PROGRESS',
    ]);
    expect(detail.body.evidence).toEqual([
      expect.objectContaining({ kind: 'NOTE', addedByType: 'USER' }),
    ]);

    // Evidence and history are append-only.
    const refused = await h.db
      .execute(
        sql`update relations.complaint_status_history set note = 'x' where complaint_id = ${complaintId}`,
      )
      .then(
        () => null,
        (e: Error & { cause?: Error }) => e.cause?.message ?? e.message,
      );
    expect(refused).toMatch(/append-only/);

    const list = await h
      .http()
      .get(`${base()}/complaints?status=OPEN,IN_PROGRESS`)
      .set('X-Test-Actor', desk())
      .expect(200);
    expect(list.body.map((c: { id: string }) => c.id)).toEqual([complaintId]);
  });

  it('service recovery: gestures are done at once, money waits for an approval, rejection is kept', async () => {
    const add = (body: object, actor = gr()) =>
      h
        .http()
        .post(`${base()}/complaints/${complaintId}/recovery`)
        .set('X-Test-Actor', actor)
        .send(body);
    const apology = await add({ kind: 'APOLOGY', note: 'Duty manager apologised' }).expect(201);
    expect(apology.body).toMatchObject({ status: 'DONE', approvalId: null });
    await add({ kind: 'DISCOUNT' }).expect(400);
    await add({ kind: 'AMENITY' }, desk()).expect(403);

    const discount = await add({ kind: 'DISCOUNT', amountMinor: 20_000 }).expect(201);
    expect(discount.body).toMatchObject({
      status: 'PENDING_APPROVAL',
      currency: 'EGP',
      amountMinor: 20_000,
    });
    const refund = await add({ kind: 'REFUND', amountMinor: 75_000 }).expect(201);
    const approval = (id: string) =>
      h
        .http()
        .get(`${base()}/approvals/${id}`)
        .set('X-Test-Actor', gm())
        .expect(200)
        .then((r) => r.body);
    expect(await approval(discount.body.approvalId)).toMatchObject({
      kind: 'RECOVERY_ACTION',
      riskLevel: 'MEDIUM',
      status: 'PENDING',
    });
    expect(await approval(refund.body.approvalId)).toMatchObject({ riskLevel: 'HIGH' });

    await h
      .http()
      .post(`${base()}/approvals/${discount.body.approvalId}/decision`)
      .set('X-Test-Actor', gm())
      .send({ decision: 'APPROVE' })
      .expect(200);
    await h
      .http()
      .post(`${base()}/approvals/${refund.body.approvalId}/decision`)
      .set('X-Test-Actor', gm())
      .send({ decision: 'REJECT', reason: 'Amount too high' })
      .expect(200);
    // The worker settles rejected and expired approvals (twice is harmless).
    const recovery = h.app.get(RecoveryService);
    await recovery.settle(hotel.tenantId, refund.body.approvalId, 'REJECTED');
    await recovery.settle(hotel.tenantId, refund.body.approvalId, 'REJECTED');

    const detail = await h
      .http()
      .get(`${base()}/complaints/${complaintId}`)
      .set('X-Test-Actor', gr())
      .expect(200);
    expect(
      detail.body.recovery.map((r: { kind: string; status: string }) => [r.kind, r.status]),
    ).toEqual([
      ['APOLOGY', 'DONE'],
      ['DISCOUNT', 'DONE'],
      ['REFUND', 'REJECTED'],
    ]);

    await h
      .http()
      .post(`${base()}/complaints/${complaintId}/status`)
      .set('X-Test-Actor', gr())
      .send({ to: 'RESOLVED', version: 2 })
      .expect(200);
    expect(await outbox('relations.complaint.resolved')).toEqual([
      expect.objectContaining({
        complaint_id: complaintId,
        category_code: 'NOISE',
        recovery_kinds: ['APOLOGY', 'DISCOUNT'],
      }),
    ]);
    await h
      .http()
      .post(`${base()}/complaints/${complaintId}/status`)
      .set('X-Test-Actor', gr())
      .send({ to: 'CLOSED', version: 3 })
      .expect(200);
    await add({ kind: 'AMENITY' }).expect(409);
  });

  it('the concierge suggests candidates; a person confirms one into a complaint with its evidence or dismisses it', async () => {
    const tool = TOOLS.get('relations.suggest_complaint')!;
    expect(tool).toMatchObject({ risk: 'LOW', requiredPermission: 'complaint.suggest' });
    const suggest = (args: object) => tool.handle(tool.input.parse(args), toolCtx());

    expect(
      await suggest({
        category_code: 'CLEANLINESS',
        severity: 'LOW',
        confidence: 0.4,
        summary: 'Maybe unhappy with towels',
        reason: 'Guest sounded mildly annoyed',
      }),
    ).toMatchObject({ flagged: false });
    expect(
      await suggest({
        category_code: 'CLEANLINESS',
        severity: 'HIGH',
        confidence: 0.92,
        summary: 'Room not cleaned for two days',
        reason: 'Guest says the room was not cleaned since arrival and is angry',
        guest_words: 'الأوضة متنضفتش من يومين وده مش مقبول',
      }),
    ).toEqual({ flagged: true, already_flagged: false });
    expect(
      await suggest({
        category_code: 'CLEANLINESS',
        severity: 'HIGH',
        confidence: 0.95,
        summary: 'Still not cleaned',
        reason: 'Repeated',
      }),
    ).toEqual({ flagged: true, already_flagged: true });
    // A code the tenant does not use is kept under OTHER for the person to correct.
    await suggest({
      category_code: 'PARKING',
      severity: 'MEDIUM',
      confidence: 0.8,
      summary: 'No parking space',
      reason: 'Guest complains the car park was full',
    });

    const pending = await h
      .http()
      .get(`${base()}/complaint-candidates`)
      .set('X-Test-Actor', desk())
      .set('Accept-Language', 'ar')
      .expect(200);
    const byCode = new Map(
      pending.body.map((c: { categoryCode: string }) => [c.categoryCode, c]),
    ) as Map<string, { id: string; version: number; categoryName: string }>;
    expect([...byCode.keys()].sort()).toEqual(['CLEANLINESS', 'OTHER']);
    expect(byCode.get('CLEANLINESS')!.categoryName).toBe('النظافة');

    const cats = await categories();
    const confirmed = await h
      .http()
      .post(`${base()}/complaint-candidates/${byCode.get('CLEANLINESS')!.id}/confirm`)
      .set('X-Test-Actor', gr())
      .send({ version: 1 })
      .expect(201);
    expect(confirmed.body.candidate).toMatchObject({ status: 'CONFIRMED' });
    expect(confirmed.body.complaint).toMatchObject({
      number: 2,
      source: 'AI_CANDIDATE',
      severity: 'HIGH',
      stayId: hotel.stayId,
      openedByType: 'USER',
    });
    const detail = await h
      .http()
      .get(`${base()}/complaints/${confirmed.body.complaint.id}`)
      .set('X-Test-Actor', gr())
      .expect(200);
    expect(detail.body.evidence).toEqual([
      expect.objectContaining({
        kind: 'MESSAGE',
        addedByType: 'GUEST',
        text: 'الأوضة متنضفتش من يومين وده مش مقبول',
      }),
      expect.objectContaining({ kind: 'AI_REASON', addedByType: 'AI_AGENT' }),
    ]);
    await h
      .http()
      .post(`${base()}/complaint-candidates/${byCode.get('CLEANLINESS')!.id}/confirm`)
      .set('X-Test-Actor', gr())
      .send({ version: 2 })
      .expect(409);

    // The person corrects the category while confirming… or dismisses it.
    await h
      .http()
      .post(`${base()}/complaint-candidates/${byCode.get('OTHER')!.id}/dismiss`)
      .set('X-Test-Actor', desk())
      .send({ version: 1 })
      .expect(403);
    await h
      .http()
      .post(`${base()}/complaint-candidates/${byCode.get('OTHER')!.id}/dismiss`)
      .set('X-Test-Actor', gr())
      .send({ version: 1, note: 'Hotel has no car park' })
      .expect(200);
    expect(cats.get('OTHER')).toBeDefined();
    const left = await h
      .http()
      .get(`${base()}/complaint-candidates`)
      .set('X-Test-Actor', gr())
      .expect(200);
    expect(left.body).toEqual([]);

    const open = await h.app
      .get<RelationsPublicApi>(RELATIONS_API)
      .openComplaints(hotel.tenantId, hotel.propertyId);
    expect(open).toEqual([
      expect.objectContaining({ number: 2, categoryCode: 'CLEANLINESS', status: 'OPEN' }),
    ]);
  });

  it('isolates tenants: another tenant’s complaints and candidates are not found, and RLS hides them', async () => {
    const foreign = staff(gmId, other.tenantId);
    await h
      .http()
      .get(`/properties/${other.propertyId}/complaints/${complaintId}`)
      .set('X-Test-Actor', foreign)
      .expect(404);
    await h
      .http()
      .post(`/properties/${other.propertyId}/complaints/${complaintId}/recovery`)
      .set('X-Test-Actor', foreign)
      .send({ kind: 'APOLOGY' })
      .expect(404);
    const otherList = await h
      .http()
      .get(`/properties/${other.propertyId}/complaints`)
      .set('X-Test-Actor', foreign)
      .expect(200);
    expect(otherList.body).toEqual([]);
    const rows = await h.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${other.tenantId}, true)`);
      return (
        await tx.execute(
          sql`select count(*)::int as n from relations.complaints where tenant_id = ${hotel.tenantId}`,
        )
      ).rows;
    });
    expect(rows).toEqual([{ n: 0 }]);
  });
});
