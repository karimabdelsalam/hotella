import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PRIORITIES } from '@hotella/contracts-events';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import {
  isUuid,
  newId,
  type PropertyScope,
  type TenantScope,
  TransactionRunner,
} from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { RISK_LEVELS } from '../domain/approval';
import { isTerminal } from '../domain/task-lifecycle';
import {
  definitionProblems,
  nextMove,
  type WorkflowAction,
  workflowDefinitionSchema,
} from '../domain/workflow';
import { OperationsRepositories } from '../infrastructure/repositories';
import { WorkflowRepositories } from '../infrastructure/workflow-repositories';
import type {
  ApprovalRequestRow,
  TaskRow,
  WorkflowInstanceRow,
  WorkflowVersionRow,
  WorkItemRow,
} from '../infrastructure/schema';
import { ApprovalService } from './approval.service';
import { WorkService } from './work.service';

export interface GuardContext {
  readonly item: WorkItemRow;
  readonly tasks: readonly TaskRow[];
  readonly approvals: readonly ApprovalRequestRow[];
}
export interface ActionContext {
  readonly scope: PropertyScope;
  readonly item: WorkItemRow;
  readonly instance: WorkflowInstanceRow;
  readonly params: Record<string, unknown>;
}
export type WorkflowGuard = (ctx: GuardContext) => boolean;
export type WorkflowActionHandler = (ctx: ActionContext) => Promise<void>;

const createTaskParams = z.object({
  titleKey: z.string().min(1).max(128).optional(),
  titleParams: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  title: z.string().min(1).max(500).optional(),
  departmentCode: z.string().min(2).max(32).optional(),
  priority: z.enum(PRIORITIES).optional(),
  /** Queue the task for this department. */
  assignToDepartment: z.string().min(2).max(32).optional(),
});
const requestApprovalParams = z.object({
  kind: z.string().min(2).max(64),
  riskLevel: z.enum(RISK_LEVELS).default('HIGH'),
  ttlMinutes: z
    .number()
    .int()
    .min(1)
    .max(7 * 24 * 60)
    .optional(),
  reason: z.string().max(500).optional(),
});
const cancelParams = z.object({ reason: z.string().max(200).default('workflow') });

/**
 * Named guards and actions a definition may use (BUILD_PLAN §7.2). Code registers them; definitions only combine them.
 * Other modules add theirs through `OPERATIONS_API` at boot.
 */
@Injectable()
export class WorkflowRegistry {
  private readonly guards = new Map<string, WorkflowGuard>();
  private readonly actions = new Map<string, WorkflowActionHandler>();

  registerGuard(name: string, guard: WorkflowGuard): void {
    if (this.guards.has(name)) throw new Error(`Workflow guard "${name}" registered twice`);
    this.guards.set(name, guard);
  }
  registerAction(name: string, handler: WorkflowActionHandler): void {
    if (this.actions.has(name)) throw new Error(`Workflow action "${name}" registered twice`);
    this.actions.set(name, handler);
  }
  guard(name: string): WorkflowGuard | undefined {
    return this.guards.get(name);
  }
  action(name: string): WorkflowActionHandler | undefined {
    return this.actions.get(name);
  }
  known() {
    return { guards: new Set(this.guards.keys()), actions: new Set(this.actions.keys()) };
  }
}

/**
 * The workflow interpreter (deterministic, CLAUDE.md rule 11): starts a run on the latest published version, moves it on
 * triggers (task lifecycle, approval outcomes, staff actions) and runs the move's actions in the same transaction.
 * Actions never fire triggers themselves, so a move cannot recurse.
 */
