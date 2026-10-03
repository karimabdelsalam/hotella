import { applyDecorators, SetMetadata } from '@nestjs/common';

export const PUBLIC_KEY = 'hotella:auth:public';
export const PERMISSION_KEY = 'hotella:auth:permission';
export const PROPERTY_SCOPE_KEY = 'hotella:auth:property-scope';
export const TENANT_SCOPE_KEY = 'hotella:auth:tenant-scope';

/** No actor required (health, public branding, guest activation entry points). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

export const PERMISSION_CHECK_KEY = 'hotella:auth:permission-check';

export interface RequirePermissionOptions {
  /**
   * `guard` (default): checked before the handler for the scope named by the request.
   * `gate`: the scope is only known after loading the resource (e.g. a membership's property), so the guard only
   * requires authentication and the service's ActionGate checks this permission for the resource's scope.
   * The permission is declared either way (CLAUDE.md rule 4).
   */
  readonly checkedBy?: 'guard' | 'gate';
}

/** The actor must hold this permission in the resolved scope (Spec §5 granular permissions). */
export const RequirePermission = (
  permission: string,
  options: RequirePermissionOptions = {},
): MethodDecorator & ClassDecorator =>
  applyDecorators(
    SetMetadata(PERMISSION_KEY, permission),
    SetMetadata(PERMISSION_CHECK_KEY, options.checkedBy ?? 'guard'),
  );

export interface ScopeSource {
  /** Where to read the id: route param, query string or body field. Checked in that order when `from` is omitted. */
  readonly from?: 'param' | 'query' | 'body';
  readonly key?: string;
  /**
   * When the id is absent: property scope falls back to tenant scope; tenant scope falls back to the actor's own
   * tenant (tenant users only). Without `optional` a missing id is a 400.
   */
  readonly optional?: boolean;
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
