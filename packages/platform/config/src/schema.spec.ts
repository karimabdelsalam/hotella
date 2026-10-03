import { describe, expect, it } from 'vitest';
import { ConfigValidationError, loadConfig } from './schema';

const valid = {
  DATABASE_URL: 'postgresql://hotella:hotella@localhost:5432/hotella',
  VALKEY_URL: 'redis://localhost:6379',
};

describe('loadConfig', () => {
  it('applies defaults and shapes the config', () => {
    const cfg = loadConfig(valid);
    expect(cfg.env).toBe('development');
    expect(cfg.app.port).toBe(3000);
    expect(cfg.logging.level).toBe('info');
    expect(cfg.database.url).toBe(valid.DATABASE_URL);
    expect(cfg.isProduction).toBe(false);
  });

  it('coerces numeric strings', () => {
    expect(loadConfig({ ...valid, PORT: '8080' }).app.port).toBe(8080);
  });

  it('fails fast and names the offending fields', () => {
    expect(() => loadConfig({ VALKEY_URL: 'redis://localhost' })).toThrowError(
      ConfigValidationError,
    );
    try {
      loadConfig({ DATABASE_URL: 'not-a-url', VALKEY_URL: 'redis://localhost', PORT: '99999' });
    } catch (err) {
      const e = err as ConfigValidationError;
      const paths = e.issues.map((i) => i.path);
      expect(paths).toContain('DATABASE_URL');
      expect(paths).toContain('PORT');
      expect(e.message).toContain('DATABASE_URL');
    }
  });

  it('requires storage credentials to be SecretRefs, not values', () => {
    expect(() => loadConfig({ ...valid, STORAGE_ACCESS_KEY_REF: 'AKIA-plaintext' })).toThrow();
    expect(
      loadConfig({ ...valid, STORAGE_ACCESS_KEY_REF: 'vault://kv/minio#access' }).storage
        .accessKeyRef,
    ).toBe('vault://kv/minio#access');
  });

  it('parses boolean-ish flags', () => {
    expect(loadConfig({ ...valid, OTEL_ENABLED: 'true' }).otel.enabled).toBe(true);
    expect(loadConfig({ ...valid, OTEL_ENABLED: '0' }).otel.enabled).toBe(false);
  });

  it('parses worker queue groups and supported locales', () => {
    expect(loadConfig(valid).worker.queues).toBe('all');
    expect(
      loadConfig({ ...valid, WORKER_QUEUES: 'guest-realtime, critical-operational' }).worker.queues,
    ).toEqual(['guest-realtime', 'critical-operational']);
    expect(loadConfig(valid).i18n.supportedLocales).toEqual(['en', 'ar']);
    expect(() => loadConfig({ ...valid, DEFAULT_LOCALE: 'english' })).toThrow();
  });

  it('identity keys are SecretRefs, optional outside production and required in production', () => {
    const dev = loadConfig(valid);
    expect(dev.iam.jwtSigningKeyRef).toBeNull();
    expect(dev.iam.accessTokenTtlSeconds).toBe(900);
    expect(() => loadConfig({ ...valid, IAM_ACCESS_TOKEN_TTL_SECONDS: '3600' })).toThrow();
    expect(() =>
      loadConfig({ ...valid, IAM_JWT_SIGNING_KEY_REF: '-----BEGIN PRIVATE KEY' }),
    ).toThrow();
    try {
      loadConfig({ ...valid, NODE_ENV: 'production' });
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigValidationError).issues.map((i) => i.path)).toEqual([
        'IAM_JWT_SIGNING_KEY_REF',
        'IAM_MFA_KEY_REF',
      ]);
    }
    const prod = loadConfig({
      ...valid,
      NODE_ENV: 'production',
      IAM_JWT_SIGNING_KEY_REF: 'vault://iam/jwt#private_key',
      IAM_MFA_KEY_REF: 'vault://iam/mfa#key',
    });
    expect(prod.iam.mfaKeyRef).toBe('vault://iam/mfa#key');
  });

  it('rejects unknown log levels and environments', () => {
    expect(() => loadConfig({ ...valid, LOG_LEVEL: 'verbose' })).toThrow();
    expect(() => loadConfig({ ...valid, NODE_ENV: 'staging' })).toThrow();
  });
});
