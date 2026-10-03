import { describe, expect, it } from 'vitest';
import { mergeBrand, PLATFORM_BRAND_DEFAULTS } from './domain/branding';
import { attributionFor } from '@hotella/platform-settings';
import { normalizeCode, PLATFORM_ATTRIBUTION } from './domain/values';

describe('mergeBrand', () => {
  it('layers override field by field and attribution is always present', () => {
    const b = mergeBrand(
      'p1',
      'GUEST_WEB',
      'ar',
      'Nile Palace',
      [
        { name: 'tenant', layer: { primaryColor: '#112233', displayName: 'Nile Group' } },
        { name: 'organization', layer: null },
        { name: 'property', layer: { displayName: 'قصر النيل', typography: { arabic: 'Cairo' } } },
        { name: 'channel', layer: { presentation: { compact: true }, coverAssetKeys: [] } },
      ],
      attributionFor(null),
    );
    expect(b.displayName).toBe('قصر النيل');
    expect(b.primaryColor).toBe('#112233');
    expect(b.secondaryColor).toBe(PLATFORM_BRAND_DEFAULTS.secondaryColor);
    expect(b.typography).toEqual({ heading: 'Inter', body: 'Inter', arabic: 'Cairo' });
    expect(b.direction).toBe('rtl');
    expect(b.attribution).toEqual({ show: true, ...PLATFORM_ATTRIBUTION });
    expect(b.layers).toEqual(['platform', 'tenant', 'property', 'channel']);
  });
  it('falls back to the property name and platform defaults with no layers', () => {
    const b = mergeBrand('p1', null, 'en', 'Nile Palace', [], attributionFor(null));
    expect(b.displayName).toBe('Nile Palace');
    expect(b.layers).toEqual(['platform']);
    expect(Object.isFrozen(b.attribution)).toBe(true);
  });
});

describe('attribution policy', () => {
  it('stays visible unless the policy hides it AND cites an entitlement', () => {
    expect(attributionFor(null).show).toBe(true);
    expect(attributionFor({ showPoweredBy: false, overrideEntitlementRef: null }).show).toBe(true);
    expect(attributionFor({ showPoweredBy: true, overrideEntitlementRef: 'ent-1' }).show).toBe(
      true,
    );
    const hidden = attributionFor({ showPoweredBy: false, overrideEntitlementRef: 'ent-1' });
    expect(hidden).toEqual({
      show: false,
      label: 'Powered by Planova',
      href: 'https://planova.com.eg',
    });
  });
});

describe('normalizeCode', () => {
  it('uppercases and validates', () => {
    expect(normalizeCode(' nile palace ')).toBe('NILE_PALACE');
    expect(() => normalizeCode('x')).toThrow();
    expect(() => normalizeCode('bad code!')).toThrow();
  });
});
