# Hotella Developer Guide

**Who this is for:** an engineer joining the project at any point in the next several years. If you can follow this file from a fresh clone to green tests, the repository is healthy. If you cannot, the first thing to fix is this file (Gate C).

> Reading order on day one: this guide → `docs/architecture/overview.md` → `CLAUDE.md` (the rules) → the phase you are working on in `docs/BUILD_PLAN.md` → the relevant sections of `docs/spec/HOTELLA_MASTER_SPEC.md`.

---

## 1. What Hotella is, in one paragraph

A white-label, multi-tenant **Hotel Intelligence Platform**. Hotels (tenants/properties) get guest activation over WhatsApp/web/QR, service requests, housekeeping, engineering (CMMS), inspections, complaints, lost & found, and an AI layer that understands the hotel's live state — all on top of one operations engine and one integration platform (OPERA 5 first). The PMS stays the source of truth for guests and stays; the platform owns everything the PMS does not have. Arabic and English are first-class.

## 2. Setup (target: under 30 minutes)

Prerequisites: Git, Docker (with Compose), Node 24 LTS (`nvm use` reads `.nvmrc`), Corepack enabled (`corepack enable` → pnpm 11 is picked from `package.json#packageManager`). No C/C++ toolchain is needed: the foundation has no native modules that compile at install.

```bash
git clone <repo> hotella && cd hotella
nvm use                      # Node 24 LTS
corepack enable              # pnpm 11, exact version pinned
pnpm install                 # frozen lockfile
cp .env.example .env         # dev defaults only; no secrets needed locally
pnpm dev:infra               # PostgreSQL 18 + pgvector, Valkey 9, SeaweedFS, Mailpit, Grafana (otel-lgtm)
pnpm build                   # compiles packages (SWC) and the API; required once before dev/test
pnpm db:migrate              # applies packages/platform/database/migrations (needs DATABASE_URL from .env)
pnpm dev                     # api (nest start --watch) + packages in watch mode
curl -s localhost:3000/api/v1/health   # liveness
curl -s localhost:3000/api/v1/ready    # readiness: 200 when PostgreSQL + Valkey reachable, else 503 Problem Details with per-dependency details
pnpm test                    # unit + e2e + integration (Testcontainers starts PostgreSQL/Valkey/SeaweedFS; without Docker those suites skip with a reason)
```

> Integration suites print `TEST_INFRA_UNAVAILABLE` and skip when no container runtime is reachable; CI always runs them against real services.

Full verification exactly as CI runs it:

```bash
pnpm format:check && pnpm lint && pnpm lint:selftest && pnpm depcruise && pnpm build && pnpm typecheck && pnpm locales:check && pnpm db:check && pnpm test
```

Useful URLs in dev: API docs `http://localhost:3000/api/docs` (JSON at `/api/docs/json`), worker status `http://localhost:3001/ready`, Grafana `http://localhost:3003`, Mailpit `http://localhost:8025`, SeaweedFS master UI `http://localhost:9333` (S3 on 8333).

Everything above is a `package.json` script; if a script name changes, this section changes in the same PR.

## 3. Map of the repository

```text
apps/          things you run        → api (:3000), worker (:3001), later realtime, guest-web, staff-web, pms-simulator, hotel-agent (.NET)
packages/
  platform/    infrastructure        → config, secrets, observability (logs, request context, tracing), database, events (outbox/inbox),
                                       queue (BullMQ on Valkey), http (Problem Details, idempotency, rate limit, OpenAPI), i18n,
                                       flags, manifest, storage (S3), testing (Testcontainers),
                                       auth (request actor, permission guard, ActionGate)
  domain/      business (one folder per bounded context, one PostgreSQL schema each)
                                     → organization (schema `org`: tenants, properties, location tree, rooms, branding)
  contracts/   zod schemas shared by everything → events, api, later connectors, ai-tools
locales/       ONE ICU MessageFormat catalog (en, ar) used by backend and frontend
docs/          spec, plan, ADRs, traceability, this guide, architecture diagrams
infra/         docker compose, k8s charts, CI pieces
```

