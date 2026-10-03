/**
 * Complaint rules (Spec §12): a complaint's lifecycle, which service recovery needs an approval, and when an AI
 * candidate is worth showing. Deterministic (CLAUDE.md rule 11); no model decides any of it.
 */

export const COMPLAINT_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];
export const COMPLAINT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type ComplaintSeverity = (typeof COMPLAINT_SEVERITIES)[number];
export const RECOVERY_KINDS = [
  'APOLOGY',
  'AMENITY',
  'MEAL',
  'DISCOUNT',
  'REFUND',
  'ROOM_MOVE',
  'OTHER',
] as const;
export type RecoveryKind = (typeof RECOVERY_KINDS)[number];

const NEXT: Readonly<Record<ComplaintStatus, readonly ComplaintStatus[]>> = {
  OPEN: ['IN_PROGRESS', 'RESOLVED'],
  IN_PROGRESS: ['RESOLVED'],
  // A resolved complaint can be reopened until it is closed; closed is final.
  RESOLVED: ['IN_PROGRESS', 'CLOSED'],
  CLOSED: [],
};

export function canMove(from: ComplaintStatus, to: ComplaintStatus): boolean {
  return NEXT[from].includes(to);
}

/** Recovery that costs the hotel money goes through an approval; its risk grows with the amount. */
export function recoveryApproval(
  kind: RecoveryKind,
  amountMinor: number | null,
  highFromMinor: number,
): { readonly required: false } | { readonly required: true; readonly risk: 'MEDIUM' | 'HIGH' } {
  const costs = kind === 'MEAL' || kind === 'DISCOUNT' || kind === 'REFUND';
  if (!costs) return { required: false };
  return { required: true, risk: (amountMinor ?? 0) >= highFromMinor ? 'HIGH' : 'MEDIUM' };
}

/** Recovery kinds that must state an amount. */
export function needsAmount(kind: RecoveryKind): boolean {
  return kind === 'DISCOUNT' || kind === 'REFUND';
}

/**
 * An AI candidate is kept only above a confidence floor; below it the conversation simply continues (a negative
 * sentence is not a complaint by itself).
 */
export const CANDIDATE_MIN_CONFIDENCE = 0.6;
