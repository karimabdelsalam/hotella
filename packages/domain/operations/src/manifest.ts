import {
  TaskAssigned,
  TaskStatusChanged,
  WorkItemCreated,
  WorkItemStatusChanged,
} from '@hotella/contracts-events';
import { defineManifest } from '@hotella/platform-manifest';

export const OPERATIONS_MANIFEST = defineManifest({
  code: 'ops',
  schema: 'ops',
  description:
    'Operations engine: work items from every module, tasks with assignment history, SLA, escalation, workflows, approvals, alerts.',
  permissions: [
    { code: 'task.read', descriptionKey: 'ops.permission.task_read', risk: 'READ' },
    { code: 'task.assign', descriptionKey: 'ops.permission.task_assign', risk: 'LOW' },
    { code: 'task.accept', descriptionKey: 'ops.permission.task_accept', risk: 'LOW' },
    { code: 'task.complete', descriptionKey: 'ops.permission.task_complete', risk: 'LOW' },
    { code: 'task.cancel', descriptionKey: 'ops.permission.task_cancel', risk: 'MEDIUM' },
  ],
  events: [
    WorkItemCreated.name,
    WorkItemStatusChanged.name,
    TaskAssigned.name,
    TaskStatusChanged.name,
  ],
  localeNamespaces: ['ops'],
});
