import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { DATABASE, type Database, executor, type TenantScope } from '@hotella/platform-database';
import {
  memberships,
  membershipRoles,
  permissions,
  persons,
  refreshTokens,
  rolePermissions,
  roles,
  roleTranslations,
  sessions,
  supportAccessGrants,
  userInvitations,
  users,
  type MembershipRow,
  type PermissionRow,
  type PersonRow,
  type RefreshTokenRow,
  type RoleRow,
  type SessionRow,
  type SupportAccessGrantRow,
  type UserRow,
} from './schema';

export interface GrantRow {
  membershipId: string;
  tenantId: string;
  propertyId: string | null;
  permissionCode: string;
}

/**
 * IAM persistence. Tenant-owned reads take a TenantScope; the few platform-level lookups (login by email for
 * platform staff, session checks by id, the permission catalog) are named as such.
 */
@Injectable()
export class IdentityRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- persons & users ----
  async insertPerson(values: typeof persons.$inferInsert): Promise<PersonRow> {
    const [row] = await this.x.insert(persons).values(values).returning();
    return row!;
  }
  async insertUser(values: typeof users.$inferInsert): Promise<UserRow> {
    const [row] = await this.x.insert(users).values(values).returning();
    return row!;
  }
  /** Login lookup: tenant users by (tenant, email); platform staff by email with tenant null. */
  /** Staff accounts that count against the licence (Spec §61 ACTIVE_STAFF): invited or active, not disabled. */
  async countLiveStaff(scope: TenantScope): Promise<number> {
    const [row] = await this.x
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.tenantId, scope.tenantId), sql`${users.status} <> 'DISABLED'`));
    return row?.n ?? 0;
  }
  userByLogin(tenantId: string | null, email: string): Promise<UserRow | undefined> {
    return this.x
      .select()
      .from(users)
      .where(
        and(
          tenantId ? eq(users.tenantId, tenantId) : isNull(users.tenantId),
          eq(users.email, email),
        ),
      )
      .then((r) => r[0]);
  }
  /** By id regardless of tenant — only for authenticated self-service and session checks. */
  userById(id: string): Promise<UserRow | undefined> {
    return this.x
      .select()
      .from(users)
      .where(eq(users.id, id))
      .then((r) => r[0]);
  }
  userInTenant(scope: TenantScope, id: string): Promise<UserRow | undefined> {
    return this.x
      .select()
      .from(users)
      .where(and(eq(users.tenantId, scope.tenantId), eq(users.id, id)))
      .then((r) => r[0]);
  }
  listUsers(scope: TenantScope): Promise<Array<{ user: UserRow; person: PersonRow }>> {
    return this.x
      .select({ user: users, person: persons })
      .from(users)
      .innerJoin(persons, eq(persons.id, users.personId))
      .where(eq(users.tenantId, scope.tenantId))
      .orderBy(asc(users.email));
  }
  personById(id: string): Promise<PersonRow | undefined> {
    return this.x
      .select()
      .from(persons)
      .where(eq(persons.id, id))
      .then((r) => r[0]);
  }
  async updateUser(id: string, values: Partial<typeof users.$inferInsert>): Promise<UserRow> {
    const [row] = await this.x
      .update(users)
      .set({ ...values, version: sql`${users.version} + 1` })
      .where(eq(users.id, id))
      .returning();
    return row!;
  }
  /** Atomic failure counter; returns the new count. */
  async recordLoginFailure(id: string): Promise<number> {
    const [row] = await this.x
      .update(users)
      .set({ failedLoginCount: sql`${users.failedLoginCount} + 1` })
      .where(eq(users.id, id))
      .returning({ count: users.failedLoginCount });
    return row?.count ?? 0;
  }
  /** Accepts a TOTP step only if it is newer than the last one (atomic replay guard). */
  async claimMfaStep(id: string, step: number): Promise<boolean> {
    const rows = await this.x
      .update(users)
      .set({ mfaLastStep: step })
      .where(
        and(
          eq(users.id, id),
          sql`(${users.mfaLastStep} IS NULL OR ${users.mfaLastStep} < ${step})`,
        ),
      )
      .returning({ id: users.id });
    return rows.length === 1;
  }

  // ---- invitations ----
  async insertInvitation(values: typeof userInvitations.$inferInsert): Promise<void> {
    await this.x.insert(userInvitations).values(values);
  }
  /** Claims a valid invitation exactly once. */
  async claimInvitation(tokenHash: string, now: Date): Promise<{ userId: string } | undefined> {
    const [row] = await this.x
      .update(userInvitations)
      .set({ acceptedAt: now })
      .where(
        and(
          eq(userInvitations.tokenHash, tokenHash),
          isNull(userInvitations.acceptedAt),
          gt(userInvitations.expiresAt, now),
        ),
      )
      .returning({ userId: userInvitations.userId });
    return row;
  }

  // ---- permission catalog & roles ----
  async upsertPermissions(rows: Array<typeof permissions.$inferInsert>): Promise<void> {
    if (rows.length === 0) return;
    await this.x
      .insert(permissions)
      .values(rows)
      .onConflictDoUpdate({
        target: permissions.code,
        set: {
          module: sql`excluded.module`,
          risk: sql`excluded.risk`,
          descriptionKey: sql`excluded.description_key`,
          updatedAt: sql`now()`,
        },
      });
  }
  listPermissions(): Promise<PermissionRow[]> {
    return this.x.select().from(permissions).orderBy(asc(permissions.code));
  }
  systemRoleByCode(code: string): Promise<RoleRow | undefined> {
    return this.x
      .select()
      .from(roles)
      .where(and(isNull(roles.tenantId), eq(roles.code, code)))
      .then((r) => r[0]);
  }
  async insertRole(values: typeof roles.$inferInsert): Promise<RoleRow> {
    const [row] = await this.x.insert(roles).values(values).returning();
    return row!;
  }
  /** System roles plus the tenant's own roles. */
  rolesVisibleTo(scope: TenantScope): Promise<RoleRow[]> {
    return this.x
      .select()
      .from(roles)
      .where(sql`${roles.tenantId} IS NULL OR ${roles.tenantId} = ${scope.tenantId}`)
      .orderBy(asc(roles.code));
  }
  rolesByCodes(scope: TenantScope, codes: readonly string[]): Promise<RoleRow[]> {
    if (codes.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(roles)
      .where(
        and(
          inArray(roles.code, [...codes]),
          sql`(${roles.tenantId} IS NULL OR ${roles.tenantId} = ${scope.tenantId})`,
        ),
      );
  }
  roleVisibleById(scope: TenantScope, id: string): Promise<RoleRow | undefined> {
    return this.x
      .select()
      .from(roles)
      .where(
        and(
          eq(roles.id, id),
          sql`(${roles.tenantId} IS NULL OR ${roles.tenantId} = ${scope.tenantId})`,
        ),
      )
      .then((r) => r[0]);
  }
  async rolePermissionCodes(roleIds: readonly string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (roleIds.length === 0) return out;
    const rows = await this.x
      .select()
      .from(rolePermissions)
      .where(inArray(rolePermissions.roleId, [...roleIds]));
    for (const r of rows) out.set(r.roleId, [...(out.get(r.roleId) ?? []), r.permissionCode]);
    return out;
  }
  /**
   * Replaces a role's permission set; returns what was added and removed. With `withinModules`, only permissions of
   * those modules are touched (a process that loads part of the platform never strips the rest).
   */
  async replaceRolePermissions(
    roleId: string,
    codes: readonly string[],
    withinModules?: ReadonlySet<string>,
  ): Promise<{ added: string[]; removed: string[] }> {
    const current = new Set((await this.rolePermissionCodes([roleId])).get(roleId) ?? []);
    const next = new Set(codes);
    const added = [...next].filter((c) => !current.has(c)).sort();
    let removed = [...current].filter((c) => !next.has(c)).sort();
    if (withinModules && removed.length > 0) {
      const owners = await this.x
        .select({ code: permissions.code, module: permissions.module })
        .from(permissions)
        .where(inArray(permissions.code, removed));
      const inScope = new Set(owners.filter((o) => withinModules.has(o.module)).map((o) => o.code));
      removed = removed.filter((c) => inScope.has(c));
    }
    if (removed.length > 0)
      await this.x
        .delete(rolePermissions)
        .where(
          and(eq(rolePermissions.roleId, roleId), inArray(rolePermissions.permissionCode, removed)),
        );
    if (added.length > 0)
      await this.x
        .insert(rolePermissions)
        .values(added.map((permissionCode) => ({ roleId, permissionCode })));
    return { added, removed };
  }
  async upsertRoleTranslations(
    roleId: string,
    rows: ReadonlyArray<{ locale: string; name: string; description?: string | null }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.x
      .insert(roleTranslations)
      .values(
        rows.map((t) => ({
          entityId: roleId,
          locale: t.locale,
          name: t.name,
          description: t.description ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: [roleTranslations.entityId, roleTranslations.locale],
        set: {
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          updatedAt: sql`now()`,
        },
      });
  }
  roleTranslationsFor(
    roleIds: readonly string[],
  ): Promise<
    Array<{ entityId: string; locale: string; name: string; description: string | null }>
  > {
    if (roleIds.length === 0) return Promise.resolve([]);
    return this.x
      .select({
        entityId: roleTranslations.entityId,
        locale: roleTranslations.locale,
        name: roleTranslations.name,
        description: roleTranslations.description,
      })
      .from(roleTranslations)
      .where(inArray(roleTranslations.entityId, [...roleIds]));
  }

  // ---- memberships ----
  async insertMembership(values: typeof memberships.$inferInsert): Promise<MembershipRow> {
    const [row] = await this.x.insert(memberships).values(values).returning();
    return row!;
  }
  membershipByScope(
    scope: TenantScope,
    userId: string,
    propertyId: string | null,
  ): Promise<MembershipRow | undefined> {
    return this.x
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, scope.tenantId),
          eq(memberships.userId, userId),
          isNull(memberships.organizationId),
          propertyId ? eq(memberships.propertyId, propertyId) : isNull(memberships.propertyId),
        ),
      )
      .then((r) => r[0]);
  }
  membershipById(scope: TenantScope, id: string): Promise<MembershipRow | undefined> {
    return this.x
      .select()
      .from(memberships)
      .where(and(eq(memberships.tenantId, scope.tenantId), eq(memberships.id, id)))
      .then((r) => r[0]);
  }
  membershipsOfUser(userId: string): Promise<MembershipRow[]> {
    return this.x
      .select()
      .from(memberships)
      .where(eq(memberships.userId, userId))
      .orderBy(asc(memberships.createdAt));
  }
  async updateMembership(
    scope: TenantScope,
    id: string,
    values: Partial<typeof memberships.$inferInsert>,
  ): Promise<MembershipRow> {
    const [row] = await this.x
      .update(memberships)
      .set({ ...values, version: sql`${memberships.version} + 1` })
      .where(and(eq(memberships.tenantId, scope.tenantId), eq(memberships.id, id)))
      .returning();
    return row!;
  }
  async replaceMembershipRoles(
    membershipId: string,
    roleIds: readonly string[],
    grantedBy: string | null,
  ): Promise<void> {
    await this.x.delete(membershipRoles).where(eq(membershipRoles.membershipId, membershipId));
    if (roleIds.length > 0)
      await this.x
        .insert(membershipRoles)
        .values(roleIds.map((roleId) => ({ membershipId, roleId, grantedBy })));
  }
  async roleCodesByMembership(membershipIds: readonly string[]): Promise<Map<string, RoleRow[]>> {
    const out = new Map<string, RoleRow[]>();
    if (membershipIds.length === 0) return out;
    const rows = await this.x
      .select({ membershipId: membershipRoles.membershipId, role: roles })
      .from(membershipRoles)
      .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
      .where(inArray(membershipRoles.membershipId, [...membershipIds]));
    for (const r of rows) out.set(r.membershipId, [...(out.get(r.membershipId) ?? []), r.role]);
    return out;
  }
  /** Every (membership, permission) pair of the user's ACTIVE memberships in one tenant — the input of access rules. */
  grantsOf(userId: string, tenantId: string): Promise<GrantRow[]> {
    return this.x
      .select({
        membershipId: memberships.id,
        tenantId: memberships.tenantId,
        propertyId: memberships.propertyId,
        permissionCode: rolePermissions.permissionCode,
      })
      .from(memberships)
      .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, membershipRoles.roleId))
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.tenantId, tenantId),
          eq(memberships.status, 'ACTIVE'),
          isNull(memberships.organizationId),
        ),
      );
  }

  /** ACTIVE users with an ACTIVE membership (tenant-wide or at the property) whose roles grant the permission. */
  userIdsWithPermission(
    tenantId: string,
    propertyId: string,
    permission: string,
  ): Promise<string[]> {
    return this.x
      .selectDistinct({ id: users.id })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, membershipRoles.roleId))
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.status, 'ACTIVE'),
          isNull(memberships.organizationId),
          sql`(${memberships.propertyId} IS NULL OR ${memberships.propertyId} = ${propertyId})`,
          eq(rolePermissions.permissionCode, permission),
          eq(users.status, 'ACTIVE'),
        ),
      )
      .then((r) => r.map((x) => x.id));
  }

  /** Active users holding a role (system or tenant role, by code) at a property or tenant-wide. */
  userIdsWithRole(tenantId: string, propertyId: string, roleCode: string): Promise<string[]> {
    return this.x
      .selectDistinct({ id: users.id })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
      .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.status, 'ACTIVE'),
          isNull(memberships.organizationId),
          sql`(${memberships.propertyId} IS NULL OR ${memberships.propertyId} = ${propertyId})`,
          eq(roles.code, roleCode),
          sql`(${roles.tenantId} IS NULL OR ${roles.tenantId} = ${tenantId})`,
          eq(users.status, 'ACTIVE'),
        ),
      )
      .then((r) => r.map((x) => x.id));
  }

  // ---- support access grants (Spec §64) ----
  async insertSupportGrant(
    values: typeof supportAccessGrants.$inferInsert,
  ): Promise<SupportAccessGrantRow> {
    const [row] = await this.x.insert(supportAccessGrants).values(values).returning();
    return row!;
  }
  supportGrantById(scope: TenantScope, id: string): Promise<SupportAccessGrantRow | undefined> {
    return this.x
      .select()
      .from(supportAccessGrants)
      .where(and(eq(supportAccessGrants.tenantId, scope.tenantId), eq(supportAccessGrants.id, id)))
      .then((r) => r[0]);
  }
  supportGrantsOfTenant(scope: TenantScope): Promise<SupportAccessGrantRow[]> {
    return this.x
      .select()
      .from(supportAccessGrants)
      .where(eq(supportAccessGrants.tenantId, scope.tenantId))
      .orderBy(asc(supportAccessGrants.createdAt));
  }
  /** Grants held by a support user (all tenants) — the requester's own view and the resolver's input. */
  supportGrantsOfUser(userId: string, tenantId?: string): Promise<SupportAccessGrantRow[]> {
    return this.x
      .select()
      .from(supportAccessGrants)
      .where(
        and(
          eq(supportAccessGrants.grantedToUserId, userId),
          tenantId ? eq(supportAccessGrants.tenantId, tenantId) : undefined,
        ),
      )
      .orderBy(asc(supportAccessGrants.createdAt));
  }
  async updateSupportGrant(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: Partial<typeof supportAccessGrants.$inferInsert>,
  ): Promise<SupportAccessGrantRow | undefined> {
    const [row] = await this.x
      .update(supportAccessGrants)
      .set({ ...values, version: sql`${supportAccessGrants.version} + 1` })
      .where(
        and(
          eq(supportAccessGrants.tenantId, scope.tenantId),
          eq(supportAccessGrants.id, id),
          eq(supportAccessGrants.version, expectedVersion),
        ),
      )
      .returning();
    return row;
  }

  // ---- sessions & refresh tokens ----
  async insertSession(values: typeof sessions.$inferInsert): Promise<SessionRow> {
    const [row] = await this.x.insert(sessions).values(values).returning();
    return row!;
  }
  /** The per-request check behind every access token: session live and user ACTIVE. */
  liveSession(
    sessionId: string,
    now: Date,
  ): Promise<{ session: SessionRow; user: UserRow; person: PersonRow } | undefined> {
    return this.x
      .select({ session: sessions, user: users, person: persons })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .innerJoin(persons, eq(persons.id, users.personId))
      .where(
        and(
          eq(sessions.id, sessionId),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
          eq(users.status, 'ACTIVE'),
        ),
      )
      .then((r) => r[0]);
  }
  sessionById(id: string): Promise<SessionRow | undefined> {
    return this.x
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .then((r) => r[0]);
  }
  async revokeSession(id: string, reason: string, now: Date): Promise<boolean> {
    const rows = await this.x
      .update(sessions)
      .set({ revokedAt: now, revokeReason: reason })
      .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return rows.length === 1;
  }
  liveSessionIds(userId: string): Promise<string[]> {
    return this.x
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .then((r) => r.map((x) => x.id));
  }
  async touchSession(id: string, now: Date): Promise<void> {
    await this.x.update(sessions).set({ lastUsedAt: now }).where(eq(sessions.id, id));
  }
  async insertRefreshToken(values: typeof refreshTokens.$inferInsert): Promise<void> {
    await this.x.insert(refreshTokens).values(values);
  }
  refreshTokenByHash(hash: string): Promise<RefreshTokenRow | undefined> {
    return this.x
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hash))
      .then((r) => r[0]);
  }
  /** Marks a refresh token used exactly once; false means it was already used (reuse → revoke the family). */
  async claimRefreshToken(id: string, replacedById: string, now: Date): Promise<boolean> {
    const rows = await this.x
      .update(refreshTokens)
      .set({ usedAt: now, replacedById })
      .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.usedAt)))
      .returning({ id: refreshTokens.id });
    return rows.length === 1;
  }
}
