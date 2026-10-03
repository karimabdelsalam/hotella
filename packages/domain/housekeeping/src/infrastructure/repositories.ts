import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
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
  type CreditRuleRow,
  creditRules,
  inspections,
  type JobRow,
  jobs,
  type RoomSignalRow,
  roomSignals,
  roomStateEvents,
  type RoomStateRow,
  roomStates,
} from './schema';

@Injectable()
export class HousekeepingRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- room states ----
  /** The room's state row, created (VACANT, DIRTY) on first touch, locked for the caller's transaction. */
  async stateForUpdate(scope: PropertyScope, roomId: string): Promise<RoomStateRow> {
    await this.x
      .insert(roomStates)
      .values({ roomId, tenantId: scope.tenantId, propertyId: scope.propertyId })
      .onConflictDoNothing();
    const [row] = await this.x
      .select()
      .from(roomStates)
      .where(tenantWhere(roomStates, scope, eq(roomStates.roomId, roomId)))
      .for('update');
    return row!;
  }
  async updateState(
    scope: TenantScope,
    roomId: string,
    patch: Partial<
      Pick<
        RoomStateRow,
        | 'occupancy'
        | 'housekeeping'
        | 'frontOffice'
        | 'lastCleanedAt'
        | 'lastInspectedAt'
        | 'lastPmsEventAt'
      >
    >,
  ): Promise<RoomStateRow> {
    const [row] = await this.x
      .update(roomStates)
      .set({ ...patch, updatedAt: new Date(), version: sql`${roomStates.version} + 1` })
      .where(tenantWhere(roomStates, scope, eq(roomStates.roomId, roomId)))
      .returning();
    return row!;
  }
  statesOf(scope: PropertyScope): Promise<RoomStateRow[]> {
    return this.x.select().from(roomStates).where(propertyWhere(roomStates, scope));
  }
  async state(scope: TenantScope, roomId: string): Promise<RoomStateRow | undefined> {
    const [row] = await this.x
      .select()
      .from(roomStates)
      .where(tenantWhere(roomStates, scope, eq(roomStates.roomId, roomId)));
    return row;
  }
  async insertStateEvent(values: typeof roomStateEvents.$inferInsert): Promise<void> {
    await this.x.insert(roomStateEvents).values(values);
  }
  history(scope: TenantScope, roomId: string, limit: number) {
    return this.x
      .select()
      .from(roomStateEvents)
      .where(tenantWhere(roomStateEvents, scope, eq(roomStateEvents.roomId, roomId)))
      .orderBy(desc(roomStateEvents.occurredAt), desc(roomStateEvents.id))
      .limit(limit);
  }

  // ---- signals ----
  openSignals(scope: PropertyScope): Promise<RoomSignalRow[]> {
    return this.x
      .select()
      .from(roomSignals)
      .where(propertyWhere(roomSignals, scope, isNull(roomSignals.endedAt)));
  }
  async openSignal(
    scope: TenantScope,
    roomId: string,
    signal: RoomSignalRow['signal'],
  ): Promise<RoomSignalRow | undefined> {
    const [row] = await this.x
      .select()
      .from(roomSignals)
      .where(
        tenantWhere(
          roomSignals,
          scope,
          and(
            eq(roomSignals.roomId, roomId),
            eq(roomSignals.signal, signal),
            isNull(roomSignals.endedAt),
          ),
        ),
      )
      .for('update');
    return row;
  }
  async insertSignal(values: typeof roomSignals.$inferInsert): Promise<void> {
    await this.x.insert(roomSignals).values(values);
  }
  async endSignal(
    scope: TenantScope,
    id: string,
    by: { type: string; id: string | null },
    at: Date,
  ): Promise<void> {
    await this.x
      .update(roomSignals)
      .set({ endedAt: at, endedByType: by.type, endedById: by.id })
      .where(tenantWhere(roomSignals, scope, eq(roomSignals.id, id)));
  }

  // ---- jobs ----
  /** Inserts a job; a generated job that already exists for (room, type, day) returns undefined. */
  async insertJob(values: typeof jobs.$inferInsert): Promise<JobRow | undefined> {
    const [row] = await this.x.insert(jobs).values(values).onConflictDoNothing().returning();
    return row;
  }
  async jobForUpdate(scope: TenantScope, id: string): Promise<JobRow | undefined> {
    const [row] = await this.x
      .select()
      .from(jobs)
      .where(tenantWhere(jobs, scope, eq(jobs.id, id)))
      .for('update');
    return row;
  }
  async jobOfWorkItem(scope: TenantScope, workItemId: string): Promise<JobRow | undefined> {
    const [row] = await this.x
      .select()
      .from(jobs)
      .where(tenantWhere(jobs, scope, eq(jobs.workItemId, workItemId)))
      .for('update');
    return row;
  }
  async updateJob(
    scope: TenantScope,
    id: string,
    patch: Partial<
      Pick<
        JobRow,
        'workItemId' | 'status' | 'startedAt' | 'completedAt' | 'inspectedAt' | 'skipReason'
      >
    >,
  ): Promise<JobRow> {
    const [row] = await this.x
      .update(jobs)
      .set({ ...patch, updatedAt: new Date(), version: sql`${jobs.version} + 1` })
      .where(tenantWhere(jobs, scope, eq(jobs.id, id)))
      .returning();
    return row!;
  }
  jobsOf(scope: PropertyScope, filter: { day?: string; statuses?: readonly JobRow['status'][] }) {
    return this.x
      .select()
      .from(jobs)
      .where(
        propertyWhere(
          jobs,
          scope,
          filter.day ? eq(jobs.scheduledFor, filter.day) : undefined,
          filter.statuses?.length ? inArray(jobs.status, [...filter.statuses]) : undefined,
        ),
      )
      .orderBy(asc(jobs.scheduledFor), asc(jobs.id));
  }
  async insertInspection(values: typeof inspections.$inferInsert): Promise<void> {
    await this.x.insert(inspections).values(values);
  }

  // ---- credit rules ----
  creditRules(scope: PropertyScope): Promise<CreditRuleRow[]> {
    return this.x
      .select()
      .from(creditRules)
      .where(propertyWhere(creditRules, scope))
      .orderBy(asc(creditRules.cleaningType));
  }
  /** Sets the credits of (type, room type) for the property: updates the rule or creates it. */
  async putCreditRule(
    scope: PropertyScope,
    rule: {
      id: string;
      cleaningType: CreditRuleRow['cleaningType'];
      roomTypeId: string | null;
      credits: number;
    },
  ): Promise<CreditRuleRow> {
    const [existing] = await this.x
      .select()
      .from(creditRules)
      .where(
        propertyWhere(
          creditRules,
          scope,
          eq(creditRules.cleaningType, rule.cleaningType),
          rule.roomTypeId
            ? eq(creditRules.roomTypeId, rule.roomTypeId)
            : isNull(creditRules.roomTypeId),
        ),
      )
      .for('update');
    if (existing) {
      const [row] = await this.x
        .update(creditRules)
        .set({
          credits: rule.credits,
          updatedAt: new Date(),
          version: sql`${creditRules.version} + 1`,
        })
        .where(eq(creditRules.id, existing.id))
        .returning();
      return row!;
    }
    const [row] = await this.x
      .insert(creditRules)
      .values({ ...rule, tenantId: scope.tenantId, propertyId: scope.propertyId })
      .returning();
    return row!;
  }

  // ---- the daily sweep (all tenants: the worker runs it without a tenant) ----
  occupiedRooms() {
    return this.x
      .select({
        tenantId: roomStates.tenantId,
        propertyId: roomStates.propertyId,
        roomId: roomStates.roomId,
      })
      .from(roomStates)
      .where(eq(roomStates.occupancy, 'OCCUPIED'))
      .orderBy(asc(roomStates.tenantId), asc(roomStates.propertyId), asc(roomStates.roomId));
  }
}
