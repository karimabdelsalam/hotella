import { Inject, Injectable } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type PropertyScope,
  propertyWhere,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import { requisitions, type RequisitionRow } from './schema';

/** Part requisitions (BUILD_PLAN 13.5). */
@Injectable()
export class RequisitionRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  async insert(values: typeof requisitions.$inferInsert): Promise<RequisitionRow> {
    const [row] = await this.x.insert(requisitions).values(values).returning();
    return row!;
  }

  async update(
    scope: TenantScope,
    id: string,
    values: Partial<typeof requisitions.$inferInsert>,
  ): Promise<RequisitionRow> {
    const [row] = await this.x
      .update(requisitions)
      .set({ ...values, version: sql`${requisitions.version} + 1`, updatedAt: new Date() })
      .where(tenantWhere(requisitions, scope, eq(requisitions.id, id)))
      .returning();
    return row!;
  }

  forUpdate(scope: TenantScope, id: string): Promise<RequisitionRow | undefined> {
    return this.x
      .select()
      .from(requisitions)
      .where(tenantWhere(requisitions, scope, eq(requisitions.id, id)))
      .for('update')
      .then((r) => r[0]);
  }

  ofApproval(scope: TenantScope, approvalId: string): Promise<RequisitionRow | undefined> {
    return this.x
      .select()
      .from(requisitions)
      .where(tenantWhere(requisitions, scope, eq(requisitions.approvalId, approvalId)))
      .for('update')
      .then((r) => r[0]);
  }

  list(scope: PropertyScope, limit: number): Promise<RequisitionRow[]> {
    return this.x
      .select()
      .from(requisitions)
      .where(propertyWhere(requisitions, scope))
      .orderBy(desc(requisitions.createdAt))
      .limit(limit);
  }
}
