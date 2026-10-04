import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate } from '@hotella/platform-auth';
import { type TenantScope, TransactionRunner } from '@hotella/platform-database';
import { FeatureFlagService } from '@hotella/platform-flags';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { AttributionPolicyService } from '@hotella/platform-settings';
import { CatalogRepositories } from '../infrastructure/repositories';
import { TenantLicenseRepositories } from '../infrastructure/tenant-repositories';
import { EntitlementEngine } from './entitlement-engine';

export const WHITE_LABEL = 'WHITE_LABEL';

/**
 * The rest of the SaaS control plane (Spec §63) that is not plans and subscriptions: the platform-wide subscription
 * overview, the white-label attribution (CLAUDE.md rule 15: "Powered by Planova" can be hidden only while the tenant
 * holds the WHITE_LABEL entitlement, and comes back when it ends) and feature flags (release control, never licensing:
 * Spec §60). Platform administrators only; no guest or operational data is read here.
 */
@Injectable()
export class ControlPlaneService {
  constructor(
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly engine: EntitlementEngine,
    private readonly tenantRepo: TenantLicenseRepositories,
    private readonly catalog: CatalogRepositories,
    private readonly attribution: AttributionPolicyService,
    private readonly flags: FeatureFlagService,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  /** Every tenant's subscriptions with their plan, for the control plane's tenant list. */
  subscriptions() {
    return this.gate.execute({ action: 'license.subscription.manage', tenantId: null }, () =>
      this.tx.read(async () => {
        const rows = await this.tenantRepo.allSubscriptions();
        const versions = new Map(
          (
            await Promise.all(
              [...new Set(rows.map((r) => r.planVersionId))].map((id) =>
                this.catalog.versionById(id),
              ),
            )
          )
            .filter((v) => v !== undefined)
            .map((v) => [v.id, v]),
        );
        const plans = new Map((await this.catalog.listPlans()).map((p) => [p.id, p]));
        return rows.map((r) => {
          const v = versions.get(r.planVersionId);
          const p = v ? plans.get(v.planId) : undefined;
          return {
            id: r.id,
            tenantId: r.tenantId,
            status: r.status,
            scope: r.scope,
            startsAt: r.startsAt,
            endsAt: r.endsAt,
            plan: p && v ? { id: p.id, code: p.code, versionNo: v.versionNo } : null,
          };
        });
      }),
    );
  }

  attributionOf(scope: TenantScope) {
    return this.gate.execute(
      { action: 'license.attribution.manage', tenantId: null },
      async () => ({
        tenantId: scope.tenantId,
        ...(await this.attribution.resolve(scope.tenantId)),
        whiteLabelEntitled: await this.engine.can(scope.tenantId, null, WHITE_LABEL),
      }),
    );
  }

  /** Hide "Powered by Planova" only with the WHITE_LABEL entitlement; showing it is always allowed. */
  setAttribution(scope: TenantScope, input: { showPoweredBy: boolean; reason: string }) {
    return this.gate.execute({ action: 'license.attribution.manage', tenantId: null }, async () => {
      if (!input.showPoweredBy && !(await this.engine.can(scope.tenantId, null, WHITE_LABEL)))
        throw new AppError('license.not_entitled', HttpStatus.FORBIDDEN, {
          capability: WHITE_LABEL,
        });
      await this.attribution.set(
        scope.tenantId,
        {
          showPoweredBy: input.showPoweredBy,
          overrideEntitlementRef: input.showPoweredBy ? null : `license:${WHITE_LABEL}`,
        },
        input.reason,
      );
      return this.attributionOf(scope);
    });
  }

  listFlags() {
    return this.gate.execute({ action: 'platform.feature_flag.read', tenantId: null }, () =>
      this.flags.list(),
    );
  }

  setFlag(input: {
    key: string;
    scope: 'PLATFORM' | 'TENANT' | 'PROPERTY';
    scopeId?: string | null;
    enabled: boolean;
    description?: string | null;
    reason: string;
  }) {
    return this.gate.execute(
      { action: 'platform.feature_flag.manage', tenantId: null },
      async () => {
        if (input.scope !== 'PLATFORM' && !input.scopeId)
          throw new AppError('platform.validation_failed', HttpStatus.BAD_REQUEST, { count: 1 });
        await this.flags.set({
          key: input.key,
          scope: input.scope,
          scopeId: input.scope === 'PLATFORM' ? null : input.scopeId,
          enabled: input.enabled,
          description: input.description ?? null,
        });
        await this.tx.run(() =>
          this.audit.record({
            action: 'platform.feature_flag.set',
            entityType: 'feature_flag',
            entityId: input.key,
            tenantId: input.scope === 'TENANT' ? (input.scopeId ?? null) : null,
            propertyId: input.scope === 'PROPERTY' ? (input.scopeId ?? null) : null,
            reason: input.reason,
            after: { scope: input.scope, enabled: input.enabled },
          }),
        );
        return (await this.flags.list()).filter((f) => f.key === input.key);
      },
    );
  }
}
