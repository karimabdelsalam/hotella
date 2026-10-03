import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
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
}
