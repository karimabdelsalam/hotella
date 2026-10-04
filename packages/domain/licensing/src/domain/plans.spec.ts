import { describe, expect, it } from 'vitest';
import { type CatalogView, planProblems } from './plans';

const catalog: CatalogView = {
  capabilities: new Map([
    ['CORE', { kind: 'MODULE', moduleCode: null, active: true }],
    ['HOUSEKEEPING', { kind: 'MODULE', moduleCode: null, active: true }],
    ['HK_READINESS', { kind: 'FEATURE', moduleCode: 'HOUSEKEEPING', active: true }],
    ['OLD_THING', { kind: 'ADDON', moduleCode: null, active: false }],
  ]),
  metrics: new Map([
    ['ACTIVE_STAFF', { kind: 'GAUGE', active: true }],
    ['AI_INPUT_TOKENS', { kind: 'COUNTER', active: true }],
  ]),
};

const keys = (p: ReturnType<typeof planProblems>) => p.map((x) => x.key);

describe('plan version rules', () => {
  it('accepts a complete plan', () => {
    expect(
      planProblems(
        {
          items: ['CORE', 'HOUSEKEEPING', 'HK_READINESS'],
          limits: [
            {
              metricCode: 'ACTIVE_STAFF',
              scope: 'TENANT',
              period: 'NONE',
              limitValue: 50,
              enforcement: 'HARD',
            },
            {
              metricCode: 'AI_INPUT_TOKENS',
              scope: 'PROPERTY',
              period: 'MONTH',
              limitValue: 1_000_000,
              enforcement: 'SOFT',
            },
          ],
        },
        catalog,
        true,
      ),
    ).toEqual([]);
  });

  it('needs CORE only to publish', () => {
    expect(planProblems({ items: [], limits: [] }, catalog, false)).toEqual([]);
    expect(keys(planProblems({ items: ['HOUSEKEEPING'], limits: [] }, catalog, true))).toEqual([
      'license.plan.core_required',
    ]);
  });

  it('refuses unknown or retired codes and a feature without its module', () => {
    expect(
      keys(
        planProblems(
          { items: ['CORE', 'NOPE', 'OLD_THING', 'HK_READINESS'], limits: [] },
          catalog,
          false,
        ),
      ),
    ).toEqual([
      'license.plan.unknown_capability',
      'license.plan.unknown_capability',
      'license.plan.feature_without_module',
    ]);
  });

  it('fits limit periods to the metric and refuses duplicates', () => {
    const limit = (metricCode: string, period: 'NONE' | 'DAY' | 'MONTH') => ({
      metricCode,
      scope: 'TENANT' as const,
      period,
      limitValue: 1,
      enforcement: 'HARD' as const,
    });
    expect(
      keys(
        planProblems(
          {
            items: ['CORE'],
            limits: [
              limit('ACTIVE_STAFF', 'MONTH'),
              limit('AI_INPUT_TOKENS', 'NONE'),
              limit('AI_INPUT_TOKENS', 'DAY'),
              limit('AI_INPUT_TOKENS', 'DAY'),
              limit('NOPE', 'DAY'),
            ],
          },
          catalog,
          true,
        ),
      ),
    ).toEqual([
      'license.plan.limit_period_invalid',
      'license.plan.limit_period_invalid',
      'license.plan.limit_duplicate',
      'license.plan.unknown_metric',
    ]);
  });
});
