import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, inArray, or } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import { accessGrantEvents, type AccessGrantRow, accessGrants } from './schema';

/** Stay-bound access storage (BUILD_PLAN 13.3): grants and their append-only history. */
@Injectable()
export class AccessRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  async insertGrant(values: typeof accessGrants.$inferInsert): Promise<AccessGrantRow> {
    const [row] = await this.x.insert(accessGrants).values(values).returning();
    return row!;
  }
  async grant(scope: TenantScope, id: string): Promise<AccessGrantRow | undefined> {
    const [row] = await this.x
      .select()
      .from(accessGrants)
      .where(tenantWhere(accessGrants, scope, eq(accessGrants.id, id)))
      .for('update');
    return row;
  }
  grantsOfStay(scope: TenantScope, stayId: string): Promise<AccessGrantRow[]> {
    return this.x
      .select()
      .from(accessGrants)
      .where(tenantWhere(accessGrants, scope, eq(accessGrants.stayId, stayId)))
      .orderBy(asc(accessGrants.id));
  }
  liveGrantsOfStay(scope: TenantScope, stayId: string): Promise<AccessGrantRow[]> {
    return this.x
      .select()
      .from(accessGrants)
      .where(
        tenantWhere(
          accessGrants,
          scope,
          eq(accessGrants.stayId, stayId),
          inArray(accessGrants.status, ['REQUESTED', 'ISSUED']),
        ),
      )
      .orderBy(asc(accessGrants.id))
      .for('update');
  }
  async grantOfCommand(scope: TenantScope, commandId: string): Promise<AccessGrantRow | undefined> {
    const [row] = await this.x
      .select()
      .from(accessGrants)
      .where(
        tenantWhere(
          accessGrants,
          scope,
          or(
            eq(accessGrants.issueCommandId, commandId),
            eq(accessGrants.revokeCommandId, commandId),
          ),
        ),
      )
      .for('update');
    return row;
  }
  async updateGrant(
    scope: TenantScope,
    row: AccessGrantRow,
    values: Partial<
      Pick<
        AccessGrantRow,
        | 'status'
        | 'issueCommandId'
        | 'revokeCommandId'
        | 'issuedAt'
        | 'revokedAt'
        | 'revokeReason'
        | 'failure'
      >
    >,
  ): Promise<AccessGrantRow> {
    const [updated] = await this.x
      .update(accessGrants)
      .set({ ...values, version: row.version + 1 })
      .where(tenantWhere(accessGrants, scope, eq(accessGrants.id, row.id)))
      .returning();
    return updated!;
  }
  async insertEvent(values: typeof accessGrantEvents.$inferInsert): Promise<void> {
    await this.x.insert(accessGrantEvents).values(values);
  }
}
