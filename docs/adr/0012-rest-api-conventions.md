# ADR-0012: REST API conventions

**Status:** Accepted — 2026-10-03

## Context
Spec §2.1 (REST with versioning, OpenAPI), §74 (versioned external APIs, idempotency keys, signed webhooks with retry/DLQ/replay, rate limiting), §79 (localized messages).

## Decision
- Base path `/api/v1`; breaking changes create `/api/v2` for the affected resources only.
- Errors use RFC 9457 Problem Details: `{ type, title, status, detail, instance, code, params, correlation_id }`. `code` is stable and machine-readable (e.g. `guest.activation.token_expired`); `detail` is localized via the i18n layer from `errors.json`.
- Retriable create operations accept `Idempotency-Key`; replays return the stored response with `Idempotent-Replayed: true`; key scope is `(actor, route, key)`, TTL 24h in Redis.
- Pagination is cursor-based (`?cursor=&limit=`), responses `{ data, next_cursor }`.
- Rate limiting in Redis by IP, guest session, user, tenant, API client and endpoint class; limits are configuration, not code constants.
- Outbound webhooks (later phases) are HMAC-signed with timestamp, retried with exponential backoff, dead-lettered and replayable.
- Public guest endpoints live under `/api/v1/guest/*` and `/api/v1/public/*`; staff endpoints are property-scoped by explicit `property_id` parameters.

## Consequences
- Clients (web, mobile, connectors) share one error model and one pagination model.
- OpenAPI is generated from zod schemas (ADR-0005) and snapshot-tested in CI.
