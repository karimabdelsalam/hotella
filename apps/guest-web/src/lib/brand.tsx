'use client';

import {
  createContext,
  type CSSProperties,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react';
import { useLocale } from 'next-intl';
import { AttributionFooter } from '@hotella/ui';
import { api } from './api';
import type { Branding } from './types';

interface BrandState {
  readonly brand: Branding | null;
  /** Loads the property's guest-web brand (activation pages know the property before any session exists). */
  readonly load: (propertyId: string) => void;
  readonly set: (brand: Branding | null) => void;
}

const BrandContext = createContext<BrandState>({ brand: null, load: () => {}, set: () => {} });

/** Only `#rgb`/`#rrggbb` colors reach CSS; anything else keeps the neutral default. */
function safeColor(value: string | undefined): string | undefined {
  return value && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value : undefined;
}

/**
 * Branding resolves dynamically (platform → tenant → property → channel, CLAUDE.md rule 15): the hotel's name and
 * color come from the API; the attribution footer's visibility comes from the platform policy, never from the brand.
 */
export function BrandProvider({ children }: { readonly children: ReactNode }) {
  const locale = useLocale();
  const [brand, setBrand] = useState<Branding | null>(null);
  const [propertyId, setPropertyId] = useState<string | null>(null);

  useEffect(() => {
    if (!propertyId) return;
    let live = true;
    api<Branding>(
      `public/branding?property=${encodeURIComponent(propertyId)}&channel=GUEST_WEB&lang=${locale}`,
      locale,
    )
      .then((b) => live && setBrand(b))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [propertyId, locale]);

  const color = safeColor(brand?.primaryColor);
  return (
    <BrandContext.Provider value={{ brand, load: setPropertyId, set: setBrand }}>
      <div
        className="flex min-h-full flex-1 flex-col"
        style={color ? ({ '--brand-primary': color } as CSSProperties) : undefined}
      >
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        <AttributionFooter show={brand?.attribution.show ?? true} />
      </div>
    </BrandContext.Provider>
  );
}

export function useBrand(): BrandState {
  return useContext(BrandContext);
}
