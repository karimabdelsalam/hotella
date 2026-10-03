import { type NextRequest, NextResponse } from 'next/server';
import { callApi, clearGuestSession, GUEST_COOKIE } from '../../../lib/bff';

/** Ends the guest session on the API (best effort) and forgets the cookie. */
export async function POST(req: NextRequest) {
  const session = req.cookies.get(GUEST_COOKIE)?.value;
  if (session) await callApi(req, '/guest/logout', undefined, session).catch(() => null);
  return clearGuestSession(new NextResponse(null, { status: 204 }));
}
