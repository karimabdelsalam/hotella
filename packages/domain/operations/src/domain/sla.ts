import {
  addDays,
  isoDate,
  type LocalDate,
  localToUtc,
  parseClock,
  wallClock,
} from '@hotella/platform-time';

/**
 * SLA arithmetic (Spec §8.3, CLAUDE.md rule 11): deterministic, pure, unit-tested — never an LLM. Business time is
 * defined in the hotel's wall clock and converted to UTC day by day, so DST changes shift deadlines correctly.
 */

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** `[["08:00","20:00"]]`; an end at or before its start runs past midnight (night shift `22:00`–`06:00`). */
export type DayWindows = ReadonlyArray<readonly [string, string]>;

export interface WeeklySchedule {
  readonly days: Partial<Record<Weekday, DayWindows>>;
  /** Local dates (`YYYY-MM-DD`) on which windows starting that day do not open (holidays, closures). */
  readonly closedDates?: readonly string[];
}

/** The clock an SLA runs on: around the clock, or a property's business hours in its time zone. */
export type SlaCalendar =
  | { readonly kind: 'ALWAYS' }
  | {
      readonly kind: 'BUSINESS_HOURS';
      readonly timeZone: string;
      readonly schedule: WeeklySchedule;
    };

export interface Interval {
  readonly start: number;
  /** null = still open (a running pause). */
  readonly end: number | null;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Hard stop: a calendar with no business time in a year is a configuration error, not an infinite loop. */
const HORIZON_DAYS = 400;

export class SlaCalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlaCalendarError';
  }
}

/** Validates a schedule (used by the API before storing it). Returns problems, empty when valid. */
export function scheduleProblems(schedule: WeeklySchedule): string[] {
  const problems: string[] = [];
  let open = 0;
  for (const [day, windows] of Object.entries(schedule.days)) {
    if (!WEEKDAYS.includes(day as Weekday)) problems.push(`unknown day ${day}`);
    for (const [from, to] of windows ?? []) {
      const a = parseClock(from);
      const b = parseClock(to);
      if (a === null || b === null || a === 24 * 60)
        problems.push(`${day}: bad window ${from}-${to}`);
      else open++;
    }
  }
  for (const d of schedule.closedDates ?? [])
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) problems.push(`bad closed date ${d}`);
  if (open === 0) problems.push('no business hours');
  return problems;
}

/** Open business intervals (UTC ms) intersecting [from, to), in order. */
export function businessIntervals(calendar: SlaCalendar, from: number, to: number): Interval[] {
  if (calendar.kind === 'ALWAYS') return [{ start: from, end: to }];
  const { timeZone, schedule } = calendar;
  const closed = new Set(schedule.closedDates ?? []);
  const out: Array<{ start: number; end: number }> = [];
  // Start a day early: yesterday's overnight window may still be open at `from`.
  const first = wallClock(from - DAY, timeZone);
  let date: LocalDate = { year: first.year, month: first.month, day: first.day };
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const dayStart = localToUtc(date, timeZone).getTime();
    if (dayStart >= to) break;
    if (!closed.has(isoDate(date))) {
      const weekday =
        WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()]!;
      for (const [a, b] of schedule.days[weekday] ?? []) {
        const startMin = parseClock(a)!;
        const endMin = parseClock(b)!;
        const start = at(date, startMin, timeZone);
        const end =
          endMin > startMin ? at(date, endMin, timeZone) : at(addDays(date, 1), endMin, timeZone);
        const s = Math.max(start, from);
        const e = Math.min(end, to);
        if (e > s) out.push({ start: s, end: e });
      }
    }
    date = addDays(date, 1);
  }
  return merge(out);
}

/**
 * The instant `minutes` of business time after `start`, skipping closed hours and pauses. Pauses must be closed
 * (a running pause has no deadline yet).
 */
