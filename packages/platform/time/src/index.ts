/**
 * Time in a hotel's timezone (IANA names, e.g. `Africa/Cairo`), deterministic and dependency-free. Hotels think in
 * wall-clock time ("housekeeping works 08:00–20:00"); the platform stores UTC instants (CLAUDE.md rule 2). These
 * helpers convert between the two across DST changes using the runtime's ICU time-zone data.
 */

export interface LocalDate {
  readonly year: number;
  /** 1–12 */
  readonly month: number;
  readonly day: number;
}

export interface LocalDateTime extends LocalDate {
  readonly hour?: number;
  readonly minute?: number;
  readonly second?: number;
}

export interface WallClock extends Required<LocalDateTime> {
  /** 0 = Sunday … 6 = Saturday */
  readonly weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Throws for a name the runtime does not know (so a typo never silently means UTC). */
export function assertTimeZone(timeZone: string): void {
  formatter(timeZone);
}

/** Wall-clock reading of `instant` in `timeZone`. */
export function wallClock(instant: number | Date, timeZone: string): WallClock {
  const t = typeof instant === 'number' ? instant : instant.getTime();
  const p: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(t)))
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  const year = p['year']!;
  const month = p['month']!;
  const day = p['day']!;
  return {
    year,
    month,
    day,
    hour: p['hour']!,
    minute: p['minute']!,
    second: p['second']!,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds (positive east of Greenwich). */
export function offsetMs(instant: number, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * Wall-clock time in `timeZone` → UTC instant, with the `compatible` disambiguation of ECMAScript Temporal: a local time
 * that does not exist (spring-forward gap) is moved forward by the length of the gap (02:30 → 03:30); one that occurs
 * twice (fall-back) resolves to the earlier instant.
 */
export function localToUtc(local: LocalDateTime, timeZone: string): Date {
  const asUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour ?? 0,
    local.minute ?? 0,
    local.second ?? 0,
  );
  const first = asUtc - offsetMs(asUtc, timeZone);
  const second = asUtc - offsetMs(first, timeZone);
  if (first === second) return new Date(first);
  // Ambiguous: the earlier reading that round-trips. Non-existent: neither round-trips; the later candidate is the
  // reading shifted forward by the gap.
  const candidates = [first, second].sort((a, b) => a - b);
  for (const c of candidates) {
    const w = wallClock(c, timeZone);
    if (Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) === asUtc)
      return new Date(c);
  }
  return new Date(candidates[1]!);
}

/** Calendar arithmetic on local dates (no time zone involved). */
export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** `YYYY-MM-DD` of a local date. */
export function isoDate(date: LocalDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(
    date.day,
  ).padStart(2, '0')}`;
}

/** `HH:MM` (00:00–24:00) → minutes after midnight; null when malformed. */
export function parseClock(value: string): number | null {
  const m = /^([01]\d|2[0-4]):([0-5]\d)$/.exec(value);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes <= 24 * 60 ? minutes : null;
}
