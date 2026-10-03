# ADR-0016: Technology currency & longevity policy (stack baseline, October 2026)

**Status:** Accepted — 2026-10-03 (product owner: "latest technology everywhere, organised so a new developer can work on it, maintainable for years")

## Context
The owner wants the newest technology across the stack **and** a codebase that stays understandable and upgradable for years. Those two goals conflict only if "newest" means pre-release. This ADR fixes the rule that reconciles them and records the concrete baseline verified on 2026-10-03 against primary sources (release notes, GitHub releases, official blogs). It supersedes the version statements in ADR-0001, 0002, 0004, 0005, 0008, 0009 and 0013; those ADRs keep their architectural content.

## Rule
1. **Latest *generally available* major, LTS where the project offers one.** Alphas, betas and release candidates are never used in `packages/platform/*`, `packages/contracts/*` or the database layer. An RC may be used only when the API surface we touch is identical to the previous stable and the ADR says so explicitly (see Drizzle below).
2. **Standards over framework-specific APIs**, so a framework can be replaced without rewriting the domain: ESM, Standard Schema, OpenAPI 3.1, RFC 9457, UUIDv7, ICU MessageFormat, OpenTelemetry, S3 API, RESP protocol, SQL migrations as plain SQL files.
3. **Every dependency has an upgrade trigger** written here or in `package.json` comments; Renovate opens the PR, CI (Gate A) proves it, a human merges. Quarterly "currency sprint" (one day) reviews the table below.
4. **Pin exact versions** in `pnpm-lock.yaml`; majors are changed only through a PR that updates this ADR.
5. **Pure ESM repository** (`"type": "module"`, `moduleResolution: NodeNext`). No CommonJS output anywhere; a dependency that is CJS-only is wrapped behind a platform interface so it can be swapped.

## Baseline (verified 2026-10-03)

