import { parseSecretRef, SecretNotFoundError, SecretRefError, type SecretRef } from './secret-ref';

/** A backend that can resolve SecretRefs of one scheme. Values are never cached beyond `ttlMs`. */
export interface SecretProvider {
  readonly scheme: string;
  get(ref: SecretRef): Promise<string>;
}

/**
 * `env://NAME` — reads the process environment. For local development, tests and CI only.
 * This package (with platform-config) is the only place allowed to read process.env.
 */
export class EnvSecretProvider implements SecretProvider {
  readonly scheme = 'env';
  constructor(private readonly env: Readonly<Record<string, string | undefined>> = process.env) {}

  async get(ref: SecretRef): Promise<string> {
    if (ref.key) throw new SecretRefError(`env:// refs do not take a #key (got "${ref.key}")`);
    const value = this.env[ref.path];
    if (value === undefined || value === '') throw new SecretNotFoundError(ref);
    return value;
  }
}

/** Routes by scheme to the registered providers; caches resolved values briefly to avoid hot-path lookups. */
export class SecretResolver {
  private readonly providers = new Map<string, SecretProvider>();
  private readonly cache = new Map<string, { value: string; expiresAt: number }>();

  constructor(
    providers: ReadonlyArray<SecretProvider>,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {
    for (const p of providers) this.providers.set(p.scheme, p);
  }

  async resolve(refOrString: SecretRef | string): Promise<string> {
    const ref = typeof refOrString === 'string' ? parseSecretRef(refOrString) : refOrString;
    const cacheKey = `${ref.provider}://${ref.path}#${ref.key ?? ''}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expiresAt > this.now()) return hit.value;
    const provider = this.providers.get(ref.provider);
    if (!provider)
      throw new SecretRefError(`No SecretProvider registered for scheme "${ref.provider}"`);
    const value = await provider.get(ref);
    this.cache.set(cacheKey, { value, expiresAt: this.now() + this.ttlMs });
    return value;
  }

  /** Drop cached values (e.g. after rotation). */
  invalidate(): void {
    this.cache.clear();
  }
}
