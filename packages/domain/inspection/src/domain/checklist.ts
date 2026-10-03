/**
 * The checklist language of the inspection engine (Spec §11) and its deterministic evaluation (CLAUDE.md rule 11):
 * which answers pass, which failures become findings of which severity, the score and the overall result. No model
 * decides any of it.
 */

export const ITEM_KINDS = [
  'PASS_FAIL',
  'YES_NO',
  'SCORE',
  'NUMBER',
  'TEXT',
  'PHOTO',
  'MULTI_SELECT',
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const SEVERITIES = ['INFO', 'MINOR', 'MAJOR', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** How an item is answered and judged. Text and photo items are evidence only: they never fail. */
export interface ItemRule {
  readonly kind: ItemKind;
  readonly required: boolean;
  /** YES_NO: the answer that passes (default YES). */
  readonly expected?: 'YES' | 'NO';
  /** SCORE: the scale (default 1..5) and the lowest passing score. */
  readonly scaleMax?: number;
  readonly passFrom?: number;
  /** NUMBER: the acceptable range (inclusive). */
  readonly min?: number;
  readonly max?: number;
  /** MULTI_SELECT: the option codes, and those that fail when chosen (e.g. "MOULD", "LEAK"). */
  readonly options?: readonly string[];
  readonly failOptions?: readonly string[];
  /** The severity of the finding a failed answer raises. */
  readonly failSeverity: Severity;
}

export type Answer =
  | { readonly kind: 'PASS_FAIL'; readonly value: 'PASS' | 'FAIL' }
  | { readonly kind: 'YES_NO'; readonly value: 'YES' | 'NO' }
  | { readonly kind: 'SCORE'; readonly value: number }
  | { readonly kind: 'NUMBER'; readonly value: number }
  | { readonly kind: 'TEXT'; readonly value: string }
  | { readonly kind: 'PHOTO'; readonly value: readonly string[] }
  | { readonly kind: 'MULTI_SELECT'; readonly value: readonly string[] };

export type ItemOutcome = 'PASS' | 'FAIL' | 'NOT_GRADED' | 'MISSING';

/** Checks an answer fits its item (kind, scale, options) before it is stored; null when it does. */
export function answerProblem(rule: ItemRule, answer: Answer): string | null {
  if (answer.kind !== rule.kind) return 'kind';
  switch (answer.kind) {
    case 'SCORE': {
      const max = rule.scaleMax ?? 5;
      return Number.isInteger(answer.value) && answer.value >= 0 && answer.value <= max
        ? null
        : 'scale';
    }
    case 'NUMBER':
      return Number.isFinite(answer.value) ? null : 'number';
    case 'MULTI_SELECT':
      return answer.value.every((v) => rule.options?.includes(v)) ? null : 'option';
    case 'TEXT':
      return answer.value.trim().length > 0 ? null : 'empty';
    case 'PHOTO':
      return answer.value.length > 0 ? null : 'empty';
    default:
      return null;
  }
}

/** Whether one answer passes its item. */
export function judge(rule: ItemRule, answer: Answer | undefined): ItemOutcome {
  if (!answer) return rule.required ? 'MISSING' : 'NOT_GRADED';
  switch (answer.kind) {
    case 'PASS_FAIL':
      return answer.value === 'PASS' ? 'PASS' : 'FAIL';
    case 'YES_NO':
      return answer.value === (rule.expected ?? 'YES') ? 'PASS' : 'FAIL';
    case 'SCORE':
      return answer.value >= (rule.passFrom ?? Math.ceil((rule.scaleMax ?? 5) / 2))
        ? 'PASS'
        : 'FAIL';
    case 'NUMBER':
      return (rule.min === undefined || answer.value >= rule.min) &&
        (rule.max === undefined || answer.value <= rule.max)
        ? 'PASS'
        : 'FAIL';
    case 'MULTI_SELECT':
      return answer.value.some((v) => rule.failOptions?.includes(v)) ? 'FAIL' : 'PASS';
    case 'TEXT':
    case 'PHOTO':
      return 'NOT_GRADED';
  }
}

export interface Evaluation {
  /** Items still to answer before the inspection can be completed. */
  readonly missing: readonly string[];
  /** Failed items with the severity of the finding each raises. */
  readonly findings: ReadonlyArray<{ readonly itemCode: string; readonly severity: Severity }>;
  /** Share of graded items that passed, 0..100 (100 when nothing is graded). */
  readonly score: number;
  /** FAIL as soon as one finding is MAJOR or CRITICAL. */
  readonly result: 'PASS' | 'FAIL';
}

export function evaluate(
  items: ReadonlyArray<{ readonly code: string; readonly rule: ItemRule }>,
  answers: ReadonlyMap<string, Answer>,
): Evaluation {
  const missing: string[] = [];
  const findings: Array<{ itemCode: string; severity: Severity }> = [];
  let graded = 0;
  let passed = 0;
  for (const item of items) {
    const outcome = judge(item.rule, answers.get(item.code));
    if (outcome === 'MISSING') missing.push(item.code);
    if (outcome === 'PASS' || outcome === 'FAIL') graded++;
    if (outcome === 'PASS') passed++;
    if (outcome === 'FAIL')
      findings.push({ itemCode: item.code, severity: item.rule.failSeverity });
  }
  const score = graded === 0 ? 100 : Math.round((passed / graded) * 100);
  const result = findings.some((f) => f.severity === 'MAJOR' || f.severity === 'CRITICAL')
    ? 'FAIL'
    : 'PASS';
  return { missing, findings, score, result };
}

/** Problems with an item definition before a version can be published (null when it is sound). */
export function ruleProblem(rule: ItemRule): string | null {
  if (rule.kind === 'SCORE') {
    const max = rule.scaleMax ?? 5;
    if (!Number.isInteger(max) || max < 2 || max > 10) return 'scale';
    if (rule.passFrom !== undefined && (rule.passFrom < 0 || rule.passFrom > max))
      return 'pass_from';
  }
  if (
    rule.kind === 'NUMBER' &&
    rule.min !== undefined &&
    rule.max !== undefined &&
    rule.min > rule.max
  )
    return 'range';
  if (rule.kind === 'MULTI_SELECT') {
    if (!rule.options || rule.options.length === 0) return 'options';
    if (rule.failOptions?.some((o) => !rule.options!.includes(o))) return 'fail_options';
  }
  return null;
}
