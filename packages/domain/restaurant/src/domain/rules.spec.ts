import { describe, expect, it } from 'vitest';
import {
  canTransition,
  guestWindow,
  sittingsOn,
  sittingStart,
  stayAllowance,
  stayNights,
  weekdayOf,
  withinStay,
} from './rules';

describe('the stay allowance (Spec B.1)', () => {
  it('is one booking per restaurant per started block of 7 nights', () => {
    const table: Array<[number, number]> = [
      [1, 1],
      [6, 1],
      [7, 1],
      [8, 2],
      [14, 2],
      [15, 3],
      [21, 3],
      [22, 4],
    ];
    for (const [nights, allowed] of table)
      expect(stayAllowance(nights), `${nights} nights`).toBe(allowed);
  });

  it('follows the property policy', () => {
    expect(stayAllowance(9, { blockNights: 5, perBlock: 2 })).toBe(4);
    expect(stayAllowance(5, { blockNights: 5, perBlock: 2 })).toBe(2);
  });

  it('counts nights between arrival and departure; a day use counts as one', () => {
    expect(stayNights('2026-10-05', '2026-10-13')).toBe(8);
    expect(stayNights('2026-12-28', '2027-01-04')).toBe(7);
    expect(stayNights('2026-10-05', '2026-10-05')).toBe(1);
  });
});

describe('sittings and dates', () => {
  const sittings = [
    {
      id: 'a',
      weekday: 1,
      startsAt: '21:00',
      seats: 20,
      validFrom: '2026-01-01',
      validTo: null,
      active: true,
    },
    {
      id: 'b',
      weekday: 1,
      startsAt: '19:00',
      seats: 30,
      validFrom: '2026-01-01',
      validTo: '2026-10-31',
      active: true,
    },
    {
      id: 'c',
      weekday: 2,
      startsAt: '19:00',
      seats: 30,
      validFrom: '2026-01-01',
      validTo: null,
      active: true,
    },
    {
      id: 'd',
      weekday: 1,
      startsAt: '20:00',
      seats: 30,
      validFrom: '2026-01-01',
      validTo: null,
      active: false,
    },
  ];

  it('serves the weekday’s active sittings in force, in time order', () => {
    expect(weekdayOf('2026-10-05')).toBe(1); // a Monday
    expect(sittingsOn('2026-10-05', sittings, []).map((s) => s.id)).toEqual(['b', 'a']);
    expect(sittingsOn('2026-11-02', sittings, []).map((s) => s.id)).toEqual(['a']); // b ended in October
    expect(sittingsOn('2026-10-06', sittings, []).map((s) => s.id)).toEqual(['c']);
  });

  it('honours closures of a day or of one sitting', () => {
    expect(sittingsOn('2026-10-05', sittings, [{ onDate: '2026-10-05', sittingId: null }])).toEqual(
      [],
    );
    expect(
      sittingsOn('2026-10-05', sittings, [{ onDate: '2026-10-05', sittingId: 'b' }]).map(
        (s) => s.id,
      ),
    ).toEqual(['a']);
  });

  it('keeps dinners within the nights of the stay', () => {
    expect(withinStay('2026-10-05', '2026-10-05', '2026-10-08')).toBe(true);
    expect(withinStay('2026-10-07', '2026-10-05', '2026-10-08')).toBe(true);
    expect(withinStay('2026-10-08', '2026-10-05', '2026-10-08')).toBe(false); // departure day
    expect(withinStay('2026-10-04', '2026-10-05', '2026-10-08')).toBe(false);
    expect(withinStay('2026-10-05', '2026-10-05', '2026-10-05')).toBe(true); // day use
  });

  it('places a sitting in the hotel’s time zone', () => {
    expect(sittingStart('2026-10-05', '19:30', 'Africa/Cairo').toISOString()).toBe(
      '2026-10-05T16:30:00.000Z',
    );
  });
});

describe('the guest booking window', () => {
  const base = {
    serviceDate: '2026-10-08',
    startsAt: '19:00',
    timeZone: 'Africa/Cairo',
    cutoffMinutes: 120,
    daysAhead: 7,
  };
  it('closes before the sitting and opens a number of days ahead', () => {
    expect(guestWindow({ ...base, now: new Date('2026-10-08T13:00:00Z') })).toBe('OPEN'); // 16:00 local
    expect(guestWindow({ ...base, now: new Date('2026-10-08T14:30:00Z') })).toBe('CUTOFF_PASSED'); // 17:30 local
    expect(guestWindow({ ...base, now: new Date('2026-09-30T10:00:00Z') })).toBe('TOO_EARLY');
    expect(guestWindow({ ...base, now: new Date('2026-10-01T10:00:00Z') })).toBe('OPEN');
  });
});

describe('reservation lifecycle', () => {
  it('moves forward only', () => {
    expect(canTransition('CONFIRMED', 'SEATED')).toBe(true);
    expect(canTransition('SEATED', 'COMPLETED')).toBe(true);
    expect(canTransition('CONFIRMED', 'NO_SHOW')).toBe(true);
    expect(canTransition('SEATED', 'CANCELLED')).toBe(false);
    expect(canTransition('CANCELLED', 'CONFIRMED')).toBe(false);
  });
});
