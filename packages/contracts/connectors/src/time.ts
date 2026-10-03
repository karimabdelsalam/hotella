/**
 * Wall-clock time in an IANA timezone → UTC instant (SDK helper for sources that report local hotel time, e.g. FIAS
 * `DA`/`TI`). Deterministic and dependency-free. A local time that does not exist (spring-forward gap) or occurs
 * twice (fall-back) resolves deterministically to one of the adjacent valid instants.
 */
export function localDateTimeToUtc(
  parts: {
    readonly year: number;
    readonly month: number;
    readonly day: number;
    readonly hour?: number;
    readonly minute?: number;
    readonly second?: number;
  },
  timeZone: string,
): Date {
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  // Two passes converge for every real-world zone (offset changes at most once around a given instant).
  const first = asUtc - offsetMs(asUtc, timeZone);
  const second = asUtc - offsetMs(first, timeZone);
  return new Date(first === second ? first : Math.min(first, second));
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds (positive east of Greenwich). */
export function offsetMs(instant: number, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(instant))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const wall = Date.UTC(
    p['year']!,
    p['month']! - 1,
    p['day']!,
    p['hour']!,
    p['minute']!,
    p['second']!,
  );
  return wall - Math.floor(instant / 1000) * 1000;
}
