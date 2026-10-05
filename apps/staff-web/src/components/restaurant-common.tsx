'use client';

import { useFormatter } from 'next-intl';

export const card = 'rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-900/5';
export const field = 'rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm';
export const label = 'flex flex-col gap-1 text-xs font-semibold text-slate-600';

/** Today's date where the screen is used (the hotel), as YYYY-MM-DD. */
export function localToday(): string {
  return new Date().toLocaleDateString('en-CA');
}
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Hotel-local dates and times as the person reads them (no time zone shift). */
export function useClock() {
  const format = useFormatter();
  return {
    day: (date: string) =>
      format.dateTime(new Date(`${date}T12:00:00Z`), {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      }),
    time: (clock: string) =>
      format.dateTime(new Date(`1970-01-01T${clock}:00Z`), { timeStyle: 'short', timeZone: 'UTC' }),
    weekday: (n: number) =>
      // 2026-01-04 was a Sunday (weekday 0).
      format.dateTime(new Date(Date.UTC(2026, 0, 4 + n, 12)), {
        weekday: 'long',
        timeZone: 'UTC',
      }),
  };
}

/** Runs an action with one busy flag, one error line and one notice line for the whole screen. */
export type Run = (action: () => Promise<unknown>, done?: string) => Promise<boolean>;
