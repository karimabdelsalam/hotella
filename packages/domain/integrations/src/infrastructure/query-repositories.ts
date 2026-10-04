import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import { integrationQueries, type IntegrationQueryRow } from './schema';

/** Predefined reads over link protocol 2 (ADR-0019, BUILD_PLAN 10.7). */
@Injectable()
export class QueryRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  async insert(values: typeof integrationQueries.$inferInsert): Promise<IntegrationQueryRow> {
    const [row] = await this.x.insert(integrationQueries).values(values).returning();
    return row!;
  }

  query(scope: TenantScope, id: string): Promise<IntegrationQueryRow | undefined> {
    return this.x
      .select()
      .from(integrationQueries)
      .where(tenantWhere(integrationQueries, scope, eq(integrationQueries.id, id)))
      .then((r) => r[0]);
  }

  /** Past their deadline before an answer: EXPIRED (the asker has stopped waiting). */
  async expire(scope: TenantScope, instanceId: string, now: Date): Promise<number> {
    const rows = await this.x
      .update(integrationQueries)
      .set({ status: 'EXPIRED', updatedAt: now })
      .where(
        tenantWhere(
          integrationQueries,
          scope,
          eq(integrationQueries.instanceId, instanceId),
          inArray(integrationQueries.status, ['PENDING', 'SENT']),
          lte(integrationQueries.deadlineAt, now),
        ),
      )
      .returning({ id: integrationQueries.id });
    return rows.length;
  }

  /** Waiting queries of an instance, oldest first, marked SENT in the same step. */
  async takePending(
    scope: TenantScope,
    instanceId: string,
    now: Date,
  ): Promise<IntegrationQueryRow[]> {
    const pending = await this.x
      .select()
      .from(integrationQueries)
      .where(
        tenantWhere(
          integrationQueries,
          scope,
          eq(integrationQueries.instanceId, instanceId),
          eq(integrationQueries.status, 'PENDING'),
        ),
      )
      .orderBy(asc(integrationQueries.createdAt))
      .limit(20)
      .for('update', { skipLocked: true });
    if (pending.length === 0) return [];
    await this.x
      .update(integrationQueries)
      .set({ status: 'SENT', sentAt: now, updatedAt: now })
      .where(
        inArray(
          integrationQueries.id,
          pending.map((q) => q.id),
        ),
      );
    return pending;
  }

  /** The agent's answer, once: a query already settled is left as it is. */
  async settle(
    scope: TenantScope,
    id: string,
    set: {
      readonly status: 'ANSWERED' | 'FAILED';
      readonly rows: readonly unknown[] | null;
      readonly truncated: boolean;
      readonly error: string | null;
    },
  ): Promise<boolean> {
    const now = new Date();
    const rows = await this.x
      .update(integrationQueries)
      .set({
        status: set.status,
        answeredAt: now,
        updatedAt: now,
        rowCount: set.rows?.length ?? null,
        truncated: set.truncated,
        result: set.status === 'ANSWERED' ? (set.rows ?? []) : null,
        error: set.error,
      })
      .where(
        tenantWhere(
          integrationQueries,
          scope,
          eq(integrationQueries.id, id),
          inArray(integrationQueries.status, ['PENDING', 'SENT']),
        ),
      )
      .returning({ id: integrationQueries.id });
    return rows.length > 0;
  }

  /** The asker takes the answer: rows are returned and cleared in one statement. */
  async takeResult(scope: TenantScope, id: string): Promise<IntegrationQueryRow | undefined> {
    const current = await this.query(scope, id);
    if (!current || current.status !== 'ANSWERED' || current.result === null) return current;
    await this.x
      .update(integrationQueries)
      .set({ result: null, updatedAt: new Date() })
      .where(tenantWhere(integrationQueries, scope, eq(integrationQueries.id, id)));
    return current;
  }

  /** Answers nobody took and queries nobody answered (worker sweep, across tenants). */
  async sweep(now: Date, keepResultsMs: number): Promise<{ cleared: number; expired: number }> {
    const cleared = await this.x
      .update(integrationQueries)
      .set({ result: null, updatedAt: now })
      .where(
        and(
          isNotNull(integrationQueries.result),
          lt(integrationQueries.answeredAt, new Date(now.getTime() - keepResultsMs)),
        ),
      )
      .returning({ id: integrationQueries.id });
    const expired = await this.x
      .update(integrationQueries)
      .set({ status: 'EXPIRED', updatedAt: now })
      .where(
        and(
          or(eq(integrationQueries.status, 'PENDING'), eq(integrationQueries.status, 'SENT')),
          lte(integrationQueries.deadlineAt, now),
        ),
      )
      .returning({ id: integrationQueries.id });
    return { cleared: cleared.length, expired: expired.length };
  }

  /** Request log of a property for support (never the answers). */
  recent(scope: TenantScope & { propertyId: string }, limit: number) {
    return this.x
      .select({
        id: integrationQueries.id,
        instanceId: integrationQueries.instanceId,
        queryType: integrationQueries.queryType,
        status: integrationQueries.status,
        rowCount: integrationQueries.rowCount,
        truncated: integrationQueries.truncated,
        error: integrationQueries.error,
        routing: integrationQueries.routing,
        createdAt: integrationQueries.createdAt,
        answeredAt: integrationQueries.answeredAt,
      })
      .from(integrationQueries)
      .where(
        tenantWhere(integrationQueries, scope, eq(integrationQueries.propertyId, scope.propertyId)),
      )
      .orderBy(sql`${integrationQueries.createdAt} desc`)
      .limit(limit);
  }
}
