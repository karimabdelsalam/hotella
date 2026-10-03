# HOTELLA — Build Plan

**Status:** Active execution plan (derived from `docs/spec/HOTELLA_MASTER_SPEC.md` v1.0)
**Version:** 1.5 (Phase 0 delivered and accepted; see `docs/acceptance/phase-0.md`)
**Date:** 2026-10-03
**Audience:** Implementation team / Claude engineering agents

> The Master Spec is the architecture source of truth. This document says *in which order*, *with which concrete technology choices*, and *with which acceptance criteria* we build it. If this plan and the spec disagree, the spec wins and this plan gets corrected (with an ADR if the deviation is material).

---

## 0. How to use this plan

1. Work strictly phase by phase (Spec §84.4). A phase is not "done" until its acceptance criteria pass in CI.
2. Before coding any phase, its section here must contain: scope, domain model, migrations, APIs, events, permissions, tests, acceptance criteria (Spec §84.5). Phases 0–5 already carry that detail below. Phases 6–13 are outlined and get expanded when their predecessor is accepted.
3. Every module follows the **Module Definition of Done** (§9 of this plan) — no exceptions for "internal" modules.
4. Material technology or boundary decisions are recorded in `docs/adr/`. Decisions already taken for Phase 0 are listed in §2.
5. **Traceability:** `docs/TRACEABILITY.md` maps every spec section to the plan section, ADR and phase that satisfies it. A spec requirement with no row there is a planning bug; fix the plan before coding.
6. **Quality gates (every sprint, no exceptions):**
   - *Gate A — Automated:* lint (incl. boundaries, no-`process.env`, no-`console`, no-`gen_random_uuid`), typecheck, unit + integration + contract tests, migration drift check, `en`/`ar` key parity, OpenAPI snapshot. All green in CI before review.
   - *Gate B — Spec review:* reviewer walks the Module Definition of Done (§12) and the relevant TRACEABILITY rows; any invariant in `CLAUDE.md` touched by the change is cited in the PR description with how it is honoured.
   - *Gate C — Docs sync:* BUILD_PLAN section, ADRs, TRACEABILITY and CLAUDE.md updated in the same PR if anything deviated.
   - *Gate D — Acceptance:* the sprint's acceptance checklist is executed and its result recorded in the PR.
7. **Versions:** the **Maturity Gate** of ADR-0016 decides (GA ≥ 6 months with ≥ 2 patches, ecosystem and tooling ready, documented exit path, no node-gyp). Baseline: Node 24 LTS, TypeScript 6, NestJS 11, Zod 4 + nestjs-zod, PostgreSQL 18, Drizzle 0.45, Valkey 9, pnpm 10 (11 after 28 Oct 2026), ESLint 10 + Prettier 3, Vitest 4, OTel SDK 2, Next.js 16 LTS, Tailwind 4, .NET 10 LTS. HOLD with dates: NestJS 12/ESM, TypeScript 7, Node 26, Drizzle 1.0, oxlint. Exact versions are pinned by `pnpm-lock.yaml`; Renovate proposes, CI proves, a human merges; majors change only with an ADR-0016 update.
8. **Naming conventions (binding):**
   - Events: `<context>.<entity>.<past_tense_event>.v<N>` for platform events (e.g. `ops.task.assigned.v1`); `hotel.<entity>.<event>.v<N>` is reserved for canonical PMS/hotel events produced by the Integration Platform (Spec §51).
   - Permissions: `<domain>.<resource>.<action>` or `<resource>.<action>` as in Spec §5 (e.g. `engineering.work_order.create`, `task.assign`).
   - Locale keys: `<domain>.<entity>.<message>` (Spec §79.1). Error codes: same shape, stored in `errors.json`.
   - PostgreSQL schemas: `org, iam, guest, catalog, ops, hk, eng, inspection, relations, lostfound, logbook, comms, knowledge, ai, integration, license, audit, platform`.
   - Tables: snake_case plural; translation tables `<singular>_translations`; history tables keep every row (no updates to closed rows).

---

## 1. Study synthesis — what the spec actually demands

Reading the spec end to end, the product decomposes into **three layers of work**, and the ordering of the roadmap follows directly from their dependencies.

### 1.1 Foundations everything sits on (Spec §2, §65–§74, §79, §82)

| Foundation | Where it bites | Must exist before |
|---|---|---|
| Tenant / property scoping on every row and every request | all domains | Phase 1 |
| Explicit, granular permissions resolved via Membership → Role → Permission | all APIs, all AI tools | Phase 1 |
| Transactional outbox / inbox, idempotent consumers, canonical event envelope (§51) | every cross-domain workflow, every integration | Phase 0 |
| Audit with actor types USER / GUEST / AI_AGENT / SYSTEM / INTEGRATION / SUPPORT (§68) | every important mutation | Phase 1 |
| Localization: external locale resources, translation tables not `*_en/*_ar` columns, locale resolution chain, RTL (§79) | every user-facing string and every localized business entity | Phase 0 |
| Config inheritance Platform → Tenant → Property → Department (§73) | branding, SLA overrides, credits, readiness rules | Phase 1 |
| Observability: correlation_id, trace_id, tenant_id, property_id on every log/trace (§70) | debugging any flow | Phase 0 |
| Secrets abstraction (§67) | any credential | Phase 0 |
| Versioning of published definitions (§82.6) | services, workflows, inspections, prompts, agents, PM procedures, plans | pattern defined in Phase 0, first use Phase 3 |

### 1.2 The unified action gate is the architectural spine (Spec §60, §42)

```text
Action Request
 -> Authorization        (IAM, Phase 1)
 -> Entitlement          (Licensing, stub in Phase 1, real in Phase 11)
 -> Feature Availability (Feature flags, Phase 0/1)
 -> Configuration        (Config service, Phase 1)
 -> Connector Capability (Integration platform, Phase 2 sim / Phase 10 real)
 -> AI Policy            (AI platform, Phase 6)
 -> Execute
```

We build this as **one pipeline with pluggable stages** from Phase 1 onwards, with later stages present as pass-through stubs. Human requests and AI tool calls go through the *same* pipeline (Spec §5 "AI agents must pass through the same authorization/policy layer as human users"). Retro-fitting this later is the single most expensive mistake we can make.

### 1.3 Separation rules that shape the schema (recurring theme in the spec)

| Keep separate | Spec |
|---|---|
| Person ≠ User ≠ Guest | §5 |
| Guest identity ≠ PMS identity (external_references) | §6 |
| Channel identity (phone) ≠ authorization (Guest Access Grant) | §18.3 |
| Room status ≠ cleaning job | §9 |
| Complaint ≠ service request | §12 |
| Alert ≠ notification | §15, §25 |
| Notification intent ≠ delivery channel | §25 |
| Service consent ≠ marketing consent | §26 |
| Entitlement ≠ feature flag ≠ configuration ≠ permission ≠ connector capability ≠ AI policy | §60 |
| Raw vendor message ≠ integration message ≠ canonical event | §50 |
| Short-term conversation state ≠ durable memory | §36 |
| Billing ≠ entitlement | §58 |

### 1.4 The AI layer is a *consumer* of the operations core, never a shortcut around it

Spec §27–§44 and §83. Consequence for sequencing: deterministic workflows, SLA, approvals, service catalog and conversations are all built **before** the first LLM call (Spec §84.14). The first AI phase (Phase 6) then only adds Model Gateway + Agent Runtime + Tool Registry over APIs that already exist and are already authorized/audited.

### 1.5 First commercially meaningful milestone (drives Phases 0–5)

**M1 — "Guest activates and gets served, driven by PMS data, without a live OPERA link yet":**

> Source-of-truth rule for M1 and forever after: the platform does **not** create guests or stays on its own. Guest profile, reservation, check-in, room assignment, room move and check-out all originate from the PMS (OPERA in production). The platform only mints what OPERA does not have: activation tokens, OTP, access grants, sessions, conversations and work. When OPERA checks the guest out, the platform receives `hotel.guest.checked_out.v1` and **automatically** revokes room/stay scopes, ends guest sessions and closes the stay-bound conversation; nobody has to do anything in the platform. "Without OPERA" in M1 means only that during development the PMS simulator stands in for OPERA and emits the exact same canonical events, so the core is not blocked on the hotel link (Spec §85 Phase 2). Phase 10 swaps the simulator for the real FIAS/OWS adapters without touching anything built in Phases 0–6.

```text
Simulated PMS check-in (Phase 2 simulator)
 -> Stay IN_HOUSE -> activation token + URL (Phase 4)
 -> Guest enters mobile -> WhatsApp OTP (abstracted provider) -> Guest Access Grant (Phase 4)
 -> Guest opens service catalog, requests EXTRA_TOWELS (Phase 5)
 -> Service request -> Work Item -> Task -> SLA instance (Phase 3)
 -> Staff sees it in unified inbox, completes it (Phase 4)
 -> Guest receives notification on the verified channel (Phase 3/4)
 -> Full audit trail + correlation id end to end (Phase 0/1)
```

**M2 — "Same flow, in natural language":** Phase 6 adds Guest Concierge over the same tools. Guest types "الجو حر أوي هنا" and the right request is created, deduplicated, routed to Engineering and answered in Arabic.

**M3 — "Operations modules":** Phases 7–9.
**M4 — "Real hotel":** Phase 10 (OPERA 5 agent) + Phase 11 (licensing/control plane).

---

## 2. Decisions locked for Phase 0

All of these are recorded as ADRs in `docs/adr/`. "Locked" means: do not re-open without a new ADR.

| # | Decision | Choice | Rejected alternatives | ADR |
|---|---|---|---|---|
| 1 | Repository | pnpm 10 workspaces + Turborepo 2 monorepo, Node 24 LTS, TypeScript 6 strict, ESM-style source compiled to CommonJS (NestJS 11 supported path; ESM flip planned with NestJS 12) | Nx (heavier), multi-repo (kills bounded-context refactors); Node 26 / TS 7 / Nest 12 held by the Maturity Gate | ADR-0001, ADR-0016 |
| 2 | Database access & migrations | **PostgreSQL 18** + pgvector; **Drizzle ORM 0.45.x** (stable line; core query builder, no relational-query API so the 1.0 move stays mechanical) per bounded context, SQL migration files (generated then hand-reviewed), one migration journal, PostgreSQL schemas per context | Prisma (weak multi-schema, poor control over RLS/raw SQL), TypeORM (migration drift) | ADR-0002, ADR-0016 |
| 3 | Identifiers | Application-generated UUIDv7 (`uuidv7` package), `uuid` columns | DB-generated `gen_random_uuid()` (v4, poor index locality), bigserial (leaks counts, not multi-tenant friendly) | ADR-0003 |
| 4 | Events & async | Transactional **outbox** table → relay worker → **BullMQ** on **Valkey 9** (BSD-licensed RESP store; Redis 8 rejected for licence reasons in an on-prem product) with the 5 spec priority queues; synchronous in-process domain event dispatch inside the same transaction where needed; **inbox** table for idempotent consumers | Kafka/NATS now (new infra dep, Spec §84.17), EventEmitter only (not durable) | ADR-0004 |
| 5 | Validation & contracts | **Zod 4** schemas in `packages/contracts` shared by API DTOs (via `nestjs-zod` on NestJS 11; native Standard Schema once on Nest 12), event payloads, AI tool I/O, connector manifests; OpenAPI generated from the same schemas | class-validator (not reusable for events/tools) | ADR-0005 |
| 6 | Observability | **pino** structured logs, **OpenTelemetry JS SDK 2.x** traces/metrics, request context via AsyncLocalStorage (`nestjs-cls`) carrying `correlation_id`, `trace_id`, `tenant_id`, `property_id`, `actor` | winston, custom middleware | ADR-0006 |
| 7 | Multi-tenancy model | Shared database, shared schema, explicit `tenant_id` columns, repository layer enforces tenant filter, PostgreSQL RLS added as defense-in-depth (Phase 1.3) | schema-per-tenant (migration fan-out), DB-per-tenant (ops cost) | ADR-0007 |
| 8 | Testing | **Vitest 4** unit tests; integration tests with **Testcontainers** (real PostgreSQL 18 + Valkey 9); contract tests for events/connectors; e2e via supertest | Jest (slower), mocking the DB (hides tenant leaks) | ADR-0008 |
| 9 | Frontend stack | Next.js 16 LTS (App Router, React 19) + `next-intl` (ICU, shared catalog with backend) + Tailwind 4 with CSS logical properties for RTL; `apps/guest-web` (PWA) and `apps/staff-web` | Separate SPA frameworks | ADR-0009 |
| 10 | Secrets | `SecretProvider` interface; `EnvSecretProvider` for dev/test, Vault/AWS SM/… adapter for production; secrets never in `settings`/config tables | Reading `process.env` directly in modules | ADR-0010 |
| 11 | Auth tokens | Staff: JWT access (≤15 min) + opaque rotating refresh token (hashed in DB, device-bound, revocable). Guest: passwordless opaque session token (hashed). Passwords: argon2id | Long-lived JWTs, sessions in Redis only | ADR-0011 |
| 12 | API style | REST `/api/v1`, RFC 9457 Problem Details errors with localized `detail`, `Idempotency-Key` on retriable creates, cursor pagination | GraphQL first | ADR-0012 |
| 13 | Lint, format, boundaries | **ESLint 10 + typescript-eslint 8** (type-aware) with core `no-restricted-imports` per layer folder, **package `exports` maps** (runtime + compile-time enforcement), **Prettier 3**, **dependency-cruiser** in CI for cycles, layer rules on resolved paths and the documentation graph: a domain package imports only `@hotella/platform-*`, `@hotella/contracts-*`, and other domains' **`/public`** entrypoint; never another domain's schema/repositories | oxlint (plugins alpha), Biome (no boundary rules), code review only | ADR-0001, ADR-0016 |
| 14 | Hosting | **On-premises**: Docker Compose (pilot) → Kubernetes k3s/RKE2 (production); self-managed PostgreSQL 18 + pgBackRest PITR; Valkey 9; SeaweedFS; OpenBao (Vault KV v2 API; HashiCorp Vault interchangeable) as secrets store; Grafana/Prometheus/Loki/Tempo via OTel collector; hotel agent still connects outbound | Public cloud managed services | ADR-0013 |
| 19 | Hotel ↔ platform link | Outbound-only from the hotel on TCP 443: single-use enrollment token → locally generated key pair → mTLS device certificate; persistent WSS for events/commands + HTTPS for batches; SQLite durable ordered queue with acks; predefined signed commands only; signed offline licence; signed auto-updates with rollback | VPN per site, inbound ports, edge message broker | ADR-0017 |
| 15 | OPERA 5 interfaces | **FIAS over IFC8** primary (real-time GI/GO/GC/RE, DB sync), **OWS (SOAP)** secondary for reservations/profiles/pre-arrival where licensed, optional **read-only DB views** for reconciliation only | OXI (CRS-oriented, extra licensing) | ADR-0014 |
| 17 | i18n engine | **ICU MessageFormat** (`intl-messageformat`) behind our own `I18nService` on the backend, `next-intl` on the frontend → one shared `/locales/{en,ar}` catalog, one parity check; no dependency on third-party Nest i18n modules | nestjs-i18n (lags Nest majors, different format from frontend) | ADR-0016 |
| 18 | Agent runtime | **.NET 10 LTS** for the on-prem hotel agent | .NET 11 (STS, 2-year support) | ADR-0016 |
| 16 | WhatsApp & OTP | `MessagingProvider` abstraction with **Meta Cloud API** and **BSP** adapters selectable per channel; OTP fallback chain WhatsApp → SMS (auto on failure/timeout, manual after 30 s) → optional voice → staff-assisted verification, all deterministic and per-property configurable | Single provider, WhatsApp-only OTP | ADR-0015 |

