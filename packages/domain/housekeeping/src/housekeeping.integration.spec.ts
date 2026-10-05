import { and, asc, eq, sql } from 'drizzle-orm';
import {
  createEnvelope,
  type EventEnvelope,
  GuestCheckedIn,
  GuestCheckedOut,
  RoomStatusChanged,
  StayRoomChanged,
} from '@hotella/contracts-events';
import { GUEST_SESSION_HEADER } from '@hotella/domain-guest/public';
import { newId } from '@hotella/platform-database';
import { eventsSchema } from '@hotella/platform-events';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RoomStateService } from './application/room-state.service';
import {
  createHotel,
  guestToken,
  type HkHarness,
  type Hotel,
  staff,
  startHousekeepingApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();

describe.skipIf(needsInfra())(`Housekeeping room states (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const STAFF = [
    'org.property.read',
    'org.property.manage',
    'org.location.manage',
    'org.department.manage',
    'hk.board.read',
    'hk.room.manage',
  ];
  let h: HkHarness;
  let hotel: Hotel;
  let other: Hotel;
  const gm = (tenantId = hotel.tenantId) => staff(gmId, tenantId);
  const base = () => `/properties/${hotel.propertyId}/housekeeping`;
  const room = (n: string) => hotel.rooms[n]!;
  const board = async () =>
    (await h.http().get(`${base()}/rooms`).set('X-Test-Actor', gm()).expect(200)).body as Array<{
      roomId: string;
      roomNumber: string;
      occupancy: string | null;
      housekeeping: string | null;
      frontOffice: string | null;
      version: number | null;
      signals: Array<{ signal: string; source: string }>;
    }>;
  const of = async (n: string) => (await board()).find((r) => r.roomNumber === n)!;
  /** Delivers a canonical PMS event the way the worker consumer does. */
  const pms = (envelope: EventEnvelope) => h.app.get(RoomStateService).applyPms(envelope);
  const envelope = <T>(
    def: Parameters<typeof createEnvelope>[0],
    payload: T,
    occurredAt: Date,
  ): EventEnvelope =>
    createEnvelope(def, {
      eventId: newId(),
      tenantId: hotel.tenantId,
      propertyId: hotel.propertyId,
      source: 'integration',
      correlationId: `hk-${stamp}`,
      occurredAt,
      payload,
    } as never) as EventEnvelope;
  const reservation = {
    integration_instance_id: newId(),
    external_id: `R-${stamp}`,
    confirmation_number: `C-${stamp}`,
  };
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 3, 8, minutes));

  beforeAll(async () => {
    h = await startHousekeepingApp(url, 'hotella_app_hk', { [gmId]: STAFF });
    hotel = await createHotel(h, `hk-a-${stamp}`, gmId);
    other = await createHotel(h, `hk-b-${stamp}`, gmId, ['900']);
  });
  afterAll(() => h?.app.close());

  it('starts with every room on the board and no claimed state', async () => {
    const rooms = await board();
    expect(rooms.map((r) => r.roomNumber)).toEqual(['101', '102', '504']);
    expect(rooms[0]).toMatchObject({ occupancy: null, housekeeping: null, signals: [] });
  });

  it('follows the PMS: check-in, check-out (dirty), room status, room move; late events are ignored', async () => {
    const r101 = { room_id: room('101'), room_number: '101' };
    const r102 = { room_id: room('102'), room_number: '102' };
    await pms(
      envelope(
        GuestCheckedIn,
        {
          reservation,
          primary_guest: {
            external_id: `P-${stamp}`,
            given_name: 'Mona',
            family_name: 'Delta',
            title: null,
            locale: 'ar',
            vip_code: null,
            email: null,
            phone: null,
            loyalty_number: null,
          },
          accompanying_guests: [],
          room: r101,
          arrival_date: '2026-10-03',
          departure_date: '2026-10-05',
          adults: 1,
          children: 0,
          rate_code: null,
          market_code: null,
          checked_in_at: at(0).toISOString(),
        },
        at(0),
      ),
    );
    expect(await of('101')).toMatchObject({ occupancy: 'OCCUPIED', housekeeping: 'DIRTY' });
    await pms(
      envelope(
        RoomStatusChanged,
        { room: r101, status: 'CLEAN', occupied: true, changed_at: at(10).toISOString() },
        at(10),
      ),
    );
    expect(await of('101')).toMatchObject({ occupancy: 'OCCUPIED', housekeeping: 'CLEAN' });
    // A late status from before the cleaning changes nothing.
    await pms(
      envelope(
        RoomStatusChanged,
        { room: r101, status: 'DIRTY', occupied: true, changed_at: at(5).toISOString() },
        at(5),
      ),
    );
    expect((await of('101')).housekeeping).toBe('CLEAN');
    await pms(
      envelope(
        StayRoomChanged,
        {
          reservation,
          from_room: r101,
          to_room: r102,
          reason: 'ROOM_MOVE',
          changed_at: at(20).toISOString(),
        },
        at(20),
      ),
    );
    expect(await of('101')).toMatchObject({ occupancy: 'VACANT', housekeeping: 'DIRTY' });
    expect((await of('102')).occupancy).toBe('OCCUPIED');
    await pms(
      envelope(
        GuestCheckedOut,
        { reservation, room: r102, checked_out_at: at(30).toISOString() },
        at(30),
      ),
    );
    expect(await of('102')).toMatchObject({ occupancy: 'VACANT', housekeeping: 'DIRTY' });
    await pms(
      envelope(
        RoomStatusChanged,
        { room: r101, status: 'OUT_OF_ORDER', occupied: null, changed_at: at(40).toISOString() },
        at(40),
      ),
    );
    expect(await of('101')).toMatchObject({ frontOffice: 'OUT_OF_ORDER', housekeeping: 'DIRTY' });

    // History with causes, and events for each change.
    const history = (
      await h
        .http()
        .get(`${base()}/rooms/${room('101')}/history`)
        .set('X-Test-Actor', gm())
        .expect(200)
    ).body as Array<{ dimension: string; fromValue: string; toValue: string; cause: string }>;
    expect(history.map((e) => `${e.dimension}:${e.fromValue}>${e.toValue}:${e.cause}`)).toEqual([
      'FRONT_OFFICE:null>OUT_OF_ORDER:PMS',
      'HOUSEKEEPING:CLEAN>DIRTY:PMS',
      'OCCUPANCY:OCCUPIED>VACANT:PMS',
      'HOUSEKEEPING:DIRTY>CLEAN:PMS',
      'OCCUPANCY:VACANT>OCCUPIED:PMS',
    ]);
    const [events] = (
      await h.db.execute(
        sql`select count(*)::int as n from platform.outbox where tenant_id = ${hotel.tenantId} and event_type = 'hk.room.state_changed'`,
      )
    ).rows as Array<{ n: number }>;
    // Plus room 102: occupied by the move, vacant at check-out (it was never clean, so it stays dirty).
    expect(events!.n).toBe(history.length + 2);
    const refused = await h.db
      .execute(sql`delete from hk.room_state_events where room_id = ${room('101')}`)
      .then(
        () => '',
        (e: Error) => String((e.cause as Error | undefined)?.message ?? e.message),
      );
    expect(refused).toMatch(/append-only/);
  });

  it('staff move cleaning forward with optimistic locking; impossible moves are refused', async () => {
    const r102 = await of('102');
    await h
      .http()
      .post(`${base()}/rooms/${room('102')}/state`)
      .set('X-Test-Actor', gm())
      .send({ housekeeping: 'INSPECTED', version: r102.version })
      .expect(409);
    await h
      .http()
      .post(`${base()}/rooms/${room('102')}/state`)
      .set('X-Test-Actor', gm())
      .send({ housekeeping: 'CLEANING', version: r102.version! + 5 })
      .expect(409);
    const cleaning = await h
      .http()
      .post(`${base()}/rooms/${room('102')}/state`)
      .set('X-Test-Actor', gm())
      .send({ housekeeping: 'CLEANING', version: r102.version })
      .expect(200);
    await h
      .http()
      .post(`${base()}/rooms/${room('102')}/state`)
      .set('X-Test-Actor', gm())
      .send({ housekeeping: 'CLEAN', version: cleaning.body.version })
      .expect(200);
    const after = await h.db.execute(
      sql`select last_cleaned_at from hk.room_states where room_id = ${room('102')}`,
    );
    expect((after.rows[0] as { last_cleaned_at: Date | null }).last_cleaned_at).not.toBeNull();
    const [audit] = (
      await h.db.execute(
        sql`select actor_type, actor_id from audit.audit_log where tenant_id = ${hotel.tenantId} and action = 'hk.room.state' and entity_id = ${room('102')} order by id desc limit 1`,
      )
    ).rows as Array<{ actor_type: string; actor_id: string }>;
    expect(audit).toEqual({ actor_type: 'USER', actor_id: gmId });
  });

  it('signals: DND and make-up-room exclude each other, from staff and from the guest web', async () => {
    await h
      .http()
      .post(`${base()}/rooms/${room('504')}/signals`)
      .set('X-Test-Actor', gm())
      .send({ signal: 'DND', active: true })
      .expect(200);
    expect((await of('504')).signals).toMatchObject([{ signal: 'DND', source: 'STAFF' }]);
    // The guest of room 504 asks for the room to be made up: DND is lifted.
    const token = await guestToken(h, hotel);
    const res = await h
      .http()
      .post('/guest/room-signals')
      .set(GUEST_SESSION_HEADER, token)
      .send({ signal: 'MAKE_UP_ROOM', active: true })
      .expect(200);
    expect(res.body.active).toEqual(['MAKE_UP_ROOM']);
    expect((await of('504')).signals).toMatchObject([
      { signal: 'MAKE_UP_ROOM', source: 'GUEST_PORTAL' },
    ]);
    const changes = await h.db
      .select({ payload: eventsSchema.outbox.envelope })
      .from(eventsSchema.outbox)
      .where(
        and(
          eq(eventsSchema.outbox.tenantId, hotel.tenantId),
          eq(eventsSchema.outbox.eventType, 'hk.room_signal.changed'),
        ),
      )
      // In the order they were written (the outbox id grows with time).
      .orderBy(asc(eventsSchema.outbox.id));
    expect(
      changes.map((c) => {
        const p = (c.payload as EventEnvelope).payload as { signal: string; active: boolean };
        return `${p.signal}:${p.active}`;
      }),
    ).toEqual(['DND:true', 'DND:false', 'MAKE_UP_ROOM:true']);
    // The DND that was lifted keeps its history.
    const [dnd] = (
      await h.db.execute(
        sql`select ended_at, ended_by_type from hk.room_signals where room_id = ${room('504')} and signal = 'DND'`,
      )
    ).rows as Array<{ ended_at: Date | null; ended_by_type: string }>;
    expect(dnd).toMatchObject({ ended_by_type: 'GUEST' });
    expect(dnd!.ended_at).not.toBeNull();
  });

  it('isolates tenants: another tenant’s rooms are not found, and row-level security hides them', async () => {
    await h
      .http()
      .post(`/properties/${other.propertyId}/housekeeping/rooms/${room('101')}/signals`)
      .set('X-Test-Actor', gm(other.tenantId))
      .send({ signal: 'DND', active: true })
      .expect(404);
    await h.http().get(`${base()}/rooms`).set('X-Test-Actor', gm(other.tenantId)).expect(404);
    const leaked = await h.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${other.tenantId}, true)`);
      return (
        await tx.execute(
          sql`select count(*)::int as n from hk.room_states where tenant_id = ${hotel.tenantId}`,
        )
      ).rows[0] as { n: number };
    });
    expect(leaked.n).toBe(0);
  });
});
