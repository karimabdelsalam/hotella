import { describe, expect, it } from 'vitest';
import { canaryBucket, compareRuns, currentTrial, inCanary } from './release';

describe('canary bucketing (BUILD_PLAN 12.2)', () => {
  it('is stable per key and close to the asked share over many conversations', () => {
    const key = '01900000-0000-7000-8000-00000000c0de';
    expect(canaryBucket(key)).toBe(canaryBucket(key));
    const ids = Array.from(
      { length: 4000 },
      (_, i) => `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`,
    );
    const share = ids.filter((id) => inCanary(id, 20)).length / ids.length;
    expect(share).toBeGreaterThan(0.17);
    expect(share).toBeLessThan(0.23);
    expect(ids.some((id) => inCanary(id, 0))).toBe(false);
    expect(ids.every((id) => inCanary(id, 100))).toBe(true);
    // Raising the share only adds conversations: who was on the canary stays on it.
    expect(ids.filter((id) => inCanary(id, 20)).every((id) => inCanary(id, 50))).toBe(true);
  });
});

describe('currentTrial', () => {
  const at = (n: number) => new Date(Date.UTC(2026, 9, 5, 10, n));
  it('follows the latest release row', () => {
    expect(currentTrial([])).toBeNull();
    expect(
      currentTrial([
        { agentVersionId: 'v2', stage: 'CANARY', canaryPercent: 10, createdAt: at(2) },
      ]),
    ).toEqual({ stage: 'CANARY', versionId: 'v2', percent: 10 });
    expect(
      currentTrial([
        { agentVersionId: 'v2', stage: 'SHADOW', canaryPercent: null, createdAt: at(3) },
        { agentVersionId: 'v2', stage: 'CANARY', canaryPercent: 10, createdAt: at(2) },
      ]),
    ).toEqual({ stage: 'SHADOW', versionId: 'v2' });
    for (const stage of ['ACTIVE', 'ROLLED_BACK'] as const)
      expect(
        currentTrial([
          { agentVersionId: 'v2', stage, canaryPercent: null, createdAt: at(4) },
          { agentVersionId: 'v2', stage: 'CANARY', canaryPercent: 10, createdAt: at(2) },
        ]),
      ).toBeNull();
  });
});

describe('compareRuns', () => {
  it('passes when both answered with the same tools and hand-off, and names each difference', () => {
    const active = {
      tools: ['catalog.list_services', 'operations.create_service_request'],
      handoff: null,
      answered: true,
    };
    expect(
      compareRuns(active, {
        ...active,
        tools: ['operations.create_service_request', 'catalog.list_services'],
      }).outcome,
    ).toBe('PASS');
    expect(
      compareRuns(active, { tools: [], handoff: 'COMPLAINT', answered: true }).checks.filter(
        (c) => c.outcome === 'FAIL',
      ),
    ).toEqual([
      { expectation: 'SAME_TOOLS', outcome: 'FAIL', detail: 'TOOLS_DIFFER' },
      { expectation: 'SAME_HANDOFF', outcome: 'FAIL', detail: 'HANDOFF_COMPLAINT' },
    ]);
    expect(compareRuns(active, { ...active, answered: false }).checks[0]).toEqual({
      expectation: 'BOTH_ANSWERED',
      outcome: 'FAIL',
      detail: 'SHADOW_NO_ANSWER',
    });
  });
});