---

## 3. Repository layout (concrete)

Follows Spec §77 with pnpm package names.

```text
hotella/
├── apps/
│   ├── api/                      # NestJS HTTP API (platform-api)
│   ├── worker/                   # BullMQ consumers, outbox relay, scheduler (platform-worker / scheduler)
│   │                             # apps/worker runs one or more BullMQ queue groups selected by WORKER_QUEUES, so the
│   │                             # six Spec §71 deployables are: api; worker[normal,analytics]; worker[scheduler];
│   │                             # realtime; worker[integration]; worker[background-ai] — same image, different env
│   ├── realtime/                 # WebSocket gateway (Phase 4)
│   ├── guest-web/                # Guest PWA (Phase 5, stack per ADR-0009)
│   ├── staff-web/                # Staff portal (Phase 4+, stack per ADR-0009)
│   ├── pms-simulator/            # Dev-only PMS simulator CLI/HTTP (Phase 2)
│   └── hotel-agent/              # .NET 8 on-prem connector agent (Phase 10)
├── packages/
│   ├── platform/
│   │   ├── database/             # drizzle client, migration runner, base column helpers, tx helper, migrations/
│   │   ├── events/               # outbox/inbox, envelope, dispatcher, BullMQ queues & priorities
│   │   ├── queue/                # BullMQ wrappers, queue names, worker base
│   │   ├── auth/                 # guards, request actor, permission decorator, action gate pipeline
│   │   ├── observability/        # pino, OTel, CLS request context
│   │   ├── storage/              # S3-compatible client abstraction
│   │   ├── config/               # env schema (zod), hierarchical config service, feature flags
│   │   ├── secrets/              # SecretProvider interface + adapters
│   │   ├── i18n/                 # locale resolution, message catalog loader, translation-table helpers
│   │   └── testing/              # testcontainers harness, factories, test app builder
│   ├── domain/
│   │   ├── organization/         # tenants, organizations, properties, locations, branding
│   │   ├── identity/             # persons, users, memberships, roles, permissions, sessions, support access
│   │   ├── guest/                # guests, stays, party, room assignment history, external refs, preferences, grants
│   │   ├── catalog/              # service definitions/versions/categories/translations
│   │   ├── operations/           # work items, tasks, workflows, SLA, escalation, approvals, alerts, notification intents
│   │   ├── housekeeping/
│   │   ├── engineering/
│   │   ├── inspections/
│   │   ├── relations/            # complaints, service recovery
│   │   ├── lostfound/            # schema lostfound
│   │   ├── logbook/              # schema logbook
│   │   ├── communications/       # channels, conversations, messages, delivery, channel identities, activation, OTP, inbox
│   │   ├── knowledge/            # documents, chunks, embeddings abstraction, retrieval
│   │   ├── ai/                   # model gateway, agents, prompts, tools, context engine, policy, execution audit, memory
│   │   ├── integrations/         # connector defs, instances, capabilities, messages, commands, mappings, reconciliation
│   │   ├── licensing/            # products, modules, features, plans, subscriptions, entitlements, usage
│   │   └── audit/                # append-only audit log
│   └── contracts/
│       ├── events/               # canonical event schemas (zod) + registry, versioned
│       ├── api/                  # shared API DTO schemas, error codes
│       ├── connectors/           # connector manifest/capability contracts (Connector SDK)
│       └── ai-tools/             # tool I/O schemas, risk levels
├── locales/                      # ONE ICU MessageFormat catalog shared by backend (I18nService) and frontend (next-intl)
│   ├── en/  common.json errors.json guest.json housekeeping.json engineering.json …
│   └── ar/  (same keys — parity enforced in CI)
├── infra/
│   ├── docker/                   # docker-compose.dev.yml (postgres16+pgvector, redis7, minio, mailpit) + compose.pilot.yml
│   ├── k8s/                      # Helm charts for on-prem Kubernetes (ADR-0013), added at end of Phase 1
│   └── ci/                       # reusable GitHub Actions workflows
├── docs/
│   ├── spec/HOTELLA_MASTER_SPEC.md
│   ├── BUILD_PLAN.md             # this file
│   ├── TRACEABILITY.md
│   ├── DEVELOPER_GUIDE.md        # onboarding: setup, map, conventions, how to add a module
│   ├── GLOSSARY.md               # EN/AR hotel + platform vocabulary
│   ├── architecture/             # Mermaid diagrams + CI-generated dependency graph
│   └── adr/
├── .github/
│   ├── workflows/ci.yml
│   ├── pull_request_template.md  # Gates A–D checklist
│   └── CODEOWNERS
├── renovate.json  .nvmrc  .editorconfig  .dependency-cruiser.cjs  eslint.config.mjs  .prettierrc
├── CLAUDE.md                     # non-negotiable rules for agents working in this repo
└── package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json
```

**Package naming:** `@hotella/platform-database`, `@hotella/domain-guest`, `@hotella/contracts-events`, etc.

**Domain package internal layout (mandatory):**

```text
packages/domain/<ctx>/src/
├── public/            # the ONLY thing other domains may import: interfaces + DTO types + event names
├── application/       # use cases / application services (transaction boundaries live here)
├── domain/            # entities, value objects, invariants, domain events
├── infrastructure/    # drizzle schema (schema.ts), repositories, adapters
├── api/               # NestJS controllers for this context (mounted by apps/api)
├── <ctx>.module.ts
└── index.ts           # re-exports module + public only
```

---

## 4. Phase 0 — Repository & Engineering Foundation (detailed)

**Goal:** a running, tested, observable, bilingual NestJS skeleton with database, Redis, outbox events and CI, such that **no hotel business feature can bypass these foundations** (Spec §85 Phase 0).

**Duration estimate:** 3 sprints (~3 weeks for one focused engineer/agent working continuously).

### Sprint 0.1 — Skeleton & tooling

| # | Task | Done when |
|---|---|---|
| 0.1.1 | `.nvmrc` (Node 24 LTS), Corepack-pinned pnpm 10, pnpm workspace, Turborepo pipeline (`build`, `lint`, `format:check`, `typecheck`, `test`, `depcruise`), `tsconfig.base.json` (TypeScript 6, `strict`, `isolatedModules` + lint-enforced `consistent-type-imports` (`verbatimModuleSyntax` cannot emit CommonJS), `module: nodenext` with CommonJS output, no deprecated options so TS 7 is a no-op later), `typecheck` runs `tsc --noEmit`, emit via SWC (`nest build` with the SWC builder) | `pnpm -r build && pnpm typecheck` pass on empty packages |
| 0.1.2 | ESLint 10 flat config: typescript-eslint (type-aware), `no-restricted-imports` layer rules from §2.13 scoped by folder, `no-console`, `no-restricted-globals` for `process.env`, `no-restricted-imports` for provider SDKs outside the gateway; Prettier 3; dependency-cruiser (`no-circular`, graph) — `pnpm depcruise:graph` renders `docs/architecture/dependency-graph.svg` | lint fails on a deliberate cross-domain import, on `console.log` and on `process.env` in a test fixture; depcruise fails on an injected cycle |
| 0.1.3 | `apps/api`: NestJS 11 app, `/health` (liveness) and `/ready` (checks PostgreSQL + Valkey), global prefix `/api/v1`, graceful shutdown, `nestjs-zod` validation pipe wired with a zod 4 sample DTO | `curl /api/v1/health` returns 200; invalid body returns Problem Details 400 |
| 0.1.4 | `infra/docker/docker-compose.dev.yml`: `pgvector/pgvector:pg18`, `valkey/valkey:9`, `chrislusf/seaweedfs:4.48`, `axllent/mailpit`, `grafana/otel-lgtm` (all-in-one Grafana/Tempo/Loki/Prometheus for dev); `pnpm dev:infra` script | `/ready` green against compose |
| 0.1.5 | `@hotella/platform-config`: zod-validated env schema, typed `AppConfig`, fail-fast on invalid env | app refuses to boot with a missing var and prints the field name |
| 0.1.6 | `@hotella/platform-observability`: pino JSON logs, redaction list (authorization headers, tokens, phone, otp), log level from config | log line contains `correlation_id` placeholder field |
| 0.1.7 | CI (`.github/workflows/ci.yml`): install → lint → typecheck → build → unit tests, with PG/Redis service containers for integration tests | green on the first PR |
| 0.1.8 | `renovate.json` (grouped by ADR-0016 rows, weekly), `.editorconfig`, `.github/pull_request_template.md` (Gates A–D), `CODEOWNERS`, commitlint with Conventional Commits, `docs/DEVELOPER_GUIDE.md` kept in sync with the real commands | a new developer follows the guide from clone to green tests in ≤ 30 minutes (timed once, recorded in the PR) |

### Sprint 0.2 — Data, identity of requests, tests

| # | Task | Done when |
|---|---|---|
| 0.2.1 | `@hotella/platform-database`: Drizzle 0.45 client (core query builder only, ADR-0016), `withTransaction()` helper (AsyncLocalStorage; nested calls join the outer unit of work; `executor(db)` returns the ambient tx) propagating the tx through CLS, base column helpers `baseColumns()` (`id uuid pk`, `created_at`, `updated_at` TIMESTAMPTZ) and `tenantScoped()` (`tenant_id`), `versioned()` (`version int` for optimistic locking) | unit-tested helpers |
| 0.2.2 | UUIDv7 generator `newId()`; lint rule banning `gen_random_uuid()` defaults in schema | tests assert monotonic ordering |
| 0.2.3 | Migration framework: drizzle-kit generates SQL into `packages/platform/database/migrations/<n>_<name>.sql` (one journal, journal table `migrations.journal` in its own schema so migration 0000 owns `CREATE SCHEMA platform`); `pnpm db:migrate`, `pnpm db:generate <name>`, `pnpm db:check` (generates into a temp copy of the journal; any new file = drift = CI failure); each bounded context lives in its own PostgreSQL schema listed in `drizzle.config.ts` `schemaFilter` | CI fails when a schema change has no migration |
| 0.2.4 | Request context (`nestjs-cls`): middleware generates/propagates `X-Correlation-Id`, stores `correlation_id`, `trace_id`, `tenant_id`, `property_id`, `actor` (empty until Phase 1); pino mixin injects them into every log line | integration test asserts the header is echoed and logged |
| 0.2.5 | OpenTelemetry JS SDK 2.x bootstrap (HTTP, pg, ioredis, BullMQ instrumentation), OTLP exporter configured by env, no-op in tests | trace visible in the dev `otel-lgtm` Grafana |
| 0.2.6 | `@hotella/platform-secrets`: `SecretProvider` interface, `EnvSecretProvider`, `SecretRef` type used by config for anything credential-like | `grep process.env` outside platform-config/secrets returns nothing (lint rule) |
| 0.2.7 | `@hotella/platform-testing`: Testcontainers PostgreSQL 18 + Valkey 9 singleton per test run, migration applied, `createTestApp()` builder, DB truncation between tests, factory helpers | one sample integration test passes in CI |
| 0.2.8 | `@hotella/platform-storage`: S3 client abstraction (`putObject`, `getSignedUrl`, `delete`), SeaweedFS in dev | integration test uploads and signs a URL |

### Sprint 0.3 — Events, queues, i18n, API conventions

