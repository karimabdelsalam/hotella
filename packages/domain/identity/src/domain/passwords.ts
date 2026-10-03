import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing (ADR-0011): argon2id with OWASP 2025 minimums (19 MiB memory, 2 iterations, 1 lane).
 * `@node-rs/argon2` defaults to argon2id; the parameters are pinned here so a library default change cannot weaken them.
 */
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

/** A fixed hash verified when the user does not exist, so response time does not reveal which emails are registered. */
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('hotella-timing-equalizer');
  await verifyPassword(await dummyHash, password);
}

export type PasswordProblem = 'too_short' | 'too_long' | 'contains_email';

/** Length-based policy (NIST SP 800-63B): no composition rules, but the password may not contain the email's local part. */
export function checkPasswordPolicy(
  password: string,
  email: string | null,
): PasswordProblem | null {
  if (password.length < PASSWORD_MIN_LENGTH) return 'too_short';
  if (password.length > PASSWORD_MAX_LENGTH) return 'too_long';
  const local = email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) return 'contains_email';
  return null;
}
