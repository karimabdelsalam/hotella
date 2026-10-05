import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import { type InstallationRow, installations, type SiteBundleRow, siteBundles } from './schema';

/** Site installations (central) and the accepted bundle (site) — ADR-0021. */
@Injectable()
export class InstallationRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  async insert(values: typeof installations.$inferInsert): Promise<InstallationRow> {
    const [row] = await this.x.insert(installations).values(values).returning();
    return row!;
  }
  list(scope: TenantScope): Promise<InstallationRow[]> {
    return this.x
      .select()
      .from(installations)
      .where(tenantWhere(installations, scope))
      .orderBy(asc(installations.createdAt));
  }
  get(scope: TenantScope, id: string): Promise<InstallationRow | undefined> {
    return this.x
      .select()
      .from(installations)
      .where(tenantWhere(installations, scope, eq(installations.id, id)))
      .then((r) => r[0]);
  }
  /**
   * The installation asking for its bundle, before any tenant is known: the request is authenticated by the
   * installation's own signature, checked right after this lookup (as the enrollment token lookup in `integration`).
   */
  byId(id: string): Promise<InstallationRow | undefined> {
    return this.x
      .select()
      .from(installations)
      .where(eq(installations.id, id))
      .then((r) => r[0]);
  }
  async revoke(
    scope: TenantScope,
    id: string,
    reason: string,
  ): Promise<InstallationRow | undefined> {
    const [row] = await this.x
      .update(installations)
      .set({
        status: 'REVOKED',
        revokedAt: new Date(),
        revokeReason: reason,
        updatedAt: new Date(),
        version: sql`${installations.version} + 1`,
      })
      .where(
        tenantWhere(
          installations,
          scope,
          and(eq(installations.id, id), eq(installations.status, 'ACTIVE')),
        ),
      )
      .returning();
    return row;
  }
  async issued(scope: TenantScope, id: string, at: Date): Promise<void> {
    await this.x
      .update(installations)
      .set({ lastSeenAt: at, lastIssuedAt: at, updatedAt: at })
      .where(tenantWhere(installations, scope, eq(installations.id, id)));
  }

  // ---- site side ----
  siteBundle(installationId: string): Promise<SiteBundleRow | undefined> {
    return this.x
      .select()
      .from(siteBundles)
      .where(eq(siteBundles.installationId, installationId))
      .then((r) => r[0]);
  }
  async saveSiteBundle(values: SiteBundleRow): Promise<void> {
    await this.x
      .insert(siteBundles)
      .values(values)
      .onConflictDoUpdate({
        target: siteBundles.installationId,
        set: {
          tenantId: values.tenantId,
          token: values.token,
          issuedAt: values.issuedAt,
          validUntil: values.validUntil,
          graceUntil: values.graceUntil,
          acceptedAt: values.acceptedAt,
        },
      });
  }
}
