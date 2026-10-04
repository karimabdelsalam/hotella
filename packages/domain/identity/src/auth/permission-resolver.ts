import { Injectable } from '@nestjs/common';
import type { PermissionResolver, PermissionScope, RequestActor } from '@hotella/platform-auth';
import {
  effectivePermissions,
  hasPermission,
  type MembershipGrant,
  supportGrantAllows,
} from '../domain/access';
import { PLATFORM_ADMIN_ROLE, SUPPORT_ROLE } from '../domain/system-roles';
import { IdentityRepositories } from '../infrastructure/repositories';

const PLATFORM_CACHE_MS = 30_000;

/**
 * Membership → Role → Permission for the scope of the request (Spec §5). Tenant users: grants from ACTIVE memberships
 * in their tenant, tenant-wide or for exactly the requested property. Platform admins: the PLATFORM_ADMIN system
 * role's permissions in any tenant — which by design exclude guest and operational data (Spec §64).
 */
@Injectable()
export class MembershipPermissionResolver implements PermissionResolver {
  private platformAdmin: { codes: ReadonlySet<string>; at: number } | null = null;
  private support: { codes: ReadonlySet<string>; at: number } | null = null;
  private risks: { map: ReadonlyMap<string, string>; at: number } | null = null;

  constructor(private readonly repo: IdentityRepositories) {}

  async hasPermission(
    actor: RequestActor,
    permission: string,
    scope: PermissionScope,
  ): Promise<boolean> {
    if (actor.isPlatformAdmin) return (await this.platformAdminPermissions()).has(permission);
    if (actor.apiClient) return apiClientAllows(actor, permission, scope);
    if (actor.type === 'SUPPORT') return this.supportHas(actor, permission, scope);
    if (actor.type !== 'USER' || !actor.tenantId) return false;
    if (scope.tenantId && scope.tenantId !== actor.tenantId) return false;
    const grants = await this.grants(actor.id, actor.tenantId);
    return hasPermission(grants, permission, {
      tenantId: actor.tenantId,
      propertyId: scope.propertyId ?? null,
    });
  }

  async permissionsFor(actor: RequestActor, scope: PermissionScope): Promise<readonly string[]> {
    if (actor.isPlatformAdmin) return [...(await this.platformAdminPermissions())].sort();
    if (actor.apiClient)
      return actor.apiClient.scopes.filter((p) => apiClientAllows(actor, p, scope)).sort();
    if (actor.type === 'SUPPORT') {
      const own = await this.supportRolePermissions();
      if (!scope.tenantId) return [...own].sort();
      const grants = await this.repo.supportGrantsOfUser(actor.id, scope.tenantId);
      const risk = await this.riskMap();
      const out = new Set<string>();
      for (const g of grants)
        for (const p of g.scopes)
          if (
            supportGrantAllows(
              [g],
              p,
              { tenantId: scope.tenantId, propertyId: scope.propertyId ?? null },
              new Date(),
              (x) => risk.get(x),
            )
          )
            out.add(p);
      return [...out].sort();
    }
    if (actor.type !== 'USER' || !actor.tenantId) return [];
    if (scope.tenantId && scope.tenantId !== actor.tenantId) return [];
    return effectivePermissions(await this.grants(actor.id, actor.tenantId), {
      tenantId: actor.tenantId,
      propertyId: scope.propertyId ?? null,
    });
  }

  async grants(userId: string, tenantId: string): Promise<MembershipGrant[]> {
    const rows = await this.repo.grantsOf(userId, tenantId);
    const byMembership = new Map<
      string,
      { tenantId: string; propertyId: string | null; permissions: Set<string> }
    >();
    for (const r of rows) {
      const g = byMembership.get(r.membershipId) ?? {
        tenantId: r.tenantId,
        propertyId: r.propertyId,
        permissions: new Set<string>(),
      };
      g.permissions.add(r.permissionCode);
      byMembership.set(r.membershipId, g);
    }
    return [...byMembership.entries()].map(([membershipId, g]) => ({ membershipId, ...g }));
  }

  /** The PLATFORM_ADMIN role's permission set, cached briefly (it changes only with a deploy). */
  async platformAdminPermissions(): Promise<ReadonlySet<string>> {
    if (this.platformAdmin && Date.now() - this.platformAdmin.at < PLATFORM_CACHE_MS)
      return this.platformAdmin.codes;
    const role = await this.repo.systemRoleByCode(PLATFORM_ADMIN_ROLE);
    const codes = new Set(
      role ? ((await this.repo.rolePermissionCodes([role.id])).get(role.id) ?? []) : [],
    );
    this.platformAdmin = { codes, at: Date.now() };
    return codes;
  }

  /**
   * Spec §64: platform support staff hold only the SUPPORT role (request access) outside a tenant; inside a tenant
   * they act exclusively through an approved, unexpired, unrevoked grant for that scope.
   */
  private async supportHas(
    actor: RequestActor,
    permission: string,
    scope: PermissionScope,
  ): Promise<boolean> {
    if (!scope.tenantId) return (await this.supportRolePermissions()).has(permission);
    const grants = await this.repo.supportGrantsOfUser(actor.id, scope.tenantId);
    const risk = await this.riskMap();
    return supportGrantAllows(
      grants,
      permission,
      { tenantId: scope.tenantId, propertyId: scope.propertyId ?? null },
      new Date(),
      (p) => risk.get(p),
    );
  }

  private async supportRolePermissions(): Promise<ReadonlySet<string>> {
    if (this.support && Date.now() - this.support.at < PLATFORM_CACHE_MS) return this.support.codes;
    const role = await this.repo.systemRoleByCode(SUPPORT_ROLE);
    const codes = new Set(
      role ? ((await this.repo.rolePermissionCodes([role.id])).get(role.id) ?? []) : [],
    );
    this.support = { codes, at: Date.now() };
    return codes;
  }

  /** Permission → risk level, from the catalog (READ-only grants admit READ permissions only). */
  async riskMap(): Promise<ReadonlyMap<string, string>> {
    if (this.risks && Date.now() - this.risks.at < PLATFORM_CACHE_MS) return this.risks.map;
    const map = new Map((await this.repo.listPermissions()).map((p) => [p.code, p.risk as string]));
    this.risks = { map, at: Date.now() };
    return map;
  }

  invalidate(): void {
    this.platformAdmin = null;
    this.support = null;
    this.risks = null;
  }
}

/** An API client may use its scopes in its own tenant, and only at its property when bound to one (Spec §75). */
export function apiClientAllows(
  actor: RequestActor,
  permission: string,
  scope: PermissionScope,
): boolean {
  const client = actor.apiClient;
  if (!client || !actor.tenantId) return false;
  if (scope.tenantId && scope.tenantId !== actor.tenantId) return false;
  if (client.propertyId && scope.propertyId !== client.propertyId) return false;
  return client.scopes.includes(permission);
}
