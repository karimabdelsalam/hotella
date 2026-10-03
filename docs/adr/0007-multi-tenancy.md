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

## Implementation notes (Phase 1, 2026-10-03)
- **Repository filter:** repositories take an explicit `TenantScope`/`PropertyScope` argument (`tenantWhere`/`propertyWhere`) instead of reading CLS implicitly; the scope type makes an unscoped call a compile error. Platform-level lookups (login, session checks, permission catalog) are named as such in the repository.
- **Probing → 404:** the auth guard resolves the property's tenant through `PROPERTY_SCOPE_VERIFIER` (organization context) before any permission check: a tenant user naming a property of another tenant, or one that does not exist, gets 404; platform staff acting on a property get its tenant as their scope (support grants are checked against it). Services that verify properties outside the guard (configuration) use the same verifier.
- **RLS (migration 0006):** policies on every tenant-owned table, `FORCE`d so they also bind the table owner. `TransactionRunner` sets `app.tenant_id` with `set_config(…, true)` (transaction-local) whenever the request acts within a tenant. When the setting is absent — platform administration, background jobs, migrations — policies do not restrict; this replaces the "explicit bypass role" above, because those paths already run without a tenant and are audited at the application level. Tables holding platform-wide rows next to tenant rows (system roles, platform configuration and retention defaults, platform-level audit events) keep the `tenant_id IS NULL` rows visible inside a tenant transaction.
- **Deployment requirement:** superusers and `BYPASSRLS` roles ignore RLS, so the application must connect as an ordinary role in every deployed environment (pilot runbook). The identity integration suite runs the whole API as such a role and includes a smoke test proving that, inside a tenant transaction, another tenant's rows are invisible and unwritable.
- **Known limit:** reads outside a transaction rely on the repository filter only. Extending the tenant pin to every request-scoped read is tracked for Phase 2 together with the guest context.
