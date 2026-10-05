import { describe, expect, it } from 'vitest';
import {
  canMove,
  confidence,
  recurringAssetFailure,
  repeatComplaint,
  type Signal,
  slaBreachCluster,
  slowTurnaround,
} from './insights';

const now = new Date('2026-10-05T12:00:00Z');
const daysAgo = (d: number, minutes = 0) =>
  new Date(now.getTime() - d * 86_400_000 + minutes * 60_000);
let n = 0;
const sig = (signal: string, at: Date, codes: Signal['codes'], subjectRef = `s${++n}`): Signal => ({
  signal,
  subjectKind: 'X',
  subjectRef,
  codes,
  at,
});

describe('confidence', () => {
  it('is half at the threshold and full at twice the threshold', () => {
    expect(confidence(3, 3)).toBe(0.5);
    expect(confidence(4, 3)).toBe(0.667);
    expect(confidence(9, 3)).toBe(1);
  });
});

describe('RECURRING_ASSET_FAILURE (Spec §38)', () => {
  const closed = (asset: string, d: number, cause: string | null, type = 'CORRECTIVE') =>
    sig('WORK_ORDER_CLOSED', daysAgo(d), { asset, type, status: 'DONE', cause });
  const cfg = { windowDays: 30, minFailures: 3 };

  it('raises when an asset needed enough corrective repairs in the window, naming a shared cause', () => {
    const signals = [
      closed('ac-504', 2, 'WEAR'),
      closed('ac-504', 9, 'WEAR'),
      closed('ac-504', 20, 'POWER'),
      closed('ac-504', 25, 'WEAR'),
      closed('ac-504', 40, 'WEAR'), // outside the window
      closed('ac-601', 3, 'WEAR'),
      closed('ac-601', 4, 'WEAR', 'PREVENTIVE'), // not corrective
      closed('ac-601', 5, 'WEAR'),
    ];
    const found = recurringAssetFailure(signals, now, cfg);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      fingerprint: 'asset:ac-504',
      severity: 'MEDIUM',
      confidence: 0.667,
      reasonKey: 'ai.insight.reason.recurring_failure_same_cause',
      reasonParams: { count: 4, days: 30, cause: 'WEAR' },
      evidence: [
        { kind: 'CORRECTIVE_WORK_ORDERS', refType: 'WORK_ORDER', count: 4, window: 'P30D' },
      ],
      affected: [{ type: 'ASSET', id: 'ac-504' }],
    });
    // Without a majority cause it says so differently.
    expect(
      recurringAssetFailure(
        [closed('x', 1, 'A'), closed('x', 2, 'B'), closed('x', 3, null)],
        now,
        cfg,
      )[0]?.reasonKey,
    ).toBe('ai.insight.reason.recurring_failure');
  });
});

describe('SLA_BREACH_CLUSTER', () => {
  const breach = (department: string, d: number) => sig('SLA_BREACHED', daysAgo(d), { department });
  const cfg = { recentDays: 7, baselineDays: 28, minBreaches: 3, factor: 2 };

  it('needs both the minimum and a clear rise over the department’s own baseline', () => {
    const hk = [1, 2, 3, 4].map((d) => breach('HK', d)); // 4 this week, none before
    const eng = [
      ...[1, 2, 3, 4].map((d) => breach('ENG', d)),
      ...[8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34].map((d) => breach('ENG', d)),
    ]; // 4 this week, 14 in four weeks before = 3.5 a week
    const fo = [1, 2].map((d) => breach('FO', d));
    const found = slaBreachCluster([...hk, ...eng, ...fo], now, cfg);
    expect(found.map((f) => f.fingerprint)).toEqual(['department:HK']);
    expect(found[0]).toMatchObject({ reasonParams: { department: 'HK', count: 4, baseline: 0 } });
  });
});

describe('REPEAT_COMPLAINT', () => {
  const complaint = (room: string | null, category: string, d: number) =>
    sig('COMPLAINT_OPENED', daysAgo(d), { room, category });
  it('finds a room complained about repeatedly and a category that keeps coming back', () => {
    const found = repeatComplaint(
      [
        complaint('r504', 'NOISE', 1),
        complaint('r504', 'NOISE', 5),
        complaint('r601', 'CLEANLINESS', 2),
        complaint(null, 'CLEANLINESS', 3),
        complaint('r702', 'CLEANLINESS', 4),
        complaint('r504', 'NOISE', 30), // outside the window
      ],
      now,
      { windowDays: 14, minPerRoom: 2, minPerCategory: 3 },
    );
    expect(found.map((f) => `${f.fingerprint}:${f.reasonParams.count}`)).toEqual([
      'category:CLEANLINESS:3',
      'room:r504:2',
    ]);
    expect(found[1]?.reasonParams.category).toBe('NOISE');
  });
});

describe('SLOW_TURNAROUND', () => {
  const job = (id: string, room: string, d: number, minutes: number) => [
    sig('HK_JOB_STATUS', daysAgo(d), { room, to: 'DONE' }, id),
    sig('HK_JOB_STATUS', daysAgo(d, minutes), { room, to: 'INSPECTED' }, id),
  ];
  it('compares a room type’s clean-to-inspected median with the hotel’s', () => {
    const roomTypes = new Map([
      ['s1', 'SUITE'],
      ['s2', 'SUITE'],
      ['k1', 'KING'],
      ['k2', 'KING'],
    ]);
    const signals = [
      ...[1, 2, 3].flatMap((d) => job(`js${d}`, d % 2 ? 's1' : 's2', d, 120)),
      ...[1, 2, 3, 4, 5].flatMap((d) => job(`jk${d}`, d % 2 ? 'k1' : 'k2', d, 30)),
    ];
    const found = slowTurnaround(signals, now, roomTypes, {
      windowDays: 14,
      minSamples: 3,
      factor: 1.5,
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      fingerprint: 'room_type:SUITE',
      reasonParams: { median_minutes: 120, property_minutes: 30, samples: 3 },
      severity: 'HIGH',
    });
    // Too few cleans overall: nothing.
    expect(
      slowTurnaround(signals.slice(0, 4), now, roomTypes, {
        windowDays: 14,
        minSamples: 3,
        factor: 1.5,
      }),
    ).toEqual([]);
  });
});

describe('insight lifecycle', () => {
  it('lets people act on live insights only', () => {
    expect(canMove('OPEN', 'ACKNOWLEDGED')).toBe(true);
    expect(canMove('ACKNOWLEDGED', 'RESOLVED')).toBe(true);
    expect(canMove('ACKNOWLEDGED', 'ACKNOWLEDGED')).toBe(false);
    expect(canMove('RESOLVED', 'OPEN')).toBe(false);
    expect(canMove('DISMISSED', 'RESOLVED')).toBe(false);
  });
});
