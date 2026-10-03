import { Injectable } from '@nestjs/common';
import { WorkItemKindRegistry, WorkService } from './application/work.service';
import type {
  CreateWorkItemInput,
  NewTaskInput,
  OperationsPublicApi,
  TaskSummary,
  WorkItemKindDefinition,
  WorkItemSummary,
} from './public';

@Injectable()
export class OperationsPublicApiService implements OperationsPublicApi {
  constructor(
    private readonly kinds: WorkItemKindRegistry,
    private readonly work: WorkService,
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
}
