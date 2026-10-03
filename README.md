# Hotella

**Hotel Intelligence Platform** — a white-label, multi-tenant, AI-native operations and guest-experience platform for hotels and hotel groups. A Planova product.

| Document | Purpose |
|---|---|
| [`docs/spec/HOTELLA_MASTER_SPEC.md`](docs/spec/HOTELLA_MASTER_SPEC.md) | Architecture source of truth (v1.0) |
| [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md) | Phase-by-phase build plan, technology decisions, acceptance criteria, milestones |
| [`docs/adr/`](docs/adr/README.md) | Architecture Decision Records |
| [`CLAUDE.md`](CLAUDE.md) | Non-negotiable rules for anyone (human or agent) changing this repository |

## Status

Phase 0 (Repository & Engineering Foundation) — starting. See `docs/BUILD_PLAN.md` §4.

## Stack

TypeScript · NestJS (modular monolith) · PostgreSQL 16 + pgvector · Redis 7 + BullMQ · Drizzle ORM · Zod · pino + OpenTelemetry · pnpm + Turborepo · Vitest + Testcontainers · .NET 8 on-prem hotel agent (later phase).

## Getting started

Tooling arrives with Phase 0 Sprint 0.1. Until then this repository contains documentation only.
