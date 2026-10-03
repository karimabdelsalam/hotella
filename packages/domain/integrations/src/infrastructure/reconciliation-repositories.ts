import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import {
  reconciliationEntries,
  reconciliationResults,
  reconciliationRuns,
  type ReconciliationEntryRow,
  type ReconciliationResultRow,
  type ReconciliationRunRow,
} from './schema';

@Injectable()
export class ReconciliationRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  async insertRun(values: typeof reconciliationRuns.$inferInsert): Promise<ReconciliationRunRow> {
    const [row] = await this.x.insert(reconciliationRuns).values(values).returning();
    return row!;
  }
  run(scope: TenantScope, id: string): Promise<ReconciliationRunRow | undefined> {
    return this.x
      .select()
      .from(reconciliationRuns)
      .where(tenantWhere(reconciliationRuns, scope, eq(reconciliationRuns.id, id)))
      .then((r) => r[0]);
  }
  runForUpdate(scope: TenantScope, id: string): Promise<ReconciliationRunRow | undefined> {
    return this.x
      .select()
      .from(reconciliationRuns)
      .where(tenantWhere(reconciliationRuns, scope, eq(reconciliationRuns.id, id)))
      .for('update')
      .then((r) => r[0]);
  }
  runs(scope: TenantScope, instanceId: string, limit = 20): Promise<ReconciliationRunRow[]> {
    return this.x
      .select()
      .from(reconciliationRuns)
      .where(tenantWhere(reconciliationRuns, scope, eq(reconciliationRuns.instanceId, instanceId)))
      .orderBy(desc(reconciliationRuns.createdAt))
      .limit(limit);
  }
  /** The run waiting for a PMS snapshot (oldest first), if any. */
  awaitingSnapshot(
    scope: TenantScope,
    instanceId: string,
  ): Promise<ReconciliationRunRow | undefined> {
    return this.x
      .select()
      .from(reconciliationRuns)
      .where(
        tenantWhere(
          reconciliationRuns,
          scope,
          eq(reconciliationRuns.instanceId, instanceId),
          eq(reconciliationRuns.status, 'RUNNING'),
          isNull(reconciliationRuns.snapshotCompletedAt),
        ),
      )
      .orderBy(asc(reconciliationRuns.createdAt))
      .limit(1)
      .then((r) => r[0]);
  }
  /** The run currently receiving a snapshot. */
  collecting(scope: TenantScope, instanceId: string): Promise<ReconciliationRunRow | undefined> {
    return this.x
      .select()
      .from(reconciliationRuns)
      .where(
        tenantWhere(
          reconciliationRuns,
          scope,
          eq(reconciliationRuns.instanceId, instanceId),
          eq(reconciliationRuns.status, 'RUNNING'),
          isNotNull(reconciliationRuns.snapshotStartedAt),
          isNull(reconciliationRuns.snapshotCompletedAt),
        ),
      )
      .orderBy(desc(reconciliationRuns.snapshotStartedAt))
      .limit(1)
      .then((r) => r[0]);
  }
  async updateRun(
    scope: TenantScope,
    id: string,
    values: Partial<typeof reconciliationRuns.$inferInsert>,
  ): Promise<ReconciliationRunRow> {
    const [row] = await this.x
      .update(reconciliationRuns)
      .set(values)
      .where(tenantWhere(reconciliationRuns, scope, eq(reconciliationRuns.id, id)))
      .returning();
    return row!;
  }

  async clearEntries(scope: TenantScope, runId: string): Promise<void> {
    await this.x
      .delete(reconciliationEntries)
      .where(tenantWhere(reconciliationEntries, scope, eq(reconciliationEntries.runId, runId)));
  }
  async addEntry(values: typeof reconciliationEntries.$inferInsert): Promise<void> {
    await this.x
      .insert(reconciliationEntries)
      .values(values)
      .onConflictDoUpdate({
        target: [reconciliationEntries.runId, reconciliationEntries.externalId],
        set: { roomCode: values.roomCode, roomId: values.roomId },
      });
  }
  entries(scope: TenantScope, runId: string): Promise<ReconciliationEntryRow[]> {
    return this.x
      .select()
      .from(reconciliationEntries)
      .where(tenantWhere(reconciliationEntries, scope, eq(reconciliationEntries.runId, runId)))
      .orderBy(asc(reconciliationEntries.externalId));
  }

  async insertResults(values: Array<typeof reconciliationResults.$inferInsert>): Promise<void> {
    if (values.length > 0) await this.x.insert(reconciliationResults).values(values);
  }
  results(scope: TenantScope, runId: string): Promise<ReconciliationResultRow[]> {
    return this.x
      .select()
      .from(reconciliationResults)
      .where(and(tenantWhere(reconciliationResults, scope, eq(reconciliationResults.runId, runId))))
      .orderBy(asc(reconciliationResults.outcome), asc(reconciliationResults.externalId));
  }
}
