import { describe, expect, it } from 'vitest';
import {
  addDays,
  assertTimeZone,
  isoDate,
  localToUtc,
  offsetMs,
  parseClock,
  wallClock,
} from './index';

describe('time in hotel time zones', () => {
  it('converts Cairo wall-clock time across the 2026 DST changes', () => {
    // Egypt: summer time from the last Friday of April (00:00 → 01:00) to the last Thursday of October (24:00 → 23:00).
    expect(
      localToUtc({ year: 2026, month: 4, day: 23, hour: 12 }, 'Africa/Cairo').toISOString(),
    ).toBe('2026-04-23T10:00:00.000Z');
    expect(
      localToUtc({ year: 2026, month: 4, day: 24, hour: 12 }, 'Africa/Cairo').toISOString(),
    ).toBe('2026-04-24T09:00:00.000Z');
    expect(
      localToUtc({ year: 2026, month: 10, day: 30, hour: 12 }, 'Africa/Cairo').toISOString(),
    ).toBe('2026-10-30T10:00:00.000Z');
    expect(offsetMs(Date.parse('2026-07-01T00:00:00Z'), 'Africa/Cairo')).toBe(3 * 3600_000);
  });

  it('resolves non-existent and repeated local times deterministically', () => {
    // New York 2026-03-08 02:30 does not exist (→ 03:30 EDT); 2026-11-01 01:30 happens twice (→ the EDT reading).
    expect(
      localToUtc(
        { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
        'America/New_York',
      ).toISOString(),
    ).toBe('2026-03-08T07:30:00.000Z');
    expect(
      localToUtc({ year: 2026, month: 3, day: 8, hour: 2 }, 'America/New_York').toISOString(),
    ).toBe('2026-03-08T07:00:00.000Z');
    expect(
      localToUtc(
        { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
        'America/New_York',
      ).toISOString(),
    ).toBe('2026-11-01T05:30:00.000Z');
  });

  it('reads wall clocks and does calendar arithmetic', () => {
    expect(wallClock(Date.parse('2026-10-03T21:30:00Z'), 'Africa/Cairo')).toMatchObject({
      year: 2026,
      month: 10,
      day: 4,
      hour: 0,
      minute: 30,
      weekday: 0,
    });
    expect(isoDate(addDays({ year: 2026, month: 12, day: 31 }, 1))).toBe('2027-01-01');
    expect(isoDate(addDays({ year: 2028, month: 3, day: 1 }, -1))).toBe('2028-02-29');
    expect([
      parseClock('08:00'),
      parseClock('24:00'),
      parseClock('24:30'),
      parseClock('8:00'),
    ]).toEqual([480, 1440, null, null]);
    expect(() => assertTimeZone('Mars/Olympus')).toThrow();
  });
});
