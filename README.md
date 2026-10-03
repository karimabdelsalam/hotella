# Hotella

**Hotel Intelligence Platform** — a white-label, multi-tenant, AI-native operations and guest-experience platform for hotels and hotel groups. A Planova product.

| Document                                                               | Purpose                                                                                  |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`docs/spec/HOTELLA_MASTER_SPEC.md`](docs/spec/HOTELLA_MASTER_SPEC.md) | Architecture source of truth (v1.0)                                                      |
| [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md)                             | Phase-by-phase build plan, technology decisions, acceptance criteria, milestones         |
| [`docs/adr/`](docs/adr/README.md)                                      | Architecture Decision Records                                                            |
| [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md)                         | Every spec section mapped to the plan/ADR/phase that satisfies it                        |
| [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md)                   | **Start here if you are new**: setup, architecture map, conventions, how to add a module |
| [`docs/GLOSSARY.md`](docs/GLOSSARY.md)                                 | Hotel and platform vocabulary, English/Arabic                                            |
| [`CLAUDE.md`](CLAUDE.md)                                               | Non-negotiable rules for anyone (human or agent) changing this repository                |

## Status

Phase 0 (Repository & Engineering Foundation) — **Sprints 0.1 and 0.2 done**: workspace and tooling, lint/boundary rules, config, logging with request context, OpenTelemetry bootstrap, PostgreSQL access (Drizzle, UUIDv7, column helpers, data classes, migrations + drift check), secrets abstraction, S3 storage, Testcontainers harness, API skeleton with health/ready and Problem Details, dev compose, CI. Sprint 0.3 (events/outbox, queues, i18n, API conventions, module manifests) is next. See `docs/BUILD_PLAN.md` §4.

## Stack

TypeScript 6 · Node 24 LTS · NestJS 11 (modular monolith) · PostgreSQL 18 + pgvector · Valkey 9 + BullMQ · Drizzle ORM 0.45 · Zod 4 · pino + OpenTelemetry 2 · pnpm 10 + Turborepo · ESLint 10 + Prettier 3 + dependency-cruiser · Vitest 4 + Testcontainers · Next.js 16 LTS + next-intl + Tailwind 4 · .NET 10 LTS on-prem hotel agent (later phase). Version policy and HOLD list: [ADR-0016](docs/adr/0016-technology-currency-and-longevity.md).

## Getting started

See `docs/DEVELOPER_GUIDE.md` §2 — clone to green tests in under 30 minutes (Node 24, pnpm via Corepack, Docker).