export function addBusinessMinutes(
  start: Date,
  minutes: number,
  calendar: SlaCalendar,
  pauses: readonly Interval[] = [],
): Date {
  if (minutes < 0) throw new SlaCalendarError('negative duration');
  if (pauses.some((p) => p.end === null)) throw new SlaCalendarError('open pause');
  let remaining = minutes * MINUTE;
  if (remaining === 0) return new Date(start.getTime());
  let cursor = start.getTime();
  const horizon = cursor + HORIZON_DAYS * DAY;
  const step = 14 * DAY;
  while (cursor < horizon) {
    const until = Math.min(cursor + step, horizon);
    for (const open of subtract(businessIntervals(calendar, cursor, until), pauses)) {
      const length = open.end! - open.start;
      if (length >= remaining) return new Date(open.start + remaining);
      remaining -= length;
    }
    cursor = until;
  }
  throw new SlaCalendarError('no business time within the horizon');
}

export interface SlaTargets {
  readonly responseMinutes: number | null;
  readonly resolutionMinutes: number;
}

export interface SlaDeadlines {
  readonly responseDueAt: Date | null;
  readonly resolutionDueAt: Date;
}

/** Response and resolution deadlines of an SLA that started at `startedAt` (Spec §8.3). */
export function computeSlaDeadlines(
  targets: SlaTargets,
  calendar: SlaCalendar,
  startedAt: Date,
  pauses: readonly Interval[] = [],
): SlaDeadlines {
  return {
    // Pauses only happen once work has started, i.e. after the response target is met.
    responseDueAt:
      targets.responseMinutes === null
        ? null
        : addBusinessMinutes(startedAt, targets.responseMinutes, calendar),
    resolutionDueAt: addBusinessMinutes(startedAt, targets.resolutionMinutes, calendar, pauses),
  };
}

// ---- policy selection ----

export interface PolicyMatch {
  readonly id: string;
  readonly matchKind: string | null;
  readonly matchServiceCode: string | null;
  readonly matchDepartmentCode: string | null;
  readonly matchPriority: string | null;
}

export interface WorkFacts {
  readonly kind: string;
  readonly serviceCode: string | null;
  readonly departmentCode: string | null;
  readonly priority: string;
}

/**
 * The most specific active policy that matches (service > department > priority > kind); every set criterion must
 * match. Ties are broken by id so the choice never depends on row order.
 */
export function pickPolicy<P extends PolicyMatch>(
  policies: readonly P[],
  work: WorkFacts,
): P | null {
  let best: { policy: P; score: number } | null = null;
  for (const p of policies) {
    if (p.matchKind !== null && p.matchKind !== work.kind) continue;
    if (p.matchServiceCode !== null && p.matchServiceCode !== work.serviceCode) continue;
    if (p.matchDepartmentCode !== null && p.matchDepartmentCode !== work.departmentCode) continue;
    if (p.matchPriority !== null && p.matchPriority !== work.priority) continue;
    const score =
      (p.matchServiceCode !== null ? 8 : 0) +
      (p.matchDepartmentCode !== null ? 4 : 0) +
      (p.matchPriority !== null ? 2 : 0) +
      (p.matchKind !== null ? 1 : 0);
    if (!best || score > best.score || (score === best.score && p.id < best.policy.id))
      best = { policy: p, score };
  }
  return best?.policy ?? null;
}

// ---- escalation ----

export const ESCALATION_TRIGGERS = [
  'RESPONSE_BREACH',
  'RESOLUTION_WARNING',
  'RESOLUTION_BREACH',
] as const;
export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];
export const ALERT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export interface EscalationRule {
  readonly level: number;
  readonly trigger: EscalationTrigger;
  /** Wall-clock minutes after the breach (before the deadline for a warning). */
  readonly offsetMinutes: number;
  readonly severity: AlertSeverity;
  /** Role codes to notify (notification intents, Sprint 3.4). */
  readonly notifyRoles: readonly string[];
}

export interface SlaClock {
  readonly responseDueAt: Date | null;
  readonly resolutionDueAt: Date;
  readonly responseMetAt: Date | null;
  readonly resolutionMetAt: Date | null;
  readonly responseBreachedAt: Date | null;
  readonly resolutionBreachedAt: Date | null;
}

