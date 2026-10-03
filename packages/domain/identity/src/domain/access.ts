/**
 * Effective-permission rules (Spec §5): Membership → Role → Permission, evaluated for the scope of the request.
 * Pure functions so the rules are unit-tested without a database.
 */
export interface MembershipGrant {
  readonly membershipId: string;
  readonly tenantId: string;
  /** null = tenant-wide. Organization-scoped memberships are reserved (column exists; not granted in Phase 1). */
  readonly propertyId: string | null;
  readonly permissions: ReadonlySet<string>;
}

export interface AccessScope {
  readonly tenantId: string | null;
  readonly propertyId: string | null;
}

/** Grants that apply to the scope: same tenant, and either tenant-wide or for exactly this property. */
export function applicableGrants(
  grants: readonly MembershipGrant[],
  scope: AccessScope,
): MembershipGrant[] {
  if (!scope.tenantId) return [];
  return grants.filter(
    (g) =>
      g.tenantId === scope.tenantId &&
      (g.propertyId === null || (scope.propertyId !== null && g.propertyId === scope.propertyId)),
  );
}

export function hasPermission(
  grants: readonly MembershipGrant[],
  permission: string,
  scope: AccessScope,
): boolean {
  return applicableGrants(grants, scope).some((g) => g.permissions.has(permission));
}

export function effectivePermissions(
  grants: readonly MembershipGrant[],
  scope: AccessScope,
): string[] {
  const out = new Set<string>();
  for (const g of applicableGrants(grants, scope)) for (const p of g.permissions) out.add(p);
  return [...out].sort();
}

/**
 * Anti-escalation: an actor may grant a role (or build one) only if they hold every permission in it, in the
 * scope of the grant. Returns the permissions the actor lacks.
 */
export function missingForDelegation(
  actorPermissions: ReadonlySet<string>,
  requested: Iterable<string>,
): string[] {
  return [...new Set(requested)].filter((p) => !actorPermissions.has(p)).sort();
}

/** Platform staff without the administrator flag act as SUPPORT (Spec §64); everyone else is a USER. */
export function staffActorType(user: {
  readonly tenantId: string | null;
  readonly isPlatformAdmin: boolean;
}): 'USER' | 'SUPPORT' {
  return user.tenantId === null && !user.isPlatformAdmin ? 'SUPPORT' : 'USER';
}

/** An approved, time-boxed support grant (Spec §64) as the access rules see it. */
export interface SupportGrant {
  readonly tenantId: string;
  /** null = the whole tenant. */
  readonly propertyId: string | null;
  readonly scopes: readonly string[];
  readonly readOnly: boolean;
  readonly startsAt: Date;
  readonly expiresAt: Date;
  readonly approvedAt: Date | null;
  readonly revokedAt: Date | null;
}

export function grantIsActive(g: SupportGrant, now: Date): boolean {
  return !!g.approvedAt && !g.revokedAt && g.startsAt <= now && now < g.expiresAt;
}

/**
 * Support staff act only through an active grant for that tenant (and property, when the grant names one), only
 * with the permissions it lists, and — when read-only — only with READ-risk permissions.
 */
export function supportGrantAllows(
  grants: readonly SupportGrant[],
  permission: string,
  scope: AccessScope,
  now: Date,
  riskOf: (permission: string) => string | undefined,
): boolean {
  if (!scope.tenantId) return false;
  return grants.some(
    (g) =>
      grantIsActive(g, now) &&
      g.tenantId === scope.tenantId &&
      (g.propertyId === null || g.propertyId === scope.propertyId) &&
      g.scopes.includes(permission) &&
      (!g.readOnly || riskOf(permission) === 'READ'),
  );
}
