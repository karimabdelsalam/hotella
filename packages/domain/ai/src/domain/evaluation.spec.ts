import { describe, expect, it } from 'vitest';
import {
  caseInputSchema,
  expectationsSchema,
  grade,
  type Observation,
  runPasses,
} from './evaluation';

const towels: Observation = {
  toolCalls: [
    {
      tool: 'operations.create_service_request',
      args: { serviceCode: 'EXTRA_TOWELS', quantity: 2, note: 'Two Bath Towels' },
      outcome: 'OK',
    },
  ],
  answer: { text: 'Your towels are on the way to room 504.', handoff: null },
};
const expect_ = (e: unknown) => expectationsSchema.parse(e);

describe('grade (BUILD_PLAN 12.1)', () => {
  it('passes a case whose tool call, arguments, outcome, hand-off and reply match', () => {
    const g = grade(
      expect_({
        toolsCalled: [
          {
            tool: 'operations.create_service_request',
            args: {
              serviceCode: { equals: 'EXTRA_TOWELS' },
              note: { contains: 'bath towels' },
              stayId: { present: false },
            },
            outcome: 'OK',
          },
        ],
        toolsNotCalled: ['operations.cancel_service_request'],
        handoff: 'NONE',
        replyContains: ['ON THE WAY'],
        replyNotContains: ['sorry'],
      }),
      towels,
    );
    expect(g.outcome).toBe('PASS');
    expect(g.checks.map((c) => c.expectation)).toEqual([
      'ANSWER',
      'TOOL_CALLED:operations.create_service_request',
      'TOOL_NOT_CALLED:operations.cancel_service_request',
      'HANDOFF',
      'REPLY_CONTAINS:0',
      'REPLY_NOT_CONTAINS:0',
    ]);
  });

  it('names what failed with a code', () => {
    const g = grade(
      expect_({
        toolsCalled: [
          { tool: 'operations.create_service_request', args: { quantity: { equals: 3 } } },
          { tool: 'catalog.list_services' },
          { tool: 'operations.create_service_request', outcome: 'PROPOSED' },
        ],
        toolsNotCalled: ['operations.create_service_request'],
        handoff: 'COMPLAINT',
        replyContains: ['manager'],
        replyNotContains: ['ROOM 504'],
      }),
      towels,
    );
    expect(g.outcome).toBe('FAIL');
    expect(
      g.checks.filter((c) => c.outcome === 'FAIL').map((c) => [c.expectation, c.detail]),
    ).toEqual([
      ['TOOL_CALLED:operations.create_service_request', 'ARGUMENTS_DIFFER'],
      ['TOOL_CALLED:catalog.list_services', 'NOT_CALLED'],
      ['TOOL_CALLED:operations.create_service_request', 'OUTCOME_DIFFERS'],
      ['TOOL_NOT_CALLED:operations.create_service_request', 'CALLED'],
      ['HANDOFF', 'NO_HANDOFF'],
      ['REPLY_CONTAINS:0', 'MISSING'],
      ['REPLY_NOT_CONTAINS:0', 'PRESENT'],
    ]);
  });

  it('fails every case without an answer, and checks any or a specific hand-off', () => {
    expect(grade(expect_({ handoff: 'ANY' }), { toolCalls: [], answer: null })).toMatchObject({
      outcome: 'FAIL',
      checks: [{ expectation: 'ANSWER', detail: 'NO_ANSWER' }, { expectation: 'HANDOFF' }],
    });
    const handedOff = {
      toolCalls: [],
      answer: { text: 'A colleague will help.', handoff: 'COMPLAINT' },
    };
    expect(grade(expect_({ handoff: 'ANY' }), handedOff).outcome).toBe('PASS');
    expect(grade(expect_({ handoff: 'COMPLAINT' }), handedOff).outcome).toBe('PASS');
    expect(grade(expect_({ handoff: 'PAYMENT_ISSUE' }), handedOff).checks.at(-1)).toMatchObject({
      detail: 'HANDOFF_COMPLAINT',
    });
  });

  it('refuses cases that expect nothing or do not end with the person speaking', () => {
    expect(expectationsSchema.safeParse({}).success).toBe(false);
    expect(
      caseInputSchema.safeParse({
        locale: 'en',
        turns: [
          { from: 'person', text: 'Hi' },
          { from: 'agent', text: 'Hello' },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('runPasses', () => {
  it('needs every critical case and the pass rate; errors count as failures', () => {
    const ok = { critical: false, outcome: 'PASS' as const };
    expect(runPasses([], 0.9)).toBe(false);
    expect(runPasses([...Array(9).fill(ok), { critical: false, outcome: 'FAIL' }], 0.9)).toBe(true);
    expect(runPasses([...Array(9).fill(ok), { critical: true, outcome: 'FAIL' }], 0.9)).toBe(false);
    expect(runPasses([ok, { critical: false, outcome: 'ERROR' }], 0.9)).toBe(false);
  });
});
