import { createHmac, timingSafeEqual } from 'node:crypto';

/** OTP rules (Spec §19.2, §66, ADR-0011): 6 digits, 5 minutes, 5 attempts per session across channels. */
export const OTP_DIGITS = 6;
export const OTP_TTL_MS = 5 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
/** Verification sessions one phone number may open per hour (the per-IP limit is a route rate limit). */
export const PHONE_SESSIONS_PER_HOUR = 5;

/**
 * The code of a session is derived, not stored: HMAC-SHA256 under a provider-managed key (a SecretRef) over the session
 * id and a random seed. The same code can be re-sent on a fallback channel (ADR-0015: one session, one code), the
 * database alone never reveals it, and a stolen row without the key is useless.
 */
export function deriveOtp(key: string, sessionId: string, seed: string): string {
  const mac = createHmac('sha256', key).update(`otp:v1:${sessionId}:${seed}`, 'utf8').digest();
  const n = mac.readBigUInt64BE(0) % 10n ** BigInt(OTP_DIGITS);
  return n.toString().padStart(OTP_DIGITS, '0');
}

/** Constant-time comparison of a submitted code. */
export function otpMatches(expected: string, submitted: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(submitted.trim(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface SessionState {
  readonly expiresAt: Date;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly verifiedAt: Date | null;
  readonly lockedAt: Date | null;
}

export type AttemptGate = 'OPEN' | 'EXPIRED' | 'LOCKED' | 'ALREADY_VERIFIED';

/** Whether a session still accepts a code (checked before counting the attempt). */
export function attemptGate(s: SessionState, now: Date): AttemptGate {
  if (s.verifiedAt) return 'ALREADY_VERIFIED';
  if (s.lockedAt || s.attempts >= s.maxAttempts) return 'LOCKED';
  if (now >= s.expiresAt) return 'EXPIRED';
  return 'OPEN';
}

// ---- delivery chain (ADR-0015; deterministic, never an LLM — CLAUDE.md rule 11) ----

export type OtpChannel = 'WHATSAPP' | 'SMS' | 'VOICE';
export type ChannelHealthState = 'HEALTHY' | 'DEGRADED' | 'OFFLINE' | 'AUTH_FAILED';

export interface OtpPolicy {
  readonly primary: OtpChannel;
  readonly fallbacks: readonly OtpChannel[];
  readonly fallbackTimeoutSeconds: number;
  readonly manualFallbackAfterSeconds: number;
}

/**
 * The channels to try, in order: primary then fallbacks, without duplicates, skipping channels the property has not
 * set up and channels whose health is OFFLINE or AUTH_FAILED (health pre-emption). `preempted` lists the skipped
 * unhealthy ones so the caller can raise one deduplicated alert.
 */
export function deliveryChain(
  policy: OtpPolicy,
  available: Readonly<Partial<Record<OtpChannel, ChannelHealthState>>>,
): { readonly chain: readonly OtpChannel[]; readonly preempted: readonly OtpChannel[] } {
  const chain: OtpChannel[] = [];
  const preempted: OtpChannel[] = [];
  for (const c of [policy.primary, ...policy.fallbacks]) {
    if (chain.includes(c) || preempted.includes(c)) continue;
    const health = available[c];
    if (!health) continue;
    if (health === 'OFFLINE' || health === 'AUTH_FAILED') preempted.push(c);
    else chain.push(c);
  }
  return { chain, preempted };
}

export interface DeliveryFact {
  readonly channel: OtpChannel | 'STAFF';
  readonly status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  readonly sentAt: Date;
}

/** The first channel of the chain not tried yet for this session, or null when the chain is exhausted. */
export function nextChannel(
  chain: readonly OtpChannel[],
  tried: readonly DeliveryFact[],
): OtpChannel | null {
  return chain.find((c) => !tried.some((d) => d.channel === c)) ?? null;
}

/**
 * Automatic fallback (the sweep): the latest delivery has no delivery receipt within the timeout, or failed, and a
 * further channel exists. Returns the channel to use, or null.
 */
export function autoFallback(
  chain: readonly OtpChannel[],
  deliveries: readonly DeliveryFact[],
  policy: OtpPolicy,
  now: Date,
): OtpChannel | null {
  const last = deliveries.at(-1);
  if (!last || last.channel === 'STAFF') return null;
  if (last.status === 'DELIVERED' || last.status === 'READ') return null;
  const due =
    last.status === 'FAILED' ||
    now.getTime() - last.sentAt.getTime() >= policy.fallbackTimeoutSeconds * 1000;
  return due ? nextChannel(chain, deliveries) : null;
}

/**
 * Manual fallback ("Didn't get the code?"): allowed once `manualFallbackAfterSeconds` passed since the last send.
 * Returns the next channel, `WAIT` with the time it becomes available, or `EXHAUSTED` (front desk can assist).
 */
export function manualFallback(
  chain: readonly OtpChannel[],
  deliveries: readonly DeliveryFact[],
  policy: OtpPolicy,
  now: Date,
):
  | { readonly kind: 'SEND'; readonly channel: OtpChannel }
  | { readonly kind: 'WAIT'; readonly until: Date }
  | { readonly kind: 'EXHAUSTED' } {
  const last = deliveries.at(-1);
  if (last) {
    const until = new Date(last.sentAt.getTime() + policy.manualFallbackAfterSeconds * 1000);
    if (now < until) return { kind: 'WAIT', until };
  }
  const channel = nextChannel(chain, deliveries);
  return channel ? { kind: 'SEND', channel } : { kind: 'EXHAUSTED' };
}

/** Channel health from send outcomes: a success heals; repeated unavailability takes the channel offline. */
export function healthAfter(
  current: ChannelHealthState,
  outcome: 'OK' | 'UNAVAILABLE' | 'AUTH_FAILED' | 'OTHER_ERROR',
): ChannelHealthState {
  switch (outcome) {
    case 'OK':
      return 'HEALTHY';
    case 'AUTH_FAILED':
      return 'AUTH_FAILED';
    case 'UNAVAILABLE':
      return current === 'HEALTHY'
        ? 'DEGRADED'
        : current === 'AUTH_FAILED'
          ? 'AUTH_FAILED'
          : 'OFFLINE';
    default:
      return current;
  }
}

// ---- last-name check for the room QR fallback (Spec §20) ----

/** Case-, accent- and spacing-insensitive comparison of family names (Arabic diacritics and tatweel included). */
export function sameFamilyName(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const key = (v: string | null | undefined) =>
    (v ?? '')
      .normalize('NFKD')
      .replace(/[̀-ًͯ-ٰٟـ]/g, '')
      .replace(/[\s'’.-]/g, '')
      .toLocaleLowerCase('en');
  const ka = key(a);
  return ka.length > 0 && ka === key(b);
}
