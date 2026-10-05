import { CORE } from './catalog';

/**
 * Effective entitlements (Spec §58, BUILD_PLAN 11.B): computed, never stored. Deterministic code, no judgement
 * (rule 11). A subscription is *in force* while TRIAL or ACTIVE inside its period, or PAST_DUE until `grace_days`
 * after its end; SUSPENDED, CANCELLED and EXPIRED grant nothing. A capability comes from the plan-version items of
 * every in-force subscription covering the property, plus unrevoked grants valid now (tenant-wide or for the
 * property). A feature is entitled by its own code, or by its module's when `default_included`.
 */

export type SubscriptionStatus =
  'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED' | 'EXPIRED';

export interface SubscriptionFacts {
  readonly id: string;
  readonly status: SubscriptionStatus;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly graceDays: number;
  readonly scope: 'TENANT' | 'PROPERTIES';
  readonly propertyIds: readonly string[];
  readonly items: readonly string[];
  readonly limits: readonly LimitFacts[];
}

export interface LimitFacts {
  readonly metricCode: string;
  readonly scope: 'TENANT' | 'PROPERTY';
  readonly period: 'NONE' | 'DAY' | 'MONTH';
  readonly limitValue: number;
  readonly enforcement: 'SOFT' | 'HARD';
}

export interface GrantFacts {
  readonly id: string;
  readonly propertyId: string | null;
  readonly capabilityCode: string;
  readonly validFrom: Date;
  readonly validUntil: Date | null;
  readonly revokedAt: Date | null;
}

export interface OverrideFacts {
  readonly id: string;
  readonly propertyId: string | null;
  readonly metricCode: string;
  readonly period: 'NONE' | 'DAY' | 'MONTH';
  readonly limitValue: number;
  readonly enforcement: 'SOFT' | 'HARD';
  readonly validUntil: Date | null;
  readonly revokedAt: Date | null;
}

export interface FeatureFacts {
  readonly code: string;
  readonly moduleCode: string;
  readonly defaultIncluded: boolean;
}

/** Everything licensing knows about one tenant, loaded at once and evaluated per property in memory. */
export interface TenantFacts {
  readonly subscriptions: readonly SubscriptionFacts[];
  readonly grants: readonly GrantFacts[];
  readonly overrides: readonly OverrideFacts[];
  readonly features: readonly FeatureFacts[];
}

export interface EntitlementSource {
  readonly kind: 'SUBSCRIPTION' | 'GRANT';
  readonly id: string;
  /** When this source stops granting (null: open-ended). */
  readonly until: Date | null;
}

export interface EffectiveEntitlements {
  readonly codes: ReadonlySet<string>;
  readonly sources: ReadonlyMap<string, readonly EntitlementSource[]>;
}

const DAY_MS = 86_400_000;

/** Until when a subscription grants anything (null: open-ended); undefined when it grants nothing at `at`. */
export function subscriptionInForceUntil(s: SubscriptionFacts, at: Date): Date | null | undefined {
  if (at < s.startsAt) return undefined;
  switch (s.status) {
    case 'TRIAL':
    case 'ACTIVE':
      if (s.endsAt && at >= s.endsAt) return undefined;
      return s.endsAt;
    case 'PAST_DUE': {
      // Payment is late: the hotel keeps working through the grace period after the period's end.
      if (!s.endsAt) return null;
      const graceEnd = new Date(s.endsAt.getTime() + s.graceDays * DAY_MS);
      return at < graceEnd ? graceEnd : undefined;
    }
    default:
      return undefined;
  }
}

const covers = (s: SubscriptionFacts, propertyId: string | null): boolean =>
  s.scope === 'TENANT' || (propertyId !== null && s.propertyIds.includes(propertyId));

