import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  afterFailure,
  deriveSecret,
  retryDelayMs,
  signatureHeader,
  targetProblem,
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
