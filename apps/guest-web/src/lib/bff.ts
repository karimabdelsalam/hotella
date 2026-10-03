import 'server-only';
import { type NextRequest, NextResponse } from 'next/server';
import { webConfig } from './config';

/**
 * The guest session token never reaches page scripts (ADR-0011): it lives in this httpOnly cookie, set by the BFF when
 * activation succeeds and turned into the `X-Guest-Session` header by the API proxy. `Lax`, so a guest opening the
 * app from a WhatsApp link stays signed in.
 */
export const GUEST_COOKIE = 'hotella_gs';
export const GUEST_SESSION_HEADER = 'x-guest-session';

interface OpenedSession {
  readonly sessionToken: string;
  readonly expiresAt: string;
  readonly scopes: readonly string[];
}

/** Calls the API from the web server, forwarding the caller's language and address. */
export async function callApi(
  req: NextRequest,
  path: string,
  body: unknown,
  session?: string | null,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const lang = req.headers.get('accept-language');
  if (lang) headers['accept-language'] = lang;
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) headers['x-forwarded-for'] = forwarded;
  if (session) headers[GUEST_SESSION_HEADER] = session;
  return fetch(`${webConfig().apiUrl}${path}`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
}

/** Passes an API answer through unchanged (status and RFC 9457 problem details). */
export async function passThrough(res: Response): Promise<NextResponse> {
  const text = await res.text();
  return new NextResponse(text || null, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/problem+json' },
  });
}

/** Keeps the session token in the cookie and answers with what the page may know. */
export function withGuestSession(opened: OpenedSession): NextResponse {
  const res = NextResponse.json({ expiresAt: opened.expiresAt, scopes: opened.scopes });
  res.cookies.set(GUEST_COOKIE, opened.sessionToken, {
    httpOnly: true,
    secure: webConfig().secureCookies,
    sameSite: 'lax',
    path: '/',
    expires: new Date(opened.expiresAt),
  });
  res.headers.set('cache-control', 'no-store');
  return res;
}

export function clearGuestSession(res: NextResponse): NextResponse {
  res.cookies.set(GUEST_COOKIE, '', {
    httpOnly: true,
    secure: webConfig().secureCookies,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}

/** A short device description for the guest's session list (no fingerprinting, just the browser's own string). */
export function deviceOf(req: NextRequest): string | undefined {
  return req.headers.get('user-agent')?.slice(0, 200) || undefined;
}