@Injectable()
export class WorkflowEngine {
  constructor(
    private readonly repo: WorkflowRepositories,
    private readonly ops: OperationsRepositories,
    private readonly registry: WorkflowRegistry,
    private readonly work: WorkService,
    private readonly approvals: ApprovalService,
    private readonly actors: ActorStore,
  ) {
    registry.registerGuard(
      'all_tasks_done',
      ({ tasks }) =>
        tasks.length > 0 &&
        tasks.every((t) => isTerminal(t.status)) &&
        tasks.some((t) => t.status === 'DONE'),
    );
    registry.registerGuard('no_open_tasks', ({ tasks }) =>
      tasks.every((t) => isTerminal(t.status)),
    );
    registry.registerGuard('has_open_tasks', ({ tasks }) =>
      tasks.some((t) => !isTerminal(t.status)),
    );
    registry.registerGuard(
      'last_approval_approved',
      ({ approvals }) => approvals[approvals.length - 1]?.status === 'APPROVED',
    );
    registry.registerAction('create_task', async ({ scope, item, params }) => {
      const p = createTaskParams.parse(params);
      await this.work.addTask(scope.tenantId, item.id, {
        ...(p.titleKey ? { title: { key: p.titleKey, params: p.titleParams } } : {}),
        ...(p.title ? { title: { text: p.title } } : {}),
        ...(p.departmentCode ? { departmentCode: p.departmentCode } : {}),
        ...(p.priority ? { priority: p.priority } : {}),
        ...(p.assignToDepartment
          ? { assignTo: { type: 'TEAM' as const, departmentCode: p.assignToDepartment } }
          : {}),
      });
    });
    registry.registerAction('request_approval', async ({ scope, item, params }) => {
      const p = requestApprovalParams.parse(params);
      await this.approvals.request({
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        kind: p.kind,
        riskLevel: p.riskLevel,
        subject: { type: 'work_item', id: item.id },
        workItemId: item.id,
        ttlMinutes: p.ttlMinutes,
        reason: p.reason,
      });
    });
    registry.registerAction('cancel_open_tasks', async ({ scope, item, params }) => {
      await this.work.cancelWorkItem(scope.tenantId, item.id, cancelParams.parse(params).reason);
    });
    // Approval outcomes move the workflow of the work item they belong to.
    approvals.onSettled(async (approval, outcome) => {
      if (approval.workItemId)
        await this.fire(
          { tenantId: approval.tenantId },
          approval.workItemId,
          `APPROVAL_${outcome}`,
        );
    });
  }

  /** Starts the property's published workflow `code` for a new work item. */
  async start(
    scope: PropertyScope,
    workItemId: string,
    code: string,
  ): Promise<WorkflowInstanceRow> {
    const definition = await this.repo.definitionByCode(scope, code);
    if (!definition || definition.status !== 'ACTIVE')
      throw new AppError('ops.workflow.not_found', HttpStatus.UNPROCESSABLE_ENTITY, { code });
    const version = await this.repo.publishedVersion(scope, definition.id);
    if (!version)
      throw new AppError('ops.workflow.not_published', HttpStatus.UNPROCESSABLE_ENTITY, { code });
    const def = version.definition;
    const terminal = def.states[def.initial]!.terminal;
    const instance = await this.repo.insertInstance({
      id: newId(),
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      versionId: version.id,
      workItemId,
      currentState: def.initial,
      status: terminal ? 'COMPLETED' : 'RUNNING',
      completedAt: terminal ? new Date() : null,
    });
    await this.ops.updateWorkItem(scope, workItemId, { workflowInstanceId: instance.id });
    await this.recordTransition(instance, null, def.initial, 'START');
    await this.run(scope, workItemId, instance, def.states[def.initial]!.onEnter);
    await this.work.recomputeStatus(scope, workItemId);
    return instance;
  }

