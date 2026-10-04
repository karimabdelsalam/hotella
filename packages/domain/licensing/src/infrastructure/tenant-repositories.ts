import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import {
  capabilities,
  type CapabilityRow,
  entitlementGrants,
  type EntitlementGrantRow,
  limitOverrides,
  type LimitOverrideRow,
  planVersionItems,
  type PlanVersionItemRow,
  planVersionLimits,
  type PlanVersionLimitRow,
  subscriptionHistory,
  type SubscriptionHistoryRow,
  subscriptionProperties,
  type SubscriptionRow,
  subscriptions,
} from './schema';

/** Tenant-owned licensing rows; every query carries the tenant (CLAUDE.md rule 1). */
@Injectable()
export class TenantLicenseRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- subscriptions ----
  async insertSubscription(values: typeof subscriptions.$inferInsert): Promise<SubscriptionRow> {
    const [row] = await this.x.insert(subscriptions).values(values).returning();
    return row!;
  }
  subscription(scope: TenantScope, id: string): Promise<SubscriptionRow | undefined> {
    return this.x
      .select()
      .from(subscriptions)
      .where(tenantWhere(subscriptions, scope, eq(subscriptions.id, id)))
      .then((r) => r[0]);
  }
  subscriptions(scope: TenantScope): Promise<SubscriptionRow[]> {
    return this.x
      .select()
      .from(subscriptions)
      .where(tenantWhere(subscriptions, scope))
      .orderBy(desc(subscriptions.startsAt));
  }
  async updateSubscription(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    set: Partial<
      Pick<
        SubscriptionRow,
        'status' | 'planVersionId' | 'scope' | 'endsAt' | 'graceDays' | 'externalRef'
      >
    >,
  ): Promise<SubscriptionRow | undefined> {
    const [row] = await this.x
      .update(subscriptions)
      .set({ ...set, version: sql`${subscriptions.version} + 1` })
      .where(
        tenantWhere(
          subscriptions,
          scope,
          eq(subscriptions.id, id),
          eq(subscriptions.version, expectedVersion),
        ),
      )
      .returning();
    return row;
  }
  subscriptionProperties(
    scope: TenantScope,
    subscriptionIds: readonly string[],
  ): Promise<Array<{ subscriptionId: string; propertyId: string }>> {
    if (subscriptionIds.length === 0) return Promise.resolve([]);
    return this.x
      .select({
        subscriptionId: subscriptionProperties.subscriptionId,
        propertyId: subscriptionProperties.propertyId,
      })
      .from(subscriptionProperties)
      .where(
        tenantWhere(
          subscriptionProperties,
          scope,
          inArray(subscriptionProperties.subscriptionId, [...subscriptionIds]),
        ),
      )
      .orderBy(asc(subscriptionProperties.propertyId));
  }
  /** Replaces the properties a PROPERTIES-scoped subscription covers. */
  async setSubscriptionProperties(
    scope: TenantScope,
    subscriptionId: string,
    propertyIds: readonly string[],
  ): Promise<void> {
    await this.x
      .delete(subscriptionProperties)
      .where(
        tenantWhere(
          subscriptionProperties,
          scope,
          eq(subscriptionProperties.subscriptionId, subscriptionId),
        ),
      );
    if (propertyIds.length)
      await this.x.insert(subscriptionProperties).values(
        [...new Set(propertyIds)].map((propertyId) => ({
          subscriptionId,
          tenantId: scope.tenantId,
          propertyId,
        })),
      );
  }
  async appendHistory(values: typeof subscriptionHistory.$inferInsert): Promise<void> {
    await this.x.insert(subscriptionHistory).values(values);
  }
  history(scope: TenantScope, subscriptionId: string): Promise<SubscriptionHistoryRow[]> {
    return this.x
      .select()
      .from(subscriptionHistory)
      .where(
        tenantWhere(
          subscriptionHistory,
          scope,
          eq(subscriptionHistory.subscriptionId, subscriptionId),
        ),
      )
      .orderBy(asc(subscriptionHistory.at), asc(subscriptionHistory.id));
  }

  // ---- plan content of versions (platform rows, read for a tenant's subscriptions) ----
  versionItems(versionIds: readonly string[]): Promise<PlanVersionItemRow[]> {
    if (versionIds.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(planVersionItems)
      .where(inArray(planVersionItems.planVersionId, [...versionIds]));
  }
  versionLimits(versionIds: readonly string[]): Promise<PlanVersionLimitRow[]> {
    if (versionIds.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(planVersionLimits)
      .where(inArray(planVersionLimits.planVersionId, [...versionIds]));
  }
  features(): Promise<CapabilityRow[]> {
    return this.x
      .select()
      .from(capabilities)
      .where(and(eq(capabilities.kind, 'FEATURE'), eq(capabilities.status, 'ACTIVE')));
  }

  // ---- grants ----
  async insertGrant(values: typeof entitlementGrants.$inferInsert): Promise<EntitlementGrantRow> {
    const [row] = await this.x.insert(entitlementGrants).values(values).returning();
    return row!;
  }
  grant(scope: TenantScope, id: string): Promise<EntitlementGrantRow | undefined> {
    return this.x
      .select()
      .from(entitlementGrants)
      .where(tenantWhere(entitlementGrants, scope, eq(entitlementGrants.id, id)))
      .then((r) => r[0]);
  }
  grants(scope: TenantScope): Promise<EntitlementGrantRow[]> {
    return this.x
      .select()
      .from(entitlementGrants)
      .where(tenantWhere(entitlementGrants, scope))
      .orderBy(desc(entitlementGrants.createdAt));
  }
  async revokeGrant(
    scope: TenantScope,
    id: string,
    by: string | null,
    reason: string,
  ): Promise<EntitlementGrantRow | undefined> {
    const [row] = await this.x
      .update(entitlementGrants)
      .set({
        revokedAt: new Date(),
        revokedById: by,
        revokeReason: reason,
        version: sql`${entitlementGrants.version} + 1`,
      })
      .where(
        tenantWhere(
          entitlementGrants,
          scope,
          eq(entitlementGrants.id, id),
          sql`${entitlementGrants.revokedAt} is null`,
        ),
      )
      .returning();
    return row;
  }

  // ---- limit overrides ----
  async insertOverride(values: typeof limitOverrides.$inferInsert): Promise<LimitOverrideRow> {
    const [row] = await this.x.insert(limitOverrides).values(values).returning();
    return row!;
  }
  overrides(scope: TenantScope): Promise<LimitOverrideRow[]> {
    return this.x
      .select()
      .from(limitOverrides)
      .where(tenantWhere(limitOverrides, scope))
      .orderBy(desc(limitOverrides.createdAt));
  }
  async revokeOverride(
    scope: TenantScope,
    id: string,
    by: string | null,
  ): Promise<LimitOverrideRow | undefined> {
    const [row] = await this.x
      .update(limitOverrides)
      .set({ revokedAt: new Date(), revokedById: by, version: sql`${limitOverrides.version} + 1` })
      .where(
        tenantWhere(
          limitOverrides,
          scope,
          eq(limitOverrides.id, id),
          sql`${limitOverrides.revokedAt} is null`,
        ),
      )
      .returning();
    return row;
  }
}
