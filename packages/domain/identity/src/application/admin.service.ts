import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { ENTITLEMENT_API, type EntitlementPublicApi } from '@hotella/domain-licensing/public';
import { MembershipChanged, RolePermissionsChanged, UserCreated } from '@hotella/contracts-events';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { ActionGate, ActorStore, type RequestActor } from '@hotella/platform-auth';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { newId, type TenantScope, TransactionRunner } from '@hotella/platform-database';
import { AuditWriter } from '@hotella/platform-audit';
import { EventPublisher } from '@hotella/platform-events';
import { AppError, CurrentLocale, I18nService } from '@hotella/platform-i18n';
import { missingForDelegation } from '../domain/access';
import { SYSTEM_ROLES } from '../domain/system-roles';
import { generateOpaqueToken, sha256Hex } from '../domain/tokens';
import { IdentityRepositories } from '../infrastructure/repositories';
import type { MembershipRow, PersonRow, RoleRow, UserRow } from '../infrastructure/schema';
import { MembershipPermissionResolver } from '../auth/permission-resolver';
import { AuthService } from './auth.service';
import type { CreateRoleInput, CreateUserInput, MembershipGrantInput } from './dto';

const PLATFORM_ONLY_ROLES = new Set(
  SYSTEM_ROLES.filter((r) => r.audience === 'PLATFORM').map((r) => r.code),
);

export interface RoleView {
  id: string;
  code: string;
  isSystem: boolean;
  name: string;
  description: string | null;
  permissions: string[];
}
export interface MembershipView {
  id: string;
  tenantId: string;
  propertyId: string | null;
  status: MembershipRow['status'];
  roles: Array<{ id: string; code: string; name: string }>;
}
export interface UserView {
  id: string;
  tenantId: string | null;
  email: string;
  status: UserRow['status'];
  isPlatformAdmin: boolean;
  mfaEnabled: boolean;
  lastLoginAt: Date | null;
  givenName: string;
  familyName: string | null;
  localePref: string | null;
}

export function toUserView(user: UserRow, person: PersonRow): UserView {
  return {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    status: user.status,
    isPlatformAdmin: user.isPlatformAdmin,
    mfaEnabled: user.mfaEnabled,
    lastLoginAt: user.lastLoginAt,
    givenName: person.givenName,
    familyName: person.familyName,
    localePref: person.localePref,
  };
}

/** Localized role names: requested locale → en → code. */
export async function localizeRoles(
  repo: IdentityRepositories,
  roles: readonly RoleRow[],
  locale: string,
): Promise<Map<string, { name: string; description: string | null }>> {
  const rows = await repo.roleTranslationsFor(roles.map((r) => r.id));
  const out = new Map<string, { name: string; description: string | null }>();
  for (const role of roles) {
    const mine = rows.filter((t) => t.entityId === role.id);
    const t = mine.find((x) => x.locale === locale) ?? mine.find((x) => x.locale === 'en');
    out.set(role.id, { name: t?.name ?? role.code, description: t?.description ?? null });
  }
  return out;
}

/** Tenant administration of staff identities (Spec §5). Every mutation goes through the ActionGate. */
@Injectable()
export class IdentityAdminService {
  constructor(
    private readonly repo: IdentityRepositories,
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
    private readonly tx: TransactionRunner,
    private readonly events: EventPublisher,
    private readonly resolver: MembershipPermissionResolver,
    private readonly auth: AuthService,
    private readonly locale: CurrentLocale,
    private readonly i18n: I18nService,
    private readonly audit: AuditWriter,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional()
    @Inject(ENTITLEMENT_API)
    private readonly entitlements?: EntitlementPublicApi,
  ) {}

