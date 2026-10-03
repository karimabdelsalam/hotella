import type { NextRequest } from 'next/server';
import { webConfig } from '../../../lib/config';

/**
 * Same-origin proxy to the Hotella API (`/hotella/*` → `WEB_API_URL/*`), resolved at run time so one image serves any
 * environment. Only the headers the API needs are forwarded; cookies never leave this origin.
 */
const FORWARD = [
  'authorization',
  'accept-language',
  'content-type',
  'idempotency-key',
  'x-forwarded-for',
];

async function proxy(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const target = new URL(`${webConfig().apiUrl}/${path.map(encodeURIComponent).join('/')}`);
  target.search = req.nextUrl.search;
  const headers = new Headers();
  for (const name of FORWARD) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
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
  for (const name of [
    'content-type',
    'content-language',
    'retry-after',
    'ratelimit',
    'ratelimit-policy',
  ])
    if (res.headers.get(name)) out.set(name, res.headers.get(name)!);
  out.set('cache-control', 'no-store');
  return new Response(res.status === 204 ? null : res.body, { status: res.status, headers: out });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const dynamic = 'force-dynamic';
