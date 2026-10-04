import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, max, notInArray, sql } from 'drizzle-orm';
import { DATABASE, type Database, executor } from '@hotella/platform-database';
import type { CapabilityDefinition, MetricDefinition } from '../domain/catalog';
import type { DraftLimit } from '../domain/plans';
import {
  capabilities,
  type CapabilityRow,
  metrics,
  type MetricRow,
  planTranslations,
  type PlanRow,
  plans,
  type PlanTranslationRow,
  planVersionItems,
  type PlanVersionItemRow,
  planVersionLimits,
  type PlanVersionLimitRow,
  type PlanVersionRow,
  planVersions,
  products,
} from './schema';

export interface TranslationInput {
  readonly locale: string;
  readonly name: string;
  readonly description?: string | null;
}

/**
 * The commercial catalog and plans (platform-level rows: no tenant). Tenant-owned licensing rows have their own
 * repository, which never runs a query without a tenant scope (rule 1).
 */
@Injectable()
export class CatalogRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- catalog sync ----
  /** Serialises catalog syncs of processes booting together (transaction-scoped). */
  async lockCatalog(): Promise<void> {
    await this.x.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('license.catalog.sync', 0))`,
    );
  }
  async upsertProduct(code: string): Promise<void> {
    await this.x
      .insert(products)
      .values({ code })
      .onConflictDoUpdate({ target: products.code, set: { status: 'ACTIVE' } });
  }
  async upsertCapabilities(product: string, defs: readonly CapabilityDefinition[]): Promise<void> {
    for (const d of defs)
      await this.x
        .insert(capabilities)
        .values({
          code: d.code,
          productCode: product,
          kind: d.kind,
          moduleCode: d.moduleCode ?? null,
          defaultIncluded: d.defaultIncluded ?? false,
        })
        .onConflictDoUpdate({
          target: capabilities.code,
          set: {
            productCode: product,
            kind: d.kind,
            moduleCode: d.moduleCode ?? null,
            defaultIncluded: d.defaultIncluded ?? false,
            status: 'ACTIVE',
          },
        });
    // A code removed from the catalog is retired, never deleted: plans and grants keep pointing at it.
    await this.x
      .update(capabilities)
      .set({ status: 'RETIRED' })
      .where(
        defs.length
          ? notInArray(
              capabilities.code,
              defs.map((d) => d.code),
            )
          : sql`true`,
      );
  }
  async upsertMetrics(defs: readonly MetricDefinition[]): Promise<void> {
    for (const d of defs)
      await this.x
        .insert(metrics)
        .values({ code: d.code, unit: d.unit, kind: d.kind })
        .onConflictDoUpdate({
          target: metrics.code,
          set: { unit: d.unit, kind: d.kind, status: 'ACTIVE' },
        });
    await this.x
      .update(metrics)
      .set({ status: 'RETIRED' })
      .where(
        defs.length
          ? notInArray(
              metrics.code,
              defs.map((d) => d.code),
            )
          : sql`true`,
      );
  }

  capabilities(): Promise<CapabilityRow[]> {
    return this.x
      .select()
      .from(capabilities)
      .orderBy(asc(capabilities.kind), asc(capabilities.code));
  }
  metrics(): Promise<MetricRow[]> {
    return this.x.select().from(metrics).orderBy(asc(metrics.code));
  }

  // ---- plans ----
  async insertPlan(values: typeof plans.$inferInsert): Promise<PlanRow> {
    const [row] = await this.x.insert(plans).values(values).returning();
    return row!;
  }
  plan(id: string): Promise<PlanRow | undefined> {
    return this.x
      .select()
      .from(plans)
      .where(eq(plans.id, id))
      .then((r) => r[0]);
  }
  /** Row lock: one change of a plan's versions at a time. */
  async lockPlan(id: string): Promise<PlanRow | undefined> {
    return this.x
      .select()
      .from(plans)
      .where(eq(plans.id, id))
      .for('update')
      .then((r) => r[0]);
  }
  listPlans(): Promise<PlanRow[]> {
    return this.x.select().from(plans).orderBy(asc(plans.code));
  }
  async updatePlan(
    id: string,
    expectedVersion: number,
    set: Partial<Pick<PlanRow, 'status'>>,
  ): Promise<PlanRow | undefined> {
    const [row] = await this.x
      .update(plans)
      .set({ ...set, version: sql`${plans.version} + 1` })
      .where(and(eq(plans.id, id), eq(plans.version, expectedVersion)))
      .returning();
    return row;
  }
  async putPlanTranslations(planId: string, input: readonly TranslationInput[]): Promise<void> {
    for (const t of input)
      await this.x
        .insert(planTranslations)
        .values({
          entityId: planId,
          locale: t.locale,
          name: t.name,
          description: t.description ?? null,
        })
        .onConflictDoUpdate({
          target: [planTranslations.entityId, planTranslations.locale],
          set: { name: t.name, description: t.description ?? null, updatedAt: new Date() },
        });
  }
  planTranslations(planIds: readonly string[]): Promise<PlanTranslationRow[]> {
    if (planIds.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(planTranslations)
      .where(inArray(planTranslations.entityId, [...planIds]))
      .orderBy(asc(planTranslations.locale));
  }

  // ---- versions ----
  async insertVersion(values: typeof planVersions.$inferInsert): Promise<PlanVersionRow> {
    const [row] = await this.x.insert(planVersions).values(values).returning();
    return row!;
  }
  version(planId: string, id: string): Promise<PlanVersionRow | undefined> {
    return this.x
      .select()
      .from(planVersions)
      .where(and(eq(planVersions.planId, planId), eq(planVersions.id, id)))
      .then((r) => r[0]);
  }
  versionById(id: string): Promise<PlanVersionRow | undefined> {
    return this.x
      .select()
      .from(planVersions)
      .where(eq(planVersions.id, id))
      .then((r) => r[0]);
  }
  versionsOf(planIds: readonly string[]): Promise<PlanVersionRow[]> {
    if (planIds.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(planVersions)
      .where(inArray(planVersions.planId, [...planIds]))
      .orderBy(asc(planVersions.planId), desc(planVersions.versionNo));
  }
  async nextVersionNo(planId: string): Promise<number> {
    const [row] = await this.x
      .select({ n: max(planVersions.versionNo) })
      .from(planVersions)
      .where(eq(planVersions.planId, planId));
    return (row?.n ?? 0) + 1;
  }
  async updateVersion(
    id: string,
    expectedVersion: number,
    set: Partial<
      Pick<PlanVersionRow, 'notes' | 'status' | 'publishedAt' | 'publishedById' | 'retiredAt'>
    >,
  ): Promise<PlanVersionRow | undefined> {
    const [row] = await this.x
      .update(planVersions)
      .set({ ...set, version: sql`${planVersions.version} + 1` })
      .where(and(eq(planVersions.id, id), eq(planVersions.version, expectedVersion)))
      .returning();
    return row;
  }

  items(versionIds: readonly string[]): Promise<PlanVersionItemRow[]> {
    if (versionIds.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(planVersionItems)
      .where(inArray(planVersionItems.planVersionId, [...versionIds]))
      .orderBy(asc(planVersionItems.capabilityCode));
  }
  limits(versionIds: readonly string[]): Promise<PlanVersionLimitRow[]> {
    if (versionIds.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(planVersionLimits)
      .where(inArray(planVersionLimits.planVersionId, [...versionIds]))
      .orderBy(asc(planVersionLimits.metricCode), asc(planVersionLimits.scope));
  }
  /** Replaces a draft's content (the database refuses this for a published version). */
  async replaceContent(
    versionId: string,
    items: readonly string[],
    limits: readonly DraftLimit[],
  ): Promise<void> {
    await this.x.delete(planVersionItems).where(eq(planVersionItems.planVersionId, versionId));
    await this.x.delete(planVersionLimits).where(eq(planVersionLimits.planVersionId, versionId));
    if (items.length)
      await this.x.insert(planVersionItems).values(
        [...new Set(items)].map((capabilityCode) => ({
          planVersionId: versionId,
          capabilityCode,
        })),
      );
    if (limits.length)
      await this.x.insert(planVersionLimits).values(
        limits.map((l) => ({
          planVersionId: versionId,
          metricCode: l.metricCode,
          scope: l.scope,
          period: l.period,
          limitValue: l.limitValue,
          enforcement: l.enforcement,
        })),
      );
  }
}
