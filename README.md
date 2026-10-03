# Hotella

**Hotel Intelligence Platform** — a white-label, multi-tenant, AI-native operations and guest-experience platform for hotels and hotel groups. A Planova product.

| Document | Purpose |
|---|---|
| [`docs/spec/HOTELLA_MASTER_SPEC.md`](docs/spec/HOTELLA_MASTER_SPEC.md) | Architecture source of truth (v1.0) |
| [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md) | Phase-by-phase build plan, technology decisions, acceptance criteria, milestones |
| [`docs/adr/`](docs/adr/README.md) | Architecture Decision Records |
| [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md) | Every spec section mapped to the plan/ADR/phase that satisfies it |
| [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md) | **Start here if you are new**: setup, architecture map, conventions, how to add a module |
| [`docs/GLOSSARY.md`](docs/GLOSSARY.md) | Hotel and platform vocabulary, English/Arabic |
| [`CLAUDE.md`](CLAUDE.md) | Non-negotiable rules for anyone (human or agent) changing this repository |

## Status

Phase 0 (Repository & Engineering Foundation) — starting. See `docs/BUILD_PLAN.md` §4.

## Stack

Pure ESM TypeScript 7 · Node 26 · NestJS 12 (modular monolith) · PostgreSQL 18 + pgvector · Valkey 9 + BullMQ · Drizzle ORM 1.0 · Zod 4 · pino + OpenTelemetry 2 · pnpm 11 + Turborepo · oxlint + Prettier + dependency-cruiser · Vitest 4 + Testcontainers · Next.js 16 LTS + next-intl + Tailwind 4 · .NET 10 LTS on-prem hotel agent (later phase). Version policy: [ADR-0016](docs/adr/0016-technology-currency-and-longevity.md).

## Getting started

Tooling arrives with Phase 0 Sprint 0.1. Until then this repository contains documentation only.
