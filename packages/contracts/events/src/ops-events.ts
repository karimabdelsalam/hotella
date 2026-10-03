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
