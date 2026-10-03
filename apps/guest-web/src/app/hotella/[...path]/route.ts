import type { NextRequest } from 'next/server';
import { GUEST_COOKIE, GUEST_SESSION_HEADER } from '../../../lib/bff';
import { webConfig } from '../../../lib/config';

/**
 * Same-origin proxy to the guest part of the Hotella API (`/hotella/guest/*`, `/hotella/public/*`), resolved at run
 * time so one image serves any environment. The guest session cookie becomes the `X-Guest-Session` header here; the
 * steps that mint a session go through the BFF instead, so the token never reaches the page.
 */
const FORWARD = ['accept-language', 'content-type', 'idempotency-key', 'x-forwarded-for'];
const ALLOWED = /^(guest|public)\//;
const BFF_ONLY = new Set([
  'guest/activation/otp/verify',
  'guest/activation/complete',
  'guest/logout',
]);

async function proxy(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const joined = path.join('/');
  if (!ALLOWED.test(joined) || BFF_ONLY.has(joined))
    return Response.json({ code: 'platform.not_found' }, { status: 404 });
  const target = new URL(`${webConfig().apiUrl}/${path.map(encodeURIComponent).join('/')}`);
  target.search = req.nextUrl.search;
  const headers = new Headers();
  for (const name of FORWARD) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  const session = req.cookies.get(GUEST_COOKIE)?.value;
  if (session) headers.set(GUEST_SESSION_HEADER, session);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const res = await fetch(target, {
    method: req.method,
    headers,
    body: hasBody ? await req.arrayBuffer() : undefined,
    cache: 'no-store',
    redirect: 'manual',
  }).catch(() => null);
  if (!res) return Response.json({ code: 'platform.not_ready' }, { status: 502 });
  const out = new Headers();
  for (const name of ['content-type', 'content-language', 'retry-after'])
    if (res.headers.get(name)) out.set(name, res.headers.get(name)!);
  out.set('cache-control', 'no-store');
  return new Response(res.status === 204 ? null : res.body, { status: res.status, headers: out });
}

export const GET = proxy;
export const POST = proxy;
export const dynamic = 'force-dynamic';
