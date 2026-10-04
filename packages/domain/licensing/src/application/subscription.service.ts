import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { EntitlementsChanged, SubscriptionChanged } from '@hotella/contracts-events';
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
import {
  SUBSCRIPTION_TRANSITIONS,
  type SubscriptionStatus,
  type SubscriptionTransition,
} from '../domain/entitlements';
import { CatalogRepositories } from '../infrastructure/repositories';
import type { SubscriptionRow } from '../infrastructure/schema';
import { TenantLicenseRepositories } from '../infrastructure/tenant-repositories';
import { EntitlementEngine } from './entitlement-engine';
import type {
  ChangeSubscriptionInput,
  CreateSubscriptionInput,
  TransitionSubscriptionInput,
} from './schemas';

const MANAGE = 'license.subscription.manage';

/**
 * Subscriptions of a tenant to published plan versions (Spec §58, BUILD_PLAN 11.2), tenant-wide or for chosen
 * properties. Every change appends to the subscription's history (rule 10), is audited and announced
 * (`license.subscription.changed.v1`, `license.entitlements.changed.v1`). Billing stays outside: `external_ref` is the
 * billing system's reference.
 */
@Injectable()
export class SubscriptionService {
  constructor(
    private readonly repo: TenantLicenseRepositories,
    private readonly plans: CatalogRepositories,
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

  list(scope: TenantScope) {
    return this.act('read', () => this.summaries(scope));
  }

  /** The tenant's subscriptions as views, without a gate of its own: callers check their own permission. */
  async summaries(scope: TenantScope) {
    return this.views(scope, await this.repo.subscriptions(scope));
  }

  get(scope: TenantScope, id: string) {
    return this.act('read', async () => {
      const row = await this.find(scope, id);
      const [view] = await this.views(scope, [row]);
      return { ...view!, history: (await this.repo.history(scope, id)).map(historyView) };
    });
  }

  async create(scope: TenantScope, input: CreateSubscriptionInput) {
    const result = await this.act('write', async () => {
      await this.requirePublished(input.planVersionId);
      await this.requireProperties(scope, input.propertyIds);
      const startsAt = input.startsAt ?? new Date();
      if (input.endsAt && input.endsAt <= startsAt)
        throw unprocessable('license.subscription.period_invalid');
      const row = await this.repo
        .insertSubscription({
          id: newId(),
          tenantId: scope.tenantId,
          planVersionId: input.planVersionId,
          scope: input.scope,
          status: input.status,
          startsAt,
          endsAt: input.endsAt ?? null,
          graceDays: input.graceDays,
          externalRef: input.externalRef ?? null,
        })
        .catch((e: unknown) => {
          throw foreignKey(e);
        });
      if (input.scope === 'PROPERTIES')
        await this.repo.setSubscriptionProperties(scope, row.id, input.propertyIds);
      await this.record(scope, row, null, 'CREATED', input.reason ?? null);
      return row;
    });
    this.engine.invalidate(scope.tenantId);
    return this.get(scope, result.id);
  }

  async transition(scope: TenantScope, id: string, input: TransitionSubscriptionInput) {
    await this.act('write', async () => {
      const current = await this.find(scope, id);
      if (
        !SUBSCRIPTION_TRANSITIONS.has(
          `${current.status}->${input.status}` as SubscriptionTransition,
        )
      )
        throw new AppError('license.subscription.transition_invalid', HttpStatus.CONFLICT, {
          from: current.status,
          to: input.status,
        });
      const row = await this.repo.updateSubscription(scope, id, input.version, {
        status: input.status,
      });
      if (!row) throw AppError.conflict('license.subscription.version_conflict');
      await this.record(scope, row, current.status, 'STATUS', input.reason);
    });
    this.engine.invalidate(scope.tenantId);
    return this.get(scope, id);
  }

  /** Another plan version, scope, covered properties or period, in one recorded step. */
  async change(scope: TenantScope, id: string, input: ChangeSubscriptionInput) {
    await this.act('write', async () => {
      const current = await this.find(scope, id);
      if (current.status === 'CANCELLED' || current.status === 'EXPIRED')
        throw AppError.conflict('license.subscription.ended');
      if (input.planVersionId && input.planVersionId !== current.planVersionId)
        await this.requirePublished(input.planVersionId);
      const nextScope = input.scope ?? current.scope;
      const props =
        input.propertyIds ??
        (await this.repo.subscriptionProperties(scope, [id])).map((p) => p.propertyId);
      if (
        (nextScope === 'PROPERTIES' && props.length === 0) ||
        (nextScope === 'TENANT' && (input.propertyIds?.length ?? 0) > 0)
      )
        throw unprocessable('license.subscription.scope_invalid');
      await this.requireProperties(scope, nextScope === 'PROPERTIES' ? props : []);
      const endsAt = input.endsAt === undefined ? current.endsAt : input.endsAt;
      if (endsAt && endsAt <= current.startsAt)
        throw unprocessable('license.subscription.period_invalid');
      const row = await this.repo.updateSubscription(scope, id, input.version, {
        ...(input.planVersionId ? { planVersionId: input.planVersionId } : {}),
        scope: nextScope,
        endsAt,
        ...(input.graceDays !== undefined ? { graceDays: input.graceDays } : {}),
      });
      if (!row) throw AppError.conflict('license.subscription.version_conflict');
      await this.repo.setSubscriptionProperties(scope, id, nextScope === 'PROPERTIES' ? props : []);
      const change =
        input.planVersionId && input.planVersionId !== current.planVersionId ? 'PLAN' : 'TERMS';
      await this.record(scope, row, current.status, change, input.reason, {
        planVersionId: current.planVersionId,
        scope: current.scope,
        endsAt: current.endsAt,
      });
    });
    this.engine.invalidate(scope.tenantId);
    return this.get(scope, id);
  }

  // ---- helpers ----

  private async record(
    scope: TenantScope,
    row: SubscriptionRow,
    from: SubscriptionStatus | null,
    change: 'CREATED' | 'STATUS' | 'PLAN' | 'TERMS',
    reason: string | null,
    before?: Record<string, unknown>,
  ): Promise<void> {
    const actor = this.actors.require();
    await this.repo.appendHistory({
      id: newId(),
      subscriptionId: row.id,
      tenantId: scope.tenantId,
      fromStatus: from,
      toStatus: row.status,
      planVersionId: row.planVersionId,
      change,
      actorType: actor.type,
      actorId: actor.id && isUuid(actor.id) ? actor.id : null,
      reason,
    });
    await this.audit.record({
      action: `license.subscription.${change.toLowerCase()}`,
      entityType: 'license_subscription',
      entityId: row.id,
      tenantId: scope.tenantId,
      reason,
      before: before ?? (from ? { status: from } : null),
      after: {
        status: row.status,
        plan_version_id: row.planVersionId,
        scope: row.scope,
        ends_at: row.endsAt?.toISOString() ?? null,
      },
    });
    await this.events.publish(SubscriptionChanged, {
      tenantId: scope.tenantId,
      source: 'license',
      aggregate: { type: 'license_subscription', id: row.id },
      payload: {
        subscription_id: row.id,
        plan_version_id: row.planVersionId,
        scope: row.scope,
        from_status: from,
        to_status: row.status,
        reason,
      },
    });
    await this.events.publish(EntitlementsChanged, {
      tenantId: scope.tenantId,
      source: 'license',
      aggregate: { type: 'license_subscription', id: row.id },
      payload: { property_id: null, reason: 'SUBSCRIPTION' },
    });
  }

  private async views(scope: TenantScope, rows: readonly SubscriptionRow[]) {
    const props = await this.repo.subscriptionProperties(
      scope,
      rows.map((r) => r.id),
    );
    const versions = await Promise.all(
      [...new Set(rows.map((r) => r.planVersionId))].map((id) => this.plans.versionById(id)),
    );
    const plans = await Promise.all(
      [...new Set(versions.filter((v) => v).map((v) => v!.planId))].map((id) =>
        this.plans.plan(id),
      ),
    );
    return rows.map((r) => {
      const v = versions.find((x) => x?.id === r.planVersionId);
      const p = plans.find((x) => x?.id === v?.planId);
      return {
        id: r.id,
        tenantId: r.tenantId,
        planVersionId: r.planVersionId,
        plan:
          p && v
            ? { id: p.id, code: p.code, versionNo: v.versionNo, versionStatus: v.status }
            : null,
        scope: r.scope,
        propertyIds: props.filter((x) => x.subscriptionId === r.id).map((x) => x.propertyId),
        status: r.status,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        graceDays: r.graceDays,
        externalRef: r.externalRef,
        version: r.version,
      };
    });
  }

  private async find(scope: TenantScope, id: string): Promise<SubscriptionRow> {
    const row = isUuid(id) ? await this.repo.subscription(scope, id) : undefined;
    if (!row) throw AppError.notFound('license.subscription.not_found');
    return row;
  }

  private async requirePublished(planVersionId: string): Promise<void> {
    const v = await this.plans.versionById(planVersionId);
    if (!v) throw AppError.notFound('license.plan_version.not_found');
    // A draft is not for sale yet; a retired version takes no new subscribers.
    if (v.status !== 'PUBLISHED') throw AppError.conflict('license.plan_version.not_published');
  }

  private async requireProperties(
    scope: TenantScope,
    propertyIds: readonly string[],
  ): Promise<void> {
    if (!this.properties) return;
    for (const p of propertyIds)
      if (!(await this.properties.propertyBelongsToTenant(p, scope.tenantId)))
        throw AppError.notFound('org.property.not_found');
  }

  private act<T>(mode: 'read' | 'write', fn: () => Promise<T>): Promise<T> {
    // A platform action about a tenant: no tenant on the gate, so the tenant's own entitlements never block it.
    return this.gate.execute({ action: MANAGE, tenantId: null }, () =>
      mode === 'read' ? this.tx.read(fn) : this.tx.run(fn),
    );
  }
}

export function historyView(h: {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  planVersionId: string;
  change: string;
  actorType: string;
  actorId: string | null;
  reason: string | null;
  at: Date;
}) {
  return {
    id: h.id,
    change: h.change,
    fromStatus: h.fromStatus,
    toStatus: h.toStatus,
    planVersionId: h.planVersionId,
    actorType: h.actorType,
    actorId: h.actorId,
    reason: h.reason,
    at: h.at,
  };
}

export function unprocessable(key: string, params?: Record<string, string | number>): AppError {
  return new AppError(key, HttpStatus.UNPROCESSABLE_ENTITY, params);
}

/** An unknown tenant (or property) surfaces as the foreign-key violation of the insert: 404, never a 500. */
export function foreignKey(e: unknown): unknown {
  const code = (e as { cause?: { code?: string } }).cause?.code;
  return code === '23503' ? AppError.notFound('org.tenant.not_found') : e;
}
