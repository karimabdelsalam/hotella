# ADR-0004: Transactional outbox/inbox and BullMQ (on Valkey) for async work

**Status:** Accepted — 2026-10-03

## Context
Spec §2.1 asks for asynchronous events for cross-domain workflows; §50 and §84.8 require outbox/inbox patterns, idempotency and dead-letter handling; §71 defines five queue priorities and demands guest real-time work never waits behind analytics; §84.17 forbids new infrastructure unless the existing stack cannot satisfy the requirement. Redis is already in the stack (§2.3).

## Decision
- **Outbox:** `platform.outbox` written in the same transaction as the business change. A relay in `apps/worker` publishes rows (`FOR UPDATE SKIP LOCKED`) to BullMQ and marks them published.
- **Inbox:** `platform.inbox (event_id, consumer, processed_at)`; every consumer is wrapped by `@Idempotent(consumer)` so duplicates are no-ops.
- **Store:** **Valkey 9** (BSD-3, RESP-compatible; chosen over Redis 8 for licence reasons in an on-prem product, see ADR-0016) accessed through `ioredis`. Wherever this repository says "Redis" in a generic sense it means the RESP store, i.e. Valkey.
- **Queues:** BullMQ on Valkey with queues `critical-operational`, `guest-realtime`, `normal`, `analytics`, `background-ai`, each with its own worker concurrency and isolation (separate worker processes may be deployed per queue). Retries with exponential backoff; failed jobs go to a per-queue DLQ with replay tooling.
- **Event envelope** per Spec §51 defined once in `@hotella/contracts-events`; payload schemas are zod; type+version registry; material changes bump the version.
- **In-process `DomainEventBus`** exists for same-transaction side effects *inside one bounded context* only. Anything crossing a context boundary goes through the outbox.
- Kafka/NATS are **not** introduced now. If throughput or multi-consumer fan-out later requires it, the relay is the single swap point.

## Consequences
- At-least-once delivery everywhere; all consumers must be idempotent (enforced by the decorator and tests).
- Slight publish latency (relay polling interval) is acceptable; guest-realtime jobs use a short interval and a dedicated worker.
