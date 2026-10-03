/**
 * Arrival-risk intelligence v1 (Spec §9, BUILD_PLAN 8.B): will the room be ready when the guest arrives? Rules only
 * (CLAUDE.md rule 11): a score from the room's state, its open work and restrictions, the guest's ETA and VIP flag,
 * with the reasons that produced it. Nothing here is estimated by a model.
 */

export type ArrivalRiskReason =
  | 'NO_ROOM_ASSIGNED'
  | 'ROOM_RESTRICTED'
  | 'ROOM_STILL_OCCUPIED'
  | 'ROOM_DIRTY'
  | 'ROOM_BEING_CLEANED'
  | 'AWAITING_INSPECTION'
  | 'OPEN_ENGINEERING_WORK'
  | 'URGENT_ENGINEERING_WORK'
  | 'ETA_SOON'
  | 'ETA_PASSED'
  | 'VIP_GUEST';

export type ArrivalRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface ArrivalRiskInput {
  readonly roomAssigned: boolean;
  /** The room's housekeeping state, when the room is known. */
  readonly housekeeping:
    'DIRTY' | 'PICKUP' | 'CLEANING' | 'CLEAN' | 'INSPECTING' | 'INSPECTED' | null;
  readonly occupied: boolean;
  /** Readiness as housekeeping computed it (all configured dimensions). */
  readonly ready: boolean;
  readonly restricted: boolean;
  /** Open engineering work at the room, and whether any of it is HIGH/URGENT priority. */
  readonly openEngineeringWork: number;
  readonly urgentEngineeringWork: boolean;
  readonly vip: boolean;
  /** Minutes until the ETA (negative once it has passed); null without an ETA. */
  readonly minutesToEta: number | null;
}

export interface ArrivalRisk {
  readonly score: number;
  readonly level: ArrivalRiskLevel;
  /** Most important first. */
  readonly reasons: readonly ArrivalRiskReason[];
}

/** Points per reason; the order of this table is the order reasons are listed in. */
export const ARRIVAL_RISK_POINTS: Readonly<Record<ArrivalRiskReason, number>> = {
  ROOM_RESTRICTED: 60,
  NO_ROOM_ASSIGNED: 30,
  ETA_PASSED: 30,
  ROOM_STILL_OCCUPIED: 25,
  ROOM_DIRTY: 25,
  OPEN_ENGINEERING_WORK: 25,
  ETA_SOON: 20,
  URGENT_ENGINEERING_WORK: 10,
  ROOM_BEING_CLEANED: 10,
  VIP_GUEST: 10,
  AWAITING_INSPECTION: 5,
};

/** Within this many minutes of the ETA, a room that is not ready is a risk. */
export const ETA_SOON_MINUTES = 120;
export const HIGH_FROM = 60;
export const MEDIUM_FROM = 25;

export function assessArrival(input: ArrivalRiskInput): ArrivalRisk {
  const found = new Set<ArrivalRiskReason>();
  if (!input.roomAssigned) found.add('NO_ROOM_ASSIGNED');
  else {
    if (input.restricted) found.add('ROOM_RESTRICTED');
    if (input.occupied) found.add('ROOM_STILL_OCCUPIED');
    if (input.housekeeping === 'DIRTY' || input.housekeeping === 'PICKUP') found.add('ROOM_DIRTY');
    else if (input.housekeeping === 'CLEANING') found.add('ROOM_BEING_CLEANED');
    else if (input.housekeeping === 'INSPECTING') found.add('AWAITING_INSPECTION');
    if (input.openEngineeringWork > 0) {
      found.add('OPEN_ENGINEERING_WORK');
      if (input.urgentEngineeringWork) found.add('URGENT_ENGINEERING_WORK');
    }
  }
  const notReady = !input.roomAssigned || !input.ready;
  if (notReady && input.minutesToEta !== null) {
    if (input.minutesToEta < 0) found.add('ETA_PASSED');
    else if (input.minutesToEta <= ETA_SOON_MINUTES) found.add('ETA_SOON');
  }
  // A VIP raises the stakes of a problem; it is not a problem by itself.
  if (input.vip && found.size > 0) found.add('VIP_GUEST');
  const reasons = (Object.keys(ARRIVAL_RISK_POINTS) as ArrivalRiskReason[]).filter((r) =>
    found.has(r),
  );
  const score = Math.min(
    100,
    reasons.reduce((sum, r) => sum + ARRIVAL_RISK_POINTS[r], 0),
  );
  const level: ArrivalRiskLevel =
    score >= HIGH_FROM ? 'HIGH' : score >= MEDIUM_FROM ? 'MEDIUM' : 'LOW';
  return { score, level, reasons };
}
