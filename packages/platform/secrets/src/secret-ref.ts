/**
 * A SecretRef names WHERE a secret lives, never its value: `<provider>://<path>[#<key>]`.
 * Examples: `env://DATABASE_PASSWORD`, `vault://kv/hotella/prod/whatsapp#token`.
 * Tables and configuration store SecretRefs only (CLAUDE.md rule 13).
 */
export interface SecretRef {
  readonly provider: string;
  readonly path: string;
  readonly key?: string;
}

const REF_RE = /^([a-z][a-z0-9+.-]*):\/\/([^#\s]+)(?:#([^\s]+))?$/i;

export function parseSecretRef(value: string): SecretRef {
  const m = REF_RE.exec(value.trim());
  if (!m)
    throw new SecretRefError(`Invalid SecretRef "${value}". Expected <provider>://<path>[#<key>].`);
  const [, provider, path, key] = m;
  return { provider: provider!.toLowerCase(), path: path!, ...(key ? { key } : {}) };
}

export function isSecretRef(value: unknown): value is string {
  return typeof value === 'string' && REF_RE.test(value.trim());
}

export function formatSecretRef(ref: SecretRef): string {
  return `${ref.provider}://${ref.path}${ref.key ? `#${ref.key}` : ''}`;
}

export class SecretRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretRefError';
  }
}

export class SecretNotFoundError extends Error {
  constructor(public readonly ref: SecretRef) {
    super(`Secret not found: ${formatSecretRef(ref)}`);
    this.name = 'SecretNotFoundError';
  }
}
