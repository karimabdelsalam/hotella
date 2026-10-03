import {
  AlertRaised,
  ApprovalDecided,
  ApprovalRequested,
  EscalationTriggered,
  SlaBreached,
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
    { code: 'sla.manage', descriptionKey: 'ops.permission.sla_manage', risk: 'MEDIUM' },
    { code: 'alert.read', descriptionKey: 'ops.permission.alert_read', risk: 'READ' },
    { code: 'alert.ack', descriptionKey: 'ops.permission.alert_ack', risk: 'LOW' },
    { code: 'workflow.manage', descriptionKey: 'ops.permission.workflow_manage', risk: 'HIGH' },
    { code: 'approval.read', descriptionKey: 'ops.permission.approval_read', risk: 'READ' },
    { code: 'approval.decide', descriptionKey: 'ops.permission.approval_decide', risk: 'HIGH' },
  ],
  events: [
    WorkItemCreated.name,
    WorkItemStatusChanged.name,
    TaskAssigned.name,
    TaskStatusChanged.name,
    SlaBreached.name,
    EscalationTriggered.name,
    AlertRaised.name,
    ApprovalRequested.name,
    ApprovalDecided.name,
  ],
  localeNamespaces: ['ops'],
});
