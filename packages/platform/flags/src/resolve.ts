export type FlagScope = 'PLATFORM' | 'TENANT' | 'PROPERTY';

export interface FlagRow {
  readonly key: string;
  readonly scope: FlagScope;
  readonly scopeId: string | null;
  readonly enabled: boolean;
}

export interface FlagContext {
  readonly tenantId?: string | null;
  readonly propertyId?: string | null;
}

/**
 * Pure resolution: the most specific matching row wins (PROPERTY → TENANT → PLATFORM); no row → false.
 * Deterministic and unit-tested; the service only adds loading and caching.
 */
export function resolveFlag(rows: readonly FlagRow[], key: string, ctx: FlagContext = {}): boolean {
  const forKey = rows.filter((r) => r.key === key);
  if (forKey.length === 0) return false;
  if (ctx.propertyId) {
    const p = forKey.find((r) => r.scope === 'PROPERTY' && r.scopeId === ctx.propertyId);
    if (p) return p.enabled;
  }
  if (ctx.tenantId) {
    const t = forKey.find((r) => r.scope === 'TENANT' && r.scopeId === ctx.tenantId);
    if (t) return t.enabled;
  }
  const platform = forKey.find((r) => r.scope === 'PLATFORM');
  return platform?.enabled ?? false;
}
