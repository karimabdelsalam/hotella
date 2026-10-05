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
| [0014](0014-opera5-interfaces.md) | OPERA 5 integration interfaces: FIAS primary, OWS secondary, optional read-only DB reconciliation | Accepted; decision 3 superseded and 1, 2, 5 refined by 0019 |
| [0015](0015-messaging-providers-otp-fallback.md) | WhatsApp providers (Meta Cloud API and BSP) and OTP fallback policy | Accepted |
| [0016](0016-technology-currency-and-longevity.md) | Technology currency & longevity policy — Maturity Gate, ADOPT/HOLD baseline Oct 2026 (supersedes version statements in 0001/0002/0004/0005/0008/0009/0013) | Accepted (revised) |
| [0017](0017-hotel-agent-connectivity.md) | Hotel Agent ↔ online platform connectivity: outbound-only, enrollment + mTLS, WSS/HTTPS, durable ordered idempotent link, signed commands, offline licence, signed updates | Accepted |
| [0018](0018-ai-model-gateway-and-data-egress.md) | AI Model Gateway, provider adapters (OpenAI-compatible incl. on-prem, Anthropic, fake) and data egress policy; external providers and budget pending owner decision (Q8) | Accepted (engineering); Q8 open |
| [0019](0019-unified-opera-integration-layer.md) | Unified OPERA Integration Layer: read-only OPERA DB, IFC8/FIAS (Planova Standard Profile) and optional OWS connectors behind one capability-routed adapter; per-property capability registry; never write the OPERA DB | Accepted |
| [0020](0020-windows-installer-wix-v5.md) | Windows installer: MSI built with WiX v5 as a thin shell over `hotella-agent setup`; PowerShell secondary | Accepted |
| [0021](0021-offline-resilient-entitlements.md) | Offline-resilient entitlements: last-known-good facts, signed cached entitlement bundle for hotel-site installations, grace and revocation | Accepted |
| [0022](0022-five-locales.md) | Five user-facing languages: English, Arabic (RTL), Italian, Russian, German; parity across all locales | Accepted |
| [0023](0023-hotella-staff-mobile-app-flutter.md) | One staff mobile app "Hotella" in Flutter: sign-in per hotel, generated API client, shared catalog, push via the notification pipeline | Accepted |
| [0024](0024-phase-13-voice-telemetry-connectors.md) | Phase 13 on existing abstractions: vendor-neutral Planova Standard Profiles, Connector SDK v2 (link protocol 3, signed webhook ingress), voice as a channel with on-prem speech, telemetry in engineering, stay-bound locks and Wi-Fi under rule 19 | Accepted |
