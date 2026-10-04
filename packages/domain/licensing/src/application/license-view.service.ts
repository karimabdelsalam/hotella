import { Injectable } from '@nestjs/common';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { type TenantScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { METRICS } from '../domain/catalog';
import { effectiveEntitlements, effectiveLimit } from '../domain/entitlements';
import { CatalogRepositories } from '../infrastructure/repositories';
import { EntitlementEngine } from './entitlement-engine';
import { SubscriptionService } from './subscription.service';

/** Read models of a tenant's licence: the control plane's full view, the tenant's own and the apps' code list. */
@Injectable()
export class LicenseViewService {
  constructor(
    private readonly engine: EntitlementEngine,
    private readonly catalog: CatalogRepositories,
    private readonly subscriptions: SubscriptionService,
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
    private readonly tx: TransactionRunner,
  ) {}

  /** Effective entitlements with their sources and the limits in force (platform administrators). */
  effective(scope: TenantScope, propertyId: string | null) {
    return this.gate.execute({ action: 'license.entitlement.read', tenantId: null }, () =>
      this.tx.read(() => this.describe(scope, propertyId)),
    );
  }

  /** The tenant's own licence (its managers): subscriptions, what they give and the limits. */
  tenantLicense(scope: TenantScope) {
    return this.gate.execute({ action: 'license.tenant.read', tenantId: scope.tenantId }, () =>
      this.tx.read(async () => {
        const subscriptions = (await this.subscriptions.summaries(scope)).map((s) => ({
          id: s.id,
          plan: s.plan,
          scope: s.scope,
          propertyIds: s.propertyIds,
          status: s.status,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
        }));
        return { subscriptions, ...(await this.describe(scope, null)) };
      }),
    );
  }

  /**
   * The codes the apps use to show only what the property may use (Spec §47 spirit: never offer what cannot be done).
   * Any signed-in staff member of the tenant; platform administrators are not limited.
   */
  async mine(
    propertyId: string | null,
  ): Promise<{ propertyId: string | null; unrestricted: boolean; codes: readonly string[] }> {
    const actor = this.actors.require();
    if (actor.isPlatformAdmin)
      return {
        propertyId,
        unrestricted: true,
        codes: (await this.tx.read(() => this.catalog.capabilities()))
          .filter((c) => c.status === 'ACTIVE')
          .map((c) => c.code),
      };
    if (!actor.tenantId) throw AppError.notFound('org.tenant.not_found');
    if (propertyId)
      return {
        propertyId,
        unrestricted: false,
        codes: await this.engine.effective(actor.tenantId, propertyId),
      };
    // No property named: what the tenant may use anywhere (tenant-wide plus every property-specific source), so the
    // apps show a section that at least one property has; each property's screens are still refused where it has not.
    const facts = await this.engine.facts(actor.tenantId);
    const properties = new Set<string | null>([null]);
    for (const s of facts.subscriptions) for (const p of s.propertyIds) properties.add(p);
    for (const g of facts.grants) if (g.propertyId) properties.add(g.propertyId);
    const codes = new Set<string>();
    for (const p of properties)
      for (const c of await this.engine.effective(actor.tenantId, p)) codes.add(c);
    return { propertyId: null, unrestricted: false, codes: [...codes].sort() };
  }

  private async describe(scope: TenantScope, propertyId: string | null) {
    const facts = await this.engine.facts(scope.tenantId);
    const now = new Date();
    const e = effectiveEntitlements(facts, propertyId, now);
    const limits = METRICS.flatMap((m) =>
      (['TENANT', 'PROPERTY'] as const).flatMap((s) => {
        if (s === 'PROPERTY' && !propertyId) return [];
        const l = effectiveLimit(facts, m.code, s, propertyId, now);
        return l ? [l] : [];
      }),
    );
    return {
      propertyId,
      entitlements: [...e.codes].sort().map((code) => ({
        code,
        sources: e.sources.get(code)!.map((s) => ({ kind: s.kind, id: s.id, until: s.until })),
      })),
      limits,
    };
  }
}
