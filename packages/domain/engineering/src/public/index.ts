/** The ONLY surface other bounded contexts may import from this package (ADR-0001). */

export interface AssetSummary {
  readonly id: string;
  readonly propertyId: string;
  readonly assetNumber: string;
  readonly name: string;
  readonly assetTypeId: string;
  readonly assetModelId: string | null;
  readonly locationId: string;
  readonly status: 'ACTIVE' | 'OUT_OF_SERVICE' | 'RETIRED';
  readonly criticality: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly warrantyUntil: string | null;
}

/** What other contexts may ask of engineering (work orders from guest requests, readiness, the copilot). */
export interface EngineeringPublicApi {
  getAsset(tenantId: string, propertyId: string, assetId: string): Promise<AssetSummary | null>;
  /** Active assets at a location (e.g. the fan-coil unit of room 504). */
  assetsAtLocation(
    tenantId: string,
    propertyId: string,
    locationId: string,
  ): Promise<readonly AssetSummary[]>;
}

/** Registered symbol: stays identical even if a bundler or test runner loads this entry twice. */
export const ENGINEERING_API = Symbol.for('hotella.domain.engineering.api');

export { ENGINEERING_MANIFEST } from '../manifest';
