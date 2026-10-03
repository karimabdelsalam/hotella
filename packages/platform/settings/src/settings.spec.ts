import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { attributionFor } from './attribution';
import { defineSetting, resolveEffective, SettingsRegistry } from './registry';

const CHECKOUT = defineSetting({
  key: 'org.property.checkout_time',
  scopes: ['PLATFORM', 'TENANT', 'PROPERTY'],
  schema: z.string().regex(/^\d{2}:\d{2}$/),
  default: '12:00',
  descriptionKey: 'org.setting.checkout_time',
});

describe('configuration resolution (Spec §72)', () => {
  it('most specific scope wins: property → tenant → platform → default', () => {
    expect(resolveEffective(CHECKOUT, [])).toEqual({
      value: '12:00',
      source: 'DEFAULT',
      version: 0,
    });
    const stored = [
      { scope: 'PLATFORM' as const, value: '11:00', version: 1 },
      { scope: 'TENANT' as const, value: '10:00', version: 3 },
    ];
    expect(resolveEffective(CHECKOUT, stored)).toEqual({
      value: '10:00',
      source: 'TENANT',
      version: 3,
    });
    expect(
      resolveEffective(CHECKOUT, [...stored, { scope: 'PROPERTY', value: '13:00', version: 1 }])
        .value,
    ).toBe('13:00');
  });
  it('skips stored values the schema now rejects and values at scopes the key does not allow', () => {
    const seen: string[] = [];
    const r = resolveEffective(
      CHECKOUT,
      [
        { scope: 'PROPERTY', value: 'late', version: 2 },
        { scope: 'PLATFORM', value: '11:30', version: 1 },
      ],
      (s) => seen.push(s),
    );
    expect(r).toMatchObject({ value: '11:30', source: 'PLATFORM' });
    expect(seen).toEqual(['PROPERTY']);
    const tenantOnly = defineSetting({ ...CHECKOUT, key: 'x.y.z', scopes: ['TENANT'] });
    expect(
      resolveEffective(tenantOnly, [{ scope: 'PROPERTY', value: '09:00', version: 1 }]).source,
    ).toBe('DEFAULT');
  });
  it('definitions are validated when declared and registered once', () => {
    expect(() => defineSetting({ ...CHECKOUT, key: 'bad-key' })).toThrow();
    expect(() => defineSetting({ ...CHECKOUT, default: 'noon' })).toThrow();
    expect(() => defineSetting({ ...CHECKOUT, scopes: [] })).toThrow();
    const registry = new SettingsRegistry();
    registry.register(CHECKOUT);
    registry.register(CHECKOUT); // idempotent for the same definition
    expect(() => registry.register(defineSetting({ ...CHECKOUT }))).toThrow(/twice/);
    expect(registry.all().map((d) => d.key)).toEqual(['org.property.checkout_time']);
  });
  it('attribution is shown unless hidden by a policy citing an entitlement', () => {
    expect(attributionFor(undefined)).toEqual({
      show: true,
      label: 'Powered by Planova',
      href: 'https://planova.com.eg',
    });
    expect(attributionFor({ showPoweredBy: false, overrideEntitlementRef: null }).show).toBe(true);
    expect(attributionFor({ showPoweredBy: false, overrideEntitlementRef: 'lic-wl-1' }).show).toBe(
      false,
    );
  });
});
