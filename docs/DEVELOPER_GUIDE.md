# Hotella Developer Guide

**Who this is for:** an engineer joining the project at any point in the next several years. If you can follow this file from a fresh clone to green tests, the repository is healthy. If you cannot, the first thing to fix is this file (Gate C).

> Reading order on day one: this guide → `docs/architecture/overview.md` → `CLAUDE.md` (the rules) → the phase you are working on in `docs/BUILD_PLAN.md` → the relevant sections of `docs/spec/HOTELLA_MASTER_SPEC.md`.

---

## 1. What Hotella is, in one paragraph

A white-label, multi-tenant **Hotel Intelligence Platform**. Hotels (tenants/properties) get guest activation over WhatsApp/web/QR, service requests, housekeeping, engineering (CMMS), inspections, complaints, lost & found, and an AI layer that understands the hotel's live state — all on top of one operations engine and one integration platform (OPERA 5 first). The PMS stays the source of truth for guests and stays; the platform owns everything the PMS does not have. Arabic and English are first-class.

## 2. Setup (target: under 30 minutes)

Prerequisites: Git, Docker (with Compose), Node 24 LTS (`nvm use` reads `.nvmrc`), Corepack enabled (`corepack enable` → pnpm 10 is picked from `package.json#packageManager`). No C/C++ toolchain is needed: the foundation has no native modules that compile at install.

```bash
git clone <repo> hotella && cd hotella
nvm use                      # Node 24 LTS
corepack enable              # pnpm 10, exact version pinned
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

Staff web portal (`apps/staff-web`, ADR-0009) against the running API:

```bash
pnpm --filter @hotella/staff-web dev   # http://localhost:3100/en (or /ar); WEB_API_URL defaults to localhost:3000/api/v1
pnpm --filter @hotella/staff-web e2e   # Playwright, English (LTR) and Arabic (RTL), API mocked in the browser
```

Guest web app (`apps/guest-web`, ADR-0009), the PWA guests open from activation links (`/a/<token>`) and room QR codes
(`/q/<token>`); set `PUBLIC_BASE_URL=http://localhost:3200` for the API so the links it issues open it:

```bash
pnpm --filter @hotella/guest-web dev   # http://localhost:3200/en (or /ar)
pnpm --filter @hotella/guest-web e2e   # Playwright, English (LTR) and Arabic (RTL), API mocked in the browser
```

The guest session token lives only in the httpOnly cookie `hotella_gs` (set by `/bff/verify` and `/bff/complete`); the
same-origin proxy `/hotella/*` turns it into `X-Guest-Session` and forwards `guest/*` and `public/*` routes only.

Both apps wear the hotel's brand at run time: its logo (`/hotella/public/branding/logo?property=…`, or its initials
when there is none), name and colour (the `--brand-primary` CSS variable; `bg-brand`, `text-brand`, `bg-brand-soft`
utilities). A hotel manager sets them in the staff web at `/branding`; logos go to object storage (SeaweedFS locally,
`STORAGE_*` settings). The typeface is Cairo, bundled with each app (`@fontsource-variable/cairo`), so no page loads a
font from the internet. Shared pieces (`BrandMark`, icons, the attribution footer) live in `packages/ui`.

UI strings live in `locales/{en,ar}/staff.json` and `locales/{en,ar}/portal.json` (the shared catalog); `scripts/sync-messages.mjs` turns them into the app's
next-intl messages at build/dev time. Layout uses logical properties only (`ms-*`, `me-*`, `text-start`, `border-e`).