| # | Task | Done when |
|---|---|---|
| 0.3.1 | `@hotella/contracts-events`: `EventEnvelope` zod schema exactly per Spec §51 (`event_id, event_type, event_version, tenant_id, property_id, source, source_reference, occurred_at, received_at, correlation_id, payload`), `defineEvent('hotel.guest.checked_in', 1, payloadSchema)` registry helper | registry rejects two definitions with the same type+version |
| 0.3.2 | `@hotella/platform-events`: `platform.outbox` table (`id, event_type, event_version, tenant_id, property_id, aggregate_type, aggregate_id, payload jsonb, correlation_id, occurred_at, published_at, attempts, last_error`); `EventPublisher.publish()` writes inside the caller's transaction | integration test: rollback of business tx removes outbox row |
| 0.3.3 | Outbox relay in `apps/worker`: polls unpublished rows (`FOR UPDATE SKIP LOCKED`), pushes to BullMQ, marks published; metrics for lag | relay survives worker restart with no loss/duplication (test) |
| 0.3.4 | `platform.inbox` table + `@Idempotent(consumerName)` decorator for consumers (keyed by `event_id + consumer`) | duplicate delivery processes once (test) |
| 0.3.5 | `@hotella/platform-queue`: BullMQ on Valkey, queues `critical-operational`, `guest-realtime`, `normal`, `analytics`, `background-ai` with separate worker concurrency settings (Spec §71); job base class with retry/backoff/DLQ | jobs land in the right queue by declared priority |
| 0.3.6 | In-process `DomainEventBus` for same-transaction side effects (used only within a bounded context) | documented when to use which (ADR-0004) |
| 0.3.7 | `@hotella/platform-i18n`: own `I18nService` on ICU MessageFormat (`intl-messageformat`) loading `/locales/{en,ar}/*.json` (the same files `next-intl` will load on the frontend); `LocaleResolver` implementing the chain *explicit → user/guest preference → detected → property default → platform default (en)*; `Accept-Language` + `?lang=` + per-actor preference hooks (Phase 1 wires the preference); `translationColumns()` + `translationUnique()` schema helpers (split so Drizzle keeps column types) producing `<entity>_translations(entity_id, locale, …)` with unique `(entity_id, locale)` | test: same key resolves differently per locale; CI check that `ar` and `en` key sets are identical |
| 0.3.8 | Error model: `AppError(code, params)` → RFC 9457 Problem Details with `code` (stable, e.g. `guest.activation.token_expired`) and localized `detail`; error codes documented in `locales/*/errors.json` | unknown code fails tests |
| 0.3.9 | API conventions: versioned routes, `IdempotencyInterceptor` (`Idempotency-Key` header, Valkey-backed, 24h, replays stored response), Valkey rate limiting (per IP now; per actor/tenant in Phase 1), cursor pagination helper, OpenAPI from zod 4 (`nestjs-zod` + `@nestjs/swagger` 11) served at `/api/docs` in non-prod and snapshot-tested | replayed POST returns identical body and `Idempotent-Replayed: true` |
| 0.3.10 | Scheduler base in `apps/worker` (BullMQ repeatable jobs) for later SLA timers, reconciliation, PM | a heartbeat job runs every minute in dev |
| 0.3.11 | Feature flags v0 in `platform-config`: `FeatureFlagService.isEnabled(flag, {tenant, property})` reading a table `platform.feature_flags` with scope columns; explicitly *not* licensing | test shows flag ≠ entitlement call sites |
| 0.3.12 | **Module manifest** (Spec §76 brought forward as an enforcement tool): every domain module exports a `ModuleManifest { code, schema, permissions[], events[], entitlements[], aiTools[], localeNamespaces[], integrationCapabilities[], dataClasses[] }`; a `ManifestRegistry` collects them at boot; tests assert that every permission used in a decorator, every event published, every locale namespace loaded and every table's data class is declared in exactly one manifest | a permission used but not declared fails the test suite |
| 0.3.13 | **Data classification registry** (Spec §67) — *delivered early in Sprint 0.2*: `classify(table, {...})` wraps every table and throws at module load when a column is missing a class (`PUBLIC / INTERNAL / CONFIDENTIAL / SENSITIVE / RESTRICTED`); registry exported for the logger redaction list, the AI redaction policy (Phase 6) and retention policies (Phase 1) | an unclassified column cannot be built or tested |

### Phase 0 acceptance criteria

> **Status: accepted on 2026-10-03** — evidence per item in `docs/acceptance/phase-0.md` (two items need a human walk-through of the Developer Guide).

- [ ] `pnpm install && pnpm dev:infra && pnpm db:migrate && pnpm dev` boots API + worker locally; `/api/v1/ready` is green.
- [ ] CI runs ESLint, Prettier check, dependency-cruiser, `tsc --noEmit`, build, unit + integration tests (real PostgreSQL 18 / Valkey 9), the migration drift check and the OpenAPI snapshot.
- [ ] Every log line carries `correlation_id`; a request's correlation id appears in the outbox row and in the job the relay enqueues.
- [ ] A sample `ping.requested.v1` event published inside a transaction is delivered to a worker consumer exactly once across a forced duplicate delivery.
- [ ] Switching `Accept-Language: ar` changes the error `detail` of a Problem Details response; the `ar`/`en` key-parity check passes.
- [ ] A deliberate cross-domain import fails ESLint (`pnpm lint:selftest` proves five forbidden patterns); a deliberate `process.env` read outside the config package fails ESLint; no `require`/`__dirname` in source (ESM-ready rule) and no node-gyp dependency in the lockfile.
- [ ] No secret value appears in any config table, log line or test fixture.
- [ ] ADR-0001…0016 exist and `CLAUDE.md` reflects them; `docs/DEVELOPER_GUIDE.md` has been followed end-to-end by someone other than its author.

---

## 5. Phase 1 — Organization, IAM & Property (detailed)

> **Status: accepted on 2026-10-03** — evidence per item in `docs/acceptance/phase-1.md` (installing on the target host and the secret-store licence confirmation are owner/operator steps).

**Goal / acceptance (Spec §85):** one user can have different permissions across different properties without data leakage; guest-facing branding resolves dynamically with the Planova attribution preserved.

### 5.1 Scope

Tenants, organizations, properties, generic location tree (rooms as a location specialization), persons, staff users, memberships, roles & permissions, staff sessions, audit baseline, property-scoped authorization, locale preferences, hierarchical configuration, brand profiles with inheritance, branding resolver, platform attribution policy, support-access grants (model only; UI later).

### 5.2 Domain model (PostgreSQL schemas `org`, `iam`, `audit`, `platform`)

```text
org.tenants                (Spec §4.1 columns)                           + version
org.organizations          (Spec §4.2 columns)                           + version
org.properties             id, tenant_id, organization_id, code, name, timezone, currency,
                           default_locale, enabled_locales text[], country, address jsonb,
                           geo point nullable, status, settings jsonb, version
org.locations              id, tenant_id, property_id, parent_id nullable, kind
                           (PROPERTY|BUILDING|FLOOR|ROOM|AREA|PLANT|OTHER), code, path ltree,
                           sort_order, status, metadata jsonb, version
org.location_translations  location_id, locale, name, description
org.rooms                  location_id pk/fk, room_number, room_type_id, bed_config, floor_label,
                           connecting_room_id nullable, attributes jsonb          (specialization of location)
org.room_types             id, tenant_id, property_id, code, capacity, attributes jsonb
org.room_type_translations room_type_id, locale, name, description
org.brand_profiles         id, tenant_id, scope (TENANT|ORGANIZATION|PROPERTY|CHANNEL), scope_id,
                           channel nullable, display_name, logo_asset_id, logo_alt_asset_id,
                           primary_color, secondary_color, cover_asset_ids, favicon_asset_id,
                           typography jsonb (approved fonts only), contact jsonb, social jsonb,
                           ai_persona jsonb (validated against platform policy), presentation jsonb, version
org.brand_profile_translations  brand_profile_id, locale, welcome_text, farewell_text
platform.attribution_policy     singleton rows per tenant: show_powered_by bool (default true),
                                link (default https://planova.com.eg), override_entitlement_ref nullable
                                — NOT editable through brand profile APIs

iam.persons                id, tenant_id nullable (platform staff), given_name, family_name, email, phone, locale_pref, metadata
iam.users                  id, person_id, email (unique per tenant), password_hash (argon2id), status,
                           mfa_enabled, mfa_secret_ref (SecretRef, never plaintext), last_login_at, version
iam.memberships            id, user_id, tenant_id, organization_id nullable, property_id nullable
                           (null = tenant-wide), status, version
iam.roles                  id, tenant_id nullable (null = platform-defined), code, is_system
iam.role_translations      role_id, locale, name, description
iam.permissions            code pk (e.g. task.assign), domain, risk_level, description_key
iam.role_permissions       role_id, permission_code
iam.membership_roles       membership_id, role_id
iam.sessions               id, user_id, refresh_token_hash, device_info, ip, created_at, expires_at,
                           rotated_from nullable, revoked_at, revoke_reason
iam.support_access_grants  id, tenant_id, property_id nullable, granted_to_user_id, reason, scopes text[],
                           read_only bool default true, starts_at, expires_at, approved_by, revoked_at

audit.audit_log            id, tenant_id, property_id nullable, actor_type
                           (USER|GUEST|AI_AGENT|SYSTEM|INTEGRATION|SUPPORT), actor_id, action,
                           entity_type, entity_id, before jsonb, after jsonb, reason, approval_ref,
                           policy_ref, correlation_id, occurred_at — append-only (no UPDATE/DELETE grants)

platform.configuration     id, scope (PLATFORM|TENANT|PROPERTY|DEPARTMENT|MODULE), scope_id, key,
                           value jsonb, version, changed_by, changed_at  + platform.configuration_history
platform.retention_policies id, tenant_id nullable, data_class, entity_type nullable, retain_days, action
                           (DELETE|ANONYMIZE|ARCHIVE), legal_hold bool — framework only in Phase 1; each module
                           declares its data classes (manifest) and implements its purge/anonymize job (DoD §12.15)
```

### 5.3 Application services & APIs (`/api/v1`)

- `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/mfa/verify` (TOTP), `GET /me` (memberships, effective permissions per property, locale)
- Tenants / organizations / properties CRUD (platform-admin scoped), `GET /properties/:id/locations?tree=1`, locations & rooms CRUD, bulk room import (CSV)
- Roles & permissions: list permissions catalog, role CRUD, assign roles to memberships
- Users & memberships CRUD, invite flow (email via mailpit in dev)
- Configuration: `GET/PUT /config/{scope}/{scopeId}/{key}` with effective-value resolution endpoint
- Branding: brand profile CRUD per scope; **`GET /public/branding?property=…&channel=…`** returns the fully resolved guest-facing brand (used by guest web / QR pages / WhatsApp context) and always includes `attribution: { show: true, label: "Powered by Planova", href: "https://planova.com.eg" }` unless the attribution policy entitlement says otherwise
- Audit: `GET /audit?entity=…` (read-only)
- Support access: request/approve/revoke endpoints (model + API; approval UI later)
- Retention policies: CRUD per tenant/data class (framework; enforcement jobs land with each module)

### 5.4 Authorization & the action gate v1

- `RequestActor` (in CLS): `{ type, userId, tenantId, membershipIds, propertyScope }` resolved from the access token on every request.
- `@RequirePermission('task.assign')` + `@PropertyScoped()` decorators; guard resolves permission through Membership → Role → Permission **for the property in the request** (path/body/query `property_id`); tenant-wide memberships cover all properties.
- Repository base enforces `tenant_id` filter from CLS; a repository method without tenant filter fails a unit test helper (`assertTenantScoped`).
- `ActionGate.execute(actionRequest)` pipeline with stages `authorization` (real), `entitlement`, `feature`, `configuration`, `connectorCapability`, `aiPolicy` (pass-through stubs with interfaces). All controllers that mutate go through it.
- RLS (Phase 1.3): policies on tenant-scoped tables using `current_setting('app.tenant_id')`, set per transaction. Application authorization remains authoritative (Spec §2.2).

### 5.5 Events

```text
org.tenant.created.v1          org.property.created.v1       org.property.updated.v1
org.location.created.v1        org.room.created.v1           org.brand_profile.updated.v1
iam.user.created.v1            iam.membership.changed.v1     iam.role_permissions.changed.v1
iam.session.revoked.v1         platform.configuration.changed.v1
```

### 5.6 Permissions introduced

```text
org.tenant.manage  org.property.read  org.property.manage  org.location.manage
iam.user.read  iam.user.manage  iam.role.manage  iam.membership.manage
config.read  config.manage  branding.read  branding.manage  audit.read
support.access.request  support.access.approve
```

### 5.7 Tests & acceptance

- Integration: user U with role Housekeeping-Supervisor at Property A and Engineer at Property B — `GET /properties/A/...` with engineering permission → 403; cross-tenant id guessing → 404 (never 403 leaking existence).
- Property B's brand profile never resolves for Property A; missing property profile falls back to tenant then platform defaults; attribution survives any brand profile write.
- Refresh token reuse after rotation revokes the whole session chain.
- Every mutating endpoint writes an `audit.audit_log` row with `correlation_id`; the audit table rejects UPDATE/DELETE at the DB grant level.
- Locale: user with `ar` preference gets Arabic error details and Arabic role names from `role_translations`.
- RLS smoke test: direct SQL with wrong `app.tenant_id` returns zero rows.

---

### 5.8 Deployment deliverable at end of Phase 1 (ADR-0013)

First staging environment on the on-prem target: `infra/docker/compose.pilot.yml` (api, worker, scheduler, realtime placeholder, PostgreSQL 18 + pgvector, Valkey 9, SeaweedFS, a real (non-dev) OpenBao secret store, OTel collector + Grafana stack), pgBackRest backup job with a documented restore drill, and operations runbooks (deploy, rollback, backup/restore, secret rotation). Helm charts for Kubernetes follow when the second property/tenant is onboarded.

### 5.9 Sprints and progress

| Sprint | Scope | Status |
|---|---|---|
| 1.1 | `@hotella/platform-auth` (RequestActor in CLS, `@Public`/`@RequirePermission`/`@PropertyScoped`/`@TenantScoped`, global `AuthGuard`, `ActionGate` with pluggable stages, test strategy/resolver); `@hotella/domain-organization` (schema `org`, migration `0002_org_phase1` incl. `ltree`, tenant/property foreign keys on every scoped table, services, controllers, public API, manifest, branding resolver with non-removable attribution); `runMigrations` serialized by a PostgreSQL advisory lock | delivered |
| 1.2 | `@hotella/domain-identity` (schema `iam`, migration `0003_iam_phase1` with hand-reviewed FKs to `org`): persons, users, invitations, roles + translations, permission catalog synced from manifests, system roles (Platform admin, Support, General manager, Duty manager, HK supervisor, Room attendant, Engineer, Front desk, Guest relations — en/ar), memberships (tenant-wide or per property), sessions + refresh-token chain with reuse detection, TOTP MFA, lockout, real `AuthenticationStrategy` + `PermissionResolver`, anti-escalation, `pnpm iam:bootstrap-admin`; platform-auth: property-scope verifier (foreign property → 404), `checkedBy: 'gate'`, optional property scope | delivered |
| 1.3 | `@hotella/platform-audit` (append-only `audit.audit_log`, migration 0004, triggers reject UPDATE/DELETE/TRUNCATE; `AuditWriter` with data-class redaction; `GET /audit`) retrofitted into every org/iam mutation and security event; `@hotella/platform-settings` (migration 0005: typed hierarchical configuration + append-only history, retention policies, attribution policy with CHECK constraint; `/config`, `/retention-policies`); support-access request/approve/revoke with SUPPORT actor, grant-based permissions and per-request audit; RLS (migration 0006) with `FORCE` and transaction-local `app.tenant_id` | delivered |
| 1.4 | Pilot deployment (§5.8): `infra/docker/Dockerfile` (api/worker), `compose.pilot.yml` + `pilot/pilot.sh`, OpenBao (Vault API) secret provider with AppRole, application database role (non-superuser, RLS-bound) + `hotella-db grant`, PostgreSQL+pgBackRest image with restore drill, runbooks (`docs/runbooks/`), CI job "pilot deployment smoke"; Valkey-outage resilience fixes; Phase 1 acceptance (`docs/acceptance/phase-1.md`) | delivered |

