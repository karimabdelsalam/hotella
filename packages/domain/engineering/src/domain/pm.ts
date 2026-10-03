/**
 * Preventive maintenance and meters (Spec §10.6–§10.7, BUILD_PLAN 8.B): when a plan comes due is deterministic code
 * (rule 11), never estimated.
 */

export const METER_KINDS = [
  'RUNTIME_HOURS',
  'CYCLES',
  'ENERGY_KWH',
  'TEMPERATURE',
  'PRESSURE',
] as const;
export type MeterKind = (typeof METER_KINDS)[number];
/** Cumulative meters only grow (a replaced meter is reset explicitly); others are point readings. */
export const CUMULATIVE: ReadonlySet<MeterKind> = new Set([
  'RUNTIME_HOURS',
  'CYCLES',
  'ENERGY_KWH',
]);

export type PmTrigger =
  | { readonly kind: 'CALENDAR'; readonly everyDays: number }
  | { readonly kind: 'METER'; readonly meterId: string; readonly everyUnits: number }
  | {
      readonly kind: 'CONDITION';
      readonly meterId: string;
      readonly above?: number;
      readonly below?: number;
    };

export interface PmState {
  /** Property-local day the plan was last done (or started), YYYY-MM-DD. */
  readonly lastDoneOn: string;
  /** The meter value when it was last done (METER plans). */
  readonly lastDoneValue: number | null;
}

/** Adds days to a calendar day (no time zone arithmetic: days are property-local already). */
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The next due day of a calendar plan. */
export function nextCalendarDue(state: PmState, everyDays: number): string {
  return addDays(state.lastDoneOn, everyDays);
}

/** The meter value at which a meter plan is next due. */
export function nextMeterDue(state: PmState, everyUnits: number): number {
  return (state.lastDoneValue ?? 0) + everyUnits;
}

export interface DueInput {
  readonly today: string;
  readonly leadDays: number;
  /** The latest reading of the plan's meter, if any. */
  readonly meterValue: number | null;
}

/**
 * Whether the plan should create its work now: a calendar plan `leadDays` before its due day, a meter plan once the
 * meter reached its next value, a condition plan while the latest reading is out of bounds.
 */
export function isDue(trigger: PmTrigger, state: PmState, input: DueInput): boolean {
  switch (trigger.kind) {
    case 'CALENDAR':
      return addDays(input.today, input.leadDays) >= nextCalendarDue(state, trigger.everyDays);
    case 'METER':
      return (
        input.meterValue !== null && input.meterValue >= nextMeterDue(state, trigger.everyUnits)
      );
    case 'CONDITION':
      return (
        input.meterValue !== null &&
        ((trigger.above !== undefined && input.meterValue > trigger.above) ||
          (trigger.below !== undefined && input.meterValue < trigger.below))
      );
  }
}

/** A cumulative meter never goes back; a lower reading is refused unless the meter was reset. */
export function readingAccepted(kind: MeterKind, last: number | null, value: number): boolean {
  return !CUMULATIVE.has(kind) || last === null || value >= last;
}
