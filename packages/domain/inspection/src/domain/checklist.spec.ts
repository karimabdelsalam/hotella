import { describe, expect, it } from 'vitest';
import {
  type Answer,
  answerProblem,
  evaluate,
  type ItemRule,
  judge,
  ruleProblem,
} from './checklist';

const rule = (r: Partial<ItemRule> & Pick<ItemRule, 'kind'>): ItemRule => ({
  required: true,
  failSeverity: 'MINOR',
  ...r,
});

describe('checklist rules', () => {
  it('judges each kind deterministically', () => {
    expect(judge(rule({ kind: 'PASS_FAIL' }), { kind: 'PASS_FAIL', value: 'FAIL' })).toBe('FAIL');
    expect(judge(rule({ kind: 'YES_NO', expected: 'NO' }), { kind: 'YES_NO', value: 'NO' })).toBe(
      'PASS',
    );
    expect(judge(rule({ kind: 'SCORE' }), { kind: 'SCORE', value: 2 })).toBe('FAIL');
    expect(judge(rule({ kind: 'SCORE' }), { kind: 'SCORE', value: 3 })).toBe('PASS');
    expect(
      judge(rule({ kind: 'SCORE', scaleMax: 10, passFrom: 8 }), { kind: 'SCORE', value: 7 }),
    ).toBe('FAIL');
    const chlorine = rule({ kind: 'NUMBER', min: 1, max: 3 });
    expect(judge(chlorine, { kind: 'NUMBER', value: 0.5 })).toBe('FAIL');
    expect(judge(chlorine, { kind: 'NUMBER', value: 3 })).toBe('PASS');
    const surfaces = rule({
      kind: 'MULTI_SELECT',
      options: ['DUST', 'MOULD', 'OK'],
      failOptions: ['MOULD'],
    });
    expect(judge(surfaces, { kind: 'MULTI_SELECT', value: ['DUST'] })).toBe('PASS');
    expect(judge(surfaces, { kind: 'MULTI_SELECT', value: ['DUST', 'MOULD'] })).toBe('FAIL');
    expect(judge(rule({ kind: 'TEXT' }), { kind: 'TEXT', value: 'ok' })).toBe('NOT_GRADED');
    expect(judge(rule({ kind: 'PHOTO' }), undefined)).toBe('MISSING');
    expect(judge(rule({ kind: 'PHOTO', required: false }), undefined)).toBe('NOT_GRADED');
  });

  it('refuses answers that do not fit the item', () => {
    expect(answerProblem(rule({ kind: 'SCORE' }), { kind: 'SCORE', value: 6 })).toBe('scale');
    expect(answerProblem(rule({ kind: 'SCORE' }), { kind: 'SCORE', value: 2.5 })).toBe('scale');
    expect(answerProblem(rule({ kind: 'YES_NO' }), { kind: 'PASS_FAIL', value: 'PASS' })).toBe(
      'kind',
    );
    expect(
      answerProblem(rule({ kind: 'MULTI_SELECT', options: ['A'] }), {
        kind: 'MULTI_SELECT',
        value: ['B'],
      }),
    ).toBe('option');
    expect(answerProblem(rule({ kind: 'TEXT' }), { kind: 'TEXT', value: '  ' })).toBe('empty');
    expect(answerProblem(rule({ kind: 'NUMBER' }), { kind: 'NUMBER', value: 2 })).toBe(null);
  });

  it('validates definitions before publishing', () => {
    expect(ruleProblem(rule({ kind: 'SCORE', scaleMax: 1 }))).toBe('scale');
    expect(ruleProblem(rule({ kind: 'NUMBER', min: 5, max: 1 }))).toBe('range');
    expect(ruleProblem(rule({ kind: 'MULTI_SELECT' }))).toBe('options');
    expect(ruleProblem(rule({ kind: 'MULTI_SELECT', options: ['A'], failOptions: ['B'] }))).toBe(
      'fail_options',
    );
    expect(ruleProblem(rule({ kind: 'PASS_FAIL' }))).toBe(null);
  });

  it('scores, raises findings and fails on any major or critical one', () => {
    const items = [
      { code: 'EXTINGUISHER', rule: rule({ kind: 'PASS_FAIL', failSeverity: 'CRITICAL' }) },
      { code: 'SIGNAGE', rule: rule({ kind: 'YES_NO', failSeverity: 'MINOR' }) },
      { code: 'CHLORINE', rule: rule({ kind: 'NUMBER', min: 1, max: 3, failSeverity: 'MAJOR' }) },
      { code: 'NOTES', rule: rule({ kind: 'TEXT', required: false }) },
    ];
    const answers = (a: Record<string, Answer>) => new Map(Object.entries(a));
    expect(
      evaluate(
        items,
        answers({
          EXTINGUISHER: { kind: 'PASS_FAIL', value: 'PASS' },
          SIGNAGE: { kind: 'YES_NO', value: 'NO' },
          CHLORINE: { kind: 'NUMBER', value: 2 },
        }),
      ),
    ).toEqual({
      missing: [],
      findings: [{ itemCode: 'SIGNAGE', severity: 'MINOR' }],
      score: 67,
      result: 'PASS',
    });
    expect(
      evaluate(items, answers({ EXTINGUISHER: { kind: 'PASS_FAIL', value: 'FAIL' } })),
    ).toEqual({
      missing: ['SIGNAGE', 'CHLORINE'],
      findings: [{ itemCode: 'EXTINGUISHER', severity: 'CRITICAL' }],
      score: 0,
      result: 'FAIL',
    });
    expect(evaluate([], new Map())).toEqual({
      missing: [],
      findings: [],
      score: 100,
      result: 'PASS',
    });
  });
});
