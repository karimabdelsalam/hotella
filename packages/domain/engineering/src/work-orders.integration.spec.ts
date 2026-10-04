import { sql } from 'drizzle-orm';
import { type EventEnvelope } from '@hotella/contracts-events';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { ENGINEERING_API, type EngineeringPublicApi } from './public';
import { newId } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHotel,
  type EngHarness,
  type Hotel,
  staff,
  startEngineeringApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();

interface WorkOrder {
  id: string;
  number: number;
  workItemId: string;
  type: string;
  source: string;
  status: string;
  assetId: string | null;
  version: number;
  codingMissing: string[];
  downtimeMinutes: number | null;
}

describe.skipIf(needsInfra())(`Engineering work orders (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const STAFF = [
    'org.property.read',
    'org.property.manage',
    'org.location.manage',
    'org.department.manage',
    'eng.asset.read',
    'eng.asset.manage',
    'eng.config.manage',
    'eng.work_order.read',
    'eng.work_order.manage',
    'eng.parts.manage',
    'task.read',
    'task.accept',
    'task.complete',
  ];
  let h: EngHarness;
  let hotel: Hotel;
  let other: Hotel;
  const gm = (tenantId = hotel.tenantId) => staff(gmId, tenantId);
  const base = () => `/properties/${hotel.propertyId}/eng`;
  const ops = () => h.app.get<OperationsPublicApi>(OPERATIONS_API);
  const outbox = async (type: string) =>
    (
      (
        await h.db.execute(
          sql`select envelope from platform.outbox where tenant_id = ${hotel.tenantId} and event_type = ${type} order by id`,
        )
      ).rows as Array<{ envelope: EventEnvelope }>
    ).map((r) => r.envelope.payload as Record<string, unknown>);
  let unit504: { id: string };
  let unit505: { id: string };

  beforeAll(async () => {
    h = await startEngineeringApp(url, 'hotella_app_eng_wo', { [gmId]: STAFF });
    hotel = await createHotel(h, `engw-a-${stamp}`, gmId);
    other = await createHotel(h, `engw-b-${stamp}`, gmId, ['900']);
    await h
      .http()
      .post(`/properties/${hotel.propertyId}/departments`)
      .set('X-Test-Actor', gm())
      .send({ code: 'ENG', translations: [{ locale: 'en', name: 'Engineering' }] })
      .expect(201);
    await h.http().post('/eng/failure-codes/starter').set('X-Test-Actor', gm()).expect(201);
    const type = (
      await h
        .http()
        .post('/eng/asset-types')
        .set('X-Test-Actor', gm())
        .send({ code: 'FCU', translations: [{ locale: 'en', name: 'Fan-coil unit' }] })
        .expect(201)
    ).body as { id: string };
    const unit = (room: string, warrantyUntil?: string) =>
      h
        .http()
        .post(`${base()}/assets`)
        .set('X-Test-Actor', gm())
        .send({
          assetNumber: `FCU-${room}`,
          assetTypeId: type.id,
          locationId: hotel.rooms[room],
          name: `Room ${room} fan-coil`,
          ...(warrantyUntil ? { warrantyUntil } : {}),
        })
        .expect(201)
        .then((r) => r.body as { id: string });
    unit504 = await unit('504', '2099-12-31');
    unit505 = await unit('505');
  });
  afterAll(() => h?.app.close());

  it('opens corrective work for Engineering at the unit, suggests the warranty, and closes only when coded', async () => {
    await h
      .http()
      .post(`${base()}/work-orders`)
      .set('X-Test-Actor', gm())
      .send({ type: 'CORRECTIVE', assetId: unit504.id, symptomCode: 'MAKES_COFFEE' })
      .expect(422);
    const created = (
      await h
        .http()
        .post(`${base()}/work-orders`)
        .set('X-Test-Actor', gm())
        .send({ type: 'CORRECTIVE', assetId: unit504.id, symptomCode: 'NOT_COOLING' })
        .expect(201)
    ).body as WorkOrder;
    expect(created).toMatchObject({
      number: 1,
      type: 'CORRECTIVE',
      source: 'STAFF',
      status: 'OPEN',
    });
    // Lists carry the labels the screens show.
    expect(
      (await h.http().get(`${base()}/work-orders`).set('X-Test-Actor', gm()).expect(200)).body,
    ).toMatchObject([{ id: created.id, roomNumber: '504', assetNumber: 'FCU-504' }]);
    const work = await ops().getWorkItem(hotel.tenantId, created.workItemId);
    expect(work).toMatchObject({
      kind: 'ENG_WORK_ORDER',
      departmentCode: 'ENG',
      locationId: hotel.rooms['504'],
      priority: 'NORMAL',
    });
    expect(await outbox('eng.work_order.created')).toMatchObject([
      { work_order_id: created.id, symptom_code: 'NOT_COOLING', asset_id: unit504.id },
    ]);
    const warranty = (
      await h.http().get(`${base()}/warranty-cases`).set('X-Test-Actor', gm()).expect(200)
    ).body as Array<{ id: string; workOrderId: string; status: string; version: number }>;
    expect(warranty).toMatchObject([{ workOrderId: created.id, status: 'SUGGESTED' }]);
    await h
      .http()
      .post(`${base()}/warranty-cases/${warranty[0]!.id}/decision`)
      .set('X-Test-Actor', gm())
      .send({ version: warranty[0]!.version, status: 'OPENED', note: 'Vendor ticket raised' })
      .expect(200);

    const recorded = (
      await h
        .http()
        .patch(`${base()}/work-orders/${created.id}`)
        .set('X-Test-Actor', gm())
        .send({
          version: created.version,
          diagnosis: 'Compressor clicks but does not start',
          failureModeCode: 'COMPRESSOR_NOT_STARTING',
          causeCode: 'CAPACITOR_FAILED',
          downtimeStartedAt: '2026-10-03T10:00:00Z',
        })
        .expect(200)
    ).body as WorkOrder;
    const refused = await h
      .http()
      .post(`${base()}/work-orders/${created.id}/complete`)
      .set('X-Test-Actor', gm())
      .send({ downtimeEndedAt: '2026-10-03T11:30:00Z' })
      .expect(422);
    expect(refused.body.code).toBe('eng.work_order.coding_missing');
    expect(recorded.version).toBeGreaterThan(created.version);
    const done = (
      await h
        .http()
        .post(`${base()}/work-orders/${created.id}/complete`)
        .set('X-Test-Actor', gm())
        .send({ resolutionCode: 'CAPACITOR_REPLACED', downtimeEndedAt: '2026-10-03T11:30:00Z' })
        .expect(200)
    ).body as WorkOrder;
    expect(done.status).toBe('DONE');
    expect((await ops().getWorkItem(hotel.tenantId, created.workItemId))!.status).toBe('RESOLVED');
    expect(await outbox('eng.work_order.closed')).toEqual([
      {
        work_order_id: created.id,
        asset_id: unit504.id,
        type: 'CORRECTIVE',
        status: 'DONE',
        symptom_code: 'NOT_COOLING',
        failure_mode_code: 'COMPRESSOR_NOT_STARTING',
        cause_code: 'CAPACITOR_FAILED',
        resolution_code: 'CAPACITOR_REPLACED',
        downtime_minutes: 90,
      },
    ]);
    // The repair is history arrival risk reads: corrective work done at the room this week.
    const eng = h.app.get<EngineeringPublicApi>(ENGINEERING_API);
    expect(
      await eng.recentCorrectiveWork(hotel.tenantId, hotel.propertyId, hotel.rooms['504']!, 7),
    ).toEqual({ count: 1, assetIds: [unit504.id] });
    expect(
      await eng.recentCorrectiveWork(hotel.tenantId, hotel.propertyId, hotel.rooms['505']!, 7),
    ).toEqual({ count: 0, assetIds: [] });
    // Closed work cannot be completed twice.
    await h
      .http()
      .post(`${base()}/work-orders/${created.id}/complete`)
      .set('X-Test-Actor', gm())
      .send({})
      .expect(409);
  });

  it('takes over a guest request: the same work closes both, and the room’s only unit is found', async () => {
    ops().registerWorkItemKind({
      code: 'TEST_REQUEST',
      module: 'test',
      descriptionKey: 'test.kind',
    });
    const request = await ops().createWorkItem({
      tenantId: hotel.tenantId,
      propertyId: hotel.propertyId,
      kind: 'TEST_REQUEST',
      source: { module: 'test', entityType: 'service_request', entityId: newId() },
      title: { text: 'AC problem' },
      priority: 'HIGH',
      locationId: hotel.rooms['505'],
      departmentCode: 'ENG',
    });
    const order = (
      await h
        .http()
        .post(`${base()}/work-orders/from-request`)
        .set('X-Test-Actor', gm())
        .send({ workItemId: request.id, symptomCode: 'NOT_COOLING' })
        .expect(201)
    ).body as WorkOrder;
    expect(order).toMatchObject({
      number: 2,
      workItemId: request.id,
      source: 'GUEST_REQUEST',
      assetId: unit505.id,
    });
    await h
      .http()
      .post(`${base()}/work-orders/from-request`)
      .set('X-Test-Actor', gm())
      .send({ workItemId: request.id })
      .expect(409);
    // No warranty on file for this unit: no suggestion.
    expect(
      (await h.http().get(`${base()}/warranty-cases`).set('X-Test-Actor', gm()).expect(200)).body,
    ).toHaveLength(1);
    await h
      .http()
      .post(`${base()}/work-orders/${order.id}/complete`)
      .set('X-Test-Actor', gm())
      .send({
        failureModeCode: 'LOW_REFRIGERANT',
        causeCode: 'WEAR',
        resolutionCode: 'REFRIGERANT_RECHARGED',
      })
      .expect(200);
    expect((await ops().getWorkItem(hotel.tenantId, request.id))!.status).toBe('RESOLVED');
    const list = (
      await h.http().get(`${base()}/work-orders?status=DONE`).set('X-Test-Actor', gm()).expect(200)
    ).body as WorkOrder[];
    expect(list.map((w) => w.number)).toEqual([2, 1]);
    expect(list.every((w) => w.codingMissing.length === 0)).toBe(true);
  });

  it('parts come off the shelf on a work order; stock never goes below zero; history is append-only', async () => {
    const part = (
      await h
        .http()
        .post(`${base()}/parts`)
        .set('X-Test-Actor', gm())
        .send({ partNumber: 'CAP-35UF', name: 'Run capacitor 35 µF', onHand: 5, reorderLevel: 2 })
        .expect(201)
    ).body as { id: string };
    const order = (
      await h
        .http()
        .post(`${base()}/work-orders`)
        .set('X-Test-Actor', gm())
        .send({ type: 'PREVENTIVE', assetId: unit505.id })
        .expect(201)
    ).body as WorkOrder;
    const used = await h
      .http()
      .post(`${base()}/work-orders/${order.id}/parts`)
      .set('X-Test-Actor', gm())
      .send({ partId: part.id, quantity: 4 })
      .expect(201);
    expect(used.body).toMatchObject({ onHand: 1, lowStock: true });
    const short = await h
      .http()
      .post(`${base()}/work-orders/${order.id}/parts`)
      .set('X-Test-Actor', gm())
      .send({ partId: part.id, quantity: 2 })
      .expect(409);
    expect(short.body.code).toBe('eng.part.insufficient_stock');
    await h
      .http()
      .post(`${base()}/parts/${part.id}/receipts`)
      .set('X-Test-Actor', gm())
      .send({ quantity: 10 })
      .expect(201);
    const detail = (
      await h.http().get(`${base()}/work-orders/${order.id}`).set('X-Test-Actor', gm()).expect(200)
    ).body as { parts: Array<{ partNumber: string; quantity: number }>; codingMissing: string[] };
    expect(detail.parts).toMatchObject([{ partNumber: 'CAP-35UF', quantity: 4 }]);
    // Preventive work needs no failure coding.
    expect(detail.codingMissing).toEqual([]);
    expect(
      (await h.http().get(`${base()}/parts`).set('X-Test-Actor', gm()).expect(200)).body,
    ).toMatchObject([{ partNumber: 'CAP-35UF', onHand: 11, lowStock: false }]);
    const refused = await h.db
      .execute(sql`delete from eng.part_movements where part_id = ${part.id}`)
      .then(
        () => '',
        (e: Error) => String((e.cause as Error | undefined)?.message ?? e.message),
      );
    expect(refused).toMatch(/append-only/);
  });

  it('isolates tenants: another tenant’s work orders and parts are not found, and row-level security hides them', async () => {
    const [order] = (
      await h.http().get(`${base()}/work-orders`).set('X-Test-Actor', gm()).expect(200)
    ).body as WorkOrder[];
    await h
      .http()
      .get(`/properties/${other.propertyId}/eng/work-orders/${order!.id}`)
      .set('X-Test-Actor', gm(other.tenantId))
      .expect(404);
    await h
      .http()
      .post(`/properties/${other.propertyId}/eng/work-orders`)
      .set('X-Test-Actor', gm(other.tenantId))
      .send({ type: 'CORRECTIVE', assetId: unit504.id })
      .expect(404);
    const leaked = await h.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${other.tenantId}, true)`);
      return (
        await tx.execute(
          sql`select (select count(*)::int from eng.work_orders where tenant_id = ${hotel.tenantId})
            + (select count(*)::int from eng.parts where tenant_id = ${hotel.tenantId})
            + (select count(*)::int from eng.part_movements where tenant_id = ${hotel.tenantId})
            + (select count(*)::int from eng.warranty_cases where tenant_id = ${hotel.tenantId}) as n`,
        )
      ).rows[0] as { n: number };
    });
    expect(leaked.n).toBe(0);
  });
});
