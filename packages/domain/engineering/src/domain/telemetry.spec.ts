import { describe, expect, it } from 'vitest';
import {
  acceptableSampleTime,
  aggregate,
  evaluate,
  type MinuteAggregate,
  minuteOf,
  missingVerdict,
  ruleParamsSchemas,
} from './telemetry';

const T0 = new Date('2026-10-05T10:00:00Z');
const at = (minute: number, second = 0) => new Date(T0.getTime() + minute * 60_000 + second * 1000);
/** Minutes with one average each (min = max = avg, one sample), starting at T0. */
const series = (...avgs: Array<number | null>): MinuteAggregate[] =>
  avgs.flatMap((v, i) =>
    v === null ? [] : [{ minute: at(i), min: v, max: v, sum: v, samples: 1, last: v }],
  );

describe('telemetry rule parameters', () => {
  it('need exactly one direction and a clear level on the safe side (hysteresis)', () => {
    expect(ruleParamsSchemas.THRESHOLD.safeParse({ above: 8, clear_at: 7 }).success).toBe(true);
    expect(ruleParamsSchemas.THRESHOLD.safeParse({ above: 8, clear_at: 9 }).success).toBe(false);
    expect(ruleParamsSchemas.THRESHOLD.safeParse({ below: 2, clear_at: 3 }).success).toBe(true);
    expect(ruleParamsSchemas.THRESHOLD.safeParse({ above: 8, below: 2, clear_at: 5 }).success).toBe(
      false,
    );
    expect(ruleParamsSchemas.THRESHOLD.safeParse({ clear_at: 5 }).success).toBe(false);
    expect(ruleParamsSchemas.RATE.safeParse({ max_delta: 2, window_minutes: 5 }).success).toBe(
      true,
    );
    expect(
      ruleParamsSchemas.RATE.safeParse({ max_delta: 2, window_minutes: 5, clear_delta: 3 }).success,
    ).toBe(false);
    expect(ruleParamsSchemas.MISSING.safeParse({ minutes: 10, extra: 1 }).success).toBe(false);
  });
});

describe('threshold with hysteresis', () => {
  const p = { above: 8, clear_at: 7, for_minutes: 3 };
  it('fires only after the value stayed beyond the threshold for the whole duration', () => {
    expect(evaluate('THRESHOLD', p, series(9, 9), at(1), false)).toEqual({ kind: 'NONE' });
    expect(evaluate('THRESHOLD', p, series(9, 7.5, 9), at(2), false)).toEqual({ kind: 'NONE' });
    expect(evaluate('THRESHOLD', p, series(9, null, 9, 9), at(3), false)).toEqual({ kind: 'NONE' });
    expect(evaluate('THRESHOLD', p, series(8.5, 9, 9.5), at(2), false)).toEqual({
      kind: 'RAISE',
      value: 9.5,
    });
  });
  it('holds between the clear level and the threshold, clears past it', () => {
    expect(evaluate('THRESHOLD', p, series(7.5), at(0), true)).toEqual({
      kind: 'HOLD',
      value: 7.5,
    });
    expect(evaluate('THRESHOLD', p, series(7), at(0), true)).toEqual({ kind: 'CLEAR' });
    // No data for the latest minute: a live alarm holds, nothing fires.
    expect(evaluate('THRESHOLD', p, series(9), at(1), true)).toEqual({ kind: 'HOLD', value: null });
  });
  it('uses the minute average, not a single spike', () => {
    const spike: MinuteAggregate = { minute: at(0), min: 6, max: 12, sum: 18, samples: 3, last: 6 };
    expect(evaluate('THRESHOLD', { above: 8, clear_at: 7 }, [spike], at(0), false)).toEqual({
      kind: 'NONE',
    });
  });
  it('works downwards too', () => {
    const low = { below: 2, clear_at: 3 };
    expect(evaluate('THRESHOLD', low, series(1.5), at(0), false)).toEqual({
      kind: 'RAISE',
      value: 1.5,
    });
    expect(evaluate('THRESHOLD', low, series(2.5), at(0), true)).toEqual({
      kind: 'HOLD',
      value: 2.5,
    });
    expect(evaluate('THRESHOLD', low, series(3.1), at(0), true)).toEqual({ kind: 'CLEAR' });
  });
});

