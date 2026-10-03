/** The ONLY surface other bounded contexts may import from this package (ADR-0001). */

export interface InspectionSummary {
  readonly id: string;
  readonly propertyId: string;
  readonly number: number;
  readonly locationId: string;
  readonly assetId: string | null;
  readonly status: 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  readonly result: 'PASS' | 'FAIL' | null;
  readonly score: number | null;
  readonly completedAt: string | null;
  readonly source: 'STAFF' | 'SCHEDULE' | 'HK_JOB' | 'WORK_ORDER';
  readonly sourceRef: string | null;
}

/** What other contexts may ask of inspections (housekeeping's inspection step, readiness, arrival risk). */
export interface InspectionPublicApi {
  /** Null for an unknown inspection or one of another tenant. */
  getInspection(tenantId: string, inspectionId: string): Promise<InspectionSummary | null>;
  /** The most recently completed inspection at a place (a room), if any. */
  latestCompletedAt(
    tenantId: string,
    propertyId: string,
    locationId: string,
  ): Promise<InspectionSummary | null>;
}

/** Registered symbol: stays identical even if a bundler or test runner loads this entry twice. */
export const INSPECTION_API = Symbol.for('hotella.domain.inspection.api');

export { INSPECTION_MANIFEST } from '../manifest';