  // ---------- users ----------
  createUser(
    scope: TenantScope,
    input: CreateUserInput,
  ): Promise<{
    user: UserView;
    memberships: MembershipView[];
    invitation: { token: string; expiresAt: string };
  }> {
    return this.gate.execute({ action: 'iam.user.manage', tenantId: scope.tenantId }, () =>
      this.tx.run(async () => {
        const actor = this.actors.require();
        if (await this.repo.userByLogin(scope.tenantId, input.email))
          throw AppError.conflict('iam.user.email_taken');
        // A HARD licence limit on staff stops the account that would cross it (Spec §61).
        await this.entitlements?.assertWithinLimit({
          tenantId: scope.tenantId,
          propertyId: null,
          metric: 'ACTIVE_STAFF',
          current: await this.repo.countLiveStaff(scope),
        });
        const person = await this.repo.insertPerson({
          id: newId(),
          tenantId: scope.tenantId,
          givenName: input.givenName,
          familyName: input.familyName ?? null,
          email: input.email,
          phone: input.phone ?? null,
          localePref: input.localePref ?? null,
        });
        const user = await this.repo.insertUser({
          id: newId(),
          tenantId: scope.tenantId,
          personId: person.id,
          email: input.email,
          status: 'INVITED',
        });
        const token = generateOpaqueToken('inv');
        const expiresAt = new Date(Date.now() + this.config.iam.inviteTtlHours * 3_600_000);
        await this.repo.insertInvitation({
          id: newId(),
          tenantId: scope.tenantId,
          userId: user.id,
          tokenHash: sha256Hex(token),
          expiresAt,
          createdBy: actor.id,
        });
        await this.events.publish(UserCreated, {
          tenantId: scope.tenantId,
          source: 'iam',
          aggregate: { type: 'user', id: user.id },
          payload: {
            user_id: user.id,
            tenant_id: scope.tenantId,
            status: 'INVITED',
            is_platform_admin: false,
          },
        });
        await this.audit.record({
          action: 'iam.user.create',
          entityType: 'user',
          entityId: user.id,
          tenantId: scope.tenantId,
          after: { ...toUserView(user, person), invitationExpiresAt: expiresAt },
        });
        const memberships: MembershipView[] = [];
        for (const grant of input.memberships)
          memberships.push(await this.applyGrant(scope, user.id, grant, actor));
        // The invitation link is shown once to the inviting admin; e-mail/WhatsApp delivery arrives with comms (Phase 5).
        return {
          user: toUserView(user, person),
          memberships,
          invitation: { token, expiresAt: expiresAt.toISOString() },
        };
      }),
    );
  }

  async listUsers(scope: TenantScope): Promise<UserView[]> {
    return (await this.repo.listUsers(scope)).map(({ user, person }) => toUserView(user, person));
  }

  async getUser(
    scope: TenantScope,
    userId: string,
  ): Promise<UserView & { memberships: MembershipView[] }> {
    const user = await this.repo.userInTenant(scope, userId);
    if (!user) throw AppError.notFound('iam.user.not_found');
    const person = await this.repo.personById(user.personId);
    return {
      ...toUserView(user, person!),
      memberships: await this.membershipViews(user.id, scope.tenantId),
    };
  }

  setStatus(scope: TenantScope, userId: string, status: 'ACTIVE' | 'DISABLED'): Promise<UserView> {
    return this.gate.execute({ action: 'iam.user.manage', tenantId: scope.tenantId }, () =>
      this.tx.run(async () => {
        const actor = this.actors.require();
        const user = await this.repo.userInTenant(scope, userId);
        if (!user) throw AppError.notFound('iam.user.not_found');
        if (user.id === actor.id && status === 'DISABLED')
          throw new AppError('iam.user.cannot_disable_self', HttpStatus.UNPROCESSABLE_ENTITY);
        const next = status === 'DISABLED' ? 'DISABLED' : user.passwordHash ? 'ACTIVE' : 'INVITED';
        const updated = await this.repo.updateUser(user.id, { status: next });
        if (next === 'DISABLED') {
          const now = new Date();
          for (const sid of await this.repo.liveSessionIds(user.id))
            await this.auth.revoke(sid, user.id, 'USER_DISABLED', now);
        }
        await this.audit.record({
          action: 'iam.user.status_change',
          entityType: 'user',
          entityId: user.id,
          tenantId: scope.tenantId,
          before: { status: user.status },
          after: { status: next },
        });
        const person = await this.repo.personById(user.personId);
        return toUserView(updated, person!);
      }),
    );
  }

