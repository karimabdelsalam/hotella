import { describe, expect, it } from 'vitest';
import {
  effectiveEntitlements,
  effectiveLimit,
  entitledUntil,
  type GrantFacts,
  type SubscriptionFacts,
  subscriptionInForceUntil,
} from './entitlements';

const at = new Date('2026-10-04T12:00:00Z');
const d = (iso: string) => new Date(iso);
const P1 = 'p1';
const P2 = 'p2';

const sub = (over: Partial<SubscriptionFacts> = {}): SubscriptionFacts => ({
  id: 's1',
  status: 'ACTIVE',
  startsAt: d('2026-01-01T00:00:00Z'),
  endsAt: null,
  graceDays: 0,
  scope: 'TENANT',
  propertyIds: [],
  items: ['CORE', 'HOUSEKEEPING'],
  limits: [],
  ...over,
});
const grant = (over: Partial<GrantFacts> = {}): GrantFacts => ({
  id: 'g1',
  propertyId: null,
  capabilityCode: 'ENGINEERING',
  validFrom: d('2026-10-01T00:00:00Z'),
  validUntil: null,
  revokedAt: null,
  ...over,
});
const codes = (
  subscriptions: SubscriptionFacts[],
  grants: GrantFacts[] = [],
  property: string | null = P1,
) => [...effectiveEntitlements({ subscriptions, grants, features: [] }, property, at).codes].sort();

describe('subscription in force', () => {
  it('follows the status and the period', () => {
    expect(subscriptionInForceUntil(sub(), at)).toBeNull();
    expect(
      subscriptionInForceUntil(sub({ status: 'TRIAL', endsAt: d('2026-10-10T00:00:00Z') }), at),
    ).toEqual(d('2026-10-10T00:00:00Z'));
    expect(
      subscriptionInForceUntil(sub({ startsAt: d('2026-11-01T00:00:00Z') }), at),
    ).toBeUndefined();
    expect(
      subscriptionInForceUntil(sub({ endsAt: d('2026-10-04T12:00:00Z') }), at),
    ).toBeUndefined();
    for (const status of ['SUSPENDED', 'CANCELLED', 'EXPIRED'] as const)
      expect(subscriptionInForceUntil(sub({ status }), at)).toBeUndefined();
  });

  it('keeps a past-due subscription through its grace period only', () => {
    const late = sub({ status: 'PAST_DUE', endsAt: d('2026-10-01T00:00:00Z'), graceDays: 7 });
    expect(subscriptionInForceUntil(late, at)).toEqual(d('2026-10-08T00:00:00Z'));
    expect(subscriptionInForceUntil({ ...late, graceDays: 2 }, at)).toBeUndefined();
  });
});

describe('effective entitlements', () => {
  it('unites subscriptions covering the property and valid grants', () => {
    expect(codes([sub()], [grant()])).toEqual(['CORE', 'ENGINEERING', 'HOUSEKEEPING']);
  });

  it('applies property-scoped subscriptions and grants only to their properties', () => {
    const scoped = sub({
      id: 's2',
      scope: 'PROPERTIES',
      propertyIds: [P2],
      items: ['CORE', 'LOST_FOUND'],
    });
    const g = grant({ propertyId: P2 });
    expect(codes([scoped], [g], P1)).toEqual([]);
    expect(codes([scoped], [g], P2)).toEqual(['CORE', 'ENGINEERING', 'LOST_FOUND']);
    // The tenant-level view (no property) sees only tenant-wide sources.
    expect(codes([scoped], [g], null)).toEqual([]);
  });

  it('ignores revoked, expired and future grants', () => {
    expect(codes([], [grant({ revokedAt: d('2026-10-02T00:00:00Z') })])).toEqual([]);
    expect(codes([], [grant({ validUntil: d('2026-10-03T00:00:00Z') })])).toEqual([]);
    expect(codes([], [grant({ validFrom: d('2026-10-05T00:00:00Z') })])).toEqual([]);
    expect(codes([], [grant({ revokedAt: d('2026-10-05T00:00:00Z') })])).toEqual(['ENGINEERING']);
  });

  it('brings default features with their module, and others only by name', () => {
    const features = [
      { code: 'HK_READINESS', moduleCode: 'HOUSEKEEPING', defaultIncluded: true },
      { code: 'HK_ROBOTS', moduleCode: 'HOUSEKEEPING', defaultIncluded: false },
    ];
    const e = effectiveEntitlements({ subscriptions: [sub()], grants: [], features }, P1, at);
    expect(e.codes.has('HK_READINESS')).toBe(true);
    expect(e.codes.has('HK_ROBOTS')).toBe(false);
  });

  it('knows until when a capability lasts', () => {
    const trial = sub({ id: 's3', status: 'TRIAL', endsAt: d('2026-10-20T00:00:00Z') });
    const e = effectiveEntitlements(
      {
        subscriptions: [trial],
        grants: [grant({ capabilityCode: 'HOUSEKEEPING', validUntil: d('2026-12-01T00:00:00Z') })],
        features: [],
      },
      P1,
      at,
    );
    expect(entitledUntil(e, 'CORE')).toEqual(d('2026-10-20T00:00:00Z'));
    expect(entitledUntil(e, 'HOUSEKEEPING')).toEqual(d('2026-12-01T00:00:00Z'));
    expect(entitledUntil(e, 'ENGINEERING')).toBeUndefined();
    const open = effectiveEntitlements(
      { subscriptions: [sub()], grants: [], features: [] },
      P1,
      at,
    );
    expect(entitledUntil(open, 'CORE')).toBeNull();
  });
});

describe('effective limits', () => {
  const limit = (limitValue: number, enforcement: 'SOFT' | 'HARD' = 'HARD') => ({
    metricCode: 'ACTIVE_PROPERTIES',
    scope: 'TENANT' as const,
    period: 'NONE' as const,
    limitValue,
    enforcement,
  });

  it('takes the most generous in-force plan and lets an override replace it', () => {
    const subscriptions = [
      sub({ limits: [limit(3)] }),
      sub({ id: 's2', limits: [limit(5, 'SOFT')] }),
      sub({ id: 's3', status: 'SUSPENDED', limits: [limit(50)] }),
    ];
    expect(
      effectiveLimit({ subscriptions, overrides: [] }, 'ACTIVE_PROPERTIES', 'TENANT', null, at),
    ).toMatchObject({
      limitValue: 5,
      enforcement: 'SOFT',
      source: { kind: 'PLAN', id: 's2' },
    });
    const overrides = [
      {
        id: 'o1',
        propertyId: null,
        metricCode: 'ACTIVE_PROPERTIES',
        period: 'NONE' as const,
        limitValue: 10,
        enforcement: 'HARD' as const,
        validUntil: null,
        revokedAt: null,
      },
      {
        id: 'o2',
        propertyId: null,
        metricCode: 'ACTIVE_PROPERTIES',
        period: 'NONE' as const,
        limitValue: 99,
        enforcement: 'HARD' as const,
        validUntil: null,
        revokedAt: d('2026-10-01T00:00:00Z'),
      },
    ];
    expect(
      effectiveLimit({ subscriptions, overrides }, 'ACTIVE_PROPERTIES', 'TENANT', null, at),
    ).toMatchObject({
      limitValue: 10,
      source: { kind: 'OVERRIDE', id: 'o1' },
    });
    expect(
      effectiveLimit({ subscriptions, overrides }, 'ACTIVE_STAFF', 'TENANT', null, at),
    ).toBeNull();
  });
});
