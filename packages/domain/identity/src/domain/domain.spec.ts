import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { findLocalesDir } from '@hotella/platform-i18n';
import { PERMISSION_RE } from '@hotella/platform-manifest';
import {
  applicableGrants,
  effectivePermissions,
  hasPermission,
  type MembershipGrant,
  missingForDelegation,
} from './access';
import { checkPasswordPolicy, hashPassword, verifyPassword } from './passwords';
import { roleDescriptionKey, roleNameKey, SYSTEM_ROLES } from './system-roles';
import { generateOpaqueToken, seal, sha256Hex, unseal } from './tokens';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totp,
  verifyTotp,
} from './totp';

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  // RFC 6238 Appendix B, SHA-1 seed "12345678901234567890"; we use 6 digits (the RFC lists 8).
  const seed = base32Encode(Buffer.from('12345678901234567890'));
  it('base32 round-trips and matches the RFC seed encoding', () => {
    expect(seed).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(seed).toString()).toBe('12345678901234567890');
    const raw = randomBytes(20);
    expect(base32Decode(base32Encode(raw)).equals(raw)).toBe(true);
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('t=%i → %s', (seconds, code) => {
    expect(totp(seed, seconds * 1000)).toBe(code);
  });
  it('RFC 4226 HOTP vectors', () => {
    const secret = Buffer.from('12345678901234567890');
    expect(['755224', '287082', '359152'].map((_, i) => hotp(secret, i))).toEqual([
      '755224',
      '287082',
      '359152',
    ]);
  });
  it('accepts ±1 step, rejects replays and wrong codes', () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(seed, totp(seed, now - 30_000), now, null)).toBe(step - 1);
    expect(verifyTotp(seed, totp(seed, now), now, null)).toBe(step);
    expect(verifyTotp(seed, totp(seed, now), now, step)).toBeNull(); // same step already used
    expect(verifyTotp(seed, totp(seed, now - 90_000), now, null)).toBeNull(); // outside window
    expect(verifyTotp(seed, '12345', now, null)).toBeNull();
    expect(verifyTotp(seed, 'abcdef', now, null)).toBeNull();
  });
  it('builds an otpauth URI authenticator apps accept', () => {
    const uri = otpauthUri(seed, 'Hotella', 'gm@nile.example');
    expect(uri).toMatch(/^otpauth:\/\/totp\/Hotella%3Agm%40nile\.example\?/);
    expect(new URL(uri).searchParams.get('secret')).toBe(seed);
  });
});

