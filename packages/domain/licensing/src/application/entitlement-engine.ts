import { HttpStatus, Injectable } from '@nestjs/common';
import { AppError } from '@hotella/platform-i18n';
import {
  effectiveEntitlements,
  type EffectiveEntitlements,
  effectiveLimit,
  type EffectiveLimit,
  entitledUntil,
  type FeatureFacts,
  type GrantFacts,
  type OverrideFacts,
  type SubscriptionFacts,
} from '../domain/entitlements';
import type { EntitlementPublicApi } from '../public';
import { TenantLicenseRepositories } from '../infrastructure/tenant-repositories';

/** Everything licensing knows about one tenant, loaded at once and evaluated per property in memory. */
export interface TenantFacts {
  readonly subscriptions: readonly SubscriptionFacts[];
  readonly grants: readonly GrantFacts[];
  readonly overrides: readonly OverrideFacts[];
  readonly features: readonly FeatureFacts[];
}

const TTL_MS = 30_000;

/**
 * `EntitlementEngine.can(tenant, property, capability)` (Spec §58). Facts are cached per tenant for 30 seconds and
 * dropped at once in the process that changes them; other processes see a change within the TTL. The answer is
 * computed by the pure rules of `domain/entitlements` (rule 11).
 */
@Injectable()
export class EntitlementEngine implements EntitlementPublicApi {
  private readonly cache = new Map<string, { facts: TenantFacts; at: number }>();

  constructor(private readonly repo: TenantLicenseRepositories) {}

  invalidate(tenantId?: string): void {
    if (tenantId) this.cache.delete(tenantId);
    else this.cache.clear();
  }

  async facts(tenantId: string): Promise<TenantFacts> {
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.facts;
    const facts = await this.load(tenantId);
    this.cache.set(tenantId, { facts, at: Date.now() });
    return facts;
  }

  async entitlements(
    tenantId: string,
    propertyId: string | null,
    at = new Date(),
  ): Promise<EffectiveEntitlements> {
    return effectiveEntitlements(await this.facts(tenantId), propertyId, at);
  }

  async can(tenantId: string, propertyId: string | null, capability: string): Promise<boolean> {
    return (await this.entitlements(tenantId, propertyId)).codes.has(capability);
  }

  async entitledUntil(
    tenantId: string,
    propertyId: string | null,
    capability: string,
  ): Promise<Date | null | undefined> {
    return entitledUntil(await this.entitlements(tenantId, propertyId), capability);
  }

  async effective(tenantId: string, propertyId: string | null): Promise<readonly string[]> {
    return [...(await this.entitlements(tenantId, propertyId)).codes].sort();
  }

  async limit(
    tenantId: string,
    propertyId: string | null,
    metric: string,
    scope: 'TENANT' | 'PROPERTY',
  ): Promise<EffectiveLimit | null> {
    return effectiveLimit(await this.facts(tenantId), metric, scope, propertyId, new Date());
  }

  async assertWithinLimit(input: {
    readonly tenantId: string;
    readonly propertyId: string | null;
    readonly metric: string;
    readonly current: number;
    readonly increment?: number;
  }): Promise<void> {
    const scope = input.propertyId ? 'PROPERTY' : 'TENANT';
    const limit = await this.limit(input.tenantId, input.propertyId, input.metric, scope);
    if (!limit || limit.enforcement !== 'HARD') return;
    if (input.current + (input.increment ?? 1) > limit.limitValue)
      throw new AppError('license.limit_reached', HttpStatus.CONFLICT, {
        metric: input.metric,
        limit: limit.limitValue,
      });
  }

  private async load(tenantId: string): Promise<TenantFacts> {
    const scope = { tenantId };
    const [subs, grants, overrides, features] = await Promise.all([
      this.repo.subscriptions(scope),
      this.repo.grants(scope),
      this.repo.overrides(scope),
      this.repo.features(),
    ]);
    const live = subs.filter((s) => s.status !== 'CANCELLED' && s.status !== 'EXPIRED');
    const versionIds = [...new Set(live.map((s) => s.planVersionId))];
    const [props, items, limits] = await Promise.all([
      this.repo.subscriptionProperties(
        scope,
        live.map((s) => s.id),
      ),
      this.repo.versionItems(versionIds),
      this.repo.versionLimits(versionIds),
    ]);
    return {
      subscriptions: live.map((s) => ({
        id: s.id,
        status: s.status,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        graceDays: s.graceDays,
        scope: s.scope,
        propertyIds: props.filter((p) => p.subscriptionId === s.id).map((p) => p.propertyId),
        items: items
          .filter((i) => i.planVersionId === s.planVersionId)
          .map((i) => i.capabilityCode),
        limits: limits
          .filter((l) => l.planVersionId === s.planVersionId)
          .map((l) => ({
            metricCode: l.metricCode,
            scope: l.scope,
            period: l.period,
            limitValue: l.limitValue,
            enforcement: l.enforcement,
          })),
      })),
      grants: grants.map((g) => ({
        id: g.id,
        propertyId: g.propertyId,
        capabilityCode: g.capabilityCode,
        validFrom: g.validFrom,
        validUntil: g.validUntil,
        revokedAt: g.revokedAt,
      })),
      overrides: overrides.map((o) => ({
        id: o.id,
        propertyId: o.propertyId,
        metricCode: o.metricCode,
        period: o.period,
        limitValue: o.limitValue,
        enforcement: o.enforcement,
        validUntil: o.validUntil,
        revokedAt: o.revokedAt,
      })),
      features: features.map((f) => ({
        code: f.code,
        moduleCode: f.moduleCode ?? '',
        defaultIncluded: f.defaultIncluded,
      })),
    };
  }
}
