import { Inject, Injectable } from '@nestjs/common';
import { count, desc, eq } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type PropertyScope,
  propertyWhere,
} from '@hotella/platform-database';
import {
  type CommissioningRunRow,
  commissioningRuns,
  type CommissioningSheetRow,
  commissioningSheetRows,
  integrationExceptions,
  reconciliationRuns,
} from './schema';

/** Commissioning records of a property (guide §16, BUILD_PLAN 10.9): the Interface Sheet and verification runs. */
@Injectable()
export class CommissioningRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  async appendSheetRow(
    values: typeof commissioningSheetRows.$inferInsert,
  ): Promise<CommissioningSheetRow> {
    const [row] = await this.x.insert(commissioningSheetRows).values(values).returning();
    return row!;
  }

  /** The current statement per requirement: the latest row of each. */
  currentSheet(scope: PropertyScope): Promise<CommissioningSheetRow[]> {
    const t = commissioningSheetRows;
    return this.x
      .selectDistinctOn([t.requirement])
      .from(t)
      .where(propertyWhere(t, scope))
      .orderBy(t.requirement, desc(t.createdAt), desc(t.id));
  }

  sheetHistory(scope: PropertyScope, limit: number): Promise<CommissioningSheetRow[]> {
    const t = commissioningSheetRows;
    return this.x
      .select()
      .from(t)
      .where(propertyWhere(t, scope))
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(limit);
  }

  async insertRun(values: typeof commissioningRuns.$inferInsert): Promise<CommissioningRunRow> {
    const [row] = await this.x.insert(commissioningRuns).values(values).returning();
    return row!;
  }

  /** The latest run of each instance of the property. */
  lastRuns(scope: PropertyScope): Promise<CommissioningRunRow[]> {
    const t = commissioningRuns;
    return this.x
      .selectDistinctOn([t.instanceId])
      .from(t)
      .where(propertyWhere(t, scope))
      .orderBy(t.instanceId, desc(t.startedAt), desc(t.id));
  }

  recentRuns(scope: PropertyScope, limit: number): Promise<CommissioningRunRow[]> {
    const t = commissioningRuns;
    return this.x
      .select()
      .from(t)
      .where(propertyWhere(t, scope))
      .orderBy(desc(t.startedAt), desc(t.id))
      .limit(limit);
  }

  async openExceptions(scope: PropertyScope): Promise<number> {
    const t = integrationExceptions;
    const [row] = await this.x
      .select({ n: count() })
      .from(t)
      .where(propertyWhere(t, scope, eq(t.status, 'OPEN')));
    return row?.n ?? 0;
  }

  /** The property's latest reconciliation run: its status and how many findings were not MATCH. */
  async lastReconciliation(
    scope: PropertyScope,
  ): Promise<{ status: string; differences: number } | null> {
    const t = reconciliationRuns;
    const [row] = await this.x
      .select({ status: t.status, summary: t.summary })
      .from(t)
      .where(propertyWhere(t, scope))
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(1);
    if (!row) return null;
    const summary = (row.summary ?? {}) as Record<string, number>;
    const differences = Object.entries(summary)
      .filter(([outcome]) => outcome !== 'MATCH')
      .reduce((sum, [, n]) => sum + (Number.isFinite(n) ? n : 0), 0);
    return { status: row.status, differences };
  }
}
