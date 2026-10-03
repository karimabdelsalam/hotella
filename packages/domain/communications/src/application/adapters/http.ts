import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderError } from '../providers';

/** The HTTP client adapters use (global fetch by default); contract tests inject a recorder. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const PROVIDER_TIMEOUT_MS = 10_000;

/** Calls a provider API with a hard timeout and maps transport failures to ProviderError codes. */
export async function callProvider(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  classify: (status: number, body: unknown) => ProviderError,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  } catch (e) {
    const name = (e as { name?: string }).name;
    throw new ProviderError(
      name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'UNAVAILABLE',
      true,
    );
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) throw classify(res.status, body);
  return body;
}

/** Generic HTTP status mapping shared by adapters (vendor-specific codes are refined by each adapter). */
export function statusError(status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError('AUTH_FAILED', false);
  if (status === 429) return new ProviderError('RATE_LIMITED', true);
  if (status >= 500) return new ProviderError('UNAVAILABLE', true);
  return new ProviderError('REJECTED', false);
}

/** Constant-time check of `sha256=<hex>` HMAC signatures (Meta `X-Hub-Signature-256`). */
export function validHmacSignature(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'utf8');
  const given = Buffer.from(header.slice('sha256='.length), 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Constant-time comparison of a shared secret header. */
export function sameSecret(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Channel credentials are one SecretRef holding a JSON object (e.g. access token + app secret). */
export function credentialJson(raw: string): Record<string, string> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, string>;
  } catch {
    // fall through
  }
  throw new ProviderError('AUTH_FAILED', false);
}

/** WhatsApp wants international numbers without `+`. */
export function waNumber(e164: string): string {
  return e164.replace(/^\+/, '');
}
export function fromWaNumber(digits: string): string {
  return digits.startsWith('+') ? digits : `+${digits}`;
}
