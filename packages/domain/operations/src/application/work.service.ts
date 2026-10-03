import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  TaskAssigned,
  TaskStatusChanged,
  WorkItemCreated,
  WorkItemStatusChanged,
} from '@hotella/contracts-events';
import { GUEST_API, type GuestPublicApi } from '@hotella/domain-guest/public';
import { IDENTITY_API, type IdentityPublicApi } from '@hotella/domain-identity/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActorStore } from '@hotella/platform-auth';
import {
  isUuid,
  newId,
  type PropertyScope,
  type TenantScope,
  TransactionRunner,
} from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { RequestContext } from '@hotella/platform-observability';
import {
  deriveWorkItemStatus,
  isTerminal,
  WORK_ITEM_KIND_RE,
  type TaskStatus,
} from '../domain/task-lifecycle';
import { OperationsRepositories } from '../infrastructure/repositories';
import { WorkflowRepositories } from '../infrastructure/workflow-repositories';
import { OPS_SOURCE } from './constants';
import { SlaService } from './sla.service';
import type { TaskRow, WorkItemRow } from '../infrastructure/schema';
import type {
  AssigneeInput,
  CreateWorkItemInput,
  NewTaskInput,
  TaskSummary,
  WorkItemKindDefinition,
  WorkItemSummary,
  WorkTitle,
} from '../public';

/** Kinds of work registered by modules at boot; unknown kinds are refused rather than guessed. */
@Injectable()
export class WorkItemKindRegistry {
  private readonly kinds = new Map<string, WorkItemKindDefinition>();

  register(kind: WorkItemKindDefinition): void {
    if (!WORK_ITEM_KIND_RE.test(kind.code))
      throw new Error(`Work item kind "${kind.code}" must be UPPER_SNAKE_CASE`);
    const existing = this.kinds.get(kind.code);
    if (existing && existing.module !== kind.module)
      throw new Error(
        `Work item kind "${kind.code}" is already registered by module "${existing.module}"`,
      );
    this.kinds.set(kind.code, kind);
  }
  get(code: string): WorkItemKindDefinition | undefined {
    return this.kinds.get(code);
  }
  list(): WorkItemKindDefinition[] {
    return [...this.kinds.values()].sort((a, b) => a.code.localeCompare(b.code));
  }
}

export interface ResolvedAssignee {
  readonly type: 'USER' | 'TEAM';
  readonly id: string;
  /** For a TEAM: the department whose queue the task joins. */
  readonly departmentCode?: string;
}

export function taskSummary(t: TaskRow): TaskSummary {
  return {
    id: t.id,
    workItemId: t.workItemId,
    status: t.status,
    priority: t.priority,
    departmentCode: t.departmentCode,
    locationId: t.locationId,
    assignee: t.assigneeType && t.assigneeId ? { type: t.assigneeType, id: t.assigneeId } : null,
    dueAt: t.dueAt?.toISOString() ?? null,
    version: t.version,
  };
}

export function workItemSummary(w: WorkItemRow, taskRows: readonly TaskRow[]): WorkItemSummary {
  return {
    id: w.id,
    propertyId: w.propertyId,
    kind: w.kind,
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
    tasks: taskRows.filter((t) => t.workItemId === w.id).map(taskSummary),
  };
}

function titleColumns(title: WorkTitle) {
  return 'key' in title
    ? { titleKey: title.key, titleParams: { ...(title.params ?? {}) }, title: null }
    : { titleKey: null, titleParams: null, title: title.text };
}

/**
 * Work items and their tasks (Spec §8.1). Called by modules through OPERATIONS_API inside their own transaction;
 * every reference is validated against its owning context, never trusted.
 */
@Injectable()
export class WorkService {
  constructor(
    private readonly repo: OperationsRepositories,
    private readonly kinds: WorkItemKindRegistry,
    private readonly tx: TransactionRunner,
    private readonly events: EventPublisher,
    private readonly audit: AuditWriter,
    private readonly actors: ActorStore,
    private readonly ctx: RequestContext,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    @Inject(IDENTITY_API) private readonly identity: IdentityPublicApi,
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
    private readonly sla: SlaService,
    private readonly workflows: WorkflowRepositories,
  ) {}

