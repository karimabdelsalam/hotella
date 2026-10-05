import { addDays, isoDate, localToUtc, parseClock, wallClock } from '@hotella/platform-time';

/**
 * À la carte reservation rules (Spec Appendix B.1) — deterministic code (rule 11), no I/O. Dates are the hotel's
 * calendar dates (`YYYY-MM-DD`), sitting times its wall-clock times (`HH:MM`) in the property's time zone.
 */

export interface AllowancePolicy {
  /** A stay may book each restaurant `perBlock` times per started block of `blockNights` nights (default 7 / 1). */
  readonly blockNights: number;
  readonly perBlock: number;
}
export const DEFAULT_ALLOWANCE: AllowancePolicy = { blockNights: 7, perBlock: 1 };

const parseDate = (d: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) throw new RangeError(`not a calendar date: ${d}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
};
const dayNumber = (d: string) => {
  const { year, month, day } = parseDate(d);
  return Date.UTC(year, month - 1, day) / 86_400_000;
};

/** Nights between arrival and departure; a day use (same day) counts as one. */
export function stayNights(arrival: string, departure: string): number {
  return Math.max(1, dayNumber(departure) - dayNumber(arrival));
}

/** How many reservations a stay may hold at one restaurant: ⌈nights ÷ block⌉ × per block (8 nights → 2). */
export function stayAllowance(nights: number, policy: AllowancePolicy = DEFAULT_ALLOWANCE): number {
  return Math.ceil(Math.max(1, nights) / policy.blockNights) * policy.perBlock;
}

/** A dinner belongs to a night of the stay: arrival ≤ date < departure (a day use: the arrival date only). */
export function withinStay(serviceDate: string, arrival: string, departure: string): boolean {
  const d = dayNumber(serviceDate);
  const a = dayNumber(arrival);
  const end = Math.max(dayNumber(departure), a + 1);
  return d >= a && d < end;
}

/** 0 = Sunday … 6 = Saturday, of a calendar date. */
export function weekdayOf(date: string): number {
  return new Date(dayNumber(date) * 86_400_000).getUTCDay();
}

export interface SittingRule {
  readonly id: string;
  readonly weekday: number;
  readonly startsAt: string;
  readonly seats: number;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly active: boolean;
}
export interface ClosureRule {
  readonly onDate: string;
  /** null: the whole day. */
  readonly sittingId: string | null;
}

/** The sittings a restaurant serves on a date: its weekday, in force that day, active, not closed. */
export function sittingsOn<S extends SittingRule>(
  date: string,
  sittings: readonly S[],
  closures: readonly ClosureRule[],
): S[] {
  const weekday = weekdayOf(date);
  const day = dayNumber(date);
  const closedDay = closures.some((c) => c.onDate === date && c.sittingId === null);
  if (closedDay) return [];
  return sittings
    .filter(
      (s) =>
        s.active &&
        s.weekday === weekday &&
        dayNumber(s.validFrom) <= day &&
        (s.validTo === null || day <= dayNumber(s.validTo)) &&
        !closures.some((c) => c.onDate === date && c.sittingId === s.id),
    )
    .sort((a, b) => (parseClock(a.startsAt) ?? 0) - (parseClock(b.startsAt) ?? 0));
}

/** The instant a sitting starts. */
export function sittingStart(serviceDate: string, startsAt: string, timeZone: string): Date {
  const minutes = parseClock(startsAt);
  if (minutes === null) throw new RangeError(`not a time: ${startsAt}`);
  return localToUtc(
    { ...parseDate(serviceDate), hour: Math.floor(minutes / 60), minute: minutes % 60 },
    timeZone,
  );
}

/** The hotel's calendar date of an instant. */
export function localDate(at: Date, timeZone: string): string {
  return isoDate(wallClock(at, timeZone));
}

export type GuestWindow = 'OPEN' | 'CUTOFF_PASSED' | 'TOO_EARLY';

/**
 * May a guest book (or cancel) this sitting now? Not after `cutoffMinutes` before it starts, and not more than
 * `daysAhead` days ahead of today (hotel time). Staff are not bound by these windows.
 */
export function guestWindow(input: {
  readonly now: Date;
  readonly serviceDate: string;
  readonly startsAt: string;
  readonly timeZone: string;
  readonly cutoffMinutes: number;
  readonly daysAhead: number;
}): GuestWindow {
  const start = sittingStart(input.serviceDate, input.startsAt, input.timeZone);
  if (input.now.getTime() > start.getTime() - input.cutoffMinutes * 60_000) return 'CUTOFF_PASSED';
  const today = localDate(input.now, input.timeZone);
  const last = isoDate(addDays(parseDate(today), input.daysAhead));
  return dayNumber(input.serviceDate) > dayNumber(last) ? 'TOO_EARLY' : 'OPEN';
}

/** Reservation states that hold seats (cancelled and no-show free them), and those that use a stay's allowance. */
export const HOLDS_SEATS = ['CONFIRMED', 'SEATED', 'COMPLETED'] as const;
export const USES_ALLOWANCE = ['CONFIRMED', 'SEATED', 'COMPLETED', 'NO_SHOW'] as const;
export const RESERVATION_STATUSES = [
  'CONFIRMED',
  'SEATED',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** Allowed transitions; history keeps every one (rule 10). */
const NEXT: Record<ReservationStatus, readonly ReservationStatus[]> = {
  CONFIRMED: ['SEATED', 'CANCELLED', 'NO_SHOW'],
  SEATED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};
export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return NEXT[from].includes(to);
}
