# ADR-0013: Hosting target — on-premises deployment of the platform

**Status:** Accepted — 2026-10-03 (product owner decision)

## Context
The Master Spec describes the platform as a "cloud platform" that hotel agents reach over outbound connections (§48), but does not fix a hosting provider. The product owner decided the platform is hosted **on-premises** (Planova-controlled or customer-controlled data centre), not on a public cloud. This answers open question Q6 and, implicitly, Q7 (data residency: data stays in the hosting country). It affects the secrets adapter (ADR-0010), object storage, the observability backend, backups (§72) and the deployment model (§71).

## Decision
- **Runtime:** containers. Pilot/single-site: Docker Compose on a hardened Linux host. Production/multi-tenant: Kubernetes (k3s or RKE2 — lightweight, on-prem friendly) with Helm charts kept in `infra/k8s`. The six logical deployables from Spec §71 (`platform-api`, `platform-worker`, `platform-scheduler`, `realtime-gateway`, `integration-worker`, `ai-worker`) map to separate deployments; workers are split by BullMQ queue so guest-realtime never shares a pool with analytics/background-AI.
- **Database:** self-managed PostgreSQL 18 with pgvector. Backups and point-in-time recovery with **pgBackRest** to the local object store, streaming replica where justified, quarterly restore drills. RPO ≤ 15 min, RTO ≤ 2 h for the pilot; tightened per contract later.
- **Object storage:** **MinIO** (S3-compatible) — the storage abstraction already targets S3 so no code change.
- **Cache/queue store:** **Valkey 9** (ADR-0016), single node for the pilot, Valkey cluster or Sentinel-style HA when a second tenant is onboarded.
- **Secrets:** **HashiCorp Vault** (self-hosted) as the production `SecretProvider` adapter; Kubernetes auth or AppRole for workloads. Dev/test keep `EnvSecretProvider`.
- **Observability backend:** self-hosted Grafana stack — Prometheus (metrics), Loki (logs), Tempo (traces) — fed by the OpenTelemetry collector. No vendor SaaS dependency.
- **Ingress/TLS:** Traefik or NGINX ingress with cert-manager; internal CA or public certificates depending on exposure. The hotel agent still connects **outbound** to the platform (Spec §48); the platform never initiates connections into hotel networks.
- **Hotel-site deployment variant:** because hosting is on-prem, a *single-property* deployment may run the platform and the hotel agent on the same site network. The architecture does not change: the agent still speaks only the signed connector operations over HTTPS/WSS; no shortcuts (e.g. the API reading OPERA's database directly) are allowed.
- **Egress to AI providers:** the AI worker is the only component permitted outbound access to model providers; egress is allow-listed per provider at the network layer and respects the data-classification/redaction policy (Spec §42, §67). Local/self-hosted models remain possible behind the Model Gateway.
- **Images:** built in CI (GitHub Actions), pushed to a private registry reachable from the on-prem cluster.

## Consequences
- Operations responsibility (patching, backups, capacity) sits with Planova/customer rather than a cloud provider; runbooks are part of the deliverable from the first staging deployment (end of Phase 1).
- All infrastructure dependencies chosen are open source and self-hostable; nothing in the codebase assumes a cloud-provider managed service.
- Multi-region / data-residency becomes a deployment topology question (one on-prem installation per region), not a code question.
