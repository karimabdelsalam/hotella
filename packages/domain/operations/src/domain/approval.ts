/**
 * Generic approvals (Spec §8.4, CLAUDE.md rule 12): compensation, refunds, OOO/OOS, selected AI actions and other
 * sensitive changes wait for a human decision before their handler runs. Pure rules, unit-tested.
 */

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CANCELLED';

export interface ApprovalFacts {
  readonly status: ApprovalStatus;
  readonly riskLevel: RiskLevel;
  readonly requestedByType: string;
  readonly requestedById: string | null;
  readonly expiresAt: Date;
}

export interface Decider {
  readonly type: string;
  readonly id: string;
}

/** Why an approval cannot be requested, or null. An AI agent never even proposes a CRITICAL action. */
export function requestProblem(risk: RiskLevel, requesterType: string): string | null {
  if (risk === 'CRITICAL' && requesterType === 'AI_AGENT') return 'critical_not_for_ai';
  return null;
}

/**
 * Why `decider` cannot decide the request now, or null: only a pending, unexpired request; only a person (never an AI
 * agent, the system or an integration); never the person who asked for it (four eyes).
 */
export function decisionProblem(
  request: ApprovalFacts,
  decider: Decider,
  now: Date,
): string | null {
  if (request.status !== 'PENDING') return 'not_pending';
  if (request.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (decider.type !== 'USER') return 'human_required';
  if (request.requestedById !== null && request.requestedById === decider.id) return 'four_eyes';
  return null;
}

/** Default lifetime of a request by risk (a pending approval must not wait forever). */
export function defaultTtlMinutes(risk: RiskLevel): number {
  return risk === 'CRITICAL' ? 60 : risk === 'HIGH' ? 4 * 60 : 24 * 60;
}
