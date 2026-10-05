import { describe, expect, it } from 'vitest';
import { qualityMetrics } from './quality';

describe('quality metrics (BUILD_PLAN 12.6)', () => {
  it('computes ratios and averages with their sample sizes, and leaves out metrics without samples', () => {
    const metrics = qualityMetrics({
      executions: [
        {
          agentCode: 'GUEST_CONCIERGE',
          agentVersionId: 'v5',
          total: 8,
          fallback: 2,
          costMinor: 40,
        },
      ],
      toolCalls: [{ agentCode: 'GUEST_CONCIERGE', agentVersionId: 'v5', total: 10, failed: 1 }],
      proposals: [{ agentCode: 'GUEST_CONCIERGE', agentVersionId: 'v5', decided: 4, rejected: 1 }],
      drafts: [
        { agentCode: 'GUEST_CONCIERGE', agentVersionId: 'v5', total: 3, editDistanceSum: 30 },
      ],
      replies: [{ agentCode: 'GUEST_CONCIERGE', agentVersionId: 'v5', total: 6, recontacted: 2 }],
      aiRequests: { total: 4, cancelled: 1 },
      recommendations: { accepted: 0, rejected: 0 },
    });
    expect(
      metrics.map((m) => `${m.agentCode}/${m.agentVersionId}/${m.metric}=${m.value}(${m.samples})`),
    ).toEqual([
      'GUEST_CONCIERGE/null/task_creation_accuracy=0.75(4)',
      'GUEST_CONCIERGE/v5/cost_per_execution_minor=5(8)',
      'GUEST_CONCIERGE/v5/draft_edit_distance=10(3)',
      'GUEST_CONCIERGE/v5/executions=8(8)',
      'GUEST_CONCIERGE/v5/fallback_rate=0.25(8)',
      'GUEST_CONCIERGE/v5/guest_recontact_rate=0.3333(6)',
      'GUEST_CONCIERGE/v5/human_override_rate=0.25(4)',
      'GUEST_CONCIERGE/v5/tool_failure_rate=0.1(10)',
    ]);
  });
});
