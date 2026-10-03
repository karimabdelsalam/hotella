# ADR-0007: Shared database, `tenant_id` columns, RLS as defense-in-depth

**Status:** Accepted — 2026-10-03

## Context
Spec §1 requires multi-tenant/multi-property from one codebase; §2.2 requires explicit `tenant_id`/`property_id` and allows RLS only as defense-in-depth; §82.1–2 make tenant isolation and explicit property authorization non-negotiable.

## Decision
- Single PostgreSQL cluster/database shared by all tenants; every tenant-owned table carries `tenant_id` (and `property_id` where scoped) via the `tenantScoped()` helper.
- The repository base class injects the tenant filter from the CLS request context; a test helper `assertTenantScoped(repo)` fails for any query path that omits it.
- Authorization is resolved per property (Membership → Role → Permission) and enforced in guards and application services — this is the authoritative layer.
- From Phase 1.3, RLS policies on tenant-scoped tables use `current_setting('app.tenant_id', true)`, set with `SET LOCAL` at the start of each transaction by the database helper. Platform-admin operations run with an explicit bypass role, audited.
- Cross-tenant id probing returns 404, never 403.

## Consequences
- Operationally simple (one schema set, one migration run) and compatible with later schema-per-tenant or database-per-tenant for premium customers if ever required (the repository abstraction hides it).
- Index design must lead with `tenant_id` (and often `property_id`).
