import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { TaskAssigned, TaskStatusChanged } from '@hotella/contracts-events';
import { uuidSchema } from '@hotella/contracts-api';
import {
  ActionGate,
  ActorStore,
  PERMISSION_RESOLVER,
  type PermissionResolver,
  type RequestActor,
} from '@hotella/platform-auth';
import { AuditWriter } from '@hotella/platform-audit';
import { isUuid, newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import {
  ACTION_PERMISSION,
  nextTaskStatus,
  SELF_SERVICE_ACTIONS,
  type TaskAction,
  type TaskStatus,
} from '../domain/task-lifecycle';
import { OperationsRepositories } from '../infrastructure/repositories';
import type { TaskRow } from '../infrastructure/schema';
import { taskSummary } from './work.service';
import { OPS_SOURCE, type ResolvedAssignee, WorkService } from './work.service';

const reason = z.string().trim().min(1).max(500);
const expectedVersion = z.number().int().min(1).optional();

export const assignTaskSchema = z.object({
  assignee: z.discriminatedUnion('type', [
    z.object({ type: z.literal('USER'), userId: uuidSchema }),
    z.object({
      type: z.literal('TEAM'),
      departmentCode: z.string().trim().toUpperCase().min(2).max(32),
    }),
  ]),
  reason: reason.optional(),
  expectedVersion,
});
export type AssignTaskInput = z.infer<typeof assignTaskSchema>;

/** Body of the plain lifecycle actions; pausing and cancelling must say why. */
export const taskActionSchema = z.object({ reason: reason.optional(), expectedVersion });
export const reasonRequiredSchema = z.object({ reason, expectedVersion });
export type TaskActionInput = z.infer<typeof taskActionSchema>;

/** Why an assignment ended (kept in the history). */
const END_REASON: Partial<Record<TaskAction, string>> = {
  ASSIGN: 'REASSIGNED',
  UNASSIGN: 'UNASSIGNED',
  REJECT: 'REJECTED',
  COMPLETE: 'COMPLETED',
  CANCEL: 'CANCELLED',
};

/**
 * The task lifecycle (Spec §8.2, BUILD_PLAN §7.5). Each action runs through the action gate, locks the task row,
 * checks the deterministic transition table, keeps the assignment history and the task's operational history, and
 * re-derives the work item's status — all in one transaction with the outbox events.
 */
@Injectable()
export class TaskService {
  constructor(
    private readonly repo: OperationsRepositories,
    private readonly work: WorkService,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly events: EventPublisher,
    private readonly audit: AuditWriter,
    private readonly actors: ActorStore,
    @Inject(PERMISSION_RESOLVER) private readonly permissions: PermissionResolver,
  ) {}

  assign(scope: PropertyScope, taskId: string, input: AssignTaskInput) {
    return this.act(scope, taskId, 'ASSIGN', input, input.assignee);
  }

  act(
    scope: PropertyScope,
    taskId: string,
    action: TaskAction,
    input: TaskActionInput,
    assigneeInput?: AssignTaskInput['assignee'],
  ) {
    return this.gate.execute(
      { action: ACTION_PERMISSION[action], tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const actor = this.actors.require();
          let task = await this.lock(scope, taskId);
          if (input.expectedVersion !== undefined && input.expectedVersion !== task.version)
            throw AppError.conflict('ops.task.version_conflict', { version: task.version });
          const now = new Date();

          let onBehalf = false;
          if (SELF_SERVICE_ACTIONS.includes(action)) {
            const mine = task.assigneeType === 'USER' && task.assigneeId === actor.id;
            const claimable =
              (action === 'ACCEPT' || action === 'START') &&
              (task.assigneeType === null || task.assigneeType === 'TEAM') &&
              (task.status === 'NEW' || task.status === 'ASSIGNED');
            if (claimable) {
              // A department member picks the task from the queue: it becomes theirs first.
              task = await this.changeAssignee(
                scope,
                task,
                actor,
                { type: 'USER', id: actor.id },
                now,
                {
                  claimed: true,
                },
              );
            } else if (!mine) {
              if (!(await this.isSupervisor(actor, scope)))
                throw AppError.forbidden('ops.task.not_assignee');
              onBehalf = true;
            }
          }

          if (action === 'ASSIGN') {
            const target = await this.work.resolveAssignee(scope, assigneeInput!);
            if (task.assigneeType === target.type && task.assigneeId === target.id)
              return taskSummary(task);
            this.ensureAllowed(task.status, action);
            task = await this.changeAssignee(scope, task, actor, target, now, {
              reason: input.reason ?? null,
            });
            await this.audit.record({
              action: 'ops.task.assign',
              entityType: 'task',
              entityId: task.id,
              tenantId: scope.tenantId,
              propertyId: scope.propertyId,
              after: { assignee: target },
              reason: input.reason ?? null,
            });
          } else {
            const to = this.ensureAllowed(task.status, action);
            const from = task.status;
            if (
              action === 'UNASSIGN' ||
              action === 'REJECT' ||
              action === 'COMPLETE' ||
              action === 'CANCEL'
            ) {
              const open = await this.repo.openAssignment(scope, task.id);
              if (open) await this.repo.closeAssignment(scope, open.id, now, END_REASON[action]!);
            }
            task = await this.repo.updateTask(scope, task.id, {
              status: to,
              ...(action === 'UNASSIGN' || action === 'REJECT'
                ? { assigneeType: null, assigneeId: null }
                : {}),
              ...(action === 'ACCEPT' || (action === 'START' && !task.acceptedAt)
                ? { acceptedAt: now }
                : {}),
              ...(action === 'START' && !task.startedAt ? { startedAt: now } : {}),
              ...(action === 'PAUSE' ? { pauseReason: input.reason ?? null } : {}),
              ...(action === 'RESUME' ? { pauseReason: null } : {}),
              ...(action === 'COMPLETE' ? { completedAt: now, pauseReason: null } : {}),
              ...(action === 'CANCEL' ? { cancelledAt: now, pauseReason: null } : {}),
            });
            await this.repo.insertTaskEvent({
              id: newId(),
              tenantId: scope.tenantId,
              propertyId: scope.propertyId,
              taskId: task.id,
              type: action,
              fromStatus: from,
              toStatus: to,
              actorType: actor.type,
              actorId: actor.id,
              reason: input.reason ?? null,
              payload: onBehalf ? { on_behalf: true } : {},
              occurredAt: now,
            });
            await this.events.publish(TaskStatusChanged, {
              tenantId: scope.tenantId,
              propertyId: scope.propertyId,
              source: OPS_SOURCE,
              aggregate: { type: 'task', id: task.id },
              payload: {
                task_id: task.id,
                work_item_id: task.workItemId,
                from,
                to,
                reason: action === 'PAUSE' || action === 'CANCEL' ? (input.reason ?? null) : null,
              },
            });
            if (action === 'UNASSIGN' || action === 'CANCEL' || onBehalf)
              await this.audit.record({
                action: `ops.task.${action.toLowerCase()}`,
                entityType: 'task',
                entityId: task.id,
                tenantId: scope.tenantId,
                propertyId: scope.propertyId,
                before: { status: from },
                after: { status: to, onBehalf },
                reason: input.reason ?? null,
              });
          }
          await this.work.recomputeStatus(scope, task.workItemId);
          return taskSummary(task);
        }),
    );
  }

  private async lock(scope: PropertyScope, taskId: string): Promise<TaskRow> {
    const task = isUuid(taskId) ? await this.repo.taskForUpdate(scope, taskId) : undefined;
    if (!task || task.propertyId !== scope.propertyId)
      throw AppError.notFound('ops.task.not_found');
    return task;
  }

  private ensureAllowed(status: TaskStatus, action: TaskAction): TaskStatus {
    const to = nextTaskStatus(status, action);
    if (!to) throw AppError.conflict('ops.task.transition_not_allowed', { action, status });
    return to;
  }

  private isSupervisor(actor: RequestActor, scope: PropertyScope): Promise<boolean> {
    return this.permissions.hasPermission(actor, 'task.assign', {
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
    });
  }

  /** Closes the open assignment (if any), opens the new one and moves the task to ASSIGNED. */
  private async changeAssignee(
    scope: PropertyScope,
    task: TaskRow,
    actor: RequestActor,
    target: ResolvedAssignee,
    now: Date,
    extra: { reason?: string | null; claimed?: boolean },
  ): Promise<TaskRow> {
    const open = await this.repo.openAssignment(scope, task.id);
    if (open)
      await this.repo.closeAssignment(
        scope,
        open.id,
        now,
        extra.claimed ? 'CLAIMED' : 'REASSIGNED',
      );
    await this.repo.insertAssignment({
      id: newId(),
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      taskId: task.id,
      assigneeType: target.type,
      assigneeId: target.id,
      assignedByType: actor.type,
      assignedById: actor.id,
      assignedAt: now,
      reason: extra.reason ?? null,
    });
    const updated = await this.repo.updateTask(scope, task.id, {
      status: 'ASSIGNED',
      assigneeType: target.type,
      assigneeId: target.id,
      // Handing work to a department puts it in that department's queue.
      ...(target.departmentCode ? { departmentCode: target.departmentCode } : {}),
      pauseReason: null,
    });
    await this.repo.insertTaskEvent({
      id: newId(),
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      taskId: task.id,
      type: extra.claimed ? 'CLAIM' : 'ASSIGN',
      fromStatus: task.status,
      toStatus: 'ASSIGNED',
      actorType: actor.type,
      actorId: actor.id,
      reason: extra.reason ?? null,
      payload: { assignee_type: target.type, assignee_id: target.id },
      occurredAt: now,
    });
    await this.events.publish(TaskAssigned, {
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      source: OPS_SOURCE,
      aggregate: { type: 'task', id: task.id },
      payload: {
        task_id: task.id,
        work_item_id: task.workItemId,
        assignee: { type: target.type, id: target.id },
        previous:
          task.assigneeType && task.assigneeId
            ? { type: task.assigneeType, id: task.assigneeId }
            : null,
      },
    });
    if (task.status !== 'ASSIGNED')
      await this.events.publish(TaskStatusChanged, {
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        source: OPS_SOURCE,
        aggregate: { type: 'task', id: task.id },
        payload: {
          task_id: task.id,
          work_item_id: task.workItemId,
          from: task.status,
          to: 'ASSIGNED',
          reason: null,
        },
      });
    return updated;
  }
}