describe('passwords', () => {
  it('hashes with argon2id at the pinned parameters and verifies', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(h, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(h, 'wrong horse battery staple')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
  it('length policy without composition rules; no e-mail name inside', () => {
    expect(checkPasswordPolicy('short', null)).toBe('too_short');
    expect(checkPasswordPolicy('x'.repeat(129), null)).toBe('too_long');
    expect(checkPasswordPolicy('karim-loves-hotels', 'karim@nile.example')).toBe('contains_email');
    expect(checkPasswordPolicy('quiet river morning', 'karim@nile.example')).toBeNull();
  });
});

describe('opaque tokens and sealing', () => {
  it('tokens are prefixed, random and stored only as SHA-256', () => {
    const a = generateOpaqueToken('rt');
    expect(a).toMatch(/^rt_[A-Za-z0-9_-]{43}$/);
    expect(generateOpaqueToken('rt')).not.toBe(a);
    expect(sha256Hex(a)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('AES-256-GCM seals round-trip and detect tampering', () => {
    const key = randomBytes(32);
    const sealed = seal('JBSWY3DPEHPK3PXP', key);
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(unseal(sealed, key)).toBe('JBSWY3DPEHPK3PXP');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => unseal(parts.join('.'), key)).toThrow();
    expect(() => unseal(sealed, randomBytes(32))).toThrow();
  });
});

describe('effective permissions (Membership → Role → Permission)', () => {
  const T = 'tenant-a';
  const grants: MembershipGrant[] = [
    {
      membershipId: 'm-hk',
      tenantId: T,
      propertyId: 'prop-a',
      permissions: new Set(['hk.task.assign']),
    },
    {
      membershipId: 'm-eng',
      tenantId: T,
      propertyId: 'prop-b',
      permissions: new Set(['eng.wo.assign']),
    },
    {
      membershipId: 'm-all',
      tenantId: T,
      propertyId: null,
      permissions: new Set(['org.property.read']),
    },
  ];
  it('a user can hold different permissions at different properties without leakage', () => {
    expect(hasPermission(grants, 'hk.task.assign', { tenantId: T, propertyId: 'prop-a' })).toBe(
      true,
    );
    expect(hasPermission(grants, 'eng.wo.assign', { tenantId: T, propertyId: 'prop-a' })).toBe(
      false,
    );
    expect(hasPermission(grants, 'eng.wo.assign', { tenantId: T, propertyId: 'prop-b' })).toBe(
      true,
    );
    expect(hasPermission(grants, 'hk.task.assign', { tenantId: T, propertyId: 'prop-b' })).toBe(
      false,
    );
  });
  it('tenant-wide memberships cover every property; property ones never cover tenant scope', () => {
    expect(hasPermission(grants, 'org.property.read', { tenantId: T, propertyId: 'prop-z' })).toBe(
      true,
    );
    expect(hasPermission(grants, 'hk.task.assign', { tenantId: T, propertyId: null })).toBe(false);
    expect(effectivePermissions(grants, { tenantId: T, propertyId: 'prop-a' })).toEqual([
      'hk.task.assign',
      'org.property.read',
    ]);
  });
  it('never crosses tenants', () => {
    expect(applicableGrants(grants, { tenantId: 'tenant-b', propertyId: 'prop-a' })).toEqual([]);
    expect(applicableGrants(grants, { tenantId: null, propertyId: null })).toEqual([]);
  });
  it('delegation needs every permission being granted', () => {
    expect(missingForDelegation(new Set(['a.b.c']), ['a.b.c', 'x.y.z', 'x.y.z'])).toEqual([
      'x.y.z',
    ]);
    expect(missingForDelegation(new Set(['a.b.c']), ['a.b.c'])).toEqual([]);
  });
});

// Every granted permission must be declared by a module manifest: checked in apps/api (test/role-catalog.spec.ts),
// where all contexts are composed — contexts that depend on identity (operations…) cannot be imported here.
describe('system role catalog', () => {
  const locales = ['en', 'ar'].map(
    (l) =>
      JSON.parse(readFileSync(join(findLocalesDir(), l, 'identity.json'), 'utf8')) as Record<
        string,
        string
      >,
  );
  it('covers the agreed roles, each with en/ar names and well-formed permissions', () => {
    expect(SYSTEM_ROLES.map((r) => r.code)).toEqual([
      'PLATFORM_ADMIN',
      'SUPPORT',
      'GENERAL_MANAGER',
      'DUTY_MANAGER',
      'HK_SUPERVISOR',
      'ROOM_ATTENDANT',
      'ENGINEER',
      'FRONT_DESK',
      'GUEST_RELATIONS',
    ]);
    for (const role of SYSTEM_ROLES) {
      for (const p of role.permissions) expect(p, role.code).toMatch(PERMISSION_RE);
      for (const catalog of locales) {
        expect(catalog[roleNameKey(role.code)]).toBeTruthy();
        expect(catalog[roleDescriptionKey(role.code)]).toBeTruthy();
      }
    }
  });
  it('platform roles cannot approve their own support access (Spec §64)', () => {
    for (const role of SYSTEM_ROLES.filter((r) => r.audience === 'PLATFORM'))
      expect(role.permissions).not.toContain('support.access.approve');
  });
});
