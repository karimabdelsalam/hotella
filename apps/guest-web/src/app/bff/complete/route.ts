import { type NextRequest } from 'next/server';
import { callApi, deviceOf, passThrough, withGuestSession } from '../../../lib/bff';

/** After front desk confirmed the guest in person (staff-assisted verification, ADR-0015). */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { handle?: unknown };
  const res = await callApi(req, '/guest/activation/complete', {
    handle: body.handle,
    device: deviceOf(req),
  });
  if (!res.ok) return passThrough(res);
  return withGuestSession(await res.json());
}
