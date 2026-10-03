'use client';

import { useLocale } from 'next-intl';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/** An API failure: the HTTP status and the problem-details `code`/`detail` (already localized by the API). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly detail: string | null,
  ) {
    super(code ?? `HTTP ${status}`);
  }
}

interface Session {
  readonly state: 'loading' | 'anonymous' | 'signed-in';
  /** Calls the Hotella API through the same-origin proxy with the in-memory access token. */
  api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
  signIn(input: {
    tenantCode?: string;
    email: string;
    password: string;
  }): Promise<{ challengeToken: string } | null>;
  verifyMfa(challengeToken: string, code: string): Promise<void>;
  signOut(): Promise<void>;
  /** The current access token (for the realtime handshake); never stored anywhere. */
  token(): string | null;
}

const SessionContext = createContext<Session | null>(null);

async function problem(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { code?: string; detail?: string } | null;
  return new ApiError(res.status, body?.code ?? null, body?.detail ?? null);
}

/**
 * Staff session in the browser (ADR-0011): the access token lives only in memory and is renewed through the BFF
 * before it expires; the refresh token stays in an httpOnly cookie the page cannot read.
 */
export function SessionProvider({ children }: { readonly children: ReactNode }) {
  const locale = useLocale();
  const [state, setState] = useState<Session['state']>('loading');
  const access = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const renew = useRef<() => Promise<boolean>>(async () => false);

  const accept = useCallback((tokens: { accessToken: string; expiresIn: number }) => {
    access.current = tokens.accessToken;
    setState('signed-in');
    if (timer.current) clearTimeout(timer.current);
    // Renew a minute before expiry (never less than 10 s from now).
    timer.current = setTimeout(
      () => void renew.current(),
      Math.max(10, tokens.expiresIn - 60) * 1000,
    );
  }, []);

  const refresh = useCallback(async (): Promise<boolean> => {
    const res = await fetch('/bff/refresh', {
      method: 'POST',
      headers: { 'accept-language': locale },
    });
    if (!res.ok) {
      access.current = null;
      setState('anonymous');
      return false;
    }
    accept((await res.json()) as { accessToken: string; expiresIn: number });
    return true;
  }, [accept, locale]);
  renew.current = refresh;

  useEffect(() => {
    void refresh();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refresh]);

  const api = useCallback(
    async <T,>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
      const call = () =>
        fetch(`/hotella${path}`, {
          method: init.method ?? 'GET',
          headers: {
            'accept-language': locale,
            ...(access.current ? { authorization: `Bearer ${access.current}` } : {}),
            ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        });
      let res = await call();
      if (res.status === 401 && (await refresh())) res = await call();
      if (!res.ok) throw await problem(res);
      return (res.status === 204 ? undefined : await res.json()) as T;
    },
    [locale, refresh],
  );

  const value = useMemo<Session>(
    () => ({
      state,
      api,
      token: () => access.current,
      async signIn(input) {
        const res = await fetch('/bff/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'accept-language': locale },
          body: JSON.stringify(input),
        });
        if (!res.ok) throw await problem(res);
        const body = (await res.json()) as {
          mfaRequired?: boolean;
          challengeToken?: string;
          accessToken?: string;
          expiresIn?: number;
        };
        if (body.mfaRequired) return { challengeToken: body.challengeToken! };
        accept(body as { accessToken: string; expiresIn: number });
        return null;
      },
      async verifyMfa(challengeToken, code) {
        const res = await fetch('/bff/mfa', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'accept-language': locale },
          body: JSON.stringify({ challengeToken, code }),
        });
        if (!res.ok) throw await problem(res);
        accept((await res.json()) as { accessToken: string; expiresIn: number });
      },
      async signOut() {
        await fetch('/bff/logout', {
          method: 'POST',
          headers: access.current ? { authorization: `Bearer ${access.current}` } : {},
        });
        access.current = null;
        if (timer.current) clearTimeout(timer.current);
        setState('anonymous');
      },
    }),
    [state, api, accept, locale],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}