describe('rate of change', () => {
  const p = { max_delta: 2, window_minutes: 5 };
  it('compares the latest minute with the one a window earlier, in either direction', () => {
    expect(evaluate('RATE', p, series(6, null, null, null, null, 8.5), at(5), false)).toEqual({
      kind: 'RAISE',
      value: 2.5,
    });
    expect(evaluate('RATE', p, series(8.5, null, null, null, null, 6), at(5), false)).toEqual({
      kind: 'RAISE',
      value: 2.5,
    });
    expect(evaluate('RATE', p, series(6, null, null, null, null, 7.5), at(5), false)).toEqual({
      kind: 'NONE',
    });
    // Without the earlier minute nothing can be said.
    expect(evaluate('RATE', p, series(null, 6, null, null, null, 9), at(5), false)).toEqual({
      kind: 'NONE',
    });
  });
  it('clears below half the limit by default', () => {
    expect(evaluate('RATE', p, series(6, null, null, null, null, 7.5), at(5), true)).toEqual({
      kind: 'HOLD',
      value: 1.5,
    });
    expect(evaluate('RATE', p, series(6, null, null, null, null, 6.9), at(5), true)).toEqual({
      kind: 'CLEAR',
    });
  });
});

describe('stuck value', () => {
  const p = { minutes: 4, tolerance: 0.05 };
  it('fires when the whole window is covered and flat', () => {
    expect(evaluate('STUCK', p, series(21, 21, 21.02, 21), at(3), false)).toEqual({
      kind: 'RAISE',
      value: 21,
    });
    expect(evaluate('STUCK', p, series(null, 21, 21, 21), at(3), false)).toEqual({ kind: 'NONE' });
    expect(evaluate('STUCK', p, series(21, 21, 21.5, 21), at(3), false)).toEqual({ kind: 'NONE' });
  });
  it('clears as soon as the value moves', () => {
    expect(evaluate('STUCK', p, series(21, 21, 21, 21.4), at(3), true)).toEqual({ kind: 'CLEAR' });
    expect(evaluate('STUCK', p, series(21, 21, 21, 21), at(3), true)).toEqual({
      kind: 'HOLD',
      value: 21,
    });
  });
});

describe('missing data', () => {
  it('fires after the silence and clears with the next sample', () => {
    const p = { minutes: 15 };
    expect(missingVerdict(p, at(0), at(-60), at(15), false)).toEqual({ kind: 'NONE' });
    expect(missingVerdict(p, at(0), at(-60), at(16), false)).toEqual({
      kind: 'RAISE',
      value: null,
    });
    expect(missingVerdict(p, null, at(0), at(20), false)).toEqual({ kind: 'RAISE', value: null });
    expect(missingVerdict(p, at(19), at(-60), at(20), true)).toEqual({ kind: 'CLEAR' });
  });
});

describe('minute aggregation', () => {
  it('folds samples into minutes: min, max, sum, count and the latest value by time', () => {
    const minutes = aggregate([
      { value: 7, at: at(0, 50) },
      { value: 6, at: at(0, 10) },
      { value: 9, at: at(1, 5) },
      { value: 8, at: at(0, 30) },
    ]);
    expect(minutes).toEqual([
      { minute: at(0), min: 6, max: 8, sum: 21, samples: 3, last: 7, lastAt: at(0, 50) },
      { minute: at(1), min: 9, max: 9, sum: 9, samples: 1, last: 9, lastAt: at(1, 5) },
    ]);
    expect(minuteOf(at(3, 59))).toEqual(at(3));
  });
  it('keeps only samples inside retention and not from the future', () => {
    expect(acceptableSampleTime(at(0), at(0))).toBe(true);
    expect(acceptableSampleTime(new Date(T0.getTime() + 25 * 3_600_000), T0)).toBe(false);
    expect(acceptableSampleTime(new Date(T0.getTime() - 401 * 86_400_000), T0)).toBe(false);
  });
});
