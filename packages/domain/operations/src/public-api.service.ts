import { Injectable } from '@nestjs/common';
import { TransactionRunner } from '@hotella/platform-database';
import { AlertService } from './application/alert.service';
import { WorkItemKindRegistry, WorkService } from './application/work.service';
import type {
  CreateWorkItemInput,
  NewTaskInput,
  OperationsPublicApi,
  RaiseAlertInput,
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
    private readonly tx: TransactionRunner,
  ) {}

  registerWorkItemKind(kind: WorkItemKindDefinition): void {
    this.kinds.register(kind);
  }
  createWorkItem(input: CreateWorkItemInput): Promise<WorkItemSummary> {
    return this.work.createWorkItem(input);
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
}
