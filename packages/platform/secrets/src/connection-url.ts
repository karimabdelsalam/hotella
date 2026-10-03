import type { SecretResolver } from './provider';

/**
 * Returns the connection URL with its password taken from a SecretRef (deployed environments keep credentials out
 * of configuration; CLAUDE.md rule 13). Without a ref the URL is returned unchanged (local development).
 */
export async function urlWithSecretPassword(
  url: string,
  passwordRef: string | null,
  secrets: SecretResolver | null | undefined,
): Promise<string> {
  if (!passwordRef) return url;
  if (!secrets)
    throw new Error('A password SecretRef is configured but no SecretResolver is available');
  const u = new URL(url);
  u.password = await secrets.resolve(passwordRef);
  return u.toString();
}
