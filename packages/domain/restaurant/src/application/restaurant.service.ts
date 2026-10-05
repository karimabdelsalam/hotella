import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate } from '@hotella/platform-auth';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { isUuid, newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { addDays, isoDate } from '@hotella/platform-time';
import { sittingsOn } from '../domain/rules';
import { RestaurantRepositories } from '../infrastructure/repositories';
import type { RestaurantRow, RestaurantTranslationRow, SittingRow } from '../infrastructure/schema';
import type {
  ClosureInput,
  CreateRestaurantInput,
  ScheduleInput,
  UpdateRestaurantInput,
} from './schemas';

export const RESTAURANT_ENTITLEMENT = 'RESTAURANT';
const MANAGE = 'restaurant.restaurant.manage';
const READ = 'restaurant.restaurant.read';
const MAX_RANGE_DAYS = 31;

/** A name in the asked language, else English, else any (never an empty label). */
export function localized(rows: readonly RestaurantTranslationRow[], locale: string) {
  const pick =
    rows.find((r) => r.locale === locale) ??
    rows.find((r) => r.locale === locale.slice(0, 2)) ??
    rows.find((r) => r.locale === 'en') ??
    rows[0];
  return {
    name: pick?.name ?? '',
    description: pick?.description ?? null,
    dressCode: pick?.dressCode ?? null,
  };
}

export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  const [y, m, d] = from.split('-').map(Number) as [number, number, number];
  for (let i = 0; i <= MAX_RANGE_DAYS; i++) {
    const day = isoDate(addDays({ year: y, month: m, day: d }, i));
    if (day > to) break;
    out.push(day);
  }
  if (out.length === 0 || out.at(-1)! < to)
    throw new AppError('restaurant.range_too_long', HttpStatus.UNPROCESSABLE_ENTITY, {
      days: MAX_RANGE_DAYS,
    });
  return out;
}

export interface SittingAvailability {
  readonly sittingId: string;
  readonly startsAt: string;
  readonly seats: number;
  readonly booked: number;
  readonly free: number;
}

/**
 * Restaurants of a property and their schedule (Spec Appendix B.1): names per language, weekly sittings with seats
 * from a date on (bookings keep the sitting they booked), closures, and availability computed from the seat counter.
 */
@Injectable()
export class RestaurantService {
  constructor(
    private readonly repo: RestaurantRepositories,
    private readonly tx: TransactionRunner,
    private readonly gate: ActionGate,
    private readonly audit: AuditWriter,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
  ) {}

  list(scope: PropertyScope, locale: string) {
    return this.act(scope, READ, 'read', async () =>
      this.views(scope, await this.repo.listRestaurants(scope), locale),
    );
  }

  get(scope: PropertyScope, id: string, locale: string) {
    return this.act(scope, READ, 'read', async () => {
      const restaurant = await this.require(scope, id);
      const [view] = await this.views(scope, [restaurant], locale);
      return {
        ...view!,
        sittings: (await this.repo.sittings(scope, [id])).filter((s) => s.active).map(sittingView),
      };
    });
  }

  create(scope: PropertyScope, input: CreateRestaurantInput, locale: string) {
    return this.act(scope, MANAGE, 'write', async () => {
      const row = await this.repo
        .insertRestaurant({
          id: newId(),
          tenantId: scope.tenantId,
          propertyId: scope.propertyId,
          code: input.code,
          minParty: input.minParty,
          maxParty: input.maxParty,
          bookDaysAhead: input.bookDaysAhead,
          guestCutoffMinutes: input.guestCutoffMinutes,
          allowanceApplies: input.allowanceApplies,
          sortOrder: input.sortOrder,
        })
        .catch((e: unknown) => {
          if (
            (e as { code?: string }).code === '23505' ||
            (e as { cause?: { code?: string } }).cause?.code === '23505'
          )
            throw AppError.conflict('restaurant.code_taken', { code: input.code });
          throw e;
        });
      for (const t of input.translations)
        await this.repo.upsertTranslation({
          entityId: row.id,
          locale: t.locale,
          name: t.name,
          description: t.description ?? null,
          dressCode: t.dressCode ?? null,
        });
      await this.audit.record({
        action: 'restaurant.restaurant.create',
        entityType: 'restaurant',
        entityId: row.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        after: { code: row.code },
      });
      const [view] = await this.views(scope, [row], locale);
      return view!;
    });
  }

  update(scope: PropertyScope, id: string, input: UpdateRestaurantInput, locale: string) {
    return this.act(scope, MANAGE, 'write', async () => {
      const before = await this.require(scope, id);
      const { version, ...values } = input;
      const maxParty = values.maxParty ?? before.maxParty;
      if (maxParty < (values.minParty ?? before.minParty))
        throw new AppError('restaurant.party_limits_invalid', HttpStatus.UNPROCESSABLE_ENTITY);
      const after = await this.repo.updateRestaurant(scope, id, version, values);
      if (!after) throw AppError.conflict('restaurant.version_conflict');
      await this.audit.record({
        action: 'restaurant.restaurant.update',
        entityType: 'restaurant',
        entityId: id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        before: { status: before.status },
        after: { status: after.status, ...values },
      });
      const [view] = await this.views(scope, [after], locale);
      return view!;
    });
  }

  setTranslation(
    scope: PropertyScope,
    id: string,
    locale: string,
    input: { name: string; description?: string | null; dressCode?: string | null },
  ) {
    return this.act(scope, MANAGE, 'write', async () => {
      await this.require(scope, id);
      await this.repo.upsertTranslation({
        entityId: id,
        locale,
        name: input.name,
        description: input.description ?? null,
        dressCode: input.dressCode ?? null,
      });
      return { locale, ...input };
    });
  }

