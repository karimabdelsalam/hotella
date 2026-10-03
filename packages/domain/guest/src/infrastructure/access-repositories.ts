import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
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
  guestAccessGrantEvents,
  guestAccessGrants,
  guestSessions,
  type GuestAccessGrantEventRow,
  type GuestAccessGrantRow,
  type GuestSessionRow,
} from './schema';

/** Grants and guest sessions (Spec §19.3, §21). Every query is tenant-scoped except the token lookup. */
@Injectable()
export class AccessRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- grants ----
  async insertGrant(values: typeof guestAccessGrants.$inferInsert): Promise<GuestAccessGrantRow> {
    const [row] = await this.x.insert(guestAccessGrants).values(values).returning();
    return row!;
  }
  grant(scope: TenantScope, id: string): Promise<GuestAccessGrantRow | undefined> {
    return this.x
      .select()
      .from(guestAccessGrants)
      .where(tenantWhere(guestAccessGrants, scope, eq(guestAccessGrants.id, id)))
      .then((r) => r[0]);
  }
  /** Locks the grant row for a change of scopes or revocation. */
  grantForUpdate(scope: TenantScope, id: string): Promise<GuestAccessGrantRow | undefined> {
    return this.x
      .select()
      .from(guestAccessGrants)
      .where(tenantWhere(guestAccessGrants, scope, eq(guestAccessGrants.id, id)))
      .for('update')
      .then((r) => r[0]);
  }
  /** Unrevoked grants of a stay (the projector follows the stay with them). */
  liveGrantsOfStay(scope: TenantScope, stayId: string): Promise<GuestAccessGrantRow[]> {
    return this.x
      .select()
      .from(guestAccessGrants)
      .where(
        tenantWhere(
          guestAccessGrants,
          scope,
          eq(guestAccessGrants.stayId, stayId),
          isNull(guestAccessGrants.revokedAt),
        ),
      )
      .orderBy(guestAccessGrants.id)
      .for('update');
  }
  /** The guest's unrevoked, unexpired grant for a stay, if any (one is reused for every device). */
  liveGrant(
    scope: TenantScope,
    stayId: string,
    guestId: string,
    now: Date,
  ): Promise<GuestAccessGrantRow | undefined> {
    return this.x
      .select()
      .from(guestAccessGrants)
      .where(
        tenantWhere(
          guestAccessGrants,
          scope,
          eq(guestAccessGrants.stayId, stayId),
          eq(guestAccessGrants.guestId, guestId),
          isNull(guestAccessGrants.revokedAt),
          gt(guestAccessGrants.validUntil, now),
        ),
      )
      .orderBy(desc(guestAccessGrants.id))
      .limit(1)
      .then((r) => r[0]);
  }
  /** The guest's most recent live grant at a property (messaging routes a verified phone with it). */
  latestLiveGrantAtProperty(
    scope: PropertyScope,
    guestId: string,
    now: Date,
  ): Promise<GuestAccessGrantRow | undefined> {
    return this.x
      .select()
      .from(guestAccessGrants)
      .where(
        propertyWhere(
          guestAccessGrants,
          scope,
          eq(guestAccessGrants.guestId, guestId),
          isNull(guestAccessGrants.revokedAt),
          gt(guestAccessGrants.validUntil, now),
        ),
      )
      .orderBy(desc(guestAccessGrants.validFrom), desc(guestAccessGrants.id))
      .limit(1)
      .then((r) => r[0]);
  }
  grantsOfStay(scope: PropertyScope, stayId: string): Promise<GuestAccessGrantRow[]> {
    return this.x
      .select()
      .from(guestAccessGrants)
      .where(propertyWhere(guestAccessGrants, scope, eq(guestAccessGrants.stayId, stayId)))
      .orderBy(guestAccessGrants.id);
  }
  liveGrantsOfGuest(scope: TenantScope, guestId: string): Promise<GuestAccessGrantRow[]> {
    return this.x
      .select()
      .from(guestAccessGrants)
      .where(
        tenantWhere(
          guestAccessGrants,
          scope,
          eq(guestAccessGrants.guestId, guestId),
          isNull(guestAccessGrants.revokedAt),
        ),
      )
      .for('update');
  }
  async updateGrant(
    scope: TenantScope,
    id: string,
    values: Partial<typeof guestAccessGrants.$inferInsert>,
  ): Promise<GuestAccessGrantRow> {
    const [row] = await this.x
      .update(guestAccessGrants)
      .set({ ...values, version: sql`${guestAccessGrants.version} + 1` })
      .where(tenantWhere(guestAccessGrants, scope, eq(guestAccessGrants.id, id)))
      .returning();
    return row!;
  }
  async insertGrantEvent(values: typeof guestAccessGrantEvents.$inferInsert): Promise<void> {
    await this.x.insert(guestAccessGrantEvents).values(values);
  }
  grantEvents(scope: TenantScope, grantId: string): Promise<GuestAccessGrantEventRow[]> {
    return this.x
      .select()
      .from(guestAccessGrantEvents)
      .where(
        tenantWhere(guestAccessGrantEvents, scope, eq(guestAccessGrantEvents.grantId, grantId)),
      )
      .orderBy(guestAccessGrantEvents.id); // recording order (UUIDv7); `at` is when the fact happened
  }

  // ---- sessions ----
  async insertSession(values: typeof guestSessions.$inferInsert): Promise<GuestSessionRow> {
    const [row] = await this.x.insert(guestSessions).values(values).returning();
    return row!;
  }
  /** Platform-level lookup: the token is the credential (256-bit, hashed at rest). */
  sessionByTokenHash(
    hash: string,
  ): Promise<{ session: GuestSessionRow; grant: GuestAccessGrantRow } | undefined> {
    return this.x
      .select({ session: guestSessions, grant: guestAccessGrants })
      .from(guestSessions)
      .innerJoin(guestAccessGrants, eq(guestAccessGrants.id, guestSessions.grantId))
      .where(eq(guestSessions.sessionTokenHash, hash))
      .then((r) => r[0]);
  }
  session(scope: TenantScope, id: string): Promise<GuestSessionRow | undefined> {
    return this.x
      .select()
      .from(guestSessions)
      .where(tenantWhere(guestSessions, scope, eq(guestSessions.id, id)))
      .then((r) => r[0]);
  }
  async touchSession(scope: TenantScope, id: string, now: Date, expiresAt: Date): Promise<void> {
    await this.x
      .update(guestSessions)
      .set({ lastSeenAt: now, expiresAt })
      .where(tenantWhere(guestSessions, scope, eq(guestSessions.id, id)));
  }
  /** Revokes the live sessions of a grant; returns how many ended. */
  async revokeSessionsOfGrant(
    scope: TenantScope,
    grantId: string,
    reason: string,
    at: Date,
  ): Promise<number> {
    const rows = await this.x
      .update(guestSessions)
      .set({ revokedAt: at, revokeReason: reason })
      .where(
        tenantWhere(
          guestSessions,
          scope,
          eq(guestSessions.grantId, grantId),
          isNull(guestSessions.revokedAt),
        ),
      )
      .returning({ id: guestSessions.id });
    return rows.length;
  }
  /** Caps the expiry of a grant's live sessions (a narrowed grant ends sooner). */
  async capSessionsOfGrant(scope: TenantScope, grantId: string, until: Date): Promise<void> {
    await this.x
      .update(guestSessions)
      .set({ expiresAt: sql`least(${guestSessions.expiresAt}, ${until})` })
      .where(
        tenantWhere(
          guestSessions,
          scope,
          eq(guestSessions.grantId, grantId),
          isNull(guestSessions.revokedAt),
        ),
      );
  }
  async revokeSession(scope: TenantScope, id: string, reason: string, at: Date): Promise<boolean> {
    const rows = await this.x
      .update(guestSessions)
      .set({ revokedAt: at, revokeReason: reason })
      .where(
        and(
          tenantWhere(guestSessions, scope, eq(guestSessions.id, id)),
          isNull(guestSessions.revokedAt),
        ),
      )
      .returning({ id: guestSessions.id });
    return rows.length === 1;
  }
  /** Anonymization: device descriptions are personal data. */
  async clearDeviceInfoOfGrant(scope: TenantScope, grantId: string): Promise<void> {
    await this.x
      .update(guestSessions)
      .set({ deviceInfo: null })
      .where(tenantWhere(guestSessions, scope, eq(guestSessions.grantId, grantId)));
  }
}
