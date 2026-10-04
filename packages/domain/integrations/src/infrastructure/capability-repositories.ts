import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
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
  integrationHealth,
  integrationInstances,
  propertyCapabilities,
  propertyCapabilityHistory,
  propertyCapabilityStates,
  routingOverrides,
  type IntegrationHealthRow,
  type PropertyCapabilityRow,
  type PropertyCapabilityStateRow,
  type RoutingOverrideRow,
} from './schema';

/** The per-property capability registry (ADR-0019, BUILD_PLAN 10.6). Always tenant/property scoped (rule 1). */
@Injectable()
export class CapabilityRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  healthOf(scope: PropertyScope): Promise<IntegrationHealthRow[]> {
    return this.x.select().from(integrationHealth).where(propertyWhere(integrationHealth, scope));
  }

  verifications(scope: PropertyScope): Promise<PropertyCapabilityRow[]> {
    return this.x
      .select()
      .from(propertyCapabilities)
      .where(propertyWhere(propertyCapabilities, scope));
  }
  verification(
    scope: PropertyScope,
    instanceId: string,
    capability: string,
  ): Promise<PropertyCapabilityRow | undefined> {
    return this.x
      .select()
      .from(propertyCapabilities)
      .where(
        propertyWhere(
          propertyCapabilities,
          scope,
          eq(propertyCapabilities.instanceId, instanceId),
          eq(propertyCapabilities.capability, capability),
        ),
      )
      .for('update')
      .then((r) => r[0]);
  }
  async upsertVerification(values: {
    readonly id: string;
    readonly tenantId: string;
    readonly propertyId: string;
    readonly instanceId: string;
    readonly connectorCode: string;
    readonly capability: string;
    readonly verifiedAt: Date | null;
    readonly verifiedBy: string | null;
    readonly verificationRef: string | null;
  }): Promise<PropertyCapabilityRow> {
    const [row] = await this.x
      .insert(propertyCapabilities)
      .values(values)
      .onConflictDoUpdate({
        target: [propertyCapabilities.instanceId, propertyCapabilities.capability],
        set: {
          verifiedAt: values.verifiedAt,
          verifiedBy: values.verifiedBy,
          verificationRef: values.verificationRef,
          version: sql`${propertyCapabilities.version} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row!;
  }

  async history(values: typeof propertyCapabilityHistory.$inferInsert): Promise<void> {
    await this.x.insert(propertyCapabilityHistory).values(values);
  }
  historyOf(scope: PropertyScope, limit: number) {
    return this.x
      .select()
      .from(propertyCapabilityHistory)
      .where(propertyWhere(propertyCapabilityHistory, scope))
      .orderBy(desc(propertyCapabilityHistory.at), desc(propertyCapabilityHistory.id))
      .limit(limit);
  }

  overrides(scope: PropertyScope): Promise<RoutingOverrideRow[]> {
    return this.x
      .select()
      .from(routingOverrides)
      .where(propertyWhere(routingOverrides, scope))
      .orderBy(asc(routingOverrides.operation));
  }
  async setOverride(values: {
    readonly id: string;
    readonly tenantId: string;
    readonly propertyId: string;
    readonly operation: string;
    readonly connectors: string[];
    readonly updatedBy: string | null;
  }): Promise<RoutingOverrideRow> {
    const [row] = await this.x
      .insert(routingOverrides)
      .values(values)
      .onConflictDoUpdate({
        target: [routingOverrides.propertyId, routingOverrides.operation],
        set: {
          connectors: values.connectors,
          updatedBy: values.updatedBy,
          version: sql`${routingOverrides.version} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row!;
  }
  async clearOverride(scope: PropertyScope, operation: string): Promise<boolean> {
    const rows = await this.x
      .delete(routingOverrides)
      .where(propertyWhere(routingOverrides, scope, eq(routingOverrides.operation, operation)))
      .returning({ id: routingOverrides.id });
    return rows.length > 0;
  }

  states(scope: PropertyScope): Promise<PropertyCapabilityStateRow[]> {
    return this.x
      .select()
      .from(propertyCapabilityStates)
      .where(propertyWhere(propertyCapabilityStates, scope))
      .for('update');
  }
  async saveState(values: typeof propertyCapabilityStates.$inferInsert): Promise<void> {
    await this.x
      .insert(propertyCapabilityStates)
      .values(values)
      .onConflictDoUpdate({
        target: [propertyCapabilityStates.propertyId, propertyCapabilityStates.capability],
        set: { effective: values.effective, connectors: values.connectors, changedAt: new Date() },
      });
  }

  /** Properties of a tenant that have integrations, for a tenant-wide refresh (licence changes). */
  async propertiesWithInstances(scope: TenantScope, propertyId: string | null): Promise<string[]> {
    const rows = await this.x
      .selectDistinct({ propertyId: integrationInstances.propertyId })
      .from(integrationInstances)
      .where(
        tenantWhere(
          integrationInstances,
          scope,
          propertyId ? eq(integrationInstances.propertyId, propertyId) : undefined,
        ),
      );
    return rows.map((r) => r.propertyId);
  }

  async commission(
    scope: PropertyScope,
    instanceIds: readonly string[],
    by: string | null,
    at: Date,
  ): Promise<number> {
    if (instanceIds.length === 0) return 0;
    const rows = await this.x
      .update(integrationInstances)
      .set({
        commissionedAt: at,
        commissionedBy: by,
        updatedAt: at,
        version: sql`${integrationInstances.version} + 1`,
      })
      .where(
        propertyWhere(
          integrationInstances,
          scope,
          inArray(integrationInstances.id, [...instanceIds]),
          and(sql`${integrationInstances.commissionedAt} is null`),
        ),
      )
      .returning({ id: integrationInstances.id });
    return rows.length;
  }
}
