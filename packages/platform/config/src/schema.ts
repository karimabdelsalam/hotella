import { z } from 'zod';

/**
 * Environment schema. Every variable the platform reads is declared here with its type and default.
 * Secrets are NOT configuration: they are `SecretRef`s resolved by @hotella/platform-secrets (ADR-0010).
 * Connection URLs may embed dev-only credentials; production injects them through the secret provider.
 */
function secretRef(example: string) {
  return z.string().regex(/^[a-z][a-z0-9+.-]*:\/\//i, `must be a SecretRef like ${example}`);
}

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

  /** HTTP conventions (ADR-0012). */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(600),
  OPENAPI_ENABLED: z.stringbool().default(true),

  /** Worker process shape (Spec §71): which queue groups this process serves, relay cadence, scheduler role. */
  WORKER_QUEUES: z.string().min(1).default('all'),
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WORKER_RELAY_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(500),
  WORKER_RELAY_BATCH: z.coerce.number().int().min(1).max(1000).default(100),
  WORKER_SCHEDULER_ENABLED: z.stringbool().default(true),

  /** Localization (Spec §79): platform default and the locales shipped in /locales. */
  DEFAULT_LOCALE: z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
    .default('en'),
  SUPPORTED_LOCALES: z.string().min(2).default('en,ar'),
  LOCALES_DIR: z.string().min(1).optional(),

  /** OpenTelemetry (ADR-0006). The SDK itself honours the standard OTEL_* variables; we only gate enablement. */
  OTEL_ENABLED: z.stringbool().default(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().default('http://localhost:4318'),
  OTEL_SERVICE_NAME: z.string().min(1).optional(),

  /** Object storage (Spec §2.4, ADR-0013 SeaweedFS S3 gateway). Credentials are SecretRefs, never values (ADR-0010). */
  STORAGE_ENDPOINT: z.url().default('http://localhost:8333'),
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

  /**
   * Staff identity (ADR-0011). Keys are SecretRefs: the JWT signing key is an Ed25519 private key (PKCS#8 PEM),
   * the MFA key is 32 random bytes (base64) used to encrypt TOTP seeds at rest. Both are required in production;
   * outside production an ephemeral key is generated at boot (tokens and MFA enrolments do not survive a restart).
   */
  IAM_JWT_SIGNING_KEY_REF: z
    .string()
    .regex(/^[a-z][a-z0-9+.-]*:\/\//i, 'must be a SecretRef like vault://iam/jwt#private_key')
    .optional(),
  IAM_MFA_KEY_REF: z
    .string()
    .regex(/^[a-z][a-z0-9+.-]*:\/\//i, 'must be a SecretRef like vault://iam/mfa#key')
    .optional(),
  IAM_JWT_ISSUER: z.string().min(1).default('hotella'),

  /**
   * Credentials inside connection URLs are for local development only. Deployed environments give a URL without a
   * password and a SecretRef for it (CLAUDE.md rule 13).
   */
  DATABASE_PASSWORD_REF: z
    .string()
    .regex(
      /^[a-z][a-z0-9+.-]*:\/\//i,
      'must be a SecretRef like vault://kv/hotella/api#db_password',
    )
    .optional(),
  VALKEY_PASSWORD_REF: z
    .string()
    .regex(
      /^[a-z][a-z0-9+.-]*:\/\//i,
      'must be a SecretRef like vault://kv/hotella/api#valkey_password',
    )
    .optional(),

  /** KV v2 secret store (OpenBao or HashiCorp Vault; ADR-0010/0013). Credentials are files, never values. */
  SECRETS_VAULT_ADDR: z.url().optional(),
  SECRETS_VAULT_AUTH: z.enum(['approle', 'token']).default('approle'),
  SECRETS_VAULT_APPROLE_MOUNT: z.string().min(1).default('approle'),
  SECRETS_VAULT_ROLE_ID_FILE: z.string().min(1).optional(),
  SECRETS_VAULT_SECRET_ID_FILE: z.string().min(1).optional(),
  SECRETS_VAULT_TOKEN_FILE: z.string().min(1).optional(),
  SECRETS_VAULT_NAMESPACE: z.string().min(1).optional(),
  IAM_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(900),
  IAM_REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  IAM_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
  IAM_LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  IAM_INVITE_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(72),

  /**
   * Hotel-agent gateway (ADR-0017). PEM material is referenced, never inlined: the agent CA certificate and its
   * ECDSA P-256 key (signs device certificates), the Ed25519 key that signs command frames, and the gateway's TLS
   * server certificate/key. Required in production by the gateway process; outside production an ephemeral CA and
   * keys are generated at boot (enrolled agents must re-enroll after a restart).
   */
  AGENT_CA_CERT_REF: secretRef('vault://kv/hotella/agent#ca_cert').optional(),
  AGENT_CA_KEY_REF: secretRef('vault://kv/hotella/agent#ca_key').optional(),
  AGENT_COMMAND_SIGNING_KEY_REF: secretRef('vault://kv/hotella/agent#command_key').optional(),
  AGENT_TLS_CERT_REF: secretRef('vault://kv/hotella/agent#tls_cert').optional(),
  AGENT_TLS_KEY_REF: secretRef('vault://kv/hotella/agent#tls_key').optional(),
  AGENT_GATEWAY_HOST: z.string().min(1).default('0.0.0.0'),
  AGENT_GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(8443),
  AGENT_CERT_VALIDITY_DAYS: z.coerce.number().int().min(1).max(397).default(90),
  AGENT_ENROLLMENT_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  AGENT_HEARTBEAT_SECONDS: z.coerce.number().int().min(5).max(300).default(30),

  /**
   * E-mail channel of staff notifications (Spec §25). Unset host = the channel is off (deliveries are recorded as
   * skipped). Mailpit locally: NOTIFY_SMTP_HOST=localhost, NOTIFY_SMTP_PORT=1025.
   */
  NOTIFY_SMTP_HOST: z.string().min(1).optional(),
  NOTIFY_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  NOTIFY_SMTP_SECURE: z.stringbool().default(false),
  NOTIFY_SMTP_USER: z.string().min(1).optional(),
  NOTIFY_SMTP_PASSWORD_REF: secretRef('vault://kv/hotella/app#smtp_password').optional(),
  NOTIFY_EMAIL_FROM: z.string().min(3).default('no-reply@localhost'),
  /** Retention of delivered events: published outbox rows and processed inbox rows are purged after these days. */
  EVENTS_OUTBOX_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  EVENTS_INBOX_RETENTION_DAYS: z.coerce.number().int().min(7).max(365).default(30),
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
  readonly database: { readonly url: string; readonly passwordRef: string | null };
  readonly valkey: { readonly url: string; readonly passwordRef: string | null };
  readonly secrets: {
    readonly vault: {
      readonly address: string;
      readonly auth: 'approle' | 'token';
      readonly approleMount: string;
      readonly roleIdFile: string | null;
      readonly secretIdFile: string | null;
      readonly tokenFile: string | null;
      readonly namespace: string | null;
    } | null;
  };
  readonly http: { readonly rateLimitPerMinute: number; readonly openApiEnabled: boolean };
  readonly worker: {
    readonly queues: 'all' | readonly string[];
    readonly port: number;
    readonly relayIntervalMs: number;
    readonly relayBatch: number;
    readonly schedulerEnabled: boolean;
  };
  readonly i18n: {
    readonly defaultLocale: string;
    readonly supportedLocales: readonly string[];
    readonly localesDir?: string;
  };
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
  readonly iam: {
    readonly jwtSigningKeyRef: string | null;
    readonly mfaKeyRef: string | null;
    readonly issuer: string;
    readonly accessTokenTtlSeconds: number;
    readonly refreshTokenTtlDays: number;
    readonly loginMaxAttempts: number;
    readonly loginLockMinutes: number;
    readonly inviteTtlHours: number;
  };
  readonly notifications: {
    readonly smtp: {
      readonly host: string;
      readonly port: number;
      readonly secure: boolean;
      readonly user: string | null;
      readonly passwordRef: string | null;
    } | null;
    readonly emailFrom: string;
  };
  readonly retention: {
    readonly outboxDays: number;
    readonly inboxDays: number;
  };
  readonly agent: {
    readonly caCertRef: string | null;
    readonly caKeyRef: string | null;
    readonly commandSigningKeyRef: string | null;
    readonly tlsCertRef: string | null;
    readonly tlsKeyRef: string | null;
    readonly host: string;
    readonly port: number;
    readonly certValidityDays: number;
    readonly enrollmentTtlHours: number;
    readonly heartbeatSeconds: number;
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
  if (e.SECRETS_VAULT_ADDR) {
    const needs: Array<[string, string | undefined]> =
      e.SECRETS_VAULT_AUTH === 'token'
        ? [['SECRETS_VAULT_TOKEN_FILE', e.SECRETS_VAULT_TOKEN_FILE]]
        : [
            ['SECRETS_VAULT_ROLE_ID_FILE', e.SECRETS_VAULT_ROLE_ID_FILE],
            ['SECRETS_VAULT_SECRET_ID_FILE', e.SECRETS_VAULT_SECRET_ID_FILE],
          ];
    const missing = needs.filter(([, v]) => !v);
    if (missing.length > 0)
      throw new ConfigValidationError(
        missing.map(([path]) => ({ path, message: `required when SECRETS_VAULT_ADDR is set` })),
      );
  }
  if (e.NODE_ENV === 'production') {
    const missing = (
      [
        ['IAM_JWT_SIGNING_KEY_REF', e.IAM_JWT_SIGNING_KEY_REF],
        ['IAM_MFA_KEY_REF', e.IAM_MFA_KEY_REF],
      ] as const
    ).filter(([, v]) => !v);
    if (missing.length > 0)
      throw new ConfigValidationError(
        missing.map(([path]) => ({ path, message: 'required in production' })),
      );
  }
  return {
    env: e.NODE_ENV,
    isProduction: e.NODE_ENV === 'production',
    app: { name: e.APP_NAME, host: e.HOST, port: e.PORT, publicBaseUrl: e.PUBLIC_BASE_URL },
    logging: { level: e.LOG_LEVEL },
    shutdown: { timeoutMs: e.SHUTDOWN_TIMEOUT_MS },
    database: { url: e.DATABASE_URL, passwordRef: e.DATABASE_PASSWORD_REF ?? null },
    valkey: { url: e.VALKEY_URL, passwordRef: e.VALKEY_PASSWORD_REF ?? null },
    secrets: {
      vault: e.SECRETS_VAULT_ADDR
        ? {
            address: e.SECRETS_VAULT_ADDR,
            auth: e.SECRETS_VAULT_AUTH,
            approleMount: e.SECRETS_VAULT_APPROLE_MOUNT,
            roleIdFile: e.SECRETS_VAULT_ROLE_ID_FILE ?? null,
            secretIdFile: e.SECRETS_VAULT_SECRET_ID_FILE ?? null,
            tokenFile: e.SECRETS_VAULT_TOKEN_FILE ?? null,
            namespace: e.SECRETS_VAULT_NAMESPACE ?? null,
          }
        : null,
    },
    http: {
      rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
      openApiEnabled: e.OPENAPI_ENABLED && e.NODE_ENV !== 'production',
    },
    worker: {
      queues:
        e.WORKER_QUEUES.trim() === 'all'
          ? 'all'
          : e.WORKER_QUEUES.split(',')
              .map((q) => q.trim())
              .filter(Boolean),
      port: e.WORKER_PORT,
      relayIntervalMs: e.WORKER_RELAY_INTERVAL_MS,
      relayBatch: e.WORKER_RELAY_BATCH,
      schedulerEnabled: e.WORKER_SCHEDULER_ENABLED,
    },
    i18n: {
      defaultLocale: e.DEFAULT_LOCALE,
      supportedLocales: e.SUPPORTED_LOCALES.split(',')
        .map((l) => l.trim())
        .filter(Boolean),
      ...(e.LOCALES_DIR ? { localesDir: e.LOCALES_DIR } : {}),
    },
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
    iam: {
      jwtSigningKeyRef: e.IAM_JWT_SIGNING_KEY_REF ?? null,
      mfaKeyRef: e.IAM_MFA_KEY_REF ?? null,
      issuer: e.IAM_JWT_ISSUER,
      accessTokenTtlSeconds: e.IAM_ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlDays: e.IAM_REFRESH_TOKEN_TTL_DAYS,
      loginMaxAttempts: e.IAM_LOGIN_MAX_ATTEMPTS,
      loginLockMinutes: e.IAM_LOGIN_LOCK_MINUTES,
      inviteTtlHours: e.IAM_INVITE_TTL_HOURS,
    },
    notifications: {
      smtp: e.NOTIFY_SMTP_HOST
        ? {
            host: e.NOTIFY_SMTP_HOST,
            port: e.NOTIFY_SMTP_PORT,
            secure: e.NOTIFY_SMTP_SECURE,
            user: e.NOTIFY_SMTP_USER ?? null,
            passwordRef: e.NOTIFY_SMTP_PASSWORD_REF ?? null,
          }
        : null,
      emailFrom: e.NOTIFY_EMAIL_FROM,
    },
    retention: {
      outboxDays: e.EVENTS_OUTBOX_RETENTION_DAYS,
      inboxDays: e.EVENTS_INBOX_RETENTION_DAYS,
    },
    agent: {
      caCertRef: e.AGENT_CA_CERT_REF ?? null,
      caKeyRef: e.AGENT_CA_KEY_REF ?? null,
      commandSigningKeyRef: e.AGENT_COMMAND_SIGNING_KEY_REF ?? null,
      tlsCertRef: e.AGENT_TLS_CERT_REF ?? null,
      tlsKeyRef: e.AGENT_TLS_KEY_REF ?? null,
      host: e.AGENT_GATEWAY_HOST,
      port: e.AGENT_GATEWAY_PORT,
      certValidityDays: e.AGENT_CERT_VALIDITY_DAYS,
      enrollmentTtlHours: e.AGENT_ENROLLMENT_TTL_HOURS,
      heartbeatSeconds: e.AGENT_HEARTBEAT_SECONDS,
    },
  };
}

/** Reads and validates process.env. The only sanctioned env read outside this package's module (used by main.ts before Nest boots). */
export function loadConfigFromEnv(): AppConfig {
  return loadConfig(process.env);
}
