import { customType } from 'drizzle-orm/pg-core';

/** PostgreSQL `ltree` for hierarchical paths (location tree). Labels: [A-Za-z0-9_], dot-separated. */
export const ltree = customType<{ data: string }>({
  dataType() {
    return 'ltree';
  },
});

const LABEL_RE = /[^A-Za-z0-9_]/g;
/** Sanitizes a code into a valid ltree label (`Main-Building 1` → `Main_Building_1`). */
export function ltreeLabel(code: string): string {
  const label = code.trim().replace(LABEL_RE, '_');
  if (!label) throw new Error('ltree label cannot be empty');
  return label;
}