export function effectiveEntitlements(
  input: {
    readonly subscriptions: readonly SubscriptionFacts[];
    readonly grants: readonly GrantFacts[];
    readonly features: readonly FeatureFacts[];
  },
  propertyId: string | null,
  at: Date,
): EffectiveEntitlements {
  const sources = new Map<string, EntitlementSource[]>();
  const add = (code: string, source: EntitlementSource) => {
    const list = sources.get(code) ?? [];
    list.push(source);
    sources.set(code, list);
  };
  for (const s of input.subscriptions) {
    if (!covers(s, propertyId)) continue;
    const until = subscriptionInForceUntil(s, at);
    if (until === undefined) continue;
    for (const code of s.items) add(code, { kind: 'SUBSCRIPTION', id: s.id, until });
  }
  for (const g of input.grants) {
    if (g.revokedAt && g.revokedAt <= at) continue;
    if (at < g.validFrom || (g.validUntil && at >= g.validUntil)) continue;
    if (g.propertyId !== null && g.propertyId !== propertyId) continue;
    add(g.capabilityCode, { kind: 'GRANT', id: g.id, until: g.validUntil });
  }
  // Features that come with their module.
  for (const f of input.features) {
    if (!f.defaultIncluded || sources.has(f.code)) continue;
    const viaModule = sources.get(f.moduleCode);
    if (viaModule) sources.set(f.code, [...viaModule]);
  }
  return { codes: new Set(sources.keys()), sources };
}

/** The latest moment any source keeps granting `code` (null: open-ended); undefined when not entitled. */
export function entitledUntil(e: EffectiveEntitlements, code: string): Date | null | undefined {
  const list = e.sources.get(code);
  if (!list || list.length === 0) return undefined;
  if (list.some((s) => s.until === null)) return null;
  return new Date(Math.max(...list.map((s) => s.until!.getTime())));
}

export interface EffectiveLimit {
  readonly metricCode: string;
  readonly scope: 'TENANT' | 'PROPERTY';
  readonly period: 'NONE' | 'DAY' | 'MONTH';
  readonly limitValue: number;
  readonly enforcement: 'SOFT' | 'HARD';
  readonly source: { readonly kind: 'PLAN' | 'OVERRIDE'; readonly id: string };
}

/**
 * The limit on a metric at a scope: the most generous of the in-force plan versions covering the property (several
 * subscriptions never shrink each other), replaced by an unrevoked, unexpired override for that tenant/property. No
 * limit anywhere means unlimited (null).
 */
export function effectiveLimit(
  input: {
    readonly subscriptions: readonly SubscriptionFacts[];
    readonly overrides: readonly OverrideFacts[];
  },
  metricCode: string,
  scope: 'TENANT' | 'PROPERTY',
  propertyId: string | null,
  at: Date,
): EffectiveLimit | null {
  const override = input.overrides
    .filter(
      (o) =>
        o.metricCode === metricCode &&
        !(o.revokedAt && o.revokedAt <= at) &&
        !(o.validUntil && at >= o.validUntil) &&
        (scope === 'TENANT' ? o.propertyId === null : o.propertyId === propertyId),
    )
    .sort((a, b) => b.limitValue - a.limitValue)[0];
  if (override)
    return {
      metricCode,
      scope,
      period: override.period,
      limitValue: override.limitValue,
      enforcement: override.enforcement,
      source: { kind: 'OVERRIDE', id: override.id },
    };
  let best: EffectiveLimit | null = null;
  for (const s of input.subscriptions) {
    if (scope === 'PROPERTY' && !covers(s, propertyId)) continue;
    if (subscriptionInForceUntil(s, at) === undefined) continue;
    for (const l of s.limits)
      if (
        l.metricCode === metricCode &&
        l.scope === scope &&
        (!best || l.limitValue > best.limitValue)
      )
        best = { ...l, source: { kind: 'PLAN', id: s.id } };
  }
  return best;
}

/** CORE is what every in-force plan carries; a tenant without it has no licence at all. */
export const isLicensed = (e: EffectiveEntitlements): boolean => e.codes.has(CORE);

export type SubscriptionTransition = `${SubscriptionStatus}->${SubscriptionStatus}`;

/** Allowed status moves; CANCELLED and EXPIRED are final (a new subscription starts over). */
export const SUBSCRIPTION_TRANSITIONS: ReadonlySet<SubscriptionTransition> = new Set([
  'TRIAL->ACTIVE',
  'TRIAL->CANCELLED',
  'TRIAL->EXPIRED',
  'ACTIVE->PAST_DUE',
  'ACTIVE->SUSPENDED',
  'ACTIVE->CANCELLED',
  'ACTIVE->EXPIRED',
  'PAST_DUE->ACTIVE',
  'PAST_DUE->SUSPENDED',
  'PAST_DUE->CANCELLED',
  'PAST_DUE->EXPIRED',
  'SUSPENDED->ACTIVE',
  'SUSPENDED->CANCELLED',
  'SUSPENDED->EXPIRED',
] satisfies SubscriptionTransition[]);
