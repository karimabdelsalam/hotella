import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, gte, isNull, sql } from 'drizzle-orm';
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
  activationTokens,
  roomQrCodes,
  verificationDeliveries,
  verificationSessions,
  type ActivationTokenRow,
  type RoomQrCodeRow,
  type VerificationDeliveryRow,
  type VerificationSessionRow,
} from './schema';

/**
 * Activation tokens, verification sessions and deliveries, room QR codes. Lookups by token or handle hash are
 * platform-level (the secret is the credential); everything else is tenant-scoped.
 */
@Injectable()
export class ActivationRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- activation tokens ----
  async insertToken(values: typeof activationTokens.$inferInsert): Promise<ActivationTokenRow> {
    const [row] = await this.x.insert(activationTokens).values(values).returning();
    return row!;
  }
  tokenByHash(hash: string): Promise<ActivationTokenRow | undefined> {
    return this.x
      .select()
      .from(activationTokens)
      .where(eq(activationTokens.tokenHash, hash))
      .then((r) => r[0]);
  }
  token(scope: TenantScope, id: string): Promise<ActivationTokenRow | undefined> {
    return this.x
      .select()
      .from(activationTokens)
      .where(tenantWhere(activationTokens, scope, eq(activationTokens.id, id)))
      .then((r) => r[0]);
  }
  tokensOfStay(scope: PropertyScope, stayId: string): Promise<ActivationTokenRow[]> {
    return this.x
      .select()
      .from(activationTokens)
      .where(propertyWhere(activationTokens, scope, eq(activationTokens.stayId, stayId)))
      .orderBy(desc(activationTokens.id));
  }
  /** Revokes the open tokens of a stay for the same guest (or the same "anyone" token). */
  async revokeOpenTokens(
    scope: TenantScope,
    stayId: string,
    guestId: string | null,
    at: Date,
  ): Promise<number> {
    const rows = await this.x
      .update(activationTokens)
      .set({ revokedAt: at, updatedAt: at })
      .where(
        tenantWhere(
          activationTokens,
          scope,
          eq(activationTokens.stayId, stayId),
          guestId ? eq(activationTokens.guestId, guestId) : isNull(activationTokens.guestId),
          isNull(activationTokens.usedAt),
          isNull(activationTokens.revokedAt),
        ),
      )
      .returning({ id: activationTokens.id });
    return rows.length;
  }
  async revokeToken(scope: PropertyScope, id: string, at: Date): Promise<boolean> {
    const rows = await this.x
      .update(activationTokens)
      .set({ revokedAt: at, updatedAt: at })
      .where(
        propertyWhere(
          activationTokens,
          scope,
          eq(activationTokens.id, id),
          isNull(activationTokens.usedAt),
          isNull(activationTokens.revokedAt),
        ),
      )
      .returning({ id: activationTokens.id });
    return rows.length === 1;
  }
  /** Single use: false when another request consumed (or someone revoked) it first. */
  async consumeToken(scope: TenantScope, id: string, at: Date): Promise<boolean> {
    const rows = await this.x
      .update(activationTokens)
      .set({ usedAt: at, updatedAt: at })
      .where(
        tenantWhere(
          activationTokens,
          scope,
          eq(activationTokens.id, id),
          isNull(activationTokens.usedAt),
          isNull(activationTokens.revokedAt),
          gt(activationTokens.expiresAt, at),
        ),
      )
      .returning({ id: activationTokens.id });
    return rows.length === 1;
  }

  // ---- verification sessions ----
  async insertSession(
    values: typeof verificationSessions.$inferInsert,
  ): Promise<VerificationSessionRow> {
    const [row] = await this.x.insert(verificationSessions).values(values).returning();
    return row!;
  }
  /** The guest device's handle: platform-level, locked for the attempt that follows. */
  sessionByHandleForUpdate(hash: string): Promise<VerificationSessionRow | undefined> {
    return this.x
      .select()
      .from(verificationSessions)
      .where(eq(verificationSessions.handleHash, hash))
      .for('update')
      .then((r) => r[0]);
  }
  sessionForUpdate(scope: TenantScope, id: string): Promise<VerificationSessionRow | undefined> {
    return this.x
      .select()
      .from(verificationSessions)
      .where(tenantWhere(verificationSessions, scope, eq(verificationSessions.id, id)))
      .for('update')
      .then((r) => r[0]);
  }
  async updateSession(
    scope: TenantScope,
    id: string,
    values: Partial<typeof verificationSessions.$inferInsert>,
  ): Promise<VerificationSessionRow> {
    const [row] = await this.x
      .update(verificationSessions)
      .set({ ...values, version: sql`${verificationSessions.version} + 1`, updatedAt: new Date() })
      .where(tenantWhere(verificationSessions, scope, eq(verificationSessions.id, id)))
      .returning();
    return row!;
  }
  /** Sessions a phone number opened since a time (per-phone limit, all properties of the tenant). */
  async phoneSessionsSince(scope: TenantScope, phone: string, since: Date): Promise<number> {
    const [row] = await this.x
      .select({ n: sql<number>`count(*)::int` })
      .from(verificationSessions)
      .where(
        tenantWhere(
          verificationSessions,
          scope,
          eq(verificationSessions.phoneNormalized, phone),
          gte(verificationSessions.createdAt, since),
        ),
      );
    return row?.n ?? 0;
  }
  /** Open sessions at a property with this reference (staff-assisted verification). */
  openSessionsByReference(
    scope: PropertyScope,
    reference: string,
    now: Date,
  ): Promise<VerificationSessionRow[]> {
    return this.x
      .select()
      .from(verificationSessions)
      .where(
        propertyWhere(
          verificationSessions,
          scope,
          eq(verificationSessions.reference, reference),
          isNull(verificationSessions.verifiedAt),
          isNull(verificationSessions.lockedAt),
          gt(verificationSessions.expiresAt, now),
        ),
      )
      .orderBy(desc(verificationSessions.id));
  }
  /** Open sessions across tenants for the fallback sweep (claimed one by one with SKIP LOCKED). */
  openSessionIds(now: Date, limit: number): Promise<Array<{ id: string; tenantId: string }>> {
    return this.x
      .select({ id: verificationSessions.id, tenantId: verificationSessions.tenantId })
      .from(verificationSessions)
      .where(
        and(
          isNull(verificationSessions.verifiedAt),
          isNull(verificationSessions.lockedAt),
          gt(verificationSessions.expiresAt, now),
        ),
      )
      .orderBy(asc(verificationSessions.expiresAt))
      .limit(limit);
  }
  claimOpenSession(scope: TenantScope, id: string): Promise<VerificationSessionRow | undefined> {
    return this.x
      .select()
      .from(verificationSessions)
      .where(tenantWhere(verificationSessions, scope, eq(verificationSessions.id, id)))
      .for('update', { skipLocked: true })
      .then((r) => r[0]);
  }

  // ---- deliveries ----
  async insertDelivery(
    values: typeof verificationDeliveries.$inferInsert,
  ): Promise<VerificationDeliveryRow> {
    const [row] = await this.x.insert(verificationDeliveries).values(values).returning();
    return row!;
  }
  deliveriesOf(scope: TenantScope, sessionId: string): Promise<VerificationDeliveryRow[]> {
    return this.x
      .select()
      .from(verificationDeliveries)
      .where(
        tenantWhere(verificationDeliveries, scope, eq(verificationDeliveries.sessionId, sessionId)),
      )
      .orderBy(asc(verificationDeliveries.id));
  }
  /** A provider receipt for an OTP message; statuses only move forward. */
  async updateDeliveryStatus(
    scope: TenantScope,
    channelId: string,
    providerRef: string,
    status: VerificationDeliveryRow['status'],
    at: Date,
    errorCode: string | null,
  ): Promise<VerificationDeliveryRow | undefined> {
    const rank = sql`case ${verificationDeliveries.status} when 'SENT' then 0 when 'DELIVERED' then 1 when 'READ' then 2 else 3 end`;
    const next = { SENT: 0, DELIVERED: 1, READ: 2, FAILED: 3 }[status];
    const [row] = await this.x
      .update(verificationDeliveries)
      .set({ status, statusAt: at, errorCode, updatedAt: new Date() })
      .where(
        tenantWhere(
          verificationDeliveries,
          scope,
          eq(verificationDeliveries.channelId, channelId),
          eq(verificationDeliveries.providerRef, providerRef),
          sql`${rank} < ${next}`,
        ),
      )
      .returning();
    return row;
  }

  // ---- room QR codes ----
  async insertQr(values: typeof roomQrCodes.$inferInsert): Promise<RoomQrCodeRow> {
    const [row] = await this.x.insert(roomQrCodes).values(values).returning();
    return row!;
  }
  qrByHash(hash: string): Promise<RoomQrCodeRow | undefined> {
    return this.x
      .select()
      .from(roomQrCodes)
      .where(eq(roomQrCodes.tokenHash, hash))
      .then((r) => r[0]);
  }
  activeQrForRoom(scope: PropertyScope, roomId: string): Promise<RoomQrCodeRow | undefined> {
    return this.x
      .select()
      .from(roomQrCodes)
      .where(
        propertyWhere(
          roomQrCodes,
          scope,
          eq(roomQrCodes.roomId, roomId),
          eq(roomQrCodes.status, 'ACTIVE'),
        ),
      )
      .for('update')
      .then((r) => r[0]);
  }
  async setQrStatus(
    scope: TenantScope,
    id: string,
    status: RoomQrCodeRow['status'],
    at: Date,
  ): Promise<void> {
    await this.x
      .update(roomQrCodes)
      .set({ status, statusChangedAt: at, updatedAt: at })
      .where(tenantWhere(roomQrCodes, scope, eq(roomQrCodes.id, id)));
  }
  listQr(scope: PropertyScope): Promise<RoomQrCodeRow[]> {
    return this.x
      .select()
      .from(roomQrCodes)
      .where(propertyWhere(roomQrCodes, scope))
      .orderBy(asc(roomQrCodes.roomId), desc(roomQrCodes.id));
  }
}
