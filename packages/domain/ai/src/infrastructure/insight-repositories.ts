import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { DATABASE, type Database, executor, type PropertyScope } from '@hotella/platform-database';
import type { InsightStatus } from '../domain/insights';
import {
  feedback,
  insightHistory,
  type InsightHistoryRow,
  type InsightRow,
  insights,
  type SignalRow,
  signals,
  twinNodes,
} from './schema';

const LIVE: InsightStatus[] = ['OPEN', 'ACKNOWLEDGED'];

/** A code key as an SQL literal (so the same expression can be grouped by); keys are code constants, checked here. */
function codeKey(key: string) {
  if (!/^[a-z_]{1,40}$/.test(key)) throw new Error(`invalid code key ${key}`);
  return sql.raw(`'${key}'`);
}

/** Signals, insights and their history (BUILD_PLAN 12.4). */
@Injectable()
export class InsightRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- signals ----
  async insertSignal(values: typeof signals.$inferInsert): Promise<void> {
    await this.x.insert(signals).values(values).onConflictDoNothing();
  }
  signalsSince(scope: PropertyScope, since: Date): Promise<SignalRow[]> {
    return this.x
      .select()
      .from(signals)
      .where(
        and(
          eq(signals.tenantId, scope.tenantId),
          eq(signals.propertyId, scope.propertyId),
          gte(signals.occurredAt, since),
        ),
      )
      .orderBy(asc(signals.occurredAt), asc(signals.id));
  }
  /** Properties the engine has seen anything of (the twin), across tenants — for the scheduled sweep. */
  async activeProperties(): Promise<PropertyScope[]> {
    return this.x
      .selectDistinct({ tenantId: twinNodes.tenantId, propertyId: twinNodes.propertyId })
      .from(twinNodes)
      .orderBy(asc(twinNodes.tenantId), asc(twinNodes.propertyId));
  }

  // ---- insights ----
  live(scope: PropertyScope, detectors?: readonly string[]): Promise<InsightRow[]> {
    return this.x
      .select()
      .from(insights)
      .where(
        and(
          eq(insights.tenantId, scope.tenantId),
          eq(insights.propertyId, scope.propertyId),
          inArray(insights.status, LIVE),
          detectors ? inArray(insights.detector, [...detectors]) : undefined,
        ),
      );
  }
  /** The latest resolved or dismissed insight of a fingerprint (a re-detection must bring new evidence). */
  async lastClosed(
    scope: PropertyScope,
    detector: string,
    fingerprint: string,
  ): Promise<InsightRow | undefined> {
    const [row] = await this.x
      .select()
      .from(insights)
      .where(
        and(
          eq(insights.tenantId, scope.tenantId),
          eq(insights.propertyId, scope.propertyId),
          eq(insights.detector, detector),
          eq(insights.fingerprint, fingerprint),
          inArray(insights.status, ['RESOLVED', 'DISMISSED']),
        ),
      )
      .orderBy(desc(insights.updatedAt))
      .limit(1);
    return row;
  }
  async insertInsight(values: typeof insights.$inferInsert): Promise<InsightRow> {
    const [row] = await this.x.insert(insights).values(values).returning();
    return row!;
  }
  async updateInsight(
    id: string,
    version: number,
    values: Partial<
      Pick<
        InsightRow,
        | 'severity'
        | 'confidence'
        | 'reasonKey'
        | 'reasonParams'
        | 'evidence'
        | 'affected'
        | 'suggestedAction'
        | 'status'
        | 'lastSeenAt'
        | 'occurrences'
        | 'expiresAt'
      >
    >,
  ): Promise<InsightRow | undefined> {
    const [row] = await this.x
      .update(insights)
      .set({ ...values, version: version + 1, updatedAt: new Date() })
      .where(and(eq(insights.id, id), eq(insights.version, version)))
      .returning();
    return row;
  }
  async insight(scope: PropertyScope, id: string): Promise<InsightRow | undefined> {
    const [row] = await this.x
      .select()
      .from(insights)
      .where(
        and(
          eq(insights.tenantId, scope.tenantId),
          eq(insights.propertyId, scope.propertyId),
          eq(insights.id, id),
        ),
      );
    return row;
  }
  list(
    scope: PropertyScope,
    statuses: readonly InsightStatus[],
    limit: number,
  ): Promise<InsightRow[]> {
    return this.x
      .select()
      .from(insights)
      .where(
        and(
          eq(insights.tenantId, scope.tenantId),
          eq(insights.propertyId, scope.propertyId),
          inArray(insights.status, [...statuses]),
        ),
      )
      .orderBy(
        sql`case ${insights.severity} when 'HIGH' then 0 when 'MEDIUM' then 1 else 2 end`,
        desc(insights.lastSeenAt),
        asc(insights.id),
      )
      .limit(limit);
  }
  async insertHistory(values: typeof insightHistory.$inferInsert): Promise<void> {
    await this.x.insert(insightHistory).values(values);
  }
  history(scope: PropertyScope, insightId: string): Promise<InsightHistoryRow[]> {
    return this.x
      .select()
      .from(insightHistory)
      .where(
        and(eq(insightHistory.tenantId, scope.tenantId), eq(insightHistory.insightId, insightId)),
      )
      .orderBy(asc(insightHistory.at), asc(insightHistory.id));
  }
  /** Acting on or dismissing an insight is a recommendation signal (Spec §40); once per insight and kind. */
  async recordFeedback(values: typeof feedback.$inferInsert): Promise<void> {
    await this.x.insert(feedback).values(values).onConflictDoNothing();
  }

  // ---- pulse (BUILD_PLAN 12.5): counts over the AI context's own projection ----
  /** Open work items by department (from the twin). */
  async openWorkByDepartment(scope: PropertyScope): Promise<Record<string, number>> {
    const department = sql<string>`coalesce(${twinNodes.attributes}->>'department', 'NONE')`;
    const rows = await this.x
      .select({ department, n: sql<number>`count(*)::int` })
      .from(twinNodes)
      .where(
        and(
          eq(twinNodes.tenantId, scope.tenantId),
          eq(twinNodes.propertyId, scope.propertyId),
          eq(twinNodes.kind, 'WORK_ITEM'),
          inArray(twinNodes.state, ['OPEN', 'IN_PROGRESS']),
        ),
      )
      .groupBy(department);
    return Object.fromEntries(rows.map((r) => [r.department, r.n]));
  }
  /** Things of a kind in a state, by one of their codes (e.g. open complaints by severity). */
  async countBy(
    scope: PropertyScope,
    kind: 'COMPLAINT' | 'LOCATION',
    where: { readonly state?: string; readonly attributeSet?: string },
    by: string,
  ): Promise<Record<string, number>> {
    const code = sql<string>`coalesce(${twinNodes.attributes}->>${codeKey(by)}, 'NONE')`;
    const rows = await this.x
      .select({ code, n: sql<number>`count(*)::int` })
      .from(twinNodes)
      .where(
        and(
          eq(twinNodes.tenantId, scope.tenantId),
          eq(twinNodes.propertyId, scope.propertyId),
          eq(twinNodes.kind, kind),
          where.state ? eq(twinNodes.state, where.state) : undefined,
          where.attributeSet
            ? sql`${twinNodes.attributes}->>${codeKey(where.attributeSet)} is not null`
            : undefined,
        ),
      )
      .groupBy(code);
    return Object.fromEntries(rows.map((r) => [r.code, r.n]));
  }
  /** Signals of a kind since a moment, by one of their codes. */
  async signalsBy(
    scope: PropertyScope,
    signal: string,
    since: Date,
    by: string,
  ): Promise<Record<string, number>> {
    const code = sql<string>`coalesce(${signals.codes}->>${codeKey(by)}, 'NONE')`;
    const rows = await this.x
      .select({ code, n: sql<number>`count(*)::int` })
      .from(signals)
      .where(
        and(
          eq(signals.tenantId, scope.tenantId),
          eq(signals.propertyId, scope.propertyId),
          eq(signals.signal, signal),
          gte(signals.occurredAt, since),
        ),
      )
      .groupBy(code);
    return Object.fromEntries(rows.map((r) => [r.code, r.n]));
  }
}
