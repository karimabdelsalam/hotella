/**
 * Insights (Spec §38–§39, BUILD_PLAN 12.4): deterministic detectors over operational signals. Thresholds come from
 * configuration; confidence is a formula of the evidence (how far the sample exceeds its threshold), never a model's
 * opinion (rule 11). Evidence carries ids, counts and codes only.
 */

export const INSIGHT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type InsightSeverity = (typeof INSIGHT_SEVERITIES)[number];
export const INSIGHT_STATUSES = [
  'OPEN',
  'ACKNOWLEDGED',
  'RESOLVED',
  'DISMISSED',
  'EXPIRED',
] as const;
export type InsightStatus = (typeof INSIGHT_STATUSES)[number];

/** A fact the insight engine keeps from a domain event (append-only, ids and codes). */
export interface Signal {
  /** `WORK_ORDER_CLOSED`, `SLA_BREACHED`, `COMPLAINT_OPENED`, `HK_JOB_STATUS`. */
  readonly signal: string;
  readonly subjectKind: string;
  readonly subjectRef: string;
  readonly codes: Readonly<Record<string, string | number | boolean | null>>;
  readonly at: Date;
}

export interface Evidence {
  readonly kind: string;
  readonly refType: string;
  readonly refIds: readonly string[];
  readonly count: number;
  /** ISO 8601 duration of the window looked at, e.g. `P30D`. */
  readonly window: string;
}

export interface DetectedInsight {
  readonly detector: string;
  /** What makes two detections the same insight (one OPEN insight per property, detector and fingerprint). */
  readonly fingerprint: string;
  readonly severity: InsightSeverity;
  readonly confidence: number;
  readonly reasonKey: string;
  readonly reasonParams: Readonly<Record<string, string | number>>;
  readonly evidence: readonly Evidence[];
  readonly affected: ReadonlyArray<{ readonly type: string; readonly id: string }>;
  readonly suggestedAction: {
    readonly key: string;
    readonly params: Readonly<Record<string, string | number>>;
  } | null;
}

const DAY = 86_400_000;

/** How strongly the evidence supports the insight: the threshold met is 0.5, twice the threshold or more is 1. */
export function confidence(samples: number, threshold: number): number {
  if (threshold <= 0) return 1;
  return Math.round(Math.min(1, samples / (2 * threshold)) * 1000) / 1000;
}

const within = (signals: readonly Signal[], signal: string, from: Date, to: Date) =>
  signals.filter((s) => s.signal === signal && s.at >= from && s.at <= to);

function groupBy<T>(items: readonly T[], key: (t: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    out.set(k, [...(out.get(k) ?? []), item]);
  }
  return out;
}

/** The most frequent value and how often it occurs (ties: the smallest value, so the answer is stable). */
function mode(values: ReadonlyArray<string | null>): { value: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  return best ? { value: best[0], count: best[1] } : null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const ids = (signals: readonly Signal[]) => [...new Set(signals.map((s) => s.subjectRef))].sort();

/**
 * RECURRING_ASSET_FAILURE (the Spec §38 example): an asset needed at least `minFailures` corrective work orders in the
 * window. Most closed with the same cause → the cause is named and a preventive look is suggested.
 */
export function recurringAssetFailure(
  signals: readonly Signal[],
  now: Date,
  cfg: { readonly windowDays: number; readonly minFailures: number },
): DetectedInsight[] {
  const closed = within(
    signals,
    'WORK_ORDER_CLOSED',
    new Date(now.getTime() - cfg.windowDays * DAY),
    now,
  ).filter((s) => s.codes.type === 'CORRECTIVE' && s.codes.status === 'DONE');
  return [...groupBy(closed, (s) => str(s.codes.asset))]
    .filter(([, orders]) => orders.length >= cfg.minFailures)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([asset, orders]) => {
      const cause = mode(orders.map((o) => str(o.codes.cause)));
      const shared = cause && cause.count * 2 > orders.length ? cause.value : null;
      return {
        detector: 'RECURRING_ASSET_FAILURE',
        fingerprint: `asset:${asset}`,
        severity: orders.length >= cfg.minFailures * 2 ? 'HIGH' : 'MEDIUM',
        confidence: confidence(orders.length, cfg.minFailures),
        reasonKey: shared
          ? 'ai.insight.reason.recurring_failure_same_cause'
          : 'ai.insight.reason.recurring_failure',
        reasonParams: {
          count: orders.length,
          days: cfg.windowDays,
          ...(shared ? { cause: shared } : {}),
        },
        evidence: [
          {
            kind: 'CORRECTIVE_WORK_ORDERS',
            refType: 'WORK_ORDER',
            refIds: ids(orders),
            count: orders.length,
            window: `P${cfg.windowDays}D`,
          },
        ],
        affected: [{ type: 'ASSET', id: asset }],
        suggestedAction: { key: 'ai.insight.action.preventive_check', params: {} },
      } satisfies DetectedInsight;
    });
}

