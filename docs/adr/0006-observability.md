# ADR-0006: pino + OpenTelemetry + CLS request context

**Status:** Accepted — 2026-10-03

## Context
Spec §70 requires logs, metrics, traces correlated by `correlation_id`, `trace_id`, `tenant_id`, `property_id`, with no sensitive data in logs. Spec §84.15: correlation IDs from the beginning. Spec §34/§41 need AI execution and cost telemetry later.

## Decision
- **pino** JSON logging with a redaction list (authorization headers, tokens, OTPs, phone numbers, emails where not needed, message bodies by default).
- **OpenTelemetry** Node SDK with auto-instrumentation for HTTP, pg, ioredis, BullMQ; OTLP exporter configured by environment; disabled in unit tests.
- **Request context** via `nestjs-cls` (AsyncLocalStorage): `correlation_id` (from `X-Correlation-Id` or generated), `trace_id`, `tenant_id`, `property_id`, `actor`. A pino mixin injects the context into every log line. The outbox publisher and queue jobs carry `correlation_id` so it is restored in consumers.
- Metrics: OTel metrics for HTTP latency, queue depth/lag, outbox lag, job failures; AI cost/token metrics added in Phase 6 through the same meter.

## Consequences
- Any flow (webhook → conversation → AI → tool → task → notification) is reconstructable from one correlation id.
- Developers must use the injected logger, never `console.log` (lint rule).
