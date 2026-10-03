import { describe, expect, it } from 'vitest';
import { addDays, isDue, nextMeterDue, readingAccepted } from './pm';

describe('preventive maintenance due rules', () => {
  const state = { lastDoneOn: '2026-09-03', lastDoneValue: 1200 };

  it('calendar plans come due their lead days before the due day, across month ends', () => {
    expect(addDays('2026-09-28', 5)).toBe('2026-10-03');
    const every30 = { kind: 'CALENDAR', everyDays: 30 } as const;
    expect(isDue(every30, state, { today: '2026-09-29', leadDays: 3, meterValue: null })).toBe(
      false,
    );
    expect(isDue(every30, state, { today: '2026-09-30', leadDays: 3, meterValue: null })).toBe(
      true,
    );
    expect(isDue(every30, state, { today: '2026-10-03', leadDays: 0, meterValue: null })).toBe(
      true,
    );
  });

  it('meter plans come due at the next multiple of their interval from the last service', () => {
    const every500 = { kind: 'METER', meterId: 'm', everyUnits: 500 } as const;
    expect(nextMeterDue(state, 500)).toBe(1700);
    expect(isDue(every500, state, { today: '2026-10-03', leadDays: 0, meterValue: 1699.5 })).toBe(
      false,
    );
    expect(isDue(every500, state, { today: '2026-10-03', leadDays: 0, meterValue: 1700 })).toBe(
      true,
    );
    expect(isDue(every500, state, { today: '2026-10-03', leadDays: 0, meterValue: null })).toBe(
      false,
    );
  });

  it('condition plans are due while the reading is out of bounds', () => {
    const hot = { kind: 'CONDITION', meterId: 'm', above: 8 } as const;
    expect(isDue(hot, state, { today: '2026-10-03', leadDays: 0, meterValue: 7.5 })).toBe(false);
    expect(isDue(hot, state, { today: '2026-10-03', leadDays: 0, meterValue: 9 })).toBe(true);
  });

  it('cumulative meters never go back; point readings may', () => {
    expect(readingAccepted('RUNTIME_HOURS', 1200, 1199)).toBe(false);
    expect(readingAccepted('RUNTIME_HOURS', 1200, 1200)).toBe(true);
    expect(readingAccepted('TEMPERATURE', 9, 4)).toBe(true);
    expect(readingAccepted('CYCLES', null, 0)).toBe(true);
  });
});