A **bounded context** (`packages/domain/<ctx>`) always looks like this:

```text
src/
  public/          ← the ONLY folder other contexts may import (interfaces, DTO types, event names)
  application/     ← use cases; transactions start and end here
  domain/          ← entities, value objects, invariants, domain events (no framework imports)
  infrastructure/  ← drizzle schema.ts, repositories, external adapters
  api/             ← NestJS controllers (thin: validate → call application service → map response)
  <ctx>.module.ts  ← NestJS module + ModuleManifest
  index.ts
```

Dependency direction (enforced by dependency-cruiser; see the graph in `docs/architecture/dependency-graph.svg`):

```text
apps → domain/*/public, platform/*, contracts/*
domain/<a> → platform/*, contracts/*, domain/<b>/public      (never domain/<b>/infrastructure)
platform → contracts (never domain)
contracts → zod only
```

## 4. The ten rules you will hit in your first week

Full list in `CLAUDE.md`; these are the ones that bite newcomers:

1. Every tenant-owned table has `tenant_id`; repositories filter by it automatically; you never write a query that skips it.
2. Ids come from `newId()` (UUIDv7). Never `DEFAULT gen_random_uuid()`.
3. User-facing text is never a string literal. Add a key to `locales/en/<ns>.json` **and** `locales/ar/<ns>.json`; CI fails on a missing twin.
4. Localized business data lives in `<entity>_translations` tables, never `name_en`/`name_ar` columns.
5. Cross-context side effects are events through the outbox (`EventPublisher.publish()` inside the transaction), not direct calls into another context's repository.
6. Mutating endpoints declare a permission and run through `ActionGate`.
7. Important mutations write an audit row. If you ask "is this important?", it is.
8. Never read `process.env` outside `platform-config`/`platform-secrets`. Never `console.log`. Never `require` or `__dirname` (source is ESM-ready even though it compiles to CommonJS today).
9. Published definitions (service versions, workflow versions, prompts…) are immutable; edits create a new version.
10. AI code never touches a provider SDK or a business table directly; it goes through the Model Gateway and registered tools.

## 5. Daily workflow

```bash
git switch -c feat/<ctx>-<short-description>
pnpm --filter @hotella/domain-<ctx> test       # fast loop on one package
pnpm lint && pnpm format && pnpm typecheck && pnpm depcruise
pnpm lint:selftest                             # proves the forbidden-pattern rules still fire
pnpm db:generate <name>                        # after changing a schema.ts; then READ the SQL it produced (migrations/<n>_<name>.sql)
pnpm db:check                                  # CI runs this; schema code not captured by a migration = failure
git commit -m "feat(<ctx>): <what and why>"    # Conventional Commits, commitlint-enforced in CI
```

Open a PR; the template is the four quality gates (automated checks, spec review, docs sync, acceptance). Keep PRs small and single-purpose. Reviewers check the Definition of Done in `BUILD_PLAN.md` §12.

## 6. How to add a new bounded context (worked example: `spa`)

