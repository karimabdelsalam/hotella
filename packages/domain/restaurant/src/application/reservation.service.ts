import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  type EventEnvelope,
  RestaurantReservationCancelled,
  RestaurantReservationCreated,
  RestaurantReservationStatusChanged,
  StayStatusChanged,
} from '@hotella/contracts-events';
import { GUEST_API, type GuestPrincipal, type GuestPublicApi } from '@hotella/domain-guest/public';
import { ENTITLEMENT_API, type EntitlementPublicApi } from '@hotella/domain-licensing/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import {
  DATABASE,
  type Database,
  executor,
  isUuid,
  newId,
  type PropertyScope,
  TransactionRunner,
} from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { SettingsReader } from '@hotella/platform-settings';
import {
  canTransition,
  guestWindow,
  HOLDS_SEATS,
  localDate,
  type ReservationStatus,
  sittingsOn,
  stayAllowance,
  stayNights,
  withinStay,
} from '../domain/rules';
import { ALLOWANCE } from '../domain/settings';
import { RestaurantRepositories } from '../infrastructure/repositories';
import type { ReservationRow } from '../infrastructure/schema';
import { RESTAURANT_ENTITLEMENT, RestaurantService } from './restaurant.service';
import type { GuestBookInput, StaffBookInput, TransitionInput } from './schemas';

type Actor = { readonly type: string; readonly id: string | null };
type Channel = 'GUEST_APP' | 'STAFF' | 'AI';
const ACTIVE_STAY = ['EXPECTED', 'IN_HOUSE'];

/**
 * À la carte reservations (Spec Appendix B.1). Every booking — guest app, staff on the phone, concierge — passes the
 * same rules in one transaction: the restaurant serves that sitting that day, the date is a night of the stay, the
 * party fits the restaurant, the stay still has allowance at this restaurant (⌈nights ÷ block⌉ × per block), and the
 * seats are taken atomically. Staff may override the allowance or a full sitting with a reason (separate permission,
 * audited). History of every transition is kept; checkout cancels what is still ahead.
 */
