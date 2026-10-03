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
  /** ISO 3166-1 alpha-2, when set (national phone numbers are read with it). */
  readonly country: string | null;
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

export interface LocationSummary {
  readonly id: string;
  readonly propertyId: string;
  readonly kind: string;
  readonly code: string;
  readonly status: 'ACTIVE' | 'INACTIVE';
}
export interface DepartmentSummary {
  readonly id: string;
  readonly propertyId: string;
  readonly code: string;
  readonly status: 'ACTIVE' | 'INACTIVE';
}

export interface TenantSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
  readonly defaultLocale: string;
}

export interface OrganizationPublicApi {
  /** Login and activation flows name a tenant by its stable code. */
  findTenantByCode(code: string): Promise<TenantSummary | null>;
  getTenant(tenantId: string): Promise<TenantSummary | null>;
  /** Owning tenant of a property (platform-level lookup; never exposes the property itself). */
  findPropertyTenant(propertyId: string): Promise<string | null>;
  getProperty(tenantId: string, propertyId: string): Promise<PropertySummary | null>;
  listProperties(tenantId: string): Promise<readonly PropertySummary[]>;
  getRoomByNumber(
    tenantId: string,
    propertyId: string,
    roomNumber: string,
  ): Promise<RoomSummary | null>;
  getRoom(tenantId: string, propertyId: string, roomId: string): Promise<RoomSummary | null>;
  listRooms(tenantId: string, propertyId: string): Promise<readonly RoomSummary[]>;
  /** Any location of the property (room, floor, outlet, back-of-house area…); null when not at this property. */
  getLocation(
    tenantId: string,
    propertyId: string,
    locationId: string,
  ): Promise<LocationSummary | null>;
  /** Department by its stable code at the property (codes are what operations store). */
  getDepartment(
    tenantId: string,
    propertyId: string,
    code: string,
  ): Promise<DepartmentSummary | null>;
  resolveBranding(
    propertyId: string,
    channel: string | null,
    locale: string | null,
  ): Promise<ResolvedBrand>;
}
/** Registered symbol: stays identical even if a bundler or test runner loads this entry twice. */
export const ORGANIZATION_API = Symbol.for('hotella.domain.organization.api');

export { ORGANIZATION_MANIFEST } from '../manifest';
