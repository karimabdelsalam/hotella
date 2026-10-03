import { sensitiveColumnNames } from '@hotella/platform-database';
import { SENSITIVE_KEYS } from '@hotella/platform-observability';

export const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;

function snake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Prepares a before/after snapshot for the audit log (CLAUDE.md rule 21): any property whose column is classified
 * SENSITIVE or RESTRICTED (password hashes, MFA seeds, token hashes…) or whose name is a known secret key is replaced
 * by "[REDACTED]". Dates become ISO strings; depth is bounded.
 */
export function redactForAudit(value: unknown): unknown {
  const columns = new Set(sensitiveColumnNames());
  const keys = new Set(SENSITIVE_KEYS.map((k) => k.toLowerCase()));
  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return v ?? null;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'bigint') return v.toString();
    if (typeof v !== 'object') return v;
    if (depth >= MAX_DEPTH) return '[TRUNCATED]';
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const sk = snake(k);
      out[k] =
        columns.has(sk) || keys.has(k.toLowerCase()) || keys.has(sk)
          ? REDACTED
          : walk(x, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}