> Integration suites print `TEST_INFRA_UNAVAILABLE` and skip when no container runtime is reachable; CI always runs them against real services.
> Without Docker you can still run the database suites against any PostgreSQL 16+ you have: `TEST_DATABASE_URL=postgresql://user@host:5432/empty_db pnpm test` (turbo passes the `TEST_*` variables through; CI's PostgreSQL 18 stays the authority).

First sign-in on a fresh database (the only way to create a platform administrator; there is no HTTP endpoint for it):

```bash
printf '%s' 'a long passphrase of yours' | pnpm iam:bootstrap-admin --email you@example.com --given-name You [--locale ar]
curl -s localhost:3000/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a long passphrase of yours"}'      # → accessToken, refreshToken
curl -s localhost:3000/api/v1/me -H "authorization: Bearer <accessToken>"
```

The password is read from stdin so it never lands in shell history. `--role support` creates a support engineer instead: no access of their own, only time-limited grants a hotel approves (`POST /api/v1/tenants/{tenantId}/support-access`). Hotel staff sign in with their tenant code (`"tenantCode": "NILE"`); they are created by an administrator through `POST /api/v1/tenants/{tenantId}/users`, which returns a one-time invitation token for `POST /api/v1/auth/invitations/accept` (e-mail/WhatsApp delivery arrives with the comms context). In development, leaving `IAM_JWT_SIGNING_KEY_REF`/`IAM_MFA_KEY_REF` empty makes the API generate ephemeral keys, so sessions end when it restarts.

Full verification exactly as CI runs it:

```bash
pnpm format:check && pnpm lint && pnpm lint:selftest && pnpm depcruise && pnpm build && pnpm typecheck && pnpm locales:check && pnpm db:check && pnpm test
```

Useful URLs in dev: API docs `http://localhost:3000/api/docs` (JSON at `/api/docs/json`), worker status `http://localhost:3001/ready`, Grafana `http://localhost:3003`, Mailpit `http://localhost:8025`, SeaweedFS master UI `http://localhost:9333` (S3 on 8333).

Everything above is a `package.json` script; if a script name changes, this section changes in the same PR.

## 3. Map of the repository

```text
apps/          things you run        → api (:3000), worker (:3001), agent-gateway (:8443, TLS + client certificates),
                                       pms-simulator (reference hotel agent + simulated PMS), staff-web (:3100, Next.js
                                       inbox with a BFF for sign-in), guest-web (:3200, guest PWA); hotel-agent
                                       (.NET 10 on-prem agent, `dotnet`, not pnpm). The realtime
                                       WebSocket gateway runs inside api for now.
packages/
  platform/    infrastructure        → config, secrets, pki (agent CA, device certificates, command signatures), observability (logs, request context, tracing), database, events (outbox/inbox),
                                       queue (BullMQ on Valkey), http (Problem Details, idempotency, rate limit, OpenAPI), i18n,
                                       flags, manifest, storage (S3), testing (Testcontainers),
                                       auth (request actor, permission guard, ActionGate), audit (append-only audit log),
                                       settings (typed hierarchical configuration, retention, attribution policy)
  domain/      business (one folder per bounded context, one PostgreSQL schema each)
                                     → organization (schema `org`: tenants, properties, location tree, rooms, departments,
                                       branding)
                                     → identity (schema `iam`: staff users, memberships, roles/permissions, sessions, MFA)
                                     → integrations (schema `integration`: connectors, instances, raw message inbox,
                                       parser/mapper → canonical hotel.* events, mappings, exceptions, external refs)
                                     → guest (schema `guest`: guests, stays, party, room-assignment history — written only
                                       by the StayProjector from canonical events; staff API is read-only; guest access
                                       grants and passwordless guest sessions that follow the stay)
                                     → operations (schema `ops`: the one operations engine — work items created by modules
                                       through OPERATIONS_API, tasks, assignment history, task history, SLA with business
                                       hours and escalation ladders, deduplicated alerts, immutable workflow versions,
                                       generic approvals, notification intents → deliveries (in-app, e-mail))
                                     → communications (schema `comms`: channels bound to provider adapters — WhatsApp via
                                       Meta Cloud API or a BSP, SMS — with SecretRef credentials, channel identities,
                                       guest activation: links, room QR, OTP with WhatsApp → SMS fallback, staff-assisted
                                       verification, guest session guard; provider webhooks, the conversation engine,
                                       the staff inbox and the realtime gateway on /api/v1/realtime)
  contracts/   zod schemas shared by everything → events (incl. canonical hotel.*), api, connectors (Connector SDK v0),
                                       later ai-tools
locales/       ONE ICU MessageFormat catalog (en, ar) used by backend and frontend
docs/          spec, plan, ADRs, traceability, this guide, architecture diagrams, runbooks, acceptance records
infra/         docker: dev compose, application Dockerfile, pilot compose + pilot.sh, postgres+pgBackRest image
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

Each context's Nest module is `@Global()` and exports only its public API token (e.g. `ORGANIZATION_API`), so another context injects it without importing that module. Public API tokens are registered symbols (`Symbol.for('hotella.domain.<ctx>.api')`).

How a request is authorized (packages `platform-auth` + `domain-identity`):

```text
Authorization: Bearer <jwt> → JwtAuthenticationStrategy (signature + live session + ACTIVE user) → RequestActor in CLS
→ @TenantScoped / @PropertyScoped: a property outside the actor's tenant → 404 (never 403)
→ @RequirePermission('x.y.z'): Membership → Role → Permission for that property (tenant-wide memberships cover all)
→ service → ActionGate (same check for jobs/AI, then entitlement → feature → configuration → connector → AI policy)
```

Use `@RequirePermission(code, { checkedBy: 'gate' })` only when the scope is known after loading the resource (e.g. a membership's property); the service's ActionGate then checks it.

Two more layers sit under that pipeline:

- **Row-level security.** `TransactionRunner.run()` pins every transaction of a tenant-scoped request to its tenant (`app.tenant_id`); PostgreSQL policies then hide other tenants' rows even if a query forgets its filter. Wrap reads in `TransactionRunner.read()` (read-only, same pinning) so they are guarded too; event consumers run pinned to the event's tenant. Superusers bypass RLS, so the API must connect as an ordinary database role everywhere except local throwaway setups — integration suites use `applicationRoleUrl(adminUrl)` for exactly that, and a database test fails if any table with `tenant_id` lacks forced RLS.
- **Configuration.** A tunable value is a setting, not a constant and not a feature flag: declare it with `defineSetting({ key: '<ctx>.<entity>.<name>', scopes, schema, default, descriptionKey })`, register it in your module's `onModuleInit` (`SettingsRegistry.register`), read it with `ConfigurationService.effective(setting, { tenantId, propertyId })` (property → tenant → platform → default). Writes go through `PUT /api/v1/config/values/{key}` with history, event and audit.

How a PMS message becomes a domain fact (packages `contracts-connectors` + `domain-integrations`, Spec §50):

```text
agent / simulator → IngestService.ingest(instance, raw)   stored in integration.integration_messages, unique (instance, source_message_id)
→ connector adapter parse()                               pure; FIAS/OWS shapes → connector-neutral InboundRecord (or PARSE_ERROR)
→ capability filter                                       records for capabilities the hotel did not enable are not applied
→ mapper                                                  external codes → confirmed integration_mappings only; unknown REQUIRED
                                                          code (room) ⇒ PENDING_MAPPING + exception; later messages of the same
                                                          reservation/room wait as HELD; unknown OPTIONAL code (rate, VIP) ⇒ null
→ canonical hotel.* event in the outbox                   consumed by core contexts (guest, later housekeeping, grants)
```

A core context never sees vendor formats or vendor ids: it resolves and links opaque references through `INTEGRATIONS_API` (`resolveReference` / `linkReference`). The guest context's `StayProjector` runs in the worker (`GuestEventsModule`), one transaction per event with the inbox row, and publishes `guest.stay.*` events with internal ids for everyone downstream. Contexts expose a `<Ctx>CoreModule` without HTTP routes for background processes and a full module for the API.

Operational work (Spec §8): a module never builds its own task table. At boot it registers its kinds of work (`OPERATIONS_API.registerWorkItemKind({ code: 'HK_JOB', module: 'hk', … })`); when something needs doing it calls `OPERATIONS_API.createWorkItem(…)` inside its own transaction, naming its record as the source. The engine owns tasks (lifecycle in BUILD_PLAN §7.5), assignment history and task history, and publishes `ops.work_item.*` / `ops.task.*` events the module can react to (e.g. close its record when the work item is `RESOLVED`). Staff take, start, pause and finish tasks through `/properties/:id/tasks/…`; a task given to a department (`TEAM`) waits in that department's queue until a member claims it. If a property has an SLA policy that matches the work (`/properties/:id/sla-policies`, optionally on `/business-hours`), the clock starts with the work item; the worker's `ops.sla.sweep` job records breaches, climbs the escalation ladder and raises deduplicated alerts (`/properties/:id/alerts`). Wall-clock time in a hotel's time zone goes through `@hotella/platform-time`, never hand-written offsets. A property can drive work with a published workflow (`/properties/:id/workflows`, `workflowCode` on `createWorkItem`): a JSON state machine whose guards and actions are registered in code (`WorkflowRegistry`). Sensitive actions go through the approval engine: register a kind with its handler (`OPERATIONS_API.registerApprovalKind`), ask with `requestApproval`; the handler runs only after a person other than the requester approves (`/properties/:id/approvals`). Background processes that need the engine compose `OrganizationCoreModule` and `IdentityDirectoryModule` instead of the HTTP modules. To tell people something, record an intent (`NotificationService.notify`: template key + params, recipient user/role/permission, priority); never call a channel directly (CLAUDE.md rule 18). Locally, e-mails land in Mailpit (http://localhost:8025).

Guest services (Spec §7): the catalog context (`@hotella/domain-catalog`) keeps categories and services with versioned behaviour (department, priority, optional workflow code, required fields, eligibility, availability, duplicate window) and translations. Services without `propertyId` serve every property of the tenant (tenant-wide membership needed); a property service with the same code replaces them there once published, or opts the property out when retired. Edit a published service by starting the next draft (`POST /catalog/services/:id/drafts`), change it with `PATCH /catalog/versions/:id` and publish it; the database refuses changes to a published version. `POST /properties/:id/catalog/starter` imports the Spec §7 examples with their texts from `locales/<locale>/catalog.json`. Guests read `GET /guest/services` and ask with `POST /guest/requests` (staff on their behalf: `POST /properties/:id/stays/:stayId/service-requests`; board: `GET /properties/:id/service-requests`). Every ask goes through `createServiceRequest` (`CATALOG_API` for other contexts): validation, duplicate window (a repeat is related to the open request), availability, then the request and its `SERVICE_REQUEST` work item in one transaction; the request follows its work item through the worker (`catalog.service-requests` consumer). Guest routes in any context use `GuestSessionGuard`, `RequireGuestScope` and `CurrentGuest` from `@hotella/domain-guest/public`. Integration specs share their app composition through `src/testing/` (never built).

AI (Spec §27–§42, ADR-0018): every model call goes through `MODEL_GATEWAY` (`@hotella/domain-ai/public`) with a capability, never a model name, and with context parts labelled by data class; the gateway routes, applies the egress policy, falls back and records `ai.model_calls`. No other package calls a model or a provider SDK. Tests and local development use the `FAKE` provider kind (`FakeModelProvider`, scripted replies); an on-prem model server is an `OPENAI_COMPATIBLE` provider with its base URL. External providers (Anthropic and OpenAI are approved, ADR-0018) stay off until the platform allow-list names them and the tenant opts in; each hotel then has a monthly budget, 100 USD by default (`ai.budget.monthly_limit_minor`). An AI agent acts only through registered tools (`ToolRegistry`, declared in `AI_MANIFEST.aiTools`) run by `ToolExecutor`: the deterministic policy decides (READ/LOW at once, MEDIUM only when the agent version allows it, HIGH as an `AI_ACTION` approval proposal, CRITICAL never), and the call goes through the ActionGate as an `AI_AGENT` actor holding only its tools' permissions. Apps that host tools pass `...AiModule.gateStages()` to `AuthModule.forRoot({ stages })`; without them AI actors are refused. A new tool needs its zod input, risk and required permission, a manifest entry and a test in `tools.integration.spec.ts`. The Guest Concierge (`GUEST_CONCIERGE`, defined in `packages/domain/ai/src/domain/agents.ts`) runs in the worker on `background-ai` when a verified guest writes in a conversation whose AI mode is `AUTO` or `ASSIST`; to try it locally, route `REASONING_HIGH` to a model (`PUT /ai/routing-rules`), set `comms.ai_mode.default` for the property, and watch `GET /properties/:id/ai/executions`. Changing a built-in agent or prompt means bumping its version number; published versions are immutable. Hotel knowledge (`@hotella/domain-knowledge`) is managed under `/properties/:id/knowledge/documents` (versions are published, never edited) and searched with `POST /properties/:id/knowledge/search`; the vector half needs an `EMBEDDING` route, the keyword half works without one. Local PostgreSQL needs the pgvector extension (the compose image has it).

Housekeeping (`@hotella/domain-housekeeping`, schema `hk`, Spec §9) keeps a projection of each room (`/properties/:id/housekeeping/rooms`) that the worker moves from canonical PMS events, cleaning jobs as `HK_JOB` work items (`…/housekeeping/jobs`, generated on check-out and by the hourly `hk.stayover.generate` sweep), readiness per `hk.readiness.dimensions` and the assignment proposal; the staff screen is `apps/staff-web` `/housekeeping`. Engineering (`@hotella/domain-engineering`, schema `eng`, Spec §10) holds tenant-wide equipment types, models and failure codes under `/eng/*` (import the starter taxonomy with `POST /eng/failure-codes/starter`) and each property's assets under `/properties/:id/eng/assets`; manuals are knowledge documents linked with `POST …/eng/asset-documents`. A context that contributes an AI tool registers it through `AI_TOOL_REGISTRY` (`ai/public`) at module init and declares it in its own manifest's `aiTools`. Inspections (`@hotella/domain-inspection`, schema `inspection`, Spec §11) hold tenant-wide checklists under `/inspection/templates` (draft, then publish; published versions never change; a hotel's staff read them at `/properties/:id/inspection-templates`, which needs the permission only in that hotel) and each property's inspections under `/properties/:id/inspections`; the staff screen is `/inspections`. Guest relations (`@hotella/domain-relations`, schema `relations`, Spec §12) holds tenant-wide complaint categories under `/relations/categories` (import the starter set with `POST /relations/categories/starter`; a hotel's staff read them at `/properties/:id/complaint-categories`) and each property's complaints, AI complaint candidates and service recovery under `/properties/:id/complaints` and `/properties/:id/complaint-candidates`; recovery that costs money becomes a `RECOVERY_ACTION` approval; the staff screen is `/relations`. Lost & Found (`@hotella/domain-lostfound`, schema `lostfound`, Spec §13) lives under `/properties/:id/lostfound/items` and `/properties/:id/lostfound/matches`; matching is deterministic (`domain/items.ts`), the worker adds AI-read attributes from the description, and release and disposal are explicit actions; the staff screen is `/lostfound`. The logbook (`@hotella/domain-logbook`, schema `logbook`, Spec §14) is under `/properties/:id/logbook` (`shift`, `entries`, `handovers`); shifts come from the setting `logbook.shift.starts`, and handovers are drafted by the `SHIFT_HANDOVER` assistant from facts counted by `FactsService`; the staff screen is `/logbook`. Staff-facing assistants (the Engineering Copilot, `POST /properties/:id/eng/copilot`) run through `STAFF_ASSISTANT_API` with READ tools only; arrival risk for the front desk is `GET /properties/:id/housekeeping/arrival-risk` and the staff web pages are `/engineering` and `/arrivals`.

Trying the agent link locally: `pnpm --filter @hotella/agent-gateway dev` (outside production it creates an ephemeral agent CA and logs a warning), create an instance and an enrollment token through the staff API, then `node apps/pms-simulator/dist/main.js enroll --gateway https://localhost:8443 --ca <ca.pem> --token <token>` and `… run --gateway https://localhost:8443 --scenario apps/pms-simulator/scenarios/basic-stay.yml`. The quickest full loop is the test `pnpm --filter @hotella/pms-simulator test`, which starts both sides over real mutual TLS.

The production hotel agent is .NET 10 (`apps/hotel-agent`, BUILD_PLAN §10 Phase 10). With the .NET 10 SDK installed: `dotnet test apps/hotel-agent/Hotella.Agent.slnx` builds everything (analyzers are errors) and runs the unit tests, including the vector shared with `platform-pki`; then `TEST_DOTNET_AGENT=$PWD/apps/hotel-agent/artifacts/bin pnpm --filter @hotella/pms-simulator test` also runs the cross-language suite, where the .NET link and the `hotella-agent` executable talk to the real gateway (without the variable that suite is skipped). By hand: `dotnet apps/hotel-agent/artifacts/bin/Hotella.Agent/debug/hotella-agent.dll enroll --token-file <file> --ca <ca.pem> --Agent:Gateway=https://localhost:8443 --Agent:DataDirectory=/tmp/agent`, then `status` and `run` with the same switches plus `--Agent:ConnectorCode=SIM_PMS --Agent:Capabilities:0=CHECKIN_EVENT …` (see `src/Hotella.Agent/agent.example.json`). Any change to the link protocol is made in `packages/contracts/connectors` and both agents in the same PR.

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
7. Important mutations write an audit row: `AuditWriter.record({ action, entityType, entityId, before, after, reason })` inside the same `tx.run(...)` as the change (it refuses to run outside one). Actor, tenant, property and correlation id come from the request; sensitive columns are redacted by data class. If you ask "is this important?", it is.
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

## 11. Deploying (pilot)

The pilot runs on one Linux host with `infra/docker/compose.pilot.yml`, driven by `infra/docker/pilot/pilot.sh` (`init → up → vault-init → migrate → start → admin`, plus `backup`, `restore-drill`, `status`). Images come from `infra/docker/Dockerfile` (targets `api`, `worker`); credentials live in OpenBao and reach the services through AppRole; the application uses the ordinary database role `hotella_app`. CI's "pilot deployment smoke" job runs exactly these commands on every push. Operations procedures: `docs/runbooks/`.

## 12. Where to ask / how to decide

- "Is this allowed?" → `CLAUDE.md`. If the rule is unclear, the spec section it cites decides.
- "Why was it done this way?" → `docs/adr/`.
- "What should it do?" → `docs/spec/HOTELLA_MASTER_SPEC.md` via `docs/TRACEABILITY.md`.
- "What is a stayover / OOO / FIAS?" → `docs/GLOSSARY.md`.
- Material disagreement with the spec → write an ADR proposal; do not silently deviate.
