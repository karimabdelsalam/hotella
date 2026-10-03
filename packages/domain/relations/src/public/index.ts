/** The ONLY surface other bounded contexts may import from this package (ADR-0001). */

/** What other contexts may ask of guest relations (the shift handover, arrival risk). */
export interface RelationsPublicApi {
  /** Open and in-progress complaints of a property, newest first (ids, numbers, codes; never the guest's words). */
  openComplaints(
    tenantId: string,
    propertyId: string,
  ): Promise<
    ReadonlyArray<{
      readonly id: string;
      readonly number: number;
      readonly categoryCode: string;
      readonly severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
      readonly status: 'OPEN' | 'IN_PROGRESS';
      readonly stayId: string | null;
      readonly openedAt: string;
    }>
  >;
}

/** Registered symbol: stays identical even if a bundler or test runner loads this entry twice. */
export const RELATIONS_API = Symbol.for('hotella.domain.relations.api');

export { RELATIONS_MANIFEST } from '../manifest';
