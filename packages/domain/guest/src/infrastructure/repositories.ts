import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type PropertyScope,
  propertyWhere,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import {
  guestIdentifiers,
  guests,
  reservationReferences,
  roomAssignments,
  stayPartyMembers,
  stays,
  type GuestIdentifierRow,
  type GuestRow,
  type ReservationReferenceRow,
  type RoomAssignmentRow,
  type StayPartyMemberRow,
  type StayRow,
} from './schema';

/** Repositories never accept a query on tenant data without a tenant/property scope (CLAUDE.md rule 1). */
@Injectable()
export class GuestRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  /** Serializes concurrent consumers working on the same reservation (transaction-scoped advisory lock). */
  async lockKey(key: string): Promise<void> {
    await this.x.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }

  // ---- guests ----
  async insertGuest(values: typeof guests.$inferInsert): Promise<GuestRow> {
    const [row] = await this.x.insert(guests).values(values).returning();
    return row!;
  }
  guest(scope: TenantScope, id: string): Promise<GuestRow | undefined> {
    return this.x
      .select()
      .from(guests)
      .where(tenantWhere(guests, scope, eq(guests.id, id)))
      .then((r) => r[0]);
  }
  guestsByIds(scope: TenantScope, ids: readonly string[]): Promise<GuestRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(guests)
      .where(tenantWhere(guests, scope, inArray(guests.id, [...ids])));
  }
  async updateGuest(
    scope: TenantScope,
    id: string,
    values: Partial<typeof guests.$inferInsert>,
  ): Promise<void> {
    await this.x
      .update(guests)
      .set({ ...values, version: sql`${guests.version} + 1` })
      .where(tenantWhere(guests, scope, eq(guests.id, id)));
  }
  /** Guests who have (had) a stay at the property, optionally filtered by name. */
  searchGuestsAtProperty(
    scope: PropertyScope,
    query: { q?: string; limit: number },
  ): Promise<GuestRow[]> {
    const pattern = query.q ? `%${query.q.replace(/[%_\\]/g, '\\$&')}%` : undefined;
    return this.x
      .selectDistinct({ guest: guests })
      .from(guests)
      .innerJoin(stayPartyMembers, eq(stayPartyMembers.guestId, guests.id))
      .innerJoin(stays, eq(stays.id, stayPartyMembers.stayId))
      .where(
        and(
          tenantWhere(guests, scope, eq(guests.status, 'ACTIVE')),
          propertyWhere(stays, scope),
          pattern
            ? or(ilike(guests.givenName, pattern), ilike(guests.familyName, pattern))
            : undefined,
        ),
      )
      .orderBy(asc(guests.familyName), asc(guests.givenName))
      .limit(query.limit)
      .then((r) => r.map((x) => x.guest));
  }

  // ---- identifiers ----
  async addIdentifier(values: typeof guestIdentifiers.$inferInsert): Promise<void> {
    await this.x.insert(guestIdentifiers).values(values).onConflictDoNothing();
  }
  identifiers(scope: TenantScope, guestId: string): Promise<GuestIdentifierRow[]> {
    return this.x
      .select()
      .from(guestIdentifiers)
      .where(tenantWhere(guestIdentifiers, scope, eq(guestIdentifiers.guestId, guestId)))
      .orderBy(asc(guestIdentifiers.kind));
  }

  // ---- stays ----
  async insertStay(values: typeof stays.$inferInsert): Promise<StayRow> {
    const [row] = await this.x.insert(stays).values(values).returning();
    return row!;
  }
  stay(scope: TenantScope, id: string): Promise<StayRow | undefined> {
    return this.x
      .select()
      .from(stays)
      .where(tenantWhere(stays, scope, eq(stays.id, id)))
      .then((r) => r[0]);
  }
  stayForUpdate(scope: TenantScope, id: string): Promise<StayRow | undefined> {
    return this.x
      .select()
      .from(stays)
      .where(tenantWhere(stays, scope, eq(stays.id, id)))
      .for('update')
      .then((r) => r[0]);
  }
  async updateStay(
    scope: TenantScope,
    id: string,
    values: Partial<typeof stays.$inferInsert>,
  ): Promise<StayRow> {
    const [row] = await this.x
      .update(stays)
      .set({ ...values, version: sql`${stays.version} + 1` })
      .where(tenantWhere(stays, scope, eq(stays.id, id)))
      .returning();
    return row!;
  }
  listStays(
    scope: PropertyScope,
    filter: { status?: StayRow['status']; limit: number },
  ): Promise<StayRow[]> {
    return this.x
      .select()
      .from(stays)
      .where(
        propertyWhere(stays, scope, filter.status ? eq(stays.status, filter.status) : undefined),
      )
      .orderBy(desc(stays.expectedArrival), desc(stays.id))
      .limit(filter.limit);
  }
  staysOfGuest(scope: PropertyScope, guestId: string): Promise<StayRow[]> {
    return this.x
      .select({ stay: stays })
      .from(stays)
      .innerJoin(stayPartyMembers, eq(stayPartyMembers.stayId, stays.id))
      .where(and(propertyWhere(stays, scope), eq(stayPartyMembers.guestId, guestId)))
      .orderBy(desc(stays.expectedArrival))
      .then((r) => r.map((x) => x.stay));
  }

  // ---- reservation references ----
  async upsertReservationReference(
    values: typeof reservationReferences.$inferInsert,
  ): Promise<void> {
    await this.x
      .insert(reservationReferences)
      .values(values)
      .onConflictDoUpdate({
        target: [reservationReferences.stayId, reservationReferences.integrationInstanceId],
        set: {
          confirmationNumber: sql`coalesce(excluded.confirmation_number, ${reservationReferences.confirmationNumber})`,
          lastEventType: values.lastEventType,
          lastEventAt: values.lastEventAt,
          updatedAt: new Date(),
        },
      });
  }
  reservationReferences(scope: TenantScope, stayId: string): Promise<ReservationReferenceRow[]> {
    return this.x
      .select()
      .from(reservationReferences)
      .where(tenantWhere(reservationReferences, scope, eq(reservationReferences.stayId, stayId)));
  }

  // ---- party ----
  activeParty(scope: TenantScope, stayId: string): Promise<StayPartyMemberRow[]> {
    return this.x
      .select()
      .from(stayPartyMembers)
      .where(
        tenantWhere(
          stayPartyMembers,
          scope,
          eq(stayPartyMembers.stayId, stayId),
          isNull(stayPartyMembers.leftAt),
        ),
      )
      .orderBy(asc(stayPartyMembers.joinedAt));
  }
  party(scope: TenantScope, stayId: string): Promise<StayPartyMemberRow[]> {
    return this.x
      .select()
      .from(stayPartyMembers)
      .where(tenantWhere(stayPartyMembers, scope, eq(stayPartyMembers.stayId, stayId)))
      .orderBy(asc(stayPartyMembers.joinedAt));
  }
  async addPartyMember(values: typeof stayPartyMembers.$inferInsert): Promise<void> {
    await this.x.insert(stayPartyMembers).values(values).onConflictDoNothing();
  }
  async closePartyMember(scope: TenantScope, id: string, at: Date): Promise<void> {
    await this.x
      .update(stayPartyMembers)
      .set({ leftAt: at })
      .where(tenantWhere(stayPartyMembers, scope, eq(stayPartyMembers.id, id)));
  }

  // ---- room assignments ----
  openAssignment(scope: TenantScope, stayId: string): Promise<RoomAssignmentRow | undefined> {
    return this.x
      .select()
      .from(roomAssignments)
      .where(
        tenantWhere(
          roomAssignments,
          scope,
          eq(roomAssignments.stayId, stayId),
          isNull(roomAssignments.unassignedAt),
        ),
      )
      .then((r) => r[0]);
  }
  assignments(scope: TenantScope, stayId: string): Promise<RoomAssignmentRow[]> {
    return this.x
      .select()
      .from(roomAssignments)
      .where(tenantWhere(roomAssignments, scope, eq(roomAssignments.stayId, stayId)))
      .orderBy(asc(roomAssignments.assignedAt), asc(roomAssignments.id));
  }
  async insertAssignment(values: typeof roomAssignments.$inferInsert): Promise<void> {
    await this.x.insert(roomAssignments).values(values);
  }
  async closeAssignment(scope: TenantScope, id: string, at: Date): Promise<void> {
    await this.x
      .update(roomAssignments)
      .set({ unassignedAt: at })
      .where(tenantWhere(roomAssignments, scope, eq(roomAssignments.id, id)));
  }
  /** In-house stay currently assigned to a room (several when the PMS shares a room between reservations). */
  inHouseStaysInRoom(scope: PropertyScope, roomId: string): Promise<StayRow[]> {
    return this.x
      .select({ stay: stays })
      .from(roomAssignments)
      .innerJoin(stays, eq(stays.id, roomAssignments.stayId))
      .where(
        and(
          propertyWhere(roomAssignments, scope),
          eq(roomAssignments.roomId, roomId),
          isNull(roomAssignments.unassignedAt),
          eq(stays.status, 'IN_HOUSE'),
        ),
      )
      .orderBy(asc(roomAssignments.assignedAt))
      .then((r) => r.map((x) => x.stay));
  }
}
