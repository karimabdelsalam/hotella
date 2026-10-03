import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import {
  type ModelRow,
  modelCalls,
  models,
  type ProviderRow,
  providers,
  type RoutingRuleRow,
  routingRules,
} from './schema';

@Injectable()
export class AiRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- providers and models (platform configuration) ----
  async insertProvider(values: typeof providers.$inferInsert): Promise<ProviderRow> {
    const [row] = await this.x.insert(providers).values(values).returning();
    return row!;
  }
  provider(id: string): Promise<ProviderRow | undefined> {
    return this.x
      .select()
      .from(providers)
      .where(eq(providers.id, id))
      .then((r) => r[0]);
  }
  listProviders(): Promise<ProviderRow[]> {
    return this.x.select().from(providers).orderBy(asc(providers.code));
  }
  async updateProvider(
    id: string,
    version: number,
    values: Partial<typeof providers.$inferInsert>,
  ): Promise<ProviderRow | undefined> {
    const [row] = await this.x
      .update(providers)
      .set({ ...values, version: sql`${providers.version} + 1` })
      .where(and(eq(providers.id, id), eq(providers.version, version)))
      .returning();
    return row;
  }
  async insertModel(values: typeof models.$inferInsert): Promise<ModelRow> {
    const [row] = await this.x.insert(models).values(values).returning();
    return row!;
  }
  model(id: string): Promise<ModelRow | undefined> {
    return this.x
      .select()
      .from(models)
      .where(eq(models.id, id))
      .then((r) => r[0]);
  }
  listModels(): Promise<ModelRow[]> {
    return this.x.select().from(models).orderBy(asc(models.code));
  }
  modelsWithProviders(ids: readonly string[]) {
    if (ids.length === 0) return Promise.resolve([]);
    return this.x
      .select({ model: models, provider: providers })
      .from(models)
      .innerJoin(providers, eq(providers.id, models.providerId))
      .where(inArray(models.id, [...ids]));
  }
  async updateModel(
    id: string,
    version: number,
    values: Partial<typeof models.$inferInsert>,
  ): Promise<ModelRow | undefined> {
    const [row] = await this.x
      .update(models)
      .set({ ...values, version: sql`${models.version} + 1` })
      .where(and(eq(models.id, id), eq(models.version, version)))
      .returning();
    return row;
  }

  // ---- routing ----
  /** Rules that may apply to a tenant (and property): the platform's, the tenant's and the property's. */
  rulesFor(tenantId: string, propertyId: string | null): Promise<RoutingRuleRow[]> {
    return this.x
      .select()
      .from(routingRules)
      .where(
        or(
          isNull(routingRules.tenantId),
          and(
            eq(routingRules.tenantId, tenantId),
            propertyId
              ? or(isNull(routingRules.propertyId), eq(routingRules.propertyId, propertyId))
              : isNull(routingRules.propertyId),
          ),
        ),
      );
  }
  /** Inserts or replaces the rule of one scope and capability. */
  async putRule(values: {
    tenantId: string | null;
    propertyId: string | null;
    capability: string;
    modelIds: string[];
    id: string;
  }): Promise<RoutingRuleRow> {
    const existing = await this.x
      .select()
      .from(routingRules)
      .where(
        and(
          eq(routingRules.capability, values.capability),
          values.tenantId
            ? eq(routingRules.tenantId, values.tenantId)
            : isNull(routingRules.tenantId),
          values.propertyId
            ? eq(routingRules.propertyId, values.propertyId)
            : isNull(routingRules.propertyId),
        ),
      )
      .for('update')
      .then((r) => r[0]);
    if (existing) {
      const [row] = await this.x
        .update(routingRules)
        .set({ modelIds: values.modelIds, version: sql`${routingRules.version} + 1` })
        .where(eq(routingRules.id, existing.id))
        .returning();
      return row!;
    }
    const [row] = await this.x.insert(routingRules).values(values).returning();
    return row!;
  }
  listRules(tenantId: string | null): Promise<RoutingRuleRow[]> {
    return this.x
      .select()
      .from(routingRules)
      .where(tenantId ? eq(routingRules.tenantId, tenantId) : isNull(routingRules.tenantId))
      .orderBy(asc(routingRules.capability));
  }

  // ---- calls ----
  async insertCall(values: typeof modelCalls.$inferInsert): Promise<void> {
    await this.x.insert(modelCalls).values(values);
  }
  /** External spend of the tenant since `from` (minor units). */
  async externalSpendSince(scope: TenantScope, from: Date): Promise<number> {
    const [row] = await this.x
      .select({ n: sql<number>`coalesce(sum(${modelCalls.costMinor}), 0)::int` })
      .from(modelCalls)
      .where(
        tenantWhere(
          modelCalls,
          scope,
          eq(modelCalls.egress, 'EXTERNAL'),
          gte(modelCalls.createdAt, from),
        ),
      );
    return row?.n ?? 0;
  }
  usage(scope: TenantScope, from: Date) {
    return this.x
      .select({
        capability: modelCalls.capability,
        providerCode: modelCalls.providerCode,
        modelCode: modelCalls.modelCode,
        currency: modelCalls.currency,
        calls: sql<number>`count(*)::int`,
        failures: sql<number>`count(*) filter (where ${modelCalls.outcome} <> 'OK')::int`,
        tokensIn: sql<number>`coalesce(sum(${modelCalls.tokensIn}), 0)::int`,
        tokensOut: sql<number>`coalesce(sum(${modelCalls.tokensOut}), 0)::int`,
        costMinor: sql<number>`coalesce(sum(${modelCalls.costMinor}), 0)::int`,
        avgLatencyMs: sql<number>`coalesce(avg(${modelCalls.latencyMs}), 0)::int`,
      })
      .from(modelCalls)
      .where(tenantWhere(modelCalls, scope, gte(modelCalls.createdAt, from)))
      .groupBy(
        modelCalls.capability,
        modelCalls.providerCode,
        modelCalls.modelCode,
        modelCalls.currency,
      )
      .orderBy(asc(modelCalls.capability));
  }
}