Reality notes for 1.1: brand assets are stored as object-storage keys (`logo_asset_key`, `cover_asset_keys`, …) because the asset registry arrives with the knowledge/storage work; the public branding endpoint takes `property` (+ optional `channel`) and resolves platform → tenant → organization → property → channel.

Reality notes for 1.2 (details in ADR-0011 "Implementation notes"):
- `iam.sessions` is the refresh-token family and `iam.refresh_tokens` holds one row per issued token; the plan's single `refresh_token_hash` column could not express reuse detection safely.
- `mfa_secret_ref` became `mfa_secret_enc`: per-user TOTP seeds are sealed with AES-256-GCM under a SecretRef key (`IAM_MFA_KEY_REF`), because secret providers are read-only; `mfa_last_step` blocks code replay.
- Organization-scoped memberships are reserved (column and FK exist, the API grants tenant-wide or per-property only) until a customer needs a group/brand level; the resolver ignores them.
- Platform administrators get exactly the `PLATFORM_ADMIN` role's permissions; staff below tenant-wide level cannot list properties (`GET /properties` is tenant-level) — they see their properties through `GET /me`.
- Invitation tokens are returned once to the inviting administrator until the comms context (Phase 5) delivers them.
- Support-access grants: table only in 1.2; request/approve/revoke endpoints land in 1.3 with the audit log they depend on.

Reality notes for 1.3:
- `GET /audit` is tenant- or property-scoped (`audit.read`): general managers hold it, platform administrators do not (audit snapshots may contain hotel data, Spec §64).
- Configuration keys are declared in code (`defineSetting`: zod schema, default, allowed scopes, localized description) and registered by their module; unknown keys cannot be written. DEPARTMENT and MODULE scopes exist in the enum and wait for the operations phases. First keys: `iam.password.min_length` (tenant may raise the floor), `org.property.checkout_time`.
- The attribution policy has no HTTP route yet (control plane, Phase 11); the table refuses a hidden attribution without an entitlement reference.
- Support engineers are platform staff without the administrator flag (`pnpm iam:bootstrap-admin --role support`); they act as actor type `SUPPORT`, only through approved grants, and every request they make is audited (`support.access.use`).
- RLS details and the "application must not connect as a superuser" requirement: ADR-0007 implementation notes.

---

## 6. Phase 2 — Guest, Stay & PMS Canonical Model (detailed)

**Goal:** core guest/stay model driven by canonical PMS events, fully testable with a simulator; no OPERA required (Spec §85 Phase 2).

> **Status: accepted on 2026-10-03** — evidence in `docs/acceptance/phase-2.md`; sprints and reality notes in §6.7.

### 6.1 Domain model (schema `guest`, `integration`)

```text
guest.guests                     id, tenant_id, person_id nullable, primary_locale, vip_code nullable,
                                 status, merged_into_guest_id nullable, version
guest.guest_identifiers          guest_id, kind (EMAIL|PHONE|LOYALTY|DOCUMENT_HASH), value_normalized, verified_at
guest.stays                      id, tenant_id, property_id, status
                                 (EXPECTED|IN_HOUSE|CHECKED_OUT|CANCELLED|NO_SHOW), expected_arrival,
                                 expected_departure, actual_checkin_at, actual_checkout_at, eta,
                                 adults, children, rate_code nullable, market_code nullable, version
guest.reservation_references     stay_id, integration_instance_id, confirmation_number, reservation_status, raw_ref jsonb
guest.stay_party_members         id, stay_id, guest_id, role (PRIMARY|ACCOMPANYING|CHILD), joined_at, left_at
guest.room_assignments           id, stay_id, room_id, assigned_at, unassigned_at nullable, reason
                                 (INITIAL|ROOM_MOVE|UPGRADE|MAINTENANCE), source — history, never overwritten
guest.guest_preferences          id, guest_id, category, key, value jsonb, source (EXPLICIT|INFERRED|PMS), confidence, expires_at
guest.guest_consents             id, guest_id, type (SERVICE_COMMUNICATION|MARKETING_WHATSAPP|MARKETING_EMAIL|PERSONALIZATION),
                                 granted bool, channel, captured_at, evidence jsonb — append history
integration.external_references  internal_entity_type, internal_entity_id, integration_instance_id,
                                 external_entity_type, external_id, first_seen_at, last_seen_at
                                 unique(integration_instance_id, external_entity_type, external_id)
integration.connector_definitions   code, category, capabilities text[], config_schema jsonb, credential_schema jsonb, version
integration.integration_instances   id, tenant_id, property_id, connector_code, name, status, config jsonb,
                                    credential_ref (SecretRef), negotiated_capabilities text[], health_status
integration.integration_messages    id, instance_id, direction, source_message_id, received_at, raw payload (or storage ref),
                                    parse_status, canonical_event_id nullable, error — raw inbox (Spec §50)
integration.integration_mappings    instance_id, mapping_type (ROOM|ROOM_TYPE|RATE|MARKET|STATUS…), external_code,
                                    internal_value, confirmed_by, confirmed_at
integration.integration_exceptions  instance_id, kind (UNKNOWN_MAPPING|PARSE_ERROR|CONFLICT), payload, status, resolved_by
integration.integration_commands    id, instance_id, command_type, payload, idempotency_key unique(instance_id, key),
                                    status (PENDING|SENT|ACKNOWLEDGED|FAILED|EXPIRED), attempts, sent_at, acknowledged_at,
                                    error, correlation_id — durable outbound commands (Spec §53); first used by Phase 8 room restrictions
integration.integration_health      instance_id, status (HEALTHY|DEGRADED|OFFLINE|MISCONFIGURED|AUTH_FAILED), last_success_at,
                                    last_failure_at, latency_ms_p95, queue_depth, error_rate, agent_last_seen_at, updated_at
                                    (Spec §57; alerts deduplicated through ops.alerts)
integration.reconciliation_runs / reconciliation_results  run_id, instance_id, entity_type, outcome
                                    (MATCH|MISSING_INTERNAL|MISSING_EXTERNAL|DIFFERENT), details — Spec §52; simulator-driven in Phase 2
guest.guest_data_requests           id, tenant_id, guest_id, kind (EXPORT|CORRECTION|ANONYMIZE|DELETE), status, requested_by_actor,
                                    reason, completed_at, result_asset_id — Spec §69; anonymization keeps operational/audit integrity
```

### 6.2 Canonical events (contracts, Spec §51)

```text
hotel.reservation.created.v1   hotel.reservation.updated.v1   hotel.reservation.cancelled.v1
hotel.guest.checked_in.v1      hotel.guest.checked_out.v1     hotel.stay.room_changed.v1
hotel.guest.profile_updated.v1 hotel.room.status_changed.v1 (consumed by HK in Phase 7)
```

Pipeline per Spec §50: raw vendor message → `integration_messages` → parser → mapper (unknown code ⇒ `integration_exceptions`, never guess) → canonical event (outbox) → `guest` domain consumer (idempotent via inbox) → stay state machine.

### 6.3 Simulator (`apps/pms-simulator`)

Connector `SIM_PMS` implementing the Connector SDK contract v0 **and the agent link protocol of ADR-0017** (enrollment, mTLS, WSS frames with sequence numbers and acks, HTTPS batches) from a container, so the platform-side gateway is production-tested long before the .NET agent exists: HTTP endpoints / CLI to create reservations, check in, move rooms, check out, send duplicates and out-of-order messages. It emulates **two faces** so capability negotiation is exercised before Phase 10 (ADR-0014): an event stream shaped like FIAS (in-house events only, no future reservations) and a query API shaped like OWS (future reservations, profiles, ETA). Instances can be configured with either or both faces. Used by all later phases' integration tests. Also a scripted scenario file format (YAML) replayable in CI.

### 6.4 APIs

`GET /guests/:id`, search, merge (approval-gated later), `GET /stays?status=IN_HOUSE&property=`, `GET /stays/:id` (with party, current room, assignment history), `GET /rooms/:id/current-stay`, preferences & consents CRUD, external reference lookup, integration instances CRUD, mapping confirmation, exceptions queue, integration health read, reconciliation run/trigger/results, guest data requests (export → JSON asset; anonymize → pseudonymised profile with audit/ops rows intact).

### 6.5 Permissions

`guest.read guest.manage guest.merge guest.data_request.manage stay.read stay.manage integration.read integration.configure integration.replay integration.mapping.confirm integration.reconcile`

### 6.6 Acceptance

- Simulator check-in creates guest + stay + party + room assignment via canonical event; replaying the same source message changes nothing.
- Room move creates a second `room_assignments` row and closes the first; `GET /rooms/504/current-stay` flips.
- Unknown room code from the simulator yields an `integration_exceptions` row and no stay; confirming the mapping and replaying resolves it.
- PMS ids never appear as `id` of any `guest.*` row (test over schema).
- Reconciliation against the simulator reports MATCH for a clean run and the correct outcome for each injected discrepancy.
- Anonymizing a checked-out guest removes identifying fields and identifiers while stays, work history and audit rows remain queryable.
- Checkout emits `hotel.guest.checked_out.v1` consumed later by grants (Phase 4) and HK (Phase 7).
- No API or UI path creates a guest or stay outside the canonical-event consumer (staff can only *view*, *merge*, annotate preferences/consents); a test asserts the stay state machine is driven exclusively by PMS events.

### 6.7 Sprints and progress

| Sprint | Scope | Status |
|---|---|---|
| 2.1 | `@hotella/contracts-connectors` (Connector SDK v0: categories, capabilities, `defineConnector`, raw message, `ParseContext`, connector-neutral `InboundRecord`, `RECORD_CAPABILITY`, ordering keys, wall-clock → UTC helper); canonical `hotel.*` events + `integration.exception.opened.v1` / `integration.health.changed.v1`; `@hotella/domain-integrations` (schema `integration`, migration `0007_integration_phase2` with hand-reviewed FKs to `org` and forced RLS): connector catalog synced at boot, instances with enabled ∩ reported capabilities, raw inbox with replay-safe ingest, `SIM_PMS` adapter (FIAS-shaped records + OWS-shaped JSON), mapper with required/optional mapping types, deduplicated exceptions, HELD successors, replay, external references API, health counters, action-gate connector-capability stage; `TransactionRunner.read()` and tenant-pinned event consumers; RLS coverage test | delivered |
| 2.2 | `@hotella/domain-guest` (schema `guest`, migration `0008_guest_phase2` with FKs to `org`/`integration`, period CHECKs, forced RLS): guests, identifiers, stays, reservation references, party, room-assignment history; `StayProjector` = the only writer of stays (pure state machine, out-of-order safety, PMS reinstatements, per-reservation advisory locks), `guest.stay.created/status_changed/room_changed.v1`; read-only staff API (`/properties/:id/stays`, `/stays/:id`, `/rooms/:roomId/current-stay`, `/guests`, `/guests/:id` with masked contacts); worker runs the projector (`GuestEventsModule`); `AuditCoreModule` / `IntegrationsCoreModule` / `GuestCoreModule` without HTTP routes for background processes | delivered |
| 2.3 | Agent link (ADR-0017): `@hotella/platform-pki` (agent CA, CSR → device certificate, Ed25519 canonical signatures); link frames in `contracts-connectors`; migration `0009_agent_link` (`agent_links`, `enrollment_tokens`); `EnrollmentService` (single-use tokens, enroll, renew, revoke), `AgentLinkService` (hello/capabilities, ordered cumulative acks, resend, gap exception, heartbeats → health, signed command delivery/results), `INTEGRATIONS_API.requestCommand`; `apps/agent-gateway` (TLS 1.3 + client certificates, no staff routes); `apps/pms-simulator` (reference agent: durable queue, reconnect, chaos, FIAS/OWS faces, YAML scenarios, `RESYNC_IN_HOUSE`); pilot: gateway service, agent PKI in OpenBao, `pilot.sh simulate`, CI smoke through the deployed worker | delivered |
| 2.4 | Reconciliation (Spec §52): database-sync records (FIAS DS/DR/DE) become a PMS snapshot on a run started by staff (`POST …/reconciliations` → `RESYNC_IN_HOUSE` command), the guest context's `StayReconciler` compares it deterministically (`reconcileInHouse`) and reports MATCH / MISSING_INTERNAL / MISSING_EXTERNAL / DIFFERENT back; non-matches open exceptions, nothing is auto-corrected. Guest data: preferences (EXPLICIT/INFERRED with confidence), append-only consent history (DB trigger), merge of duplicates (stays, party, identifiers, preferences, consents and PMS profile links follow the survivor; MERGED tombstone), data-subject requests (EXPORT returned once with only its SHA-256 kept; ANONYMIZE/DELETE anonymize, unlink PMS profiles and scrub raw vendor payloads; CORRECTION recorded for the PMS). Migration `0010`. Phase 2 acceptance record | delivered |

Reality notes for 2.1:
- `integration_instances` stores `enabled_capabilities` (administrator) and `reported_capabilities` (agent, from 2.3); the effective set is their intersection, and only for `ACTIVE` instances. The plan's single `negotiated_capabilities` column could not tell the two apart.
- Mapping types are split into REQUIRED (`ROOM`, `ROOM_STATUS`: the message waits as `PENDING_MAPPING`) and OPTIONAL (`RATE`, `MARKET`, `VIP`: the canonical field is `null`). Both raise a deduplicated `UNKNOWN_MAPPING` exception; nothing is inferred. `POST …/mappings/rooms-by-number` is an explicit administrator confirmation that PMS room codes equal Hotella room numbers (exact matches only).
- Ordering: a message whose reservation/room key is shared with an earlier blocked message is `HELD` and released, in order, when the blocker is processed. Exception kinds gained `UNSUPPORTED_MESSAGE` (message type or capability not enabled).
- Protocol-defined FIAS values (e.g. `RS` maid status 1–6, `YYMMDD` dates) are translated by the adapter; hotel-defined codes (rooms, rates, VIP) always go through mappings. FIAS wall-clock times are converted with the property timezone.
- Raw message payloads (SENSITIVE) are not exposed through the staff API; staff see message metadata, status and error.
- Ingestion has no staff HTTP endpoint on purpose: messages enter only through the agent link (2.3), authenticated as the instance (actor `INTEGRATION`).

