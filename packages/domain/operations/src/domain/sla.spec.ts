import { describe, expect, it } from 'vitest';
import {
  addBusinessMinutes,
  computeSlaDeadlines,
  type EscalationRule,
  escalationKey,
  evaluateSla,
  pickPolicy,
  scheduleProblems,
  type SlaCalendar,
  type SlaClock,
  type WeeklySchedule,
} from './sla';

const EVERY_DAY = (windows: Array<[string, string]>): WeeklySchedule => ({
  days: {
    sun: windows,
    mon: windows,
    tue: windows,
    wed: windows,
    thu: windows,
    fri: windows,
    sat: windows,
  },
});
const cairo = (schedule: WeeklySchedule): SlaCalendar => ({
  kind: 'BUSINESS_HOURS',
  timeZone: 'Africa/Cairo',
  schedule,
});
const HOURS_8_20 = cairo(EVERY_DAY([['08:00', '20:00']]));
const iso = (d: Date) => d.toISOString();
const t = (s: string) => new Date(s);

describe('business-time deadlines (BUILD_PLAN §7.4: 08:00–20:00, pauses, DST in Africa/Cairo)', () => {
  const cases: Array<{
    name: string;
    calendar: SlaCalendar;
    start: string;
    minutes: number;
    pauses?: Array<[string, string]>;
    due: string;
  }> = [
    {
      name: 'rolls over the night into the first day of summer time (UTC+2 → UTC+3)',
      calendar: HOURS_8_20,
      start: '2026-04-23T17:30:00Z', // Thu 19:30 local
      minutes: 60,
      due: '2026-04-24T05:30:00.000Z', // Fri 08:30 local, now UTC+3
    },
    {
      name: 'rolls over the night out of summer time (UTC+3 → UTC+2)',
      calendar: HOURS_8_20,
      start: '2026-10-29T16:00:00Z', // Thu 19:00 local (UTC+3)
      minutes: 120,
      due: '2026-10-30T07:00:00.000Z', // Fri 09:00 local, now UTC+2
    },
    {
      name: 'within one business day',
      calendar: HOURS_8_20,
      start: '2026-10-05T05:00:00Z', // Mon 08:00 local
      minutes: 90,
      due: '2026-10-05T06:30:00.000Z',
    },
    {
      name: 'starts before opening',
      calendar: HOURS_8_20,
      start: '2026-10-05T02:00:00Z', // Mon 05:00 local
      minutes: 30,
      due: '2026-10-05T05:30:00.000Z',
    },
    {
      name: 'a pause inside business hours shifts the deadline by its length',
      calendar: HOURS_8_20,
      start: '2026-10-05T05:00:00Z', // Mon 08:00 local
      minutes: 240,
      pauses: [['2026-10-05T06:00:00Z', '2026-10-05T07:30:00Z']], // 09:00–10:30 local
      due: '2026-10-05T10:30:00.000Z', // 13:30 local
    },
    {
      name: 'a pause across the night only removes the business part',
      calendar: HOURS_8_20,
      start: '2026-10-05T15:00:00Z', // Mon 18:00 local
      minutes: 180,
      pauses: [['2026-10-05T16:00:00Z', '2026-10-06T06:00:00Z']], // Mon 19:00 → Tue 09:00 local
      due: '2026-10-06T08:00:00.000Z', // Tue 11:00 local
    },
    {
      name: 'skips a closed date',
      calendar: cairo({ ...EVERY_DAY([['08:00', '20:00']]), closedDates: ['2026-10-06'] }),
      start: '2026-10-05T16:30:00Z', // Mon 19:30 local
      minutes: 60,
      due: '2026-10-07T05:30:00.000Z', // Wed 08:30 local
    },
    {
      name: 'night shift window runs past midnight',
      calendar: cairo({ days: { mon: [['22:00', '06:00']] } }),
      start: '2026-10-05T18:00:00Z', // Mon 21:00 local
      minutes: 120,
      due: '2026-10-05T21:00:00.000Z', // Tue 00:00 local
    },
    {
      name: "yesterday's night shift is still open in the early morning",
      calendar: cairo({ days: { mon: [['22:00', '06:00']] } }),
      start: '2026-10-06T00:00:00Z', // Tue 03:00 local
      minutes: 60,
      due: '2026-10-06T01:00:00.000Z',
    },
    {
      name: 'around the clock counts elapsed time across the DST jump',
      calendar: { kind: 'ALWAYS' },
      start: '2026-04-23T21:30:00Z', // Thu 23:30 local, clocks jump at midnight
      minutes: 60,
      due: '2026-04-23T22:30:00.000Z',
    },
    {
      name: 'a window that loses an hour to a spring-forward gap (New York)',
      calendar: {
        kind: 'BUSINESS_HOURS',
        timeZone: 'America/New_York',
        schedule: EVERY_DAY([['01:00', '04:00']]),
      },
      start: '2026-03-08T06:30:00Z', // 01:30 EST; the window closes at 04:00 EDT = 08:00Z
      minutes: 120,
      due: '2026-03-09T05:30:00.000Z', // 90 minutes that night, 30 the next (01:30 EDT)
    },
  ];
  for (const c of cases)
    it(c.name, () => {
      const pauses = (c.pauses ?? []).map(([a, b]) => ({
        start: Date.parse(a),
        end: Date.parse(b),
      }));
      expect(iso(addBusinessMinutes(t(c.start), c.minutes, c.calendar, pauses))).toBe(c.due);
    });

  it('computes response and resolution targets together; pauses only move resolution', () => {
    const d = computeSlaDeadlines(
      { responseMinutes: 15, resolutionMinutes: 120 },
      HOURS_8_20,
      t('2026-10-05T05:00:00Z'),
      [{ start: Date.parse('2026-10-05T05:30:00Z'), end: Date.parse('2026-10-05T06:00:00Z') }],
    );
    expect([iso(d.responseDueAt!), iso(d.resolutionDueAt)]).toEqual([
      '2026-10-05T05:15:00.000Z',
      '2026-10-05T07:30:00.000Z',
    ]);
    expect(
      computeSlaDeadlines(
        { responseMinutes: null, resolutionMinutes: 0 },
        HOURS_8_20,
        t('2026-10-05T05:00:00Z'),
      ).responseDueAt,
    ).toBeNull();
  });

  it('refuses running pauses and calendars without business time', () => {
    expect(() =>
      addBusinessMinutes(t('2026-10-05T05:00:00Z'), 10, HOURS_8_20, [{ start: 0, end: null }]),
    ).toThrow(/open pause/);
    expect(() => addBusinessMinutes(t('2026-10-05T05:00:00Z'), 10, cairo({ days: {} }))).toThrow(
      /horizon/,
    );
    expect(scheduleProblems({ days: {} })).toContain('no business hours');
    expect(scheduleProblems({ days: { mon: [['8:00', '20:00']] } })[0]).toMatch(/bad window/);
    expect(scheduleProblems({ days: { mon: [['24:00', '06:00']] } })[0]).toMatch(/bad window/);
    expect(scheduleProblems(EVERY_DAY([['08:00', '20:00']]))).toEqual([]);
  });
});

