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

  it('rejects unknown log levels and environments', () => {
    expect(() => loadConfig({ ...valid, LOG_LEVEL: 'verbose' })).toThrow();
    expect(() => loadConfig({ ...valid, NODE_ENV: 'staging' })).toThrow();
  });
});
