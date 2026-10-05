import { sql } from 'drizzle-orm';
import { createEnvelope, StayStatusChanged } from '@hotella/contracts-events';
import { GUEST_SESSION_HEADER } from '@hotella/domain-guest/public';
import { ActorStore } from '@hotella/platform-auth';
import { newId } from '@hotella/platform-database';
import { RequestContext } from '@hotella/platform-observability';
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
  TOOLS,
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
    hotel = await createHotel(h, `RST${stamp}`, managerId, [
      '101',
      '102',
      '103',
      '104',
      '105',
      '106',
      '107',
      '108',
    ]);
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

  it('a phone booking starts from the room: the guest, the stay and the bookings left', async () => {
    const stay = await seedStay(h.db, hotel, '105', today, 10);
    const found = await h
      .http()
      .get(`${base()}/restaurant-reservations/stays?room=105`)
      .set('X-Test-Actor', host())
      .expect(200);
    expect(found.body).toEqual([
      expect.objectContaining({
        stayId: stay.stayId,
        roomNumber: '105',
        guestName: 'Giulia Rossi',
        nights: 10,
        allowance: [
          expect.objectContaining({
            restaurantId: restaurant.id,
            allowed: 2,
            used: 0,
            remaining: 2,
          }),
        ],
      }),
    ]);
    const empty = await h
      .http()
      .get(`${base()}/restaurant-reservations/stays?room=999`)
      .set('X-Test-Actor', host())
      .expect(200);
    expect(empty.body).toEqual([]);
    // Reading the board is not enough to look guests up for a booking.
    await h
      .http()
      .get(`${base()}/restaurant-reservations/stays?room=105`)
      .set('X-Test-Actor', manager())
      .expect(403);
  });

  it('a closed day is not offered; reopening it brings its sittings back', async () => {
    const day = addDays(today, 4);
    const sittingsOn = async () =>
      (
        await h
          .http()
          .get(`${base()}/restaurants/availability?from=${day}&to=${day}`)
          .set('X-Test-Actor', host())
          .expect(200)
      ).body[0].days[0].sittings as unknown[];
    expect(await sittingsOn()).toHaveLength(2);
    const closure = await h
      .http()
      .post(`${base()}/restaurants/${restaurant.id}/closures`)
      .set('X-Test-Actor', manager())
      .send({ onDate: day, reason: 'Private event' })
      .expect(201);
    expect(await sittingsOn()).toHaveLength(0);
    const detail = await h
      .http()
      .get(`${base()}/restaurants/${restaurant.id}`)
      .set('X-Test-Actor', manager())
      .expect(200);
    expect(detail.body.closures).toEqual([
      { id: closure.body.id, onDate: day, sittingId: null, reason: 'Private event' },
    ]);
    expect(detail.body.translations.map((t: { locale: string }) => t.locale).sort()).toEqual([
      'ar',
      'en',
      'it',
    ]);
    await h
      .http()
      .delete(`${base()}/restaurants/${restaurant.id}/closures/${closure.body.id}`)
      .set('X-Test-Actor', host())
      .expect(403);
    await h
      .http()
      .delete(`${base()}/restaurants/${restaurant.id}/closures/${closure.body.id}`)
      .set('X-Test-Actor', manager())
      .expect(200);
    expect(await sittingsOn()).toHaveLength(2);
    await h
      .http()
      .delete(`${base()}/restaurants/${restaurant.id}/closures/${closure.body.id}`)
      .set('X-Test-Actor', manager())
      .expect(404);
  });

  it('the concierge finds tables and books one for its own guest, under the same allowance', async () => {
    const stay = await seedStay(h.db, hotel, '106', today, 3);
    await guestSession(h, hotel, stay.stayId, stay.primary);
    const find = TOOLS.get('restaurant.find_tables')!;
    const book = TOOLS.get('restaurant.book_table')!;
    expect(find).toMatchObject({ risk: 'READ', requiredPermission: 'restaurant.offer.read' });
    expect(book).toMatchObject({
      risk: 'MEDIUM',
      requiredPermission: 'restaurant.reservation.book_own',
    });
    const executionId = newId();
    const ctx = {
      tenantId: hotel.tenantId,
      propertyId: hotel.propertyId,
      executionId,
      agentCode: 'GUEST_CONCIERGE',
      locale: 'it',
      guest: { guestId: stay.primary, stayId: stay.stayId },
      conversationId: null,
    };
    // As the tool executor runs them: in a request context whose actor is the agent.
    const asAgent = <T>(fn: () => Promise<T>) =>
      h.app.get(RequestContext).run(
        {
          tenant_id: hotel.tenantId,
          property_id: hotel.propertyId,
          actor_type: 'AI_AGENT',
          actor_id: executionId,
        },
        async () => {
          h.app.get(ActorStore).set({
            type: 'AI_AGENT',
            id: executionId,
            tenantId: hotel.tenantId,
            isPlatformAdmin: false,
          });
          return fn();
        },
      );
    const offer = (await asAgent(() => find.handle(find.input.parse({}), ctx))) as {
      restaurants: Array<{
        restaurant_id: string;
        name: string;
        bookings_left: number;
        dates: Array<{ date: string; sittings: Array<{ sitting_id: string; starts_at: string }> }>;
      }>;
    };
    expect(offer.restaurants[0]).toMatchObject({ name: 'La Terrazza', bookings_left: 1 });
    const night = offer.restaurants[0]!.dates.find((d) => d.date === tomorrow)!;
    const at21 = night.sittings.find((s) => s.starts_at === '21:00')!;
    const args = {
      restaurant_id: restaurant.id,
      sitting_id: at21.sitting_id,
      date: tomorrow,
      party_size: 2,
    };
    expect(await asAgent(() => book.handle(book.input.parse(args), ctx))).toMatchObject({
      status: 'CONFIRMED',
      starts_at: '21:00',
    });
    await expect(asAgent(() => book.handle(book.input.parse(args), ctx))).rejects.toMatchObject({
      code: 'restaurant.reservation.allowance_used',
    });
    const [row] = (
      await h.db.execute(
        sql`select channel, created_by_type from restaurant.reservations where stay_id = ${stay.stayId}`,
      )
    ).rows;
    expect(row).toEqual({ channel: 'AI', created_by_type: 'AI_AGENT' });
    // Another guest's stay is out of reach: the execution fixes the guest, the model cannot choose one.
    const stranger = { ...ctx, guest: { guestId: newId(), stayId: stay.stayId } };
    await expect(
      asAgent(() => book.handle(book.input.parse(args), stranger)),
    ).rejects.toMatchObject({ code: 'guest.session.scope_missing' });
  });

  it('Phase 14 acceptance (restaurant): a 9-night guest books in Italian, the manager books a full sitting only with an override, checkout cancels the rest', async () => {
    // A second restaurant, open every day at 20:00.
    const sushi = (
      await h
        .http()
        .post(`${base()}/restaurants`)
        .set('X-Test-Actor', manager())
        .send({
          code: `SUSHI_${stamp}`.slice(0, 40),
          translations: [{ locale: 'en', name: 'Sakura' }],
        })
        .expect(201)
    ).body as { id: string; version: number };
    const sushiSittings = (
      await h
        .http()
        .put(`${base()}/restaurants/${sushi.id}/sittings`)
        .set('X-Test-Actor', manager())
        .send({
          fromDate: today,
          sittings: ALL_DAYS.map((weekday) => ({ weekday, startsAt: '20:00', seats: 30 })),
        })
        .expect(200)
    ).body as Array<{ id: string; weekday: number }>;
    await h
      .http()
      .patch(`${base()}/restaurants/${sushi.id}`)
      .set('X-Test-Actor', manager())
      .send({ version: sushi.version, status: 'ACTIVE' })
      .expect(200);

    // The guest app, in Italian: 9 nights = 2 started weeks, so two dinners per restaurant; two at La Terrazza,
    // one at Sakura.
    const guest = await seedStay(h.db, hotel, '107', today, 9);
    const token = await guestSession(h, hotel, guest.stayId, guest.primary);
    const offer = await h
      .http()
      .get('/guest/restaurants')
      .set(GUEST_SESSION_HEADER, token)
      .set('Accept-Language', 'it')
      .expect(200);
    expect(
      offer.body.restaurants.map((r: { name: string; allowance: { remaining: number } }) => [
        r.name,
        r.allowance.remaining,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['La Terrazza', 2],
        ['Sakura', 2],
      ]),
    );
    const guestBook = (body: object) =>
      h.http().post('/guest/restaurant-reservations').set(GUEST_SESSION_HEADER, token).send(body);
    const d1 = addDays(today, 2);
    const d2 = addDays(today, 3);
    await guestBook({
      restaurantId: restaurant.id,
      sittingId: late(d1),
      serviceDate: d1,
      partySize: 2,
    }).expect(201);
    await guestBook({
      restaurantId: restaurant.id,
      sittingId: late(d2),
      serviceDate: d2,
      partySize: 2,
    }).expect(201);
    const sakuraOn = (date: string) => sushiSittings.find((x) => x.weekday === weekdayOf(date))!.id;
    await guestBook({
      restaurantId: sushi.id,
      sittingId: sakuraOn(d1),
      serviceDate: d1,
      partySize: 2,
    }).expect(201);
    const d3 = addDays(today, 4);
    const third = await guestBook({
      restaurantId: restaurant.id,
      sittingId: late(d3),
      serviceDate: d3,
      partySize: 2,
    }).expect(409);
    expect(third.body.code).toBe('restaurant.reservation.allowance_used');

    // On the phone: the 19:00 sitting (4 seats) fills, then a full sitting needs the override and a reason.
    const day = addDays(today, 5);
    const caller = await seedStay(h.db, hotel, '108', today, 7);
    const phone = (
      actor: string,
      stayId: string,
      partySize: number,
      override?: { reason: string },
    ) =>
      h
        .http()
        .post(`${base()}/restaurant-reservations`)
        .set('X-Test-Actor', actor)
        .send({
          restaurantId: restaurant.id,
          sittingId: early(day),
          serviceDate: day,
          partySize,
          stayId,
          override,
        });
    await phone(host(), guest.stayId, 4, { reason: 'Guest asked at the desk' }).expect(403);
    const filled = await phone(supervisor(), guest.stayId, 4, {
      reason: 'Birthday dinner, GM approved',
    }).expect(201);
    expect((await phone(host(), caller.stayId, 2).expect(409)).body.code).toBe(
      'restaurant.reservation.sitting_full',
    );
    const squeezed = await phone(supervisor(), caller.stayId, 2, {
      reason: 'Regular guest, extra table',
    }).expect(201);
    expect(squeezed.body.overridden).toBe(true);

    // The board of that day: both bookings at 19:00, 6 covers for 4 seats; one is seated, the other does not come.
    const board = await h
      .http()
      .get(`${base()}/restaurant-reservations?date=${day}&restaurantId=${restaurant.id}`)
      .set('X-Test-Actor', host())
      .expect(200);
    const sitting = board.body[0].sittings.find(
      (x: { startsAt: string }) => x.startsAt === '19:00',
    );
    expect(sitting).toMatchObject({ seats: 4, booked: 6, free: 0 });
    await h
      .http()
      .post(`${base()}/restaurant-reservations/${squeezed.body.id}/seat`)
      .set('X-Test-Actor', host())
      .send({ version: squeezed.body.version })
      .expect(200);
    await h
      .http()
      .post(`${base()}/restaurant-reservations/${filled.body.id}/no-show`)
      .set('X-Test-Actor', host())
      .send({ version: filled.body.version })
      .expect(200);

    // Checkout: the guest's confirmed bookings are cancelled; the no-show stays as it was.
    await h.app.get(ReservationService).onStayEvent(
      createEnvelope(StayStatusChanged, {
        eventId: newId(),
        tenantId: hotel.tenantId,
        propertyId: hotel.propertyId,
        source: 'guest',
        correlationId: null,
        payload: {
          stay_id: guest.stayId,
          primary_guest_id: guest.primary,
          from: 'IN_HOUSE',
          to: 'CHECKED_OUT',
          at: new Date().toISOString(),
          room_id: hotel.rooms['107']!,
        },
      }),
    );
    const left = await h.db.execute(
      sql`select status, count(*)::int as n from restaurant.reservations where stay_id = ${guest.stayId} group by status order by status`,
    );
    expect(left.rows).toEqual([
      { status: 'CANCELLED', n: 3 },
      { status: 'NO_SHOW', n: 1 },
    ]);
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
