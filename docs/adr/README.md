# Architecture Decision Records

ADRs record material technology choices and any deviation from `docs/spec/HOTELLA_MASTER_SPEC.md` (Spec §84.20).

Format: Context → Decision → Consequences. Status is one of `Proposed`, `Accepted`, `Superseded by ADR-xxxx`.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-monorepo-and-boundaries.md) | Monorepo (pnpm + Turborepo) and bounded-context boundary enforcement | Accepted |
| [0002](0002-drizzle-postgres-schemas-migrations.md) | Drizzle ORM, PostgreSQL schema per bounded context, SQL migrations | Accepted |
| [0003](0003-uuidv7-identifiers.md) | Application-generated UUIDv7 identifiers | Accepted |
| [0004](0004-outbox-inbox-bullmq.md) | Transactional outbox/inbox and BullMQ for async work | Accepted |
| [0005](0005-zod-contracts-openapi.md) | Zod as the single contract language, OpenAPI generated | Accepted |
| [0006](0006-observability.md) | pino + OpenTelemetry + CLS request context | Accepted |
| [0007](0007-multi-tenancy.md) | Shared database, `tenant_id` columns, RLS as defense-in-depth | Accepted |
| [0008](0008-testing-strategy.md) | Vitest + Testcontainers; integration tests against real infra | Accepted |
| [0009](0009-frontend-stack.md) | Frontend stack (Next.js + next-intl + Tailwind logical properties) | Accepted |
| [0010](0010-secrets-abstraction.md) | `SecretProvider` abstraction | Accepted |
| [0011](0011-auth-tokens.md) | Staff and guest token model | Accepted |
| [0012](0012-rest-api-conventions.md) | REST API conventions (versioning, Problem Details, idempotency, pagination) | Accepted |
| [0013](0013-hosting-on-prem.md) | Hosting target: on-premises deployment of the platform | Accepted |
| [0014](0014-opera5-interfaces.md) | OPERA 5 integration interfaces: FIAS primary, OWS secondary, optional read-only DB reconciliation | Accepted |
| [0015](0015-messaging-providers-otp-fallback.md) | WhatsApp providers (Meta Cloud API and BSP) and OTP fallback policy | Accepted |
| [0016](0016-technology-currency-and-longevity.md) | Technology currency & longevity policy — stack baseline Oct 2026 (supersedes version statements in 0001/0002/0004/0005/0008/0009/0013) | Accepted |
