/**
 * Interface profiles (ADR-0019; OPERA Integration Guide §7.3): what Planova asks of a vendor interface, record by
 * record — the fields requested, the fields without which a record cannot be used, and the records requested only when
 * a hotel enables them. A hotel's interface sheet is compared with the profile at commissioning; what a hotel does not
 * deliver shows as a profile gap, never as a guess. The agent's link records (FIAS `LR`) are generated from the same
 * definition (shared vector `test-vectors/fias-profile-v1.json`, checked by both implementations).
 */

export interface ProfileRecord {
  /** What the platform uses the record for. */
  readonly purpose: string;
  /** Field ids requested from the interface, in request order. */
  readonly fields: readonly string[];
  /** Fields without which the record is refused (a parse error and an integration exception). */
  readonly mandatory: readonly string[];
  /** Requested only when the hotel enables it (agent setting); absent = always requested. */
  readonly optional?: boolean;
}

export interface InterfaceProfile {
  readonly code: string;
  readonly version: number;
  readonly records: Readonly<Record<string, ProfileRecord>>;
}

/** What one received message showed of the profile: its record id and the field ids it carried. */
export interface ProfileObservation {
  readonly record: string;
  readonly fields: readonly string[];
}

/** Planova Standard OPERA IFC8/FIAS Profile v1 (guide §7.3): the records OPERA sends to Hotella. */
export const FIAS_STANDARD_PROFILE_V1: InterfaceProfile = Object.freeze({
  code: 'PLANOVA_FIAS_STANDARD',
  version: 1,
  records: Object.freeze({
    GI: {
      purpose: 'check-in; in the database swap (SF) one in-house reservation',
      fields: ['RN', 'G#', 'GN', 'GF', 'GT', 'GL', 'GV', 'GS', 'GG', 'GA', 'GD', 'SF', 'DA', 'TI'],
      mandatory: ['RN', 'G#', 'GN', 'GD'],
    },
    GO: {
      purpose: 'check-out',
      fields: ['RN', 'G#', 'GS', 'SF', 'DA', 'TI'],
      mandatory: ['G#'],
    },
    GC: {
      purpose: 'guest data change and room move (RO = old room)',
      fields: ['RN', 'RO', 'G#', 'GN', 'GF', 'GT', 'GL', 'GV', 'GS', 'GG', 'GA', 'GD', 'DA', 'TI'],
      mandatory: ['G#'],
    },
    RE: {
      purpose: 'room status from the PMS (RS 1–6)',
      fields: ['RN', 'RS', 'DA', 'TI'],
      mandatory: ['RN', 'RS'],
    },
    DS: { purpose: 'database swap start', fields: ['DA', 'TI'], mandatory: [] },
    DE: { purpose: 'database swap end', fields: ['DA', 'TI'], mandatory: [] },
    NS: { purpose: 'night audit start', fields: ['DA', 'TI'], mandatory: [], optional: true },
    NE: { purpose: 'night audit end', fields: ['DA', 'TI'], mandatory: [], optional: true },
  }),
});

/** The FIAS `LR` requests for a profile: `[record id, concatenated field ids]`, optional records only when enabled. */
export function fiasLinkRecords(
  profile: InterfaceProfile,
  enabledOptional: readonly string[] = [],
): Array<[string, string]> {
  return Object.entries(profile.records)
    .filter(([id, r]) => !r.optional || enabledOptional.includes(id))
    .map(([id, r]) => [id, r.fields.join('')]);
}

export interface ProfileRecordCoverage {
  readonly record: string;
  readonly purpose: string;
  readonly optional: boolean;
  /** Messages of this record received since the instance started observing. */
  readonly received: number;
  /** Requested fields seen at least once, with how often. */
  readonly seen: Readonly<Record<string, number>>;
  /** Requested fields never delivered — the hotel's profile gaps (an empty list once all were seen). */
  readonly gaps: readonly string[];
  /** Received records that lacked a mandatory field (each one was refused). */
  readonly missingMandatory: number;
  /** Fields delivered that the profile does not request (ignored, reported for the interface sheet). */
  readonly extra: readonly string[];
}

/**
 * Coverage of a profile from what an instance received (pure; the integration context keeps the counts). A record
 * never received has every field as a gap, so an interface that never sends `RE` shows it plainly.
 */
export function profileCoverage(
  profile: InterfaceProfile,
  observed: ReadonlyArray<{
    readonly record: string;
    readonly received: number;
    readonly fields: Readonly<Record<string, number>>;
    readonly missingMandatory: number;
  }>,
): ProfileRecordCoverage[] {
  const byRecord = new Map(observed.map((o) => [o.record, o]));
  return Object.entries(profile.records).map(([id, r]) => {
    const o = byRecord.get(id);
    const seen: Record<string, number> = {};
    for (const f of r.fields) if (o?.fields[f]) seen[f] = o.fields[f];
    return {
      record: id,
      purpose: r.purpose,
      optional: r.optional ?? false,
      received: o?.received ?? 0,
      seen,
      gaps: r.fields.filter((f) => !seen[f]),
      missingMandatory: o?.missingMandatory ?? 0,
      extra: Object.keys(o?.fields ?? {})
        .filter((f) => !r.fields.includes(f))
        .sort(),
    };
  });
}
