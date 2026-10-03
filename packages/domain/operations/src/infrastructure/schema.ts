import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { baseColumns, classify, propertyScoped, versioned } from '@hotella/platform-database';

/**
 * Operations engine (Spec §8, schema `ops`). One set of tables for every module's work: a module creates a work item
 * of its registered kind and the engine owns tasks, assignment history and (from 3.2) SLA. Foreign keys to `org.*`
 * and `guest.*` are added by hand in the migration.
 */
export const ops = pgSchema('ops');

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const workItemStatus = ops.enum('work_item_status', [
  'OPEN',
  'IN_PROGRESS',
  'RESOLVED',
  'CANCELLED',
]);
export const taskStatus = ops.enum('task_status', [
  'NEW',
  'ASSIGNED',
  'ACCEPTED',
  'IN_PROGRESS',
  'PAUSED',
  'DONE',
  'CANCELLED',
]);
export const priority = ops.enum('priority', ['LOW', 'NORMAL', 'HIGH', 'URGENT']);
export const assigneeType = ops.enum('assignee_type', ['USER', 'TEAM', 'AI', 'ROBOT']);

/** Generic operational object linking a module's record (the source) to tasks, SLA and workflow (Spec §8.1). */
export const workItems = classify(
  ops.table(
    'work_items',
    {
      ...baseColumns(),
      ...propertyScoped(),
      kind: varchar('kind', { length: 64 }).notNull(),
      sourceModule: varchar('source_module', { length: 32 }).notNull(),
      sourceEntityType: varchar('source_entity_type', { length: 64 }).notNull(),
      sourceEntityId: uuid('source_entity_id'),
      titleKey: varchar('title_key', { length: 128 }),
      titleParams: jsonb('title_params').$type<Record<string, string | number>>(),
      title: text('title'),
      status: workItemStatus('status').notNull().default('OPEN'),
      priority: priority('priority').notNull().default('NORMAL'),
      locationId: uuid('location_id'),
      guestId: uuid('guest_id'),
      stayId: uuid('stay_id'),
      departmentCode: varchar('department_code', { length: 32 }),
      workflowInstanceId: uuid('workflow_instance_id'),
      slaInstanceId: uuid('sla_instance_id'),
      createdByType: varchar('created_by_type', { length: 16 }).notNull(),
      createdById: uuid('created_by_id'),
      correlationId: varchar('correlation_id', { length: 64 }),
      resolvedAt: tz('resolved_at'),
      cancelledAt: tz('cancelled_at'),
      ...versioned(),
    },
    (t) => [
      index('work_items_property_status_idx').on(t.propertyId, t.status, t.createdAt),
      index('work_items_source_idx').on(t.tenantId, t.sourceEntityType, t.sourceEntityId),
      index('work_items_stay_idx').on(t.stayId),
      check('work_items_title_ck', sql`(${t.titleKey} IS NOT NULL) <> (${t.title} IS NOT NULL)`),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    kind: 'INTERNAL',
    sourceModule: 'INTERNAL',
    sourceEntityType: 'INTERNAL',
    sourceEntityId: 'INTERNAL',
    titleKey: 'INTERNAL',
    // Parameters and free-text titles may quote a guest ("towels for Mr X") — treated as guest data.
    titleParams: 'CONFIDENTIAL',
    title: 'CONFIDENTIAL',
    status: 'INTERNAL',
    priority: 'INTERNAL',
    locationId: 'INTERNAL',
    guestId: 'INTERNAL',
    stayId: 'INTERNAL',
    departmentCode: 'INTERNAL',
    workflowInstanceId: 'INTERNAL',
    slaInstanceId: 'INTERNAL',
    createdByType: 'INTERNAL',
    createdById: 'INTERNAL',
    correlationId: 'INTERNAL',
    resolvedAt: 'INTERNAL',
    cancelledAt: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** A unit of work someone does (Spec §8.2). The current assignee is a projection of `task_assignments`. */
export const tasks = classify(
  ops.table(
    'tasks',
    {
      ...baseColumns(),
      ...propertyScoped(),
      workItemId: uuid('work_item_id')
        .notNull()
        .references(() => workItems.id, { onDelete: 'cascade' }),
      titleKey: varchar('title_key', { length: 128 }),
      titleParams: jsonb('title_params').$type<Record<string, string | number>>(),
      title: text('title'),
      status: taskStatus('status').notNull().default('NEW'),
      priority: priority('priority').notNull().default('NORMAL'),
      dueAt: tz('due_at'),
      locationId: uuid('location_id'),
      departmentCode: varchar('department_code', { length: 32 }),
      assigneeType: assigneeType('assignee_type'),
      assigneeId: uuid('assignee_id'),
      pauseReason: varchar('pause_reason', { length: 64 }),
      acceptedAt: tz('accepted_at'),
      startedAt: tz('started_at'),
      completedAt: tz('completed_at'),
      cancelledAt: tz('cancelled_at'),
      ...versioned(),
    },
    (t) => [
      index('tasks_work_item_idx').on(t.workItemId),
      index('tasks_assignee_idx').on(t.assigneeType, t.assigneeId, t.status),
      index('tasks_property_status_idx').on(t.propertyId, t.status, t.dueAt),
      index('tasks_department_idx').on(t.propertyId, t.departmentCode, t.status),
      check('tasks_title_ck', sql`(${t.titleKey} IS NOT NULL) <> (${t.title} IS NOT NULL)`),
      check('tasks_assignee_ck', sql`(${t.assigneeType} IS NULL) = (${t.assigneeId} IS NULL)`),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    workItemId: 'INTERNAL',
    titleKey: 'INTERNAL',
    titleParams: 'CONFIDENTIAL',
    title: 'CONFIDENTIAL',
    status: 'INTERNAL',
    priority: 'INTERNAL',
    dueAt: 'INTERNAL',
    locationId: 'INTERNAL',
    departmentCode: 'INTERNAL',
    assigneeType: 'INTERNAL',
    assigneeId: 'INTERNAL',
    pauseReason: 'INTERNAL',
    acceptedAt: 'INTERNAL',
    startedAt: 'INTERNAL',
    completedAt: 'INTERNAL',
    cancelledAt: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Assignment history (Spec §8.2 "must be preserved", CLAUDE.md rule 10): rows are closed, never rewritten. */
export const taskAssignments = classify(
  ops.table(
    'task_assignments',
    {
      ...baseColumns(),
      ...propertyScoped(),
      taskId: uuid('task_id')
        .notNull()
        .references(() => tasks.id, { onDelete: 'cascade' }),
      assigneeType: assigneeType('assignee_type').notNull(),
      assigneeId: uuid('assignee_id').notNull(),
      assignedByType: varchar('assigned_by_type', { length: 16 }).notNull(),
      assignedById: uuid('assigned_by_id'),
      assignedAt: tz('assigned_at').notNull(),
      reason: text('reason'),
      unassignedAt: tz('unassigned_at'),
      endReason: varchar('end_reason', { length: 16 }),
    },
    (t) => [
      index('task_assignments_task_idx').on(t.taskId, t.assignedAt),
      index('task_assignments_assignee_idx').on(t.assigneeType, t.assigneeId),
      uniqueIndex('task_assignments_open_uq')
        .on(t.taskId)
        .where(sql`${t.unassignedAt} IS NULL`),
      check('task_assignments_end_ck', sql`(${t.unassignedAt} IS NULL) = (${t.endReason} IS NULL)`),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    taskId: 'INTERNAL',
    assigneeType: 'INTERNAL',
    assigneeId: 'INTERNAL',
    assignedByType: 'INTERNAL',
    assignedById: 'INTERNAL',
    assignedAt: 'INTERNAL',
    reason: 'INTERNAL',
    unassignedAt: 'INTERNAL',
    endReason: 'INTERNAL',
  },
);

/** Operational history of a task: every transition with its actor (append-only, enforced by a trigger). */
export const taskEvents = classify(
  ops.table(
    'task_events',
    {
      ...baseColumns(),
      ...propertyScoped(),
      taskId: uuid('task_id')
        .notNull()
        .references(() => tasks.id, { onDelete: 'cascade' }),
      type: varchar('type', { length: 32 }).notNull(),
      fromStatus: taskStatus('from_status'),
      toStatus: taskStatus('to_status').notNull(),
      actorType: varchar('actor_type', { length: 16 }).notNull(),
      actorId: uuid('actor_id'),
      reason: text('reason'),
      payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
      occurredAt: tz('occurred_at').notNull(),
    },
    (t) => [index('task_events_task_idx').on(t.taskId, t.occurredAt)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    taskId: 'INTERNAL',
    type: 'INTERNAL',
    fromStatus: 'INTERNAL',
    toStatus: 'INTERNAL',
    actorType: 'INTERNAL',
    actorId: 'INTERNAL',
    // A completion note may mention a guest.
    reason: 'CONFIDENTIAL',
    payload: 'INTERNAL',
    occurredAt: 'INTERNAL',
  },
);

export type WorkItemRow = typeof workItems.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskAssignmentRow = typeof taskAssignments.$inferSelect;
export type TaskEventRow = typeof taskEvents.$inferSelect;
