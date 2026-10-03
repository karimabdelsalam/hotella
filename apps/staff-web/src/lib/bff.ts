import 'server-only';
import { type NextRequest, NextResponse } from 'next/server';
import { webConfig } from './config';

/** The refresh token never reaches page scripts: httpOnly, SameSite=Strict, scoped to the BFF routes. */
export const REFRESH_COOKIE = 'hotella_rt';

interface IssuedTokens {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly refreshToken: string;
  readonly refreshExpiresAt: string;
}

/** Calls the API from the web server, forwarding the caller's language for localized problem details. */
export async function callApi(
  req: NextRequest,
  path: string,
  body: unknown,
  bearer?: string | null,
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const lang = req.headers.get('accept-language');
  if (lang) headers['accept-language'] = lang;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) headers['x-forwarded-for'] = forwarded;
  return fetch(`${webConfig().apiUrl}${path}`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
}

/** Passes an API error through unchanged (status and RFC 9457 problem details). */
export async function passThrough(res: Response): Promise<NextResponse> {
  const text = await res.text();
  return new NextResponse(text || null, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/problem+json' },
  });
}

/** Answers with the access token only and keeps the refresh token in the cookie. */
export function withSession(tokens: IssuedTokens): NextResponse {
  const res = NextResponse.json({ accessToken: tokens.accessToken, expiresIn: tokens.expiresIn });
  res.cookies.set(REFRESH_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure: webConfig().secureCookies,
    sameSite: 'strict',
    path: '/bff',
    expires: new Date(tokens.refreshExpiresAt),
  });
  res.headers.set('cache-control', 'no-store');
  return res;
}

export function clearSession(res: NextResponse): NextResponse {
  res.cookies.set(REFRESH_COOKIE, '', {
    httpOnly: true,
    secure: webConfig().secureCookies,
    sameSite: 'strict',
    path: '/bff',
    maxAge: 0,
  });
  return res;
}
