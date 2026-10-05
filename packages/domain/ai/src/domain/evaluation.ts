/**
 * Agent evaluation (Spec §40, BUILD_PLAN 12.1): a case is a synthetic conversation with what each tool would answer
 * and what the agent must and must not do; grading is deterministic code over what the agent did — never a model's
 * opinion (CLAUDE.md rule 11). Checks carry codes, never free text.
 */
import { z } from 'zod';
import { HANDOFF_REASONS } from './agents';

const LOCALES = ['ar', 'en', 'it', 'ru', 'de'] as const;
const DATA_CLASS = z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL']);

/** What the agent is given: the turns so far (guest or staff, and earlier agent replies), language and context. */
export const caseInputSchema = z.object({
  locale: z.enum(LOCALES),
  turns: z
    .array(
      z.object({
        from: z.enum(['person', 'agent']),
        text: z.string().trim().min(1).max(2000),
      }),
    )
    .min(1)
    .max(20)
    .refine((turns) => turns.at(-1)?.from === 'person', 'the last turn is the person’s'),
  /** Synthetic context parts the runtime would have built (no real guest data, CONFIDENTIAL at most). */
  context: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z][a-z0-9_.]{1,40}$/),
        text: z.string().max(4000),
        dataClass: DATA_CLASS,
      }),
    )
    .max(10)
    .default([]),
});
export type CaseInput = z.infer<typeof caseInputSchema>;

/** What a tool answers in a dry run (the outcome the executor would have produced). */
export const toolFixtureSchema = z.union([
  z.object({ status: z.literal('OK'), result: z.unknown() }),
  z.object({ status: z.literal('ERROR'), code: z.string().max(80) }),
]);
export const toolFixturesSchema = z.record(z.string().max(80), toolFixtureSchema).default({});
export type ToolFixtures = z.infer<typeof toolFixturesSchema>;

const matcher = z.union([
  z.object({ equals: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
  z.object({ contains: z.string().min(1).max(200) }),
  z.object({ present: z.boolean() }),
]);
export type ArgumentMatcher = z.infer<typeof matcher>;

const OUTCOMES = ['OK', 'PROPOSED', 'REFUSED', 'ERROR'] as const;
export type DryOutcome = (typeof OUTCOMES)[number];

export const expectationsSchema = z
  .object({
    /** Tools the agent must call (in any order), optionally with argument matchers and the policy outcome. */
    toolsCalled: z
      .array(
        z.object({
          tool: z.string().max(80),
          args: z.record(z.string().max(60), matcher).optional(),
          outcome: z.enum(OUTCOMES).optional(),
        }),
      )
      .max(10)
      .default([]),
    toolsNotCalled: z.array(z.string().max(80)).max(20).default([]),
    /** NONE: the agent must not hand off; ANY: it must; a reason: it must, with that reason. */
    handoff: z.union([z.enum(HANDOFF_REASONS), z.enum(['NONE', 'ANY'])]).optional(),
    replyContains: z.array(z.string().min(1).max(200)).max(10).default([]),
    replyNotContains: z.array(z.string().min(1).max(200)).max(10).default([]),
  })
  .refine(
    (e) =>
      e.toolsCalled.length +
        e.toolsNotCalled.length +
        e.replyContains.length +
        e.replyNotContains.length >
        0 || e.handoff !== undefined,
    'a case expects something',
  );
export type Expectations = z.infer<typeof expectationsSchema>;

/** What the agent did in one case. */
export interface Observation {
  readonly toolCalls: ReadonlyArray<{
    readonly tool: string;
    readonly args: Record<string, unknown>;
    readonly outcome: DryOutcome;
  }>;
  /** Null when the agent produced no usable answer (the loop failed or ran out of steps). */
  readonly answer: { readonly text: string; readonly handoff: string | null } | null;
}

export interface Check {
  /** `TOOL_CALLED:<tool>`, `TOOL_NOT_CALLED:<tool>`, `HANDOFF`, `REPLY_CONTAINS:<n>`, `REPLY_NOT_CONTAINS:<n>`, `ANSWER`. */
  readonly expectation: string;
  readonly outcome: 'PASS' | 'FAIL';
  /** Why it failed, as a code. */
  readonly detail?: string;
}

const fold = (s: string) => s.normalize('NFKC').toLocaleLowerCase();

function matches(value: unknown, m: ArgumentMatcher): boolean {
  if ('present' in m) return (value !== undefined && value !== null) === m.present;
  if ('equals' in m) return value === m.equals;
  return typeof value === 'string' && fold(value).includes(fold(m.contains));
}

/** Grades one case; it passes when every check passes. */
export function grade(
  expectations: Expectations,
  observed: Observation,
): { readonly outcome: 'PASS' | 'FAIL'; readonly checks: readonly Check[] } {
  const checks: Check[] = [];
  const add = (expectation: string, ok: boolean, detail: string) =>
    checks.push(ok ? { expectation, outcome: 'PASS' } : { expectation, outcome: 'FAIL', detail });

  add('ANSWER', observed.answer !== null, 'NO_ANSWER');

  for (const want of expectations.toolsCalled) {
    const calls = observed.toolCalls.filter((c) => c.tool === want.tool);
    const fitting = calls.filter((c) =>
      Object.entries(want.args ?? {}).every(([key, m]) => matches(c.args[key], m)),
    );
    const detail =
      calls.length === 0
        ? 'NOT_CALLED'
        : fitting.length === 0
          ? 'ARGUMENTS_DIFFER'
          : 'OUTCOME_DIFFERS';
    add(
      `TOOL_CALLED:${want.tool}`,
      fitting.some((c) => !want.outcome || c.outcome === want.outcome),
      detail,
    );
  }
  for (const tool of expectations.toolsNotCalled)
    add(`TOOL_NOT_CALLED:${tool}`, !observed.toolCalls.some((c) => c.tool === tool), 'CALLED');

  if (expectations.handoff !== undefined) {
    const got = observed.answer?.handoff ?? null;
    const want = expectations.handoff;
    const ok = want === 'NONE' ? got === null : want === 'ANY' ? got !== null : got === want;
    add('HANDOFF', observed.answer !== null && ok, got === null ? 'NO_HANDOFF' : `HANDOFF_${got}`);
  }

  const reply = fold(observed.answer?.text ?? '');
  expectations.replyContains.forEach((text, i) =>
    add(`REPLY_CONTAINS:${i}`, reply.includes(fold(text)), 'MISSING'),
  );
  expectations.replyNotContains.forEach((text, i) =>
    add(`REPLY_NOT_CONTAINS:${i}`, !reply.includes(fold(text)), 'PRESENT'),
  );
  return { outcome: checks.every((c) => c.outcome === 'PASS') ? 'PASS' : 'FAIL', checks };
}

/**
 * Whether a regression run passes (BUILD_PLAN 12.B): every critical case passes and the pass rate reaches the
 * threshold; an errored case counts as failed.
 */
export function runPasses(
  results: ReadonlyArray<{
    readonly critical: boolean;
    readonly outcome: 'PASS' | 'FAIL' | 'ERROR';
  }>,
  minPassRate: number,
): boolean {
  if (results.length === 0) return false;
  if (results.some((r) => r.critical && r.outcome !== 'PASS')) return false;
  const passed = results.filter((r) => r.outcome === 'PASS').length;
  return passed / results.length >= minPassRate;
}
