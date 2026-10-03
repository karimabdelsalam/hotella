/**
 * Cleaning jobs (Spec §9.1–§9.2): pure rules, unit-tested. Credits are deterministic (rule 11); a job follows its work
 * item in the operations engine the way service requests do.
 */

export const CLEANING_TYPES = [
  'STAYOVER',
  'CHECKOUT',
  'ARRIVAL',
  'DEEP_CLEAN',
  'TURNDOWN',
  'TOUCH_UP',
  'VIP',
  'OTHER',
] as const;
export type CleaningType = (typeof CLEANING_TYPES)[number];
export type JobStatus =
  'OPEN' | 'IN_PROGRESS' | 'DONE' | 'INSPECTED' | 'FAILED_INSPECTION' | 'SKIPPED' | 'CANCELLED';

/** Platform defaults (BUILD_PLAN 7.B); a property overrides them per type and room type. */
export const DEFAULT_CREDITS: Readonly<Record<CleaningType, number>> = {
  CHECKOUT: 1.0,
  STAYOVER: 0.7,
  ARRIVAL: 0.5,
  DEEP_CLEAN: 2.0,
  TURNDOWN: 0.4,
  TOUCH_UP: 0.3,
  VIP: 1.5,
  OTHER: 0.5,
};

export interface CreditRule {
  readonly cleaningType: CleaningType;
  readonly roomTypeId: string | null;
  readonly credits: number;
}

/** The property's rule for (type, room type), else its rule for the type, else the platform default. */
export function resolveCredits(
  rules: readonly CreditRule[],
  type: CleaningType,
  roomTypeId: string | null,
): number {
  const exact = roomTypeId
    ? rules.find((r) => r.cleaningType === type && r.roomTypeId === roomTypeId)
    : undefined;
  const general = rules.find((r) => r.cleaningType === type && r.roomTypeId === null);
  return (exact ?? general)?.credits ?? DEFAULT_CREDITS[type];
}

/**
 * The job status for its work item's new status. Finished jobs keep their outcome (a done or inspected job is not
 * reopened by a late event); null means no change.
 */
export function jobStatusFor(
  current: JobStatus,
  workItem: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CANCELLED',
): JobStatus | null {
  if (current !== 'OPEN' && current !== 'IN_PROGRESS') return null;
  switch (workItem) {
    case 'IN_PROGRESS':
      return current === 'OPEN' ? 'IN_PROGRESS' : null;
    case 'RESOLVED':
      return 'DONE';
    case 'CANCELLED':
      return 'CANCELLED';
    default:
      return null;
  }
}

/** The calendar day at `at` in the property's time zone (YYYY-MM-DD). */
export function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** The hour (0–23) at `at` in the property's time zone. */
export function localHour(at: Date, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(at),
  );
}
