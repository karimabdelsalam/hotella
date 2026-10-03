import { type NextRequest, NextResponse } from 'next/server';
import { callApi, clearSession, passThrough, REFRESH_COOKIE, withSession } from '../../../lib/bff';

/** Rotates the refresh token (the API revokes the session family on reuse) and returns a fresh access token. */
export async function POST(req: NextRequest) {
  const refreshToken = req.cookies.get(REFRESH_COOKIE)?.value;
  if (!refreshToken)
    return clearSession(NextResponse.json({ code: 'platform.unauthorized' }, { status: 401 }));
  const res = await callApi(req, '/auth/refresh', { refreshToken });
  if (!res.ok) return clearSession(await passThrough(res));
  return withSession((await res.json()) as never);
}
