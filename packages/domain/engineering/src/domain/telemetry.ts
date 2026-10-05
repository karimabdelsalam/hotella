import { z } from 'zod';

/**
 * Building telemetry rules (BUILD_PLAN 13.2, CLAUDE.md rule 11): pure, deterministic evaluation over minute
 * aggregates. The same minutes and the same rule always give the same verdict; time is the data's own minute, never
 * the wall clock, so a replayed batch evaluates exactly as it did live.
 */

export const MINUTE_MS = 60_000;
/** Samples older than the aggregate retention or ahead of the platform's clock by more than this are dropped. */
export const TELEMETRY_RETENTION_DAYS = 400;
export const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

const finite = z.number().finite();

/**
 * Parameters per rule kind. THRESHOLD has hysteresis: it fires beyond `above` (or `below`) for `for_minutes`
 * consecutive minutes and clears only once back past `clear_at`. RATE fires when the minute average moved more than
 * `max_delta` within `window_minutes` and clears below `clear_delta` (default half). STUCK fires when the value stayed
 * within `tolerance` for `minutes`. MISSING fires when no sample came for `minutes` (checked by the sweep).
 */
export const ruleParamsSchemas = {
  THRESHOLD: z
    .object({
      above: finite.optional(),
      below: finite.optional(),
      clear_at: finite,
      for_minutes: z.number().int().min(1).max(60).default(1),
    })
    .strict()
    .refine((p) => (p.above === undefined) !== (p.below === undefined), {
      message: 'exactly one of above or below',
    })
    .refine(
      (p) =>
        p.above !== undefined
          ? p.clear_at < p.above
          : p.below !== undefined
            ? p.clear_at > p.below
            : true,
      { message: 'clear_at must be on the safe side of the threshold', path: ['clear_at'] },
    ),
  RATE: z
    .object({
      max_delta: finite.positive(),
      window_minutes: z.number().int().min(1).max(120),
      clear_delta: finite.min(0).optional(),
    })
    .strict()
    .refine((p) => p.clear_delta === undefined || p.clear_delta < p.max_delta, {
      message: 'clear_delta must be below max_delta',
      path: ['clear_delta'],
    }),
  STUCK: z
    .object({
      minutes: z.number().int().min(2).max(1440),
      tolerance: finite.min(0).default(0),
    })
    .strict(),
  MISSING: z.object({ minutes: z.number().int().min(1).max(1440) }).strict(),
} as const;

export type RuleKind = keyof typeof ruleParamsSchemas;
export type ThresholdParams = z.infer<(typeof ruleParamsSchemas)['THRESHOLD']>;
export type RateParams = z.infer<(typeof ruleParamsSchemas)['RATE']>;
export type StuckParams = z.infer<(typeof ruleParamsSchemas)['STUCK']>;
export type MissingParams = z.infer<(typeof ruleParamsSchemas)['MISSING']>;

/** One stored minute of a point. */
export interface MinuteAggregate {
  readonly minute: Date;
  readonly min: number;
  readonly max: number;
  readonly sum: number;
  readonly samples: number;
  readonly last: number;
}

export const average = (m: MinuteAggregate): number => m.sum / m.samples;

export const minuteOf = (at: Date): Date =>
  new Date(Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS);

/** How many minutes before the latest one a rule needs to look at. */
export function lookbackMinutes(kind: RuleKind, params: Record<string, number>): number {
  switch (kind) {
    case 'THRESHOLD':
      return params.for_minutes ?? 1;
    case 'RATE':
      return (params.window_minutes ?? 1) + 1;
    case 'STUCK':
      return params.minutes ?? 2;
    case 'MISSING':
      return 0;
  }
}

/** What a rule says now, given whether its alarm is live. */
export type Verdict =
  | { readonly kind: 'RAISE'; readonly value: number | null }
  | { readonly kind: 'CLEAR' }
  | { readonly kind: 'HOLD'; readonly value: number | null }
  | { readonly kind: 'NONE' };

/**
 * Evaluates threshold, rate and stuck rules on the point's minutes (ascending, at most a day; gaps allowed) at
 * `latest` — the newest minute the batch touched. `live` = an alarm of this rule is open or acknowledged.
 */
