/** Guest identity helpers: deterministic normalization, no fuzzy matching (merges are a human decision). */

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Keeps a leading `+` and digits only (`+20 100-123 4567` → `+201001234567`). */
export function normalizePhone(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

function key(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').trim().toLocaleLowerCase('en');
}

/** Same person within ONE stay's party (a repeated PMS snapshot without profile ids). */
export function sameName(
  a: { givenName: string; familyName: string | null },
  b: { givenName: string; familyName: string | null },
): boolean {
  return key(a.givenName) === key(b.givenName) && key(a.familyName) === key(b.familyName);
}

/** Masked contact value for staff screens (`l***@example.com`, `+20*******67`). */
export function maskIdentifier(kind: string, value: string): string {
  if (kind === 'EMAIL') {
    const [local = '', domain = ''] = value.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  if (value.length <= 4) return '*'.repeat(value.length);
  const head = value.startsWith('+') ? value.slice(0, 3) : value.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(0, value.length - head.length - 2))}${value.slice(-2)}`;
}
