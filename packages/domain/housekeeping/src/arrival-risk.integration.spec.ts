import { sql } from 'drizzle-orm';
import { createEnvelope, type EventEnvelope, GuestCheckedOut } from '@hotella/contracts-events';
import { newId } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArrivalRiskService } from './application/arrival-risk.service';
import { RoomStateService } from './application/room-state.service';
import { localDay } from './domain/jobs';
import {
  createHotel,
  type HkHarness,
  type Hotel,
  LATEST_INSPECTIONS,
  staff,
  startHousekeepingApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();

interface Arrival {
  stayId: string;
  guestName: string | null;
  vip: boolean;
  eta: string | null;
  roomNumber: string | null;
  housekeeping: string | null;
  ready: boolean;
  score: number;
  level: string;
  reasons: string[];
}

describe.skipIf(needsInfra())(`Arrival risk v1 (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const gmId = newId();
  const attendantId = newId();
  const STAFF = [
    'org.property.read',
    'org.property.manage',
    'org.location.manage',
    'org.department.manage',
    'hk.board.read',
    'hk.room.manage',
    'hk.arrivals.read',
  ];
  let h: HkHarness;
  let hotel: Hotel;
  let other: Hotel;
  const gm = () => staff(gmId, hotel.tenantId);
  const base = () => `/properties/${hotel.propertyId}/housekeeping`;
  const stays: Record<string, string> = {};

  /** An expected stay of the hotel's guest, optionally pre-assigned to a room and with an ETA. */
  const expect_ = async (key: string, day: string, roomNumber: string | null, eta: Date | null) => {
    const id = newId();
    const guestId = newId();
    await h.db
      .execute(sql`insert into guest.guests (id, tenant_id, given_name, family_name, primary_locale, vip_code)
      values (${guestId}, ${hotel.tenantId}, ${`Guest ${key}`}, 'Test', 'en', ${key === 'vip' ? 'V1' : null})`);
    await h.db
      .execute(sql`insert into guest.stays (id, tenant_id, property_id, status, primary_guest_id, expected_arrival, expected_departure, eta, last_pms_event_at)
      values (${id}, ${hotel.tenantId}, ${hotel.propertyId}, 'EXPECTED', ${guestId}, ${day}, '2099-01-01', ${eta}, now())`);
    await h.db
      .execute(sql`insert into guest.stay_party_members (id, tenant_id, stay_id, guest_id, role, joined_at)
      values (${newId()}, ${hotel.tenantId}, ${id}, ${guestId}, 'PRIMARY', now())`);
    if (roomNumber)
      await h.db
        .execute(sql`insert into guest.room_assignments (id, tenant_id, property_id, stay_id, room_id, assigned_at, reason)
        values (${newId()}, ${hotel.tenantId}, ${hotel.propertyId}, ${id}, ${hotel.rooms[roomNumber]}, now(), 'PRE_ASSIGNMENT')`);
    stays[key] = id;
  };
  /** The previous guest checked out of the room: the projection starts tracking it (vacant, dirty). */
  const checkedOut = (n: string) =>
    h.app.get(RoomStateService).applyPms(
      createEnvelope(GuestCheckedOut, {
        eventId: newId(),
        tenantId: hotel.tenantId,
        propertyId: hotel.propertyId,
        source: 'integration',
        correlationId: `hk-arrivals-${stamp}`,
        occurredAt: new Date(),
        payload: {
          reservation: {
            integration_instance_id: newId(),
            external_id: `R-${n}-${stamp}`,
            confirmation_number: null,
          },
          room: { room_id: hotel.rooms[n], room_number: n },
          checked_out_at: new Date().toISOString(),
        },
      } as never) as EventEnvelope,
    );
  const setRoom = async (n: string, states: readonly string[]) => {
    const rooms = (await h.http().get(`${base()}/rooms`).set('X-Test-Actor', gm()).expect(200))
      .body as Array<{ roomNumber: string; version: number }>;
    let version = rooms.find((r) => r.roomNumber === n)!.version;
    for (const state of states)
      version = (
        await h
          .http()
          .post(`${base()}/rooms/${hotel.rooms[n]}/state`)
          .set('X-Test-Actor', gm())
          .send({ housekeeping: state, version })
          .expect((r) => {
            if (r.status !== 200) throw new Error(JSON.stringify(r.body));
          })
      ).body.version;
  };
  const risk = async (day?: string, actor = gm()) =>
    (
      await h
        .http()
        .get(`${base()}/arrival-risk${day ? `?day=${day}` : ''}`)
        .set('X-Test-Actor', actor)
        .expect(200)
    ).body as { day: string; arrivals: Arrival[] };

  beforeAll(async () => {
    h = await startHousekeepingApp(url, 'hotella_app_hk_arrivals', {
      [gmId]: STAFF,
      [attendantId]: ['hk.board.read'],
    });
    hotel = await createHotel(h, `hka-${stamp}`, gmId, ['101', '201', '504']);
    other = await createHotel(h, `hkb-${stamp}`, gmId, ['900']);
    const now = Date.now();
    const today = localDay(new Date(now), 'Africa/Cairo');
    const tomorrow = localDay(new Date(now + 86_400_000), 'Africa/Cairo');
    // Both rooms were just left (dirty); 201 is cleaned and becomes ready.
    await checkedOut('101');
    await checkedOut('201');
    await setRoom('201', ['CLEANING', 'CLEAN']);
    await expect_('vip', today, '101', new Date(now + 60 * 60_000));
    await expect_('ready', today, '201', new Date(now + 30 * 60_000));
    await expect_('unassigned', today, null, null);
    await expect_('tomorrow', tomorrow, '101', null);
  });
  afterAll(() => h?.app.close());

  it('lists today’s arrivals riskiest first, with deterministic scores and reasons', async () => {
    const today = await risk();
    expect(today.day).toBe(localDay(new Date(), 'Africa/Cairo'));
    expect(today.arrivals.map((a) => a.stayId)).toEqual([
      stays['vip'],
      stays['unassigned'],
      stays['ready'],
    ]);
    const [vip, unassigned, ready] = today.arrivals;
    expect(vip).toMatchObject({
      guestName: 'Guest vip Test',
      vip: true,
      roomNumber: '101',
      housekeeping: 'DIRTY',
      ready: false,
      score: 55,
      level: 'MEDIUM',
      reasons: ['ROOM_DIRTY', 'ETA_SOON', 'VIP_GUEST'],
    });
    expect(unassigned).toMatchObject({
      roomNumber: null,
      score: 30,
      level: 'MEDIUM',
      reasons: ['NO_ROOM_ASSIGNED'],
    });
    expect(ready).toMatchObject({ roomNumber: '201', ready: true, score: 0, reasons: [] });
  });

  it('a room that failed its inspection today is a risk even when housekeeping calls it ready', async () => {
    LATEST_INSPECTIONS.set(hotel.rooms['201']!, {
      id: newId(),
      propertyId: hotel.propertyId,
      number: 3,
      locationId: hotel.rooms['201']!,
      assetId: null,
      status: 'COMPLETED',
      result: 'FAIL',
      score: 40,
      completedAt: new Date().toISOString(),
      source: 'STAFF',
      sourceRef: null,
    });
    const ready = (await risk()).arrivals.find((a) => a.stayId === stays['ready'])!;
    expect(ready).toMatchObject({
      score: 25,
      level: 'MEDIUM',
      reasons: ['INSPECTION_FAILED_TODAY'],
    });
    // An older failure no longer counts.
    LATEST_INSPECTIONS.set(hotel.rooms['201']!, {
      ...LATEST_INSPECTIONS.get(hotel.rooms['201']!)!,
      completedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    });
    expect((await risk()).arrivals.find((a) => a.stayId === stays['ready'])!.reasons).toEqual([]);
    LATEST_INSPECTIONS.clear();
  });

  it('shows tomorrow on request; needs hk.arrivals.read; another tenant’s property is not found', async () => {
    const tomorrow = await risk('tomorrow');
    expect(tomorrow.arrivals).toMatchObject([
      { stayId: stays['tomorrow'], roomNumber: '101', reasons: ['ROOM_DIRTY'] },
    ]);
    await h
      .http()
      .get(`${base()}/arrival-risk`)
      .set('X-Test-Actor', staff(attendantId, hotel.tenantId))
      .expect(403);
    await h
      .http()
      .get(`${base()}/arrival-risk`)
      .set('X-Test-Actor', staff(gmId, other.tenantId))
      .expect(404);
    await h
      .http()
      .get(`${base()}/arrival-risk?day=yesterday`)
      .set('X-Test-Actor', gm())
      .expect(400);
  });

  it('contributes ARRIVAL_RISK_TOMORROW to the insight engine: only HIGH arrivals, ids as evidence, no names', async () => {
    const service = h.app.get(ArrivalRiskService);
    const scope = { tenantId: hotel.tenantId, propertyId: hotel.propertyId, now: new Date() };
    // Tomorrow's only arrival is MEDIUM: nothing to raise.
    expect(await service.insightDetector().detect(scope)).toEqual([]);
    // With HIGH arrivals (scored as the rules would), one insight for the day.
    const scored = Object.assign(Object.create(service) as ArrivalRiskService, {
      assess: async () => ({
        day: '2026-10-06',
        arrivals: [
          {
            stayId: 's2',
            roomId: 'r2',
            vip: false,
            score: 70,
            level: 'HIGH',
            guestName: 'Not copied',
          },
          {
            stayId: 's1',
            roomId: null,
            vip: true,
            score: 90,
            level: 'HIGH',
            guestName: 'Not copied',
          },
          {
            stayId: 's3',
            roomId: 'r3',
            vip: false,
            score: 30,
            level: 'MEDIUM',
            guestName: 'Not copied',
          },
        ],
      }),
    });
    const found = await scored.insightDetector().detect(scope);
    expect(found).toEqual([
      expect.objectContaining({
        detector: 'ARRIVAL_RISK_TOMORROW',
        fingerprint: 'day:2026-10-06',
        severity: 'HIGH',
        confidence: 0.8,
        reasonParams: { count: 2, day: '2026-10-06' },
        evidence: [
          {
            kind: 'HIGH_RISK_ARRIVALS',
            refType: 'STAY',
            refIds: ['s1', 's2'],
            count: 2,
            window: 'P1D',
          },
        ],
        affected: [{ type: 'LOCATION', id: 'r2' }],
      }),
    ]);
    expect(JSON.stringify(found)).not.toContain('Not copied');
  });
});