export function evaluate(
  kind: Exclude<RuleKind, 'MISSING'>,
  params: Record<string, number>,
  minutes: readonly MinuteAggregate[],
  latest: Date,
  live: boolean,
): Verdict {
  const byMinute = new Map(minutes.map((m) => [m.minute.getTime(), m]));
  const at = (offset: number) => byMinute.get(latest.getTime() - offset * MINUTE_MS);
  const current = at(0);
  if (!current) return live ? { kind: 'HOLD', value: null } : { kind: 'NONE' };
  switch (kind) {
    case 'THRESHOLD': {
      const p = ruleParamsSchemas.THRESHOLD.parse(params);
      const beyond = (m: MinuteAggregate | undefined) =>
        m !== undefined &&
        (p.above !== undefined ? average(m) > p.above : average(m) < (p.below as number));
      const value = average(current);
      if (live) {
        const safe = p.above !== undefined ? value <= p.clear_at : value >= p.clear_at;
        return safe ? { kind: 'CLEAR' } : { kind: 'HOLD', value };
      }
      for (let i = 0; i < p.for_minutes; i++) if (!beyond(at(i))) return { kind: 'NONE' };
      return { kind: 'RAISE', value };
    }
    case 'RATE': {
      const p = ruleParamsSchemas.RATE.parse(params);
      const before = at(p.window_minutes);
      if (!before) return live ? { kind: 'HOLD', value: null } : { kind: 'NONE' };
      const delta = Math.abs(average(current) - average(before));
      if (live)
        return delta <= (p.clear_delta ?? p.max_delta / 2)
          ? { kind: 'CLEAR' }
          : { kind: 'HOLD', value: delta };
      return delta > p.max_delta ? { kind: 'RAISE', value: delta } : { kind: 'NONE' };
    }
    case 'STUCK': {
      const p = ruleParamsSchemas.STUCK.parse(params);
      const from = latest.getTime() - (p.minutes - 1) * MINUTE_MS;
      const window = minutes.filter(
        (m) => m.minute.getTime() >= from && m.minute.getTime() <= latest.getTime(),
      );
      const low = Math.min(...window.map((m) => m.min));
      const high = Math.max(...window.map((m) => m.max));
      const flat = high - low <= p.tolerance;
      if (live) return flat ? { kind: 'HOLD', value: current.last } : { kind: 'CLEAR' };
      // The window must really be covered: data in its first minute and in its last, at least two samples.
      const covered =
        window.length >= 2 &&
        window[0]!.minute.getTime() === from &&
        window.reduce((n, m) => n + m.samples, 0) >= 2;
      return covered && flat ? { kind: 'RAISE', value: current.last } : { kind: 'NONE' };
    }
  }
}

/** The sweep's verdict for missing data: silent for `minutes` since the last sample (or since the point exists). */
export function missingVerdict(
  params: Record<string, number>,
  lastAt: Date | null,
  since: Date,
  now: Date,
  live: boolean,
): Verdict {
  const p = ruleParamsSchemas.MISSING.parse(params);
  const quietSince = lastAt ?? since;
  const silent = now.getTime() - quietSince.getTime() > p.minutes * MINUTE_MS;
  if (live) return silent ? { kind: 'HOLD', value: null } : { kind: 'CLEAR' };
  return silent ? { kind: 'RAISE', value: null } : { kind: 'NONE' };
}

/** A sample the aggregate can keep: inside retention and not from the future (a device clock gone wrong). */
export function acceptableSampleTime(at: Date, now: Date): boolean {
  return (
    at.getTime() <= now.getTime() + MAX_FUTURE_SKEW_MS &&
    at.getTime() >= now.getTime() - TELEMETRY_RETENTION_DAYS * 24 * 60 * MINUTE_MS
  );
}

/** A batch's contribution to one minute, merged into the stored row (min, max, sum and count add up; last by time). */
export interface PartialMinute extends MinuteAggregate {
  readonly lastAt: Date;
}

/** Groups samples into per-minute partial aggregates (to be merged into the stored minute). */
export function aggregate(
  samples: readonly { readonly value: number; readonly at: Date }[],
): PartialMinute[] {
  const out = new Map<
    number,
    { min: number; max: number; sum: number; samples: number; last: number; lastAt: number }
  >();
  for (const s of samples) {
    const key = minuteOf(s.at).getTime();
    const m = out.get(key);
    if (!m)
      out.set(key, {
        min: s.value,
        max: s.value,
        sum: s.value,
        samples: 1,
        last: s.value,
        lastAt: s.at.getTime(),
      });
    else {
      m.min = Math.min(m.min, s.value);
      m.max = Math.max(m.max, s.value);
      m.sum += s.value;
      m.samples += 1;
      if (s.at.getTime() >= m.lastAt) {
        m.last = s.value;
        m.lastAt = s.at.getTime();
      }
    }
  }
  return [...out.entries()]
    .sort(([a], [b]) => a - b)
    .map(([minute, m]) => ({
      minute: new Date(minute),
      min: m.min,
      max: m.max,
      sum: m.sum,
      samples: m.samples,
      last: m.last,
      lastAt: new Date(m.lastAt),
    }));
}
