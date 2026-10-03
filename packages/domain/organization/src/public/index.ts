/** The ONLY surface other bounded contexts may import from this package (ADR-0001). */
import type { ResolvedBrand } from '../domain/branding';

export type { ResolvedBrand };
export interface PropertySummary {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string | null;
  readonly code: string;
  readonly name: string;
  readonly timezone: string;
  readonly currency: string;
  readonly defaultLocale: string;
  readonly enabledLocales: readonly string[];
  readonly status: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
}
export interface RoomSummary {
  readonly id: string;
  readonly propertyId: string;
  readonly roomNumber: string;
  readonly roomTypeId: string | null;
}

export interface OrganizationPublicApi {
  getProperty(tenantId: string, propertyId: string): Promise<PropertySummary | null>;
  listProperties(tenantId: string): Promise<readonly PropertySummary[]>;
  getRoomByNumber(
    tenantId: string,
    propertyId: string,
    roomNumber: string,
  ): Promise<RoomSummary | null>;
  resolveBranding(
    propertyId: string,
    channel: string | null,
    locale: string | null,
  ): Promise<ResolvedBrand>;
}
export const ORGANIZATION_API = Symbol('ORGANIZATION_API');

export { ORGANIZATION_MANIFEST } from '../manifest';
