import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import {
  agentLinks,
  enrollmentTokens,
  integrationCommands,
  type AgentLinkRow,
  type EnrollmentTokenRow,
  type IntegrationCommandRow,
} from './schema';

/** Persistence of the agent link (ADR-0017): enrollment tokens, device certificates, sequence state, commands. */
@Injectable()
export class LinkRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- enrollment tokens ----
  async insertToken(values: typeof enrollmentTokens.$inferInsert): Promise<EnrollmentTokenRow> {
    const [row] = await this.x.insert(enrollmentTokens).values(values).returning();
    return row!;
  }
  /** Platform-level lookup: the token itself is the credential (single use, hashed at rest). */
  tokenByHash(hash: string): Promise<EnrollmentTokenRow | undefined> {
    return this.x
      .select()
      .from(enrollmentTokens)
      .where(eq(enrollmentTokens.tokenHash, hash))
      .then((r) => r[0]);
  }
  /** Marks a token used; false when another request used it first (atomic single use). */
  async consumeToken(scope: TenantScope, id: string): Promise<boolean> {
    const rows = await this.x
      .update(enrollmentTokens)
      .set({ usedAt: new Date() })
      .where(
        tenantWhere(
          enrollmentTokens,
          scope,
          eq(enrollmentTokens.id, id),
          isNull(enrollmentTokens.usedAt),
        ),
      )
      .returning({ id: enrollmentTokens.id });
    return rows.length === 1;
  }

  // ---- agent links ----
  link(scope: TenantScope, instanceId: string): Promise<AgentLinkRow | undefined> {
    return this.x
      .select()
      .from(agentLinks)
      .where(tenantWhere(agentLinks, scope, eq(agentLinks.instanceId, instanceId)))
      .then((r) => r[0]);
  }
  /** Platform-level lookup by the presented client certificate (mutual TLS identity). */
  linkByFingerprint(fingerprint: string): Promise<AgentLinkRow | undefined> {
    return this.x
      .select()
      .from(agentLinks)
      .where(eq(agentLinks.certFingerprint, fingerprint))
      .then((r) => r[0]);
  }
  async upsertLink(values: typeof agentLinks.$inferInsert): Promise<AgentLinkRow> {
    const { instanceId: _id, tenantId: _t, propertyId: _p, ...set } = values;
    const [row] = await this.x
      .insert(agentLinks)
      .values(values)
      .onConflictDoUpdate({
        target: agentLinks.instanceId,
        set: { ...set, updatedAt: new Date(), version: sql`${agentLinks.version} + 1` },
      })
      .returning();
    return row!;
  }
  async updateLink(
    scope: TenantScope,
    instanceId: string,
    values: Partial<typeof agentLinks.$inferInsert>,
  ): Promise<AgentLinkRow | undefined> {
    const [row] = await this.x
      .update(agentLinks)
      .set({ ...values, updatedAt: new Date(), version: sql`${agentLinks.version} + 1` })
      .where(tenantWhere(agentLinks, scope, eq(agentLinks.instanceId, instanceId)))
      .returning();
    return row;
  }
  /** Advances the cumulative acknowledgement from `from` to `to`; false if another writer moved it. */
  async advanceSequence(
    scope: TenantScope,
    instanceId: string,
    from: number,
    to: number,
  ): Promise<boolean> {
    const rows = await this.x
      .update(agentLinks)
      .set({ lastSequenceNo: to, updatedAt: new Date() })
      .where(
        tenantWhere(
          agentLinks,
          scope,
          eq(agentLinks.instanceId, instanceId),
          eq(agentLinks.lastSequenceNo, from),
        ),
      )
      .returning({ id: agentLinks.instanceId });
    return rows.length === 1;
  }

  // ---- commands ----
  /** Pending commands to deliver now, oldest first; expired ones are skipped (and expired by `expireCommands`). */
  deliverable(
    scope: TenantScope,
    instanceId: string,
    limit = 20,
  ): Promise<IntegrationCommandRow[]> {
    return this.x
      .select()
      .from(integrationCommands)
      .where(
        tenantWhere(
          integrationCommands,
          scope,
          eq(integrationCommands.instanceId, instanceId),
          eq(integrationCommands.status, 'PENDING'),
          or(isNull(integrationCommands.expiresAt), sql`${integrationCommands.expiresAt} > now()`),
        ),
      )
      .orderBy(asc(integrationCommands.createdAt))
      .limit(limit);
  }
  async markCommands(
    scope: TenantScope,
    ids: readonly string[],
    values: Partial<typeof integrationCommands.$inferInsert>,
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.x
      .update(integrationCommands)
      .set({ ...values, version: sql`${integrationCommands.version} + 1` })
      .where(tenantWhere(integrationCommands, scope, inArray(integrationCommands.id, [...ids])));
  }
  async markSent(scope: TenantScope, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.x
      .update(integrationCommands)
      .set({
        status: 'SENT',
        sentAt: new Date(),
        attempts: sql`${integrationCommands.attempts} + 1`,
        version: sql`${integrationCommands.version} + 1`,
      })
      .where(tenantWhere(integrationCommands, scope, inArray(integrationCommands.id, [...ids])));
  }
  command(scope: TenantScope, id: string): Promise<IntegrationCommandRow | undefined> {
    return this.x
      .select()
      .from(integrationCommands)
      .where(tenantWhere(integrationCommands, scope, eq(integrationCommands.id, id)))
      .then((r) => r[0]);
  }
  /** Commands sent but never answered return to PENDING after a reconnect (at-least-once; agent dedups by id). */
  async requeueSent(scope: TenantScope, instanceId: string): Promise<void> {
    await this.x
      .update(integrationCommands)
      .set({ status: 'PENDING' })
      .where(
        tenantWhere(
          integrationCommands,
          scope,
          eq(integrationCommands.instanceId, instanceId),
          eq(integrationCommands.status, 'SENT'),
        ),
      );
  }
  async expireCommands(scope: TenantScope, instanceId: string): Promise<IntegrationCommandRow[]> {
    return this.x
      .update(integrationCommands)
      .set({ status: 'EXPIRED', error: 'expired before acknowledgement' })
      .where(
        tenantWhere(
          integrationCommands,
          scope,
          eq(integrationCommands.instanceId, instanceId),
          inArray(integrationCommands.status, ['PENDING', 'SENT']),
          lt(integrationCommands.expiresAt, new Date()),
        ),
      )
      .returning();
  }
}
