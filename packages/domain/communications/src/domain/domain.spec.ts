import { describe, expect, it } from 'vitest';
import { isE164, maskPhone, toE164 } from './phone';

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