  createWorkItem(input: CreateWorkItemInput): Promise<WorkItemSummary> {
    return this.tx.run(async () => {
      const scope: PropertyScope = { tenantId: input.tenantId, propertyId: input.propertyId };
      if (!this.kinds.get(input.kind))
        throw new AppError('ops.work_item.kind_unknown', HttpStatus.UNPROCESSABLE_ENTITY, {
          kind: input.kind,
        });
      const departmentCode = await this.department(scope, input.departmentCode);
      const locationId = await this.location(scope, input.locationId);
      const { stayId, guestId } = await this.stay(scope, input.stayId, input.guestId);
      const actor = this.actors.get();
      const priority = input.priority ?? 'NORMAL';
      const item = await this.repo.insertWorkItem({
        id: newId(),
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        kind: input.kind,
        sourceModule: input.source.module,
        sourceEntityType: input.source.entityType,
        sourceEntityId: input.source.entityId ?? null,
        ...titleColumns(input.title),
        priority,
        locationId,
        departmentCode,
        serviceCode: input.serviceCode ?? null,
        stayId,
        guestId,
        createdByType: actor?.type ?? 'SYSTEM',
        createdById: actor?.id ?? null,
        correlationId: this.ctx.correlationId ?? null,
      });
      // A workflow creates its own tasks; otherwise the work starts with one task like the work item.
      const specs = input.tasks?.length ? input.tasks : input.workflowCode ? [] : [{}];
      const created: TaskRow[] = [];
      for (const spec of specs) created.push(await this.insertTask(scope, item, spec));
      await this.events.publish(WorkItemCreated, {
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        source: OPS_SOURCE,
        aggregate: { type: 'work_item', id: item.id },
        payload: {
          work_item_id: item.id,
          kind: item.kind,
          source_module: item.sourceModule,
          source_entity_type: item.sourceEntityType,
          source_entity_id: item.sourceEntityId,
          priority: item.priority,
          department_code: item.departmentCode,
          location_id: item.locationId,
          stay_id: item.stayId,
          task_ids: created.map((t) => t.id),
        },
      });
      // Titles may quote a guest: the audit keeps the facts of the work, not its text (Spec §69).
      await this.audit.record({
        action: 'ops.work_item.create',
        entityType: 'work_item',
        entityId: item.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        after: {
          kind: item.kind,
          source: input.source,
          priority,
          departmentCode,
          locationId,
          stayId,
          tasks: created.map((t) => t.id),
        },
      });
      // The SLA clock starts with the work (most specific policy of the property, if any).
      await this.sla.start(scope, item);
      const final = await this.recomputeStatus(scope, item.id);
      return workItemSummary(final, created);
    });
  }

  addTask(tenantId: string, workItemId: string, input: NewTaskInput): Promise<TaskSummary> {
    return this.tx.run(async () => {
      const item = isUuid(workItemId)
        ? await this.repo.workItemForUpdate({ tenantId }, workItemId)
        : undefined;
      if (!item) throw AppError.notFound('ops.work_item.not_found');
      if (item.status === 'RESOLVED' || item.status === 'CANCELLED')
        throw AppError.conflict('ops.work_item.closed', { status: item.status });
      const task = await this.insertTask({ tenantId, propertyId: item.propertyId }, item, input);
      await this.recomputeStatus({ tenantId }, item.id);
      return taskSummary(task);
    });
  }

  async getWorkItem(scope: TenantScope, id: string): Promise<WorkItemSummary | null> {
    const item = isUuid(id) ? await this.repo.workItem(scope, id) : undefined;
    if (!item) return null;
    return workItemSummary(item, await this.repo.tasksOfWorkItems(scope, [item.id]));
  }

  async workItemsForSource(
    scope: TenantScope,
    entityType: string,
    entityId: string,
  ): Promise<WorkItemSummary[]> {
    if (!isUuid(entityId)) return [];
    const items = await this.repo.workItemsBySource(scope, entityType, entityId);
    const taskRows = await this.repo.tasksOfWorkItems(
      scope,
      items.map((i) => i.id),
    );
    return items.map((i) => workItemSummary(i, taskRows));
  }

