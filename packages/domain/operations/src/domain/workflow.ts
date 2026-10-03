import { z } from 'zod';

/**
 * Workflows (Spec §8, BUILD_PLAN §7.2): a JSON state machine interpreted deterministically. Guards are named predicates
 * and actions are named handlers registered in code — a definition can only combine what the platform implements, it
 * never carries code. Published versions are immutable (CLAUDE.md rule 9).
 */

const name = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'UPPER_SNAKE_CASE');
const ref = z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/, 'lower_snake_case');

/**
 * What can move a workflow: lifecycle facts of the work item's tasks and approvals, or a named staff action
 * (`MANUAL:<NAME>`).
 */
export const WORKFLOW_TRIGGERS = [
  'TASK_ACCEPTED',
  'TASK_STARTED',
  'TASK_COMPLETED',
  'TASK_CANCELLED',
  'APPROVAL_APPROVED',
  'APPROVAL_REJECTED',
  'APPROVAL_EXPIRED',
] as const;
export type WorkflowTrigger = (typeof WORKFLOW_TRIGGERS)[number] | `MANUAL:${string}`;

const trigger = z.union([
  z.enum(WORKFLOW_TRIGGERS),
  z.string().regex(/^MANUAL:[A-Z][A-Z0-9_]{0,63}$/),
]);

export const workflowActionSchema = z.object({
  type: ref,
  params: z.record(z.string(), z.unknown()).default({}),
});
export type WorkflowAction = z.infer<typeof workflowActionSchema>;

export const workflowDefinitionSchema = z.object({
  initial: name,
  states: z.record(
    name,
    z.object({
      terminal: z.boolean().default(false),
      /** Actions run when the state is entered (also for the initial state). */
      onEnter: z.array(workflowActionSchema).max(10).default([]),
    }),
  ),
  transitions: z
    .array(
      z.object({
        from: name,
        to: name,
        on: trigger,
        guards: z.array(ref).max(5).default([]),
        actions: z.array(workflowActionSchema).max(10).default([]),
      }),
    )
    .max(100),
});
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

/** Structural problems of a definition against the registered guards and actions; empty when publishable. */
export function definitionProblems(
  def: WorkflowDefinition,
  known: { readonly guards: ReadonlySet<string>; readonly actions: ReadonlySet<string> },
): string[] {
  const problems: string[] = [];
  const states = new Set(Object.keys(def.states));
  if (!states.has(def.initial)) problems.push(`initial state ${def.initial} is not defined`);
  if (![...states].some((s) => def.states[s]!.terminal)) problems.push('no terminal state');
  const actionsOf = (list: readonly WorkflowAction[], where: string) => {
    for (const a of list)
      if (!known.actions.has(a.type)) problems.push(`${where}: unknown action ${a.type}`);
  };
  for (const [s, cfg] of Object.entries(def.states)) actionsOf(cfg.onEnter, `state ${s}`);
  def.transitions.forEach((t, i) => {
    const where = `transition ${i + 1} (${t.from} → ${t.to})`;
    if (!states.has(t.from)) problems.push(`${where}: unknown state ${t.from}`);
    if (!states.has(t.to)) problems.push(`${where}: unknown state ${t.to}`);
    if (def.states[t.from]?.terminal) problems.push(`${where}: leaves a terminal state`);
    for (const g of t.guards)
      if (!known.guards.has(g)) problems.push(`${where}: unknown guard ${g}`);
    actionsOf(t.actions, where);
  });
  // Every non-terminal state must be reachable from the initial one.
  const reachable = new Set([def.initial]);
  for (let changed = true; changed;) {
    changed = false;
    for (const t of def.transitions)
      if (reachable.has(t.from) && !reachable.has(t.to)) {
        reachable.add(t.to);
        changed = true;
      }
  }
  for (const s of states) if (!reachable.has(s)) problems.push(`state ${s} is unreachable`);
  return problems;
}

export interface Move {
  readonly from: string;
  readonly to: string;
  readonly actions: readonly WorkflowAction[];
}

/**
 * The transition a trigger causes from `state`: the first listed transition with that source and trigger whose guards
 * all hold (`guard(name)`), plus the target state's entry actions. Null when the trigger does not apply.
 */
export function nextMove(
  def: WorkflowDefinition,
  state: string,
  on: string,
  guard: (name: string) => boolean,
): Move | null {
  if (def.states[state]?.terminal) return null;
  for (const t of def.transitions) {
    if (t.from !== state || t.on !== on) continue;
    if (!t.guards.every(guard)) continue;
    return { from: state, to: t.to, actions: [...t.actions, ...def.states[t.to]!.onEnter] };
  }
  return null;
}