  // ---------- memberships ----------
  grantMembership(
    scope: TenantScope,
    userId: string,
    grant: MembershipGrantInput,
  ): Promise<MembershipView> {
    return this.gate.execute(
      {
        action: 'iam.membership.manage',
        tenantId: scope.tenantId,
        propertyId: grant.propertyId ?? null,
      },
      () =>
        this.tx.run(async () => {
          const user = await this.repo.userInTenant(scope, userId);
          if (!user) throw AppError.notFound('iam.user.not_found');
          return this.applyGrant(scope, user.id, grant, this.actors.require());
        }),
    );
  }

  async replaceMembershipRoles(
    scope: TenantScope,
    membershipId: string,
    roleCodes: readonly string[],
  ): Promise<MembershipView> {
    const membership = await this.repo.membershipById(scope, membershipId);
    if (!membership) throw AppError.notFound('iam.membership.not_found');
    return this.gate.execute(
      {
        action: 'iam.membership.manage',
        tenantId: scope.tenantId,
        propertyId: membership.propertyId,
      },
      () =>
        this.tx.run(async () => {
          const actor = this.actors.require();
          const roles = await this.assignableRoles(scope, roleCodes, membership.propertyId, actor);
          const previous =
            (await this.repo.roleCodesByMembership([membership.id])).get(membership.id) ?? [];
          await this.repo.replaceMembershipRoles(
            membership.id,
            roles.map((r) => r.id),
            actor.id,
          );
          const updated = await this.repo.updateMembership(scope, membership.id, {
            status: 'ACTIVE',
          });
          await this.publishMembership(updated, roles);
          await this.audit.record({
            action: 'iam.membership.roles_change',
            entityType: 'membership',
            entityId: membership.id,
            tenantId: scope.tenantId,
            propertyId: membership.propertyId,
            before: { status: membership.status, roles: previous.map((r) => r.code).sort() },
            after: { status: updated.status, roles: roles.map((r) => r.code).sort() },
          });
          return this.membershipView(updated, roles);
        }),
    );
  }

  async deactivateMembership(scope: TenantScope, membershipId: string): Promise<MembershipView> {
    const membership = await this.repo.membershipById(scope, membershipId);
    if (!membership) throw AppError.notFound('iam.membership.not_found');
    return this.gate.execute(
      {
        action: 'iam.membership.manage',
        tenantId: scope.tenantId,
        propertyId: membership.propertyId,
      },
      () =>
        this.tx.run(async () => {
          // Roles stay attached for history; an INACTIVE membership grants nothing.
          const updated = await this.repo.updateMembership(scope, membership.id, {
            status: 'INACTIVE',
          });
          const roles =
            (await this.repo.roleCodesByMembership([membership.id])).get(membership.id) ?? [];
          await this.publishMembership(updated, roles);
          await this.audit.record({
            action: 'iam.membership.deactivate',
            entityType: 'membership',
            entityId: membership.id,
            tenantId: scope.tenantId,
            propertyId: membership.propertyId,
            before: { status: membership.status },
            after: { status: updated.status },
          });
          return this.membershipView(updated, roles);
        }),
    );
  }

  // ---------- roles & permissions ----------
  async listRoles(scope: TenantScope): Promise<RoleView[]> {
    const roles = await this.repo.rolesVisibleTo(scope);
    const visible = roles.filter((r) => r.tenantId !== null || !PLATFORM_ONLY_ROLES.has(r.code));
    const [names, perms] = await Promise.all([
      localizeRoles(this.repo, visible, this.locale.get()),
      this.repo.rolePermissionCodes(visible.map((r) => r.id)),
    ]);
    return visible.map((r) => ({
      id: r.id,
      code: r.code,
      isSystem: r.isSystem,
      name: names.get(r.id)!.name,
      description: names.get(r.id)!.description,
      permissions: (perms.get(r.id) ?? []).sort(),
    }));
  }

