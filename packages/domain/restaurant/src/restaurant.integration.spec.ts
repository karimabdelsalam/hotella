import { sql } from 'drizzle-orm';
import { createEnvelope, StayStatusChanged } from '@hotella/contracts-events';
import { GUEST_SESSION_HEADER } from '@hotella/domain-guest/public';
import { newId } from '@hotella/platform-database';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReservationService } from './application/reservation.service';
import { localDate, weekdayOf } from './domain/rules';
import {
  createHotel,
  guestSession,
  type Harness,
  type Hotel,
  seedStay,
  staff,
  startRestaurantApp,
} from './testing/harness';

const stamp = Date.now().toString(36).toUpperCase();
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** Spec Appendix B.1 against real PostgreSQL: allowance, seats, stay window, override, checkout, history, isolation. */
describe.skipIf(needsInfra())(`Restaurant — à la carte reservations (${infraSkipReason()})`, () => {
  const url = readTestInfra().databaseUrl!;
  const managerId = newId();
  const hostId = newId();
  const supervisorId = newId();
  const otherId = newId();
  let h: Harness;
  let hotel: Hotel;
  let other: Hotel;
  let restaurant: { id: string; version: number };
  let schedule: Array<{ id: string; weekday: number; startsAt: string }>;
  /** Sittings are per weekday: the 19:00 (4 seats) and 21:00 (20 seats) sitting served on a date. */
  const sittingOf = (startsAt: string, date: string) =>
    schedule.find((s) => s.startsAt === startsAt && s.weekday === weekdayOf(date))!.id;
  const early = (date = tomorrow) => sittingOf('19:00', date);
  const late = (date = tomorrow) => sittingOf('21:00', date);
  const today = localDate(new Date(), 'Africa/Cairo');
  const tomorrow = addDays(today, 1);
  const manager = () => staff(managerId, hotel.tenantId);
  const host = () => staff(hostId, hotel.tenantId);
  const supervisor = () => staff(supervisorId, hotel.tenantId);
  const base = () => `/properties/${hotel.propertyId}`;

  beforeAll(async () => {
    const manage = [
      'org.tenant.manage',
      'org.property.manage',
      'org.property.read',
      'org.location.manage',
    ];
    h = await startRestaurantApp(url, 'hotella_app_restaurant', {
      [managerId]: [
        ...manage,
        'restaurant.restaurant.read',
        'restaurant.restaurant.manage',
        'restaurant.reservation.read',
      ],
      [hostId]: [
        'restaurant.restaurant.read',
        'restaurant.reservation.read',
        'restaurant.reservation.manage',
      ],
      [supervisorId]: [
        'restaurant.restaurant.read',
        'restaurant.reservation.read',
        'restaurant.reservation.manage',
        'restaurant.reservation.override',
      ],
      [otherId]: [
        ...manage,
        'restaurant.restaurant.read',
        'restaurant.reservation.read',
        'restaurant.reservation.manage',
      ],
    });
    hotel = await createHotel(h, `RST${stamp}`, managerId, ['101', '102', '103', '104']);
    other = await createHotel(h, `OTH${stamp}`, otherId, ['201']);
    const created = await h
      .http()
      .post(`${base()}/restaurants`)
      .set('X-Test-Actor', manager())
      .send({
        code: 'LA_TERRAZZA',
        translations: [
          { locale: 'en', name: 'La Terrazza', description: 'Italian' },
          { locale: 'it', name: 'La Terrazza', description: 'Cucina italiana' },
          { locale: 'ar', name: 'لا تيرازا' },
        ],
        maxParty: 6,
      })
      .expect(201);
    restaurant = created.body;
    expect(created.body).toMatchObject({
      status: 'DRAFT',
      name: 'La Terrazza',
      allowanceApplies: true,
    });
    const saved = await h
      .http()
      .put(`${base()}/restaurants/${restaurant.id}/sittings`)
      .set('X-Test-Actor', manager())
      .send({
        fromDate: today,
        sittings: ALL_DAYS.flatMap((weekday) => [
          { weekday, startsAt: '19:00', seats: 4 },
          { weekday, startsAt: '21:00', seats: 20 },
        ]),
      })
      .expect(200);
    schedule = saved.body;
    const active = await h
      .http()
      .patch(`${base()}/restaurants/${restaurant.id}`)
      .set('X-Test-Actor', manager())
      .send({ version: restaurant.version, status: 'ACTIVE' })
      .expect(200);
    restaurant = active.body;
  });
  afterAll(async () => {
    await h?.app.close();
  });

  const sittingsTomorrow = async () => {
    const avail = await h
      .http()
      .get(`${base()}/restaurants/availability?from=${tomorrow}&to=${tomorrow}`)
      .set('X-Test-Actor', host())
      .expect(200);
    return avail.body[0].days[0].sittings as Array<{
      sittingId: string;
      booked: number;
      free: number;
    }>;
  };

  it('a guest of a 6-night stay books once per restaurant; the second booking is refused', async () => {
    const stay = await seedStay(h.db, hotel, '101', today, 6);
    const token = await guestSession(h, hotel, stay.stayId, stay.primary);
    const offer = await h
      .http()
      .get('/guest/restaurants')
      .set(GUEST_SESSION_HEADER, token)
      .set('Accept-Language', 'it')
      .expect(200);
    const terrazza = offer.body.restaurants[0];
    expect(terrazza).toMatchObject({
      name: 'La Terrazza',
      description: 'Cucina italiana',
      allowance: { allowed: 1, used: 0, remaining: 1 },
    });
    expect(terrazza.days.map((d: { date: string }) => d.date)).not.toContain(addDays(today, 6)); // departure day

    const book = (body: object) =>
      h.http().post('/guest/restaurant-reservations').set(GUEST_SESSION_HEADER, token).send(body);
    const first = await book({
      restaurantId: restaurant.id,
      sittingId: late(tomorrow),
      serviceDate: tomorrow,
      partySize: 2,
    }).expect(201);
    expect(first.body).toMatchObject({
      status: 'CONFIRMED',
      channel: 'GUEST_APP',
      roomNumber: '101',
      startsAt: '21:00',
    });
    const second = await book({
      restaurantId: restaurant.id,
      sittingId: late(addDays(today, 2)),
      serviceDate: addDays(today, 2),
      partySize: 2,
    }).expect(409);
    expect(second.body.code).toBe('restaurant.reservation.allowance_used');
    expect(second.body.detail).toContain('one booking');
    const outside = await book({
      restaurantId: restaurant.id,
      sittingId: late(addDays(today, 6)),
      serviceDate: addDays(today, 6),
      partySize: 2,
    }).expect(422);
    expect(outside.body.code).toBe('restaurant.reservation.outside_stay');
    const tooMany = await book({
      restaurantId: restaurant.id,
      sittingId: late(tomorrow),
      serviceDate: tomorrow,
      partySize: 7,
    }).expect(422);
    expect(tooMany.body.code).toBe('restaurant.reservation.party_size');

    // The guest cancels: the allowance comes back.
    await h
      .http()
      .post(`/guest/restaurant-reservations/${first.body.id}/cancel`)
      .set(GUEST_SESSION_HEADER, token)
      .expect(200);
    await book({
      restaurantId: restaurant.id,
      sittingId: late(addDays(today, 2)),
      serviceDate: addDays(today, 2),
      partySize: 2,
    }).expect(201);
  });

  it('a 9-night stay may book the same restaurant twice; a third needs an override with a reason', async () => {
    const stay = await seedStay(h.db, hotel, '102', today, 9);
    const book = (actor: string, serviceDate: string, override?: { reason: string }) =>
      h
        .http()
        .post(`${base()}/restaurant-reservations`)
        .set('X-Test-Actor', actor)
        .send({
          restaurantId: restaurant.id,
          sittingId: late(serviceDate),
          serviceDate,
          partySize: 2,
          stayId: stay.stayId,
          notes: 'nut allergy',
          override,
        });
    await book(host(), tomorrow).expect(201);
    await book(host(), addDays(today, 3)).expect(201);
    expect((await book(host(), addDays(today, 5)).expect(409)).body.code).toBe(
      'restaurant.reservation.allowance_used',
    );
    // The override is a separate permission.
    await book(host(), addDays(today, 5), { reason: 'Anniversary, GM approved' }).expect(403);
    const overridden = await book(supervisor(), addDays(today, 5), {
      reason: 'Anniversary, GM approved',
    }).expect(201);
    expect(overridden.body.overridden).toBe(true);
    const audit = await h.db.execute(
      sql`select reason from audit.audit_log where action = 'restaurant.reservation.create_override' and entity_id = ${overridden.body.id}`,
    );
    expect(audit.rows[0]).toMatchObject({ reason: 'Anniversary, GM approved' });
  });

  it('two bookings racing for the last seats: exactly one wins', async () => {
    const a = await seedStay(h.db, hotel, '103', today, 3);
    const b = await seedStay(h.db, hotel, '104', today, 3);
    const book = (stayId: string) =>
      h
        .http()
        .post(`${base()}/restaurant-reservations`)
        .set('X-Test-Actor', host())
        .send({
          restaurantId: restaurant.id,
          sittingId: early(tomorrow),
          serviceDate: tomorrow,
          partySize: 3,
          stayId,
        });
    const results = await Promise.all([book(a.stayId), book(b.stayId)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe(
      'restaurant.reservation.sitting_full',
    );
    expect((await sittingsTomorrow()).find((s) => s.sittingId === early())).toMatchObject({
      booked: 3,
      free: 1,
    });
  });

  it('the board shows the guests; seat and complete are kept as history', async () => {
    const board = await h
      .http()
      .get(`${base()}/restaurant-reservations?date=${tomorrow}`)
      .set('X-Test-Actor', host())
      .expect(200);
    const sitting = board.body[0].sittings.find(
      (s: { startsAt: string }) => s.startsAt === '21:00',
    );
    const res = sitting.reservations.find((r: { roomNumber: string }) => r.roomNumber === '102');
    expect(res).toMatchObject({
      guestName: 'Giulia Rossi',
      notes: 'nut allergy',
      status: 'CONFIRMED',
    });
    const seated = await h
      .http()
      .post(`${base()}/restaurant-reservations/${res.id}/seat`)
      .set('X-Test-Actor', host())
      .send({ version: res.version })
      .expect(200);
    await h
      .http()
      .post(`${base()}/restaurant-reservations/${res.id}/complete`)
      .set('X-Test-Actor', host())
      .send({ version: seated.body.version })
      .expect(200);
    await h
      .http()
      .post(`${base()}/restaurant-reservations/${res.id}/cancel`)
      .set('X-Test-Actor', host())
      .send({ version: seated.body.version + 1 })
      .expect(409);
    const history = await h.db.execute(
      sql`select from_status, to_status from restaurant.reservation_transitions where reservation_id = ${res.id} order by created_at`,
    );
    expect(history.rows.map((r) => `${r.from_status ?? '-'}>${r.to_status}`)).toEqual([
      '->CONFIRMED',
      'CONFIRMED>SEATED',
      'SEATED>COMPLETED',
    ]);
    await expect(
      h.db.execute(
        sql`update restaurant.reservation_transitions set reason = 'x' where reservation_id = ${res.id}`,
      ),
    ).rejects.toThrow();
  });

  it('PMS checkout cancels the stay’s confirmed reservations ahead and frees their seats', async () => {
    const stay = await seedStay(h.db, hotel, '101', today, 4);
    const made = await h
      .http()
      .post(`${base()}/restaurant-reservations`)
      .set('X-Test-Actor', host())
      .send({
        restaurantId: restaurant.id,
        sittingId: early(tomorrow),
        serviceDate: tomorrow,
        partySize: 1,
        stayId: stay.stayId,
      })
      .expect(201);
    expect((await sittingsTomorrow()).find((s) => s.sittingId === early())).toMatchObject({
      booked: 4,
      free: 0,
    });
    await h.app.get(ReservationService).onStayEvent(
      createEnvelope(StayStatusChanged, {
        eventId: newId(),
        tenantId: hotel.tenantId,
        propertyId: hotel.propertyId,
        source: 'guest',
        correlationId: null,
        payload: {
          stay_id: stay.stayId,
          primary_guest_id: stay.primary,
          from: 'IN_HOUSE',
          to: 'CHECKED_OUT',
          at: new Date().toISOString(),
          room_id: hotel.rooms['101']!,
        },
      }),
    );
    const [row] = (
      await h.db.execute(
        sql`select status, cancel_reason from restaurant.reservations where id = ${made.body.id}`,
      )
    ).rows as Array<{ status: string; cancel_reason: string }>;
    expect(row).toEqual({ status: 'CANCELLED', cancel_reason: 'STAY_ENDED' });
    expect((await sittingsTomorrow()).find((s) => s.sittingId === early())).toMatchObject({
      booked: 3,
      free: 1,
    });
  });

  it('another hotel sees nothing of these restaurants or reservations', async () => {
    const actor = staff(otherId, other.tenantId);
    await h.http().get(`${base()}/restaurants`).set('X-Test-Actor', actor).expect(404);
    const own = await h
      .http()
      .get(`/properties/${other.propertyId}/restaurants`)
      .set('X-Test-Actor', actor)
      .expect(200);
    expect(own.body).toEqual([]);
    await h
      .http()
      .post(`/properties/${other.propertyId}/restaurant-reservations`)
      .set('X-Test-Actor', actor)
      .send({
        restaurantId: restaurant.id,
        sittingId: late(tomorrow),
        serviceDate: tomorrow,
        partySize: 2,
        stayId: newId(),
      })
      .expect(404);
  });
});