| Area | Choice | Version / line | Why this and not the alternative | Upgrade trigger |
|---|---|---|---|---|
| Runtime | Node.js | **26** (Active LTS from 28 Oct 2026, EOL Apr 2029) | Newest LTS line; Node 24 is the fallback if a dependency blocks | Node 27 LTS (Oct 2027) after one minor of ecosystem settling |
| Language | TypeScript | **7.0** (Go-native compiler) for type-checking (`tsgo`) | 10× faster checks; `emitDecoratorMetadata` supported since typescript-go #2343 | TS 7.1 compiler API → re-evaluate single-toolchain emit |
| Emit / build | SWC via NestJS CLI / Rspack | current | TS 7.0 ships no compiler API, so emit is done by SWC (what Nest 12 uses under Rspack); type safety comes from `tsgo --noEmit` in CI | TS 7.1 |
| Backend | NestJS | **12** (ESM-only, Standard Schema in decorators, Vitest, oxlint, Rspack) | Newest GA major (27 Aug 2026); validation via Standard Schema removes the `nestjs-zod` adapter | NestJS 13 |
| Validation | Zod | **4** | Standard Schema compliant; `z.toJSONSchema()` feeds OpenAPI | — |
| Database | PostgreSQL | **18** (18.6) + pgvector 0.8.x | Newest GA major; async I/O subsystem; pgvector supports 18 | PostgreSQL 19 GA + pgvector support, after first minor |
| Data access | Drizzle ORM | **1.0 RC** (pinned), restricted surface | 1.0 final has not shipped (RC since 30 Apr 2026). We use only `pg-core` schema definitions, SQL migrations and the core query builder — identical to 0.45 stable. **Not used until 1.0 final:** RQB v2, JIT row mappers. New 1.0 migration folder layout adopted from day one so no re-layout later | Drizzle 1.0 final → bump; then RQB v2 allowed |
| Cache / queue store | Valkey | **9.x** (BSD-3, Linux Foundation) | Wire-compatible with Redis; permissive licence matters for an on-prem product distributed to customers (Redis 8 is AGPL/SSPL/RSAL); faster release cadence; BullMQ supports it | Valkey 10 |
| Job queue | BullMQ | latest 5.x | De-facto standard on RESP stores; priorities, repeatables, DLQ patterns | BullMQ 6 |
| Monorepo | pnpm + Turborepo | **pnpm 11.x**, **Turborepo 2.6+** | pnpm 11 is pure ESM, Node 22+; Turborepo is the default for JS/TS monorepos | pnpm 12 (Rust port) once GA + one minor |
| Lint | oxlint | **1.x** (+ `oxlint-tsgolint` for type-aware rules) | Stable, 50× faster than ESLint, NestJS 12's default; covers 59/61 type-aware rules | JS plugins GA → move any custom rule we need into oxlint |
| Format | Prettier | **3.x** | oxfmt is still 0.x; Prettier-compatible so a later switch is a one-line change | oxfmt 1.0 |
| Architecture boundaries | dependency-cruiser | latest | Explicit *allow* rules per layer, cycle detection, generates dependency graphs used in onboarding docs; independent of linter plugin maturity | — |
| Tests | Vitest + Testcontainers | **Vitest 4.1+** | NestJS 12 default; ESM-native; Testcontainers for real PostgreSQL/Valkey | Vitest 5 |
| Observability | OpenTelemetry JS SDK | **2.x** (2.9) | Stable traces/metrics; vendor-neutral; feeds the on-prem Grafana stack (ADR-0013) | — |
| Logging | pino | latest 9.x | Fastest structured logger; redaction built in | — |
| i18n (backend) | ICU MessageFormat via `intl-messageformat` behind our own `I18nService` | current | Same ICU format as `next-intl` on the frontend → **one shared catalog** `/locales/{en,ar}`; no dependency on a third-party Nest module lagging behind Nest 12 | — |
| Frontend | Next.js + React | **Next.js 16.3 LTS**, React 19 | Newest LTS line (Next 15 EOL 21 Oct 2026) | Next.js 17 after `.1` |
| Styling | Tailwind CSS | **4.3** | CSS-first config, Lightning CSS, logical properties for RTL | Tailwind 5 |
| Frontend i18n | next-intl | latest | ICU, App Router native, RTL `dir` handling | — |
| On-prem agent | .NET | **10 LTS** (EOL Nov 2028) | Long-lived agent at hotel sites needs LTS; .NET 11 (Nov 2026) is STS | .NET 12 LTS (Nov 2027) |
| Containers (dev) | `pgvector/pgvector:pg18`, `valkey/valkey:9`, `minio/minio`, `axllent/mailpit`, `grafana/otel-lgtm` | current | Matches production choices (ADR-0013) | with the rows above |

## Known risks and their mitigations
- **NestJS 12 ecosystem lag.** Official `@nestjs/*` packages (swagger, bullmq, schedule, config) are at 12 and ESM. Third-party modules may lag: `nestjs-cls` supports 12 (ESM/Vitest path is clean; the reported issue is Jest+CJS, which we do not use); we do **not** depend on `nestjs-i18n` (own ICU service). Any third-party Nest module we adopt must declare `@nestjs/core@^12` peer support; otherwise we wrap or write it.
- **TypeScript 7.0 has no compiler API.** Type-check with `tsgo`, emit with SWC. If a tool needs the TS API (e.g. an OpenAPI plugin), run it with a dev-only TypeScript 6.x install; never block the build on it.
- **Drizzle RC.** Restricted surface as above; CI pins the exact RC; final expected within Phase 0–1.
- **Valkey vs Redis naming.** Code and docs say "Valkey"; the client is `ioredis` (RESP), so the store is swappable.

## Consequences
- Phase 0 Sprint 0.1 is updated to this baseline (BUILD_PLAN §4).
- Renovate configuration (`renovate.json`) groups updates by the rows above and schedules them weekly; majors require this ADR to change.
- Developers need Node 26 (`.nvmrc`), pnpm 11 (via Corepack) and Docker; nothing else.