  /** Replaces the weekly schedule from a date: earlier sittings end the day before, booked ones are untouched. */
  setSchedule(scope: PropertyScope, id: string, input: ScheduleInput) {
    return this.act(scope, MANAGE, 'write', async () => {
      await this.require(scope, id);
      const seen = new Set<string>();
      for (const s of input.sittings) {
        const key = `${s.weekday}@${s.startsAt}`;
        if (seen.has(key))
          throw new AppError('restaurant.sitting_duplicate', HttpStatus.UNPROCESSABLE_ENTITY, {
            weekday: s.weekday,
            startsAt: s.startsAt,
          });
        seen.add(key);
      }
      await this.repo.endSittingsFrom(scope, id, input.fromDate);
      const rows = await this.repo.insertSittings(
        input.sittings.map((s) => ({
          id: newId(),
          tenantId: scope.tenantId,
          propertyId: scope.propertyId,
          restaurantId: id,
          weekday: s.weekday,
          startsAt: s.startsAt,
          seats: s.seats,
          validFrom: input.fromDate,
        })),
      );
      await this.audit.record({
        action: 'restaurant.schedule.set',
        entityType: 'restaurant',
        entityId: id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        after: { from: input.fromDate, sittings: input.sittings.length },
      });
      return rows.map(sittingView);
    });
  }

  addClosure(scope: PropertyScope, id: string, input: ClosureInput) {
    return this.act(scope, MANAGE, 'write', async () => {
      await this.require(scope, id);
      if (input.sittingId) {
        const sitting = await this.repo.sitting(scope, input.sittingId);
        if (!sitting || sitting.restaurantId !== id)
          throw AppError.notFound('restaurant.sitting.not_found');
      }
      const row = await this.repo.insertClosure({
        id: newId(),
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        restaurantId: id,
        onDate: input.onDate,
        sittingId: input.sittingId ?? null,
        reason: input.reason,
      });
      await this.audit.record({
        action: 'restaurant.closure.add',
        entityType: 'restaurant',
        entityId: id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        reason: input.reason,
        after: { on: row.onDate, sitting: row.sittingId },
      });
      return row;
    });
  }

  /** Open sittings with seats booked and free, per restaurant and day (staff view; guests get a filtered one). */
  availability(scope: PropertyScope, from: string, to: string, locale: string) {
    return this.act(scope, READ, 'read', () =>
      this.availabilityOf(scope, from, to, locale, { activeOnly: false }),
    );
  }

  /** Shared by staff, guests and the concierge: no gate here — callers gate. */
  async availabilityOf(
    scope: PropertyScope,
    from: string,
    to: string,
    locale: string,
    opts: { activeOnly: boolean },
  ) {
    const days = dayRange(from, to);
    const restaurants = (await this.repo.listRestaurants(scope)).filter(
      (r) => r.status === 'ACTIVE' || (!opts.activeOnly && r.status !== 'INACTIVE'),
    );
    const ids = restaurants.map((r) => r.id);
    const [sittings, closures, views] = await Promise.all([
      this.repo.sittings(scope, ids),
      this.repo.closures(scope, ids, from, to),
      this.views(scope, restaurants, locale),
    ]);
    const loads = await this.repo.loads(
      scope,
      sittings.map((s) => s.id),
      from,
      to,
    );
    const booked = new Map(loads.map((l) => [`${l.sittingId}@${l.serviceDate}`, l.covers]));
    return views.map((view) => ({
      ...view,
      days: days.map((date) => ({
        date,
        sittings: sittingsOn(
          date,
          sittings.filter((s) => s.restaurantId === view.id),
          closures.filter((c) => c.restaurantId === view.id),
        ).map((s): SittingAvailability => {
          const n = booked.get(`${s.id}@${date}`) ?? 0;
          return {
            sittingId: s.id,
            startsAt: s.startsAt,
            seats: s.seats,
            booked: n,
            free: Math.max(0, s.seats - n),
          };
        }),
      })),
    }));
  }

  async timeZone(scope: PropertyScope): Promise<string> {
    const property = await this.org.getProperty(scope.tenantId, scope.propertyId);
    if (!property) throw AppError.notFound('org.property.not_found');
    return property.timezone;
  }

  async views(scope: PropertyScope, rows: readonly RestaurantRow[], locale: string) {
    const translations = await this.repo.translations(rows.map((r) => r.id));
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      status: r.status,
      ...localized(
        translations.filter((t) => t.entityId === r.id),
        locale,
      ),
      minParty: r.minParty,
      maxParty: r.maxParty,
      bookDaysAhead: r.bookDaysAhead,
      guestCutoffMinutes: r.guestCutoffMinutes,
      allowanceApplies: r.allowanceApplies,
      sortOrder: r.sortOrder,
      version: r.version,
    }));
  }

  private async require(scope: PropertyScope, id: string): Promise<RestaurantRow> {
    const row = isUuid(id) ? await this.repo.restaurant(scope, id) : undefined;
    if (!row) throw AppError.notFound('restaurant.not_found');
    return row;
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

export function sittingView(s: SittingRow) {
  return {
    id: s.id,
    weekday: s.weekday,
    startsAt: s.startsAt,
    seats: s.seats,
    validFrom: s.validFrom,
    validTo: s.validTo,
  };
}
