import { Inject, Injectable } from '@nestjs/common';
import { asc, desc, eq, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type PropertyScope,
  propertyWhere,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import type { Shift } from '../domain/shifts';
import { entries, type EntryRow, handovers, type HandoverRow } from './schema';

@Injectable()
export class LogbookRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  async insertEntry(values: typeof entries.$inferInsert): Promise<EntryRow> {
    const [row] = await this.x.insert(entries).values(values).returning();
    return row!;
  }
  async entry(scope: TenantScope, id: string): Promise<EntryRow | undefined> {
    const [row] = await this.x
      .select()
      .from(entries)
      .where(tenantWhere(entries, scope, eq(entries.id, id)));
    return row;
  }
  entriesOf(
    scope: PropertyScope,
    departmentCode: string,
    shiftDate: string,
    shiftName: Shift,
  ): Promise<EntryRow[]> {
    return this.x
      .select()
      .from(entries)
      .where(
        propertyWhere(
          entries,
          scope,
          eq(entries.departmentCode, departmentCode),
          eq(entries.shiftDate, shiftDate),
          eq(entries.shift, shiftName),
        ),
      )
      .orderBy(asc(entries.id));
  }

  async handoverFor(
    scope: PropertyScope,
    departmentCode: string,
    shiftDate: string,
    shiftName: Shift,
    lock = false,
  ): Promise<HandoverRow | undefined> {
    const q = this.x
      .select()
      .from(handovers)
      .where(
        propertyWhere(
          handovers,
          scope,
          eq(handovers.departmentCode, departmentCode),
          eq(handovers.shiftDate, shiftDate),
          eq(handovers.shift, shiftName),
        ),
      );
    const [row] = lock ? await q.for('update') : await q;
    return row;
  }
  async handover(scope: TenantScope, id: string, lock = false): Promise<HandoverRow | undefined> {
    const q = this.x
      .select()
      .from(handovers)
      .where(tenantWhere(handovers, scope, eq(handovers.id, id)));
    const [row] = lock ? await q.for('update') : await q;
    return row;
  }
  async insertHandover(values: typeof handovers.$inferInsert): Promise<HandoverRow> {
    const [row] = await this.x.insert(handovers).values(values).returning();
    return row!;
  }
  async updateHandover(
    scope: TenantScope,
    id: string,
    patch: Partial<
      Pick<
        HandoverRow,
        | 'summary'
        | 'facts'
        | 'source'
        | 'edited'
        | 'executionId'
        | 'status'
        | 'draftedByType'
        | 'draftedById'
        | 'acknowledgedById'
        | 'acknowledgedAt'
        | 'acknowledgementNote'
      >
    >,
  ): Promise<HandoverRow> {
    const [row] = await this.x
      .update(handovers)
      .set({ ...patch, updatedAt: new Date(), version: sql`${handovers.version} + 1` })
      .where(tenantWhere(handovers, scope, eq(handovers.id, id)))
      .returning();
    return row!;
  }
  handoversOf(scope: PropertyScope, departmentCode?: string): Promise<HandoverRow[]> {
    return this.x
      .select()
      .from(handovers)
      .where(
        propertyWhere(
          handovers,
          scope,
          ...(departmentCode ? [eq(handovers.departmentCode, departmentCode)] : []),
        ),
      )
      .orderBy(desc(handovers.shiftDate), desc(handovers.id))
      .limit(60);
  }
}
