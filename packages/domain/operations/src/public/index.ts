/** The ONLY surface other bounded contexts may import from this package (ADR-0001). */
import type { Priority, TaskStatus, WorkItemStatus } from '../domain/task-lifecycle';

export type { Priority, TaskStatus, WorkItemStatus };

/** A kind of work a module creates (`HK_JOB`, `WORK_ORDER`, `SERVICE_REQUEST`…), registered at module init. */
export interface WorkItemKindDefinition {
  readonly code: string;
  /** Owning context code (manifest `code`), e.g. `hk`. */
  readonly module: string;
  /** Locale key describing the kind for staff screens. */
  readonly descriptionKey: string;
}

/** A localized title (preferred: rendered per viewer) or free text quoted from a guest or staff member. */
export type WorkTitle =
  | { readonly key: string; readonly params?: Readonly<Record<string, string | number>> }
  | { readonly text: string };

/** Who a task goes to: one staff member, or a department's queue (any member can claim it). */
export type AssigneeInput =
  | { readonly type: 'USER'; readonly userId: string }
  | { readonly type: 'TEAM'; readonly departmentCode: string };

export interface NewTaskInput {
  /** Defaults to the work item's title. */
  readonly title?: WorkTitle;
  /** Defaults to the work item's department / location / priority. */
  readonly departmentCode?: string | null;
  readonly locationId?: string | null;
  readonly priority?: Priority;
  readonly dueAt?: Date | null;
  readonly assignTo?: AssigneeInput | null;
}

export interface CreateWorkItemInput {
  readonly tenantId: string;
  readonly propertyId: string;
  readonly kind: string;
  /** The module record this work belongs to (the module keeps its own domain data; ops keeps the work). */
  readonly source: {
    readonly module: string;
    readonly entityType: string;
    readonly entityId?: string | null;
  };
  readonly title: WorkTitle;
  readonly priority?: Priority;
  readonly locationId?: string | null;
  readonly departmentCode?: string | null;
  readonly stayId?: string | null;
  /** Must belong to the stay's party. */
  readonly guestId?: string | null;
  /** Defaults to one task inheriting the work item's title, department and location. */
  readonly tasks?: readonly NewTaskInput[];
}

export interface TaskSummary {
  readonly id: string;
  readonly workItemId: string;
  readonly status: TaskStatus;
  readonly priority: Priority;
  readonly departmentCode: string | null;
  readonly locationId: string | null;
  readonly assignee: {
    readonly type: 'USER' | 'TEAM' | 'AI' | 'ROBOT';
    readonly id: string;
  } | null;
  readonly dueAt: string | null;
  readonly version: number;
}

export interface WorkItemSummary {
  readonly id: string;
  readonly propertyId: string;
  readonly kind: string;
  readonly status: WorkItemStatus;
  readonly priority: Priority;
  readonly source: {
    readonly module: string;
    readonly entityType: string;
    readonly entityId: string | null;
  };
  readonly departmentCode: string | null;
  readonly locationId: string | null;
  readonly stayId: string | null;
  readonly guestId: string | null;
  readonly tasks: readonly TaskSummary[];
}

/**
 * How modules create and follow work (Spec §8: "do not rebuild separate task engines"). Calls join the caller's
 * transaction when there is one, so a module's record and its work item commit together.
 */
export interface OperationsPublicApi {
  registerWorkItemKind(kind: WorkItemKindDefinition): void;
  createWorkItem(input: CreateWorkItemInput): Promise<WorkItemSummary>;
  addTask(tenantId: string, workItemId: string, input: NewTaskInput): Promise<TaskSummary>;
  getWorkItem(tenantId: string, workItemId: string): Promise<WorkItemSummary | null>;
  workItemsForSource(
    tenantId: string,
    entityType: string,
    entityId: string,
  ): Promise<readonly WorkItemSummary[]>;
  /** The source module withdrew the work (e.g. the guest cancelled the request): open tasks are cancelled. */
  cancelWorkItem(tenantId: string, workItemId: string, reason: string): Promise<WorkItemSummary>;
}

/** Registered symbol: stays identical even if a bundler or test runner loads this entry twice. */
export const OPERATIONS_API = Symbol.for('hotella.domain.operations.api');

export { OPERATIONS_MANIFEST } from '../manifest';