  /** Applies a trigger to the work item's workflow; returns the new state, or null when it does not apply. */
  async fire(scope: TenantScope, workItemId: string, trigger: string): Promise<string | null> {
    const instance = await this.repo.instanceOfWorkItemForUpdate(scope, workItemId);
    if (!instance || instance.status !== 'RUNNING') return null;
    const version = (await this.repo.versionById(scope, instance.versionId))!;
    const ctx = await this.context(scope, workItemId);
    const move = nextMove(version.definition, instance.currentState, trigger, (name) =>
      Boolean(this.registry.guard(name)?.(ctx)),
    );
    if (!move) return null;
    const terminal = version.definition.states[move.to]!.terminal;
    const updated = await this.repo.updateInstance(scope, instance.id, {
      currentState: move.to,
      ...(terminal ? { status: 'COMPLETED' as const, completedAt: new Date() } : {}),
    });
    await this.recordTransition(instance, move.from, move.to, trigger);
    await this.run(
      { tenantId: instance.tenantId, propertyId: instance.propertyId },
      workItemId,
      updated,
      move.actions,
    );
    // The work item's status follows its tasks again once the workflow is over.
    if (terminal) await this.work.recomputeStatus(scope, workItemId);
    return move.to;
  }

  private async run(
    scope: PropertyScope,
    workItemId: string,
    instance: WorkflowInstanceRow,
    actions: readonly WorkflowAction[],
  ) {
    for (const action of actions) {
      const handler = this.registry.action(action.type);
      // Publishing validated every action; a module that stopped registering one is a deployment error.
      if (!handler) throw new Error(`Workflow action "${action.type}" is not registered`);
      const item = (await this.ops.workItem(scope, workItemId))!;
      await handler({ scope, item, instance, params: action.params });
    }
  }

  private async context(scope: TenantScope, workItemId: string): Promise<GuardContext> {
    const [item, tasks, approvals] = await Promise.all([
      this.ops.workItem(scope, workItemId),
      this.ops.tasksOfWorkItems(scope, [workItemId]),
      this.repo.approvalsOfWorkItem(scope, workItemId),
    ]);
    return { item: item!, tasks, approvals };
  }

  private recordTransition(
    instance: WorkflowInstanceRow,
    from: string | null,
    to: string,
    trigger: string,
  ) {
    const actor = this.actors.get();
    return this.repo.insertTransition({
      id: newId(),
      tenantId: instance.tenantId,
      propertyId: instance.propertyId,
      instanceId: instance.id,
      fromState: from,
      toState: to,
      trigger,
      actorType: actor?.type ?? 'SYSTEM',
      actorId: actor?.id ?? null,
      occurredAt: new Date(),
    });
  }
}

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{1,31}$/, 'UPPER_SNAKE_CASE, 2–32 characters');
export const createWorkflowSchema = z.object({ code });
export const addWorkflowVersionSchema = z.object({ definition: workflowDefinitionSchema });
export const manualTriggerSchema = z.object({
  action: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/),
});

function versionView(v: WorkflowVersionRow) {
  return {
    id: v.id,
    version: v.version,
    status: v.status,
    definition: v.definition,
    publishedAt: v.publishedAt,
    publishedById: v.publishedById,
  };
}

/** Workflow definitions of a property: drafts, validation and immutable publication (`workflow.manage`). */
@Injectable()
export class WorkflowAdminService {
  constructor(
    private readonly repo: WorkflowRepositories,
    private readonly registry: WorkflowRegistry,
    private readonly engine: WorkflowEngine,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly actors: ActorStore,
  ) {}

  list(scope: PropertyScope) {
    return this.manage(scope, true, async () => {
      const defs = await this.repo.listDefinitions(scope);
      const versions = await this.repo.versions(
        scope,
        defs.map((d) => d.id),
      );
      return defs.map((d) => ({
        id: d.id,
        code: d.code,
        status: d.status,
        versions: versions.filter((v) => v.definitionId === d.id).map(versionView),
      }));
    });
  }

