import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lt, type SQL, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type PropertyScope,
  propertyWhere,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import type { TaskStatus, WorkItemStatus } from '../domain/task-lifecycle';
import {
  taskAssignments,
  taskEvents,
  tasks,
  workItems,
  type TaskAssignmentRow,
  type TaskEventRow,
  type TaskRow,
  type WorkItemRow,
} from './schema';

export interface TaskFilter {
  readonly status?: readonly TaskStatus[];
  readonly assignee?: { readonly type: 'USER' | 'TEAM'; readonly id: string };
  readonly departmentCode?: string;
  readonly workItemId?: string;
  /** Keyset pagination: tasks created before this id (UUIDv7 ids sort by time). */
  readonly before?: string;
  readonly limit: number;
}

export interface WorkItemFilter {
  readonly status?: readonly WorkItemStatus[];
  readonly kind?: string;
  readonly departmentCode?: string;
  readonly before?: string;
  readonly limit: number;
}

/** Tenant-filtered data access for `ops` (CLAUDE.md rule 1). Writes run inside the caller's transaction. */
@Injectable()
export class OperationsRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- work items ----
  async insertWorkItem(values: typeof workItems.$inferInsert): Promise<WorkItemRow> {
    const [row] = await this.x.insert(workItems).values(values).returning();
    return row!;
  }
  workItem(scope: TenantScope, id: string): Promise<WorkItemRow | undefined> {
    return this.x
      .select()
      .from(workItems)
      .where(tenantWhere(workItems, scope, eq(workItems.id, id)))
      .then((r) => r[0]);
  }
  workItemForUpdate(scope: TenantScope, id: string): Promise<WorkItemRow | undefined> {
    return this.x
      .select()
      .from(workItems)
      .where(tenantWhere(workItems, scope, eq(workItems.id, id)))
      .for('update')
      .then((r) => r[0]);
  }
  async updateWorkItem(
    scope: TenantScope,
    id: string,
    values: Partial<typeof workItems.$inferInsert>,
  ): Promise<WorkItemRow> {
    const [row] = await this.x
      .update(workItems)
      .set({ ...values, version: sql`${workItems.version} + 1` })
      .where(tenantWhere(workItems, scope, eq(workItems.id, id)))
      .returning();
    return row!;
  }
  listWorkItems(scope: PropertyScope, filter: WorkItemFilter): Promise<WorkItemRow[]> {
    const conditions: SQL[] = [];
    if (filter.status?.length) conditions.push(inArray(workItems.status, [...filter.status]));
    if (filter.kind) conditions.push(eq(workItems.kind, filter.kind));
    if (filter.departmentCode) conditions.push(eq(workItems.departmentCode, filter.departmentCode));
    if (filter.before) conditions.push(lt(workItems.id, filter.before));
    return this.x
      .select()
      .from(workItems)
      .where(propertyWhere(workItems, scope, ...conditions))
      .orderBy(desc(workItems.id))
      .limit(filter.limit);
  }
  workItemsBySource(
    scope: TenantScope,
    entityType: string,
    entityId: string,
  ): Promise<WorkItemRow[]> {
    return this.x
      .select()
      .from(workItems)
      .where(
        tenantWhere(
          workItems,
          scope,
          eq(workItems.sourceEntityType, entityType),
          eq(workItems.sourceEntityId, entityId),
        ),
      )
      .orderBy(asc(workItems.id));
  }

  // ---- tasks ----
  async insertTask(values: typeof tasks.$inferInsert): Promise<TaskRow> {
    const [row] = await this.x.insert(tasks).values(values).returning();
    return row!;
  }
  task(scope: TenantScope, id: string): Promise<TaskRow | undefined> {
    return this.x
      .select()
      .from(tasks)
      .where(tenantWhere(tasks, scope, eq(tasks.id, id)))
      .then((r) => r[0]);
  }
  taskForUpdate(scope: TenantScope, id: string): Promise<TaskRow | undefined> {
    return this.x
      .select()
      .from(tasks)
      .where(tenantWhere(tasks, scope, eq(tasks.id, id)))
      .for('update')
      .then((r) => r[0]);
  }
  async updateTask(
    scope: TenantScope,
    id: string,
    values: Partial<typeof tasks.$inferInsert>,
  ): Promise<TaskRow> {
    const [row] = await this.x
      .update(tasks)
      .set({ ...values, version: sql`${tasks.version} + 1` })
      .where(tenantWhere(tasks, scope, eq(tasks.id, id)))
      .returning();
    return row!;
  }
  tasksOfWorkItems(scope: TenantScope, workItemIds: readonly string[]): Promise<TaskRow[]> {
    if (workItemIds.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(tasks)
      .where(tenantWhere(tasks, scope, inArray(tasks.workItemId, [...workItemIds])))
      .orderBy(asc(tasks.id));
  }
  listTasks(scope: PropertyScope, filter: TaskFilter): Promise<TaskRow[]> {
    const conditions: SQL[] = [];
    if (filter.status?.length) conditions.push(inArray(tasks.status, [...filter.status]));
    if (filter.assignee)
      conditions.push(
        eq(tasks.assigneeType, filter.assignee.type),
        eq(tasks.assigneeId, filter.assignee.id),
      );
    if (filter.departmentCode) conditions.push(eq(tasks.departmentCode, filter.departmentCode));
    if (filter.workItemId) conditions.push(eq(tasks.workItemId, filter.workItemId));
    if (filter.before) conditions.push(lt(tasks.id, filter.before));
    return this.x
      .select()
      .from(tasks)
      .where(propertyWhere(tasks, scope, ...conditions))
      .orderBy(desc(tasks.id))
      .limit(filter.limit);
  }

  // ---- assignment history ----
  async insertAssignment(values: typeof taskAssignments.$inferInsert): Promise<TaskAssignmentRow> {
    const [row] = await this.x.insert(taskAssignments).values(values).returning();
    return row!;
  }
  openAssignment(scope: TenantScope, taskId: string): Promise<TaskAssignmentRow | undefined> {
    return this.x
      .select()
      .from(taskAssignments)
      .where(
        tenantWhere(
          taskAssignments,
          scope,
          eq(taskAssignments.taskId, taskId),
          isNull(taskAssignments.unassignedAt),
        ),
      )
      .then((r) => r[0]);
  }
  async closeAssignment(
    scope: TenantScope,
    id: string,
    at: Date,
    endReason: string,
  ): Promise<void> {
    await this.x
      .update(taskAssignments)
      .set({ unassignedAt: at, endReason })
      .where(
        tenantWhere(
          taskAssignments,
          scope,
          eq(taskAssignments.id, id),
          isNull(taskAssignments.unassignedAt),
        ),
      );
  }
  assignments(scope: TenantScope, taskIds: readonly string[]): Promise<TaskAssignmentRow[]> {
    if (taskIds.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(taskAssignments)
      .where(tenantWhere(taskAssignments, scope, inArray(taskAssignments.taskId, [...taskIds])))
      .orderBy(asc(taskAssignments.assignedAt), asc(taskAssignments.id));
  }

  // ---- task events ----
  async insertTaskEvent(values: typeof taskEvents.$inferInsert): Promise<TaskEventRow> {
    const [row] = await this.x.insert(taskEvents).values(values).returning();
    return row!;
  }
  taskEvents(scope: TenantScope, taskIds: readonly string[]): Promise<TaskEventRow[]> {
    if (taskIds.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(taskEvents)
      .where(and(tenantWhere(taskEvents, scope, inArray(taskEvents.taskId, [...taskIds]))))
      .orderBy(asc(taskEvents.occurredAt), asc(taskEvents.id));
  }
}
