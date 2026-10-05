import { z } from 'zod';

/**
 * Configuration of the web applications (ADR-0009: staff-web, later guest-web). They run Next.js servers, not the
 * Nest application, so they get their own small schema; like every process they read the environment only through
 * this package (CLAUDE.md rule 13). Nothing here is a secret: the web servers hold no credentials of their own.
 */
export const webEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Where the web server reaches the Hotella API (server-side calls and the same-origin `/hotella` proxy). */
  WEB_API_URL: z.url().default('http://localhost:3000/api/v1'),
  /** The realtime WebSocket the browser connects to (BUILD_PLAN §8.9, notes for 4.4). */
  WEB_REALTIME_URL: z
    .string()
    .regex(/^wss?:\/\//, 'must be a ws:// or wss:// URL')
    .default('ws://localhost:3000/api/v1/realtime'),
  /** Tenant code shown pre-filled on the staff sign-in page of a single-hotel deployment (optional). */
  WEB_TENANT_CODE: z.string().trim().min(2).max(32).optional(),
  DEFAULT_LOCALE: z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
    .default('en'),
  SUPPORTED_LOCALES: z.string().min(2).default('en,ar,it,ru,de'),
});

export interface WebConfig {
  readonly env: 'development' | 'test' | 'production';
  readonly apiUrl: string;
  readonly realtimeUrl: string;
  readonly tenantCode: string | null;
  readonly defaultLocale: string;
  readonly locales: readonly string[];
  /** Cookies are `Secure` outside development and tests. */
  readonly secureCookies: boolean;
}

export function loadWebConfig(raw: Readonly<Record<string, string | undefined>>): WebConfig {
  const e = webEnvSchema.parse(raw);
  const locales = e.SUPPORTED_LOCALES.split(',')
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    env: e.NODE_ENV,
    apiUrl: e.WEB_API_URL.replace(/\/+$/, ''),
    realtimeUrl: e.WEB_REALTIME_URL,
    tenantCode: e.WEB_TENANT_CODE ?? null,
    defaultLocale: e.DEFAULT_LOCALE,
    locales,
    secureCookies: e.NODE_ENV === 'production',
  };
}

/** Reads and validates process.env for a web server. */
export function loadWebConfigFromEnv(): WebConfig {
  return loadWebConfig(process.env);
}