Reality notes for 2.2:
- `guests.person_id` is not created: no flow links a guest to a staff person yet; it arrives with the use case. `party_role` has PRIMARY and ACCOMPANYING (children are counted on the stay; FIAS/OWS give no per-child profile).
- Guest resolution is deterministic and conservative: by the PMS profile reference, else by exact name inside the same stay's party (a repeated snapshot), else a new guest. Nothing is matched across stays by name, e-mail or phone; duplicates are merged by staff (2.4).
- Downstream contexts consume `guest.stay.*` events (internal ids) rather than `hotel.*` (vendor references): Phase 4 grants revoke on `guest.stay.status_changed.v1` → `CHECKED_OUT`.
- A check-out, room move or cancellation for an unknown reservation is logged and ignored (nothing to close); reconciliation (2.4) reports it. A reference to a missing stay fails the job loudly (dead-letter set).
- Staff see guest contact identifiers masked; full values are used by the communication channels (Phase 4).

Reality notes for 2.3 (details in ADR-0017 "Implementation notes"):
- The gateway is a separate process (`apps/agent-gateway`, Nest application context + its own TLS listener) rather than routes of the API, so the internet-facing agent endpoint exposes nothing else and holds WebSockets independently of API deploys.
- Device certificates use ECDSA P-256 (portable to .NET TLS); commands are signed with Ed25519 as decided. X.509 issuance uses `@peculiar/x509` (ADR-0016 row "Agent link").
- `ReplayService` was split from `IngestService`, and `HealthService` from both, so the ingest path needs no staff action gate.
- Rate limiting is a per-instance throttle frame (200 frames/s); hard limits arrive with the licensing/metering work (Phase 11).
- Gate defect found and fixed: `pnpm db:check` passed vacuously since Phase 0 — drizzle-kit could not open the absolute temporary `out` path, printed the error and exited 0, so no drift migration was ever generated. The scratch journal now lives under the package (relative path), any drizzle-kit error fails the check, and drift was proven to be detected (temporary column → exit 2). The existing schema had no drift.

Reality notes for 2.4:
- FIAS `DR` records are no longer applied as check-ins: a database sync is a snapshot for reconciliation, and differences become exceptions (ADR-0017 §4: never silent fixes). A sync the platform did not request still gets its own run.
- The comparison runs in the guest context (owner of stays) and reports back through `INTEGRATIONS_API.completeReconciliation`, so the dependency stays guest → integrations.
- Guest audit entries record which fields changed, never their values: the audit log is append-only, so personal data in it could not be anonymized (Spec §69). The projector was corrected accordingly.
- Data exports are returned in the response and not stored (only their SHA-256); an object-storage export with expiring links arrives with the asset registry. `DELETE` requests are executed as anonymization to keep operational and audit integrity (CLAUDE.md rule 21).
- Published outbox rows still hold canonical payloads (names) until a retention job purges published events (scheduled with the operations scheduler in Phase 3).

---

## 7. Phase 3 — Operations Engine (detailed)

**Goal / acceptance (Spec §85):** multiple future modules create work through one engine; SLA deterministic; approvals generic.

> **Status: accepted on 2026-10-03** — evidence in `docs/acceptance/phase-3.md`; sprints and reality notes in §7.7. Package `@hotella/domain-operations` (context code `ops`).

### 7.1 Domain model (schema `ops`)

```text
ops.work_items              id, tenant_id, property_id, kind (SERVICE_REQUEST|HK_JOB|WORK_ORDER|INSPECTION|COMPLAINT|…),
                            source_entity_type, source_entity_id, title_key/params or title, status, priority,
                            location_id nullable, guest_id nullable, stay_id nullable, department_code,
                            workflow_instance_id nullable, sla_instance_id nullable, correlation_id, version
ops.tasks                   id, work_item_id, tenant_id, property_id, status (NEW|ASSIGNED|ACCEPTED|IN_PROGRESS|PAUSED|
                            DONE|CANCELLED|REJECTED), priority, due_at, location_id, department_code,
                            current_assignee_user_id nullable, started_at, completed_at, version
ops.task_assignments        id, task_id, assignee_type (USER|TEAM|AI|ROBOT), assignee_id, assigned_by_actor,
                            assigned_at, unassigned_at, reason — history
ops.task_events             id, task_id, type, actor, payload, occurred_at — operational history
ops.workflow_definitions    id, tenant_id nullable, code, status
ops.workflow_versions       id, definition_id, version, definition jsonb (states, transitions, guards, actions), published_at, immutable
ops.workflow_instances      id, version_id, work_item_id, current_state, context jsonb, version
ops.workflow_transitions    id, instance_id, from_state, to_state, trigger, actor, occurred_at
ops.sla_policies            id, tenant_id, property_id nullable, department_code nullable, service_code nullable,
                            response_minutes, resolution_minutes, business_hours_ref, pause_rules jsonb, escalation_rules jsonb, version
ops.sla_instances           id, work_item_id, policy_id, response_due_at, resolution_due_at, paused_at, paused_total_sec,
                            response_met_at, resolution_met_at, breached_at, status
ops.escalations             id, sla_instance_id, level, triggered_at, notified_actor_refs, acknowledged_by, acknowledged_at
ops.approval_requests       id, tenant_id, property_id, kind, subject_type, subject_id, requested_by_actor, payload,
                            risk_level, status (PENDING|APPROVED|REJECTED|EXPIRED), decided_by, decided_at, decision_reason, expires_at
ops.alerts                  id, tenant_id, property_id, type, severity, dedupe_key unique(active), status, evidence jsonb,
                            first_seen_at, last_seen_at, acknowledged_by, resolved_at
ops.notification_intents    id, tenant_id, property_id, recipient_type (USER|GUEST|ROLE|DEPARTMENT), recipient_id,
                            template_key, params jsonb, priority, critical_override bool, status, created_at
ops.notification_deliveries id, intent_id, channel (PUSH|WHATSAPP|EMAIL|SMS|IN_APP), status, provider_ref, attempts, last_error
ops.notification_preferences actor_type, actor_id, template_key/category, channel, enabled
ops.business_hours          id, tenant_id, property_id, department_code nullable, schedule jsonb, timezone
ops.sla_pauses              id, sla_instance_id, reason, paused_at, resumed_at — pause history (rule 10), totals derive from it
-- owned by the organization context (Spec §80 "Property → Departments"); ops references departments by code
org.departments             id, tenant_id, property_id, code unique per property, status, version
org.department_translations department_id, locale, name
```

Work-item kinds are not an enum: a module registers the kinds it creates (`WorkItemKindRegistry.register('HK_JOB', …)`) at
module init; creating a work item of an unregistered kind is rejected. This is what lets future modules use the engine
without a migration of `ops`.

### 7.2 Engine rules

- **SLA** computed by a pure, unit-tested function `computeSlaDeadlines(policy, businessHours, now)`; timers via scheduler jobs on the `critical-operational` queue; breach ⇒ escalation ⇒ alert (deduped) ⇒ notification intent. No LLM anywhere in this path (Spec §8.3, §82.25).
- **Workflow**: JSON state machine interpreted by a deterministic engine; guards are named predicates registered in code; actions are named handlers (create task, start SLA, notify, request approval). Versions immutable once `published_at` set.
- **Approvals**: one engine used by compensation/refund/OOO/AI proposals; subject carries risk level; decision audited.
- **Delivery adapters**: `IN_APP` and `EMAIL` (mailpit) in this phase; `WHATSAPP` adapter lands in Phase 4; `PUSH` with staff web.

### 7.3 APIs / permissions / events (abridged)

APIs: work items & tasks list/filter (my tasks, department, property), assign/accept/start/pause/complete/cancel, workflow definitions CRUD + publish, SLA policies, approvals inbox (pending/decide), alerts (ack/resolve), notification preferences.

Permissions: `task.read task.assign task.accept task.complete task.cancel workflow.manage sla.manage approval.read approval.decide alert.read alert.ack notification.preferences.manage`

Events: `ops.work_item.created.v1`, `ops.task.assigned.v1`, `ops.task.status_changed.v1`, `ops.sla.breached.v1`, `ops.escalation.triggered.v1`, `ops.approval.requested.v1`, `ops.approval.decided.v1`, `ops.alert.raised.v1`, `ops.notification.requested.v1`

### 7.4 Acceptance

- Two different "modules" (a test module A and B) create work items and get tasks, SLA and escalation without any module-specific task table.
- SLA with business hours 08:00–20:00 and a pause correctly shifts deadlines (table-driven tests across DST in `Africa/Cairo`).
- Same alert condition raised 50 times produces one active alert with `last_seen_at` updated.
- Approval of a HIGH-risk subject is required before the subject's handler runs; expiry closes it.
- Assignment history is complete after assign → reassign → unassign.

### 7.5 Task lifecycle (deterministic, unit-tested)

```text
NEW ──assign──▶ ASSIGNED ──accept──▶ ACCEPTED ──start──▶ IN_PROGRESS ──complete──▶ DONE
 ▲                 │  └──reject (assignee)──▶ NEW (assignment closed, reason REJECTED)
 └───unassign──────┘                          IN_PROGRESS ──pause(reason)──▶ PAUSED ──resume──▶ IN_PROGRESS
any non-terminal ──cancel(reason)──▶ CANCELLED;   reassign = close current assignment + open a new one (ASSIGNED)
```

Assignees act on their own tasks with `task.accept`/`task.complete`; supervisors (`task.assign`) may act on any task of
the property. Work-item status derives from its tasks: OPEN → IN_PROGRESS (a task accepted/started) → RESOLVED (all
tasks terminal, at least one DONE) or CANCELLED (all cancelled). Every transition writes `ops.task_events` and an
`ops.task.status_changed.v1` event; the row's `version` guards concurrent updates.

### 7.6 Migrations and tests

- `0011_ops_core` (departments, work items, tasks, assignments, task events), `0012_ops_sla` (business hours,
  policies, instances, pauses, escalations, alerts), `0013_ops_workflow_approvals`, `0014_ops_notifications`; every
  tenant-owned table gets forced RLS and tenant/property FKs; published workflow versions are protected by a trigger.
- Unit: task state machine, work-item status derivation, `computeSlaDeadlines` table (business hours, overnight
  schedules, pauses, DST in `Africa/Cairo` and a zone with a gap), escalation ladder, workflow interpreter, approval
  expiry, alert dedupe key.
- Integration (real PostgreSQL/Valkey): two test modules create work through `OPERATIONS_API`; assignment history;
  SLA timers fire through the `critical-operational` queue and breach → escalation → alert → notification intent;
  approvals gate a HIGH-risk handler; 50 identical alert raises → one alert; tenant-leak test (404 + RLS).
- e2e: API routes for tasks/approvals/alerts with the role catalog (General manager, Duty manager, department staff).

### 7.7 Sprints and progress

| Sprint | Scope | Status |
|---|---|---|
| 3.1 | `org.departments` (+ translations, API, `ORGANIZATION_API.getDepartment`); `@hotella/domain-operations`: work items, tasks, assignment history, task events; kind registry; `OPERATIONS_API.createWorkItem/addTask`; task lifecycle API (assign/unassign/accept/reject/start/pause/resume/complete/cancel); `my tasks`/department/property lists; events `ops.work_item.created.v1`, `ops.work_item.status_changed.v1`, `ops.task.assigned.v1`, `ops.task.status_changed.v1`; permissions; role grants | delivered |
| 3.2 | `@hotella/platform-time` (IANA wall clock ↔ UTC); business hours; SLA policies with property/department/service overrides; `computeSlaDeadlines`; SLA instances started by work items, paused/resumed by task pauses with policy pause rules; timers on `critical-operational` + a sweep; breach → escalation ladder → deduplicated alert; `ops.sla.breached.v1`, `ops.escalation.triggered.v1`, `ops.alert.raised.v1` | delivered |
| 3.3 | Workflow definitions/versions (immutable once published), deterministic interpreter with code-registered guards and actions (create task, start SLA, notify, request approval); generic approval engine (risk level, expiry job, audited decisions, handler registry); `ops.approval.requested.v1`, `ops.approval.decided.v1` | delivered |
| 3.4 | Notification intents (from escalations and alerts) and deliveries; `IN_APP` inbox and `EMAIL` (SMTP, Mailpit locally) adapters; preferences with critical-policy override; outbox retention purge; Phase 3 acceptance (`docs/acceptance/phase-3.md`) | delivered |

Reality notes for 3.4:
- Notification intents name a user, everyone holding a role, or everyone holding a permission at the property; the
  worker's dispatcher (an inbox consumer of `ops.notification.requested.v1`) expands them into one delivery per person
  and channel, idempotently (unique per intent, person and channel). Rules turn engine events into intents:
  escalations → the ladder's roles (severity sets the priority; CRITICAL overrides preferences), approval requests →
  holders of `approval.decide`, task assignments → the assignee.