/**
 * SLA_BREACH_CLUSTER: a department breached at least `minBreaches` times in the recent window and at least `factor`
 * times its own weekly baseline (the window before it).
 */
export function slaBreachCluster(
  signals: readonly Signal[],
  now: Date,
  cfg: {
    readonly recentDays: number;
    readonly baselineDays: number;
    readonly minBreaches: number;
    readonly factor: number;
  },
): DetectedInsight[] {
  const recentFrom = new Date(now.getTime() - cfg.recentDays * DAY);
  const baselineFrom = new Date(recentFrom.getTime() - cfg.baselineDays * DAY);
  const recent = groupBy(within(signals, 'SLA_BREACHED', recentFrom, now), (s) =>
    str(s.codes.department),
  );
  const before = groupBy(
    within(signals, 'SLA_BREACHED', baselineFrom, new Date(recentFrom.getTime() - 1)),
    (s) => str(s.codes.department),
  );
  return [...recent]
    .flatMap(([department, breaches]) => {
      // The baseline over the same length of time as the recent window.
      const baseline = ((before.get(department)?.length ?? 0) * cfg.recentDays) / cfg.baselineDays;
      const needed = Math.max(cfg.minBreaches, cfg.factor * baseline);
      if (breaches.length < needed) return [];
      return [
        {
          detector: 'SLA_BREACH_CLUSTER',
          fingerprint: `department:${department}`,
          severity: breaches.length >= needed * 2 ? 'HIGH' : 'MEDIUM',
          confidence: confidence(breaches.length, needed),
          reasonKey: 'ai.insight.reason.sla_breach_cluster',
          reasonParams: {
            department,
            count: breaches.length,
            days: cfg.recentDays,
            baseline: Math.round(baseline * 10) / 10,
          },
          evidence: [
            {
              kind: 'SLA_BREACHES',
              refType: 'WORK_ITEM',
              refIds: ids(breaches),
              count: breaches.length,
              window: `P${cfg.recentDays}D`,
            },
          ],
          affected: [{ type: 'DEPARTMENT', id: department }],
          suggestedAction: { key: 'ai.insight.action.review_staffing', params: { department } },
        } satisfies DetectedInsight,
      ];
    })
    .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1));
}

