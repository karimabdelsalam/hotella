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
  /** Catalog service the work fulfils (SLA policies may target it). */
  readonly serviceCode?: string | null;
  readonly stayId?: string | null;
  /** Must belong to the stay's party. */
  readonly guestId?: string | null;
  /** Defaults to one task inheriting the work item's title, department and location. */
  readonly tasks?: readonly NewTaskInput[];
  /** Published workflow of the property that drives this work (BUILD_PLAN §7.2). */
  readonly workflowCode?: string | null;
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
  readonly serviceCode: string | null;
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
  /** Open and in-progress work items of a stay, whichever module created them (staff inbox context). */
  openWorkItemsOfStay(tenantId: string, stayId: string): Promise<readonly WorkItemSummary[]>;
  /** The source module withdrew the work (e.g. the guest cancelled the request): open tasks are cancelled. */
  /** Open work at a location (a room), e.g. engineering work that keeps a room from being ready. */
  openWorkItemsAtLocation(
    tenantId: string,
    propertyId: string,
    locationId: string,
  ): Promise<readonly WorkItemSummary[]>;
  /**
   * Assigns a task as the current actor (ActionGate `task.assign`; assignment history kept), e.g. a supervisor
   * applying a housekeeping assignment proposal. API process only.
   */
  assignTask(
    scope: { readonly tenantId: string; readonly propertyId: string },
    taskId: string,
    assignee: AssigneeInput,
    reason?: string | null,
  ): Promise<TaskSummary>;
  cancelWorkItem(tenantId: string, workItemId: string, reason: string): Promise<WorkItemSummary>;
  /** Declares an approval kind and the handler that runs once a person approves (Spec §8.4). */
  registerApprovalKind(kind: ApprovalKindDefinition): void;
  /** Asks for a decision; the requester is the current actor (an AI agent may not request CRITICAL actions). */
  requestApproval(input: RequestApprovalInput): Promise<ApprovalSummary>;
  getApproval(tenantId: string, approvalId: string): Promise<ApprovalSummary | null>;
  /** Raises (or refreshes) a deduplicated operational alert (Spec §15). */
  raiseAlert(
    input: RaiseAlertInput,
  ): Promise<{ readonly alertId: string; readonly created: boolean }>;
}

export interface RaiseAlertInput {
  readonly tenantId: string;
  readonly propertyId: string;
  /** Stable condition type, e.g. `REPEATED_AC_FAILURE`, `ARRIVAL_ROOM_NOT_READY`. */
  readonly type: string;
  readonly severity: 'INFO' | 'WARNING' | 'CRITICAL';
  /** Identifies the condition: raising the same key again updates the open alert instead of creating another. */
  readonly dedupeKey: string;
  readonly subject?: { readonly type: string; readonly id: string } | null;
  readonly evidence?: Record<string, unknown>;
}

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ApprovalSummary {
  readonly id: string;
  readonly tenantId: string;
  readonly propertyId: string;
  readonly kind: string;
  readonly status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';
  readonly riskLevel: RiskLevel;
  readonly subject: { readonly type: string; readonly id: string | null };
  readonly workItemId: string | null;
  readonly payload: Record<string, unknown>;
  readonly reason: string | null;
  readonly requestedBy: { readonly type: string; readonly id: string | null };
  readonly expiresAt: string;
  readonly decidedBy: { readonly type: string; readonly id: string | null } | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly executedAt: string | null;
}

/** A sensitive action that needs a person's approval (compensation, refund, OOO, an AI proposal…). */
export interface ApprovalKindDefinition {
  readonly code: string;
  readonly module: string;
  readonly descriptionKey: string;
  /** Performs the action once approved, inside the approving transaction (throwing rolls the approval back). */
  readonly handler?: (approval: ApprovalSummary) => Promise<void>;
}

export interface RequestApprovalInput {
  readonly tenantId: string;
  readonly propertyId: string;
  readonly kind: string;
  readonly riskLevel: RiskLevel;
  readonly subject: { readonly type: string; readonly id?: string | null };
  readonly workItemId?: string | null;
  /** What exactly would be done (amount, room, AI proposal…), shown to the decider. */
  readonly payload?: Record<string, unknown>;
  readonly reason?: string | null;
  /** Default by risk: CRITICAL 1 h, HIGH 4 h, otherwise 24 h. */
  readonly ttlMinutes?: number;
}

/** Registered symbol: stays identical even if a bundler or test runner loads this entry twice. */
export const OPERATIONS_API = Symbol.for('hotella.domain.operations.api');

export { OPERATIONS_MANIFEST } from '../manifest';