- Channels by priority: NORMAL in-app; HIGH and CRITICAL in-app + e-mail. Preferences are per user, category and channel
  (`notification_preferences`, keyed by user instead of the plan's actor type/id: guests get channels in Phase 4).
  `PUSH` arrives with the staff app, `WHATSAPP`/`SMS` with the Phase 4 adapters; until then they are recorded as
  skipped. `DEPARTMENT` recipients wait for department membership (see 3.1 notes).
- E-mail goes through `EMAIL_CHANNEL` (SMTP via `nodemailer` 8, ADR-0016 row; Mailpit locally). A 10 s job sends due
  deliveries with retries (1, 2, 4, 8 minutes, then FAILED); a delivery records the transport error code, never its
  message (it can echo the address). Subjects and bodies are ICU templates rendered per recipient locale; the inbox
  renders them in the reader's locale; intents store keys and parameters only.
- Retention of delivered events (Phase 2 open item): `EventRetention` purges published outbox rows after
  `EVENTS_OUTBOX_RETENTION_DAYS` (7) and processed inbox rows after `EVENTS_INBOX_RETENTION_DAYS` (30), hourly from the
  worker. Pending outbox rows are never touched.
- Pilot hardening found on the way: the pgBackRest stanza is now created when the pilot database starts (WAL archiving
  without it made PostgreSQL restart its processes), and the reference agent no longer strands a message held back by
  the reorder chaos.
- Stay projection ordering (Phase 2 defect the deployed pipeline exposed): facts of one stay are processed concurrently
  (two queues, concurrency per queue), so a check-out, room move or cancellation could reach the projector before the
  check-in and be dropped. A fresh fact for an unknown stay now fails with `StayNotYetKnownError` and the queue retries
  it (20 s window, then it is reported and ignored as before); an assignment older than the current in-stay assignment
  never moves the guest back. Covered by "facts delivered before their check-in are retried…" in the guest suite.

Reality notes for 3.3:
- Workflow definitions and versions are property-scoped (like SLA policies). A version is a draft until published;
  publishing validates it against the registered guards and actions, retires the previous published version and freezes
  it — a database trigger refuses any later change except retiring, and any deletion (CLAUDE.md rule 9). Running
  workflows stay on the version they started with.
- Triggers are the task lifecycle (`TASK_ACCEPTED/STARTED/COMPLETED/CANCELLED`), approval outcomes
  (`APPROVAL_APPROVED/REJECTED/EXPIRED`) and named staff actions (`MANUAL:<ACTION>`, permission `task.assign`). SLA
  breaches do not drive workflows yet (escalation covers them). Built-in guards: `all_tasks_done`, `no_open_tasks`,
  `has_open_tasks`, `last_approval_approved`; actions: `create_task`, `request_approval`, `cancel_open_tasks` — modules
  add theirs through the registry. Actions never fire triggers, so a move cannot recurse.
- While a workflow runs, a work item does not become RESOLVED/CANCELLED just because its current tasks are finished: it
  stays IN_PROGRESS until the workflow reaches a terminal state, then follows its tasks again. A work item started with a
  workflow gets its tasks from the workflow (no default task).
- Approvals: kinds are registered with an optional handler that runs inside the approving transaction (a failing handler
  rolls the approval back). Only a person may decide, never the requester (four eyes); an AI agent cannot request a
  CRITICAL action; undecided requests expire (default 1 h CRITICAL, 4 h HIGH, 24 h otherwise) through
  `ops.approval.expire` (every minute on `critical-operational`). Every request and decision is audited with
  `approvalRef`.
- The worker now runs the full engine (approval expiry moves workflows): it composes route-free modules of the contexts
  the engine looks up — `OrganizationCoreModule` (branding resolution is not available there) and
  `IdentityDirectoryModule` — next to `GuestCoreModule`. This is the pattern later phases use to create work from events.

Reality notes for 3.2:
- Timers are one repeatable job, `ops.sla.sweep` every 15 s on `critical-operational`, over an indexed `next_check_at`
  (claimed with `FOR UPDATE SKIP LOCKED`, so several workers are safe), instead of one delayed job per deadline. Targets
  are minute-based; the API path never depends on Valkey; evaluation is idempotent (`evaluateSla`, unit-tested).
- SLA state follows the tasks inside the same transaction: the response target is met by the first accept/start/complete,
  the resolution clock pauses only while every open task is paused for a reason the policy lists (e.g. `WAITING_GUEST`)
  and its deadline is recomputed from the pause history; resolution/cancellation of the work item closes the SLA.
- An SLA copies targets, calendar (business hours + the property's time zone) and escalation ladder from its policy when
  it starts, so policy edits never move running deadlines. `ops.business_hours` has no time-zone column (the property's
  is used) and no `department_code`: department hours are a separate code chosen by a department-matched policy.
- Policies are property-scoped in this sprint (the property is the broadest override); a tenant-wide default comes with
  multi-property chains if needed. Selection is deterministic: service > department > priority > kind, ties by id.
- Alerts moved here from 3.4 because escalation needs them: one active alert per dedupe key (partial unique index +
  `ON CONFLICT`), repeats count and only raise severity, SLA alerts close themselves (SYSTEM) when the response is met
  or the work is resolved/cancelled. Escalations record the roles to notify; intents for them arrive in 3.4.
- `@hotella/platform-time` converts wall clock ↔ UTC with ECMAScript Temporal's `compatible` disambiguation (a
  non-existent local time moves forward by the gap; a repeated one takes the earlier instant).

Reality notes for 3.1:
- Tasks keep the plan's status set without `REJECTED`: an assignee who rejects a task hands it back (`ASSIGNED → NEW`, the
  assignment closes with end reason `REJECTED`); cancelling is `CANCELLED`. Starting implies accepting, and completing is
  allowed from any owned status, so staff screens stay one tap (CLAUDE.md rule 23).
- `tasks.current_assignee_user_id` became `assignee_type` + `assignee_id`: a task can wait in a department's queue
  (`TEAM` = the department) and any member claims it (`CLAIM` in the history, the team assignment closes with `CLAIMED`).
  `AI` and `ROBOT` are reserved. Department membership of staff is not modelled yet: anyone with `task.accept` at the
  property may claim; it arrives with the staff app (Phase 5) if hotels need it.
- Supervisors (`task.assign`) may act for an assignee; such actions are audited with `onBehalf`. Assignments, unassignments
  and cancellations are audited; every transition is in `ops.task_events`, append-only at the database level (only a
  free-text reason may be cleared, for anonymization).
- Work items carry `source_module/source_entity_type/source_entity_id`; titles are a locale key with parameters or quoted
  free text (CONFIDENTIAL). Anonymizing a guest must also clear free-text titles that quote them — wired when the first
  guest-facing source (service requests, Phase 5) exists.
- Departments live in the organization context (`org.departments`), referenced by code with a composite foreign key
  `(property_id, department_code)`. Permission `org.department.manage` (platform admin, general manager).
- Defects found and fixed on the way: the identity catalog sync let a partial process (the admin CLI) strip the grants of
  modules it does not load, which broke the Phase 2 pilot smoke; the check that system roles grant only declared
  permissions moved to `apps/api` (`test/role-catalog.spec.ts`), because identity cannot import contexts that depend on it.

---

## 8. Phase 4 — Communications & Guest Identity (detailed)

**Goal / acceptance (Spec §85):** a checked-in guest activates without OPERA modification and is later recognized automatically on the verified channel.

### 8.1 Domain model (schema `comms`, plus `guest` additions)

```text
comms.channels                  id, tenant_id, property_id, type (WHATSAPP|GUEST_WEB|ROOM_QR|EMAIL|SMS|VOICE|MESSENGER|INSTAGRAM|APP),
                                provider_code, config jsonb, credential_ref, status, brand_profile_id nullable
comms.channel_identities        id, tenant_id, channel_type, identifier_normalized (E.164 phone, email…), guest_id nullable,
                                verified_at, last_seen_at — identity ≠ authorization
comms.conversations             id, tenant_id, property_id, subject_type (GUEST|STAFF_INTERNAL), guest_id, stay_id nullable,
                                status (OPEN|WAITING_GUEST|WAITING_STAFF|HANDED_OFF|CLOSED), assigned_user_id nullable,
                                ai_mode (OFF|ASSIST|AUTO), handoff_reason nullable, last_message_at, version
comms.conversation_participants id, conversation_id, participant_type (GUEST|STAFF|AI|SYSTEM|EXTERNAL), participant_ref, joined_at, left_at
comms.messages                  id, conversation_id, channel_id, direction, sender_participant_id, type
                                (TEXT|IMAGE|AUDIO|VIDEO|DOCUMENT|LOCATION|INTERACTIVE|SYSTEM), body text, media_asset_id,
                                locale_detected, provider_message_id, reply_to_message_id, created_at
comms.message_delivery_events   id, message_id, status (QUEUED|SENT|DELIVERED|READ|FAILED), provider_payload, occurred_at
comms.activation_tokens         id, tenant_id, property_id, stay_id, token_hash, purpose, expires_at, used_at, revoked_at, created_by
comms.verification_sessions     id, tenant_id, property_id, stay_id nullable, room_id nullable, phone_normalized, otp_hash,
                                attempts, max_attempts, expires_at, verified_at, channel (WHATSAPP|SMS), activation_token_id nullable
comms.verification_deliveries   id, tenant_id, session_id, channel (WHATSAPP|SMS|VOICE|STAFF), provider_code, status, provider_ref,
                                error_code, sent_at — one row per delivery attempt of the same code (ADR-0015)
comms.inbound_events            id, tenant_id, property_id, channel_id, provider_event_id unique per channel, payload jsonb,
                                received_at, processed_at, status — raw webhook store, normalized by the worker
comms.room_qr_codes             id, tenant_id, property_id, room_id (location), token_hash, status (ACTIVE|ROTATED|REVOKED),
                                created_at, rotated_from — contains no guest data
comms.inbox_views               (materialized/read model) conversation + guest + stay + room + open work items + SLA risk + AI summary placeholder
-- owned by the guest domain (Spec §6); comms creates grants only through `@hotella/domain-guest/public`
guest.guest_access_grants       id, tenant_id, property_id, guest_id, stay_id nullable, scopes text[]
                                (SERVICE_REQUEST|CHAT|DINING|CONCIERGE|ROOM_CONTROL|VIEW_BILL|PAYMENT|LOST_FOUND|FEEDBACK|INVOICE|SUPPORT),
                                valid_from, valid_until, revoked_at, revoke_reason, granted_via (ACTIVATION|QR|STAFF|PRE_ARRIVAL)
guest.guest_sessions            id, grant_id, session_token_hash, device_info, created_at, last_seen_at, expires_at, revoked_at
```

### 8.2 Flows

- **Primary activation** (Spec §19): consume `hotel.guest.checked_in.v1` → mint `activation_token` (256-bit, hashed) → build URL on the property's guest-web domain → *delivery policy* (WhatsApp template if a verified channel identity exists, else staff-visible for front desk) → guest enters mobile → OTP via the fallback chain of ADR-0015 (WhatsApp template through the property's `MessagingProvider`, Meta Cloud API or BSP; automatic SMS fallback on provider error/timeout, manual fallback after 30 s, optional voice, staff-assisted verification as last resort; one verification session and one attempt counter across channels) → verify → `channel_identity` verified → `guest_access_grant` (scopes by property policy; accompanying guests narrower) → `guest_session`.
- **Room QR fallback** (Spec §20): static QR → `room_qr_codes` resolve → room + last-name check against current stay (rate-limited) → same OTP path → grant.
- **Checkout (automatic, PMS-driven)**: `hotel.guest.checked_out.v1` from the PMS revokes room/stay scopes, revokes all guest sessions bound to the grant, closes or archives the stay-bound conversation, and stops any AI auto mode; keeps post-stay scopes (`LOST_FOUND|FEEDBACK|INVOICE|SUPPORT`) for a configurable window. No staff action is required.
- **Pre-arrival** (Spec §22): `EXPECTED` stays can get a narrower grant via the same path.
- **Inbound WhatsApp**: webhook → signature check → `integration_messages`-style raw store → normalize → `channel_identity` lookup → conversation routing → message → (Phase 6) AI → or staff inbox. Unverified phone with room/stay request ⇒ activation prompt, never trust the phone.
- **Realtime**: `apps/realtime` WS gateway pushes inbox updates and guest conversation updates (auth by staff access token / guest session).

### 8.3 Security requirements (tests, Spec §66)

OTP stored as HMAC-SHA256 with a provider-managed key (ADR-0011; a plain hash of a 6-digit code is brute-forceable), 6 digits, 5 min, 5 attempts, per-phone and per-IP rate limits, single-use; activation token single purpose, 24h default, revocable; replay of a used token ⇒ 410; QR token rotation invalidates printed codes without PMS change.

### 8.4 APIs

Public (guest, unauthenticated → session): `POST /guest/activation/start`, `/guest/activation/otp/request`, `/guest/activation/otp/verify`, `POST /guest/qr/:token/verify`, `GET /guest/me` (stay/room/scopes/branding), `GET/POST /guest/conversations/:id/messages`.
Staff: inbox list/filter, conversation detail, send message, assign, handoff/takeover, close; channels CRUD; QR generation/rotation per room (PDF sheet export); activation token issuance/revoke; grants list/revoke.
Webhooks: `POST /webhooks/whatsapp/:channelId` (provider-agnostic `MessagingProvider`; adapters `WHATSAPP_META_CLOUD` and `WHATSAPP_BSP_*`), `POST /webhooks/sms/:channelId` (`SmsProvider` delivery receipts).
Staff-assisted verification: `POST /guest/activation/assist` (permission `guest.activation.assist`, reason required, audited).

### 8.5 Permissions / events

`inbox.read inbox.reply inbox.assign inbox.takeover channel.manage guest.activation.issue guest.activation.assist guest.grant.revoke qr.manage`
Events: `comms.conversation.opened.v1`, `comms.message.received.v1`, `comms.message.sent.v1`, `comms.delivery.updated.v1`, `comms.handoff.requested.v1`, `guest.activated.v1`, `guest.grant.revoked.v1`

### 8.6 Acceptance

- Simulator check-in → activation URL → OTP (fake provider in tests) → grant; subsequent WhatsApp message from the verified phone resolves guest/stay/room automatically with no questions asked.
- Unverified phone gets the activation prompt; brute-forcing OTP locks the session after the limit.
- Fake WhatsApp provider returns an error → the same code is delivered by the fake SMS provider; the attempt counter is continuous across channels; a WhatsApp channel in `OFFLINE` health sends OTP straight to SMS and raises one deduplicated alert.
- Same activation flow passes with the channel bound to the Meta Cloud API adapter and to a BSP adapter (contract tests on both).
- Checkout revokes `SERVICE_REQUEST` and keeps `LOST_FOUND` for the configured window.
- QR rotation: old printed token rejected, new accepted; QR payload contains only an opaque token.
- Staff inbox shows guest/stay/room/open work items for the conversation; takeover marks `HANDED_OFF` and stops any auto mode.

### 8.7 Design decisions taken before coding (spec and ADR-0011/0015 applied)

