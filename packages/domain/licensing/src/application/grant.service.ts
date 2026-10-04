import { Inject, Injectable, Optional } from '@nestjs/common';
import { EntitlementsChanged } from '@hotella/contracts-events';
import { AuditWriter } from '@hotella/platform-audit';
import {
  ActionGate,
  ActorStore,
  PROPERTY_SCOPE_VERIFIER,
  type PropertyScopeVerifier,
} from '@hotella/platform-auth';
import { isUuid, newId, type TenantScope, TransactionRunner } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { CatalogRepositories } from '../infrastructure/repositories';
import type { EntitlementGrantRow, LimitOverrideRow } from '../infrastructure/schema';
import { TenantLicenseRepositories } from '../infrastructure/tenant-repositories';
import { EntitlementEngine } from './entitlement-engine';
import type { CreateGrantInput, CreateOverrideInput, RevokeInput } from './schemas';
import { foreignKey, unprocessable } from './subscription.service';

const GRANT = 'license.grant.manage';

/**
 * Capabilities and limits given outside a plan (Spec §59: tenant-wide and property-specific grants) — a trial, a
 * promotion, a negotiated extra. Each has a reason, is audited and is revoked, never deleted (rule 10).
 */
@Injectable()
export class GrantService {
  constructor(
    private readonly repo: TenantLicenseRepositories,
    private readonly catalog: CatalogRepositories,
    private readonly engine: EntitlementEngine,
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly events: EventPublisher,
    @Optional()
    @Inject(PROPERTY_SCOPE_VERIFIER)
    private readonly properties?: PropertyScopeVerifier | null,
  ) {}

  listGrants(scope: TenantScope) {
    return this.act('read', async () => (await this.repo.grants(scope)).map(grantView));
  }

  async createGrant(scope: TenantScope, input: CreateGrantInput) {
    const row = await this.act('write', async () => {
      const capability = (await this.catalog.capabilities()).find(
        (c) => c.code === input.capabilityCode,
      );
      if (!capability || capability.status !== 'ACTIVE')
        throw unprocessable('license.plan.unknown_capability', { code: input.capabilityCode });
      await this.requireProperty(scope, input.propertyId ?? null);
      const validFrom = input.validFrom ?? new Date();
      if (input.validUntil && input.validUntil <= validFrom)
        throw unprocessable('license.grant.period_invalid');
      const grant = await this.repo
        .insertGrant({
          id: newId(),
          tenantId: scope.tenantId,
          propertyId: input.propertyId ?? null,
          capabilityCode: input.capabilityCode,
          source: input.source,
          validFrom,
          validUntil: input.validUntil ?? null,
          reason: input.reason,
          grantedById: this.actorId(),
        })
        .catch((e: unknown) => {
          throw foreignKey(e);
        });
      await this.audit.record({
        action: 'license.grant.create',
        entityType: 'license_grant',
        entityId: grant.id,
        tenantId: scope.tenantId,
        propertyId: grant.propertyId,
        reason: input.reason,
        after: {
          capability: grant.capabilityCode,
          source: grant.source,
          valid_until: grant.validUntil?.toISOString() ?? null,
        },
      });
      await this.changed(scope, grant.propertyId, 'GRANT', grant.id);
      return grant;
    });
    this.engine.invalidate(scope.tenantId);
    return grantView(row);
  }

  async revokeGrant(scope: TenantScope, id: string, input: RevokeInput) {
    const row = await this.act('write', async () => {
      const current = isUuid(id) ? await this.repo.grant(scope, id) : undefined;
      if (!current) throw AppError.notFound('license.grant.not_found');
      const revoked = await this.repo.revokeGrant(scope, id, this.actorId(), input.reason);
      if (!revoked) throw AppError.conflict('license.grant.already_revoked');
      await this.audit.record({
        action: 'license.grant.revoke',
        entityType: 'license_grant',
        entityId: id,
        tenantId: scope.tenantId,
        propertyId: revoked.propertyId,
        reason: input.reason,
        before: { revoked: false },
        after: { revoked: true, capability: revoked.capabilityCode },
      });
      await this.changed(scope, revoked.propertyId, 'GRANT', id);
      return revoked;
    });
    this.engine.invalidate(scope.tenantId);
    return grantView(row);
  }

  listOverrides(scope: TenantScope) {
    return this.act('read', async () => (await this.repo.overrides(scope)).map(overrideView));
  }