describe('SLA policy selection', () => {
  const policy = (
    id: string,
    m: Partial<Record<'kind' | 'service' | 'department' | 'priority', string>>,
  ) => ({
    id,
    matchKind: m.kind ?? null,
    matchServiceCode: m.service ?? null,
    matchDepartmentCode: m.department ?? null,
    matchPriority: m.priority ?? null,
  });
  const policies = [
    policy('p0', {}),
    policy('p1', { kind: 'HK_JOB' }),
    policy('p2', { kind: 'HK_JOB', priority: 'URGENT' }),
    policy('p3', { department: 'HK' }),
    policy('p4', { service: 'EXTRA_TOWELS' }),
  ];
  const work = (
    over: Partial<{
      kind: string;
      serviceCode: string | null;
      departmentCode: string | null;
      priority: string;
    }>,
  ) => ({
    kind: 'HK_JOB',
    serviceCode: null,
    departmentCode: null,
    priority: 'NORMAL',
    ...over,
  });

  it('takes the most specific matching policy', () => {
    expect(pickPolicy(policies, work({}))?.id).toBe('p1');
    expect(pickPolicy(policies, work({ priority: 'URGENT' }))?.id).toBe('p2');
    expect(pickPolicy(policies, work({ priority: 'URGENT', departmentCode: 'HK' }))?.id).toBe('p3');
    expect(
      pickPolicy(policies, work({ departmentCode: 'HK', serviceCode: 'EXTRA_TOWELS' }))?.id,
    ).toBe('p4');
    expect(pickPolicy(policies, work({ kind: 'WORK_ORDER' }))?.id).toBe('p0');
    expect(pickPolicy(policies.slice(1), work({ kind: 'WORK_ORDER' }))).toBeNull();
  });

  it('breaks ties by id, not by order', () => {
    const tied = [policy('b', { kind: 'HK_JOB' }), policy('a', { kind: 'HK_JOB' })];
    expect(pickPolicy(tied, work({}))?.id).toBe('a');
    expect(pickPolicy([...tied].reverse(), work({}))?.id).toBe('a');
  });
});

