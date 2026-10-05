import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type PropertyScope,
  propertyWhere,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import { roomAssignments, stayCharges, stays, type StayChargeRow, type StayRow } from './schema';

/** Spend facts of stays (BUILD_PLAN 13.5). */
@Injectable()
export class SpendRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  /** Records a charge once per source event; undefined for a repeat. */
  async insert(values: typeof stayCharges.$inferInsert): Promise<StayChargeRow | undefined> {
    const [row] = await this.x.insert(stayCharges).values(values).onConflictDoNothing().returning();
    return row;
  }

  chargesOf(scope: TenantScope, stayId: string): Promise<StayChargeRow[]> {
    return this.x
      .select()
      .from(stayCharges)
      .where(tenantWhere(stayCharges, scope, eq(stayCharges.stayId, stayId)))
      .orderBy(asc(stayCharges.closedAt));
  }

  /**
   * The stays that were in a room at an instant (the assignment history covers it; rule 10 keeps it) — the caller
   * decides what to do unless there is exactly one.
   */
  async staysInRoomAt(scope: PropertyScope, roomId: string, at: Date): Promise<StayRow[]> {
    const rows = await this.x
      .select({ stay: stays })
      .from(roomAssignments)
      .innerJoin(stays, eq(stays.id, roomAssignments.stayId))
      .where(
        propertyWhere(
          roomAssignments,
          scope,
          eq(roomAssignments.roomId, roomId),
          lte(roomAssignments.assignedAt, at),
          or(isNull(roomAssignments.unassignedAt), gt(roomAssignments.unassignedAt, at)),
          and(eq(stays.tenantId, scope.tenantId), sql`${stays.status} <> 'EXPECTED'`),
        ),
      );
    return [...new Map(rows.map((r) => [r.stay.id, r.stay])).values()];
  }
}