- **Package** `@hotella/domain-communications` (schema `comms`) owns channels, channel identities, conversations,
  messages, activation tokens, verification sessions/deliveries and room QR codes. **Grants and guest sessions belong to
  the guest context** (`guest.guest_access_grants`, `guest.guest_sessions`); communications creates and reads them only
  through `GUEST_API` (CLAUDE.md rule 19: identity and grants are platform-owned, no PMS change).
- **Internal ids only:** activation and the post-stay rules react to `guest.stay.status_changed.v1` (the guest context
  already turned PMS facts into stays), never to `hotel.*` events with external ids. Checkout revokes stay-bound scopes
  and every session of the grant **inside the projector transaction that checks the stay out** (same context, so no
  window in which a checked-out guest still acts), then publishes `guest.grant.revoked.v1`; communications consumes it to
  close the stay-bound conversation and switch AI mode off.
- **Guest authentication** is separate from staff tokens: guest routes are `@Public()` for the staff guard and protected
  by a `GuestSessionGuard` (header `X-Guest-Session`, opaque 256-bit token, SHA-256 at rest) that resolves the session,
  its grant and the stay on every request and sets the actor (`GUEST`). Scopes are checked per route
  (`@RequireGuestScope('CHAT')`). Sessions slide (default 7 days, never past the grant).
- **Secrets:** the OTP HMAC key is a SecretRef (`COMMS_OTP_HMAC_KEY_REF`); provider credentials are the channel's
  `credential_ref`; the webhook verification secret is part of those credentials. No token, code or phone number is
  logged; phone numbers are stored normalized (E.164) and classified SENSITIVE.
- **OTP**: 6 digits, HMAC-SHA256(key, session id ‖ code), 5 minutes, 5 attempts per session across channels; per-phone
  (5 sessions per hour) and per-IP (route rate limit) limits; a verified or locked session cannot be reused. The
  fallback chain of ADR-0015 is deterministic code: primary channel → automatic fallback when the provider refuses or no
  delivery receipt arrives within `comms.otp.fallback_timeout_seconds` (a 5 s sweep, `comms.otp.fallback`) → manual
  fallback after `comms.otp.manual_fallback_after_seconds` → staff-assisted verification. The voice adapter stays off.
- **Activation delivery:** when a stay goes in house and its primary guest already has a verified WhatsApp identity at
  the tenant, a token is minted and the activation template is sent; otherwise front desk issues a token on demand and
  the URL (and its QR) is shown once (tokens are hashed, so they cannot be shown again; issuing a new one revokes the
  previous one for that stay and purpose).
- **Configuration keys** (property-overridable): `comms.otp.primary_channel`, `comms.otp.fallback_channels`,
  `comms.otp.fallback_timeout_seconds`, `comms.otp.manual_fallback_after_seconds`, `comms.otp.staff_assist_enabled`,
  `comms.activation.token_ttl_hours`; `guest.grant.in_stay_scopes`, `guest.grant.companion_scopes`,
  `guest.grant.pre_arrival_scopes`, `guest.grant.post_stay_scopes`, `guest.grant.post_stay_hours`.
- **Inbound webhooks** are stored raw first (`comms.inbound_events`, CONFIDENTIAL, purged by retention) after signature
  verification, then normalized by the worker; a duplicate provider message id is a no-op. Raw vendor payloads are not
  domain events (rule 6).
- **Outbound messages** are written `QUEUED` and sent by a worker job with retries (like e-mail notifications); OTP
  sends are the exception and go out inside the request so the guest waits on one round trip.
- **Channel health** is the communications context's (`comms.channels.health`: HEALTHY/DEGRADED/OFFLINE/AUTH_FAILED,
  from send outcomes); OFFLINE/AUTH_FAILED pre-empts OTP to the fallback and raises one deduplicated operations alert
  through `OPERATIONS_API.raiseAlert`. The ops notification dispatcher gets `WHATSAPP`/`SMS` delivery through the same
  adapters once staff phone numbers exist (Phase 5); until then they stay skipped.
- **Inbox read model** is a query over conversations joined through public APIs (guest, stay, room, open work items,
  SLA risk) at pilot scale; a materialized projection is introduced only if profiling shows the need.

### 8.8 Migrations and tests

- `0015_guest_access` (grants, grant history, sessions), `0016_comms_channels` (channels, channel identities),
  `0017_comms_activation` (activation tokens, verification sessions, verification deliveries, room QR codes),
  `0018_comms_conversations` (inbound events, conversations, participants, messages, delivery events); forced RLS, tenant/property FKs,
  partial unique indexes (one ACTIVE QR per room, one open stay-bound conversation per stay, one verified identity per
  channel type and identifier per tenant).
- Unit: phone normalization (E.164, Egyptian local formats), OTP generation/verification and HMAC, attempt/expiry
  rules, fallback decision table (provider error, no receipt, health pre-emption, manual fallback timing), grant scope
  policy (primary vs companion vs pre-arrival vs post-stay), Meta Cloud webhook signature (HMAC-SHA256 `X-Hub-Signature-256`)
  and payload parsing, BSP adapter mapping, conversation routing table.
- Integration (real PostgreSQL/Valkey, fake providers): check-in → token → OTP → grant → session; WhatsApp error → SMS
  receives the same code with a continuous attempt counter; OFFLINE channel → straight to SMS + one alert; brute force
  locks; replayed token → 410; QR rotation; checkout revokes in-stay scopes and sessions, keeps post-stay scopes for the
  window; inbound message from a verified phone lands in the stay's conversation; unverified phone gets the activation
  prompt; staff inbox, assignment, takeover (`HANDED_OFF`, AI off), close; tenant-leak test (404 + RLS).
- Contract tests: the same activation flow and inbound/outbound message flow run against the Meta Cloud API adapter
  and the generic BSP adapter (recorded provider payloads, no network).
- e2e: the guest API and staff inbox routes with the role catalog (front desk, guest relations, duty manager).

### 8.9 Sprints and progress

| Sprint | Scope | Status |
|---|---|---|
| 4.1 | Guest access in the guest context: grants (scopes by policy, companions narrower, pre-arrival, post-stay window), guest sessions, `GUEST_API` (issue grant, open/authenticate/revoke session), checkout revocation in the projector, `guest.grant.revoked.v1`, staff grants list/revoke; `@hotella/domain-communications` skeleton: channels CRUD with `credential_ref`, `MessagingProvider`/`SmsProvider` ports with fake adapters, channel identities, phone normalization, manifest | delivered |
| 4.2 | Activation: tokens (on in-house stays with a verified identity, front-desk issuance/revoke), verification sessions with HMAC OTP, delivery chain WhatsApp → SMS with `verification_deliveries`, fallback sweep, health pre-emption + alert, rate limits, guest routes (`/guest/activation/*`, `/guest/me`), `GuestSessionGuard`, staff-assisted verification; room QR codes (generate, rotate, revoke, verify with last name); `guest.activated.v1` | delivered |
| 4.3 | Messaging: Meta Cloud API and generic BSP adapters (templates, text, media refs, webhook signatures, delivery receipts) with contract tests; webhooks with raw store and worker normalization; conversations, participants, messages, delivery events; routing by verified identity + active grant; activation prompt for unverified phones; outbound queue with retries; staff inbox (list/filter, detail with guest/stay/room/open work, send, assign, takeover/handoff, close); guest conversation routes; checkout closes stay conversations; `comms.*` events | planned |
| 4.4 | `apps/realtime` WebSocket gateway (staff access token / guest session; inbox and conversation updates through Valkey pub/sub); printable room QR sheet; pilot smoke extended to activation; Phase 4 acceptance (`docs/acceptance/phase-4.md`) | planned |

Reality notes for 4.2:
- The OTP is **derived, not stored**: `code = HMAC-SHA256(key, session id ‖ random seed)` truncated to 6 digits, under
  the key `COMMS_OTP_HMAC_KEY_REF` (a SecretRef; pilot: `kv/hotella/app#otp_hmac_key`). The row keeps only the seed
  (RESTRICTED), so a fallback channel re-sends *the same* code (ADR-0015) and the database alone never reveals it —
  this replaces the plan's `otp_hash` column. Codes are compared in constant time.
- The guest's device holds a 256-bit **handle** (SHA-256 at rest) for its verification session; the session id alone is
  never a credential. A wrong code is counted and committed before the error is returned; the fifth locks the session.
  A verified session becomes a grant and a guest session exactly once (`completed_at`); the activation link is consumed
  at that moment (single use; replay → 410).
- Who is verified: a link issued for a party member names them; otherwise the party member whose PMS phone matches the
  verified number, else the primary guest. Room QR: the last name (case-, accent- and Arabic-diacritic-insensitive)
  must match a member of a stay in house in that room; every mismatch gets the same `comms.qr.no_match`.
- Delivery: the chain is primary + fallbacks from configuration, limited to the property's active channels and
  skipping OFFLINE/AUTH_FAILED ones (which raises the `CHANNEL_UNHEALTHY` alert, deduplicated per channel). A provider
  error moves on at once (`AUTO_FALLBACK`); a send without a delivery receipt after `comms.otp.fallback_timeout_seconds`
  is moved on by the worker sweep `comms.otp.fallback` (every 5 s, SKIP LOCKED); the guest may ask for the next channel
  after `comms.otp.manual_fallback_after_seconds`. Health: a success heals; an unavailable provider degrades, then takes
  the channel offline; an authentication failure sticks until the channel's credentials or configuration change.
  Delivery receipts (`ActivationService.deliveryStatus`) are fed by the provider webhooks of 4.3.
- Staff-assisted verification: the guest reads out a 6-character reference; staff with `guest.activation.assist` find
  the open session (masked phone, guest name) and confirm it with a reason (audited); the guest's device then calls
  `POST /guest/activation/complete`. A session locked by wrong codes may still be confirmed in person; an expired one not.
- Arrival: on `EXPECTED → IN_HOUSE` the worker sends the activation template to the primary guest's most recently
  verified WhatsApp number at the tenant, if the property has a healthy WhatsApp channel; nothing is ever sent to an
  unverified number. Otherwise front desk issues the link (`POST /properties/:p/stays/:s/activation-tokens`), shown once.
- Guest API: `POST /guest/activation/start|otp/request|otp/resend|otp/verify|complete`, `GET /guest/qr/:token`,
  `POST /guest/qr/:token/verify`, `GET /guest/me`, `POST /guest/logout`; per-IP rate limits on every public step.
  `GuestSessionGuard` reads `X-Guest-Session`, re-checks session, grant and scope per request and sets a GUEST actor.
- Staff API: activation tokens (issue/list/revoke, `guest.activation.issue`), verification sessions by reference and
  assist (`guest.activation.assist`), room QR codes (list, generate/rotate — token shown once — revoke, `qr.manage`).
  Front desk, guest relations and managers hold the activation permissions; general managers hold `qr.manage` and
  `channel.manage`. The printable sheet arrives in 4.4.
- `PropertySummary` exposes the property's country (national phone numbers); `GUEST_API.stayParty` gives verification
  flows the party with names and PMS phone numbers.

Reality notes for 4.1:
- Grants carry the party role and their scopes; every change is a row in `guest.guest_access_grant_events`
  (GRANTED/WIDENED/NARROWED/REVOKED, append-only by trigger), so history is never overwritten (rule 10). A pre-arrival
  grant widens to the in-stay (primary) or companion scopes when the stay goes in house; check-out narrows it to the
  post-stay scopes it holds for `guest.grant.post_stay_hours` (72 by default) and caps its sessions there — revoking the
  grant and every session when nothing remains; cancellation and no-show revoke. This runs in the projector's
  transaction (`GuestAccessService.followStay`), so a checked-out guest never keeps in-stay access.
- `PAYMENT` is not in any default scope set: a property opts in through configuration.
- One live grant per guest and stay, reused for every device; verifying again after check-out returns the post-stay
  grant, never a wider one. Anonymization and merges revoke the guest's grants (device descriptions are cleared).
- Guest sessions: opaque 256-bit tokens, SHA-256 at rest, 7-day sliding expiry capped at the grant, `last_seen_at`
  written at most once a minute; `GUEST_API.authenticateGuestSession` re-checks session, grant and validity on every
  call. The HTTP guard that uses it arrives with the guest routes in 4.2.
- Events: `guest.grant.issued.v1` (stands in for the plan's `guest.activated.v1`; activation is one of its `granted_via`
  values), `guest.grant.changed.v1`, `guest.grant.revoked.v1`; permission `guest.grant.revoke` (guest desks and
  managers); staff routes `GET /properties/:p/stays/:s/grants` (with history) and `POST /properties/:p/guest-grants/:g/revoke`.
- `@hotella/platform-settings` gained a route-free `SettingsCoreModule`/`SettingsReader`, so the worker reads property
  policy without the configuration API.
- Communications: channels are created for adapter-backed types (`WHATSAPP`, `SMS`) only; web and QR entry points need
  no channel row. Adapters register in `ChannelAdapterRegistry`; the in-memory `FAKE_WHATSAPP`/`FAKE_SMS` adapters
  serve tests and local development; Meta Cloud API and BSP adapters arrive in 4.3. Channel identities are one row per
  identifier per tenant (the guest it was last verified for); anonymization removes them (worker consumer of
  `guest.guest.anonymized.v1`). Phone numbers normalize to E.164 with the property's country for national forms;
  ambiguous input is refused.

---

## 9. Phase 5 — Guest Service Catalog (detailed)

### 9.1 Domain model (schema `catalog`, plus `ops` usage)

```text
catalog.service_categories           id, tenant_id, property_id nullable, code, parent_id, sort_order, icon, status
catalog.service_category_translations category_id, locale, name, description
catalog.service_definitions          id, tenant_id, property_id nullable, code (EXTRA_TOWELS…), category_id, status
catalog.service_versions             id, definition_id, version, department_code, workflow_version_id, sla_policy_id,
                                     required_fields jsonb (zod-like schema), eligibility jsonb (scopes, stay status, room types),
                                     availability jsonb (hours, lead time, capacity), guest_visible bool, automation_policy jsonb,
                                     price jsonb nullable, published_at (immutable after)
catalog.service_version_translations version_id, locale, name, short_description, description, guest_prompt_hints
catalog.service_requests             id, tenant_id, property_id, service_version_id, guest_id, stay_id, room_id,
                                     conversation_id nullable, work_item_id, status, fields jsonb, requested_for_at nullable,
                                     source (GUEST_WEB|WHATSAPP|STAFF|AI|QR), created_by_actor, version
```