  createRole(scope: TenantScope, input: CreateRoleInput): Promise<RoleView> {
    return this.gate.execute({ action: 'iam.role.manage', tenantId: scope.tenantId }, () =>
      this.tx.run(async () => {
        const actor = this.actors.require();
        if ((await this.repo.rolesByCodes(scope, [input.code])).length > 0)
          throw AppError.conflict('iam.role.code_taken', { code: input.code });
        await this.assertPermissionsGrantable(input.permissions, scope, null, actor);
        const role = await this.repo.insertRole({
          id: newId(),
          tenantId: scope.tenantId,
          code: input.code,
          isSystem: false,
        });
        await this.repo.upsertRoleTranslations(role.id, input.translations);
        const { added } = await this.repo.replaceRolePermissions(role.id, input.permissions);
        await this.events.publish(RolePermissionsChanged, {
          tenantId: scope.tenantId,
          source: 'iam',
          aggregate: { type: 'role', id: role.id },
          payload: {
            role_id: role.id,
            tenant_id: scope.tenantId,
            code: role.code,
            added,
            removed: [],
          },
        });
        await this.audit.record({
          action: 'iam.role.create',
          entityType: 'role',
          entityId: role.id,
          tenantId: scope.tenantId,
          after: {
            code: role.code,
            permissions: [...input.permissions].sort(),
            translations: input.translations,
          },
        });
        return (await this.listRoles(scope)).find((r) => r.id === role.id)!;
      }),
    );
  }

  replaceRolePermissions(
    scope: TenantScope,
    roleId: string,
    permissions: readonly string[],
  ): Promise<RoleView> {
    return this.gate.execute({ action: 'iam.role.manage', tenantId: scope.tenantId }, () =>
      this.tx.run(async () => {
        const role = await this.repo.roleVisibleById(scope, roleId);
        if (!role) throw AppError.notFound('iam.role.not_found');
        if (role.isSystem || role.tenantId === null)
          throw new AppError('iam.role.system_immutable', HttpStatus.UNPROCESSABLE_ENTITY);
        await this.assertPermissionsGrantable(permissions, scope, null, this.actors.require());
        const { added, removed } = await this.repo.replaceRolePermissions(role.id, permissions);
        await this.events.publish(RolePermissionsChanged, {
          tenantId: scope.tenantId,
          source: 'iam',
          aggregate: { type: 'role', id: role.id },
          payload: { role_id: role.id, tenant_id: scope.tenantId, code: role.code, added, removed },
        });
        await this.audit.record({
          action: 'iam.role.permissions_change',
          entityType: 'role',
          entityId: role.id,
          tenantId: scope.tenantId,
          before: { removed },
          after: { added },
        });
        return (await this.listRoles(scope)).find((r) => r.id === role.id)!;
      }),
    );
  }

  /** The platform permission catalog with localized descriptions (for role editors). */
  async permissionCatalog(): Promise<
    Array<{ code: string; module: string; risk: string; description: string }>
  > {
    const locale = this.locale.get();
    return (await this.repo.listPermissions()).map((p) => ({
      code: p.code,
      module: p.module,
      risk: p.risk,
      description: this.i18n.has(p.descriptionKey, locale)
        ? this.i18n.t(p.descriptionKey, {}, locale)
        : p.code,
    }));
  }

  // ---------- views ----------
  async membershipViews(userId: string, tenantId: string | null): Promise<MembershipView[]> {
    const memberships = (await this.repo.membershipsOfUser(userId)).filter(
      (m) => tenantId === null || m.tenantId === tenantId,
    );
    const roles = await this.repo.roleCodesByMembership(memberships.map((m) => m.id));
    const out: MembershipView[] = [];
    for (const m of memberships) out.push(await this.membershipView(m, roles.get(m.id) ?? []));
    return out;
  }

  private async membershipView(
    m: MembershipRow,
    roles: readonly RoleRow[],
  ): Promise<MembershipView> {
    const names = await localizeRoles(this.repo, roles, this.locale.get());
    return {
      id: m.id,
      tenantId: m.tenantId,
      propertyId: m.propertyId,
      status: m.status,
      roles: roles.map((r) => ({ id: r.id, code: r.code, name: names.get(r.id)!.name })),
    };
  }

