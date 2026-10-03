/** Browser-side calls to the API through the same-origin proxy (`/hotella/*`) and the BFF (`/bff/*`). */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    /** Localized by the API from `Accept-Language` (RFC 9457 `detail`). */
    readonly detail: string | null,
  ) {
    super(code ?? `HTTP ${status}`);
    this.name = 'ApiError';
  }
}

export async function call<T>(
  path: string,
  locale: string,
  init: { readonly method?: 'GET' | 'POST'; readonly body?: unknown } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      'accept-language': locale,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: 'no-store',
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok)
    throw new ApiError(
      res.status,
      typeof json?.code === 'string' ? json.code : null,
      typeof json?.detail === 'string' ? json.detail : null,
    );
  return json as T;
}

/** The API through the proxy: `api('guest/me', locale)`. */
export function api<T>(
  path: string,
  locale: string,
  init?: { readonly method?: 'GET' | 'POST'; readonly body?: unknown },
): Promise<T> {
  return call<T>(`/hotella/${path}`, locale, init);
}