describe('SLA evaluation and escalation ladder', () => {
  const clock = (over: Partial<SlaClock> = {}): SlaClock => ({
    responseDueAt: t('2026-10-05T05:15:00Z'),
    resolutionDueAt: t('2026-10-05T07:00:00Z'),
    responseMetAt: null,
    resolutionMetAt: null,
    responseBreachedAt: null,
    resolutionBreachedAt: null,
    ...over,
  });
  const rule = (
    level: number,
    trigger: EscalationRule['trigger'],
    offsetMinutes: number,
  ): EscalationRule => ({
    level,
    trigger,
    offsetMinutes,
    severity: 'WARNING',
    notifyRoles: ['DUTY_MANAGER'],
  });
  const ladder = [
    rule(1, 'RESPONSE_BREACH', 0),
    rule(1, 'RESOLUTION_WARNING', 30),
    rule(1, 'RESOLUTION_BREACH', 0),
    rule(2, 'RESOLUTION_BREACH', 60),
  ];

  it('waits for the next deadline when nothing is due', () => {
    const e = evaluateSla(clock(), ladder, new Set(), t('2026-10-05T05:00:00Z'));
    expect(e).toMatchObject({
      responseBreached: false,
      resolutionBreached: false,
      escalations: [],
    });
    expect(iso(e.nextCheckAt!)).toBe('2026-10-05T05:15:00.000Z');
  });

  it('breaches the response target and fires its escalation once', () => {
    const now = t('2026-10-05T05:16:00Z');
    const first = evaluateSla(clock(), ladder, new Set(), now);
    expect(first.responseBreached).toBe(true);
    expect(first.escalations.map(escalationKey)).toEqual(['RESPONSE_BREACH:1']);
    expect(iso(first.nextCheckAt!)).toBe('2026-10-05T06:30:00.000Z'); // the resolution warning
    const again = evaluateSla(
      clock({ responseBreachedAt: now }),
      ladder,
      new Set(['RESPONSE_BREACH:1']),
      now,
    );
    expect(again).toMatchObject({ responseBreached: false, escalations: [] });
  });

  it('climbs the resolution ladder and stops when resolved', () => {
    const late = t('2026-10-05T08:05:00Z');
    const e = evaluateSla(
      clock({ responseMetAt: t('2026-10-05T05:05:00Z') }),
      ladder,
      new Set(),
      late,
    );
    expect(e.resolutionBreached).toBe(true);
    expect(e.escalations.map(escalationKey)).toEqual([
      'RESOLUTION_WARNING:1',
      'RESOLUTION_BREACH:1',
      'RESOLUTION_BREACH:2',
    ]);
    expect(e.nextCheckAt).toBeNull();
    const resolved = evaluateSla(
      clock({
        responseMetAt: t('2026-10-05T05:05:00Z'),
        resolutionMetAt: t('2026-10-05T06:00:00Z'),
      }),
      ladder,
      new Set(),
      late,
    );
    expect(resolved).toMatchObject({
      resolutionBreached: false,
      escalations: [],
      nextCheckAt: null,
    });
  });
});
