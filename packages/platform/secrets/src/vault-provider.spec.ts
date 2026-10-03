import { describe, expect, it } from 'vitest';
import { urlWithSecretPassword } from './connection-url';
import { EnvSecretProvider, SecretResolver } from './provider';
import { parseSecretRef, SecretNotFoundError, SecretRefError } from './secret-ref';
import { SecretBackendError, VaultKvSecretProvider } from './vault-provider';

/** A tiny in-memory KV v2 + AppRole server speaking the OpenBao/Vault HTTP API. */
function fakeStore(opts: { expireFirstToken?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; token: string | null; ns: string | null }> = [];
  let logins = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      token: headers.get('X-Vault-Token'),
      ns: headers.get('X-Vault-Namespace'),
    });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/v1/auth/approle/login')) {
      const body = JSON.parse(String(init?.body)) as { role_id: string; secret_id: string };
      if (body.role_id !== 'role-1' || body.secret_id !== 'secret-1')
        return json(400, { errors: ['invalid'] });
      logins += 1;
      return json(200, { auth: { client_token: `tok-${logins}` } });
    }
    const token = headers.get('X-Vault-Token');
    if (opts.expireFirstToken && token === 'tok-1')
      return json(403, { errors: ['permission denied'] });
    if (url.endsWith('/v1/kv/data/hotella/api'))
      return json(200, { data: { data: { db_password: 's3cr3t', empty: '' } } });
    return json(404, { errors: [] });
  }) as typeof fetch;
  const files: Record<string, string> = {
    '/run/role_id': 'role-1\n',
    '/run/secret_id': 'secret-1\n',
  };
  return { calls, fetchImpl, readFileImpl: async (p: string) => files[p]!, logins: () => logins };
}

describe('VaultKvSecretProvider (OpenBao / Vault KV v2)', () => {
  const make = (s: ReturnType<typeof fakeStore>, namespace?: string) =>
    new VaultKvSecretProvider({
      address: 'https://bao.internal:8200/',
      auth: { method: 'approle', roleIdFile: '/run/role_id', secretIdFile: '/run/secret_id' },
      namespace: namespace ?? null,
      fetchImpl: s.fetchImpl,
      readFileImpl: s.readFileImpl,
    });

  it('logs in with AppRole from files and reads <mount>/data/<path>#key', async () => {
    const s = fakeStore();
    const p = make(s, 'hotels');
    await expect(p.get(parseSecretRef('vault://kv/hotella/api#db_password'))).resolves.toBe(
      's3cr3t',
    );
    await expect(p.get(parseSecretRef('vault://kv/hotella/api#db_password'))).resolves.toBe(
      's3cr3t',
    );
    expect(s.logins()).toBe(1); // token reused
    expect(s.calls[1]).toMatchObject({
      url: 'https://bao.internal:8200/v1/kv/data/hotella/api',
      token: 'tok-1',
      ns: 'hotels',
    });
  });

  it('logs in again once when the token has expired', async () => {
    const s = fakeStore({ expireFirstToken: true });
    await expect(make(s).get(parseSecretRef('vault://kv/hotella/api#db_password'))).resolves.toBe(
      's3cr3t',
    );
    expect(s.logins()).toBe(2);
  });

  it('missing paths, keys and empty values are SecretNotFound; malformed refs are rejected', async () => {
    const p = make(fakeStore());
    await expect(p.get(parseSecretRef('vault://kv/hotella/other#x'))).rejects.toBeInstanceOf(
      SecretNotFoundError,
    );
    await expect(p.get(parseSecretRef('vault://kv/hotella/api#nope'))).rejects.toBeInstanceOf(
      SecretNotFoundError,
    );
    await expect(p.get(parseSecretRef('vault://kv/hotella/api#empty'))).rejects.toBeInstanceOf(
      SecretNotFoundError,
    );
    await expect(p.get(parseSecretRef('vault://kv/hotella/api'))).rejects.toBeInstanceOf(
      SecretRefError,
    );
    await expect(p.get(parseSecretRef('vault://kv#x'))).rejects.toBeInstanceOf(SecretRefError);
  });

  it('a failed login is a backend error, never a silent empty secret', async () => {
    const s = fakeStore();
    const p = new VaultKvSecretProvider({
      address: 'https://bao.internal:8200',
      auth: { method: 'approle', roleIdFile: '/run/secret_id', secretIdFile: '/run/role_id' },
      fetchImpl: s.fetchImpl,
      readFileImpl: s.readFileImpl,
    });
    await expect(
      p.get(parseSecretRef('vault://kv/hotella/api#db_password')),
    ).rejects.toBeInstanceOf(SecretBackendError);
  });
});

describe('urlWithSecretPassword', () => {
  it('injects the resolved password and leaves URLs alone without a ref', async () => {
    const resolver = new SecretResolver([new EnvSecretProvider({ DB_PW: 'p@ss/word' })]);
    expect(await urlWithSecretPassword('postgresql://app@db:5432/hotella', null, resolver)).toBe(
      'postgresql://app@db:5432/hotella',
    );
    const url = await urlWithSecretPassword(
      'postgresql://app@db:5432/hotella',
      'env://DB_PW',
      resolver,
    );
    expect(new URL(url).password).toBe('p%40ss%2Fword');
    expect(decodeURIComponent(new URL(url).password)).toBe('p@ss/word');
    await expect(
      urlWithSecretPassword('redis://valkey:6379', 'env://DB_PW', null),
    ).rejects.toThrow();
  });
});
