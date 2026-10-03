import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  lte,
  ne,
  type SQL,
  sql,
} from 'drizzle-orm';
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
  alerts,
  businessHours,
  escalations,
  slaInstances,
  slaPauses,
  slaPolicies,
  type AlertRow,
  type BusinessHoursRow,
  type EscalationRow,
  type SlaInstanceRow,
  type SlaPauseRow,
  type SlaPolicyRow,
} from './schema';

/** Tenant-filtered data access for SLA, escalations and alerts (CLAUDE.md rule 1). */
@Injectable()
export class SlaRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- business hours ----
  async insertBusinessHours(values: typeof businessHours.$inferInsert): Promise<BusinessHoursRow> {
    const [row] = await this.x.insert(businessHours).values(values).returning();
    return row!;
  }
  businessHours(scope: PropertyScope, id: string): Promise<BusinessHoursRow | undefined> {
    return this.x
      .select()
      .from(businessHours)
      .where(propertyWhere(businessHours, scope, eq(businessHours.id, id)))
      .then((r) => r[0]);
  }
  businessHoursByCode(scope: PropertyScope, code: string): Promise<BusinessHoursRow | undefined> {
    return this.x
      .select()
      .from(businessHours)
      .where(propertyWhere(businessHours, scope, eq(businessHours.code, code)))
      .then((r) => r[0]);
  }
  listBusinessHours(scope: PropertyScope): Promise<BusinessHoursRow[]> {
    return this.x
      .select()
      .from(businessHours)
      .where(propertyWhere(businessHours, scope))
      .orderBy(asc(businessHours.code));
  }
  /** Optimistic update: undefined when `version` is stale. */
  async updateBusinessHours(
    scope: PropertyScope,
    id: string,
    version: number,
    values: Partial<typeof businessHours.$inferInsert>,
  ): Promise<BusinessHoursRow | undefined> {
    const [row] = await this.x
      .update(businessHours)
      .set({ ...values, version: sql`${businessHours.version} + 1` })
      .where(
        propertyWhere(
          businessHours,
          scope,
          eq(businessHours.id, id),
          eq(businessHours.version, version),
        ),
      )
      .returning();
    return row;
  }

  // ---- policies ----
  async insertPolicy(values: typeof slaPolicies.$inferInsert): Promise<SlaPolicyRow> {
    const [row] = await this.x.insert(slaPolicies).values(values).returning();
    return row!;
  }
  policy(scope: PropertyScope, id: string): Promise<SlaPolicyRow | undefined> {
    return this.x
      .select()
      .from(slaPolicies)
      .where(propertyWhere(slaPolicies, scope, eq(slaPolicies.id, id)))
      .then((r) => r[0]);
  }
  policyByCode(scope: PropertyScope, code: string): Promise<SlaPolicyRow | undefined> {
    return this.x
      .select()
      .from(slaPolicies)
      .where(propertyWhere(slaPolicies, scope, eq(slaPolicies.code, code)))
      .then((r) => r[0]);
  }
  listPolicies(scope: PropertyScope, onlyActive = false): Promise<SlaPolicyRow[]> {
    return this.x
      .select()
      .from(slaPolicies)
      .where(
        propertyWhere(
          slaPolicies,
          scope,
          onlyActive ? eq(slaPolicies.status, 'ACTIVE') : undefined,
        ),
      )
      .orderBy(asc(slaPolicies.code));
  }
  async updatePolicy(
    scope: PropertyScope,
    id: string,
    version: number,
    values: Partial<typeof slaPolicies.$inferInsert>,
  ): Promise<SlaPolicyRow | undefined> {
    const [row] = await this.x
      .update(slaPolicies)
      .set({ ...values, version: sql`${slaPolicies.version} + 1` })
      .where(
        propertyWhere(slaPolicies, scope, eq(slaPolicies.id, id), eq(slaPolicies.version, version)),
      )
      .returning();
    return row;
  }

  // ---- instances ----
  async insertInstance(values: typeof slaInstances.$inferInsert): Promise<SlaInstanceRow> {
    const [row] = await this.x.insert(slaInstances).values(values).returning();
    return row!;
  }
  instanceOfWorkItem(scope: TenantScope, workItemId: string): Promise<SlaInstanceRow | undefined> {
    return this.x
      .select()
      .from(slaInstances)
      .where(tenantWhere(slaInstances, scope, eq(slaInstances.workItemId, workItemId)))
      .then((r) => r[0]);
  }
  instancesOfWorkItems(
    scope: TenantScope,
    workItemIds: readonly string[],
  ): Promise<SlaInstanceRow[]> {
    if (workItemIds.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(slaInstances)
      .where(tenantWhere(slaInstances, scope, inArray(slaInstances.workItemId, [...workItemIds])));
  }
  instanceOfWorkItemForUpdate(
    scope: TenantScope,
    workItemId: string,
  ): Promise<SlaInstanceRow | undefined> {
    return this.x
      .select()
      .from(slaInstances)
      .where(tenantWhere(slaInstances, scope, eq(slaInstances.workItemId, workItemId)))
      .for('update')
      .then((r) => r[0]);
  }
  instanceForUpdate(scope: TenantScope, id: string): Promise<SlaInstanceRow | undefined> {
    return this.x
      .select()
      .from(slaInstances)
      .where(tenantWhere(slaInstances, scope, eq(slaInstances.id, id)))
      .for('update')
      .then((r) => r[0]);
  }
  async updateInstance(
    scope: TenantScope,
    id: string,
    values: Partial<typeof slaInstances.$inferInsert>,
  ): Promise<SlaInstanceRow> {
    const [row] = await this.x
      .update(slaInstances)
      .set({ ...values, version: sql`${slaInstances.version} + 1` })
      .where(tenantWhere(slaInstances, scope, eq(slaInstances.id, id)))
      .returning();
    return row!;
  }
  /**
   * Running SLAs whose next check is due, across tenants (the worker's sweep; not tenant data access). Rows are locked
   * and skipped by concurrent sweepers, so several workers never evaluate the same SLA twice.
   */
  claimDue(now: Date, limit: number): Promise<Array<Pick<SlaInstanceRow, 'id' | 'tenantId'>>> {
    return this.x
      .select({ id: slaInstances.id, tenantId: slaInstances.tenantId })
      .from(slaInstances)
      .where(and(eq(slaInstances.status, 'RUNNING'), lte(slaInstances.nextCheckAt, now)))
      .orderBy(asc(slaInstances.nextCheckAt))
      .limit(limit)
      .for('update', { skipLocked: true });
  }

  // ---- pauses ----
  async insertPause(values: typeof slaPauses.$inferInsert): Promise<SlaPauseRow> {
    const [row] = await this.x.insert(slaPauses).values(values).returning();
    return row!;
  }
  async closeOpenPause(scope: TenantScope, instanceId: string, at: Date): Promise<void> {
    await this.x
      .update(slaPauses)
      .set({ resumedAt: at })
      .where(
        tenantWhere(
          slaPauses,
          scope,
          eq(slaPauses.slaInstanceId, instanceId),
          isNull(slaPauses.resumedAt),
        ),
      );
  }
  pauses(scope: TenantScope, instanceId: string): Promise<SlaPauseRow[]> {
    return this.x
      .select()
      .from(slaPauses)
      .where(tenantWhere(slaPauses, scope, eq(slaPauses.slaInstanceId, instanceId)))
      .orderBy(asc(slaPauses.pausedAt));
  }

  // ---- escalations ----
  /** Inserts the ladder step once; undefined when it already fired (idempotent under concurrent sweeps). */
  async insertEscalation(
    values: typeof escalations.$inferInsert,
  ): Promise<EscalationRow | undefined> {
    const [row] = await this.x.insert(escalations).values(values).onConflictDoNothing().returning();
    return row;
  }
  escalations(scope: TenantScope, instanceId: string): Promise<EscalationRow[]> {
    return this.x
      .select()
      .from(escalations)
      .where(tenantWhere(escalations, scope, eq(escalations.slaInstanceId, instanceId)))
      .orderBy(asc(escalations.triggeredAt), asc(escalations.level));
  }

  // ---- alerts ----
  /**
   * Raises an alert or, when one with the same key is still active, counts the repeat (Spec §15 deduplication). The
   * severity only goes up. `created` is true for a new alert.
   */
  async raiseAlert(
    values: typeof alerts.$inferInsert,
  ): Promise<{ alert: AlertRow; created: boolean }> {
    const [row] = await this.x
      .insert(alerts)
      .values(values)
      .onConflictDoUpdate({
        target: [alerts.tenantId, alerts.dedupeKey],
        targetWhere: sql`${alerts.status} <> 'RESOLVED'`,
        set: {
          occurrences: sql`${alerts.occurrences} + 1`,
          lastSeenAt: sql`excluded.last_seen_at`,
          severity: sql`GREATEST(${alerts.severity}, excluded.severity)`,
          evidence: sql`${alerts.evidence} || excluded.evidence`,
          updatedAt: sql`now()`,
          version: sql`${alerts.version} + 1`,
        },
      })
      .returning({ ...getTableColumns(alerts), created: sql<boolean>`(xmax = 0)` });
    const { created, ...alert } = row!;
    return { alert, created };
  }
  alert(scope: TenantScope, id: string): Promise<AlertRow | undefined> {
    return this.x
      .select()
      .from(alerts)
      .where(tenantWhere(alerts, scope, eq(alerts.id, id)))
      .then((r) => r[0]);
  }
  alertForUpdate(scope: TenantScope, id: string): Promise<AlertRow | undefined> {
    return this.x
      .select()
      .from(alerts)
      .where(tenantWhere(alerts, scope, eq(alerts.id, id)))
      .for('update')
      .then((r) => r[0]);
  }
  async updateAlert(
    scope: TenantScope,
    id: string,
    values: Partial<typeof alerts.$inferInsert>,
  ): Promise<AlertRow> {
    const [row] = await this.x
      .update(alerts)
      .set({ ...values, version: sql`${alerts.version} + 1` })
      .where(tenantWhere(alerts, scope, eq(alerts.id, id)))
      .returning();
    return row!;
  }
  listAlerts(
    scope: PropertyScope,
    filter: { status?: readonly AlertRow['status'][]; limit: number },
  ): Promise<AlertRow[]> {
    const conditions: SQL[] = [];
    if (filter.status?.length) conditions.push(inArray(alerts.status, [...filter.status]));
    return this.x
      .select()
      .from(alerts)
      .where(propertyWhere(alerts, scope, ...conditions))
      .orderBy(desc(alerts.lastSeenAt))
      .limit(filter.limit);
  }
  activeAlertsForKeys(scope: TenantScope, keys: readonly string[]): Promise<AlertRow[]> {
    if (keys.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(alerts)
      .where(
        tenantWhere(
          alerts,
          scope,
          inArray(alerts.dedupeKey, [...keys]),
          ne(alerts.status, 'RESOLVED'),
        ),
      );
  }
}
