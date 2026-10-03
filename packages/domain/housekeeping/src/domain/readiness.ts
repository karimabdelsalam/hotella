/**
 * Room readiness v0 (Spec §16, BUILD_PLAN 7.B): a vacant room is ready when every dimension the property checks passes.
 * Deterministic (rule 11); each dimension says why it fails so the board can show it.
 */

export const READINESS_DIMENSIONS = [
  'HOUSEKEEPING',
  'INSPECTION',
  'ENGINEERING',
  'NO_OOO',
] as const;
export type ReadinessDimension = (typeof READINESS_DIMENSIONS)[number];
export type DimensionResult = 'PASS' | 'FAIL' | 'UNKNOWN';
export type ReadinessReason =
  'NOT_CLEAN' | 'NOT_INSPECTED' | 'OPEN_ENGINEERING_WORK' | 'ENGINEERING_UNKNOWN' | 'OUT_OF_ORDER';

export interface ReadinessInput {
  readonly occupancy: 'VACANT' | 'OCCUPIED';
  readonly housekeeping: string;
  readonly frontOffice: string | null;
  /** Open engineering work at the room; null when it could not be looked up. */
  readonly openEngineeringWork: number | null;
}

export interface Readiness {
  readonly ready: boolean;
  readonly occupied: boolean;
  readonly dimensions: ReadonlyArray<{
    readonly dimension: ReadinessDimension;
    readonly result: DimensionResult;
    readonly reason: ReadinessReason | null;
  }>;
}

const CLEAN = new Set(['CLEAN', 'INSPECTED']);

function check(
  dimension: ReadinessDimension,
  input: ReadinessInput,
): { result: DimensionResult; reason: ReadinessReason | null } {
  switch (dimension) {
    case 'HOUSEKEEPING':
      return CLEAN.has(input.housekeeping)
        ? { result: 'PASS', reason: null }
        : { result: 'FAIL', reason: 'NOT_CLEAN' };
    case 'INSPECTION':
      return input.housekeeping === 'INSPECTED'
        ? { result: 'PASS', reason: null }
        : { result: 'FAIL', reason: 'NOT_INSPECTED' };
    case 'ENGINEERING':
      if (input.openEngineeringWork === null)
        return { result: 'UNKNOWN', reason: 'ENGINEERING_UNKNOWN' };
      return input.openEngineeringWork === 0
        ? { result: 'PASS', reason: null }
        : { result: 'FAIL', reason: 'OPEN_ENGINEERING_WORK' };
    case 'NO_OOO':
      return input.frontOffice === null
        ? { result: 'PASS', reason: null }
        : { result: 'FAIL', reason: 'OUT_OF_ORDER' };
  }
}

/** UNKNOWN never counts as ready: the platform does not claim what it could not check. */
export function evaluateReadiness(
  dimensions: readonly ReadinessDimension[],
  input: ReadinessInput,
): Readiness {
  const results = [...new Set(dimensions)].map((dimension) => ({
    dimension,
    ...check(dimension, input),
  }));
  const occupied = input.occupancy === 'OCCUPIED';
  return {
    ready: !occupied && results.every((r) => r.result === 'PASS'),
    occupied,
    dimensions: results,
  };
}
