import { describe, expect, it } from 'vitest';
import { nextShift, shiftAt, shiftWindow, validShiftStarts } from './shifts';

const cairo = 'Africa/Cairo';

describe('shifts', () => {
  it('knows the running shift in the hotel’s time zone; the small hours belong to the previous night', () => {
    // 2026-10-04 is in Cairo summer time (UTC+3).
    expect(shiftAt(new Date('2026-10-04T05:00:00Z'), cairo)).toEqual({
      shiftDate: '2026-10-04',
      shift: 'MORNING',
    });
    expect(shiftAt(new Date('2026-10-04T13:30:00Z'), cairo)).toEqual({
      shiftDate: '2026-10-04',
      shift: 'EVENING',
    });
    // 23:30 local: the night of the 4th starts…
    expect(shiftAt(new Date('2026-10-04T20:30:00Z'), cairo)).toEqual({
      shiftDate: '2026-10-04',
      shift: 'NIGHT',
    });
    // …and 02:30 local on the 5th is still that night.
    expect(shiftAt(new Date('2026-10-04T23:30:00Z'), cairo)).toEqual({
      shiftDate: '2026-10-04',
      shift: 'NIGHT',
    });
    expect(shiftAt(new Date('2026-10-05T04:30:00Z'), cairo)).toEqual({
      shiftDate: '2026-10-05',
      shift: 'MORNING',
    });
  });

  it('gives each shift its window, the night running into the next morning', () => {
    expect(shiftWindow('2026-10-04', 'MORNING', cairo)).toEqual({
      from: new Date('2026-10-04T04:00:00Z'),
      to: new Date('2026-10-04T12:00:00Z'),
    });
    expect(shiftWindow('2026-10-04', 'NIGHT', cairo)).toEqual({
      from: new Date('2026-10-04T20:00:00Z'),
      to: new Date('2026-10-05T04:00:00Z'),
    });
  });

  it('follows the order of shifts and refuses starts out of order', () => {
    expect(nextShift('2026-10-04', 'EVENING')).toEqual({ shiftDate: '2026-10-04', shift: 'NIGHT' });
    expect(nextShift('2026-10-31', 'NIGHT')).toEqual({ shiftDate: '2026-11-01', shift: 'MORNING' });
    expect(validShiftStarts({ MORNING: '06:00', EVENING: '14:00', NIGHT: '22:00' })).toBe(true);
    expect(validShiftStarts({ MORNING: '14:00', EVENING: '06:00', NIGHT: '22:00' })).toBe(false);
    expect(validShiftStarts({ MORNING: '6am', EVENING: '14:00', NIGHT: '22:00' })).toBe(false);
  });
});
