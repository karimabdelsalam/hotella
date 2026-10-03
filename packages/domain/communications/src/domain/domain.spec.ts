import { editDistance } from './edit-distance';
import { describe, expect, it } from 'vitest';
import { isE164, maskPhone, toE164 } from './phone';
import {
  attemptGate,
  autoFallback,
  deliveryChain,
  deriveOtp,
  healthAfter,
  manualFallback,
  otpMatches,
  type OtpPolicy,
  sameFamilyName,
} from './otp';

describe('phone numbers as identities (E.164)', () => {
  it.each([
    ['+20 100 123 4567', null, '+201001234567'],
    ['0020 100 123 4567', null, '+201001234567'],
    ['01001234567', 'EG', '+201001234567'],
    ['0100-123-4567', 'eg', '+201001234567'],
    ['(010) 0123 4567', 'EG', '+201001234567'],
    ['050 123 4567', 'AE', '+971501234567'],
    ['+44 7700 900123', 'EG', '+447700900123'],
    ['5551234567', 'US', '+15551234567'],
  ])('%s (%s) → %s', (raw, country, expected) => {
    expect(toE164(raw, country)).toBe(expected);
  });

  it('refuses what it cannot know: no country for a national number, letters, too short or too long', () => {
    expect(toE164('01001234567')).toBeNull();
    expect(toE164('01001234567', 'ZZ')).toBeNull();
    expect(toE164('+20 100 CALL ME')).toBeNull();
    expect(toE164('+20 1')).toBeNull();
    expect(toE164('+1234567890123456')).toBeNull();
    expect(toE164('+0123456789')).toBeNull();
    expect(isE164('+201001234567')).toBe(true);
    expect(isE164('201001234567')).toBe(false);
  });

  it('masks for display', () => {
    expect(maskPhone('+201001234567')).toBe('+20*******567');
  });
});

