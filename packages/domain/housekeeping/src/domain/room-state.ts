/**
 * Room operational state (Spec §9): pure rules, unit-tested. Room status is not a cleaning job — the projection says
 * what the room is now; jobs are work. The PMS owns occupancy and the front-office status (CLAUDE.md rule 19); the
 * platform owns the housekeeping progress between a room going dirty and being clean or inspected.
 */

export const OCCUPANCY = ['VACANT', 'OCCUPIED'] as const;
export const HOUSEKEEPING = [
  'DIRTY',
  'CLEANING',
  'CLEAN',
  'INSPECTING',
  'INSPECTED',
  'PICKUP',
] as const;
export const SIGNALS = ['DND', 'MAKE_UP_ROOM', 'PRIVACY', 'SERVICE_REQUESTED'] as const;
export const SIGNAL_SOURCES = ['PMS', 'BMS', 'SMART_ROOM', 'STAFF', 'GUEST_PORTAL'] as const;

export type Occupancy = (typeof OCCUPANCY)[number];
export type HousekeepingState = (typeof HOUSEKEEPING)[number];
export type RoomSignal = (typeof SIGNALS)[number];
export type SignalSource = (typeof SIGNAL_SOURCES)[number];
export type StateCause = 'PMS' | 'JOB' | 'INSPECTION' | 'STAFF' | 'SYSTEM';

/** What a canonical PMS room status means here: a housekeeping state, or a front-office restriction. */
export function fromPmsStatus(status: string): {
  readonly housekeeping: HousekeepingState | null;
  readonly frontOffice: string | null;
} {
  switch (status) {
    case 'DIRTY':
    case 'CLEAN':
    case 'INSPECTED':
    case 'PICKUP':
      return { housekeeping: status, frontOffice: null };
    case 'OUT_OF_ORDER':
    case 'OUT_OF_SERVICE':
      return { housekeeping: null, frontOffice: status };
    default:
      return { housekeeping: null, frontOffice: null };
  }
}

/**
 * Which housekeeping moves staff may make by hand (the rest come from jobs, inspections and the PMS). A room can always
 * be marked dirty or pick-up; cleaning states move forward.
 */
const STAFF_MOVES: Readonly<Record<HousekeepingState, readonly HousekeepingState[]>> = {
  DIRTY: ['CLEANING', 'CLEAN', 'PICKUP'],
  PICKUP: ['CLEANING', 'CLEAN', 'DIRTY'],
  CLEANING: ['CLEAN', 'DIRTY', 'PICKUP'],
  CLEAN: ['INSPECTING', 'INSPECTED', 'DIRTY', 'PICKUP'],
  INSPECTING: ['INSPECTED', 'DIRTY', 'PICKUP'],
  INSPECTED: ['DIRTY', 'PICKUP'],
};

export function staffMoveAllowed(from: HousekeepingState, to: HousekeepingState): boolean {
  return from !== to && STAFF_MOVES[from].includes(to);
}

/**
 * A PMS event older than the last one applied to the room is ignored (events may arrive late or twice); events without
 * a time are applied in arrival order.
 */
export function isStale(eventAt: Date, lastPmsAt: Date | null): boolean {
  return lastPmsAt !== null && eventAt.getTime() < lastPmsAt.getTime();
}

/** Signals that cannot both be on: asking for service lifts privacy and the other way round. */
export function conflictingSignals(signal: RoomSignal): readonly RoomSignal[] {
  switch (signal) {
    case 'DND':
    case 'PRIVACY':
      return ['MAKE_UP_ROOM', 'SERVICE_REQUESTED'];
    case 'MAKE_UP_ROOM':
    case 'SERVICE_REQUESTED':
      return ['DND', 'PRIVACY'];
  }
}
