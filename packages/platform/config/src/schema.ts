import { z } from 'zod';

/**
 * Environment schema. Every variable the platform reads is declared here with its type and default.
 * Secrets are NOT configuration: they are `SecretRef`s resolved by @hotella/platform-secrets (ADR-0010).
 * Connection URLs may embed dev-only credentials; production injects them through the secret provider.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().min(1).default('hotella-api'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  VALKEY_URL: z.url({ protocol: /^rediss?$/ }),
  /** Base URL used for guest-facing links (activation URLs). Phase 4 uses it; declared early so envs are complete. */
  PUBLIC_BASE_URL: z.url().default('http://localhost:3000'),
});

export type Env = z.infer<typeof envSchema>;

/** Typed, grouped view of the configuration consumed by the application. */
export interface AppConfig {
  readonly env: Env['NODE_ENV'];
  readonly isProduction: boolean;
  readonly app: {
    readonly name: string;
    readonly host: string;
    readonly port: number;
    readonly publicBaseUrl: string;
  };
  readonly logging: { readonly level: Env['LOG_LEVEL'] };
  readonly shutdown: { readonly timeoutMs: number };
  readonly database: { readonly url: string };
  readonly valkey: { readonly url: string };
}

export class ConfigValidationError extends Error {
  constructor(public readonly issues: ReadonlyArray<{ path: string; message: string }>) {
    super(
      `Invalid configuration:\n${issues.map((i) => `  - ${i.path || '(root)'}: ${i.message}`).join('\n')}`,
    );
    this.name = 'ConfigValidationError';
  }
}

/** Pure function: validates raw environment variables and shapes them into AppConfig. Fails fast with field names. */
export function loadConfig(raw: Readonly<Record<string, string | undefined>>): AppConfig {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigValidationError(
      parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    );
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    app: { name: e.APP_NAME, host: e.HOST, port: e.PORT, publicBaseUrl: e.PUBLIC_BASE_URL },
    logging: { level: e.LOG_LEVEL },
    shutdown: { timeoutMs: e.SHUTDOWN_TIMEOUT_MS },
    database: { url: e.DATABASE_URL },
    valkey: { url: e.VALKEY_URL },
  };
}
