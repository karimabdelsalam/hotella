import type { ServiceRequestStatus } from '../public';

/** Request status from its work item's status (BUILD_PLAN §9.2); the operations engine drives the work. */
export function statusForWorkItem(
  workItem: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CANCELLED',
): ServiceRequestStatus {
  switch (workItem) {
    case 'OPEN':
      return 'OPEN';
    case 'IN_PROGRESS':
      return 'IN_PROGRESS';
    case 'RESOLVED':
      return 'COMPLETED';
    case 'CANCELLED':
      return 'CANCELLED';
  }
}

export function isTerminal(status: ServiceRequestStatus): boolean {
  return status === 'COMPLETED' || status === 'CANCELLED';
}

/** Who may cancel: the guest while nobody started; staff (`request.manage`) until it is done. */
export function canCancel(status: ServiceRequestStatus, by: 'GUEST' | 'STAFF'): boolean {
  return by === 'GUEST' ? status === 'OPEN' : status === 'OPEN' || status === 'IN_PROGRESS';
}