  create(scope: PropertyScope, input: z.infer<typeof createWorkflowSchema>) {
    return this.manage(scope, false, async () => {
      if (await this.repo.definitionByCode(scope, input.code))
        throw AppError.conflict('ops.workflow.code_taken', { code: input.code });
      const def = await this.repo.insertDefinition({
        id: newId(),
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        code: input.code,
      });
      await this.audit.record({
        action: 'ops.workflow.create',
        entityType: 'workflow_definition',
        entityId: def.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        after: { code: def.code },
      });
      return { id: def.id, code: def.code, status: def.status, versions: [] };
    });
  }

  addVersion(scope: PropertyScope, code: string, input: z.infer<typeof addWorkflowVersionSchema>) {
    return this.manage(scope, false, async () => {
      const def = await this.repo.definitionByCodeForUpdate(scope, code.toUpperCase());
      if (!def) throw AppError.notFound('ops.workflow.not_found', { code });
      const existing = await this.repo.versions(scope, [def.id]);
      const version = await this.repo.insertVersion({
        id: newId(),
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        definitionId: def.id,
        version: (existing[existing.length - 1]?.version ?? 0) + 1,
        definition: input.definition,
        createdById: this.actors.require().id,
      });
      await this.audit.record({
        action: 'ops.workflow.version.create',
        entityType: 'workflow_version',
        entityId: version.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        after: { code: def.code, version: version.version },
      });
      return versionView(version);
    });
  }

  /** Validates against the registered guards/actions and freezes the version; the previous one is retired. */
  publish(scope: PropertyScope, code: string, versionNo: number) {
    return this.manage(scope, false, async () => {
      const def = await this.repo.definitionByCodeForUpdate(scope, code.toUpperCase());
      if (!def) throw AppError.notFound('ops.workflow.not_found', { code });
      const versions = await this.repo.versions(scope, [def.id]);
      const target = versions.find((v) => v.version === versionNo);
      if (!target)
        throw AppError.notFound('ops.workflow.version_not_found', { version: versionNo });
      if (target.status !== 'DRAFT')
        throw AppError.conflict('ops.workflow.version_published', { version: versionNo });
      const problems = definitionProblems(target.definition, this.registry.known());
      if (problems.length > 0)
        throw new AppError('ops.workflow.invalid', HttpStatus.UNPROCESSABLE_ENTITY, {
          problem: problems[0]!,
        });
      for (const v of versions.filter((x) => x.status === 'PUBLISHED'))
        await this.repo.updateVersion(scope, v.id, { status: 'RETIRED' });
      const published = await this.repo.updateVersion(scope, target.id, {
        status: 'PUBLISHED',
        publishedAt: new Date(),
        publishedById: this.actors.require().id,
      });
      await this.audit.record({
        action: 'ops.workflow.version.publish',
        entityType: 'workflow_version',
        entityId: target.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        after: { code: def.code, version: target.version },
      });
      return versionView(published);
    });
  }

  /** A named staff action on a work item's workflow (`MANUAL:<ACTION>`), e.g. WITHDRAW. */
  manual(scope: PropertyScope, workItemId: string, action: string) {
    return this.gate.execute(
      { action: 'task.assign', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const item = isUuid(workItemId) ? await this.repoItem(scope, workItemId) : undefined;
          if (!item) throw AppError.notFound('ops.work_item.not_found');
          const state = await this.engine.fire(scope, item.id, `MANUAL:${action}`);
          if (!state) throw AppError.conflict('ops.workflow.transition_not_allowed', { action });
          await this.audit.record({
            action: 'ops.workflow.manual',
            entityType: 'work_item',
            entityId: item.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: { action, state },
          });
          return { state };
        }),
    );
  }

  private async repoItem(scope: PropertyScope, id: string) {
    const instance = await this.repo.instanceOfWorkItem(scope, id);
    return instance && instance.propertyId === scope.propertyId ? { id } : undefined;
  }

  private manage<T>(scope: PropertyScope, read: boolean, fn: () => Promise<T>): Promise<T> {
    return this.gate.execute(
      { action: 'workflow.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => (read ? this.tx.read(fn) : this.tx.run(fn)),
    );
  }
}
