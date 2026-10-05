/**
 * AI quality and cost (Spec §41, BUILD_PLAN 12.6): metrics are ratios and averages computed by code from what the
 * platform recorded — never a model's opinion (rule 11). Each metric keeps its sample size; a metric without samples is
 * not reported.
 */

export interface QualityInputs {
  /** Executions per agent version (evaluation and shadow runs are left out). */
  readonly executions: ReadonlyArray<{
    readonly agentCode: string;
    readonly agentVersionId: string | null;
    readonly total: number;
    readonly fallback: number;
    readonly costMinor: number;
  }>;
  readonly toolCalls: ReadonlyArray<{
    agentCode: string;
    agentVersionId: string | null;
    total: number;
    failed: number;
  }>;
  readonly proposals: ReadonlyArray<{
    agentCode: string;
    agentVersionId: string | null;
    decided: number;
    rejected: number;
  }>;
  readonly drafts: ReadonlyArray<{
    agentCode: string;
    agentVersionId: string | null;
    total: number;
    editDistanceSum: number;
  }>;
  readonly replies: ReadonlyArray<{
    agentCode: string;
    agentVersionId: string | null;
    total: number;
    recontacted: number;
  }>;
  /** Service requests the AI created, and how many people cancelled within 24 h. */
  readonly aiRequests: { readonly total: number; readonly cancelled: number };
  /** Insight recommendations people took up or dismissed. */
  readonly recommendations: { readonly accepted: number; readonly rejected: number };
}

export interface QualityMetric {
  readonly agentCode: string;
  readonly agentVersionId: string | null;
  readonly metric: string;
  readonly value: number;
  readonly samples: number;
}

/** The agent the AI-created requests are attributed to, and the pseudo-agent of insights. */
export const REQUEST_AGENT = 'GUEST_CONCIERGE';
export const INSIGHTS_AGENT = 'INSIGHTS';

const round = (v: number) => Math.round(v * 10_000) / 10_000;
const ratio = (part: number, whole: number) => round(part / whole);

export function qualityMetrics(input: QualityInputs): QualityMetric[] {
  const out: QualityMetric[] = [];
  const push = (
    agentCode: string,
    agentVersionId: string | null,
    metric: string,
    value: number,
    samples: number,
  ) => {
    if (samples > 0) out.push({ agentCode, agentVersionId, metric, value: round(value), samples });
  };
  for (const e of input.executions) {
    push(e.agentCode, e.agentVersionId, 'executions', e.total, e.total);
    push(
      e.agentCode,
      e.agentVersionId,
      'fallback_rate',
      e.total ? ratio(e.fallback, e.total) : 0,
      e.total,
    );
    push(
      e.agentCode,
      e.agentVersionId,
      'cost_per_execution_minor',
      e.total ? e.costMinor / e.total : 0,
      e.total,
    );
  }
  for (const t of input.toolCalls)
    push(
      t.agentCode,
      t.agentVersionId,
      'tool_failure_rate',
      t.total ? ratio(t.failed, t.total) : 0,
      t.total,
    );
  for (const p of input.proposals)
    push(
      p.agentCode,
      p.agentVersionId,
      'human_override_rate',
      p.decided ? ratio(p.rejected, p.decided) : 0,
      p.decided,
    );
  for (const d of input.drafts)
    push(
      d.agentCode,
      d.agentVersionId,
      'draft_edit_distance',
      d.total ? d.editDistanceSum / d.total : 0,
      d.total,
    );
  for (const r of input.replies)
    push(
      r.agentCode,
      r.agentVersionId,
      'guest_recontact_rate',
      r.total ? ratio(r.recontacted, r.total) : 0,
      r.total,
    );
  const { total, cancelled } = input.aiRequests;
  push(REQUEST_AGENT, null, 'task_creation_accuracy', total ? 1 - cancelled / total : 0, total);
  const decided = input.recommendations.accepted + input.recommendations.rejected;
  push(
    INSIGHTS_AGENT,
    null,
    'recommendation_acceptance',
    decided ? input.recommendations.accepted / decided : 0,
    decided,
  );
  return out.sort(
    (a, b) =>
      a.agentCode.localeCompare(b.agentCode) ||
      (a.agentVersionId ?? '').localeCompare(b.agentVersionId ?? '') ||
      a.metric.localeCompare(b.metric),
  );
}
