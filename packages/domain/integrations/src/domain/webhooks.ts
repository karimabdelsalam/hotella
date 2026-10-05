import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * Outbound webhooks (Spec §75, ADR-0012, BUILD_PLAN 11.5): pure rules — the events a tenant may subscribe to, how a
 * secret is derived, how a delivery is signed, when it is retried and which targets are allowed.
 */

/**
 * Events a webhook may carry: operational facts with ids and codes only (Spec §51). Canonical `hotel.*` events and
 * guest/identity events are not offered: a tenant's PMS already has them, and they would carry guest context.
 */
export const WEBHOOK_EVENTS = [
  'ops.work_item.created.v1',
  'ops.work_item.status_changed.v1',
  'ops.task.assigned.v1',
  'ops.task.status_changed.v1',
  'ops.sla.breached.v1',
  'hk.room.state_changed.v1',
  'hk.room.ready.v1',
  'hk.job.created.v1',
  'hk.job.status_changed.v1',
  'eng.work_order.created.v1',
  'eng.work_order.closed.v1',
  'eng.pm.due.v1',
  'eng.room_restriction.changed.v1',
  'inspection.inspection.completed.v1',
  'inspection.finding.raised.v1',
  'relations.complaint.opened.v1',
  'relations.complaint.resolved.v1',
  'lostfound.item.registered.v1',
  'lostfound.item.released.v1',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 30_000;

/** Delay before attempt `n + 1` after `n` failed attempts: 30 s · 2^(n−1) — 30 s, 1 min, 2 min … about 1 h. */
export function retryDelayMs(failedAttempts: number): number {
  return BASE_DELAY_MS * 2 ** Math.max(0, failedAttempts - 1);
}

/** After a failed attempt: retry later, or give up (the dead-letter state, replayable by staff). */
export function afterFailure(
  failedAttempts: number,
  now: Date,
): { status: 'PENDING'; nextAttemptAt: Date } | { status: 'DEAD' } {
  if (failedAttempts >= WEBHOOK_MAX_ATTEMPTS) return { status: 'DEAD' };
  return {
    status: 'PENDING',
    nextAttemptAt: new Date(now.getTime() + retryDelayMs(failedAttempts)),
  };
}

/** The endpoint's secret: never stored, derived from the platform signing key, the endpoint and its secret version. */
export function deriveSecret(
  signingKey: string,
  endpointId: string,
  secretVersion: number,
): string {
  const mac = createHmac('sha256', signingKey)
    .update(`hotella-webhook:${endpointId}:${secretVersion}`)
    .digest('base64url');
  return `whsec_${mac}`;
}

/**
 * `X-Hotella-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>` — receivers recompute it over the
 * raw body and reject stale timestamps (replay protection on their side).
 */
export function signatureHeader(secret: string, body: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** An inbound endpoint's secret (ADR-0024): derived like an outbound one, in its own namespace so the two never match. */
export function deriveInboundSecret(
  signingKey: string,
  endpointId: string,
  secretVersion: number,
): string {
  const mac = createHmac('sha256', signingKey)
    .update(`hotella-inbound:${endpointId}:${secretVersion}`)
    .digest('base64url');
  return `whin_${mac}`;
}

/** How long a signed inbound request stays acceptable (replay window). */
export const INBOUND_TOLERANCE_SECONDS = 300;

/**
 * Checks `X-Hotella-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>` on an inbound request:
 * the timestamp must be within the window either way and the MAC must match in constant time.
 */
export function verifySignature(
  secret: string,
  header: string | undefined,
  body: Buffer,
  now: Date,
  toleranceSeconds = INBOUND_TOLERANCE_SECONDS,
): 'OK' | 'MISSING' | 'STALE' | 'MISMATCH' {
  const parts = Object.fromEntries(
    (header ?? '')
      .split(',')
      .map((p) => p.trim().split('=', 2))
      .filter((p): p is [string, string] => p.length === 2),
  );
  const t = Number(parts.t);
  if (!header || !Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? '')) return 'MISSING';
  if (Math.abs(Math.floor(now.getTime() / 1000) - t) > toleranceSeconds) return 'STALE';
  const expected = createHmac('sha256', secret).update(`${t}.`).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(parts.v1!, 'hex')) ? 'OK' : 'MISMATCH';
}

export type TargetProblem = 'invalid' | 'insecure' | 'private';

/**
 * A target must be https and must not name a private, loopback or link-local address (no requests into the
 * platform's own network). Development and tests may allow plain http and local addresses explicitly. Host names are
 * checked as written; resolution-time checks belong to the egress proxy of the deployment.
 */
export function targetProblem(raw: string, allowInsecure: boolean): TargetProblem | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'invalid';
  }
  if (url.username || url.password || url.hash) return 'invalid';
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'invalid';
  if (allowInsecure) return null;
  if (url.protocol !== 'https:') return 'insecure';
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
    return 'private';
  if (isIP(host) && isPrivateAddress(host)) return 'private';
  return null;
}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  if (v6.startsWith('::ffff:')) {
    const rest = v6.slice(7);
    // The URL parser writes IPv4-mapped addresses in hex (`::ffff:7f00:1`).
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (!hex) return isIP(rest) === 4 ? isPrivateAddress(rest) : true;
    const [hi, lo] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
    return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6);
}