describe('OTP rules (ADR-0011, ADR-0015)', () => {
  const policy: OtpPolicy = {
    primary: 'WHATSAPP',
    fallbacks: ['SMS', 'VOICE'],
    fallbackTimeoutSeconds: 20,
    manualFallbackAfterSeconds: 30,
  };
  const t0 = new Date('2026-10-03T10:00:00Z');
  const at = (s: number) => new Date(t0.getTime() + s * 1000);

  it('derives a stable 6-digit code per session and seed; compares in constant time', () => {
    const a = deriveOtp('key', 'session-1', 'seed');
    expect(a).toMatch(/^\d{6}$/);
    expect(deriveOtp('key', 'session-1', 'seed')).toBe(a);
    expect(deriveOtp('key', 'session-2', 'seed')).not.toBe(a);
    expect(deriveOtp('other-key', 'session-1', 'seed')).not.toBe(a);
    expect(otpMatches(a, ` ${a} `)).toBe(true);
    expect(otpMatches(a, '12345')).toBe(false);
  });

  it('a session accepts codes until verified, locked or expired', () => {
    const s = { expiresAt: at(300), attempts: 0, maxAttempts: 5, verifiedAt: null, lockedAt: null };
    expect(attemptGate(s, t0)).toBe('OPEN');
    expect(attemptGate({ ...s, attempts: 5 }, t0)).toBe('LOCKED');
    expect(attemptGate({ ...s, lockedAt: t0 }, t0)).toBe('LOCKED');
    expect(attemptGate(s, at(300))).toBe('EXPIRED');
    expect(attemptGate({ ...s, verifiedAt: t0 }, at(400))).toBe('ALREADY_VERIFIED');
  });

  it('builds the chain from configured, healthy channels; unhealthy ones are pre-empted', () => {
    expect(deliveryChain(policy, { WHATSAPP: 'HEALTHY', SMS: 'HEALTHY' })).toEqual({
      chain: ['WHATSAPP', 'SMS'],
      preempted: [],
    });
    expect(deliveryChain(policy, { WHATSAPP: 'DEGRADED', SMS: 'HEALTHY' }).chain).toEqual([
      'WHATSAPP',
      'SMS',
    ]);
    expect(deliveryChain(policy, { WHATSAPP: 'OFFLINE', SMS: 'HEALTHY' })).toEqual({
      chain: ['SMS'],
      preempted: ['WHATSAPP'],
    });
    expect(
      deliveryChain({ ...policy, fallbacks: ['WHATSAPP'] }, { WHATSAPP: 'HEALTHY' }).chain,
    ).toEqual(['WHATSAPP']);
    expect(deliveryChain(policy, {}).chain).toEqual([]);
  });

  it('falls back automatically after the timeout or a failure, never after a receipt', () => {
    const chain = ['WHATSAPP', 'SMS'] as const;
    const sent = [{ channel: 'WHATSAPP' as const, status: 'SENT' as const, sentAt: t0 }];
    expect(autoFallback(chain, sent, policy, at(19))).toBeNull();
    expect(autoFallback(chain, sent, policy, at(20))).toBe('SMS');
    expect(autoFallback(chain, [{ ...sent[0]!, status: 'FAILED' }], policy, at(1))).toBe('SMS');
    expect(autoFallback(chain, [{ ...sent[0]!, status: 'DELIVERED' }], policy, at(60))).toBeNull();
    const both = [...sent, { channel: 'SMS' as const, status: 'SENT' as const, sentAt: at(20) }];
    expect(autoFallback(chain, both, policy, at(90))).toBeNull();
    expect(autoFallback(chain, [], policy, at(90))).toBeNull();
  });

  it('manual fallback waits for its delay and ends at the last channel', () => {
    const chain = ['WHATSAPP', 'SMS'] as const;
    const sent = [{ channel: 'WHATSAPP' as const, status: 'SENT' as const, sentAt: t0 }];
    expect(manualFallback(chain, sent, policy, at(10))).toEqual({ kind: 'WAIT', until: at(30) });
    expect(manualFallback(chain, sent, policy, at(30))).toEqual({ kind: 'SEND', channel: 'SMS' });
    const both = [...sent, { channel: 'SMS' as const, status: 'SENT' as const, sentAt: at(30) }];
    expect(manualFallback(chain, both, policy, at(70))).toEqual({ kind: 'EXHAUSTED' });
  });

  it('channel health: success heals, unavailability degrades then takes offline, auth failures stick', () => {
    expect(healthAfter('HEALTHY', 'UNAVAILABLE')).toBe('DEGRADED');
    expect(healthAfter('DEGRADED', 'UNAVAILABLE')).toBe('OFFLINE');
    expect(healthAfter('OFFLINE', 'OK')).toBe('HEALTHY');
    expect(healthAfter('HEALTHY', 'AUTH_FAILED')).toBe('AUTH_FAILED');
    expect(healthAfter('AUTH_FAILED', 'UNAVAILABLE')).toBe('AUTH_FAILED');
    expect(healthAfter('DEGRADED', 'OTHER_ERROR')).toBe('DEGRADED');
  });

  it('family names compare without case, accents, spaces or Arabic diacritics', () => {
    expect(sameFamilyName('El-Masry', 'el masry')).toBe(true);
    expect(sameFamilyName('Müller', 'MULLER')).toBe(true);
    expect(sameFamilyName('المَصْري', 'المصري')).toBe(true);
    expect(sameFamilyName('Nile', 'Delta')).toBe(false);
    expect(sameFamilyName(null, '')).toBe(false);
  });
});

describe('edit distance of an AI draft', () => {
  it('counts code-point insertions, deletions and substitutions', () => {
    expect(editDistance('', '')).toBe(0);
    expect(editDistance('abc', '')).toBe(3);
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('حاضر', 'حاضر')).toBe(0);
    expect(editDistance('حاضر يا فندم', 'حاضر يا مدام')).toBe(3);
    // An emoji is one code point, not two UTF-16 units.
    expect(editDistance('ok 👍', 'ok')).toBe(2);
  });
});
