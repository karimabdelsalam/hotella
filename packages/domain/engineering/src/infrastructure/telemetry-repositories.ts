import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type PropertyScope,
  propertyWhere,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import type { PartialMinute } from '../domain/telemetry';
import {
  type TelemetryAlarmRow,
  telemetryAlarms,
  type TelemetryMinuteRow,
  telemetryMinutes,
  type TelemetryPointRow,
  telemetryPoints,
  type TelemetryRuleRow,
  telemetryRules,
} from './schema';

/** Building telemetry storage (BUILD_PLAN 13.2): points, minute aggregates, rules and alarms of schema `eng`. */
@Injectable()
export class TelemetryRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- points ----
  async insertPoint(
    values: typeof telemetryPoints.$inferInsert,
  ): Promise<TelemetryPointRow | undefined> {
    const [row] = await this.x
      .insert(telemetryPoints)
      .values(values)
      .onConflictDoNothing()
      .returning();
    return row;
  }
  async point(scope: PropertyScope, id: string): Promise<TelemetryPointRow | undefined> {
    const [row] = await this.x
      .select()
      .from(telemetryPoints)
      .where(propertyWhere(telemetryPoints, scope, eq(telemetryPoints.id, id)));
    return row;
  }
  pointsOf(scope: PropertyScope): Promise<TelemetryPointRow[]> {
    return this.x
      .select()
      .from(telemetryPoints)
      .where(propertyWhere(telemetryPoints, scope))
      .orderBy(asc(telemetryPoints.externalCode));
  }
  pointsByCode(
    scope: TenantScope,
    instanceId: string,
    codes: readonly string[],
  ): Promise<TelemetryPointRow[]> {
    if (codes.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(telemetryPoints)
      .where(
        tenantWhere(
          telemetryPoints,
          scope,
          eq(telemetryPoints.instanceId, instanceId),
          inArray(telemetryPoints.externalCode, [...codes]),
        ),
      );
  }
  async updatePoint(
    scope: PropertyScope,
    id: string,
    version: number,
    values: Partial<Pick<TelemetryPointRow, 'status' | 'name' | 'assetId' | 'locationId'>>,
  ): Promise<TelemetryPointRow | undefined> {
    const [row] = await this.x
      .update(telemetryPoints)
      .set({ ...values, version: version + 1 })
      .where(
        propertyWhere(
          telemetryPoints,
          scope,
          eq(telemetryPoints.id, id),
          eq(telemetryPoints.version, version),
        ),
      )
      .returning();
    return row;
  }
  /** Moves the point's latest value forward only (batches may arrive out of order). */
  async touchPoint(scope: TenantScope, id: string, value: number, at: Date): Promise<void> {
    await this.x
      .update(telemetryPoints)
      .set({ lastValue: value, lastAt: at })
      .where(
        tenantWhere(
          telemetryPoints,
          scope,
          eq(telemetryPoints.id, id),
          sql`(${telemetryPoints.lastAt} IS NULL OR ${telemetryPoints.lastAt} <= ${at})`,
        ),
      );
  }
  /** Active points with an active MISSING rule, for the sweep (all tenants; the caller scopes each alarm). */
  missingCandidates(): Promise<Array<{ point: TelemetryPointRow; rule: TelemetryRuleRow }>> {
    return this.x
      .select({ point: telemetryPoints, rule: telemetryRules })
      .from(telemetryRules)
      .innerJoin(telemetryPoints, eq(telemetryPoints.id, telemetryRules.pointId))
      .where(
        and(
          eq(telemetryRules.kind, 'MISSING'),
          eq(telemetryRules.status, 'ACTIVE'),
          eq(telemetryPoints.status, 'ACTIVE'),
        ),
      )
      .orderBy(asc(telemetryRules.id));
  }

  // ---- minutes ----
  /** Merges a batch's partial minute into the stored one (min/max/sum/count add up; last by time). */
  async mergeMinute(
    point: Pick<TelemetryPointRow, 'id' | 'tenantId' | 'propertyId'>,
    m: PartialMinute,
  ): Promise<void> {
    await this.x
      .insert(telemetryMinutes)
      .values({
        tenantId: point.tenantId,
        propertyId: point.propertyId,
        pointId: point.id,
        minute: m.minute,
        min: m.min,
        max: m.max,
        sum: m.sum,
        samples: m.samples,
        last: m.last,
        lastAt: m.lastAt,
      })
      .onConflictDoUpdate({
        target: [telemetryMinutes.pointId, telemetryMinutes.minute],
        set: {
          min: sql`least(${telemetryMinutes.min}, excluded.min)`,
          max: sql`greatest(${telemetryMinutes.max}, excluded.max)`,
          sum: sql`${telemetryMinutes.sum} + excluded.sum`,
          samples: sql`${telemetryMinutes.samples} + excluded.samples`,
          last: sql`case when excluded.last_at >= ${telemetryMinutes.lastAt} then excluded.last else ${telemetryMinutes.last} end`,
          lastAt: sql`greatest(${telemetryMinutes.lastAt}, excluded.last_at)`,
        },
      });
  }
  minutes(
    scope: TenantScope,
    pointId: string,
    from: Date,
    to: Date,
  ): Promise<TelemetryMinuteRow[]> {
    return this.x
      .select()
      .from(telemetryMinutes)
      .where(
        tenantWhere(
          telemetryMinutes,
          scope,
          eq(telemetryMinutes.pointId, pointId),
          gte(telemetryMinutes.minute, from),
          lte(telemetryMinutes.minute, to),
        ),
      )
      .orderBy(asc(telemetryMinutes.minute));
  }
  /** Keeps the monthly partitions ahead and drops those past retention (SECURITY DEFINER function, migration 0056). */
  async maintainPartitions(): Promise<number> {
    const r = await this.x.execute<{ dropped: number }>(
      sql`select "eng"."maintain_telemetry_partitions"() as dropped`,
    );
    return Number(r.rows[0]?.dropped ?? 0);
  }

  // ---- rules ----
  async insertRule(values: typeof telemetryRules.$inferInsert): Promise<TelemetryRuleRow> {
    const [row] = await this.x.insert(telemetryRules).values(values).returning();
    return row!;
  }
  async rule(scope: PropertyScope, id: string): Promise<TelemetryRuleRow | undefined> {
    const [row] = await this.x
      .select()
      .from(telemetryRules)
      .where(propertyWhere(telemetryRules, scope, eq(telemetryRules.id, id)));
    return row;
  }
  rulesOf(scope: PropertyScope, pointId?: string): Promise<TelemetryRuleRow[]> {
    return this.x
      .select()
      .from(telemetryRules)
      .where(
        propertyWhere(
          telemetryRules,
          scope,
          ...(pointId ? [eq(telemetryRules.pointId, pointId)] : []),
        ),
      )
      .orderBy(asc(telemetryRules.id));
  }
  activeRulesOf(scope: TenantScope, pointIds: readonly string[]): Promise<TelemetryRuleRow[]> {
    if (pointIds.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(telemetryRules)
      .where(
        tenantWhere(
          telemetryRules,
          scope,
          inArray(telemetryRules.pointId, [...pointIds]),
          eq(telemetryRules.status, 'ACTIVE'),
        ),
      )
      .orderBy(asc(telemetryRules.id));
  }
  async retireRule(
    scope: PropertyScope,
    id: string,
    version: number,
    by: string | null,
  ): Promise<TelemetryRuleRow | undefined> {
    const [row] = await this.x
      .update(telemetryRules)
      .set({ status: 'RETIRED', retiredAt: new Date(), retiredBy: by, version: version + 1 })
      .where(
        propertyWhere(
          telemetryRules,
          scope,
          eq(telemetryRules.id, id),
          eq(telemetryRules.version, version),
          eq(telemetryRules.status, 'ACTIVE'),
        ),
      )
      .returning();
    return row;
  }

  // ---- alarms ----
  async insertAlarm(
    values: typeof telemetryAlarms.$inferInsert,
  ): Promise<TelemetryAlarmRow | undefined> {
    // The partial unique index keeps one live alarm per rule; a concurrent raise is a no-op.
    const [row] = await this.x
      .insert(telemetryAlarms)
      .values(values)
      .onConflictDoNothing()
      .returning();
    return row;
  }
  async liveAlarmsOf(scope: TenantScope, ruleIds: readonly string[]): Promise<TelemetryAlarmRow[]> {
    if (ruleIds.length === 0) return [];
    return this.x
      .select()
      .from(telemetryAlarms)
      .where(
        tenantWhere(
          telemetryAlarms,
          scope,
          inArray(telemetryAlarms.ruleId, [...ruleIds]),
          ne(telemetryAlarms.status, 'CLEARED'),
        ),
      )
      .for('update');
  }
  async alarm(scope: PropertyScope, id: string): Promise<TelemetryAlarmRow | undefined> {
    const [row] = await this.x
      .select()
      .from(telemetryAlarms)
      .where(propertyWhere(telemetryAlarms, scope, eq(telemetryAlarms.id, id)));
    return row;
  }
  alarmsOf(
    scope: PropertyScope,
    filter: { live?: boolean; pointId?: string; limit: number },
  ): Promise<TelemetryAlarmRow[]> {
    return this.x
      .select()
      .from(telemetryAlarms)
      .where(
        propertyWhere(
          telemetryAlarms,
          scope,
          ...(filter.live ? [ne(telemetryAlarms.status, 'CLEARED')] : []),
          ...(filter.pointId ? [eq(telemetryAlarms.pointId, filter.pointId)] : []),
        ),
      )
      .orderBy(desc(telemetryAlarms.raisedAt))
      .limit(filter.limit);
  }
  async updateAlarm(
    scope: TenantScope,
    id: string,
    version: number,
    values: Partial<
      Pick<
        TelemetryAlarmRow,
        'status' | 'peak' | 'acknowledgedAt' | 'acknowledgedBy' | 'clearedAt' | 'workOrderId'
      >
    >,
  ): Promise<TelemetryAlarmRow | undefined> {
    const [row] = await this.x
      .update(telemetryAlarms)
      .set({ ...values, version: version + 1 })
      .where(
        tenantWhere(
          telemetryAlarms,
          scope,
          eq(telemetryAlarms.id, id),
          eq(telemetryAlarms.version, version),
        ),
      )
      .returning();
    return row;
  }
}
