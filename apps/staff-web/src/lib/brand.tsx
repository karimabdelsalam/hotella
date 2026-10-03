'use client';

import { useLocale } from 'next-intl';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useSession } from './session';
import type { ResolvedBrand } from './types';

interface StaffBrand {
  /** The brand of the property the current screen works on; null before one is chosen. */
  readonly brand: ResolvedBrand | null;
  /** Screens call this when their property changes. */
  readonly show: (propertyId: string | null) => void;
  /** Re-reads the brand (after a manager changed it). */
  readonly refresh: () => void;
}

const BrandContext = createContext<StaffBrand>({ brand: null, show: () => {}, refresh: () => {} });

/** Only `#rgb`/`#rrggbb` colors reach CSS; anything else keeps the default. */
function safeColor(value: string | undefined): string | null {
  return value && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value : null;
}

/** The hotel's logo through the same-origin proxy; the key in the query changes with every upload (fresh cache). */
export function logoUrl(brand: ResolvedBrand | null): string | null {
  if (!brand?.logoAssetKey) return null;
  return `/hotella/public/branding/logo?property=${encodeURIComponent(brand.propertyId)}&v=${encodeURIComponent(brand.logoAssetKey)}`;
}

/**
 * The staff screens wear the brand of the hotel they work on (CLAUDE.md rule 15: resolved at run time, nothing
 * hotel-specific built in): its logo and name in the header and its colour on primary actions.
 */
export function StaffBrandProvider({ children }: { readonly children: ReactNode }) {
  const locale = useLocale();
  const session = useSession();
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [brand, setBrand] = useState<ResolvedBrand | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!propertyId || session.state !== 'signed-in') return;
    let live = true;
    session
      .api<ResolvedBrand>(
        `/public/branding?property=${encodeURIComponent(propertyId)}&lang=${locale}`,
      )
      .then((b) => live && setBrand(b))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [session, propertyId, locale, tick]);

  useEffect(() => {
    const color = safeColor(brand?.primaryColor);
    if (color) document.documentElement.style.setProperty('--brand-primary', color);
    else document.documentElement.style.removeProperty('--brand-primary');
  }, [brand]);

  const show = useCallback((id: string | null) => setPropertyId(id), []);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const value = useMemo(() => ({ brand, show, refresh }), [brand, show, refresh]);
  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>;
}

export function useStaffBrand(): StaffBrand {
  return useContext(BrandContext);
}
