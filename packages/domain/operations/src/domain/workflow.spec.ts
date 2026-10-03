import { describe, expect, it } from 'vitest';
import { decisionProblem, defaultTtlMinutes, requestProblem } from './approval';
import {
  definitionProblems,
  nextMove,
  type WorkflowDefinition,
  workflowDefinitionSchema,
} from './workflow';

const known = {
  guards: new Set(['all_tasks_done', 'no_open_tasks']),
  actions: new Set(['create_task', 'request_approval', 'cancel_open_tasks']),
};
const def = (input: unknown): WorkflowDefinition => workflowDefinitionSchema.parse(input);

const COMPENSATION = def({
  initial: 'OPEN',
  states: {
    OPEN: { onEnter: [{ type: 'create_task', params: { titleKey: 'x' } }] },
    AWAITING_APPROVAL: {
      onEnter: [{ type: 'request_approval', params: { kind: 'COMPENSATION' } }],
    },
    GRANTED: { terminal: true },
    DECLINED: { terminal: true, onEnter: [{ type: 'cancel_open_tasks' }] },
  },
  transitions: [
    { from: 'OPEN', to: 'AWAITING_APPROVAL', on: 'TASK_COMPLETED', guards: ['all_tasks_done'] },
    { from: 'OPEN', to: 'DECLINED', on: 'MANUAL:WITHDRAW' },
    { from: 'AWAITING_APPROVAL', to: 'GRANTED', on: 'APPROVAL_APPROVED' },
    { from: 'AWAITING_APPROVAL', to: 'DECLINED', on: 'APPROVAL_REJECTED' },
    { from: 'AWAITING_APPROVAL', to: 'DECLINED', on: 'APPROVAL_EXPIRED' },
  ],
});

describe('workflow definitions', () => {
  it('accept a well-formed definition built from registered guards and actions', () => {
    expect(definitionProblems(COMPENSATION, known)).toEqual([]);
  });

  it('report every structural problem', () => {
    const bad = def({
      initial: 'START',
      states: { OPEN: {}, LOST: {}, DONE: { terminal: true } },
      transitions: [
        { from: 'OPEN', to: 'DONE', on: 'TASK_COMPLETED', guards: ['phase_of_moon'] },
        { from: 'DONE', to: 'OPEN', on: 'MANUAL:REOPEN', actions: [{ type: 'run_shell' }] },
        { from: 'OPEN', to: 'NOWHERE', on: 'TASK_STARTED' },
      ],
    });
    expect(definitionProblems(bad, known)).toEqual(
      expect.arrayContaining([
        'initial state START is not defined',
        'transition 1 (OPEN → DONE): unknown guard phase_of_moon',
        'transition 2 (DONE → OPEN): leaves a terminal state',
        'transition 2 (DONE → OPEN): unknown action run_shell',
        'transition 3 (OPEN → NOWHERE): unknown state NOWHERE',
        'state LOST is unreachable',
      ]),
    );
    expect(() => def({ initial: 'a', states: {}, transitions: [] })).toThrow();
    expect(() =>
      def({
        initial: 'A',
        states: { A: {} },
        transitions: [{ from: 'A', to: 'A', on: 'WHENEVER' }],
      }),
    ).toThrow();
  });
});

describe('workflow interpreter', () => {
  it('takes the first transition whose guards hold, with the target entry actions', () => {
    expect(nextMove(COMPENSATION, 'OPEN', 'TASK_COMPLETED', () => false)).toBeNull();
    expect(nextMove(COMPENSATION, 'OPEN', 'TASK_COMPLETED', () => true)).toEqual({
      from: 'OPEN',
      to: 'AWAITING_APPROVAL',
      actions: [{ type: 'request_approval', params: { kind: 'COMPENSATION' } }],
    });
    expect(nextMove(COMPENSATION, 'AWAITING_APPROVAL', 'APPROVAL_REJECTED', () => true)?.to).toBe(
      'DECLINED',
    );
  });

  it('ignores triggers that do not apply and never leaves a terminal state', () => {
    expect(nextMove(COMPENSATION, 'OPEN', 'APPROVAL_APPROVED', () => true)).toBeNull();
    expect(nextMove(COMPENSATION, 'GRANTED', 'MANUAL:WITHDRAW', () => true)).toBeNull();
    expect(nextMove(COMPENSATION, 'UNKNOWN', 'TASK_COMPLETED', () => true)).toBeNull();
  });
});

describe('approval rules', () => {
  const now = new Date('2026-10-05T10:00:00Z');
  const pending = {
    status: 'PENDING' as const,
    riskLevel: 'HIGH' as const,
    requestedByType: 'AI_AGENT',
    requestedById: 'agent-1',
    expiresAt: new Date('2026-10-05T12:00:00Z'),
  };

  it('needs a person other than the requester, before expiry, on a pending request', () => {
    expect(decisionProblem(pending, { type: 'USER', id: 'gm' }, now)).toBeNull();
    expect(decisionProblem(pending, { type: 'AI_AGENT', id: 'agent-2' }, now)).toBe(
      'human_required',
    );
    expect(decisionProblem(pending, { type: 'SYSTEM', id: 'x' }, now)).toBe('human_required');
    expect(
      decisionProblem(
        { ...pending, requestedByType: 'USER', requestedById: 'gm' },
        { type: 'USER', id: 'gm' },
        now,
      ),
    ).toBe('four_eyes');
    expect(
      decisionProblem(pending, { type: 'USER', id: 'gm' }, new Date('2026-10-05T12:00:00Z')),
    ).toBe('expired');
    expect(
      decisionProblem({ ...pending, status: 'APPROVED' }, { type: 'USER', id: 'gm' }, now),
    ).toBe('not_pending');
  });

  it('keeps CRITICAL actions away from AI and bounds how long a request may wait', () => {
    expect(requestProblem('CRITICAL', 'AI_AGENT')).toBe('critical_not_for_ai');
    expect(requestProblem('CRITICAL', 'USER')).toBeNull();
    expect(requestProblem('HIGH', 'AI_AGENT')).toBeNull();
    expect([
      defaultTtlMinutes('CRITICAL'),
      defaultTtlMinutes('HIGH'),
      defaultTtlMinutes('LOW'),
    ]).toEqual([60, 240, 1440]);
  });
});