  cancelWorkItem(tenantId: string, workItemId: string, reason: string): Promise<WorkItemSummary> {
    return this.tx.run(async () => {
      const scope = { tenantId };
      const current = isUuid(workItemId) ? await this.repo.workItem(scope, workItemId) : undefined;
      if (!current) throw AppError.notFound('ops.work_item.not_found');
      const actor = this.actors.get();
      const now = new Date();
      // Lock order task → work item, as in every task transition.
      for (const t of await this.repo.tasksOfWorkItems(scope, [current.id])) {
        const task = await this.repo.taskForUpdate(scope, t.id);
        if (!task || isTerminal(task.status)) continue;
        const open = await this.repo.openAssignment(scope, task.id);
        if (open) await this.repo.closeAssignment(scope, open.id, now, 'CANCELLED');
        await this.repo.updateTask(scope, task.id, { status: 'CANCELLED', cancelledAt: now });
        await this.repo.insertTaskEvent({
          id: newId(),
          tenantId,
          propertyId: task.propertyId,
          taskId: task.id,
          type: 'CANCEL',
          fromStatus: task.status,
          toStatus: 'CANCELLED',
          actorType: actor?.type ?? 'SYSTEM',
          actorId: actor?.id ?? null,
          reason,
          payload: { by_source: true },
          occurredAt: now,
        });
        await this.events.publish(TaskStatusChanged, {
          tenantId,
          propertyId: task.propertyId,
          source: OPS_SOURCE,
          aggregate: { type: 'task', id: task.id },
          payload: {
            task_id: task.id,
            work_item_id: task.workItemId,
            from: task.status,
            to: 'CANCELLED',
            reason: 'SOURCE_CANCELLED',
          },
        });
      }
      await this.audit.record({
        action: 'ops.work_item.cancel',
        entityType: 'work_item',
        entityId: current.id,
        tenantId,
        propertyId: current.propertyId,
        reason,
      });
      const item = await this.recomputeStatus(scope, current.id);
      return workItemSummary(item, await this.repo.tasksOfWorkItems(scope, [item.id]));
    });
  }

  /** Re-derives the work item's status from its tasks and announces a change (inside the caller's transaction). */
  async recomputeStatus(scope: TenantScope, workItemId: string): Promise<WorkItemRow> {
    const item = (await this.repo.workItemForUpdate(scope, workItemId))!;
    const statuses: TaskStatus[] = (await this.repo.tasksOfWorkItems(scope, [item.id])).map(
      (t) => t.status,
    );
    let next = deriveWorkItemStatus(statuses);
    // A running workflow still has steps to take (an approval, a follow-up task): the work is not over yet.
    if (next === 'RESOLVED' || next === 'CANCELLED') {
      const flow = await this.workflows.instanceOfWorkItem(scope, item.id);
      if (flow?.status === 'RUNNING') next = 'IN_PROGRESS';
    }
    if (next === item.status) {
      await this.sla.sync(scope, item.id);
      return item;
    }
    const now = new Date();
    const updated = await this.repo.updateWorkItem(scope, item.id, {
      status: next,
      resolvedAt: next === 'RESOLVED' ? now : null,
      cancelledAt: next === 'CANCELLED' ? now : null,
    });
    await this.events.publish(WorkItemStatusChanged, {
      tenantId: item.tenantId,
      propertyId: item.propertyId,
      source: OPS_SOURCE,
      aggregate: { type: 'work_item', id: item.id },
      payload: {
        work_item_id: item.id,
        kind: item.kind,
        source_entity_type: item.sourceEntityType,
        source_entity_id: item.sourceEntityId,
        from: item.status,
        to: next,
      },
    });
    await this.sla.sync(scope, item.id);
    return updated;
  }

  /** A USER must be able to take tasks at the property; a TEAM is an active department of the property. */
  async resolveAssignee(scope: PropertyScope, input: AssigneeInput): Promise<ResolvedAssignee> {
    if (input.type === 'USER') {
      const eligible = isUuid(input.userId)
        ? await this.identity.usersWithPermission(scope.tenantId, scope.propertyId, 'task.accept')
        : [];
      if (!eligible.includes(input.userId))
        throw new AppError('ops.task.assignee_invalid', HttpStatus.UNPROCESSABLE_ENTITY);
      return { type: 'USER', id: input.userId };
    }
    const department = await this.org.getDepartment(
      scope.tenantId,
      scope.propertyId,
      input.departmentCode,
    );
    if (!department || department.status !== 'ACTIVE')
      throw new AppError('ops.task.assignee_invalid', HttpStatus.UNPROCESSABLE_ENTITY);
    return { type: 'TEAM', id: department.id, departmentCode: department.code };
  }

