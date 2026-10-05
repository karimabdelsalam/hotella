import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type PropertyScope,
  tenantWhere,
} from '@hotella/platform-database';
import type { ReservationStatus } from '../domain/rules';
import {
  type ClosureRow,
  closures,
  type ReservationRow,
  reservations,
  reservationTransitions,
  restaurants,
  type RestaurantRow,
  restaurantTranslations,
  type RestaurantTranslationRow,
  sittingLoads,
  type SittingRow,
  sittings,
} from './schema';

/** Restaurant rows; every query carries the tenant and property (CLAUDE.md rule 1). */
@Injectable()
export class RestaurantRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- restaurants ----
  async insertRestaurant(values: typeof restaurants.$inferInsert): Promise<RestaurantRow> {
    const [row] = await this.x.insert(restaurants).values(values).returning();
    return row!;
  }
  listRestaurants(scope: PropertyScope): Promise<RestaurantRow[]> {
    return this.x
      .select()
      .from(restaurants)
      .where(tenantWhere(restaurants, scope, eq(restaurants.propertyId, scope.propertyId)))
      .orderBy(asc(restaurants.sortOrder), asc(restaurants.code));
  }
  restaurant(scope: PropertyScope, id: string): Promise<RestaurantRow | undefined> {
    return this.x
      .select()
      .from(restaurants)
      .where(
        tenantWhere(
          restaurants,
          scope,
          and(eq(restaurants.propertyId, scope.propertyId), eq(restaurants.id, id)),
        ),
      )
      .then((r) => r[0]);
  }
  /** Optimistic update (rule 2): undefined when the version moved on. */
  async updateRestaurant(
    scope: PropertyScope,
    id: string,
    version: number,
    values: Partial<typeof restaurants.$inferInsert>,
  ): Promise<RestaurantRow | undefined> {
    const [row] = await this.x
      .update(restaurants)
      .set({ ...values, version: sql`${restaurants.version} + 1` })
      .where(
        tenantWhere(
          restaurants,
          scope,
          and(
            eq(restaurants.propertyId, scope.propertyId),
            eq(restaurants.id, id),
            eq(restaurants.version, version),
          ),
        ),
      )
      .returning();
    return row;
  }
  translations(ids: readonly string[]): Promise<RestaurantTranslationRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    // Translation rows have no tenant of their own: they are reached only through restaurants already scoped.
    return this.x
      .select()
      .from(restaurantTranslations)
      .where(inArray(restaurantTranslations.entityId, [...ids]));
  }
  async upsertTranslation(values: typeof restaurantTranslations.$inferInsert): Promise<void> {
    await this.x
      .insert(restaurantTranslations)
      .values(values)
      .onConflictDoUpdate({
        target: [restaurantTranslations.entityId, restaurantTranslations.locale],
        set: {
          name: values.name,
          description: values.description,
          dressCode: values.dressCode,
          updatedAt: new Date(),
        },
      });
  }

  // ---- sittings and closures ----
  sittings(scope: PropertyScope, restaurantIds: readonly string[]): Promise<SittingRow[]> {
    if (restaurantIds.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(sittings)
      .where(
        tenantWhere(
          sittings,
          scope,
          and(
            eq(sittings.propertyId, scope.propertyId),
            inArray(sittings.restaurantId, [...restaurantIds]),
          ),
        ),
      )
      .orderBy(asc(sittings.weekday), asc(sittings.startsAt));
  }
  sitting(scope: PropertyScope, id: string): Promise<SittingRow | undefined> {
    return this.x
      .select()
      .from(sittings)
      .where(
        tenantWhere(
          sittings,
          scope,
          and(eq(sittings.propertyId, scope.propertyId), eq(sittings.id, id)),
        ),
      )
      .then((r) => r[0]);
  }
  /**
   * A new weekly schedule from `fromDate`: sittings in force then end the day before (rows that would only have started
   * on or after it are deactivated), so bookings keep the sitting they booked.
   */
  async endSittingsFrom(
    scope: PropertyScope,
    restaurantId: string,
    fromDate: string,
  ): Promise<void> {
    const where = (extra: ReturnType<typeof and>) =>
      tenantWhere(
        sittings,
        scope,
        and(
          eq(sittings.propertyId, scope.propertyId),
          eq(sittings.restaurantId, restaurantId),
          extra,
        ),
      );
    await this.x
      .update(sittings)
      .set({ active: false, updatedAt: new Date() })
      .where(where(and(gte(sittings.validFrom, fromDate), eq(sittings.active, true))));
    await this.x
      .update(sittings)
      .set({ validTo: sql`(${fromDate}::date - 1)`, updatedAt: new Date() })
      .where(
        where(
          and(
            eq(sittings.active, true),
            sql`${sittings.validFrom} < ${fromDate}::date`,
            or(isNull(sittings.validTo), gte(sittings.validTo, fromDate)),
          ),
        ),
      );
  }
  async insertSittings(values: Array<typeof sittings.$inferInsert>): Promise<SittingRow[]> {
    if (values.length === 0) return [];
    return this.x.insert(sittings).values(values).returning();
  }
  closures(
    scope: PropertyScope,
    restaurantIds: readonly string[],
    from: string,
    to: string,
  ): Promise<ClosureRow[]> {
    if (restaurantIds.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(closures)
      .where(
        tenantWhere(
          closures,
          scope,
          and(
            eq(closures.propertyId, scope.propertyId),
            inArray(closures.restaurantId, [...restaurantIds]),
            gte(closures.onDate, from),
            lte(closures.onDate, to),
          ),
        ),
      );
  }
  async insertClosure(values: typeof closures.$inferInsert): Promise<ClosureRow> {
    const [row] = await this.x.insert(closures).values(values).returning();
    return row!;
  }

  // ---- seats ----
  /**
   * Adds covers to a sitting on a date; false when they do not fit (unless `force`). One statement: two guests racing
   * for the last seats cannot both win.
   */
  async addCovers(
    scope: PropertyScope,
    sittingId: string,
    serviceDate: string,
    covers: number,
    seats: number,
    force: boolean,
  ): Promise<boolean> {
    if (!force && covers > seats) return false;
    const rows = await this.x
      .insert(sittingLoads)
      .values({
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        sittingId,
        serviceDate,
        covers,
      })
      .onConflictDoUpdate({
        target: [sittingLoads.sittingId, sittingLoads.serviceDate],
        set: { covers: sql`${sittingLoads.covers} + ${covers}` },
        setWhere: force ? undefined : sql`${sittingLoads.covers} + ${covers} <= ${seats}`,
      })
      .returning({ covers: sittingLoads.covers });
    return rows.length > 0;
  }
  async releaseCovers(
    scope: PropertyScope,
    sittingId: string,
    serviceDate: string,
    covers: number,
  ): Promise<void> {
    await this.x
      .update(sittingLoads)
      .set({ covers: sql`greatest(${sittingLoads.covers} - ${covers}, 0)` })
      .where(
        tenantWhere(
          sittingLoads,
          scope,
          and(eq(sittingLoads.sittingId, sittingId), eq(sittingLoads.serviceDate, serviceDate)),
        ),
      );
  }
  loads(scope: PropertyScope, sittingIds: readonly string[], from: string, to: string) {
    if (sittingIds.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(sittingLoads)
      .where(
        tenantWhere(
          sittingLoads,
          scope,
          and(
            inArray(sittingLoads.sittingId, [...sittingIds]),
            gte(sittingLoads.serviceDate, from),
            lte(sittingLoads.serviceDate, to),
          ),
        ),
      );
  }

  // ---- reservations ----
  async insertReservation(values: typeof reservations.$inferInsert): Promise<ReservationRow> {
    const [row] = await this.x.insert(reservations).values(values).returning();
    return row!;
  }
  reservation(scope: PropertyScope, id: string): Promise<ReservationRow | undefined> {
    return this.x
      .select()
      .from(reservations)
      .where(
        tenantWhere(
          reservations,
          scope,
          and(eq(reservations.propertyId, scope.propertyId), eq(reservations.id, id)),
        ),
      )
      .then((r) => r[0]);
  }
  reservationsOn(
    scope: PropertyScope,
    from: string,
    to: string,
    restaurantId?: string,
  ): Promise<ReservationRow[]> {
    return this.x
      .select()
      .from(reservations)
      .where(
        tenantWhere(
          reservations,
          scope,
          and(
            eq(reservations.propertyId, scope.propertyId),
            gte(reservations.serviceDate, from),
            lte(reservations.serviceDate, to),
            restaurantId ? eq(reservations.restaurantId, restaurantId) : undefined,
          ),
        ),
      )
      .orderBy(asc(reservations.serviceDate), asc(reservations.startsAt));
  }
  ofStay(scope: PropertyScope, stayId: string): Promise<ReservationRow[]> {
    return this.x
      .select()
      .from(reservations)
      .where(
        tenantWhere(
          reservations,
          scope,
          and(eq(reservations.propertyId, scope.propertyId), eq(reservations.stayId, stayId)),
        ),
      )
      .orderBy(asc(reservations.serviceDate), asc(reservations.startsAt));
  }
  /** Reservations of a stay at a restaurant that use its allowance (not cancelled). */
  async usedAllowance(scope: PropertyScope, stayId: string, restaurantId: string): Promise<number> {
    const [row] = await this.x
      .select({ n: sql<number>`count(*)::int` })
      .from(reservations)
      .where(
        tenantWhere(
          reservations,
          scope,
          and(
            eq(reservations.stayId, stayId),
            eq(reservations.restaurantId, restaurantId),
            notInArray(reservations.status, ['CANCELLED']),
          ),
        ),
      );
    return row?.n ?? 0;
  }
  /** Moves a reservation on (optimistic); undefined when it moved on meanwhile. */
  async transition(
    scope: PropertyScope,
    id: string,
    version: number,
    to: ReservationStatus,
    values: Partial<typeof reservations.$inferInsert> = {},
  ): Promise<ReservationRow | undefined> {
    const [row] = await this.x
      .update(reservations)
      .set({
        ...values,
        status: to,
        version: sql`${reservations.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        tenantWhere(
          reservations,
          scope,
          and(
            eq(reservations.id, id),
            eq(reservations.propertyId, scope.propertyId),
            eq(reservations.version, version),
          ),
        ),
      )
      .returning();
    return row;
  }
  async recordTransition(values: typeof reservationTransitions.$inferInsert): Promise<void> {
    await this.x.insert(reservationTransitions).values(values);
  }
  transitions(scope: PropertyScope, reservationId: string) {
    return this.x
      .select()
      .from(reservationTransitions)
      .where(
        tenantWhere(
          reservationTransitions,
          scope,
          eq(reservationTransitions.reservationId, reservationId),
        ),
      )
      .orderBy(asc(reservationTransitions.createdAt));
  }
}
