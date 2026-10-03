import type { ConnectorCapability, IntegrationHealthState } from '@hotella/contracts-connectors';

/**
 * Capabilities an instance can actually serve right now (Spec §47): what the administrator enabled, narrowed to what
 * the connected agent reported once it has reported anything.
 */
export function effectiveCapabilities(instance: {
  readonly status: string;
  readonly enabledCapabilities: readonly string[];
  readonly reportedCapabilities: readonly string[] | null;
}): ConnectorCapability[] {
  if (instance.status !== 'ACTIVE') return [];
  const enabled = instance.enabledCapabilities as ConnectorCapability[];
  if (!instance.reportedCapabilities) return [...enabled];
  const reported = new Set(instance.reportedCapabilities);
  return enabled.filter((c) => reported.has(c));
}

/** Window over which the error rate is computed: counters halve once `recent_total` exceeds it. */
export const HEALTH_WINDOW = 200;
/** An agent unseen for longer than this is OFFLINE (heartbeat every 30 s, fallback 60 s — ADR-0017 §3). */
export const AGENT_OFFLINE_AFTER_MS = 3 * 60_000;
/** Error rate (permille) above which an online instance is DEGRADED. */
export const DEGRADED_ERROR_PERMILLE = 50;

/** Deterministic health classification (Spec §57; CLAUDE.md rule 11). */
export function classifyHealth(input: {
  readonly now: Date;
  readonly agentLastSeenAt: Date | null;
  readonly lastSuccessAt: Date | null;
  readonly errorRatePermille: number;
  readonly authFailed?: boolean;
  readonly misconfigured?: boolean;
}): IntegrationHealthState {
  if (input.misconfigured) return 'MISCONFIGURED';
  if (input.authFailed) return 'AUTH_FAILED';
  const seen = input.agentLastSeenAt ?? input.lastSuccessAt;
  if (!seen || input.now.getTime() - seen.getTime() > AGENT_OFFLINE_AFTER_MS) return 'OFFLINE';
  return input.errorRatePermille > DEGRADED_ERROR_PERMILLE ? 'DEGRADED' : 'HEALTHY';
}

/** Updates the rolling success/failure counters; returns the new counters and error rate. */
export function recordOutcome(
  counters: { readonly recentTotal: number; readonly recentFailed: number },
  failed: boolean,
): { recentTotal: number; recentFailed: number; errorRatePermille: number } {
  let total = counters.recentTotal + 1;
  let fails = counters.recentFailed + (failed ? 1 : 0);
  if (total > HEALTH_WINDOW) {
    total = Math.ceil(total / 2);
    fails = Math.floor(fails / 2);
  }
  return {
    recentTotal: total,
    recentFailed: fails,
    errorRatePermille: Math.round((fails * 1000) / total),
  };
}
