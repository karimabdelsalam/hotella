import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { baseColumns, classify, propertyScoped, versioned } from '@hotella/platform-database';
import type { EscalationRule, SlaCalendar, WeeklySchedule } from '../domain/sla';
import type { WorkflowDefinition } from '../domain/workflow';

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
      /** Catalog service (Phase 5) the work fulfils; SLA policies may target it. */
      serviceCode: varchar('service_code', { length: 64 }),
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
    serviceCode: 'INTERNAL',
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

export const activeStatus = ops.enum('active_status', ['ACTIVE', 'INACTIVE']);
export const slaStatus = ops.enum('sla_status', ['RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED']);
export const alertStatus = ops.enum('alert_status', ['OPEN', 'ACKNOWLEDGED', 'RESOLVED']);
export const alertSeverity = ops.enum('alert_severity', ['INFO', 'WARNING', 'CRITICAL']);

/** Weekly opening hours of a property (or a department of it), in the property's time zone (Spec §8.3). */
export const businessHours = classify(
  ops.table(
    'business_hours',
    {
      ...baseColumns(),
      ...propertyScoped(),
      code: varchar('code', { length: 32 }).notNull(),
      schedule: jsonb('schedule').$type<WeeklySchedule>().notNull(),
      ...versioned(),
    },
    (t) => [uniqueIndex('business_hours_property_code_uq').on(t.propertyId, t.code)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    code: 'INTERNAL',
    schedule: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/**
 * Response/resolution targets with their clock, pause reasons and escalation ladder. Matching criteria left null match
 * anything; the most specific policy wins (service > department > priority > kind).
 */
export const slaPolicies = classify(
  ops.table(
    'sla_policies',
    {
      ...baseColumns(),
      ...propertyScoped(),
      code: varchar('code', { length: 32 }).notNull(),
      matchKind: varchar('match_kind', { length: 64 }),
      matchServiceCode: varchar('match_service_code', { length: 64 }),
      matchDepartmentCode: varchar('match_department_code', { length: 32 }),
      matchPriority: priority('match_priority'),
      responseMinutes: integer('response_minutes'),
      resolutionMinutes: integer('resolution_minutes').notNull(),
      businessHoursId: uuid('business_hours_id').references(() => businessHours.id, {
        onDelete: 'restrict',
      }),
      /** Task pause reasons that stop the resolution clock (e.g. WAITING_GUEST); others do not. */
      pauseReasons: text('pause_reasons')
        .array()
        .notNull()
        .default(sql`'{}'::text[]`),
      escalationRules: jsonb('escalation_rules').$type<EscalationRule[]>().notNull().default([]),
      status: activeStatus('status').notNull().default('ACTIVE'),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('sla_policies_property_code_uq').on(t.propertyId, t.code),
      index('sla_policies_property_status_idx').on(t.propertyId, t.status),
      check(
        'sla_policies_minutes_ck',
        sql`${t.resolutionMinutes} > 0 AND (${t.responseMinutes} IS NULL OR ${t.responseMinutes} > 0)`,
      ),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    code: 'INTERNAL',
    matchKind: 'INTERNAL',
    matchServiceCode: 'INTERNAL',
    matchDepartmentCode: 'INTERNAL',
    matchPriority: 'INTERNAL',
    responseMinutes: 'INTERNAL',
    resolutionMinutes: 'INTERNAL',
    businessHoursId: 'INTERNAL',
    pauseReasons: 'INTERNAL',
    escalationRules: 'INTERNAL',
    status: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/**
 * The SLA of one work item. Targets, calendar and ladder are copied from the policy when the clock starts, so editing
 * a policy never moves running deadlines.
 */
export const slaInstances = classify(
  ops.table(
    'sla_instances',
    {
      ...baseColumns(),
      ...propertyScoped(),
      workItemId: uuid('work_item_id')
        .notNull()
        .references(() => workItems.id, { onDelete: 'cascade' }),
      policyId: uuid('policy_id')
        .notNull()
        .references(() => slaPolicies.id, { onDelete: 'restrict' }),
      policyVersion: integer('policy_version').notNull(),
      calendar: jsonb('calendar').$type<SlaCalendar>().notNull(),
      responseMinutes: integer('response_minutes'),
      resolutionMinutes: integer('resolution_minutes').notNull(),
      pauseReasons: text('pause_reasons').array().notNull(),
      escalationRules: jsonb('escalation_rules').$type<EscalationRule[]>().notNull(),
      status: slaStatus('status').notNull().default('RUNNING'),
      startedAt: tz('started_at').notNull(),
      responseDueAt: tz('response_due_at'),
      resolutionDueAt: tz('resolution_due_at').notNull(),
      responseMetAt: tz('response_met_at'),
      resolutionMetAt: tz('resolution_met_at'),
      responseBreachedAt: tz('response_breached_at'),
      resolutionBreachedAt: tz('resolution_breached_at'),
      closedAt: tz('closed_at'),
      nextCheckAt: tz('next_check_at'),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('sla_instances_work_item_uq').on(t.workItemId),
      index('sla_instances_due_idx')
        .on(t.nextCheckAt)
        .where(sql`${t.status} = 'RUNNING'`),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    workItemId: 'INTERNAL',
    policyId: 'INTERNAL',
    policyVersion: 'INTERNAL',
    calendar: 'INTERNAL',
    responseMinutes: 'INTERNAL',
    resolutionMinutes: 'INTERNAL',
    pauseReasons: 'INTERNAL',
    escalationRules: 'INTERNAL',
    status: 'INTERNAL',
    startedAt: 'INTERNAL',
    responseDueAt: 'INTERNAL',
    resolutionDueAt: 'INTERNAL',
    responseMetAt: 'INTERNAL',
    resolutionMetAt: 'INTERNAL',
    responseBreachedAt: 'INTERNAL',
    resolutionBreachedAt: 'INTERNAL',
    closedAt: 'INTERNAL',
    nextCheckAt: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Pause history of an SLA (CLAUDE.md rule 10): deadlines are recomputed from it. */
export const slaPauses = classify(
  ops.table(
    'sla_pauses',
    {
      ...baseColumns(),
      ...propertyScoped(),
      slaInstanceId: uuid('sla_instance_id')
        .notNull()
        .references(() => slaInstances.id, { onDelete: 'cascade' }),
      reason: varchar('reason', { length: 64 }).notNull(),
      pausedAt: tz('paused_at').notNull(),
      resumedAt: tz('resumed_at'),
    },
    (t) => [
      index('sla_pauses_instance_idx').on(t.slaInstanceId, t.pausedAt),
      uniqueIndex('sla_pauses_open_uq')
        .on(t.slaInstanceId)
        .where(sql`${t.resumedAt} IS NULL`),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    slaInstanceId: 'INTERNAL',
    reason: 'INTERNAL',
    pausedAt: 'INTERNAL',
    resumedAt: 'INTERNAL',
  },
);

/**
 * A condition needing attention (Spec §15) — not a notification. One active alert per `dedupe_key`: raising it again
 * only counts and refreshes `last_seen_at`.
 */
export const alerts = classify(
  ops.table(
    'alerts',
    {
      ...baseColumns(),
      ...propertyScoped(),
      type: varchar('type', { length: 64 }).notNull(),
      severity: alertSeverity('severity').notNull(),
      dedupeKey: varchar('dedupe_key', { length: 200 }).notNull(),
      status: alertStatus('status').notNull().default('OPEN'),
      subjectType: varchar('subject_type', { length: 64 }),
      subjectId: uuid('subject_id'),
      evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
      occurrences: integer('occurrences').notNull().default(1),
      firstSeenAt: tz('first_seen_at').notNull(),
      lastSeenAt: tz('last_seen_at').notNull(),
      acknowledgedById: uuid('acknowledged_by_id'),
      acknowledgedAt: tz('acknowledged_at'),
      resolvedByType: varchar('resolved_by_type', { length: 16 }),
      resolvedById: uuid('resolved_by_id'),
      resolvedAt: tz('resolved_at'),
      resolution: text('resolution'),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('alerts_active_dedupe_uq')
        .on(t.tenantId, t.dedupeKey)
        .where(sql`${t.status} <> 'RESOLVED'`),
      index('alerts_property_status_idx').on(t.propertyId, t.status, t.lastSeenAt),
      index('alerts_subject_idx').on(t.subjectType, t.subjectId),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    type: 'INTERNAL',
    severity: 'INTERNAL',
    dedupeKey: 'INTERNAL',
    status: 'INTERNAL',
    subjectType: 'INTERNAL',
    subjectId: 'INTERNAL',
    evidence: 'INTERNAL',
    occurrences: 'INTERNAL',
    firstSeenAt: 'INTERNAL',
    lastSeenAt: 'INTERNAL',
    acknowledgedById: 'INTERNAL',
    acknowledgedAt: 'INTERNAL',
    resolvedByType: 'INTERNAL',
    resolvedById: 'INTERNAL',
    resolvedAt: 'INTERNAL',
    resolution: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Escalations fired for an SLA (one per ladder step), with the alert they raised. */
export const escalations = classify(
  ops.table(
    'escalations',
    {
      ...baseColumns(),
      ...propertyScoped(),
      slaInstanceId: uuid('sla_instance_id')
        .notNull()
        .references(() => slaInstances.id, { onDelete: 'cascade' }),
      trigger: varchar('trigger', { length: 32 }).notNull(),
      level: integer('level').notNull(),
      severity: alertSeverity('severity').notNull(),
      notifyRoles: text('notify_roles').array().notNull(),
      alertId: uuid('alert_id').references(() => alerts.id, { onDelete: 'restrict' }),
      triggeredAt: tz('triggered_at').notNull(),
    },
    (t) => [uniqueIndex('escalations_step_uq').on(t.slaInstanceId, t.trigger, t.level)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    slaInstanceId: 'INTERNAL',
    trigger: 'INTERNAL',
    level: 'INTERNAL',
    severity: 'INTERNAL',
    notifyRoles: 'INTERNAL',
    alertId: 'INTERNAL',
    triggeredAt: 'INTERNAL',
  },
);

export const workflowVersionStatus = ops.enum('workflow_version_status', [
  'DRAFT',
  'PUBLISHED',
  'RETIRED',
]);
export const workflowInstanceStatus = ops.enum('workflow_instance_status', [
  'RUNNING',
  'COMPLETED',
]);
export const riskLevel = ops.enum('risk_level', ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const approvalStatus = ops.enum('approval_status', [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
]);

/** A named workflow of a property (Spec §8); its behaviour lives in immutable published versions. */
export const workflowDefinitions = classify(
  ops.table(
    'workflow_definitions',
    {
      ...baseColumns(),
      ...propertyScoped(),
      code: varchar('code', { length: 32 }).notNull(),
      status: activeStatus('status').notNull().default('ACTIVE'),
      ...versioned(),
    },
    (t) => [uniqueIndex('workflow_definitions_property_code_uq').on(t.propertyId, t.code)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    code: 'INTERNAL',
    status: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** A version of a workflow; immutable once published (CLAUDE.md rule 9, enforced by a trigger). */
export const workflowVersions = classify(
  ops.table(
    'workflow_versions',
    {
      ...baseColumns(),
      ...propertyScoped(),
      definitionId: uuid('definition_id')
        .notNull()
        .references(() => workflowDefinitions.id, { onDelete: 'restrict' }),
      version: integer('version').notNull(),
      definition: jsonb('definition').$type<WorkflowDefinition>().notNull(),
      status: workflowVersionStatus('status').notNull().default('DRAFT'),
      createdById: uuid('created_by_id'),
      publishedAt: tz('published_at'),
      publishedById: uuid('published_by_id'),
    },
    (t) => [uniqueIndex('workflow_versions_definition_version_uq').on(t.definitionId, t.version)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    definitionId: 'INTERNAL',
    version: 'INTERNAL',
    definition: 'INTERNAL',
    status: 'INTERNAL',
    createdById: 'INTERNAL',
    publishedAt: 'INTERNAL',
    publishedById: 'INTERNAL',
  },
);

/** The workflow run of one work item, pinned to the version it started with. */
export const workflowInstances = classify(
  ops.table(
    'workflow_instances',
    {
      ...baseColumns(),
      ...propertyScoped(),
      versionId: uuid('version_id')
        .notNull()
        .references(() => workflowVersions.id, { onDelete: 'restrict' }),
      workItemId: uuid('work_item_id')
        .notNull()
        .references(() => workItems.id, { onDelete: 'cascade' }),
      currentState: varchar('current_state', { length: 64 }).notNull(),
      status: workflowInstanceStatus('status').notNull().default('RUNNING'),
      completedAt: tz('completed_at'),
      ...versioned(),
    },
    (t) => [uniqueIndex('workflow_instances_work_item_uq').on(t.workItemId)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    versionId: 'INTERNAL',
    workItemId: 'INTERNAL',
    currentState: 'INTERNAL',
    status: 'INTERNAL',
    completedAt: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Every state change of a workflow run (append-only history, CLAUDE.md rule 10). */
export const workflowTransitions = classify(
  ops.table(
    'workflow_transitions',
    {
      ...baseColumns(),
      ...propertyScoped(),
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => workflowInstances.id, { onDelete: 'cascade' }),
      fromState: varchar('from_state', { length: 64 }),
      toState: varchar('to_state', { length: 64 }).notNull(),
      trigger: varchar('trigger', { length: 80 }).notNull(),
      actorType: varchar('actor_type', { length: 16 }).notNull(),
      actorId: uuid('actor_id'),
      occurredAt: tz('occurred_at').notNull(),
    },
    (t) => [index('workflow_transitions_instance_idx').on(t.instanceId, t.occurredAt)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    instanceId: 'INTERNAL',
    fromState: 'INTERNAL',
    toState: 'INTERNAL',
    trigger: 'INTERNAL',
    actorType: 'INTERNAL',
    actorId: 'INTERNAL',
    occurredAt: 'INTERNAL',
  },
);

/**
 * A decision a person must take before a sensitive action runs (Spec §8.4): compensation, refunds, OOO/OOS, selected
 * AI actions. The registered handler of the kind runs only after approval, in the deciding transaction.
 */
export const approvalRequests = classify(
  ops.table(
    'approval_requests',
    {
      ...baseColumns(),
      ...propertyScoped(),
      kind: varchar('kind', { length: 64 }).notNull(),
      subjectType: varchar('subject_type', { length: 64 }).notNull(),
      subjectId: uuid('subject_id'),
      workItemId: uuid('work_item_id').references(() => workItems.id, { onDelete: 'restrict' }),
      payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
      riskLevel: riskLevel('risk_level').notNull(),
      status: approvalStatus('status').notNull().default('PENDING'),
      requestedByType: varchar('requested_by_type', { length: 16 }).notNull(),
      requestedById: uuid('requested_by_id'),
      reason: text('reason'),
      expiresAt: tz('expires_at').notNull(),
      decidedByType: varchar('decided_by_type', { length: 16 }),
      decidedById: uuid('decided_by_id'),
      decidedAt: tz('decided_at'),
      decisionReason: text('decision_reason'),
      executedAt: tz('executed_at'),
      ...versioned(),
    },
    (t) => [
      index('approval_requests_property_status_idx').on(t.propertyId, t.status, t.createdAt),
      index('approval_requests_pending_expiry_idx')
        .on(t.expiresAt)
        .where(sql`${t.status} = 'PENDING'`),
      index('approval_requests_work_item_idx').on(t.workItemId),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    kind: 'INTERNAL',
    subjectType: 'INTERNAL',
    subjectId: 'INTERNAL',
    workItemId: 'INTERNAL',
    // Amounts, reasons and AI proposals may describe a guest's situation.
    payload: 'CONFIDENTIAL',
    riskLevel: 'INTERNAL',
    status: 'INTERNAL',
    requestedByType: 'INTERNAL',
    requestedById: 'INTERNAL',
    reason: 'CONFIDENTIAL',
    expiresAt: 'INTERNAL',
    decidedByType: 'INTERNAL',
    decidedById: 'INTERNAL',
    decidedAt: 'INTERNAL',
    decisionReason: 'CONFIDENTIAL',
    executedAt: 'INTERNAL',
    version: 'INTERNAL',
  },
);

export type WorkItemRow = typeof workItems.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskAssignmentRow = typeof taskAssignments.$inferSelect;
export type TaskEventRow = typeof taskEvents.$inferSelect;
export type BusinessHoursRow = typeof businessHours.$inferSelect;
export type SlaPolicyRow = typeof slaPolicies.$inferSelect;
export type SlaInstanceRow = typeof slaInstances.$inferSelect;
export type SlaPauseRow = typeof slaPauses.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
export type EscalationRow = typeof escalations.$inferSelect;
export type WorkflowDefinitionRow = typeof workflowDefinitions.$inferSelect;
export type WorkflowVersionRow = typeof workflowVersions.$inferSelect;
export type WorkflowInstanceRow = typeof workflowInstances.$inferSelect;
export type WorkflowTransitionRow = typeof workflowTransitions.$inferSelect;
export type ApprovalRequestRow = typeof approvalRequests.$inferSelect;
