import { z } from 'zod';
import { defineEvent } from './registry';

/**
 * Operations engine events (Spec §8). One engine serves every module: housekeeping, engineering, guest relations…
 * create work items of their own kind and react to these events. Payloads carry ids and codes, never free text
 * (titles may quote a guest).
 */

export const WORK_ITEM_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED'] as const;
export const TASK_STATUSES = [
  'NEW',
  'ASSIGNED',
  'ACCEPTED',
  'IN_PROGRESS',
  'PAUSED',
  'DONE',
  'CANCELLED',
] as const;
export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

const workItemStatus = z.enum(WORK_ITEM_STATUSES);
const taskStatus = z.enum(TASK_STATUSES);
const assignee = z.object({ type: z.enum(['USER', 'TEAM', 'AI', 'ROBOT']), id: z.uuid() });

export const WorkItemCreated = defineEvent({
  type: 'ops.work_item.created',
  version: 1,
  description:
    'A module created operational work (service request, housekeeping job, work order…).',
  payload: z.object({
    work_item_id: z.uuid(),
    kind: z.string(),
    source_module: z.string(),
    source_entity_type: z.string(),
    source_entity_id: z.uuid().nullable(),
    priority: z.enum(PRIORITIES),
    department_code: z.string().nullable(),
    location_id: z.uuid().nullable(),
    stay_id: z.uuid().nullable(),
    task_ids: z.array(z.uuid()),
  }),
});

export const WorkItemStatusChanged = defineEvent({
  type: 'ops.work_item.status_changed',
  version: 1,
  description:
    'The status of a work item, derived from its tasks, changed (the source module closes its own record on RESOLVED).',
  payload: z.object({
    work_item_id: z.uuid(),
    kind: z.string(),
    source_entity_type: z.string(),
    source_entity_id: z.uuid().nullable(),
    from: workItemStatus,
    to: workItemStatus,
  }),
});

export const TaskAssigned = defineEvent({
  type: 'ops.task.assigned',
  version: 1,
  delivery: 'critical-operational',
  description:
    'A task got a new assignee (first assignment or reassignment); the previous assignment is kept as history.',
  payload: z.object({
    task_id: z.uuid(),
    work_item_id: z.uuid(),
    assignee,
    previous: assignee.nullable(),
  }),
});

export const TaskStatusChanged = defineEvent({
  type: 'ops.task.status_changed',
  version: 1,
  description: 'A task moved through its lifecycle (accept, start, pause, complete, cancel…).',
  payload: z.object({
    task_id: z.uuid(),
    work_item_id: z.uuid(),
    from: taskStatus,
    to: taskStatus,
    reason: z.string().nullable(),
  }),
});

const slaTarget = z.enum(['RESPONSE', 'RESOLUTION']);
const severity = z.enum(['INFO', 'WARNING', 'CRITICAL']);

export const SlaBreached = defineEvent({
  type: 'ops.sla.breached',
  version: 1,
  delivery: 'critical-operational',
  description:
    'A work item missed its response or resolution target (computed deterministically, Spec §8.3).',
  payload: z.object({
    sla_instance_id: z.uuid(),
    work_item_id: z.uuid(),
    target: slaTarget,
    due_at: z.iso.datetime({ offset: true }),
  }),
});

export const EscalationTriggered = defineEvent({
  type: 'ops.escalation.triggered',
  version: 1,
  delivery: 'critical-operational',
  description:
    'A step of an SLA escalation ladder fired: the alert to act on and the roles to notify (notification intents).',
  payload: z.object({
    escalation_id: z.uuid(),
    sla_instance_id: z.uuid(),
    work_item_id: z.uuid(),
    trigger: z.enum(['RESPONSE_BREACH', 'RESOLUTION_WARNING', 'RESOLUTION_BREACH']),
    level: z.number().int().min(1),
    severity,
    notify_roles: z.array(z.string()),
    alert_id: z.uuid(),
  }),
});

export const AlertRaised = defineEvent({
  type: 'ops.alert.raised',
  version: 1,
  delivery: 'critical-operational',
  description:
    'A new operational alert opened (Spec §15). Repeats of the same condition update the open alert and are not re-announced.',
  payload: z.object({
    alert_id: z.uuid(),
    type: z.string(),
    severity,
    subject_type: z.string().nullable(),
    subject_id: z.uuid().nullable(),
  }),
});

const risk = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export const ApprovalRequested = defineEvent({
  type: 'ops.approval.requested',
  version: 1,
  delivery: 'critical-operational',
  description:
    'A sensitive action waits for a human decision (Spec §8.4): compensation, refund, OOO/OOS, an AI proposal…',
  payload: z.object({
    approval_id: z.uuid(),
    kind: z.string(),
    risk_level: risk,
    subject_type: z.string(),
    subject_id: z.uuid().nullable(),
    work_item_id: z.uuid().nullable(),
    requested_by_type: z.string(),
    expires_at: z.iso.datetime({ offset: true }),
  }),
});

export const ApprovalDecided = defineEvent({
  type: 'ops.approval.decided',
  version: 1,
  description:
    'An approval request was approved (its handler ran in the same transaction), rejected, or expired undecided.',
  payload: z.object({
    approval_id: z.uuid(),
    kind: z.string(),
    outcome: z.enum(['APPROVED', 'REJECTED', 'EXPIRED']),
    work_item_id: z.uuid().nullable(),
    decided_by_type: z.string().nullable(),
  }),
});

export const NotificationRequested = defineEvent({
  type: 'ops.notification.requested',
  version: 1,
  delivery: 'critical-operational',
  description:
    'Something should be told to people (Spec §25): the dispatcher expands the recipients and creates deliveries per channel.',
  payload: z.object({
    intent_id: z.uuid(),
    category: z.string(),
    priority: z.enum(['NORMAL', 'HIGH', 'CRITICAL']),
  }),
});