  private async insertTask(
    scope: PropertyScope,
    item: WorkItemRow,
    spec: NewTaskInput,
  ): Promise<TaskRow> {
    const departmentCode =
      spec.departmentCode !== undefined
        ? await this.department(scope, spec.departmentCode)
        : item.departmentCode;
    const locationId =
      spec.locationId !== undefined ? await this.location(scope, spec.locationId) : item.locationId;
    const assignee = spec.assignTo ? await this.resolveAssignee(scope, spec.assignTo) : null;
    const queue = assignee?.departmentCode ?? departmentCode;
    const actor = this.actors.get();
    const now = new Date();
    const title = spec.title
      ? titleColumns(spec.title)
      : { titleKey: item.titleKey, titleParams: item.titleParams, title: item.title };
    const task = await this.repo.insertTask({
      id: newId(),
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      workItemId: item.id,
      ...title,
      status: assignee ? 'ASSIGNED' : 'NEW',
      priority: spec.priority ?? item.priority,
      dueAt: spec.dueAt ?? null,
      locationId,
      departmentCode: queue,
      assigneeType: assignee?.type ?? null,
      assigneeId: assignee?.id ?? null,
    });
    const actorRef = { actorType: actor?.type ?? 'SYSTEM', actorId: actor?.id ?? null };
    await this.repo.insertTaskEvent({
      id: newId(),
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      taskId: task.id,
      type: 'CREATE',
      fromStatus: null,
      toStatus: 'NEW',
      ...actorRef,
      payload: {},
      occurredAt: now,
    });
    if (assignee) {
      await this.repo.insertAssignment({
        id: newId(),
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        taskId: task.id,
        assigneeType: assignee.type,
        assigneeId: assignee.id,
        assignedByType: actorRef.actorType,
        assignedById: actorRef.actorId,
        assignedAt: now,
      });
      await this.repo.insertTaskEvent({
        id: newId(),
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        taskId: task.id,
        type: 'ASSIGN',
        fromStatus: 'NEW',
        toStatus: 'ASSIGNED',
        ...actorRef,
        payload: { assignee_type: assignee.type, assignee_id: assignee.id },
        occurredAt: now,
      });
      await this.events.publish(TaskAssigned, {
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        source: OPS_SOURCE,
        aggregate: { type: 'task', id: task.id },
        payload: {
          task_id: task.id,
          work_item_id: item.id,
          assignee: { type: assignee.type, id: assignee.id },
          previous: null,
        },
      });
    }
    return task;
  }

  private async department(
    scope: PropertyScope,
    code: string | null | undefined,
  ): Promise<string | null> {
    if (!code) return null;
    const department = await this.org.getDepartment(scope.tenantId, scope.propertyId, code);
    if (!department || department.status !== 'ACTIVE')
      throw new AppError('ops.work_item.reference_invalid', HttpStatus.UNPROCESSABLE_ENTITY, {
        field: 'departmentCode',
      });
    return department.code;
  }

  private async location(
    scope: PropertyScope,
    id: string | null | undefined,
  ): Promise<string | null> {
    if (!id) return null;
    if (!(await this.org.getLocation(scope.tenantId, scope.propertyId, id)))
      throw new AppError('ops.work_item.reference_invalid', HttpStatus.UNPROCESSABLE_ENTITY, {
        field: 'locationId',
      });
    return id;
  }

  private async stay(
    scope: PropertyScope,
    stayId: string | null | undefined,
    guestId: string | null | undefined,
  ): Promise<{ stayId: string | null; guestId: string | null }> {
    if (!stayId) {
      if (guestId)
        throw new AppError('ops.work_item.reference_invalid', HttpStatus.UNPROCESSABLE_ENTITY, {
          field: 'guestId',
        });
      return { stayId: null, guestId: null };
    }
    const stay = isUuid(stayId) ? await this.guests.getStay(scope.tenantId, stayId) : null;
    if (!stay || stay.propertyId !== scope.propertyId)
      throw new AppError('ops.work_item.reference_invalid', HttpStatus.UNPROCESSABLE_ENTITY, {
        field: 'stayId',
      });
    if (guestId && !stay.partyGuestIds.includes(guestId))
      throw new AppError('ops.work_item.reference_invalid', HttpStatus.UNPROCESSABLE_ENTITY, {
        field: 'guestId',
      });
    return { stayId: stay.id, guestId: guestId ?? null };
  }
}
