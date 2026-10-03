import { type NextRequest } from 'next/server';
import { callApi, deviceOf, passThrough, withGuestSession } from '../../../lib/bff';

/** The guest enters the code they received: the API opens a guest session, kept in the httpOnly cookie. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { handle?: unknown; code?: unknown };
  const res = await callApi(req, '/guest/activation/otp/verify', {
    handle: body.handle,
    code: body.code,
    device: deviceOf(req),
  });
  if (!res.ok) return passThrough(res);
  return withGuestSession(await res.json());
}
