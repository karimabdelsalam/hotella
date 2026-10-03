import { Injectable } from '@nestjs/common';
import type { PermissionResolver, PermissionScope, RequestActor } from '@hotella/platform-auth';
import { effectivePermissions, hasPermission, type MembershipGrant } from '../domain/access';
import { PLATFORM_ADMIN_ROLE } from '../domain/system-roles';
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

  constructor(private readonly repo: IdentityRepositories) {}

  async hasPermission(
    actor: RequestActor,
    permission: string,
    scope: PermissionScope,
  ): Promise<boolean> {
    if (actor.isPlatformAdmin) return (await this.platformAdminPermissions()).has(permission);
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

  invalidate(): void {
    this.platformAdmin = null;
  }
}
