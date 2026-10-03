import { readFile } from 'node:fs/promises';
import type { SecretProvider } from './provider';
import { formatSecretRef, SecretNotFoundError, type SecretRef, SecretRefError } from './secret-ref';

export type VaultAuth =
  | { readonly method: 'token'; readonly tokenFile: string }
  | {
      readonly method: 'approle';
      readonly roleIdFile: string;
      readonly secretIdFile: string;
      readonly mount?: string;
    };

export interface VaultKvOptions {
  /** e.g. `https://openbao.internal:8200` */
  readonly address: string;
  readonly auth: VaultAuth;
  /** Enterprise/OpenBao namespace, sent as `X-Vault-Namespace`. */
  readonly namespace?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly readFileImpl?: (path: string) => Promise<string>;
  readonly timeoutMs?: number;
}

export class SecretBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBackendError';
  }
}

/**
 * `vault://<mount>/<path>#<key>` against a KV v2 engine (ADR-0010, ADR-0013). Works with OpenBao and HashiCorp
 * Vault (same HTTP API). Credentials come from files (mounted by the orchestrator), never from configuration values;
 * an expired token triggers one re-login.
 */
export class VaultKvSecretProvider implements SecretProvider {
  readonly scheme = 'vault';
  private token: string | null = null;
  private readonly fetch: typeof fetch;
  private readonly read: (path: string) => Promise<string>;

  constructor(private readonly options: VaultKvOptions) {
    this.fetch = options.fetchImpl ?? fetch;
    this.read = options.readFileImpl ?? ((p) => readFile(p, 'utf8'));
  }

  async get(ref: SecretRef): Promise<string> {
    if (!ref.key)
      throw new SecretRefError(`vault:// refs need a #key (got "${formatSecretRef(ref)}")`);
    const [mount, ...rest] = ref.path.split('/');
    if (!mount || rest.length === 0)
      throw new SecretRefError(
        `vault:// refs are <mount>/<path>#<key> (got "${formatSecretRef(ref)}")`,
      );
    const url = `${this.options.address.replace(/\/$/, '')}/v1/${encodeURIComponent(mount)}/data/${rest
      .map(encodeURIComponent)
      .join('/')}`;
    let res = await this.request(url, await this.currentToken());
    if (res.status === 403) {
      this.token = null; // expired or revoked: log in again once
      res = await this.request(url, await this.currentToken());
    }
    if (res.status === 404) throw new SecretNotFoundError(ref);
    if (!res.ok)
      throw new SecretBackendError(
        `Secret store answered ${res.status} for ${formatSecretRef(ref)}`,
      );
    const body = (await res.json()) as { data?: { data?: Record<string, unknown> } };
    const value = body.data?.data?.[ref.key];
    if (typeof value !== 'string' || value === '') throw new SecretNotFoundError(ref);
    return value;
  }

  private async currentToken(): Promise<string> {
    if (this.token) return this.token;
    const auth = this.options.auth;
    if (auth.method === 'token') {
      this.token = (await this.read(auth.tokenFile)).trim();
    } else {
      const [roleId, secretId] = await Promise.all([
        this.read(auth.roleIdFile),
        this.read(auth.secretIdFile),
      ]);
      const res = await this.call(
        `${this.options.address.replace(/\/$/, '')}/v1/auth/${auth.mount ?? 'approle'}/login`,
        {
          method: 'POST',
          body: JSON.stringify({ role_id: roleId.trim(), secret_id: secretId.trim() }),
        },
      );
      if (!res.ok) throw new SecretBackendError(`Secret store login failed (${res.status})`);
      const body = (await res.json()) as { auth?: { client_token?: string } };
      if (!body.auth?.client_token)
        throw new SecretBackendError('Secret store login returned no token');
      this.token = body.auth.client_token;
    }
    return this.token;
  }

  private request(url: string, token: string): Promise<Response> {
    return this.call(url, { method: 'GET', headers: { 'X-Vault-Token': token } });
  }

  private call(url: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (init.body) headers.set('Content-Type', 'application/json');
    if (this.options.namespace) headers.set('X-Vault-Namespace', this.options.namespace);
    return this.fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
    });
  }
}
