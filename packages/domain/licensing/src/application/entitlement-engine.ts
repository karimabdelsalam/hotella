import { forwardRef, HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { AppError } from '@hotella/platform-i18n';
import {
  effectiveEntitlements,
  type EffectiveEntitlements,
  effectiveLimit,
  type EffectiveLimit,
  entitledUntil,
  type TenantFacts,
} from '../domain/entitlements';
import type { EntitlementPublicApi } from '../public';
import { TenantLicenseRepositories } from '../infrastructure/tenant-repositories';
import { SiteBundleStore } from './site-bundle.store';

export type { TenantFacts } from '../domain/entitlements';

const TTL_MS = 30_000;

/**
 * `EntitlementEngine.can(tenant, property, capability)` (Spec §58). Facts are cached per tenant for 30 seconds and
 * dropped at once in the process that changes them; other processes see a change within the TTL. The answer is
 * computed by the pure rules of `domain/entitlements` (rule 11).
 *
 * Offline resilience (ADR-0021): when licensing cannot be read, the last facts read successfully keep answering for
 * `LICENSING_STALE_GRACE_HOURS` — a database fault must not become an outage. On a hotel-site installation
 * (`LICENSING_MODE=site`) the facts come from the central control plane's signed bundle instead of the tables.
 */
@Injectable()
export class EntitlementEngine implements EntitlementPublicApi {
  private readonly cache = new Map<string, { facts: TenantFacts; at: number }>();
  private readonly lastGood = new Map<string, { facts: TenantFacts; at: number }>();
  private readonly degraded = new Set<string>();

  constructor(
    private readonly repo: TenantLicenseRepositories,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectLogger() private readonly logger: Logger,
    @Optional() @Inject(forwardRef(() => SiteBundleStore)) private readonly site?: SiteBundleStore,
  ) {}

  invalidate(tenantId?: string): void {
    if (tenantId) this.cache.delete(tenantId);
    else this.cache.clear();
  }

  async facts(tenantId: string): Promise<TenantFacts> {
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.facts;
    let facts: TenantFacts;
    try {
      facts =
        this.config.licensing.mode === 'site'
          ? await this.siteFacts(tenantId)
          : await this.load(tenantId);
    } catch (err) {
      const good = this.lastGood.get(tenantId);
      if (!good || Date.now() - good.at > this.config.licensing.staleGraceHours * 3_600_000)
        throw err;
      if (!this.degraded.has(tenantId)) {
        this.degraded.add(tenantId);
        this.logger.warn(
          { tenantId, since: new Date(good.at).toISOString(), error: (err as Error).message },
          'licensing unreadable: answering from the last facts read successfully',
        );
      }
      return good.facts;
    }
    if (this.degraded.delete(tenantId)) this.logger.info({ tenantId }, 'licensing readable again');
    const now = Date.now();
    this.cache.set(tenantId, { facts, at: now });
    this.lastGood.set(tenantId, { facts, at: now });
    return facts;
  }

  /** The central tables, uncached: what a site's bundle is made of. */
  centralFacts(tenantId: string): Promise<TenantFacts> {
    return this.load(tenantId);
  }

  /**
   * Site mode only: true once the newest accepted bundle is past its grace — people's actions are then refused with
   * `license.offline_expired` while SYSTEM/INTEGRATION work continues (ADR-0021).
   */
  async offlineExpired(tenantId: string): Promise<boolean> {
    if (this.config.licensing.mode !== 'site' || !this.site) return false;
    const current = await this.site.current();
    return current !== null && current.tenantId === tenantId && current.state === 'EXPIRED';
  }

  private async siteFacts(tenantId: string): Promise<TenantFacts> {
    if (!this.site) throw new Error('LICENSING_MODE=site without the site bundle store');
    const current = await this.site.current();
    // No bundle yet, or one for another tenant: nothing is entitled (SYSTEM/INTEGRATION work is never gated).
    if (!current || current.tenantId !== tenantId)
      return { subscriptions: [], grants: [], overrides: [], features: [] };
    return current.facts;
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