export interface SlaEvaluation {
  readonly responseBreached: boolean;
  readonly resolutionBreached: boolean;
  readonly escalations: readonly EscalationRule[];
  /** When to look again; null when nothing is left to watch. */
  readonly nextCheckAt: Date | null;
}

function fireAt(rule: EscalationRule, clock: SlaClock): number | null {
  switch (rule.trigger) {
    case 'RESPONSE_BREACH':
      return clock.responseDueAt
        ? clock.responseDueAt.getTime() + rule.offsetMinutes * MINUTE
        : null;
    case 'RESOLUTION_BREACH':
      return clock.resolutionDueAt.getTime() + rule.offsetMinutes * MINUTE;
    case 'RESOLUTION_WARNING':
      return clock.resolutionDueAt.getTime() - rule.offsetMinutes * MINUTE;
  }
}

function stillWatching(rule: EscalationRule, clock: SlaClock): boolean {
  return rule.trigger === 'RESPONSE_BREACH'
    ? clock.responseMetAt === null
    : clock.resolutionMetAt === null;
}

/**
 * What is due for a running SLA at `now`: newly breached targets, escalation rules whose time has come (and not fired
 * yet), and when to check next. Idempotent: run it as often as you like.
 */
export function evaluateSla(
  clock: SlaClock,
  rules: readonly EscalationRule[],
  fired: ReadonlySet<string>,
  now: Date,
): SlaEvaluation {
  const t = now.getTime();
  const responseBreached =
    clock.responseDueAt !== null &&
    clock.responseMetAt === null &&
    clock.responseBreachedAt === null &&
    t >= clock.responseDueAt.getTime();
  const resolutionBreached =
    clock.resolutionMetAt === null &&
    clock.resolutionBreachedAt === null &&
    t >= clock.resolutionDueAt.getTime();
  const escalations: EscalationRule[] = [];
  const upcoming: number[] = [];
  for (const rule of [...rules].sort((a, b) => a.level - b.level)) {
    if (fired.has(escalationKey(rule)) || !stillWatching(rule, clock)) continue;
    const when = fireAt(rule, clock);
    if (when === null) continue;
    if (when <= t) escalations.push(rule);
    else upcoming.push(when);
  }
  if (
    clock.responseDueAt &&
    clock.responseMetAt === null &&
    !clock.responseBreachedAt &&
    !responseBreached
  )
    upcoming.push(clock.responseDueAt.getTime());
  if (clock.resolutionMetAt === null && !clock.resolutionBreachedAt && !resolutionBreached)
    upcoming.push(clock.resolutionDueAt.getTime());
  return {
    responseBreached,
    resolutionBreached,
    escalations,
    nextCheckAt: upcoming.length ? new Date(Math.min(...upcoming)) : null,
  };
}

export function escalationKey(rule: { readonly trigger: string; readonly level: number }): string {
  return `${rule.trigger}:${rule.level}`;
}

// ---- helpers ----

function at(date: LocalDate, minutes: number, timeZone: string): number {
  if (minutes === 24 * 60) return localToUtc(addDays(date, 1), timeZone).getTime();
  return localToUtc(
    { ...date, hour: Math.floor(minutes / 60), minute: minutes % 60 },
    timeZone,
  ).getTime();
}

function merge(intervals: Array<{ start: number; end: number }>): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number }> = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/** `open` minus every (closed) pause. */
function subtract(open: readonly Interval[], pauses: readonly Interval[]): Interval[] {
  let result = open.map((i) => ({ start: i.start, end: i.end! }));
  for (const p of pauses) {
    const next: Array<{ start: number; end: number }> = [];
    for (const i of result) {
      if (p.end! <= i.start || p.start >= i.end) {
        next.push(i);
        continue;
      }
      if (p.start > i.start) next.push({ start: i.start, end: p.start });
      if (p.end! < i.end) next.push({ start: p.end!, end: i.end });
    }
    result = next;
  }
  return result;
}
