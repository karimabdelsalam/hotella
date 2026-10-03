import { SetMetadata } from '@nestjs/common';

export const PUBLIC_KEY = 'hotella:auth:public';
export const PERMISSION_KEY = 'hotella:auth:permission';
export const PROPERTY_SCOPE_KEY = 'hotella:auth:property-scope';
export const TENANT_SCOPE_KEY = 'hotella:auth:tenant-scope';

/** No actor required (health, public branding, guest activation entry points). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

/** The actor must hold this permission in the resolved scope (Spec §5 granular permissions). */
export const RequirePermission = (permission: string): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION_KEY, permission);

export interface ScopeSource {
  /** Where to read the id: route param, query string or body field. Checked in that order when `from` is omitted. */
  readonly from?: 'param' | 'query' | 'body';
  readonly key?: string;
}

/** The route acts on one property; its id is read from the request and the permission is checked for that property. */
export const PropertyScoped = (source: ScopeSource = {}): MethodDecorator & ClassDecorator =>
  SetMetadata(PROPERTY_SCOPE_KEY, { key: 'propertyId', ...source });

/**
 * The route acts on a tenant named in the request (platform-admin routes such as /tenants/:tenantId/…).
 * Tenant users may only name their own tenant.
 */
export const TenantScoped = (source: ScopeSource = {}): MethodDecorator & ClassDecorator =>
  SetMetadata(TENANT_SCOPE_KEY, { key: 'tenantId', ...source });
