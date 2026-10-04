import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lte, type SQL, sql } from 'drizzle-orm';
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
  approvalRequests,
  workflowDefinitions,
  workflowInstances,
  workflowTransitions,
  workflowVersions,
  type ApprovalRequestRow,
  type WorkflowDefinitionRow,
  type WorkflowInstanceRow,
  type WorkflowTransitionRow,
  type WorkflowVersionRow,
} from './schema';

/** Tenant-filtered data access for workflows and approvals (CLAUDE.md rule 1). */
@Injectable()
export class WorkflowRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- definitions & versions ----
  async insertDefinition(
    values: typeof workflowDefinitions.$inferInsert,
  ): Promise<WorkflowDefinitionRow> {
    const [row] = await this.x.insert(workflowDefinitions).values(values).returning();
    return row!;
  }
  definitionByCode(scope: PropertyScope, code: string): Promise<WorkflowDefinitionRow | undefined> {
    return this.x
      .select()
      .from(workflowDefinitions)
      .where(propertyWhere(workflowDefinitions, scope, eq(workflowDefinitions.code, code)))
      .then((r) => r[0]);
  }
  definitionByCodeForUpdate(
    scope: PropertyScope,
    code: string,
  ): Promise<WorkflowDefinitionRow | undefined> {
    return this.x
      .select()
      .from(workflowDefinitions)
      .where(propertyWhere(workflowDefinitions, scope, eq(workflowDefinitions.code, code)))
      .for('update')
      .then((r) => r[0]);
  }
  listDefinitions(scope: PropertyScope): Promise<WorkflowDefinitionRow[]> {
    return this.x
      .select()
      .from(workflowDefinitions)
      .where(propertyWhere(workflowDefinitions, scope))
      .orderBy(asc(workflowDefinitions.code));
  }
  async insertVersion(values: typeof workflowVersions.$inferInsert): Promise<WorkflowVersionRow> {
    const [row] = await this.x.insert(workflowVersions).values(values).returning();
    return row!;
  }
  versions(scope: TenantScope, definitionIds: readonly string[]): Promise<WorkflowVersionRow[]> {
    if (definitionIds.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(workflowVersions)
      .where(
        tenantWhere(
          workflowVersions,
          scope,
          inArray(workflowVersions.definitionId, [...definitionIds]),
        ),
      )
      .orderBy(asc(workflowVersions.definitionId), asc(workflowVersions.version));
  }
  versionById(scope: TenantScope, id: string): Promise<WorkflowVersionRow | undefined> {
    return this.x
      .select()
      .from(workflowVersions)
      .where(tenantWhere(workflowVersions, scope, eq(workflowVersions.id, id)))
      .then((r) => r[0]);
  }
  async updateVersion(
    scope: TenantScope,
    id: string,
    values: Partial<typeof workflowVersions.$inferInsert>,
  ): Promise<WorkflowVersionRow> {
    const [row] = await this.x
      .update(workflowVersions)
      .set(values)
      .where(tenantWhere(workflowVersions, scope, eq(workflowVersions.id, id)))
      .returning();
    return row!;
  }
  /** The version new work starts on: the latest published one. */
  publishedVersion(
    scope: TenantScope,
    definitionId: string,
  ): Promise<WorkflowVersionRow | undefined> {
    return this.x
      .select()
      .from(workflowVersions)
      .where(
        tenantWhere(
          workflowVersions,
          scope,
          eq(workflowVersions.definitionId, definitionId),
          eq(workflowVersions.status, 'PUBLISHED'),
        ),
      )
      .orderBy(desc(workflowVersions.version))
      .limit(1)
      .then((r) => r[0]);
  }

  // ---- instances & transitions ----
  async insertInstance(
    values: typeof workflowInstances.$inferInsert,
  ): Promise<WorkflowInstanceRow> {
    const [row] = await this.x.insert(workflowInstances).values(values).returning();
    return row!;
  }
  instanceOfWorkItem(
    scope: TenantScope,
    workItemId: string,
  ): Promise<WorkflowInstanceRow | undefined> {
    return this.x
      .select()
      .from(workflowInstances)
      .where(tenantWhere(workflowInstances, scope, eq(workflowInstances.workItemId, workItemId)))
      .then((r) => r[0]);
  }
  instanceOfWorkItemForUpdate(
    scope: TenantScope,
    workItemId: string,
  ): Promise<WorkflowInstanceRow | undefined> {
    return this.x
      .select()
      .from(workflowInstances)
      .where(tenantWhere(workflowInstances, scope, eq(workflowInstances.workItemId, workItemId)))
      .for('update')
      .then((r) => r[0]);
  }
  async updateInstance(
    scope: TenantScope,
    id: string,
    values: Partial<typeof workflowInstances.$inferInsert>,
  ): Promise<WorkflowInstanceRow> {
    const [row] = await this.x
      .update(workflowInstances)
      .set({ ...values, version: sql`${workflowInstances.version} + 1` })
      .where(tenantWhere(workflowInstances, scope, eq(workflowInstances.id, id)))
      .returning();
    return row!;
  }
  async insertTransition(values: typeof workflowTransitions.$inferInsert): Promise<void> {
    await this.x.insert(workflowTransitions).values(values);
  }
  transitions(scope: TenantScope, instanceId: string): Promise<WorkflowTransitionRow[]> {
    return this.x
      .select()
      .from(workflowTransitions)
      .where(
        tenantWhere(workflowTransitions, scope, eq(workflowTransitions.instanceId, instanceId)),
      )
      .orderBy(asc(workflowTransitions.occurredAt), asc(workflowTransitions.id));
  }

  // ---- approvals ----
  async insertApproval(values: typeof approvalRequests.$inferInsert): Promise<ApprovalRequestRow> {
    const [row] = await this.x.insert(approvalRequests).values(values).returning();
    return row!;
  }
  approval(scope: TenantScope, id: string): Promise<ApprovalRequestRow | undefined> {
    return this.x
      .select()
      .from(approvalRequests)
      .where(tenantWhere(approvalRequests, scope, eq(approvalRequests.id, id)))
      .then((r) => r[0]);
  }
  approvalForUpdate(scope: TenantScope, id: string): Promise<ApprovalRequestRow | undefined> {
    return this.x
      .select()
      .from(approvalRequests)
      .where(tenantWhere(approvalRequests, scope, eq(approvalRequests.id, id)))
      .for('update')
      .then((r) => r[0]);
  }
  async updateApproval(
    scope: TenantScope,
    id: string,
    values: Partial<typeof approvalRequests.$inferInsert>,
  ): Promise<ApprovalRequestRow> {
    const [row] = await this.x
      .update(approvalRequests)
      .set({ ...values, version: sql`${approvalRequests.version} + 1` })
      .where(tenantWhere(approvalRequests, scope, eq(approvalRequests.id, id)))
      .returning();
    return row!;
  }
  listApprovals(
    scope: PropertyScope,
    filter: { status?: readonly ApprovalRequestRow['status'][]; limit: number },
  ): Promise<ApprovalRequestRow[]> {
    const conditions: SQL[] = [];
    if (filter.status?.length)
      conditions.push(inArray(approvalRequests.status, [...filter.status]));
    return this.x
      .select()
      .from(approvalRequests)
      .where(propertyWhere(approvalRequests, scope, ...conditions))
      .orderBy(desc(approvalRequests.createdAt))
      .limit(filter.limit);
  }
  approvalsOfWorkItem(scope: TenantScope, workItemId: string): Promise<ApprovalRequestRow[]> {
    return this.x
      .select()
      .from(approvalRequests)
      .where(tenantWhere(approvalRequests, scope, eq(approvalRequests.workItemId, workItemId)))
      .orderBy(asc(approvalRequests.createdAt));
  }
  /** Pending requests past their expiry, across tenants (the worker's sweep), locked and skipped by other sweepers. */
  claimExpired(
    now: Date,
    limit: number,
    tenantId?: string,
  ): Promise<Array<Pick<ApprovalRequestRow, 'id' | 'tenantId'>>> {
    return this.x
      .select({ id: approvalRequests.id, tenantId: approvalRequests.tenantId })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.status, 'PENDING'),
          lte(approvalRequests.expiresAt, now),
          tenantId === undefined ? undefined : eq(approvalRequests.tenantId, tenantId),
        ),
      )
      .orderBy(asc(approvalRequests.expiresAt))
      .limit(limit)
      .for('update', { skipLocked: true });
  }
}
