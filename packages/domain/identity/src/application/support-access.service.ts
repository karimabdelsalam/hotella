import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { newId, type TenantScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { MembershipPermissionResolver } from '../auth/permission-resolver';
import { grantIsActive } from '../domain/access';
import { IdentityRepositories } from '../infrastructure/repositories';
import type { SupportAccessGrantRow } from '../infrastructure/schema';
import type { SupportAccessRequestInput } from './dto';

export type SupportGrantStatus = 'PENDING' | 'ACTIVE' | 'EXPIRED' | 'REVOKED';

export interface SupportGrantView extends SupportAccessGrantRow {
  status: SupportGrantStatus;
}

export function supportGrantStatus(g: SupportAccessGrantRow, now: Date): SupportGrantStatus {
  if (g.revokedAt) return 'REVOKED';
  if (!g.approvedAt) return g.expiresAt <= now ? 'EXPIRED' : 'PENDING';
  return grantIsActive(g, now) ? 'ACTIVE' : 'EXPIRED';
}

/**
 * Spec §64 support access: explicit (requested with a reason), scoped (tenant or one property, listed permissions),
 * time-limited, read-only by default, approved by the hotel, revocable by either side, and audited end to end.
 */
@Injectable()
export class SupportAccessService {
  constructor(
    private readonly repo: IdentityRepositories,
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly resolver: MembershipPermissionResolver,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
  ) {}

  /** Platform support staff ask a tenant for access. */
  request(scope: TenantScope, input: SupportAccessRequestInput): Promise<SupportGrantView> {
    return this.gate.execute({ action: 'support.access.request', tenantId: null }, () =>
      this.tx.run(async () => {
        const actor = this.actors.require();
        if (actor.type !== 'SUPPORT')
          throw new AppError('iam.support.requester_not_support', HttpStatus.UNPROCESSABLE_ENTITY);
        if (!(await this.org.getTenant(scope.tenantId)))
          throw AppError.notFound('org.tenant.not_found');
        if (input.propertyId && !(await this.org.getProperty(scope.tenantId, input.propertyId)))
          throw AppError.notFound('org.property.not_found');
        const risk = await this.resolver.riskMap();
        const unknown = input.scopes.filter((p) => !risk.has(p));
        if (unknown.length > 0)
          throw new AppError('iam.role.unknown_permission', HttpStatus.UNPROCESSABLE_ENTITY, {
            code: unknown.join(', '),
          });
        if (input.readOnly && input.scopes.some((p) => risk.get(p) !== 'READ'))
          throw new AppError('iam.support.scope_not_read_only', HttpStatus.UNPROCESSABLE_ENTITY);
        const now = new Date();
        const row = await this.repo.insertSupportGrant({
          id: newId(),
          tenantId: scope.tenantId,
          propertyId: input.propertyId ?? null,
          grantedToUserId: actor.id,
          requestedBy: actor.id,
          reason: input.reason,
          scopes: [...new Set(input.scopes)].sort(),
          readOnly: input.readOnly,
          // The requested window; approval restarts it at the moment of approval with the same length.
          startsAt: now,
          expiresAt: new Date(now.getTime() + input.durationMinutes * 60_000),
        });
        await this.audit.record({
          action: 'iam.support_access.request',
          entityType: 'support_access_grant',
          entityId: row.id,
          tenantId: scope.tenantId,
          propertyId: row.propertyId,
          reason: input.reason,
          after: {
            scopes: row.scopes,
            readOnly: row.readOnly,
            durationMinutes: input.durationMinutes,
          },
        });
        return this.view(row);
      }),
    );
  }

  /** The hotel approves: the window starts now. Approval rights follow the grant's scope (property or tenant). */
  async approve(scope: TenantScope, grantId: string): Promise<SupportGrantView> {
    const grant = await this.requireGrant(scope, grantId);
    return this.gate.execute(
      { action: 'support.access.approve', tenantId: scope.tenantId, propertyId: grant.propertyId },
      () =>
        this.tx.run(async () => {
          const actor = this.actors.require();
          const now = new Date();
          if (supportGrantStatus(grant, now) !== 'PENDING')
            throw AppError.conflict('iam.support.not_pending');
          const length = grant.expiresAt.getTime() - grant.startsAt.getTime();
          const row = await this.repo.updateSupportGrant(scope, grant.id, grant.version, {
            approvedBy: actor.id,
            approvedAt: now,
            startsAt: now,
            expiresAt: new Date(now.getTime() + length),
          });
          if (!row) throw AppError.conflict('platform.conflict');
          await this.audit.record({
            action: 'iam.support_access.approve',
            entityType: 'support_access_grant',
            entityId: row.id,
            tenantId: scope.tenantId,
            propertyId: row.propertyId,
            approvalRef: row.id,
            after: { startsAt: row.startsAt, expiresAt: row.expiresAt, scopes: row.scopes },
          });
          return this.view(row);
        }),
    );
  }

  /** Either the hotel (approvers) or the support engineer holding the grant may end it at any time. */
  async revoke(
    scope: TenantScope,
    grantId: string,
    reason: string | null,
  ): Promise<SupportGrantView> {
    const grant = await this.requireGrant(scope, grantId);
    const actor = this.actors.require();
    const run = () =>
      this.tx.run(async () => {
        if (grant.revokedAt) return this.view(grant);
        const row = await this.repo.updateSupportGrant(scope, grant.id, grant.version, {
          revokedAt: new Date(),
          revokedBy: actor.id,
        });
        if (!row) throw AppError.conflict('platform.conflict');
        await this.audit.record({
          action: 'iam.support_access.revoke',
          entityType: 'support_access_grant',
          entityId: row.id,
          tenantId: scope.tenantId,
          propertyId: row.propertyId,
          reason,
        });
        return this.view(row);
      });
    if (actor.type === 'SUPPORT' && grant.grantedToUserId === actor.id) return run();
    return this.gate.execute(
      { action: 'support.access.approve', tenantId: scope.tenantId, propertyId: grant.propertyId },
      run,
    );
  }

  /** Hotel side: the grants this approver may decide on (tenant-wide approvers see all, property approvers theirs). */
  async listForTenant(scope: TenantScope): Promise<SupportGrantView[]> {
    const actor = this.actors.require();
    const out: SupportGrantView[] = [];
    for (const g of await this.repo.supportGrantsOfTenant(scope))
      if (
        await this.resolver.hasPermission(actor, 'support.access.approve', {
          tenantId: scope.tenantId,
          propertyId: g.propertyId,
        })
      )
        out.push(this.view(g));
    return out;
  }

  /** Support side: the caller's own grants across tenants. */
  async mine(): Promise<SupportGrantView[]> {
    const actor = this.actors.require();
    return (await this.repo.supportGrantsOfUser(actor.id)).map((g) => this.view(g));
  }

  private async requireGrant(scope: TenantScope, id: string): Promise<SupportAccessGrantRow> {
    const grant = await this.repo.supportGrantById(scope, id);
    if (!grant) throw AppError.notFound('iam.support.not_found');
    return grant;
  }

  private view(g: SupportAccessGrantRow): SupportGrantView {
    return { ...g, status: supportGrantStatus(g, new Date()) };
  }
}
