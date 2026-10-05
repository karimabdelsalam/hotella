/**
 * Agent releases (Spec §40, BUILD_PLAN 12.2): which version answers a conversation is deterministic code. A canary
 * takes a fixed share of conversations — the same conversation always lands on the same side — and a shadow version
 * only ever runs beside the active one, never answering or acting.
 */

export type ReleaseStage = 'SHADOW' | 'CANARY' | 'ACTIVE' | 'ROLLED_BACK';

/** A stable bucket 0–99 for a key (FNV-1a over UTF-16 code units). */
export function canaryBucket(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return h % 100;
}

/** Whether a conversation runs on the canary version. */
export function inCanary(key: string, percent: number): boolean {
  return canaryBucket(key) < percent;
}

export interface ReleaseRow {
  readonly agentVersionId: string;
  readonly stage: ReleaseStage;
  readonly canaryPercent: number | null;
  readonly createdAt: Date;
}

/** A candidate being tried beside the active version, if any. */
export type Trial =
  | { readonly stage: 'SHADOW'; readonly versionId: string }
  | { readonly stage: 'CANARY'; readonly versionId: string; readonly percent: number };

/**
 * The trial in progress from the release history (newest first): the latest row decides — a SHADOW or CANARY row
 * starts (or changes) a trial; ACTIVE and ROLLED_BACK end it.
 */
export function currentTrial(history: readonly ReleaseRow[]): Trial | null {
  const latest = history[0];
  if (!latest) return null;
  if (latest.stage === 'SHADOW') return { stage: 'SHADOW', versionId: latest.agentVersionId };
  if (latest.stage === 'CANARY' && latest.canaryPercent)
    return { stage: 'CANARY', versionId: latest.agentVersionId, percent: latest.canaryPercent };
  return null;
}

/**
 * How a shadow run compares with the active one (codes, never text): the same tools called, the same hand-off, both
 * answered. Tools the runtime calls itself (the final reply) are left out.
 */
export function compareRuns(
  active: {
    readonly tools: readonly string[];
    readonly handoff: string | null;
    readonly answered: boolean;
  },
  shadow: {
    readonly tools: readonly string[];
    readonly handoff: string | null;
    readonly answered: boolean;
  },
): {
  readonly outcome: 'PASS' | 'FAIL';
  readonly checks: ReadonlyArray<{
    expectation: string;
    outcome: 'PASS' | 'FAIL';
    detail?: string;
  }>;
} {
  const set = (tools: readonly string[]) => [...new Set(tools)].sort().join(',');
  const checks = [
    {
      expectation: 'BOTH_ANSWERED',
      ok: active.answered === shadow.answered,
      detail: shadow.answered ? 'ACTIVE_NO_ANSWER' : 'SHADOW_NO_ANSWER',
    },
    {
      expectation: 'SAME_TOOLS',
      ok: set(active.tools) === set(shadow.tools),
      detail: 'TOOLS_DIFFER',
    },
    {
      expectation: 'SAME_HANDOFF',
      ok: active.handoff === shadow.handoff,
      detail: `HANDOFF_${shadow.handoff ?? 'NONE'}`,
    },
  ].map((c) =>
    c.ok
      ? { expectation: c.expectation, outcome: 'PASS' as const }
      : { expectation: c.expectation, outcome: 'FAIL' as const, detail: c.detail },
  );
  return { outcome: checks.every((c) => c.outcome === 'PASS') ? 'PASS' : 'FAIL', checks };
}
