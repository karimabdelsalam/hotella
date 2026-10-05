import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  afterFailure,
  deriveInboundSecret,
  deriveSecret,
  INBOUND_TOLERANCE_SECONDS,
  retryDelayMs,
  signatureHeader,
  targetProblem,
  verifySignature,
  WEBHOOK_EVENTS,
  WEBHOOK_MAX_ATTEMPTS,
} from './webhooks';

describe('webhook rules', () => {
  it('offers no canonical PMS, guest or identity events', () => {
    for (const e of WEBHOOK_EVENTS) expect(e).not.toMatch(/^(hotel|guest|iam|comms|ai)\./);
  });

  it('backs off exponentially from 30 seconds and gives up after the last attempt', () => {
    expect([1, 2, 3, 8].map(retryDelayMs)).toEqual([30_000, 60_000, 120_000, 3_840_000]);
    const now = new Date('2026-10-04T10:00:00Z');
    expect(afterFailure(1, now)).toEqual({
      status: 'PENDING',
      nextAttemptAt: new Date('2026-10-04T10:00:30Z'),
    });
    expect(afterFailure(WEBHOOK_MAX_ATTEMPTS - 1, now).status).toBe('PENDING');
    expect(afterFailure(WEBHOOK_MAX_ATTEMPTS, now)).toEqual({ status: 'DEAD' });
  });

  it('derives a stable secret per endpoint and version, never the key itself', () => {
    const a = deriveSecret('platform-key', 'ep-1', 1);
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(deriveSecret('platform-key', 'ep-1', 1)).toBe(a);
    expect(deriveSecret('platform-key', 'ep-1', 2)).not.toBe(a);
    expect(deriveSecret('platform-key', 'ep-2', 1)).not.toBe(a);
    expect(deriveSecret('other-key', 'ep-1', 1)).not.toBe(a);
  });

  it('signs "<t>.<body>" with HMAC-SHA256', () => {
    const at = new Date('2026-10-04T10:00:00.900Z');
    const header = signatureHeader('whsec_x', '{"a":1}', at);
    const t = Math.floor(at.getTime() / 1000);
    const v1 = createHmac('sha256', 'whsec_x').update(`${t}.{"a":1}`).digest('hex');
    expect(header).toBe(`t=${t},v1=${v1}`);
  });

  it('accepts only public https targets unless insecure targets are allowed', () => {
    expect(targetProblem('https://hooks.example.com/hotella', false)).toBeNull();
    expect(targetProblem('not a url', false)).toBe('invalid');
    expect(targetProblem('ftp://example.com', false)).toBe('invalid');
    expect(targetProblem('https://user:pw@example.com', false)).toBe('invalid');
    expect(targetProblem('http://example.com', false)).toBe('insecure');
    for (const host of [
      'localhost',
      'api.localhost',
      'db.internal',
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.10',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '[::1]',
      '[fd00::1]',
      '[fe80::1]',
      '[::ffff:127.0.0.1]',
    ])
      expect(targetProblem(`https://${host}/x`, false), host).toBe('private');
    expect(targetProblem('https://172.32.0.1/x', false)).toBeNull();
    expect(targetProblem('http://127.0.0.1:8080/x', true)).toBeNull();
  });
});

describe('signed inbound requests', () => {
  const key = 'k'.repeat(32);
  const body = Buffer.from('{"messages":[]}');
  const now = new Date('2026-10-05T12:00:00Z');
  const t = Math.floor(now.getTime() / 1000);
  const sign = (secret: string, at: number, raw = body) =>
    `t=${at},v1=${createHmac('sha256', secret).update(`${at}.`).update(raw).digest('hex')}`;

  it('derives a distinct secret per endpoint and per rotation', () => {
    const a1 = deriveInboundSecret(key, 'a', 1);
    expect(a1).toMatch(/^whin_[A-Za-z0-9_-]{43}$/);
    expect(deriveInboundSecret(key, 'a', 1)).toBe(a1);
    expect(deriveInboundSecret(key, 'a', 2)).not.toBe(a1);
    expect(deriveInboundSecret(key, 'b', 1)).not.toBe(a1);
    // Outbound and inbound secrets never coincide for the same id.
    expect(deriveSecret(key, 'a', 1)).not.toBe(a1);
  });

  it('accepts a fresh, correctly signed body', () => {
    const secret = deriveInboundSecret(key, 'a', 1);
    expect(verifySignature(secret, sign(secret, t), body, now)).toBe('OK');
    expect(verifySignature(secret, sign(secret, t - INBOUND_TOLERANCE_SECONDS), body, now)).toBe(
      'OK',
    );
  });

  it('refuses a missing, malformed, stale, tampered or foreign signature', () => {
    const secret = deriveInboundSecret(key, 'a', 1);
    expect(verifySignature(secret, undefined, body, now)).toBe('MISSING');
    expect(verifySignature(secret, 'v1=abc', body, now)).toBe('MISSING');
    expect(verifySignature(secret, `t=${t},v1=zz`, body, now)).toBe('MISSING');
    expect(
      verifySignature(secret, sign(secret, t - INBOUND_TOLERANCE_SECONDS - 1), body, now),
    ).toBe('STALE');
    expect(verifySignature(secret, sign(secret, t + 3600), body, now)).toBe('STALE');
    expect(verifySignature(secret, sign(secret, t), Buffer.from('{"messages":[{}]}'), now)).toBe(
      'MISMATCH',
    );
    expect(verifySignature(secret, sign(deriveInboundSecret(key, 'a', 2), t), body, now)).toBe(
      'MISMATCH',
    );
  });
});
