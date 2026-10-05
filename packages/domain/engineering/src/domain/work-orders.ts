/**
 * Work order rules (Spec §10.4–§10.5, §10.9): deterministic (rule 11), unit-tested.
 */

export const WORK_ORDER_TYPES = [
  'CORRECTIVE',
  'PREVENTIVE',
  'PREDICTIVE',
  'INSPECTION',
  'EMERGENCY',
  'PROJECT',
] as const;
export type WorkOrderType = (typeof WORK_ORDER_TYPES)[number];
export type WorkOrderStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';

/** Failures must be coded before they close, so reliability history can be counted. */
const NEEDS_TAXONOMY: ReadonlySet<WorkOrderType> = new Set(['CORRECTIVE', 'EMERGENCY']);

export interface Coding {
  readonly symptomCode: string | null;
  readonly failureModeCode: string | null;
  readonly causeCode: string | null;
  readonly resolutionCode: string | null;
}

/** The taxonomy fields still missing to close an order of this type (empty when it may close). */
export function missingCoding(type: WorkOrderType, coding: Coding): string[] {
  if (!NEEDS_TAXONOMY.has(type)) return [];
  return (
    [
      ['symptomCode', coding.symptomCode],
      ['failureModeCode', coding.failureModeCode],
      ['causeCode', coding.causeCode],
      ['resolutionCode', coding.resolutionCode],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);
}

/** Whole minutes of downtime; null while it has not started or not ended. */
export function downtimeMinutes(started: Date | null, ended: Date | null): number | null {
  if (!started || !ended) return null;
  return Math.max(0, Math.round((ended.getTime() - started.getTime()) / 60_000));
}

/** Default priority of new work: emergencies are urgent, guest-reported failures high. */
export function defaultPriority(
  type: WorkOrderType,
  source: 'STAFF' | 'GUEST_REQUEST' | 'PM' | 'INSPECTION' | 'AI' | 'TELEMETRY',
): 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' {
  if (type === 'EMERGENCY') return 'URGENT';
  if (type === 'CORRECTIVE' && source === 'GUEST_REQUEST') return 'HIGH';
  if (type === 'PREVENTIVE' || type === 'PROJECT') return 'LOW';
  return 'NORMAL';
}

/** The work order follows its work item; finished orders keep their outcome. */
export function statusFor(
  current: WorkOrderStatus,
  workItem: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CANCELLED',
): WorkOrderStatus | null {
  if (current === 'DONE' || current === 'CANCELLED') return null;
  const next: WorkOrderStatus =
    workItem === 'RESOLVED' ? 'DONE' : workItem === 'CANCELLED' ? 'CANCELLED' : workItem;
  return next === current ? null : next;
}

/** A failure of equipment under warranty on the day it was reported (dates in the property's calendar). */
export function underWarranty(warrantyUntil: string | null, reportedDay: string): boolean {
  return warrantyUntil !== null && warrantyUntil >= reportedDay;
}
