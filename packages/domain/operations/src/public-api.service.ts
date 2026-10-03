import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { TransactionRunner } from '@hotella/platform-database';
import { AlertService } from './application/alert.service';
import { ApprovalService, approvalSummary } from './application/approval.service';
import { TaskService } from './application/task.service';
import { WorkflowEngine } from './application/workflow.service';
import { WorkItemKindRegistry, WorkService } from './application/work.service';
import type {
  AssigneeInput,
  CreateWorkItemInput,
  ApprovalKindDefinition,
  ApprovalSummary,
  NewTaskInput,
  OperationsPublicApi,
  RaiseAlertInput,
  RequestApprovalInput,
  TaskSummary,
  WorkItemKindDefinition,
  WorkItemSummary,
} from './public';

@Injectable()
export class OperationsPublicApiService implements OperationsPublicApi {
  constructor(
    private readonly kinds: WorkItemKindRegistry,
    private readonly work: WorkService,
    private readonly alerts: AlertService,
    private readonly approvals: ApprovalService,
    private readonly workflows: WorkflowEngine,
    private readonly tx: TransactionRunner,
    private readonly modules: ModuleRef,
  ) {}

  registerWorkItemKind(kind: WorkItemKindDefinition): void {
    this.kinds.register(kind);
  }
  createWorkItem(input: CreateWorkItemInput): Promise<WorkItemSummary> {
    return this.tx.run(async () => {
      const created = await this.work.createWorkItem(input);
      if (!input.workflowCode) return created;
      await this.workflows.start(
        { tenantId: input.tenantId, propertyId: input.propertyId },
        created.id,
        input.workflowCode.toUpperCase(),
      );
      return (await this.work.getWorkItem({ tenantId: input.tenantId }, created.id))!;
    });
  }
  addTask(tenantId: string, workItemId: string, input: NewTaskInput): Promise<TaskSummary> {
    return this.work.addTask(tenantId, workItemId, input);
  }
  getWorkItem(tenantId: string, workItemId: string): Promise<WorkItemSummary | null> {
    return this.work.getWorkItem({ tenantId }, workItemId);
  }
  workItemsForSource(
    tenantId: string,
    entityType: string,
    entityId: string,
  ): Promise<readonly WorkItemSummary[]> {
    return this.work.workItemsForSource({ tenantId }, entityType, entityId);
  }
  openWorkItemsOfStay(tenantId: string, stayId: string): Promise<readonly WorkItemSummary[]> {
    return this.work.openWorkItemsOfStay({ tenantId }, stayId);
  }
  openWorkItemsAtLocation(
    tenantId: string,
    propertyId: string,
    locationId: string,
  ): Promise<readonly WorkItemSummary[]> {
    return this.work.openWorkItemsAtLocation({ tenantId, propertyId }, locationId);
  }
  assignTask(
    scope: { readonly tenantId: string; readonly propertyId: string },
    taskId: string,
    assignee: AssigneeInput,
    reason?: string | null,
  ): Promise<TaskSummary> {
    // The task lifecycle lives with the staff API (API process); resolved lazily so the worker composes without it.
    const tasks = this.modules.get(TaskService, { strict: false });
    return tasks.assign(scope, taskId, {
      assignee: assignee.type === 'USER' ? { type: 'USER', userId: assignee.userId } : assignee,
      ...(reason ? { reason } : {}),
    }) as Promise<TaskSummary>;
  }
  actOnTask(
    scope: { readonly tenantId: string; readonly propertyId: string },
    taskId: string,
    action: 'START' | 'COMPLETE',
    reason?: string | null,
  ): Promise<TaskSummary> {
    const tasks = this.modules.get(TaskService, { strict: false });
    return tasks.act(scope, taskId, action, reason ? { reason } : {}) as Promise<TaskSummary>;
  }
  cancelWorkItem(tenantId: string, workItemId: string, reason: string): Promise<WorkItemSummary> {
    return this.work.cancelWorkItem(tenantId, workItemId, reason);
  }
  raiseAlert(input: RaiseAlertInput): Promise<{ alertId: string; created: boolean }> {
    return this.tx.run(async () => {
      const { alert, created } = await this.alerts.raise(input);
      return { alertId: alert.id, created };
    });
  }
  registerApprovalKind(kind: ApprovalKindDefinition): void {
    this.approvals.registerKind(kind);
  }
  async requestApproval(input: RequestApprovalInput): Promise<ApprovalSummary> {
    return approvalSummary(await this.approvals.request(input));
  }
  async getApproval(tenantId: string, approvalId: string): Promise<ApprovalSummary | null> {
    const a = await this.approvals.find({ tenantId }, approvalId);
    return a ? approvalSummary(a) : null;
  }
}