1. **Plan first.** Add a section to `docs/BUILD_PLAN.md` with scope, domain model, migrations, APIs, events, permissions, tests, acceptance (Spec §84.5). Add rows to `docs/TRACEABILITY.md`.
2. `pnpm gen:context spa` (scaffold generator planned for Sprint 0.3) scaffolds `packages/domain/spa` with the folder layout above, a `pgSchema('spa')`, an empty `ModuleManifest`, locale namespaces `locales/{en,ar}/spa.json`, and a tenant-leak test.
3. Define tables in `infrastructure/schema.ts` using the helpers from `@hotella/platform-database` (`baseColumns()`, `tenantScoped()`/`propertyScoped()`, `versioned()`, and `translationColumns()` + `translationUnique()` for `<entity>_translations` tables), wrap each table in `classify(table, { col: 'INTERNAL' | 'CONFIDENTIAL' | … })` (a missing column fails at load), add the file to `drizzle.config.ts` `schema` if it is a new package, run `pnpm db:generate <name>`, review the SQL, commit the migration.
4. Write the domain model in `domain/` (pure TypeScript, unit-tested).
5. Write use cases in `application/`; start transactions with `withTransaction()`; publish events with `EventPublisher`; write audit rows with `AuditWriter`.
6. Declare events in `packages/contracts/events` (`defineEvent('spa.booking.created', 1, schema)`), permissions in the manifest (`spa.read`, `spa.book`), entitlement codes (`SPA`), AI tools if any (`spa.search_availability`).
7. Expose controllers in `api/` with `@RequirePermission()` and `@PropertyScoped()`; validate with zod schemas from `contracts/api`.
8. Export the minimal interface other contexts need from `public/`.
9. Register the module in `apps/api` and, if it has jobs/consumers, in `apps/worker`.
10. Tests: unit (domain), integration (repositories + use cases against Testcontainers), contract (event schemas), tenant-leak, and the acceptance scenario from your plan section.
11. Update `docs/architecture/overview.md` if the context changes a diagram; the dependency graph regenerates in CI.

## 7. How to add a guest-facing service (e.g. `PILLOW_MENU`)

No code: create a service definition in the catalog (staff API/UI), add translations for `en`/`ar`, bind an SLA policy and workflow version, publish. If the service needs a new *workflow action* or *guard*, that is code in `packages/domain/operations` (register a named handler) — not a new task engine.

## 8. Testing philosophy

- Unit tests prove domain rules (SLA math, state machines, credit rules). Table-driven where possible.
- Integration tests run against **real** PostgreSQL 18 and Valkey 9 (Testcontainers). We do not mock the database: tenant leaks and outbox atomicity only show up on a real engine.
- Contract tests pin event schemas, connector manifests and the OpenAPI document (snapshot).
- Every phase has an end-to-end acceptance scenario driven by the PMS simulator; it is the executable definition of "done".
- A failing test is never "flaky": find the cause or make the test deterministic.

## 9. Observability while developing

Every request has an `X-Correlation-Id` (echoed when the caller sends a well-formed one, minted otherwise, always returned in the response). Every error is an RFC 9457 Problem Details body with a stable `code` and a `detail` localized to the request locale (`?lang=`, `X-Locale`, `Accept-Language`). Every log line carries `correlation_id`, `trace_id` (when `OTEL_ENABLED=true`), `tenant_id`, `property_id`, `actor_type`, `actor_id` from the request context (`RequestContext` in `@hotella/platform-observability`). Background work uses `requestContext.run(seed, fn)` so jobs and consumers log under the id that travelled with them. Grep logs for the id, or open Grafana → Tempo and search by `correlation_id`.

## 10. Upgrading dependencies

Renovate opens grouped PRs weekly. Patch/minor: merge when CI is green. Major: must pass the Maturity Gate in `docs/adr/0016-technology-currency-and-longevity.md` (GA ≥ 6 months, ecosystem and tooling ready, exit path, no node-gyp) and update that ADR in the same PR. The HOLD list there says when NestJS 12, TypeScript 7, Node 26 and Drizzle 1.0 are due for re-evaluation. Never upgrade a major "while you are at it" inside a feature PR.

## 11. Where to ask / how to decide

- "Is this allowed?" → `CLAUDE.md`. If the rule is unclear, the spec section it cites decides.
- "Why was it done this way?" → `docs/adr/`.
- "What should it do?" → `docs/spec/HOTELLA_MASTER_SPEC.md` via `docs/TRACEABILITY.md`.
- "What is a stayover / OOO / FIAS?" → `docs/GLOSSARY.md`.
- Material disagreement with the spec → write an ADR proposal; do not silently deviate.
