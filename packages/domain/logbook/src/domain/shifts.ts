import { addDays, isoDate, localToUtc, parseClock, wallClock } from '@hotella/platform-time';

/**
 * Shifts (Spec §14, BUILD_PLAN 9.B): the day is split into MORNING, EVENING and NIGHT at the property's configured
 * wall-clock starts. A night shift belongs to the date it started on (the 23:00–07:00 shift of the 4th is the 4th's
 * night). Deterministic; time-zone and DST aware through platform-time.
 */
export const SHIFTS = ['MORNING', 'EVENING', 'NIGHT'] as const;
export type Shift = (typeof SHIFTS)[number];
export type ShiftStarts = Readonly<Record<Shift, string>>;

export const DEFAULT_SHIFT_STARTS: ShiftStarts = {
  MORNING: '07:00',
  EVENING: '15:00',
  NIGHT: '23:00',
};

function minutes(starts: ShiftStarts): Record<Shift, number> {
  const m = {
    MORNING: parseClock(starts.MORNING),
    EVENING: parseClock(starts.EVENING),
    NIGHT: parseClock(starts.NIGHT),
  };
  if (m.MORNING === null || m.EVENING === null || m.NIGHT === null)
    throw new Error('shift starts must be HH:MM');
  if (!(m.MORNING < m.EVENING && m.EVENING < m.NIGHT))
    throw new Error('shift starts must be MORNING < EVENING < NIGHT');
  return m as Record<Shift, number>;
}

/** Whether a set of starts is usable (for the setting's schema). */
export function validShiftStarts(starts: ShiftStarts): boolean {
  try {
    minutes(starts);
    return true;
  } catch {
    return false;
  }
}

/** The shift running at an instant, and the date it belongs to. */
export function shiftAt(
  at: Date,
  timeZone: string,
  starts: ShiftStarts = DEFAULT_SHIFT_STARTS,
): { readonly shiftDate: string; readonly shift: Shift } {
  const m = minutes(starts);
  const w = wallClock(at, timeZone);
  const now = w.hour * 60 + w.minute;
  if (now >= m.NIGHT) return { shiftDate: isoDate(w), shift: 'NIGHT' };
  if (now < m.MORNING) return { shiftDate: isoDate(addDays(w, -1)), shift: 'NIGHT' };
  return { shiftDate: isoDate(w), shift: now >= m.EVENING ? 'EVENING' : 'MORNING' };
}

const at = (date: string, clock: number, timeZone: string) => {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return localToUtc(
    { year, month, day, hour: Math.floor(clock / 60), minute: clock % 60, second: 0 },
    timeZone,
  );
};

/** The instants a shift runs between (UTC), from its local starts. */
export function shiftWindow(
  shiftDate: string,
  shift: Shift,
  timeZone: string,
  starts: ShiftStarts = DEFAULT_SHIFT_STARTS,
): { readonly from: Date; readonly to: Date } {
  const m = minutes(starts);
  const [year, month, day] = shiftDate.split('-').map(Number) as [number, number, number];
  const next = isoDate(addDays({ year, month, day }, 1));
  switch (shift) {
    case 'MORNING':
      return { from: at(shiftDate, m.MORNING, timeZone), to: at(shiftDate, m.EVENING, timeZone) };
    case 'EVENING':
      return { from: at(shiftDate, m.EVENING, timeZone), to: at(shiftDate, m.NIGHT, timeZone) };
    case 'NIGHT':
      return { from: at(shiftDate, m.NIGHT, timeZone), to: at(next, m.MORNING, timeZone) };
  }
}

/** The shift that follows (the one a handover is written for). */
export function nextShift(shiftDate: string, shift: Shift): { shiftDate: string; shift: Shift } {
  if (shift === 'MORNING') return { shiftDate, shift: 'EVENING' };
  if (shift === 'EVENING') return { shiftDate, shift: 'NIGHT' };
  const [year, month, day] = shiftDate.split('-').map(Number) as [number, number, number];
  return { shiftDate: isoDate(addDays({ year, month, day }, 1)), shift: 'MORNING' };
}
