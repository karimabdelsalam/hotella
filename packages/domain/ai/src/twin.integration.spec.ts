import { sql } from 'drizzle-orm';
import {
  type EventEnvelope,
  GuestStayRoomChanged,
  ServiceRequestCreated,
  StayCreated,
  StayStatusChanged,
  TaskAssigned,
  WorkItemCreated,
  WorkOrderClosed,
  WorkOrderCreated,
} from '@hotella/contracts-events';
import { newId } from '@hotella/platform-database';
import { IdempotentConsumer } from '@hotella/platform-events';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI_TWIN_CONSUMER } from './ai.module';
import { TwinProjector } from './application/twin.service';
import { AI_TWIN_LABELS, type TwinLabelRegistrar } from './public';
import {
  type AiHarness,
  createHotel,
  type Hotel,
  STAFF_NAMES,
  staff,
  startAiApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();
const minute = (n: number) => new Date(Date.UTC(2026, 9, 5, 8, n)).toISOString();

type Def = { readonly type: string; readonly version: number };

describe.skipIf(needsInfra())(`Operational twin (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const engineerReaderId = newId();
  const otherGmId = newId();
  const noTwinId = newId();
  let h: AiHarness;
  let hotel: Hotel;
  let other: Hotel;
  const ids = {
    secondRoom: newId(),
    request: newId(),
    requestWork: newId(),
    order: newId(),
    orderWork: newId(),
    asset: newId(),
    task: newId(),
    firstEngineer: newId(),
    secondEngineer: newId(),
  };
  const gm = () => staff(gmId, hotel.tenantId);

  /** What the worker does for each event the twin follows: once per event, inside the inbox transaction. */
  const deliver = (def: Def, payload: unknown, at: string, eventId = newId()) => {
    const envelope: EventEnvelope = {
      event_id: eventId,
      event_type: def.type,
      event_version: def.version,
      tenant_id: hotel.tenantId,
      property_id: hotel.propertyId,
      source: 'test',
      source_reference: null,
      occurred_at: at,
      received_at: at,
      correlation_id: `twin-${stamp}`,
      payload,
    };
    return h.app
      .get(IdempotentConsumer)
      .once(AI_TWIN_CONSUMER, envelope, (e) => h.app.get(TwinProjector).project(e));
  };
  const twin = (path: string, actor = gm(), propertyId = hotel.propertyId) =>
    h.http().get(`/properties/${propertyId}/twin/${path}`).set('X-Test-Actor', actor);
  const refs = (body: { nodes: Array<{ kind: string; refId: string; distance: number }> }) =>
    body.nodes.map((n) => `${n.distance}:${n.kind}:${n.refId}`);

  beforeAll(async () => {
    const base = [
      'org.property.read',
      'org.property.manage',
      'org.location.manage',
      'org.department.manage',
      'catalog.read',
      'catalog.manage',
    ];
    h = await startAiApp(url, 'hotella_app_ai_twin', {
      [gmId]: [...base, 'ai.twin.read'],
      [engineerReaderId]: ['ai.twin.read', 'eng.asset.read'],
      [otherGmId]: [...base, 'ai.twin.read'],
      [noTwinId]: ['org.property.read'],
    });
    hotel = await createHotel(h, `ai-twin-${stamp}`, gmId);
    other = await createHotel(h, `ai-twin-b-${stamp}`, otherGmId);
    STAFF_NAMES.set(ids.firstEngineer, 'Karim (engineer)');
    STAFF_NAMES.set(ids.secondEngineer, 'Nour (engineer)');
    // Assets are named by engineering for readers who may see assets (here: a test labeler).
    h.app.get<TwinLabelRegistrar>(AI_TWIN_LABELS).register({
      kind: 'ASSET',
      permission: 'eng.asset.read',
      labels: async (_t, _p, wanted) =>
        new Map(wanted.filter((a) => a === ids.asset).map((a) => [a, 'AC-504 · Split unit'])),
    });

    // The Spec §80 chain as events: guest → stay → room → AC unit → failure → work order → engineer → resolution.
    await deliver(
      StayCreated,
      { stay_id: hotel.stayId, primary_guest_id: hotel.guestId, status: 'IN_HOUSE' },
      minute(1),
    );
    await deliver(
      GuestStayRoomChanged,
      {
        stay_id: hotel.stayId,
        from_room_id: null,
        to_room_id: hotel.roomId,
        reason: 'INITIAL',
        at: minute(2),
      },
      minute(2),
    );
    await deliver(
      ServiceRequestCreated,
      {
        request_id: ids.request,
        service_code: 'AC_PROBLEM',
        service_version_id: newId(),
        stay_id: hotel.stayId,
        guest_id: hotel.guestId,
        room_id: hotel.roomId,
        work_item_id: ids.requestWork,
        source: 'GUEST_WEB',
      },
      minute(3),
    );
    await deliver(
      WorkOrderCreated,
      {
        work_order_id: ids.order,
        work_item_id: ids.orderWork,
        number: 41,
        type: 'CORRECTIVE',
        source: 'GUEST_REQUEST',
        asset_id: ids.asset,
        location_id: hotel.roomId,
        symptom_code: 'NOT_COOLING',
      },
      minute(4),
    );
    await deliver(
      WorkItemCreated,
      {
        work_item_id: ids.orderWork,
        kind: 'ENG_WORK_ORDER',
        source_module: 'eng',
        source_entity_type: 'work_order',
        source_entity_id: ids.order,
        priority: 'HIGH',
        department_code: 'ENG',
        location_id: hotel.roomId,
        stay_id: null,
        task_ids: [ids.task],
      },
      minute(4),
    );
    await deliver(
      TaskAssigned,
      {
        task_id: ids.task,
        work_item_id: ids.orderWork,
        assignee: { type: 'USER', id: ids.firstEngineer },
        previous: null,
      },
      minute(5),
    );
    await deliver(
      TaskAssigned,
      {
        task_id: ids.task,
        work_item_id: ids.orderWork,
        assignee: { type: 'USER', id: ids.secondEngineer },
        previous: { type: 'USER', id: ids.firstEngineer },
      },
      minute(7),
    );
    await deliver(
      WorkOrderClosed,
      {
        work_order_id: ids.order,
        asset_id: ids.asset,
        type: 'CORRECTIVE',
        status: 'DONE',
        symptom_code: 'NOT_COOLING',
        failure_mode_code: 'REFRIGERANT_LEAK',
        cause_code: 'WEAR',
        resolution_code: 'RECHARGED',
        downtime_minutes: 95,
      },
      minute(9),
    );
    // The guest moves to another room.
    await deliver(
      GuestStayRoomChanged,
      {
        stay_id: hotel.stayId,
        from_room_id: hotel.roomId,
        to_room_id: ids.secondRoom,
        reason: 'ROOM_MOVE',
        at: minute(10),
      },
      minute(10),
    );
  });
  afterAll(() => h?.app.close());

  it('answers the connected chain around a stay, now and as it was', async () => {
    const now = (await twin(`stay/${hotel.stayId}?depth=3`).expect(200)).body;
    expect(now.root).toEqual({ kind: 'STAY', refId: hotel.stayId });
    expect(refs(now)).toEqual(
      [
        `0:STAY:${hotel.stayId}`,
        ...[
          `1:GUEST:${hotel.guestId}`,
          `1:LOCATION:${ids.secondRoom}`,
          `1:SERVICE_REQUEST:${ids.request}`,
        ].sort(),
        ...[`2:LOCATION:${hotel.roomId}`, `2:WORK_ITEM:${ids.requestWork}`].sort(),
        ...[
          `3:ASSET:${ids.asset}`,
          `3:WORK_ORDER:${ids.order}`,
          `3:WORK_ITEM:${ids.orderWork}`,
        ].sort(),
      ].sort(),
    );
    // Before the move the stay was in room 504, and the engineer first assigned was on the job.
    const before = (await twin(`stay/${hotel.stayId}?depth=1&at=${minute(6)}`).expect(200)).body;
    expect(
      before.edges.map(
        (e: { relation: string; to: { refId: string } }) => `${e.relation}:${e.to.refId}`,
      ),
    ).toContain(`IN_ROOM:${hotel.roomId}`);
    const room = before.nodes.find((n: { refId: string }) => n.refId === hotel.roomId);
    expect(room).toMatchObject({ kind: 'LOCATION', label: '504' });
    const moved = now.edges.filter((e: { relation: string }) => e.relation === 'IN_ROOM');
    expect(moved).toEqual([
      expect.objectContaining({ to: { kind: 'LOCATION', refId: ids.secondRoom }, validTo: null }),
    ]);
  });

  it('follows reassignment and resolution on the work, with names looked up for the reader', async () => {
    const work = (at?: string) =>
      twin(`work-item/${ids.orderWork}?depth=1${at ? `&at=${at}` : ''}`).expect(200);
    const staffOf = (body: { nodes: Array<{ kind: string; label: string | null }> }) =>
      body.nodes.filter((n) => n.kind === 'STAFF').map((n) => n.label);
    expect(staffOf((await work()).body)).toEqual(['Nour (engineer)']);
    expect(staffOf((await work(minute(6))).body)).toEqual(['Karim (engineer)']);
    const order = (await twin(`work-order/${ids.order}?depth=1`).expect(200)).body;
    expect(order.nodes[0]).toMatchObject({
      kind: 'WORK_ORDER',
      state: 'DONE',
      attributes: {
        type: 'CORRECTIVE',
        symptom: 'NOT_COOLING',
        failure_mode: 'REFRIGERANT_LEAK',
        resolution: 'RECHARGED',
        downtime_minutes: 95,
      },
    });
    // The asset's name needs `eng.asset.read`: the GM here lacks it, an engineer has it.
    const asset = (body: { nodes: Array<{ kind: string; label: string | null }> }) =>
      body.nodes.find((n) => n.kind === 'ASSET')?.label;
    expect(asset(order)).toBeNull();
    const engineerView = (
      await twin(`work-order/${ids.order}?depth=1`, staff(engineerReaderId, hotel.tenantId)).expect(
        200,
      )
    ).body;
    expect(asset(engineerView)).toBe('AC-504 · Split unit');
  });

  it('applies each event once; an older state never overwrites a newer one; history is never deleted', async () => {
    const eventId = newId();
    const checkout = {
      stay_id: hotel.stayId,
      primary_guest_id: hotel.guestId,
      from: 'IN_HOUSE',
      to: 'CHECKED_OUT',
      at: minute(20),
      room_id: ids.secondRoom,
    };
    expect(await deliver(StayStatusChanged, checkout, minute(20), eventId)).toBe('processed');
    expect(await deliver(StayStatusChanged, checkout, minute(20), eventId)).toBe('duplicate');
    // A late event about an earlier moment.
    await deliver(
      StayStatusChanged,
      { ...checkout, from: 'EXPECTED', to: 'IN_HOUSE', at: minute(0) },
      minute(0),
    );
    const stay = (await twin(`stay/${hotel.stayId}?depth=1`).expect(200)).body.nodes[0];
    expect(stay).toMatchObject({ kind: 'STAY', state: 'CHECKED_OUT' });

    const counts = await h.db.execute(
      sql`select count(*)::int as edges, count(*) filter (where valid_to is not null)::int as ended
            from ai.twin_edges where tenant_id = ${hotel.tenantId}`,
    );
    expect(counts.rows[0]).toEqual({ edges: 14, ended: 2 });
    await expect(
      h.db.execute(sql`delete from ai.twin_edges where tenant_id = ${hotel.tenantId}`),
    ).rejects.toThrow();
    await expect(
      h.db.execute(
        sql`update ai.twin_edges set valid_to = now() where tenant_id = ${hotel.tenantId} and valid_to is not null`,
      ),
    ).rejects.toThrow();
    // Ids, states and codes only: no guest name reached the twin.
    const stored = await h.db.execute(
      sql`select attributes::text as a from ai.twin_nodes where tenant_id = ${hotel.tenantId}`,
    );
    expect(JSON.stringify(stored.rows)).not.toMatch(/Mona|Delta/);
  });

  it('is the hotel’s own: another hotel, a missing thing or a reader without the permission gets nothing', async () => {
    await twin(`stay/${hotel.stayId}`, staff(otherGmId, other.tenantId), other.propertyId).expect(
      404,
    );
    await twin(`stay/${hotel.stayId}`, staff(otherGmId, other.tenantId)).expect(404);
    await twin(`stay/${newId()}`).expect(404);
    await twin(`spaceship/${hotel.stayId}`).expect(404);
    await twin(`stay/${hotel.stayId}?depth=4`).expect(400);
    await twin(`stay/${hotel.stayId}`, staff(noTwinId, hotel.tenantId)).expect(403);
    // Row-level security: under the other tenant the rows do not exist.
    const seen = await h.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${other.tenantId}, true)`);
      return (
        await tx.execute(
          sql`select count(*)::int as n from ai.twin_nodes where tenant_id = ${hotel.tenantId}`,
        )
      ).rows[0];
    });
    expect(seen).toEqual({ n: 0 });
  });
});
