import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { TASK_STATUSES, WORK_ITEM_STATUSES } from '@hotella/contracts-events';
import { uuidSchema } from '@hotella/contracts-api';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { isUuid, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { AppError, CurrentLocale, I18nService } from '@hotella/platform-i18n';
import { OperationsRepositories } from '../infrastructure/repositories';
import { approvalSummary } from './approval.service';
import { SlaRepositories } from '../infrastructure/sla-repositories';
import { WorkflowRepositories } from '../infrastructure/workflow-repositories';
import type {
  SlaInstanceRow,
  TaskAssignmentRow,
  TaskEventRow,
  TaskRow,
  WorkItemRow,
} from '../infrastructure/schema';

const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((s) =>
      s
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(values)).max(values.length));

export const listTasksQuerySchema = z.object({
  /** `me` = tasks assigned to the caller; a user id = that person's tasks (supervisors). */
  assignee: z.union([z.literal('me'), uuidSchema]).optional(),
  department: z.string().trim().toUpperCase().min(2).max(32).optional(),
  status: csv(TASK_STATUSES).optional(),
  workItemId: uuidSchema.optional(),
  before: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const listWorkItemsQuerySchema = z.object({
  status: csv(WORK_ITEM_STATUSES).optional(),
  kind: z.string().trim().toUpperCase().max(64).optional(),
  department: z.string().trim().toUpperCase().min(2).max(32).optional(),
  before: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListWorkItemsQuery = z.infer<typeof listWorkItemsQuerySchema>;

/** Staff read side of the operations engine: lists for "my tasks", a department queue and the property board. */
@Injectable()
export class OperationsQueryService {
  constructor(
    private readonly repo: OperationsRepositories,
    private readonly sla: SlaRepositories,
    private readonly workflows: WorkflowRepositories,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly actors: ActorStore,
    private readonly i18n: I18nService,
    private readonly locale: CurrentLocale,
  ) {}

  listTasks(scope: PropertyScope, query: ListTasksQuery) {
    return this.read(scope, async () => {
      const assignee =
        query.assignee === 'me'
          ? { type: 'USER' as const, id: this.actors.require().id }
          : query.assignee
            ? { type: 'USER' as const, id: query.assignee }
            : undefined;
      const rows = await this.repo.listTasks(scope, {
        status: query.status,
        assignee,
        departmentCode: query.department,
        workItemId: query.workItemId,
        before: query.before,
        limit: query.limit,
      });
      return { items: rows.map((t) => this.taskView(t)), next: nextCursor(rows, query.limit) };
    });
  }

  getTask(scope: PropertyScope, taskId: string) {
    return this.read(scope, async () => {
      const task = isUuid(taskId) ? await this.repo.task(scope, taskId) : undefined;
      if (!task || task.propertyId !== scope.propertyId)
        throw AppError.notFound('ops.task.not_found');
      const [item, assignments, events] = await Promise.all([
        this.repo.workItem(scope, task.workItemId),
        this.repo.assignments(scope, [task.id]),
        this.repo.taskEvents(scope, [task.id]),
      ]);
      return {
        ...this.taskView(task),
        workItem: item ? this.workItemView(item) : null,
        assignments: assignments.map(assignmentView),
        history: events.map(eventView),
      };
    });
  }

  listWorkItems(scope: PropertyScope, query: ListWorkItemsQuery) {
    return this.read(scope, async () => {
      const rows = await this.repo.listWorkItems(scope, {
        status: query.status,
        kind: query.kind,
        departmentCode: query.department,
        before: query.before,
        limit: query.limit,
      });
      const taskRows = await this.repo.tasksOfWorkItems(
        scope,
        rows.map((r) => r.id),
      );
      const slas = new Map(
        (
          await this.sla.instancesOfWorkItems(
            scope,
            rows.map((r) => r.id),
          )
        ).map((i) => [i.workItemId, i]),
      );
      return {
        items: rows.map((w) => ({
          ...this.workItemView(w),
          sla: slaView(slas.get(w.id)),
          tasks: taskRows.filter((t) => t.workItemId === w.id).map((t) => this.taskView(t)),
        })),
        next: nextCursor(rows, query.limit),
      };
    });
  }

  getWorkItem(scope: PropertyScope, workItemId: string) {
    return this.read(scope, async () => {
      const item = isUuid(workItemId) ? await this.repo.workItem(scope, workItemId) : undefined;
      if (!item || item.propertyId !== scope.propertyId)
        throw AppError.notFound('ops.work_item.not_found');
      const taskRows = await this.repo.tasksOfWorkItems(scope, [item.id]);
      const ids = taskRows.map((t) => t.id);
      const [assignments, events, sla, workflow, approvals] = await Promise.all([
        this.repo.assignments(scope, ids),
        this.repo.taskEvents(scope, ids),
        this.sla.instanceOfWorkItem(scope, item.id),
        this.workflowView(scope, item.id),
        this.workflows.approvalsOfWorkItem(scope, item.id),
      ]);
      return {
        ...this.workItemView(item),
        sla: slaView(sla),
        workflow,
        approvals: approvals.map(approvalSummary),
        tasks: taskRows.map((t) => ({
          ...this.taskView(t),
          assignments: assignments.filter((a) => a.taskId === t.id).map(assignmentView),
          history: events.filter((e) => e.taskId === t.id).map(eventView),
        })),
      };
    });
  }

  /** The workflow run of a work item: definition/version, current state and its history. */
  private async workflowView(scope: PropertyScope, workItemId: string) {
    const instance = await this.workflows.instanceOfWorkItem(scope, workItemId);
    if (!instance) return null;
    const [version, transitions] = await Promise.all([
      this.workflows.versionById(scope, instance.versionId),
      this.workflows.transitions(scope, instance.id),
    ]);
    return {
      version: version?.version ?? null,
      state: instance.currentState,
      status: instance.status,
      history: transitions.map((t) => ({
        from: t.fromState,
        to: t.toState,
        trigger: t.trigger,
        actor: { type: t.actorType, id: t.actorId },
        occurredAt: t.occurredAt,
      })),
    };
  }

  private read<T>(scope: PropertyScope, fn: () => Promise<T>): Promise<T> {
    return this.gate.execute(
      { action: 'task.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.read(fn),
    );
  }

  /** Localized title for the viewer; free text (quoted from a person) is returned as written. */
  private title(row: {
    titleKey: string | null;
    titleParams: Record<string, string | number> | null;
    title: string | null;
  }) {
    if (row.title !== null) return row.title;
    const locale = this.locale.get();
    return row.titleKey && this.i18n.has(row.titleKey, locale)
      ? this.i18n.t(row.titleKey, row.titleParams ?? {}, locale)
      : (row.titleKey ?? '');
  }

  private taskView(t: TaskRow) {
    return {
      id: t.id,
      workItemId: t.workItemId,
      title: this.title(t),
      titleKey: t.titleKey,
      status: t.status,
      priority: t.priority,
      dueAt: t.dueAt,
      departmentCode: t.departmentCode,
      locationId: t.locationId,
      assignee: t.assigneeType && t.assigneeId ? { type: t.assigneeType, id: t.assigneeId } : null,
      pauseReason: t.pauseReason,
      acceptedAt: t.acceptedAt,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      cancelledAt: t.cancelledAt,
      createdAt: t.createdAt,
      version: t.version,
    };
  }

  private workItemView(w: WorkItemRow) {
    return {
      id: w.id,
      kind: w.kind,
      title: this.title(w),
      titleKey: w.titleKey,
      status: w.status,
      priority: w.priority,
      source: {
        module: w.sourceModule,
        entityType: w.sourceEntityType,
        entityId: w.sourceEntityId,
      },
      departmentCode: w.departmentCode,
      serviceCode: w.serviceCode,
      locationId: w.locationId,
      stayId: w.stayId,
      guestId: w.guestId,
      createdBy: { type: w.createdByType, id: w.createdById },
      createdAt: w.createdAt,
      resolvedAt: w.resolvedAt,
      cancelledAt: w.cancelledAt,
      version: w.version,
    };
  }
}

/** The SLA as staff see it: targets, whether they were met or breached, and whether the clock is paused. */
function slaView(i: SlaInstanceRow | undefined) {
  if (!i) return null;
  return {
    status: i.status,
    startedAt: i.startedAt,
    responseDueAt: i.responseDueAt,
    resolutionDueAt: i.resolutionDueAt,
    responseMetAt: i.responseMetAt,
    resolutionMetAt: i.resolutionMetAt,
    responseBreached: i.responseBreachedAt !== null,
    resolutionBreached: i.resolutionBreachedAt !== null,
  };
}

function assignmentView(a: TaskAssignmentRow) {
  return {
    id: a.id,
    assignee: { type: a.assigneeType, id: a.assigneeId },
    assignedBy: { type: a.assignedByType, id: a.assignedById },
    assignedAt: a.assignedAt,
    reason: a.reason,
    unassignedAt: a.unassignedAt,
    endReason: a.endReason,
  };
}

function eventView(e: TaskEventRow) {
  return {
    id: e.id,
    type: e.type,
    from: e.fromStatus,
    to: e.toStatus,
    actor: { type: e.actorType, id: e.actorId },
    reason: e.reason,
    occurredAt: e.occurredAt,
  };
}

function nextCursor(rows: ReadonlyArray<{ id: string }>, limit: number): string | null {
  return rows.length === limit ? rows[rows.length - 1]!.id : null;
}
