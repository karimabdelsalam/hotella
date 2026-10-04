import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, gte, lt, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import { limitNotices, usageAggregates, usageCollectorCursors, usageEvents } from './schema';

export type Granularity = 'DAY' | 'MONTH';

/** Usage events, their aggregates and limit notices (tenant-owned; rule 1). */
@Injectable()
export class UsageRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  /** True when the event is new; a repeated idempotency key changes nothing (Spec §61). */
  async insertEvent(values: typeof usageEvents.$inferInsert): Promise<boolean> {
    const rows = await this.x
      .insert(usageEvents)
      .values(values)
      .onConflictDoNothing({ target: [usageEvents.tenantId, usageEvents.idempotencyKey] })
      .returning({ id: usageEvents.id });
    return rows.length > 0;
  }

  /** Adds to a counter's period total, or raises a gauge's period maximum; returns the new value. */
  async bump(input: {
    readonly tenantId: string;
    readonly propertyKey: string;
    readonly metricCode: string;
    readonly granularity: Granularity;
    readonly periodStart: Date;
    readonly quantity: number;
    readonly gauge: boolean;
  }): Promise<number> {
    const [row] = await this.x
      .insert(usageAggregates)
      .values({
        tenantId: input.tenantId,
        propertyKey: input.propertyKey,
        metricCode: input.metricCode,
        granularity: input.granularity,
        periodStart: input.periodStart,
        quantity: input.quantity,
      })
      .onConflictDoUpdate({
        target: [
          usageAggregates.tenantId,
          usageAggregates.propertyKey,
          usageAggregates.metricCode,
          usageAggregates.granularity,
          usageAggregates.periodStart,
        ],
        set: {
          quantity: input.gauge
            ? sql`greatest(${usageAggregates.quantity}, excluded.quantity)`
            : sql`${usageAggregates.quantity} + excluded.quantity`,
          updatedAt: new Date(),
        },
      })
      .returning({ quantity: usageAggregates.quantity });
    return row!.quantity;
  }

  aggregate(
    scope: TenantScope,
    propertyKey: string,
    metricCode: string,
    granularity: Granularity,
    periodStart: Date,
  ): Promise<number> {
    return this.x
      .select({ q: usageAggregates.quantity })
      .from(usageAggregates)
      .where(
        tenantWhere(
          usageAggregates,
          scope,
          eq(usageAggregates.propertyKey, propertyKey),
          eq(usageAggregates.metricCode, metricCode),
          eq(usageAggregates.granularity, granularity),
          eq(usageAggregates.periodStart, periodStart),
        ),
      )
      .then((r) => r[0]?.q ?? 0);
  }

  report(
    scope: TenantScope,
    filter: {
      readonly propertyKey: string;
      readonly granularity: Granularity;
      readonly from: Date;
      readonly to: Date;
      readonly metricCode?: string;
    },
  ) {
    return this.x
      .select({
        metricCode: usageAggregates.metricCode,
        periodStart: usageAggregates.periodStart,
        quantity: usageAggregates.quantity,
      })
      .from(usageAggregates)
      .where(
        tenantWhere(
          usageAggregates,
          scope,
          eq(usageAggregates.propertyKey, filter.propertyKey),
          eq(usageAggregates.granularity, filter.granularity),
          gte(usageAggregates.periodStart, filter.from),
          lt(usageAggregates.periodStart, filter.to),
          filter.metricCode ? eq(usageAggregates.metricCode, filter.metricCode) : undefined,
        ),
      )
      .orderBy(asc(usageAggregates.metricCode), asc(usageAggregates.periodStart));
  }

  /** True when this is the first notice for the limit in this period. */
  async insertNotice(values: typeof limitNotices.$inferInsert): Promise<boolean> {
    const rows = await this.x
      .insert(limitNotices)
      .values(values)
      .onConflictDoNothing()
      .returning({ tenantId: limitNotices.tenantId });
    return rows.length > 0;
  }

  notices(scope: TenantScope, since: Date) {
    return this.x
      .select()
      .from(limitNotices)
      .where(tenantWhere(limitNotices, scope, gte(limitNotices.periodStart, since)))
      .orderBy(asc(limitNotices.createdAt));
  }

  /** Retention (BUILD_PLAN 11.B): measured occurrences older than the cut-off; aggregates stay. */
  async purgeEventsBefore(cutoff: Date): Promise<number> {
    const rows = await this.x
      .delete(usageEvents)
      .where(lt(usageEvents.occurredAt, cutoff))
      .returning({ id: usageEvents.id });
    return rows.length;
  }

  cursor(collector: string): Promise<string | null> {
    return this.x
      .select({ c: usageCollectorCursors.cursor })
      .from(usageCollectorCursors)
      .where(eq(usageCollectorCursors.collector, collector))
      .then((r) => r[0]?.c ?? null);
  }
  async setCursor(collector: string, cursor: string): Promise<void> {
    await this.x
      .insert(usageCollectorCursors)
      .values({ collector, cursor })
      .onConflictDoUpdate({
        target: usageCollectorCursors.collector,
        set: { cursor, updatedAt: new Date() },
      });
  }

  /** Tenants that hold a subscription in any state (the gauge sweep samples them). */
  async licensedTenants(): Promise<string[]> {
    const rows = await this.x.execute(
      sql`select distinct tenant_id from license.subscriptions where status not in ('CANCELLED', 'EXPIRED')`,
    );
    return (rows.rows as Array<{ tenant_id: string }>).map((r) => r.tenant_id);
  }
}
