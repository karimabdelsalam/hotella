import { type NextRequest, NextResponse } from 'next/server';
import { callApi, clearSession } from '../../../lib/bff';

/** Ends the API session (all tokens of it) and forgets the cookie. */
export async function POST(req: NextRequest) {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer /i, '') ?? null;
  if (bearer) await callApi(req, '/auth/logout', undefined, bearer).catch(() => undefined);
  return clearSession(new NextResponse(null, { status: 204 }));
}
