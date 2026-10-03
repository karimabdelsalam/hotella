import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Opaque bearer secrets (refresh tokens, invitations): 256 random bits, base64url, with a type prefix. */
export function generateOpaqueToken(prefix: 'rt' | 'inv'): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

/** Only this digest is stored; the token itself is shown once. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * AES-256-GCM sealing for small secrets at rest (TOTP seeds). Format: `v1.<iv>.<tag>.<ciphertext>` (base64url).
 * The key comes from a SecretRef; rotating it means re-enrolling MFA (documented in the runbook).
 */
export function seal(plaintext: string, key: Buffer): string {
  if (key.length !== 32) throw new Error('seal key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), ct]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function unseal(sealed: string, key: Buffer): string {
  const [version, iv, tag, ct] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || ct === undefined)
    throw new Error('unsupported sealed format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString(
    'utf8',
  );
}
