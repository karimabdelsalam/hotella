import type { NextRequest } from 'next/server';
import { callApi, passThrough, withSession } from '../../../lib/bff';

export async function POST(req: NextRequest) {
  const res = await callApi(req, '/auth/mfa/verify', await req.json().catch(() => ({})));
  if (!res.ok) return passThrough(res);
  return withSession((await res.json()) as never);
}
