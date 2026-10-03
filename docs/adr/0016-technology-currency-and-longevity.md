# ADR-0016: Technology currency & longevity policy (stack baseline, October 2026)

**Status:** Accepted — 2026-10-03, **revised the same day** after a maturity review requested by the product owner ("newest technology, but nothing that is not yet available or not well supported; think like a professional engineering team").

## Context
The owner wants a modern stack, a codebase a new engineer can pick up, and a system that stays upgradable for years. The first draft of this ADR optimised for "newest" and selected several components that a professional team would not put under a foundation today (NestJS 12 at five weeks old and ESM-only, TypeScript 7.0 without a compiler API, Drizzle 1.0 release candidate, Node 26 three weeks before its LTS date, oxlint with plugin support in alpha). This revision replaces "newest" with a **Maturity Gate** and records, for each component, whether it is adopted now or held with a re-evaluation date. Versions were verified against primary sources on 2026-10-03.

## The Maturity Gate (a component enters the foundation only if all five hold)
1. **GA, not pre-release**, and at least **6 months** since the major's GA (or an LTS designation), with **≥ 2 patch releases** behind it.
2. **Ecosystem ready:** every library we depend on for that component declares support for that major (peer ranges, docs, CI).
3. **Tooling ready:** build, test, lint, IDE and debugger work with it on the supported path, not through workarounds.
4. **Exit path documented:** the next major has a published migration guide, or the component sits behind a platform interface so it can be replaced.
5. **No native compilation at install time** in the foundation (no `node-gyp` builds); native code only through prebuilt N-API binaries.

Components that fail the gate are **HOLD** items with a date; a quarterly currency review (one day) re-runs the gate. Majors are adopted only through a PR that updates this ADR. Patch/minor updates arrive via Renovate weekly and merge when CI is green.

## Baseline — ADOPT (verified 2026-10-03)