### 9.2 Behaviour

- Publishing a version freezes it; editing creates a draft of the next version. Requests reference the exact version.
- `createServiceRequest()` is the single application entrypoint used by staff UI, guest web, and later the AI tool `operations.create_service_request`; it runs eligibility (grant scopes + stay state + availability), **duplicate detection** (same stay + same service open within window ⇒ relate instead of create, Spec §23), then creates the work item via the Operations Engine public API and binds SLA/workflow.
- Guest-facing catalog is localized from translation tables with the locale resolution chain; untranslated locale falls back to property default then `en`.

### 9.3 APIs / permissions / events

Guest: `GET /guest/services` (eligible, localized), `POST /guest/requests`, `GET /guest/requests`. Staff: catalog CRUD + publish, requests board, create on behalf of guest.
Permissions: `catalog.read catalog.manage catalog.publish request.read request.create request.manage`
Events: `catalog.service_version.published.v1`, `catalog.service_request.created.v1`, `catalog.service_request.status_changed.v1`, `catalog.service_request.related.v1`

### 9.4 Acceptance (closes **M1**)

End-to-end CI scenario: simulator check-in → activation → request EXTRA_TOWELS from guest web API in Arabic → task appears for Housekeeping department with SLA → staff completes → guest receives localized notification (fake WhatsApp provider) → audit trail links every step by `correlation_id`. A second identical request within the window is related to the first, not duplicated.

---

## 10. Phases 6–13 (outline; expanded before each starts)

### Phase 6 — AI Foundation (M2)
Deliver: `ai` schema (providers, models, capabilities, routing rules, agents, agent_versions (immutable), prompts, prompt_versions, tools, tool_versions, policies, action_proposals, executions, execution_steps, model_calls, memory_candidates, memories, feedback). Model Gateway with capability-based routing (`REASONING_HIGH, FAST_CLASSIFICATION, VISION, TRANSLATION, EMBEDDING, AUDIO, STRUCTURED_OUTPUT`), providers behind one interface (Anthropic, OpenAI, Google, local), fallback, cost/latency recording, kill switches. Tool Registry executing through the **action gate** with risk levels and AI policy stage now real. Context Engine with per-agent context policies. Guest Concierge v1 with tools `guest.get_current_stay`, `operations.find_open_requests`, `operations.create_service_request`, `knowledge.search` (stub), `communication.send_message`. Prompt composition in layers (Spec §30: platform → agent → tenant policy → property context → actor role → current task), prompt and agent versions immutable once published. Handoff reasons → inbox; AI drafts in the inbox with human edits recorded (`ai_feedback`, edit distance) for evaluation (Spec §24, §40). Language detection → respond in guest language. Data classification/redaction before provider calls using the Phase 0 classification registry. Knowledge module v1 (`knowledge` schema: documents, versions, chunks, embeddings, scope = tenant/property/department/language/audience/effective dates/classification; hybrid retrieval metadata + keyword + vector + rerank; retrieval results carry document version references, Spec §37–§38). Rule: structured live data (open tasks, stay state) is served by tools, never RAG (Spec §82.10). Acceptance: "الجو حر أوي هنا" scenario; HIGH-risk tool produces an `action_proposal` routed to approvals; execution audit complete; no AI code path has a DB write outside tool handlers (lint + test).

### Phase 7 — Housekeeping
`hk` schema: `room_operational_states` projection (+version), `housekeeping_jobs` via work items, `credit_rules`, `room_signals` (DND/MUR/PRIVACY/SERVICE_REQUESTED with source), assignment boards, inspection hook (Phase 9 engine, early minimal version here), arrival readiness v0 (configurable dimensions, Spec §16). Consumes `hotel.guest.checked_out.v1` → CHECKOUT job; `hotel.room.status_changed.v1`. Housekeeping Copilot recommendations (assignment balancing by credits/location/history) as proposals only.

### Phase 8 — Engineering / CMMS
`eng` schema: assets (hierarchy, types with controlled JSON schemas, models), asset documents (knowledge layer), work orders (types, failure taxonomy tables SYMPTOM/FAILURE_MODE/CAUSE/RESOLUTION), meters & readings, PM plans (CALENDAR/METER/CONDITION) with versioned procedures, parts & usage, warranty rules, room restrictions (OOO/OOS/BLOCKED) with integration command when PMS is source of truth. Engineering knowledge retrieval (RAG over manuals, hybrid search, pgvector). Engineering Copilot. Arrival-risk intelligence v1 combining HK + ENG + stay ETA (rules first, AI for explanation).

### Phase 9 — Inspections, Guest Relations, Lost & Found, Logbook
Generic inspection engine first (`inspection` schema per Spec §11, critical finding ⇒ work item via rules). Then `relations` (complaints, categories, evidence, `complaint_candidates` from AI with confidence, service recovery actions through approvals), `lostfound` (items, vision-derived metadata kept separate from staff description, match candidates with score/reasons, audited claims), `logbook` entries + AI shift summary with human acknowledgement.

### Phase 10 — Real OPERA 5 On-Premise Integration (M4a)
`apps/hotel-agent` (.NET 8 worker service): registration with signed identity, outbound WSS/HTTPS, SQLite durable queue (pending events, acks, checkpoints, config cache, license token, health), the link of ADR-0017 (MSI installer, enrollment, mTLS, WSS/HTTPS client, SQLite WAL queue with ordering and acks, signed-command verification, licence verification, signed updater with rollback) and three adapters per ADR-0014 — `OPERA5_FIAS` (IFC8/FIAS TCP link: link-alive, DB-sync handshake, GI/GO/GC/RE records → canonical events; primary, real-time), `OPERA5_OWS` (SOAP OPERA Web Services: future reservations, arrivals, profiles, ETA → `RESERVATION_READ`/`GUEST_READ`, enabling pre-arrival and arrival-risk; where licensed), `OPERA5_DBVIEW` (optional read-only Oracle views, reconciliation only, never an event source) — mapping, canonical events, reconciliation jobs (MATCH/MISSING_INTERNAL/MISSING_EXTERNAL/DIFFERENT), health states, signed offline license validation (public key), controlled update/rollback. Platform side: the three adapters share one connector manifest family through the same Connector SDK as `SIM_PMS`; predefined signed operations only (no remote shell). Room-status/OOO writes toward OPERA are enabled per instance only after verification at the pilot. **Pilot prerequisites:** IFC8 license for a new generic interface, OWS license status, contractual possibility of a read-only DB account.

### Phase 11 — Licensing & Control Plane (M4b)
`license` schema (products, modules, features, plans, plan_versions, subscriptions, entitlements (tenant-wide + property-specific), limits, usage_metrics, usage_events (idempotent), usage_aggregates). `EntitlementEngine.can(tenant, property, capability)` replaces the Phase 1 stub stage. Control-plane admin API/UI (tenant mgmt, subscriptions, entitlements, flags, connector & AI provider registries, support access, health). Offline license token issuance for the hotel agent. Developer platform v1 (Spec §75): API clients with scoped keys, signed outbound webhooks with retry/DLQ/replay (ADR-0012), OAuth clients later; no untrusted code plugins in the runtime.

### Phase 12 — Advanced Intelligence
GM/duty-manager intelligence, cross-property analysis, insight/recommendation engine with evidence (Spec §38), evaluation sets/runs, shadow & canary agent versions, predictive models where data supports, cost optimization and quality metrics dashboards (Spec §41). Operational digital-twin read model (Spec §80): a graph-shaped projection (property → rooms → stays/guests/assets/tasks/incidents/conversations) built from existing domain events, used by Manager AI and arrival-risk; it is a projection, never a source of truth. Controlled agent collaboration (Spec §43): specialist agents callable as capabilities with structured results, no free-form agent swarms.

### Phase 13 — Voice / IoT / Additional Connectors
Voice channel via PBX gateway → conversation engine → same tools; IoT/BMS telemetry path (high-volume ingest → rules/anomaly → meaningful events); POS/ERP/Wi-Fi/lock connectors through the Connector SDK. No core redesign allowed; if one seems needed, stop and write an ADR.

---

## 11. Milestones & sequencing

```text
Phase 0 ──> Phase 1 ──> Phase 2 ──> Phase 3 ──> Phase 4 ──> Phase 5  = M1 (guest served from PMS data via simulator, no live OPERA link, no AI)
                                                              └─> Phase 6  = M2 (AI concierge)
                                                                   ├─> Phase 7 (HK) ──┐
                                                                   ├─> Phase 8 (ENG) ─┼─> Phase 9 = M3
                                                                   │                  │
                                                                   ├─> Phase 10 (OPERA 5 agent) ─┐
                                                                   └─> Phase 11 (Licensing)  ────┴─> M4 (pilot-ready)
                                                                                 └─> Phase 12 ──> Phase 13
```

Phases 7 and 8 may run in parallel after Phase 6 (they share only the Operations Engine). Phase 10 may start its .NET agent skeleton in parallel with Phase 7 since it depends only on the Connector SDK from Phase 2.

**Parallelism rule:** two phases may run in parallel only if neither needs to change a package the other owns. Shared packages (`platform/*`, `contracts/*`, `operations`) changes are serialized through review.

---

## 12. Module Definition of Done (applies to every bounded context, Spec §84.19)

A module/phase is accepted only when all of the following are true:

1. **Scope doc** in this plan is current (scope, domain model, migrations, APIs, events, permissions, tests, acceptance).
2. **Schema**: own PostgreSQL schema; every tenant-owned table has `tenant_id` (+ `property_id` where scoped); UUIDv7 ids; TIMESTAMPTZ; `version` on concurrency-sensitive tables; FKs for business-critical relations; no `*_en`/`*_ar` columns; migrations reviewed, reversible where feasible, expand/contract-safe.
3. **Boundaries**: other domains touch it only via `/public` interfaces or events (lint-enforced). It never writes another domain's tables.
4. **Authorization**: every endpoint declares permissions; property scope enforced; tenant leak tests present.
5. **Action gate**: every mutation goes through `ActionGate`; entitlement capability codes declared even while the stage is a stub.
6. **Audit**: important mutations write audit rows with actor type, reason, approval/policy refs, correlation id.
7. **Events**: published events are in `contracts/events`, versioned, written through the outbox; consumers idempotent via inbox.
8. **Localization**: no hardcoded user-facing strings; `en` and `ar` keys present and parity-checked; localized business data uses translation tables; RTL verified for any UI.
9. **Versioning**: published definitions immutable.
10. **AI**: if the module exposes AI tools, they are registered with schema, risk level, required permission; no provider SDK imported outside the Model Gateway.
11. **Integration**: declared connector capabilities consumed; unknown external values create exceptions.
12. **Observability**: correlation ids flow through jobs and events; metrics for queue lag/failures; no PII in logs.
13. **Tests**: unit for domain rules; integration against real PG/Redis; contract tests for events/connectors; e2e scenario for the phase acceptance; all in CI.
14. **Docs**: OpenAPI updated; ADR for any deviation; CLAUDE.md updated if a convention changed; TRACEABILITY rows updated.
15. **Privacy & retention**: every column carries a data class; the module declares retention behaviour per class and implements its purge/anonymize job; nothing in the module blocks guest anonymization except legal-hold rows.
16. **Manifest**: the module's `ModuleManifest` is complete (permissions, events, entitlements, AI tools, locale namespaces, integration capabilities, data classes) and the manifest tests pass.

---

## 13. Open questions (do not block Phase 0; must be answered by the phase indicated)

| # | Question | Needed by | Current assumption |
|---|---|---|---|
| Q1 | Frontend stack | — | **Answered:** Next.js + next-intl + Tailwind (ADR-0009 accepted) |
| Q2 | WhatsApp provider | — | **Answered:** both Meta Cloud API and BSP, selectable per channel (ADR-0015). Concrete first BSP picked at pilot |
| Q3 | OTP fallback | — | **Answered:** WhatsApp → SMS (auto + manual) → optional voice → staff-assisted (ADR-0015). Concrete SMS aggregator picked at pilot |
| Q4 | Guest-web domain model: `*.hotella.app` subdomain per property vs custom property domains (affects activation URLs & branding resolution). With on-prem hosting, DNS for `*.guest.hotella.app` must point at the on-prem ingress, or properties use their own domains | Phase 4 | `{property-code}.guest.hotella.app` + optional custom domain |
| Q5 | OPERA 5 interface | — | **Answered:** FIAS primary; OWS secondary where licensed; optional read-only DB views for reconciliation (ADR-0014). Pilot to confirm IFC8/OWS licenses |
| Q6 | Hosting target | — | **Answered:** on-premises (ADR-0013): Compose → k3s/RKE2, OpenBao (Vault API), SeaweedFS, Grafana stack, pgBackRest |
| Q7 | Data residency / region constraints | — | **Answered by Q6:** data stays within the on-prem installation; multi-region = multiple installations |
| Q8 | First AI provider(s) and budget caps | Phase 6 | Anthropic + OpenAI behind gateway |
| Q9 | Initial platform role catalog (GM, Duty Manager, HK Supervisor, Room Attendant, Engineer, Front Desk, Guest Relations, Platform Admin, Support) — confirm names and Arabic labels | Phase 1 | as listed |
| Q10 | Pilot property: IFC8 interface license, OWS license status, read-only DB account possibility (ADR-0014) | before Phase 10 | FIAS available; OWS unknown |
| Q11 | Concrete BSP and SMS aggregator for the pilot (ADR-0015) | Phase 4 end | Meta Cloud API adapter first; BSP/SMS adapters implemented against fakes until chosen |

---

## 14. Immediate next actions (start now)

1. Commit this plan, the spec, ADRs and `CLAUDE.md` to `claude/hopeful-archimedes-jskowx` and push.
2. Execute **Sprint 0.1** tasks 0.1.1 → 0.1.8 in order; open one PR per sprint (or per task group if large).
3. On Sprint 0.1 completion: run the Phase 0 acceptance checklist items that already apply, then start Sprint 0.2.
4. Product owner answers Q4, Q8, Q9 while Phase 0 runs; they do not block it. Q1, Q2, Q3, Q5, Q6, Q7 are answered (ADR-0009, 0013, 0014, 0015).