  // ---------- rules ----------
  private async applyGrant(
    scope: TenantScope,
    userId: string,
    grant: MembershipGrantInput,
    actor: RequestActor,
  ): Promise<MembershipView> {
    const propertyId = grant.propertyId ?? null;
    if (propertyId && !(await this.org.getProperty(scope.tenantId, propertyId)))
      throw AppError.notFound('org.property.not_found');
    const roles = await this.assignableRoles(scope, grant.roleCodes, propertyId, actor);
    let membership = await this.repo.membershipByScope(scope, userId, propertyId);
    if (membership?.status === 'ACTIVE') throw AppError.conflict('iam.membership.exists');
    membership = membership
      ? await this.repo.updateMembership(scope, membership.id, { status: 'ACTIVE' })
      : await this.repo.insertMembership({
          id: newId(),
          tenantId: scope.tenantId,
          userId,
          propertyId,
          status: 'ACTIVE',
        });
    await this.repo.replaceMembershipRoles(
      membership.id,
      roles.map((r) => r.id),
      actor.id,
    );
    await this.publishMembership(membership, roles);
    await this.audit.record({
      action: 'iam.membership.grant',
      entityType: 'membership',
      entityId: membership.id,
      tenantId: scope.tenantId,
      propertyId,
      after: { userId, propertyId, roles: roles.map((r) => r.code).sort() },
    });
    return this.membershipView(membership, roles);
  }

  /** Roles must exist for this tenant, be tenant-assignable, and carry only permissions the actor may delegate. */
  private async assignableRoles(
    scope: TenantScope,
    codes: readonly string[],
    propertyId: string | null,
    actor: RequestActor,
  ): Promise<RoleRow[]> {
    const unique = [...new Set(codes)];
    const roles = await this.repo.rolesByCodes(scope, unique);
    // A tenant role shadows a system role of the same code only if the tenant defined it (codes are unique per tenant).
    const byCode = new Map<string, RoleRow>();
    for (const r of roles) if (!byCode.has(r.code) || r.tenantId) byCode.set(r.code, r);
    const missing = unique.filter((c) => !byCode.has(c));
    if (missing.length > 0)
      throw AppError.notFound('iam.role.not_found', { code: missing.join(', ') });
    const picked = unique.map((c) => byCode.get(c)!);
    if (picked.some((r) => r.tenantId === null && PLATFORM_ONLY_ROLES.has(r.code)))
      throw new AppError('iam.role.not_assignable', HttpStatus.UNPROCESSABLE_ENTITY);
    const perms = await this.repo.rolePermissionCodes(picked.map((r) => r.id));
    await this.assertPermissionsGrantable(
      picked.flatMap((r) => perms.get(r.id) ?? []),
      scope,
      propertyId,
      actor,
    );
    return picked;
  }

  /**
   * Anti-escalation (Spec §5): tenant staff may only delegate permissions they hold in that scope. Platform admins
   * are exempt — they onboard tenants (e.g. appoint the first General Manager) and are themselves audited.
   */
  private async assertPermissionsGrantable(
    requested: readonly string[],
    scope: TenantScope,
    propertyId: string | null,
    actor: RequestActor,
  ): Promise<void> {
    const catalog = new Set((await this.repo.listPermissions()).map((p) => p.code));
    const unknown = [...new Set(requested)].filter((p) => !catalog.has(p));
    if (unknown.length > 0)
      throw new AppError('iam.role.unknown_permission', HttpStatus.UNPROCESSABLE_ENTITY, {
        code: unknown.join(', '),
      });
    if (actor.isPlatformAdmin) return;
    const held = new Set(
      await this.resolver.permissionsFor(actor, { tenantId: scope.tenantId, propertyId }),
    );
    const lacking = missingForDelegation(held, requested);
    if (lacking.length > 0)
      throw AppError.forbidden('iam.role.cannot_delegate', { permission: lacking.join(', ') });
  }

  private async publishMembership(m: MembershipRow, roles: readonly RoleRow[]): Promise<void> {
    await this.events.publish(MembershipChanged, {
      tenantId: m.tenantId,
      propertyId: m.propertyId,
      source: 'iam',
      aggregate: { type: 'membership', id: m.id },
      payload: {
        membership_id: m.id,
        user_id: m.userId,
        tenant_id: m.tenantId,
        property_id: m.propertyId,
        status: m.status,
        role_codes: roles.map((r) => r.code).sort(),
      },
    });
  }
}
