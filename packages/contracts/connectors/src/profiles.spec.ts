import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineConnector } from './manifest';
import { FIAS_STANDARD_PROFILE_V1, fiasLinkRecords, profileCoverage } from './profiles';

/** The vector the .NET agent reads too: both sides must request exactly the profile's records and fields. */
function fiasProfileVector() {
  return {
    code: FIAS_STANDARD_PROFILE_V1.code,
    version: FIAS_STANDARD_PROFILE_V1.version,
    link_records: fiasLinkRecords(FIAS_STANDARD_PROFILE_V1),
    optional_records: Object.entries(FIAS_STANDARD_PROFILE_V1.records)
      .filter(([, r]) => r.optional)
      .map(([id, r]) => [id, r.fields.join('')]),
  };
}

describe('Planova Standard FIAS profile v1', () => {
  it('is the shared vector the .NET agent requests (test-vectors/fias-profile-v1.json)', () => {
    const vector: unknown = JSON.parse(
      readFileSync(join(process.cwd(), 'test-vectors', 'fias-profile-v1.json'), 'utf8'),
    );
    expect(vector).toEqual(fiasProfileVector());
  });

  it('requests optional records only when the hotel enables them', () => {
    expect(fiasLinkRecords(FIAS_STANDARD_PROFILE_V1).map(([id]) => id)).toEqual([
      'GI',
      'GO',
      'GC',
      'RE',
      'DS',
      'DE',
    ]);
    expect(fiasLinkRecords(FIAS_STANDARD_PROFILE_V1, ['NS', 'NE']).map(([id]) => id)).toContain(
      'NS',
    );
    expect(fiasLinkRecords(FIAS_STANDARD_PROFILE_V1)[0]).toEqual([
      'GI',
      'RNG#GNGFGTGLGVGSGGGAGDSFDATI',
    ]);
  });

  it('reports gaps, refused records and extra fields; a record never received is all gaps', () => {
    const coverage = profileCoverage(FIAS_STANDARD_PROFILE_V1, [
      {
        record: 'GI',
        received: 10,
        fields: { RN: 10, 'G#': 10, GN: 10, GF: 9, GA: 10, GD: 10, DA: 10, TI: 10, XX: 2 },
        missingMandatory: 1,
      },
    ]);
    const gi = coverage.find((c) => c.record === 'GI')!;
    expect(gi.gaps).toEqual(['GT', 'GL', 'GV', 'GS', 'GG', 'SF']);
    expect(gi.missingMandatory).toBe(1);
    expect(gi.extra).toEqual(['XX']);
    expect(coverage.find((c) => c.record === 'RE')).toMatchObject({
      received: 0,
      gaps: ['RN', 'RS', 'DA', 'TI'],
    });
    expect(coverage.find((c) => c.record === 'NS')).toMatchObject({ optional: true });
  });

  it('a profile cannot require a field it does not request', () => {
    expect(() =>
      defineConnector({
        code: 'BAD_PROFILE',
        version: 1,
        category: 'PMS',
        description: 'x',
        capabilities: ['CHECKIN_EVENT'],
        messageTypes: [],
        commands: [],
        configSchema: z.object({}),
        credentialSchema: z.object({}),
        profile: {
          code: 'X',
          version: 1,
          records: { GI: { purpose: 'x', fields: ['RN'], mandatory: ['G#'] } },
        },
      }),
    ).toThrow(/unrequested field G#/);
  });
});
