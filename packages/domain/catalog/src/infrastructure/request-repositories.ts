import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
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
  type RequestEventRow,
  type RequestRow,
  serviceRequestEvents,
  serviceRequests,
} from './schema';

export type RequestStatus = RequestRow['status'];
export const OPEN_STATUSES: readonly RequestStatus[] = ['OPEN', 'IN_PROGRESS'];

export interface BoardFilter {
  readonly status?: readonly RequestStatus[];
  readonly serviceCode?: string;
  readonly stayId?: string;
  /** Keyset pagination: requests created before this id (UUIDv7 ids sort by time). */
  readonly before?: string;
  readonly limit: number;
}

/** Service requests and their history; every query is tenant-scoped (CLAUDE.md rule 1). */
@Injectable()
export class RequestRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  /**
   * Serializes requests of one stay for one service for the rest of the transaction, so two concurrent asks cannot
   * both create (duplicate detection, Spec §23). An advisory lock: there may be no row to lock yet.
   */
  async lockStayService(stayId: string, definitionId: string): Promise<void> {
    await this.x.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`catalog.request:${stayId}:${definitionId}`}, 0))`,
    );
  }

  async insert(values: typeof serviceRequests.$inferInsert): Promise<RequestRow> {
    const [row] = await this.x.insert(serviceRequests).values(values).returning();
    return row!;
  }
  get(scope: TenantScope, id: string): Promise<RequestRow | undefined> {
    return this.x
      .select()
      .from(serviceRequests)
      .where(tenantWhere(serviceRequests, scope, eq(serviceRequests.id, id)))
      .then((r) => r[0]);
  }
  getForUpdate(scope: TenantScope, id: string): Promise<RequestRow | undefined> {
    return this.x
      .select()
      .from(serviceRequests)
      .where(tenantWhere(serviceRequests, scope, eq(serviceRequests.id, id)))
      .for('update')
      .then((r) => r[0]);
  }
  /** The newest open request of the stay for this service created since `since`. */
  openSince(
    scope: TenantScope,
    stayId: string,
    definitionId: string,
    since: Date,
  ): Promise<RequestRow | undefined> {
    return this.x
      .select()
      .from(serviceRequests)
      .where(
        tenantWhere(
          serviceRequests,
          scope,
          eq(serviceRequests.stayId, stayId),
          eq(serviceRequests.definitionId, definitionId),
          inArray(serviceRequests.status, [...OPEN_STATUSES]),
          gte(serviceRequests.createdAt, since),
        ),
      )
      .orderBy(desc(serviceRequests.id))
      .limit(1)
      .then((r) => r[0]);
  }
  /** Requests (not cancelled) of the stay for this service created in [from, to). */
  async countBetween(
    scope: TenantScope,
    stayId: string,
    definitionId: string,
    from: Date,
    to: Date,
  ): Promise<number> {
    const [row] = await this.x
      .select({ n: sql<number>`count(*)::int` })
      .from(serviceRequests)
      .where(
        tenantWhere(
          serviceRequests,
          scope,
          eq(serviceRequests.stayId, stayId),
          eq(serviceRequests.definitionId, definitionId),
          ne(serviceRequests.status, 'CANCELLED'),
          gte(serviceRequests.createdAt, from),
          lt(serviceRequests.createdAt, to),
        ),
      );
    return row?.n ?? 0;
  }
  async update(
    scope: TenantScope,
    id: string,
    values: Partial<typeof serviceRequests.$inferInsert>,
  ): Promise<RequestRow> {
    const [row] = await this.x
      .update(serviceRequests)
      .set({ ...values, version: sql`${serviceRequests.version} + 1` })
      .where(tenantWhere(serviceRequests, scope, eq(serviceRequests.id, id)))
      .returning();
    return row!;
  }
  byWorkItem(scope: TenantScope, workItemId: string): Promise<RequestRow | undefined> {
    return this.x
      .select()
      .from(serviceRequests)
      .where(tenantWhere(serviceRequests, scope, eq(serviceRequests.workItemId, workItemId)))
      .then((r) => r[0]);
  }
  board(scope: PropertyScope, filter: BoardFilter): Promise<RequestRow[]> {
    return this.x
      .select()
      .from(serviceRequests)
      .where(
        propertyWhere(
          serviceRequests,
          scope,
          filter.status?.length ? inArray(serviceRequests.status, [...filter.status]) : undefined,
          filter.serviceCode ? eq(serviceRequests.serviceCode, filter.serviceCode) : undefined,
          filter.stayId ? eq(serviceRequests.stayId, filter.stayId) : undefined,
          filter.before ? lt(serviceRequests.id, filter.before) : undefined,
        ),
      )
      .orderBy(desc(serviceRequests.id))
      .limit(filter.limit);
  }
  /** A guest's view: their own requests of the stay, or (`all`) the whole stay's. */
  ofStay(scope: TenantScope, stayId: string, guestId: string | null): Promise<RequestRow[]> {
    return this.x
      .select()
      .from(serviceRequests)
      .where(
        tenantWhere(
          serviceRequests,
          scope,
          eq(serviceRequests.stayId, stayId),
          guestId ? eq(serviceRequests.guestId, guestId) : undefined,
        ),
      )
      .orderBy(desc(serviceRequests.id))
      .limit(200);
  }
  openOfStay(scope: TenantScope, stayId: string, statuses: readonly RequestStatus[]) {
    return this.x
      .select()
      .from(serviceRequests)
      .where(
        tenantWhere(
          serviceRequests,
          scope,
          eq(serviceRequests.stayId, stayId),
          inArray(serviceRequests.status, [...statuses]),
        ),
      );
  }
  ofGuest(scope: TenantScope, guestId: string): Promise<RequestRow[]> {
    return this.x
      .select()
      .from(serviceRequests)
      .where(tenantWhere(serviceRequests, scope, eq(serviceRequests.guestId, guestId)));
  }

  // ---- history ----
  async insertEvent(values: typeof serviceRequestEvents.$inferInsert): Promise<RequestEventRow> {
    const [row] = await this.x.insert(serviceRequestEvents).values(values).returning();
    return row!;
  }
  eventsOf(scope: TenantScope, requestId: string): Promise<RequestEventRow[]> {
    return this.x
      .select()
      .from(serviceRequestEvents)
      .where(
        tenantWhere(serviceRequestEvents, scope, eq(serviceRequestEvents.requestId, requestId)),
      )
      .orderBy(serviceRequestEvents.id);
  }
  /** History rows written by a guest (their related asks carry their words). */
  eventsByActor(scope: TenantScope, actorId: string): Promise<RequestEventRow[]> {
    return this.x
      .select()
      .from(serviceRequestEvents)
      .where(
        tenantWhere(
          serviceRequestEvents,
          scope,
          and(
            eq(serviceRequestEvents.actorType, 'GUEST'),
            eq(serviceRequestEvents.actorId, actorId),
          ),
        ),
      );
  }
  async setEventText(
    scope: TenantScope,
    id: string,
    values: { fields?: Record<string, unknown> | null; reason?: null },
  ): Promise<void> {
    await this.x
      .update(serviceRequestEvents)
      .set(values)
      .where(tenantWhere(serviceRequestEvents, scope, eq(serviceRequestEvents.id, id)));
  }
}
