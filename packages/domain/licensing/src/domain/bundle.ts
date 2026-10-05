import { createPublicKey, type KeyObject, sign, verify } from 'node:crypto';
import type { TenantFacts } from './entitlements';

/**
 * The signed entitlement bundle of a hotel-site installation (ADR-0021): the tenant's licensing facts as the central
 * control plane knows them, valid until `valid_until` and usable offline until `grace_until`, signed with the
 * platform's Ed25519 entitlement key. A site computes entitlements from it with the same pure rules as the centre.
 * Token: `base64url(payload JSON) "." base64url(signature over the payload bytes)`.
 */
export const BUNDLE_TYPE = 'hotella.entitlements.v1';
/** A site refuses a bundle issued further than this in its future (clock skew). */
export const BUNDLE_MAX_SKEW_MS = 5 * 60_000;

export interface BundlePayload {
  readonly typ: typeof BUNDLE_TYPE;
  readonly installation_id: string;
  readonly tenant_id: string;
  readonly issued_at: string;
  readonly valid_until: string;
  readonly grace_until: string;
  readonly facts: TenantFacts;
}

export type BundleState = 'VALID' | 'GRACE' | 'EXPIRED';

export interface VerifiedBundle {
  readonly payload: BundlePayload;
  readonly facts: TenantFacts;
  readonly issuedAt: Date;
  readonly validUntil: Date;
  readonly graceUntil: Date;
}

export class BundleRejectedError extends Error {
  constructor(
    readonly reason: 'MALFORMED' | 'SIGNATURE' | 'TYPE' | 'INSTALLATION' | 'FUTURE' | 'ROLLBACK',
  ) {
    super(`entitlement bundle rejected: ${reason}`);
  }
}

const DAY_MS = 86_400_000;
const b64 = (b: Buffer) => b.toString('base64url');

export function issueBundle(input: {
  readonly installationId: string;
  readonly tenantId: string;
  readonly facts: TenantFacts;
  readonly now: Date;
  readonly validDays: number;
  readonly graceDays: number;
  readonly key: KeyObject;
}): string {
  const validUntil = new Date(input.now.getTime() + input.validDays * DAY_MS);
  const payload: BundlePayload = {
    typ: BUNDLE_TYPE,
    installation_id: input.installationId,
    tenant_id: input.tenantId,
    issued_at: input.now.toISOString(),
    valid_until: validUntil.toISOString(),
    grace_until: new Date(validUntil.getTime() + input.graceDays * DAY_MS).toISOString(),
    facts: input.facts,
  };
  const bytes = Buffer.from(JSON.stringify(payload));
  return `${b64(bytes)}.${b64(sign(null, bytes, input.key))}`;
}

/**
 * Checks a bundle offline: signature against the pinned key, type, the installation it was issued for, not issued in
 * the future beyond the skew, and never older than the newest bundle already accepted (a clock rolled back cannot bring
 * back an older, broader bundle). Expiry is not an error: the caller reads {@link bundleState}.
 */
export function verifyBundle(
  token: string,
  publicKey: KeyObject,
  expect: {
    readonly installationId: string;
    readonly now: Date;
    readonly newestAccepted?: Date | null;
  },
): VerifiedBundle {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) throw new BundleRejectedError('MALFORMED');
  const bytes = Buffer.from(body, 'base64url');
  if (!verify(null, bytes, publicKey, Buffer.from(signature, 'base64url')))
    throw new BundleRejectedError('SIGNATURE');
  let payload: BundlePayload;
  try {
    payload = JSON.parse(bytes.toString('utf8')) as BundlePayload;
  } catch {
    throw new BundleRejectedError('MALFORMED');
  }
  if (payload.typ !== BUNDLE_TYPE) throw new BundleRejectedError('TYPE');
  if (payload.installation_id !== expect.installationId)
    throw new BundleRejectedError('INSTALLATION');
  const issuedAt = new Date(payload.issued_at);
  if (issuedAt.getTime() > expect.now.getTime() + BUNDLE_MAX_SKEW_MS)
    throw new BundleRejectedError('FUTURE');
  if (expect.newestAccepted && issuedAt.getTime() < expect.newestAccepted.getTime())
    throw new BundleRejectedError('ROLLBACK');
  return {
    payload,
    facts: reviveFacts(payload.facts),
    issuedAt,
    validUntil: new Date(payload.valid_until),
    graceUntil: new Date(payload.grace_until),
  };
}

export function bundleState(
  bundle: Pick<VerifiedBundle, 'validUntil' | 'graceUntil'>,
  now: Date,
): BundleState {
  if (now < bundle.validUntil) return 'VALID';
  return now < bundle.graceUntil ? 'GRACE' : 'EXPIRED';
}

/** Ed25519 public key from SPKI DER in base64 (how a site pins the platform's key in its configuration). */
export function publicKeyFromBase64(spkiDer: string): KeyObject {
  return createPublicKey({ key: Buffer.from(spkiDer, 'base64'), format: 'der', type: 'spki' });
}

/** The signed request a site sends for its bundle: its id and the time, signed with its own Ed25519 key. */
export function bundleRequestMessage(installationId: string, at: string): Buffer {
  return Buffer.from(`${BUNDLE_TYPE}.request.${installationId}.${at}`);
}

const date = (v: unknown): Date => new Date(v as string);
const dateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : date(v));

/** JSON carries dates as ISO strings; the rules need `Date`s. */
export function reviveFacts(f: TenantFacts): TenantFacts {
  return {
    subscriptions: f.subscriptions.map((s) => ({
      ...s,
      startsAt: date(s.startsAt),
      endsAt: dateOrNull(s.endsAt),
    })),
    grants: f.grants.map((g) => ({
      ...g,
      validFrom: date(g.validFrom),
      validUntil: dateOrNull(g.validUntil),
      revokedAt: dateOrNull(g.revokedAt),
    })),
    overrides: f.overrides.map((o) => ({
      ...o,
      validUntil: dateOrNull(o.validUntil),
      revokedAt: dateOrNull(o.revokedAt),
    })),
    features: f.features,
  };
}
