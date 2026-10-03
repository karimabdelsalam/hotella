/**
 * In-house reconciliation (Spec §52), deterministic (CLAUDE.md rule 11). Compares what the PMS reports as in house
 * with the platform's stays and classifies every reservation:
 *
 * - MATCH             in house on both sides, same room;
 * - MISSING_INTERNAL  the PMS has it in house, the platform has no stay for it;
 * - DIFFERENT         both know it, but the status or the room differs;
 * - MISSING_EXTERNAL  the platform has it in house, the PMS does not.
 *
 * Nothing is corrected here: findings become integration exceptions for a human (no naive last-write-wins).
 */

export interface PmsInHouse {
  readonly externalId: string;
  /** Internal room when the PMS room code is mapped; null when unmapped. */
  readonly roomId: string | null;
  readonly roomCode: string | null;
}

export interface PlatformStay {
  readonly stayId: string;
  /** This integration's reservation id for the stay, if it has one. */
  readonly externalId: string | null;
  readonly status: string;
  readonly roomId: string | null;
}

export interface Finding {
  readonly entityType: 'STAY';
  readonly outcome: 'MATCH' | 'MISSING_INTERNAL' | 'MISSING_EXTERNAL' | 'DIFFERENT';
  readonly externalId: string | null;
  readonly internalId: string | null;
  readonly details: Record<string, string | number | boolean | null>;
}

/**
 * @param pms     the PMS snapshot
 * @param known   platform stays for the reservations the PMS reported (any status), keyed by external id
 * @param inHouse platform stays currently in house that belong to this integration
 */
export function reconcileInHouse(
  pms: readonly PmsInHouse[],
  known: ReadonlyMap<string, PlatformStay>,
  inHouse: readonly PlatformStay[],
): Finding[] {
  const findings: Finding[] = [];
  const reported = new Set<string>();
  for (const entry of [...pms].sort((a, b) => a.externalId.localeCompare(b.externalId))) {
    reported.add(entry.externalId);
    const stay = known.get(entry.externalId);
    if (!stay) {
      findings.push({
        entityType: 'STAY',
        outcome: 'MISSING_INTERNAL',
        externalId: entry.externalId,
        internalId: null,
        details: { pms_room_code: entry.roomCode },
      });
      continue;
    }
    if (stay.status !== 'IN_HOUSE') {
      findings.push({
        entityType: 'STAY',
        outcome: 'DIFFERENT',
        externalId: entry.externalId,
        internalId: stay.stayId,
        details: { field: 'status', pms: 'IN_HOUSE', platform: stay.status },
      });
      continue;
    }
    if (entry.roomId !== stay.roomId) {
      findings.push({
        entityType: 'STAY',
        outcome: 'DIFFERENT',
        externalId: entry.externalId,
        internalId: stay.stayId,
        details: {
          field: 'room',
          pms_room_code: entry.roomCode,
          pms_room_id: entry.roomId,
          platform_room_id: stay.roomId,
        },
      });
      continue;
    }
    findings.push({
      entityType: 'STAY',
      outcome: 'MATCH',
      externalId: entry.externalId,
      internalId: stay.stayId,
      details: {},
    });
  }
  for (const stay of [...inHouse].sort((a, b) => a.stayId.localeCompare(b.stayId))) {
    if (stay.externalId && reported.has(stay.externalId)) continue;
    findings.push({
      entityType: 'STAY',
      outcome: 'MISSING_EXTERNAL',
      externalId: stay.externalId,
      internalId: stay.stayId,
      details: { platform_room_id: stay.roomId },
    });
  }
  return findings;
}