  async createOverride(scope: TenantScope, input: CreateOverrideInput) {
    const row = await this.act('write', async () => {
      const metric = (await this.catalog.metrics()).find((m) => m.code === input.metricCode);
      if (!metric || metric.status !== 'ACTIVE')
        throw unprocessable('license.plan.unknown_metric', { code: input.metricCode });
      if ((metric.kind === 'GAUGE') !== (input.period === 'NONE'))
        throw unprocessable('license.plan.limit_period_invalid', {
          code: input.metricCode,
          period: input.period,
        });
      await this.requireProperty(scope, input.propertyId ?? null);
      const override = await this.repo
        .insertOverride({
          id: newId(),
          tenantId: scope.tenantId,
          propertyId: input.propertyId ?? null,
          metricCode: input.metricCode,
          period: input.period,
          limitValue: input.limitValue,
          enforcement: input.enforcement,
          validUntil: input.validUntil ?? null,
          reason: input.reason,
          setById: this.actorId(),
        })
        .catch((e: unknown) => {
          throw foreignKey(e);
        });
      await this.audit.record({
        action: 'license.limit_override.create',
        entityType: 'license_limit_override',
        entityId: override.id,
        tenantId: scope.tenantId,
        propertyId: override.propertyId,
        reason: input.reason,
        after: {
          metric: override.metricCode,
          limit: override.limitValue,
          enforcement: override.enforcement,
        },
      });
      await this.changed(scope, override.propertyId, 'LIMIT_OVERRIDE', override.id);
      return override;
    });
    this.engine.invalidate(scope.tenantId);
    return overrideView(row);
  }

  async revokeOverride(scope: TenantScope, id: string, input: RevokeInput) {
    const row = await this.act('write', async () => {
      const revoked = isUuid(id)
        ? await this.repo.revokeOverride(scope, id, this.actorId())
        : undefined;
      if (!revoked) throw AppError.notFound('license.limit_override.not_found');
      await this.audit.record({
        action: 'license.limit_override.revoke',
        entityType: 'license_limit_override',
        entityId: id,
        tenantId: scope.tenantId,
        propertyId: revoked.propertyId,
        reason: input.reason,
        after: { revoked: true, metric: revoked.metricCode },
      });
      await this.changed(scope, revoked.propertyId, 'LIMIT_OVERRIDE', id);
      return revoked;
    });
    this.engine.invalidate(scope.tenantId);
    return overrideView(row);
  }

  private async changed(
    scope: TenantScope,
    propertyId: string | null,
    reason: 'GRANT' | 'LIMIT_OVERRIDE',
    id: string,
  ): Promise<void> {
    await this.events.publish(EntitlementsChanged, {
      tenantId: scope.tenantId,
      propertyId,
      source: 'license',
      aggregate: { type: reason === 'GRANT' ? 'license_grant' : 'license_limit_override', id },
      payload: { property_id: propertyId, reason },
    });
  }

  private async requireProperty(scope: TenantScope, propertyId: string | null): Promise<void> {
    if (!propertyId || !this.properties) return;
    if (!(await this.properties.propertyBelongsToTenant(propertyId, scope.tenantId)))
      throw AppError.notFound('org.property.not_found');
  }

  private actorId(): string | null {
    const id = this.actors.require().id;
    return id && isUuid(id) ? id : null;
  }

  private act<T>(mode: 'read' | 'write', fn: () => Promise<T>): Promise<T> {
    return this.gate.execute({ action: GRANT, tenantId: null }, () =>
      mode === 'read' ? this.tx.read(fn) : this.tx.run(fn),
    );
  }
}

export function grantView(g: EntitlementGrantRow) {
  return {
    id: g.id,
    propertyId: g.propertyId,
    capabilityCode: g.capabilityCode,
    source: g.source,
    validFrom: g.validFrom,
    validUntil: g.validUntil,
    reason: g.reason,
    revokedAt: g.revokedAt,
    revokeReason: g.revokeReason,
    version: g.version,
  };
}

export function overrideView(o: LimitOverrideRow) {
  return {
    id: o.id,
    propertyId: o.propertyId,
    metricCode: o.metricCode,
    period: o.period,
    limitValue: o.limitValue,
    enforcement: o.enforcement,
    validUntil: o.validUntil,
    reason: o.reason,
    revokedAt: o.revokedAt,
    version: o.version,
  };
}
