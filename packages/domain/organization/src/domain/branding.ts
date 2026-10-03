import { PLATFORM_ATTRIBUTION } from './values';

export interface BrandLayer {
  readonly displayName?: string | null;
  readonly logoAssetKey?: string | null;
  readonly logoAltAssetKey?: string | null;
  readonly primaryColor?: string | null;
  readonly secondaryColor?: string | null;
  readonly coverAssetKeys?: readonly string[] | null;
  readonly faviconAssetKey?: string | null;
  readonly typography?: Record<string, unknown> | null;
  readonly contact?: Record<string, unknown> | null;
  readonly social?: Record<string, unknown> | null;
  readonly aiPersona?: Record<string, unknown> | null;
  readonly presentation?: Record<string, unknown> | null;
  readonly welcomeText?: string | null;
  readonly farewellText?: string | null;
}

export interface ResolvedBrand {
  readonly propertyId: string;
  readonly channel: string | null;
  readonly locale: string;
  readonly displayName: string;
  readonly logoAssetKey: string | null;
  readonly logoAltAssetKey: string | null;
  readonly primaryColor: string;
  readonly secondaryColor: string;
  readonly coverAssetKeys: readonly string[];
  readonly faviconAssetKey: string | null;
  readonly typography: Record<string, unknown>;
  readonly contact: Record<string, unknown>;
  readonly social: Record<string, unknown>;
  readonly aiPersona: Record<string, unknown>;
  readonly presentation: Record<string, unknown>;
  readonly welcomeText: string | null;
  readonly farewellText: string | null;
  readonly direction: 'ltr' | 'rtl';
  /** Always present; never overridable by brand layers (Spec invariant 33). */
  readonly attribution: typeof PLATFORM_ATTRIBUTION;
  /** Which layers contributed, for admin debugging. */
  readonly layers: readonly string[];
}

/** Platform defaults: neutral, never a hotel's identity (Spec: nothing hotel-specific hardcoded). */
export const PLATFORM_BRAND_DEFAULTS: Required<
  Omit<BrandLayer, 'displayName' | 'welcomeText' | 'farewellText'>
> & { displayName: null; welcomeText: null; farewellText: null } = {
  displayName: null,
  logoAssetKey: null,
  logoAltAssetKey: null,
  primaryColor: '#1F2937',
  secondaryColor: '#6B7280',
  coverAssetKeys: [],
  faviconAssetKey: null,
  typography: { heading: 'Inter', body: 'Inter', arabic: 'IBM Plex Sans Arabic' },
  contact: {},
  social: {},
  aiPersona: { tone: 'warm-professional' },
  presentation: {},
  welcomeText: null,
  farewellText: null,
};

/**
 * Pure merge: later layers override earlier ones field by field (null/undefined never overrides).
 * Order: platform → tenant → organization → property → channel. Attribution is appended last and cannot be overridden.
 */
export function mergeBrand(
  propertyId: string,
  channel: string | null,
  locale: string,
  propertyName: string,
  layers: ReadonlyArray<{ name: string; layer: BrandLayer | null }>,
): ResolvedBrand {
  const acc: Record<string, unknown> = { ...PLATFORM_BRAND_DEFAULTS };
  const used: string[] = ['platform'];
  for (const { name, layer } of layers) {
    if (!layer) continue;
    let touched = false;
    for (const [k, v] of Object.entries(layer)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0)
        continue;
      acc[k] =
        typeof v === 'object' && !Array.isArray(v)
          ? { ...(acc[k] as Record<string, unknown>), ...(v as Record<string, unknown>) }
          : v;
      touched = true;
    }
    if (touched) used.push(name);
  }
  const base = locale.split('-')[0];
  return {
    propertyId,
    channel,
    locale,
    displayName: (acc['displayName'] as string | null) ?? propertyName,
    logoAssetKey: (acc['logoAssetKey'] as string | null) ?? null,
    logoAltAssetKey: (acc['logoAltAssetKey'] as string | null) ?? null,
    primaryColor: acc['primaryColor'] as string,
    secondaryColor: acc['secondaryColor'] as string,
    coverAssetKeys: acc['coverAssetKeys'] as string[],
    faviconAssetKey: (acc['faviconAssetKey'] as string | null) ?? null,
    typography: acc['typography'] as Record<string, unknown>,
    contact: acc['contact'] as Record<string, unknown>,
    social: acc['social'] as Record<string, unknown>,
    aiPersona: acc['aiPersona'] as Record<string, unknown>,
    presentation: acc['presentation'] as Record<string, unknown>,
    welcomeText: (acc['welcomeText'] as string | null) ?? null,
    farewellText: (acc['farewellText'] as string | null) ?? null,
    direction: base === 'ar' || base === 'he' || base === 'fa' || base === 'ur' ? 'rtl' : 'ltr',
    attribution: PLATFORM_ATTRIBUTION,
    layers: used,
  };
}
