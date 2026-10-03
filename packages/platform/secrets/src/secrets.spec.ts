import { describe, expect, it } from 'vitest';
import { EnvSecretProvider, SecretResolver } from './provider';
import { isSecretRef, parseSecretRef, SecretNotFoundError, SecretRefError } from './secret-ref';

describe('SecretRef', () => {
  it('parses provider, path and key', () => {
    expect(parseSecretRef('vault://kv/hotella/prod/whatsapp#token')).toEqual({
      provider: 'vault',
      path: 'kv/hotella/prod/whatsapp',
      key: 'token',
    });
    expect(parseSecretRef('env://DATABASE_PASSWORD')).toEqual({
      provider: 'env',
      path: 'DATABASE_PASSWORD',
    });
  });
  it('rejects plain values', () => {
    expect(() => parseSecretRef('hunter2')).toThrow(SecretRefError);
    expect(isSecretRef('hunter2')).toBe(false);
    expect(isSecretRef('env://X')).toBe(true);
  });
});

describe('SecretResolver + EnvSecretProvider', () => {
  it('resolves env refs and caches within ttl', async () => {
    let now = 1_000;
    const env: Record<string, string | undefined> = { WA_TOKEN: 'first' };
    const resolver = new SecretResolver([new EnvSecretProvider(env)], 1_000, () => now);
    expect(await resolver.resolve('env://WA_TOKEN')).toBe('first');
    env['WA_TOKEN'] = 'second';
    expect(await resolver.resolve('env://WA_TOKEN')).toBe('first'); // cached
    now += 2_000;
    expect(await resolver.resolve('env://WA_TOKEN')).toBe('second'); // expired
  });
  it('fails loudly on missing secrets and unknown schemes', async () => {
    const resolver = new SecretResolver([new EnvSecretProvider({})]);
    await expect(resolver.resolve('env://MISSING')).rejects.toThrow(SecretNotFoundError);
    await expect(resolver.resolve('vault://x#y')).rejects.toThrow(SecretRefError);
  });
});
