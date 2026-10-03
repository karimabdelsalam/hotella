/** The ONLY surface other bounded contexts may import from this package (ADR-0001). */

/** What other contexts may ask of Lost & Found (the shift handover). */
export interface LostFoundPublicApi {
  /** Counts of open items at a property: found items waiting, lost reports open, matches to decide, items past retention. */
  openCounts(
    tenantId: string,
    propertyId: string,
  ): Promise<{
    readonly found: number;
    readonly lost: number;
    readonly proposedMatches: number;
    readonly retentionDue: number;
  }>;
}

/** Registered symbol: stays identical even if a bundler or test runner loads this entry twice. */
export const LOSTFOUND_API = Symbol.for('hotella.domain.lostfound.api');

export { LOSTFOUND_MANIFEST } from '../manifest';
