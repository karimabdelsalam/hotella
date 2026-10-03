import { describe, expect, it } from 'vitest';
import {
  brandAssetPrefix,
  mergeBrand,
  PLATFORM_BRAND_DEFAULTS,
  sniffBrandImage,
} from './domain/branding';
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

describe('brand images', () => {
  const bytes = (...b: number[]) => Uint8Array.from([...b, ...new Array(16).fill(0)]);
  it('reads the type from the bytes and refuses anything else (SVG included)', () => {
    expect(sniffBrandImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(
      'image/png',
    );
    expect(sniffBrandImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffBrandImage(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))).toBe(
      'image/webp',
    );
    expect(
      sniffBrandImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBe(null);
    expect(sniffBrandImage(new Uint8Array())).toBe(null);
  });
  it('keeps each tenant under its own prefix', () => {
    expect(brandAssetPrefix('t-1')).toBe('brand/t-1/');
  });
});
