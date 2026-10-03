import { describe, expect, it } from 'vitest';
import { evaluateReadiness, type ReadinessInput } from './readiness';

const vacantClean: ReadinessInput = {
  occupancy: 'VACANT',
  housekeeping: 'CLEAN',
  frontOffice: null,
  openEngineeringWork: 0,
};

describe('room readiness v0', () => {
  it('a vacant clean room with no open engineering work and no restriction is ready', () => {
    const r = evaluateReadiness(['HOUSEKEEPING', 'ENGINEERING', 'NO_OOO'], vacantClean);
    expect(r.ready).toBe(true);
    expect(r.dimensions.map((d) => d.result)).toEqual(['PASS', 'PASS', 'PASS']);
  });

  it('every failing dimension says why', () => {
    const r = evaluateReadiness(['HOUSEKEEPING', 'INSPECTION', 'ENGINEERING', 'NO_OOO'], {
      occupancy: 'VACANT',
      housekeeping: 'DIRTY',
      frontOffice: 'OUT_OF_ORDER',
      openEngineeringWork: 2,
    });
    expect(r.ready).toBe(false);
    expect(r.dimensions.map((d) => d.reason)).toEqual([
      'NOT_CLEAN',
      'NOT_INSPECTED',
      'OPEN_ENGINEERING_WORK',
      'OUT_OF_ORDER',
    ]);
  });

  it('inspection is only required when the property checks it', () => {
    expect(evaluateReadiness(['HOUSEKEEPING'], vacantClean).ready).toBe(true);
    expect(evaluateReadiness(['HOUSEKEEPING', 'INSPECTION'], vacantClean).ready).toBe(false);
    expect(
      evaluateReadiness(['HOUSEKEEPING', 'INSPECTION'], {
        ...vacantClean,
        housekeeping: 'INSPECTED',
      }).ready,
    ).toBe(true);
  });

  it('what could not be checked is not ready, and an occupied room is never ready', () => {
    const unknown = evaluateReadiness(['ENGINEERING'], {
      ...vacantClean,
      openEngineeringWork: null,
    });
    expect(unknown).toMatchObject({
      ready: false,
      dimensions: [{ result: 'UNKNOWN', reason: 'ENGINEERING_UNKNOWN' }],
    });
    expect(
      evaluateReadiness(['HOUSEKEEPING'], { ...vacantClean, occupancy: 'OCCUPIED' }),
    ).toMatchObject({ ready: false, occupied: true });
  });
});
