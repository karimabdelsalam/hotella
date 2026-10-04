import { CORE, type CapabilityKind, type MetricKind } from './catalog';

/** What a plan version grants and limits, as the administrator drafted it. */
export interface DraftContent {
  readonly items: readonly string[];
  readonly limits: readonly DraftLimit[];
}
export interface DraftLimit {
  readonly metricCode: string;
  readonly scope: 'TENANT' | 'PROPERTY';
  readonly period: 'NONE' | 'DAY' | 'MONTH';
  readonly limitValue: number;
  readonly enforcement: 'SOFT' | 'HARD';
}

export interface CatalogView {
  readonly capabilities: ReadonlyMap<
    string,
    { readonly kind: CapabilityKind; readonly moduleCode: string | null; readonly active: boolean }
  >;
  readonly metrics: ReadonlyMap<string, { readonly kind: MetricKind; readonly active: boolean }>;
}

export interface PlanProblem {
  readonly key: string;
  readonly params?: Record<string, string>;
}

/**
 * Checks a draft against the catalog. Drafts may be saved with problems that only publishing must refuse
 * (`forPublish`): an empty plan or one without CORE. Unknown or retired codes, a feature without its module and a
 * limit whose period does not fit the metric are refused at any time. Deterministic (rule 11).
 */
export function planProblems(
  content: DraftContent,
  catalog: CatalogView,
  forPublish: boolean,
): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const items = new Set(content.items);
  for (const code of items) {
    const c = catalog.capabilities.get(code);
    if (!c || !c.active) {
      problems.push({ key: 'license.plan.unknown_capability', params: { code } });
      continue;
    }
    if (c.kind === 'FEATURE' && c.moduleCode && !items.has(c.moduleCode))
      problems.push({
        key: 'license.plan.feature_without_module',
        params: { code, module: c.moduleCode },
      });
  }
  const seen = new Set<string>();
  for (const l of content.limits) {
    const m = catalog.metrics.get(l.metricCode);
    if (!m || !m.active) {
      problems.push({ key: 'license.plan.unknown_metric', params: { code: l.metricCode } });
      continue;
    }
    // A gauge (staff, properties, bytes) is a level: its limit has no period. A counter is summed per period.
    if ((m.kind === 'GAUGE') !== (l.period === 'NONE'))
      problems.push({
        key: 'license.plan.limit_period_invalid',
        params: { code: l.metricCode, period: l.period },
      });
    const key = `${l.metricCode}/${l.scope}/${l.period}`;
    if (seen.has(key))
      problems.push({ key: 'license.plan.limit_duplicate', params: { code: l.metricCode } });
    seen.add(key);
  }
  if (forPublish && !items.has(CORE)) problems.push({ key: 'license.plan.core_required' });
  return problems;
}
