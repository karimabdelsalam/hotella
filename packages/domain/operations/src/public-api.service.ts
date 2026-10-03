import { Injectable } from '@nestjs/common';
import { TransactionRunner } from '@hotella/platform-database';
import { AlertService } from './application/alert.service';
import { ApprovalService, approvalSummary } from './application/approval.service';
import { WorkflowEngine } from './application/workflow.service';
import { WorkItemKindRegistry, WorkService } from './application/work.service';
import type {
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
