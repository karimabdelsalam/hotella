import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BundleRejectedError,
  bundleState,
  issueBundle,
  publicKeyFromBase64,
  verifyBundle,
} from './bundle';
import { effectiveEntitlements, type TenantFacts } from './entitlements';

const platform = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const now = new Date('2026-10-05T10:00:00Z');
const INSTALLATION = '01920000-0000-7000-8000-000000000001';
const facts: TenantFacts = {
  subscriptions: [
    {
      id: 's1',
      status: 'ACTIVE',
      startsAt: new Date('2026-01-01T00:00:00Z'),
      endsAt: new Date('2027-01-01T00:00:00Z'),
      graceDays: 0,
      scope: 'PROPERTIES',
      propertyIds: ['p1'],
      items: ['CORE', 'HOUSEKEEPING'],
      limits: [],
    },
  ],
  grants: [
    {
      id: 'g1',
      propertyId: 'p1',
      capabilityCode: 'ENGINEERING',
      validFrom: new Date('2026-10-01T00:00:00Z'),
      validUntil: null,
      revokedAt: null,
    },
  ],
  overrides: [],
  features: [],
};
const issue = (over: { at?: Date; installationId?: string } = {}) =>
  issueBundle({
    installationId: over.installationId ?? INSTALLATION,
    tenantId: 't1',
    facts,
    now: over.at ?? now,
    validDays: 7,
    graceDays: 30,
    key: platform.privateKey,
  });
const reason = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof BundleRejectedError ? e.reason : e;
  }
};

describe('signed entitlement bundle (ADR-0021)', () => {
  it('round-trips: a site computes the same entitlements as the centre', () => {
    const bundle = verifyBundle(issue(), platform.publicKey, { installationId: INSTALLATION, now });
    expect(bundle.validUntil.toISOString()).toBe('2026-10-12T10:00:00.000Z');
    expect(bundle.graceUntil.toISOString()).toBe('2026-11-11T10:00:00.000Z');
    const site = effectiveEntitlements(bundle.facts, 'p1', now);
    const centre = effectiveEntitlements(facts, 'p1', now);
    expect([...site.codes].sort()).toEqual([...centre.codes].sort());
    expect([...site.codes]).toContain('ENGINEERING');
  });

  it('is valid, then in grace, then expired', () => {
    const bundle = verifyBundle(issue(), platform.publicKey, { installationId: INSTALLATION, now });
    expect(bundleState(bundle, now)).toBe('VALID');
    expect(bundleState(bundle, new Date('2026-10-20T00:00:00Z'))).toBe('GRACE');
    expect(bundleState(bundle, new Date('2026-11-11T10:00:00Z'))).toBe('EXPIRED');
  });

  it('refuses a tampered bundle, another key, another installation, the future and an older bundle', () => {
    const token = issue();
    const [body, sig] = token.split('.');
    const forged = Buffer.from(body!, 'base64url')
      .toString()
      .replace('HOUSEKEEPING', 'ENTERPRISE_X');
    const expectation = { installationId: INSTALLATION, now };
    expect(
      reason(() =>
        verifyBundle(
          `${Buffer.from(forged).toString('base64url')}.${sig}`,
          platform.publicKey,
          expectation,
        ),
      ),
    ).toBe('SIGNATURE');
    expect(reason(() => verifyBundle(token, other.publicKey, expectation))).toBe('SIGNATURE');
    expect(reason(() => verifyBundle('nope', platform.publicKey, expectation))).toBe('MALFORMED');
    expect(
      reason(() =>
        verifyBundle(
          issue({ installationId: '01920000-0000-7000-8000-000000000002' }),
          platform.publicKey,
          expectation,
        ),
      ),
    ).toBe('INSTALLATION');
    expect(
      reason(() =>
        verifyBundle(
          issue({ at: new Date('2026-10-05T11:00:00Z') }),
          platform.publicKey,
          expectation,
        ),
      ),
    ).toBe('FUTURE');
    expect(
      reason(() =>
        verifyBundle(issue({ at: new Date('2026-10-01T00:00:00Z') }), platform.publicKey, {
          ...expectation,
          newestAccepted: new Date('2026-10-04T00:00:00Z'),
        }),
      ),
    ).toBe('ROLLBACK');
  });

  it('pins the platform key from its SPKI DER in base64', () => {
    const pinned = publicKeyFromBase64(
      platform.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    );
    expect(
      verifyBundle(issue(), pinned, { installationId: INSTALLATION, now }).payload.tenant_id,
    ).toBe('t1');
  });
});
