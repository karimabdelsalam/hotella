import { and, eq, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

export interface TenantScope {
  readonly tenantId: string;
}
export interface PropertyScope extends TenantScope {
  readonly propertyId: string;
}

export class MissingTenantScopeError extends Error {
  constructor() {
    super('A tenant scope is required for this query (CLAUDE.md rule 1)');
    this.name = 'MissingTenantScopeError';
  }
}

/**
 * Builds `tenant_id = :tenant AND …`. Every repository query on a tenant-owned table goes through this so
 * the tenant filter can never be forgotten; cross-tenant ids simply find nothing (→ 404 upstream).
 */
export function tenantWhere(
  table: { tenantId: PgColumn },
  scope: TenantScope,
  ...conditions: Array<SQL | undefined>
): SQL {
  if (!scope?.tenantId) throw new MissingTenantScopeError();
  return and(
    eq(table.tenantId, scope.tenantId),
    ...conditions.filter((c): c is SQL => Boolean(c)),
  )!;
}

export function propertyWhere(
  table: { tenantId: PgColumn; propertyId: PgColumn },
  scope: PropertyScope,
  ...conditions: Array<SQL | undefined>
): SQL {
  return tenantWhere(table, scope, eq(table.propertyId, scope.propertyId), ...conditions);
}
