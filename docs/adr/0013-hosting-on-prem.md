# ADR-0013: Hosting target — on-premises deployment of the platform

**Status:** Accepted — 2026-10-03 (product owner decision)

## Context
The Master Spec describes the platform as a "cloud platform" that hotel agents reach over outbound connections (§48), but does not fix a hosting provider. The product owner decided the platform is hosted **on-premises** (Planova-controlled or customer-controlled data centre), not on a public cloud. This answers open question Q6 and, implicitly, Q7 (data residency: data stays in the hosting country). It affects the secrets adapter (ADR-0010), object storage, the observability backend, backups (§72) and the deployment model (§71).

## Clarification (ADR-0017)
"On-premises" here means **Planova-operated servers reachable over the internet** (Planova's own data centre / colocation, not a public-cloud provider). It does **not** mean servers inside hotels: a hotel hosts only the thin Hotel Agent, which connects outbound to this platform (ADR-0017). Guests, WhatsApp/SMS providers and staff reach the platform over the public internet.

## Decision
- **Runtime:** containers. Pilot/single-site: Docker Compose on a hardened Linux host. Production/multi-tenant: Kubernetes (k3s or RKE2 — lightweight, on-prem friendly) with Helm charts kept in `infra/k8s`. The six logical deployables from Spec §71 (`platform-api`, `platform-worker`, `platform-scheduler`, `realtime-gateway`, `integration-worker`, `ai-worker`) map to separate deployments; workers are split by BullMQ queue so guest-realtime never shares a pool with analytics/background-AI.
- **Database:** self-managed PostgreSQL 18 with pgvector. Backups and point-in-time recovery with **pgBackRest** to the local object store, streaming replica where justified, quarterly restore drills. RPO ≤ 15 min, RTO ≤ 2 h for the pilot; tightened per contract later. *Pilot reality (Sprint 1.4):* the first repository is a dedicated volume with an off-site copy after each full backup (runbook); the encrypted second repository on the S3-compatible store is the next step. The application connects as an ordinary role (`hotella_app`) so row-level security applies; migrations run as the admin role.
- **Object storage:** **SeaweedFS 4.x** (Apache-2.0, S3 gateway). *Revised 2026-10-03:* MinIO was the first choice, but MinIO archived its community edition (April 2026) and withdrew `minio/minio` from Docker Hub (11–14 Sept 2026) and quay.io (24 Sept 2026); the last free release carries an unpatched authentication-bypass CVE. The platform talks only to the S3 API, so the swap touched compose, the test harness and this ADR — no application code.
- **Cache/queue store:** **Valkey 9** (ADR-0016), single node for the pilot, Valkey cluster or Sentinel-style HA when a second tenant is onboarded.
- **Secrets:** a self-hosted **Vault-API secret store** as the production `SecretProvider` adapter (KV v2; AppRole for workloads, Kubernetes auth on k3s); dev/test keep `EnvSecretProvider`. *Revised 2026-10-03 (Sprint 1.4):* the default is **OpenBao** (Linux Foundation, MPL-2.0, 2.x GA since July 2024), because HashiCorp Vault has been under the Business Source License since August 2023 and this ADR requires every infrastructure dependency to be open source. The adapter (`VaultKvSecretProvider`, `vault://` refs) speaks the API both implement, so choosing HashiCorp Vault instead is configuration only — a licensing decision for the product owner, not a code change.
- **Observability backend:** self-hosted Grafana stack — Prometheus (metrics), Loki (logs), Tempo (traces) — fed by the OpenTelemetry collector. No vendor SaaS dependency.
- **Ingress/TLS:** Traefik or NGINX ingress with cert-manager; internal CA or public certificates depending on exposure. The hotel agent still connects **outbound** to the platform (Spec §48); the platform never initiates connections into hotel networks.
- **Hotel-site deployment variant:** because hosting is on-prem, a *single-property* deployment may run the platform and the hotel agent on the same site network. The architecture does not change: the agent still speaks only the signed connector operations over HTTPS/WSS; no shortcuts (e.g. the API reading OPERA's database directly) are allowed.
- **Egress to AI providers:** the AI worker is the only component permitted outbound access to model providers; egress is allow-listed per provider at the network layer and respects the data-classification/redaction policy (Spec §42, §67). Local/self-hosted models remain possible behind the Model Gateway.
- **Images:** built in CI (GitHub Actions), pushed to a private registry reachable from the on-prem cluster.

## Consequences
- Operations responsibility (patching, backups, capacity) sits with Planova/customer rather than a cloud provider; runbooks are part of the deliverable from the first staging deployment (end of Phase 1).
- All infrastructure dependencies chosen are open source and self-hostable; nothing in the codebase assumes a cloud-provider managed service.
- Multi-region / data-residency becomes a deployment topology question (one on-prem installation per region), not a code question.
