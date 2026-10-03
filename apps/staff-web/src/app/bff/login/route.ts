import { type NextRequest, NextResponse } from 'next/server';
import { callApi, passThrough, withSession } from '../../../lib/bff';

/** Staff sign-in (ADR-0011): password, then MFA when enrolled. */
export async function POST(req: NextRequest) {
  const res = await callApi(req, '/auth/login', await req.json().catch(() => ({})));
  if (!res.ok) return passThrough(res);
  const body = (await res.json()) as { mfaRequired: boolean; challengeToken?: string };
  if (body.mfaRequired)
    return NextResponse.json({ mfaRequired: true, challengeToken: body.challengeToken });
  return withSession(body as never);
}
