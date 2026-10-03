/**
 * AI risk and autonomy (Spec §32): deterministic code decides what an AI agent may do on its own. The decision depends
 * on the tool's risk, the agent version's autonomy policy and the kill switch for automatic actions — never on a
 * model's opinion (rule 11).
 */

export type Risk = 'READ' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type Decision = 'AUTO' | 'PROPOSE' | 'REFUSE';

export interface AutonomyPolicy {
  /** MEDIUM-risk tools this agent may run without a person (e.g. the concierge creating a request for its guest). */
  readonly autoMediumTools: readonly string[];
}

export const NO_AUTONOMY: AutonomyPolicy = { autoMediumTools: [] };

export function decide(input: {
  readonly tool: string;
  readonly risk: Risk;
  readonly autonomy: AutonomyPolicy;
  /** The `ai.kill.auto_actions` switch: everything but reading needs a person. */
  readonly autoActionsKilled: boolean;
}): { readonly decision: Decision; readonly reason: string } {
  switch (input.risk) {
    case 'READ':
      return { decision: 'AUTO', reason: 'READ' };
    case 'CRITICAL':
      return { decision: 'REFUSE', reason: 'CRITICAL_NOT_FOR_AI' };
    case 'HIGH':
      return { decision: 'PROPOSE', reason: 'HIGH_NEEDS_APPROVAL' };
    default:
      if (input.autoActionsKilled) return { decision: 'PROPOSE', reason: 'AUTO_ACTIONS_OFF' };
      if (input.risk === 'LOW') return { decision: 'AUTO', reason: 'LOW' };
      return input.autonomy.autoMediumTools.includes(input.tool)
        ? { decision: 'AUTO', reason: 'MEDIUM_ALLOWED' }
        : { decision: 'PROPOSE', reason: 'MEDIUM_NOT_ALLOWED' };
  }
}

const RANK: Record<Risk, number> = { READ: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

/** Orders risks (READ < LOW < MEDIUM < HIGH < CRITICAL). */
export function riskRank(risk: Risk): number {
  return RANK[risk];
}
