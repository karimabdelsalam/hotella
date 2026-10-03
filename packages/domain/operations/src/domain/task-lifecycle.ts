import type { PRIORITIES, TASK_STATUSES, WORK_ITEM_STATUSES } from '@hotella/contracts-events';

/**
 * Task lifecycle (Spec §8.2, BUILD_PLAN §7.5), deterministic and free of I/O. Every allowed move is listed here;
 * anything else is refused, so the HTTP layer, AI tools and future modules share one set of rules.
 */
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];

export type TaskAction =
  | 'ASSIGN'
  | 'UNASSIGN'
  | 'ACCEPT'
  | 'REJECT'
  | 'START'
  | 'PAUSE'
  | 'RESUME'
  | 'COMPLETE'
  | 'CANCEL';

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['DONE', 'CANCELLED'];
const OWNED: readonly TaskStatus[] = ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'PAUSED'];

const MOVES: Record<TaskAction, { readonly from: readonly TaskStatus[]; readonly to: TaskStatus }> =
  {
    // Reassignment hands the work over: the new assignee accepts again.
    ASSIGN: { from: ['NEW', ...OWNED], to: 'ASSIGNED' },
    UNASSIGN: { from: OWNED, to: 'NEW' },
    ACCEPT: { from: ['ASSIGNED'], to: 'ACCEPTED' },
    REJECT: { from: ['ASSIGNED'], to: 'NEW' },
    // Starting implies accepting: staff screens stay one tap (CLAUDE.md rule 23).
    START: { from: ['ASSIGNED', 'ACCEPTED'], to: 'IN_PROGRESS' },
    PAUSE: { from: ['IN_PROGRESS'], to: 'PAUSED' },
    RESUME: { from: ['PAUSED'], to: 'IN_PROGRESS' },
    COMPLETE: { from: OWNED, to: 'DONE' },
    CANCEL: { from: ['NEW', ...OWNED], to: 'CANCELLED' },
  };

/** The status after `action`, or null when the move is not allowed from `from`. */
export function nextTaskStatus(from: TaskStatus, action: TaskAction): TaskStatus | null {
  const move = MOVES[action];
  return move.from.includes(from) ? move.to : null;
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

/** Permission an actor needs for an action (the assignee rule is applied on top for the self-service actions). */
export const ACTION_PERMISSION: Record<TaskAction, string> = {
  ASSIGN: 'task.assign',
  UNASSIGN: 'task.assign',
  ACCEPT: 'task.accept',
  REJECT: 'task.accept',
  START: 'task.accept',
  PAUSE: 'task.accept',
  RESUME: 'task.accept',
  COMPLETE: 'task.complete',
  CANCEL: 'task.cancel',
};

/** Actions an assignee takes on their own task; anyone else needs `task.assign` (a supervisor acting for them). */
export const SELF_SERVICE_ACTIONS: readonly TaskAction[] = [
  'ACCEPT',
  'REJECT',
  'START',
  'PAUSE',
  'RESUME',
  'COMPLETE',
];

/**
 * A work item's status follows its tasks: OPEN until someone takes a task on, IN_PROGRESS while work happens,
 * RESOLVED when every task is finished and at least one was done, CANCELLED when all were cancelled.
 */
export function deriveWorkItemStatus(tasks: readonly TaskStatus[]): WorkItemStatus {
  if (tasks.length === 0) return 'OPEN';
  if (tasks.every(isTerminal)) return tasks.includes('DONE') ? 'RESOLVED' : 'CANCELLED';
  return tasks.some(
    (t) => t === 'ACCEPTED' || t === 'IN_PROGRESS' || t === 'PAUSED' || t === 'DONE',
  )
    ? 'IN_PROGRESS'
    : 'OPEN';
}

/** Work-item kinds are registered by modules (`HK_JOB`, `WORK_ORDER`…); codes are stable upper-snake identifiers. */
export const WORK_ITEM_KIND_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