/** REPEAT_COMPLAINT: the same room complained about at least `minPerRoom` times, or one category `minPerCategory` times. */
export function repeatComplaint(
  signals: readonly Signal[],
  now: Date,
  cfg: {
    readonly windowDays: number;
    readonly minPerRoom: number;
    readonly minPerCategory: number;
  },
): DetectedInsight[] {
  const opened = within(
    signals,
    'COMPLAINT_OPENED',
    new Date(now.getTime() - cfg.windowDays * DAY),
    now,
  );
  const window = `P${cfg.windowDays}D`;
  const byRoom = [...groupBy(opened, (s) => str(s.codes.room))]
    .filter(([, list]) => list.length >= cfg.minPerRoom)
    .map(([room, list]) => {
      const category = mode(list.map((c) => str(c.codes.category)));
      return {
        detector: 'REPEAT_COMPLAINT',
        fingerprint: `room:${room}`,
        severity: list.length >= cfg.minPerRoom * 2 ? 'HIGH' : 'MEDIUM',
        confidence: confidence(list.length, cfg.minPerRoom),
        reasonKey: 'ai.insight.reason.repeat_complaint_room',
        reasonParams: { count: list.length, days: cfg.windowDays, category: category?.value ?? '' },
        evidence: [
          {
            kind: 'COMPLAINTS',
            refType: 'COMPLAINT',
            refIds: ids(list),
            count: list.length,
            window,
          },
        ],
        affected: [{ type: 'LOCATION', id: room }],
        suggestedAction: { key: 'ai.insight.action.inspect_room', params: {} },
      } satisfies DetectedInsight;
    });
  const byCategory = [...groupBy(opened, (s) => str(s.codes.category))]
    .filter(([, list]) => list.length >= cfg.minPerCategory)
    .map(([category, list]) => ({
      detector: 'REPEAT_COMPLAINT',
      fingerprint: `category:${category}`,
      severity: list.length >= cfg.minPerCategory * 2 ? ('HIGH' as const) : ('MEDIUM' as const),
      confidence: confidence(list.length, cfg.minPerCategory),
      reasonKey: 'ai.insight.reason.repeat_complaint_category',
      reasonParams: { count: list.length, days: cfg.windowDays, category },
      evidence: [
        { kind: 'COMPLAINTS', refType: 'COMPLAINT', refIds: ids(list), count: list.length, window },
      ],
      affected: [{ type: 'COMPLAINT_CATEGORY', id: category }],
      suggestedAction: { key: 'ai.insight.action.review_category', params: { category } },
    }));
  return [...byRoom, ...byCategory].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1));
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/**
 * SLOW_TURNAROUND: rooms of one type wait far longer between cleaned (DONE) and inspected than the property's rooms
 * do: their median is at least `factor` times the property's, over at least `minSamples` cleans.
 */
export function slowTurnaround(
  signals: readonly Signal[],
  now: Date,
  roomTypeOf: ReadonlyMap<string, string>,
  cfg: { readonly windowDays: number; readonly minSamples: number; readonly factor: number },
): DetectedInsight[] {
  const steps = within(
    signals,
    'HK_JOB_STATUS',
    new Date(now.getTime() - cfg.windowDays * DAY),
    now,
  );
  const turns: Array<{ job: string; room: string; minutes: number }> = [];
  for (const [job, list] of groupBy(steps, (s) => s.subjectRef)) {
    const done = list.filter((s) => s.codes.to === 'DONE').sort((a, b) => +a.at - +b.at)[0];
    const inspected = list
      .filter((s) => s.codes.to === 'INSPECTED' && done && s.at >= done.at)
      .sort((a, b) => +a.at - +b.at)[0];
    const room = str(done?.codes.room);
    if (done && inspected && room)
      turns.push({ job, room, minutes: (inspected.at.getTime() - done.at.getTime()) / 60_000 });
  }
  if (turns.length < cfg.minSamples) return [];
  const property = median(turns.map((t) => t.minutes));
  return [...groupBy(turns, (t) => roomTypeOf.get(t.room) ?? null)]
    .flatMap(([roomType, list]) => {
      if (list.length < cfg.minSamples) return [];
      const typical = median(list.map((t) => t.minutes));
      if (property <= 0 || typical < cfg.factor * property) return [];
      return [
        {
          detector: 'SLOW_TURNAROUND',
          fingerprint: `room_type:${roomType}`,
          severity: typical >= cfg.factor * 2 * property ? ('HIGH' as const) : ('MEDIUM' as const),
          confidence: confidence(list.length, cfg.minSamples),
          reasonKey: 'ai.insight.reason.slow_turnaround',
          reasonParams: {
            median_minutes: Math.round(typical),
            property_minutes: Math.round(property),
            samples: list.length,
          },
          evidence: [
            {
              kind: 'CLEAN_TO_INSPECTED',
              refType: 'HK_JOB',
              refIds: list.map((t) => t.job).sort(),
              count: list.length,
              window: `P${cfg.windowDays}D`,
            },
          ],
          affected: [{ type: 'ROOM_TYPE', id: roomType }],
          suggestedAction: { key: 'ai.insight.action.review_inspection_flow', params: {} },
        } satisfies DetectedInsight,
      ];
    })
    .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1));
}

/** Allowed status moves of an insight (people act on OPEN and ACKNOWLEDGED ones; the engine expires them). */
export function canMove(from: InsightStatus, to: InsightStatus): boolean {
  if (from === 'OPEN') return to !== 'OPEN';
  if (from === 'ACKNOWLEDGED') return to === 'RESOLVED' || to === 'DISMISSED' || to === 'EXPIRED';
  return false;
}
