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

  /** OpenTelemetry (ADR-0006). The SDK itself honours the standard OTEL_* variables; we only gate enablement. */
  OTEL_ENABLED: z.stringbool().default(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().default('http://localhost:4318'),
  OTEL_SERVICE_NAME: z.string().min(1).optional(),

  /** Object storage (Spec §2.4, ADR-0013 MinIO). Credentials are SecretRefs, never values (ADR-0010). */
  STORAGE_ENDPOINT: z.url().default('http://localhost:9000'),
  STORAGE_REGION: z.string().min(1).default('us-east-1'),
  STORAGE_BUCKET: z.string().min(3).default('hotella'),
  STORAGE_FORCE_PATH_STYLE: z.stringbool().default(true),
  STORAGE_ACCESS_KEY_REF: z
    .string()
    .regex(/^[a-z][a-z0-9+.-]*:\/\//i, 'must be a SecretRef like env://STORAGE_ACCESS_KEY')
    .default('env://STORAGE_ACCESS_KEY'),
  STORAGE_SECRET_KEY_REF: z
    .string()
    .regex(/^[a-z][a-z0-9+.-]*:\/\//i, 'must be a SecretRef like env://STORAGE_SECRET_KEY')
    .default('env://STORAGE_SECRET_KEY'),
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
  readonly otel: {
    readonly enabled: boolean;
    readonly endpoint: string;
    readonly serviceName: string;
  };
  readonly storage: {
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
    readonly forcePathStyle: boolean;
    readonly accessKeyRef: string;
    readonly secretKeyRef: string;
  };
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
    otel: {
      enabled: e.OTEL_ENABLED,
      endpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT,
      serviceName: e.OTEL_SERVICE_NAME ?? e.APP_NAME,
    },
    storage: {
      endpoint: e.STORAGE_ENDPOINT,
      region: e.STORAGE_REGION,
      bucket: e.STORAGE_BUCKET,
      forcePathStyle: e.STORAGE_FORCE_PATH_STYLE,
      accessKeyRef: e.STORAGE_ACCESS_KEY_REF,
      secretKeyRef: e.STORAGE_SECRET_KEY_REF,
    },
  };
}

/** Reads and validates process.env. The only sanctioned env read outside this package's module (used by main.ts before Nest boots). */
export function loadConfigFromEnv(): AppConfig {
  return loadConfig(process.env);
}