@Injectable()
export class ReservationService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: RestaurantRepositories,
    private readonly restaurants: RestaurantService,
    private readonly tx: TransactionRunner,
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
    private readonly audit: AuditWriter,
    private readonly events: EventPublisher,
    private readonly settings: SettingsReader,
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    @Optional() @Inject(ENTITLEMENT_API) private readonly entitlements?: EntitlementPublicApi,
  ) {}

  // ---- staff ----

  board(scope: PropertyScope, date: string, restaurantId: string | undefined, locale: string) {
    return this.act(scope, 'restaurant.reservation.read', 'read', async () => {
      const [availability, rows] = await Promise.all([
        this.restaurants.availabilityOf(scope, date, date, locale, { activeOnly: false }),
        this.repo.reservationsOn(scope, date, date, restaurantId),
      ]);
      const names = await this.guestNames(scope, rows);
      return availability
        .filter((r) => !restaurantId || r.id === restaurantId)
        .map((r) => ({
          ...r,
          sittings: r.days[0]!.sittings.map((s) => ({
            ...s,
            reservations: rows
              .filter((x) => x.sittingId === s.sittingId)
              .map((x) => ({ ...reservationView(x), guestName: names.get(x.stayId) ?? null })),
          })),
          days: undefined,
        }));
    });
  }

  bookForGuest(scope: PropertyScope, input: StaffBookInput) {
    const run = () =>
      this.act(scope, 'restaurant.reservation.manage', 'write', () =>
        this.book(scope, input, input.stayId, 'STAFF', input.override?.reason ?? null),
      );
    // An override needs its own permission, checked before anything is booked.
    return input.override
      ? this.gate.execute(
          {
            action: 'restaurant.reservation.override',
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
          },
          run,
        )
      : run();
  }

  transition(scope: PropertyScope, id: string, to: ReservationStatus, input: TransitionInput) {
    return this.act(scope, 'restaurant.reservation.manage', 'write', async () => {
      const row = await this.require(scope, id);
      return reservationView(
        await this.move(scope, row, input.version, to, input.reason ?? null, 'STAFF'),
      );
    });
  }

  // ---- guests ----

  /** What a guest can book: open restaurants and sittings within the stay, their seats, and allowance left. */
  async guestOffer(guest: GuestPrincipal, locale: string) {
    const { scope, stay } = await this.guestContext(guest);
    return this.tx.read(async () => {
      const timeZone = await this.restaurants.timeZone(scope);
      const today = localDate(new Date(), timeZone);
      const from = stay.expectedArrival > today ? stay.expectedArrival : today;
      const lastNight = lastNightOf(stay.expectedArrival, stay.expectedDeparture);
      if (from > lastNight) return { restaurants: [] };
      const to = lastNight;
      const all = await this.restaurants.availabilityOf(
        scope,
        from,
        minDate(to, from, 31),
        locale,
        { activeOnly: true },
      );
      const rows = await this.repo.listRestaurants(scope);
      const policy = await this.settings.value(ALLOWANCE, scope);
      const nights = stayNights(stay.expectedArrival, stay.expectedDeparture);
      const out = [];
      for (const r of all) {
        const row = rows.find((x) => x.id === r.id)!;
        const used = await this.repo.usedAllowance(scope, stay.id, r.id);
        const allowed = row.allowanceApplies ? stayAllowance(nights, policy) : null;
        out.push({
          ...r,
          allowance: {
            allowed,
            used,
            remaining: allowed === null ? null : Math.max(0, allowed - used),
          },
          days: r.days
            .filter((d) => withinStay(d.date, stay.expectedArrival, stay.expectedDeparture))
            .map((d) => ({
              ...d,
              sittings: d.sittings.map((s) => ({
                ...s,
                bookable:
                  s.free >= row.minParty &&
                  guestWindow({
                    now: new Date(),
                    serviceDate: d.date,
                    startsAt: s.startsAt,
                    timeZone,
                    cutoffMinutes: row.guestCutoffMinutes,
                    daysAhead: row.bookDaysAhead,
                  }) === 'OPEN',
              })),
            })),
        });
      }
      return { restaurants: out };
    });
  }

  async guestBook(guest: GuestPrincipal, input: GuestBookInput) {
    const { scope, stay } = await this.guestContext(guest);
    return this.tx.run(() => this.book(scope, input, stay.id, 'GUEST_APP', null, guest.guestId));
  }

  async guestReservations(guest: GuestPrincipal, locale: string) {
    const { scope, stay } = await this.guestContext(guest);
    return this.tx.read(async () => {
      const rows = await this.repo.ofStay(scope, stay.id);
      const views = await this.restaurants.views(
        scope,
        await this.repo.listRestaurants(scope),
        locale,
      );
      return rows.map((r) => ({
        ...reservationView(r),
        notes: undefined,
        restaurant: views.find((v) => v.id === r.restaurantId) ?? null,
      }));
    });
  }

  async guestCancel(guest: GuestPrincipal, id: string) {
    const { scope, stay } = await this.guestContext(guest);
    return this.tx.run(async () => {
      const row = await this.require(scope, id);
      if (row.stayId !== stay.id) throw AppError.notFound('restaurant.reservation.not_found');
      const restaurant = (await this.repo.restaurant(scope, row.restaurantId))!;
      const window = guestWindow({
        now: new Date(),
        serviceDate: row.serviceDate,
        startsAt: row.startsAt,
        timeZone: await this.restaurants.timeZone(scope),
        cutoffMinutes: restaurant.guestCutoffMinutes,
        daysAhead: 366,
      });
      if (window === 'CUTOFF_PASSED')
        throw new AppError('restaurant.reservation.cutoff_passed', HttpStatus.CONFLICT);
      return reservationView(await this.move(scope, row, row.version, 'CANCELLED', null, 'GUEST'));
    });
  }

  // ---- the stay left the house (worker) ----

  static readonly consumes = [StayStatusChanged] as const;

  /** PMS check-out, cancellation or no-show: confirmed reservations still ahead are cancelled (rule 19). */
  async onStayEvent(envelope: EventEnvelope): Promise<void> {
    if (!envelope.tenant_id || envelope.event_type !== StayStatusChanged.type) return;
    const e = StayStatusChanged.parse(envelope);
    if (!['CHECKED_OUT', 'CANCELLED', 'NO_SHOW'].includes(e.payload.to)) return;
    const stay = await this.guests.getStay(envelope.tenant_id, e.payload.stay_id);
    if (!stay) return;
    const scope = { tenantId: envelope.tenant_id, propertyId: stay.propertyId };
    await this.tx.run(async () => {
      for (const row of await this.repo.ofStay(scope, stay.id))
        if (row.status === 'CONFIRMED')
          await this.move(scope, row, row.version, 'CANCELLED', 'STAY_ENDED', 'STAY_ENDED');
    });
  }

  // ---- the rules ----

  private async book(
    scope: PropertyScope,
    input: GuestBookInput,
    stayId: string,
    channel: Channel,
    overrideReason: string | null,
    guestId: string | null = null,
  ) {
    const restaurant = await this.repo.restaurant(scope, input.restaurantId);
    if (!restaurant || restaurant.status !== 'ACTIVE')
      throw AppError.notFound('restaurant.not_found');
    if (input.partySize < restaurant.minParty || input.partySize > restaurant.maxParty)
      throw new AppError('restaurant.reservation.party_size', HttpStatus.UNPROCESSABLE_ENTITY, {
        min: restaurant.minParty,
        max: restaurant.maxParty,
      });
    const sitting = await this.repo.sitting(scope, input.sittingId);
    if (!sitting || sitting.restaurantId !== restaurant.id)
      throw AppError.notFound('restaurant.sitting.not_found');
    const closures = await this.repo.closures(
      scope,
      [restaurant.id],
      input.serviceDate,
      input.serviceDate,
    );
    if (!sittingsOn(input.serviceDate, [sitting], closures).length)
      throw new AppError('restaurant.reservation.closed', HttpStatus.CONFLICT);

    const stay = await this.guests.getStay(scope.tenantId, stayId);
    if (!stay || stay.propertyId !== scope.propertyId || !ACTIVE_STAY.includes(stay.status))
      throw AppError.notFound('restaurant.stay.not_found');
    if (!withinStay(input.serviceDate, stay.expectedArrival, stay.expectedDeparture))
      throw new AppError('restaurant.reservation.outside_stay', HttpStatus.UNPROCESSABLE_ENTITY);

    if (channel !== 'STAFF') {
      const window = guestWindow({
        now: new Date(),
        serviceDate: input.serviceDate,
        startsAt: sitting.startsAt,
        timeZone: await this.restaurants.timeZone(scope),
        cutoffMinutes: restaurant.guestCutoffMinutes,
        daysAhead: restaurant.bookDaysAhead,
      });
      if (window === 'CUTOFF_PASSED')
        throw new AppError('restaurant.reservation.cutoff_passed', HttpStatus.CONFLICT);
      if (window === 'TOO_EARLY')
        throw new AppError('restaurant.reservation.too_early', HttpStatus.CONFLICT, {
          days: restaurant.bookDaysAhead,
        });
    }

    // One booking at a time per stay and restaurant: the allowance count cannot be raced.
    await executor(this.db).execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`restaurant:${stayId}:${restaurant.id}`}, 0))`,
    );
    if (restaurant.allowanceApplies) {
      const allowed = stayAllowance(
        stayNights(stay.expectedArrival, stay.expectedDeparture),
        await this.settings.value(ALLOWANCE, scope),
      );
      const used = await this.repo.usedAllowance(scope, stay.id, restaurant.id);
      if (used >= allowed && !overrideReason)
        throw new AppError('restaurant.reservation.allowance_used', HttpStatus.CONFLICT, {
          allowed,
        });
    }
    const fits = await this.repo.addCovers(
      scope,
      sitting.id,
      input.serviceDate,
      input.partySize,
      sitting.seats,
      overrideReason !== null,
    );
    if (!fits) throw new AppError('restaurant.reservation.sitting_full', HttpStatus.CONFLICT);

    const actor = this.actor();
    const room = stay.currentRoomId
      ? await this.org.getRoom(scope.tenantId, scope.propertyId, stay.currentRoomId)
      : null;
    const row = await this.repo.insertReservation({
      id: newId(),
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      restaurantId: restaurant.id,
      sittingId: sitting.id,
      serviceDate: input.serviceDate,
      startsAt: sitting.startsAt,
      partySize: input.partySize,
      stayId: stay.id,
      guestId: guestId ?? stay.primaryGuestId,
      roomNumber: room?.roomNumber ?? null,
      channel,
      notes: input.notes ?? null,
      overrideReason,
      createdByType: actor.type,
      createdById: actor.id,
    });
    await this.repo.recordTransition({
      id: newId(),
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      reservationId: row.id,
      fromStatus: null,
      toStatus: 'CONFIRMED',
      reason: overrideReason,
      actorType: actor.type,
      actorId: actor.id,
    });
    await this.events.publish(RestaurantReservationCreated, {
      ...this.eventAt(scope, row.id),
      payload: {
        reservation_id: row.id,
        restaurant_id: restaurant.id,
        stay_id: stay.id,
        service_date: row.serviceDate,
        starts_at: row.startsAt,
        party_size: row.partySize,
        channel,
        overridden: overrideReason !== null,
      },
    });
    await this.audit.record({
      action: overrideReason
        ? 'restaurant.reservation.create_override'
        : 'restaurant.reservation.create',
      entityType: 'restaurant_reservation',
      entityId: row.id,
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      reason: overrideReason ?? undefined,
      after: {
        restaurant: restaurant.code,
        date: row.serviceDate,
        at: row.startsAt,
        party: row.partySize,
        channel,
      },
    });
    return reservationView(row);
  }

  private async move(
    scope: PropertyScope,
    row: ReservationRow,
    version: number,
    to: ReservationStatus,
    reason: string | null,
    by: 'GUEST' | 'STAFF' | 'STAY_ENDED',
  ): Promise<ReservationRow> {
    if (!canTransition(row.status, to))
      throw new AppError('restaurant.reservation.transition_not_allowed', HttpStatus.CONFLICT, {
        from: row.status,
        to,
      });
    const after = await this.repo.transition(
      scope,
      row.id,
      version,
      to,
      to === 'CANCELLED' ? { cancelReason: reason } : {},
    );
    if (!after) throw AppError.conflict('restaurant.version_conflict');
    const held = (s: ReservationStatus) => (HOLDS_SEATS as readonly string[]).includes(s);
    if (held(row.status) && !held(to))
      await this.repo.releaseCovers(scope, row.sittingId, row.serviceDate, row.partySize);
    const actor = by === 'STAY_ENDED' ? { type: 'SYSTEM', id: null } : this.actor();
    await this.repo.recordTransition({
      id: newId(),
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      reservationId: row.id,
      fromStatus: row.status,
      toStatus: to,
      reason,
      actorType: actor.type,
      actorId: actor.id,
    });
    if (to === 'CANCELLED')
      await this.events.publish(RestaurantReservationCancelled, {
        ...this.eventAt(scope, row.id),
        payload: {
          reservation_id: row.id,
          restaurant_id: row.restaurantId,
          stay_id: row.stayId,
          service_date: row.serviceDate,
          by,
        },
      });
    else
      await this.events.publish(RestaurantReservationStatusChanged, {
        ...this.eventAt(scope, row.id),
        payload: { reservation_id: row.id, restaurant_id: row.restaurantId, from: row.status, to },
      });
    await this.audit.record({
      action: `restaurant.reservation.${to.toLowerCase()}`,
      entityType: 'restaurant_reservation',
      entityId: row.id,
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      reason: reason ?? undefined,
      actor: by === 'STAY_ENDED' ? { type: 'SYSTEM', id: 'restaurant.stay_ended' } : undefined,
      before: { status: row.status },
      after: { status: to },
    });
    return after;
  }

  private async guestContext(guest: GuestPrincipal) {
    if (!guest.scopes.includes('DINING'))
      throw AppError.forbidden('guest.session.scope_missing', { scope: 'DINING' });
    if (!guest.stayId) throw AppError.forbidden('restaurant.stay_required');
    const scope = { tenantId: guest.tenantId, propertyId: guest.propertyId };
    if (
      this.entitlements &&
      !(await this.entitlements.can(scope.tenantId, scope.propertyId, RESTAURANT_ENTITLEMENT))
    )
      throw new AppError('license.not_entitled', HttpStatus.FORBIDDEN, {
        capability: RESTAURANT_ENTITLEMENT,
      });
    const stay = await this.guests.getStay(guest.tenantId, guest.stayId);
    if (!stay || stay.propertyId !== guest.propertyId || !ACTIVE_STAY.includes(stay.status))
      throw AppError.forbidden('restaurant.stay_required');
    return { scope, stay };
  }

  private async guestNames(scope: PropertyScope, rows: readonly ReservationRow[]) {
    const names = new Map<string, string>();
    for (const stayId of new Set(rows.map((r) => r.stayId))) {
      const primary = (await this.guests.stayParty(scope.tenantId, stayId)).find(
        (m) => m.role === 'PRIMARY',
      );
      if (primary)
        names.set(stayId, [primary.givenName, primary.familyName].filter(Boolean).join(' '));
    }
    return names;
  }

  private async require(scope: PropertyScope, id: string): Promise<ReservationRow> {
    const row = isUuid(id) ? await this.repo.reservation(scope, id) : undefined;
    if (!row) throw AppError.notFound('restaurant.reservation.not_found');
    return row;
  }

  private eventAt(scope: PropertyScope, reservationId: string) {
    return {
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      source: 'restaurant',
      aggregate: { type: 'restaurant_reservation', id: reservationId },
    };
  }

  private actor(): Actor {
    const a = this.actors.require();
    return { type: a.type, id: a.id && isUuid(a.id) ? a.id : null };
  }

  private act<T>(
    scope: PropertyScope,
    action: string,
    mode: 'read' | 'write',
    fn: () => Promise<T>,
  ) {
    return this.gate.execute(
      {
        action,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        entitlement: RESTAURANT_ENTITLEMENT,
      },
      () => (mode === 'read' ? this.tx.read(fn) : this.tx.run(fn)),
    );
  }
}

export function reservationView(r: ReservationRow) {
  return {
    id: r.id,
    restaurantId: r.restaurantId,
    sittingId: r.sittingId,
    serviceDate: r.serviceDate,
    startsAt: r.startsAt,
    partySize: r.partySize,
    stayId: r.stayId,
    roomNumber: r.roomNumber,
    status: r.status,
    channel: r.channel,
    notes: r.notes,
    overridden: r.overrideReason !== null,
    version: r.version,
  };
}

/** The last night of a stay (a day use: its arrival date). */
function lastNightOf(arrival: string, departure: string): string {
  if (departure <= arrival) return arrival;
  const d = new Date(`${departure}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** `to`, but at most `days` days after `from` (availability windows stay bounded). */
function minDate(to: string, from: string, days: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days - 1);
  const cap = d.toISOString().slice(0, 10);
  return to < cap ? to : cap;
}