| Area | Choice | Why it passes the gate | Next step / trigger |
|---|---|---|---|
| Runtime | **Node.js 24 LTS** (Active LTS since Oct 2025, EOL Apr 2028) | A full year of LTS; every native-module ecosystem has 24 prebuilds | Node 26 → re-evaluate **Q1 2027** (LTS 28 Oct 2026 + prebuilt binaries for all our deps) |
| Language | **TypeScript 6.x** (6.0 GA 23 Mar 2026; the last JS-based compiler, full compiler API, deprecations aligned to 7) | Stable; `nest build`, swagger plugin, Vitest, IDEs all support it; writing 6-clean code makes the 7 move mechanical | TypeScript 7 → when **7.1 ships its compiler API** and NestJS CLI supports it; `tsgo --noEmit` may be used as an optional local speed-up only |
| Backend | **NestJS 11.x** (11.1.28, Jul 2026; actively patched) | Mature ecosystem (`nestjs-cls`, `@nestjs/swagger` 11, `@nestjs/bullmq`, `nestjs-zod` all GA for 11) | NestJS 12 → **after 12.3 or ≥ 6 months GA (≈ Mar 2027)** once the modules we use declare `^12` support; we write ESM-ready source now (see below) so the ESM switch is mechanical |
| Module format | **Source written ESM-style, compiled to CommonJS** (Nest 11's supported path): `import` only, `isolatedModules` + lint-enforced `consistent-type-imports` (`verbatimModuleSyntax` cannot emit CommonJS; it is switched on with the ESM move), no `require`, no `__dirname`, no CJS-only idioms | Zero workaround risk today; the Nest 12 upgrade flips `"type": "module"` + import extensions | With the NestJS 12 move |
| Validation | **Zod 4** (GA May 2025) + `nestjs-zod` (GA, supports Nest 11 and zod 4) for pipes and OpenAPI | Zod 4 is Standard-Schema compliant, so NestJS 12 will accept the same schemas natively and `nestjs-zod` is simply removed | With the NestJS 12 move |
| Database | **PostgreSQL 18** (GA Sep 2025, now 18.6) + **pgvector 0.8.x** | 13 months GA, six point releases, pgvector/pgBackRest/Testcontainers support | PostgreSQL 19 → ≥ 6 months after GA + pgvector support |
| Data access | **Drizzle ORM 0.45.x** (`@latest`, production line) | Stable, zero known CVEs, massive install base; 1.0 is still RC (rc.3) | Drizzle 1.0 → **final + 1 patch**; use the official 0.45→1.0 migration guide; until then we avoid the relational-query API (the part that changes) and use the core query builder |
| Cache / queue store | **Valkey 9.x** (BSD-3, Linux Foundation; 9.0 Oct 2025, 9.1 May 2026) | Wire-compatible with Redis 7 commands BullMQ uses; permissive licence for an on-prem product (Redis 8 is AGPL/SSPL/RSAL); default on major clouds | Valkey 10 → ≥ 6 months after GA |
| Job queue | **BullMQ 5.x** | Years of GA; documented Valkey support | BullMQ 6 → gate |
| Monorepo | **pnpm 10.x** (10.28, pinned via `packageManager`) + **Turborepo 2.x** | pnpm 10 is the mature line; Turborepo 2 since 2024. Corrected 2026-10-03: pnpm 11 reaches six months GA on 28 Oct 2026, so it was moved to HOLD | pnpm 11 → after 28 Oct 2026 (Renovate PR + this ADR); pnpm 12 (Rust port) → gate |
| Lint / format | **ESLint 10** flat config + **typescript-eslint 8** (type-aware, so `consistent-type-imports` respects NestJS decorator metadata) + core `no-restricted-imports` per layer + **Prettier 3** | The reference toolchain; `eslint-plugin-boundaries` was dropped during Sprint 0.1 because it depends on resolving pnpm symlinks, while core rules + package `exports` maps are deterministic | oxlint → when JS plugins are GA (currently alpha) and type-aware rules cover our set; oxfmt → 1.0 |
| Architecture check | **dependency-cruiser** (CI only: `no-circular` across packages + generated graph for docs) | Mature since 2017; complements ESLint boundaries with a repo-wide graph | — |
| Tests | **Vitest 4.x** (4.0 Oct 2025, 4.1 Mar 2026) + **Testcontainers** | A year GA; works with Nest 11 via SWC | Vitest 5 → gate |
| Observability | **OpenTelemetry JS SDK 2.x** (GA Mar 2025) + **pino 10** (10.0 GA Oct 2025) | Stable traces/metrics; Grafana stack on-prem | — |
| i18n (backend) | **ICU MessageFormat via `intl-messageformat`** (FormatJS, mature) behind our own `I18nService` | Same format as `next-intl` → one shared catalog; no third-party Nest module to lag behind majors | — |
| Password hashing | **`@node-rs/argon2` 2.x** (argon2id, prebuilt N-API binaries; 2.0 GA Oct 2024) | Satisfies gate rule 5; the classic `argon2` package needs node-gyp | — |
| Tokens (JWT) | **`jose` 6.x** (6.0 GA Feb 2025, zero dependencies, Web Crypto/`KeyObject`, EdDSA) | The reference JOSE implementation; no native code | jose 7 → gate |
| TOTP (MFA) | **RFC 6238 on `node:crypto`** (no library; RFC test vectors in CI) | ~60 lines, no dependency to track; HMAC-SHA1 per the RFC | WebAuthn adapter (ADR-0011) |
| Frontend | **Next.js 16 LTS** (16.3, Aug 2026; Next 15 EOL 21 Oct 2026) + **React 19** | Current LTS line of a framework with an explicit LTS policy | Next 17 → ≥ 6 months after GA |
| Styling | **Tailwind CSS 4.x** (4.0 Jan 2025) | Nearly two years GA; logical properties for RTL | Tailwind 5 → gate |
| Frontend i18n | **next-intl** (GA, App Router) | ICU; RTL `dir` handling | — |
| On-prem agent | **.NET 10 LTS** (Nov 2025, EOL Nov 2028) | LTS; .NET 11 is STS | .NET 12 LTS (Nov 2027) |
| Object storage | **SeaweedFS 4.48** (`chrislusf/seaweedfs`, Apache-2.0) | S3 gateway, mature since 2015, actively released; chosen after MinIO withdrew its community images (ADR-0013) | SeaweedFS 5 → gate |
| Dev containers | `pgvector/pgvector:pg18`, `valkey/valkey:9`, `chrislusf/seaweedfs:4.48`, `axllent/mailpit`, `grafana/otel-lgtm` | Mirrors production (ADR-0013) | with the rows above |

## HOLD list (attractive, not yet foundation-grade)

| Component | Why held | Re-evaluate |
|---|---|---|
| NestJS 12 | 5 weeks GA; ESM-only shift; third-party modules still adding `^12` peer support | Mar 2027 (or 12.3) |
| TypeScript 7.0 | No compiler API → `nest build`/plugins need a parallel TS 6 install | TS 7.1 compiler API |
| Node 26 | LTS only from 28 Oct 2026; native prebuilds lag a major by weeks | Q1 2027 |
| Drizzle 1.0 | Release candidate | Final + 1 patch |
| oxlint / oxfmt | JS plugins alpha; oxfmt 0.x | Plugins GA / oxfmt 1.0 |
| pnpm 11 | GA 28 Apr 2026: six months on 28 Oct 2026 | 28 Oct 2026 |
| pnpm 12 | Rust port not GA | GA + 6 months |
| Standard Schema in Nest decorators | Requires Nest 12 | with Nest 12 |

## What this costs us and what it buys
- We give up a few months of "latest" on the framework and language. In exchange every component has a mature ecosystem, documented upgrade paths and no workaround in the build, which is what a foundation that must live for years needs.
- The upgrades we are deferring (Nest 12/ESM, TS 7, Node 26, Drizzle 1.0) are all **planned**, dated and made mechanical by how we write code today (ESM-style source, TS 6-clean options, core query builder only).

## Consequences
- BUILD_PLAN Sprint 0.1–0.3, CLAUDE.md, README and the Developer Guide follow this baseline.
- `renovate.json` groups updates by the rows above; majors require this ADR to change.
- Developers need Node 24 (`.nvmrc`), pnpm 10 (Corepack reads `packageManager`) and Docker; no compiler toolchain for native modules.
