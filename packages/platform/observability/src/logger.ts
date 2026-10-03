import pino, { type Logger, type LoggerOptions } from 'pino';

/**
 * Keys that must never reach a log line (Spec §70 "avoid sensitive data leakage into logs").
 * Extend SENSITIVE_KEYS here, not at call sites. Sprint 0.3.13 wires the data-classification registry into this list.
 */
export const SENSITIVE_KEYS: readonly string[] = [
  'password',
  'passwordHash',
  'password_hash',
  'token',
  'accessToken',
  'refreshToken',
  'access_token',
  'refresh_token',
  'activationToken',
  'activation_token',
  'otp',
  'otpCode',
  'otp_code',
  'code',
  'secret',
  'apiKey',
  'api_key',
  'credential',
  'credentials',
  'phone',
  'phoneNumber',
  'phone_normalized',
  'email',
];

const HEADER_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

/**
 * pino redaction paths. `*` matches exactly one level, so each key is listed at the top level and up to
 * three levels deep; log *structured, shallow* objects and never dump whole request bodies.
 */
export const REDACT_PATHS: readonly string[] = [
  ...HEADER_PATHS,
  ...SENSITIVE_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`, `*.*.*.${k}`]),
];

export interface LoggerConfig {
  readonly level: string;
  readonly name: string;
  readonly pretty?: boolean;
  /** Returns the current request context (correlation_id, tenant_id, property_id, …). Wired by Sprint 0.2.4. */
  readonly contextProvider?: () => Record<string, unknown> | undefined;
}

export function createLogger(config: LoggerConfig): Logger {
  const options: LoggerOptions = {
    name: config.name,
    level: config.level,
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
    base: { service: config.name },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    mixin: () => {
      const ctx = config.contextProvider?.();
      // Always present so log pipelines can rely on the field existing (Phase 0 acceptance).
      return { correlation_id: null, ...ctx };
    },
  };
  if (config.pretty) {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' },
      },
    });
  }
  return pino(options);
}

export type { Logger };
