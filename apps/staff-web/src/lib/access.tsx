'use client';

import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { useSession } from './session';
import type { Me, PropertySummary } from './types';

/** The permissions a person holds at a property (tenant-wide memberships count everywhere). */
export function permissionsAt(me: Me, propertyId: string | null): Set<string> {
  return new Set(
    me.memberships
      .filter((m) => m.propertyId === null || m.propertyId === propertyId)
      .flatMap((m) => m.permissions),
  );
}

/** Whether the person holds a permission anywhere (to show a section at all). */
export function holdsAnywhere(me: Me, permission: string): boolean {
  return me.memberships.some((m) => m.permissions.includes(permission));
}

const MeContext = createContext<Me | null>(null);
/** The licensed capability codes (Spec §58) anywhere in the tenant; null while unknown (then nothing is hidden). */
const EntitlementsContext = createContext<ReadonlySet<string> | null>(null);

/** Who is signed in (`/me`), loaded once per session for the header and the screens. */
export function MeProvider({ children }: { readonly children: ReactNode }) {
  const session = useSession();
  const [me, setMe] = useState<Me | null>(null);
  const [entitlements, setEntitlements] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (session.state !== 'signed-in') {
      setMe(null);
      setEntitlements(null);
      return;
    }
    let live = true;
    session
      .api<Me>('/me')
      .then((m) => live && setMe(m))
      .catch(() => undefined);
    // The licence only hides what cannot be used; the API refuses it anyway, so a failed read hides nothing.
    session
      .api<{ unrestricted: boolean; codes: string[] }>('/me/entitlements')
      .then((e) => live && setEntitlements(e.unrestricted ? null : new Set(e.codes)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [session]);
  return (
    <MeContext.Provider value={me}>
      <EntitlementsContext.Provider value={entitlements}>{children}</EntitlementsContext.Provider>
    </MeContext.Provider>
  );
}

/** Whether the hotel's licence includes a capability (true while the licence is unknown). */
export function useEntitled(): (capability: string) => boolean {
  const entitlements = useContext(EntitlementsContext);
  return (capability) => entitlements === null || entitlements.has(capability);
}

export function useMe(): Me | null {
  return useContext(MeContext);
}

/**
 * The properties where the person holds a permission, and the one the screen works on (the first by default).
 * Null while loading.
 */
export function usePropertiesWith(permission: string) {
  const session = useSession();
  const me = useMe();
  const [properties, setProperties] = useState<PropertySummary[] | null>(null);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  useEffect(() => {
    if (!me || session.state !== 'signed-in') return;
    let live = true;
    session
      .api<PropertySummary[]>('/properties')
      .then((all) => {
        if (!live) return;
        const allowed = all.filter((p) => permissionsAt(me, p.id).has(permission));
        setProperties(allowed);
        setPropertyId((current) => current ?? allowed[0]?.id ?? null);
      })
      .catch((e: unknown) => live && setFailed(e));
    return () => {
      live = false;
    };
  }, [session, me, permission]);
  return { me, properties, propertyId, setPropertyId, failed };
}
