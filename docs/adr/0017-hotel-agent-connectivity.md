# ADR-0017: Connectivity between the on-site Hotel Agent and the online Hotella platform

**Status:** Accepted — 2026-10-03 (answers the product owner's question "how does the system at the customer connect to our activation server online?")

## Context
Spec §48–§49, §53, §57 and §62: the platform runs online; a `.NET` Hotel Agent runs inside the hotel network next to OPERA 5; connectivity must be **outbound-first**, authenticated with a **signed identity**, durable (buffering/retries), with health reporting, offline licensing grace and controlled updates; **no generic remote shell**; cloud commands map only to predefined signed operations.

Two things live in two places:

| Where | What | Why there |
|---|---|---|
| **Hotel network (customer site)** | Hotel Agent only: FIAS/OWS adapters, local SQLite buffer, health, updater. Nothing else. | OPERA is only reachable from the LAN. |
| **Planova online servers** (ADR-0013: Planova-operated infrastructure, internet-reachable) | The whole Hotella platform: API, workers, database, Valkey, MinIO, guest activation, OTP, QR, WhatsApp webhooks, staff and guest web apps. | Guests' phones and WhatsApp/SMS providers must reach a public HTTPS endpoint; one deployment serves all hotels; updates happen once. |

Putting the core inside each hotel was rejected: every hotel would need a public endpoint, DNS and TLS for guests and webhooks; N sites to patch and back up; and the spec's multi-tenant/multi-property model (§1) assumes one platform. The hotel keeps only the thin agent.

## Decision

### 1. Direction: the agent always calls out, the platform never calls in
- The agent opens connections **from** the hotel **to** `agent.<platform-domain>` over **TCP 443 only** (HTTPS and WSS). No inbound port, no port-forwarding, no VPN. Works behind NAT and corporate proxies (explicit HTTP(S) proxy support with authentication).
- Hotel IT receives a one-page requirement: allow outbound 443 to two hostnames (`agent.…` for the link, `updates.…` for signed packages). Nothing else.

### 2. Identity: one-time enrollment, then mutual TLS
```text
Control plane: create Integration Instance (tenant, property, connector OPERA5_FIAS)
  -> issue ENROLLMENT TOKEN (single use, 24 h, bound to that instance)
Installer at the hotel: paste token
  -> agent generates a key pair locally (private key never leaves the machine; stored in the OS key store / DPAPI)
  -> sends CSR + token to the platform
  -> platform signs a DEVICE CERTIFICATE (Planova internal CA, 90-day validity, auto-renewed at 2/3 lifetime)
  -> all further traffic is mTLS: the certificate *is* the agent's identity (tenant_id, property_id, instance_id in SAN/claims)
```
- Revocation from the control plane is immediate (certificate revoked + connection dropped). Re-enrollment needs a new token.
- The platform's certificate chain is pinned in the agent to the Planova CA; TLS 1.3 only.

### 3. Transport: one persistent channel plus plain HTTPS for bulk
| Traffic | Mechanism | Notes |
|---|---|---|
| Real-time events hotel → platform (check-in, check-out, room move, room status) | **WebSocket (WSS)** persistent session with heartbeat every 30 s, exponential reconnect (1 s → 60 s, jitter) | Each frame = one envelope (Spec §51) with `sequence_no`; platform acks `(instance_id, sequence_no)` |
| Commands platform → hotel (e.g. room OOO write, resync request, config reload) | Same WSS session, server push | Only **predefined operation codes** from the connector manifest; payload schema-validated; idempotency key; agent acks with result |
| Large resyncs (FIAS database sync, OWS arrivals list) | **HTTPS POST** batches (gzip, ≤ 5 MB) | Same envelope and idempotency rules |
| Health / heartbeat | WSS heartbeat + HTTPS fallback every 60 s when the socket is down | Feeds `integration.integration_health` (Spec §57) |
| Signed packages / config | HTTPS GET from `updates.…` | See §6 |

Protocol framing is JSON today (debuggable by hotel IT with standard tools); the envelope is versioned so a binary framing can be introduced later without changing the domain.

### 4. Reliability: nothing is lost, nothing is applied twice
- **Local durable queue (SQLite, WAL mode)** at the hotel: every FIAS/OWS message is written before it is forwarded; rows are deleted only after the platform ack. Survives restarts, power loss and days offline (retention bounded by disk, default 30 days, oldest-first eviction with an alert).
- **Ordering**: per-instance monotonically increasing `sequence_no`; the platform processes in order and asks for a resend from the last contiguous ack after a reconnect.
- **Idempotency**: platform inbox keyed by `(instance_id, source_message_id)`; agent command inbox keyed by `(command_id)`. Replays are no-ops.
- **Back-pressure**: platform can tell the agent to slow down (`throttle` control frame); agent never drops data, it buffers.
- **Reconciliation** (Spec §52): scheduled comparison of in-house list (platform) vs OPERA (via FIAS DB-sync or OWS) to catch anything missed; differences become integration exceptions, never silent fixes.

### 5. Security controls (in addition to mTLS)
- Agent runs as a least-privilege Windows service account (or systemd unit on Linux) with access only to the FIAS TCP port / OWS endpoint and its own data folder.
- Every command frame is also **signed by the platform** (Ed25519) so a compromised TLS termination point cannot inject commands; the agent verifies against the pinned public key.
- Per-instance **rate limits** and schema validation on the platform side; malformed frames close the session and raise an alert.
- Secrets at the hotel (OPERA interface credentials, OWS credentials) are stored in the OS key store, never in config files; the platform never receives them.
- Full audit (Spec §68): every command carries `correlation_id`; the agent reports ack/result which lands in `audit.audit_log` with actor `INTEGRATION`.

### 6. Lifecycle: licensing, updates, offline behaviour
- **Signed license token** (Spec §62): issued by the platform (tenant, property, connector, capabilities, issue/expiry, offline grace = 14 days default); verified offline by the agent with the pinned public key; renewed automatically while connected. When the grace expires the agent keeps **buffering** FIAS events but stops executing commands until it reconnects.
- **Updates**: signed packages (Authenticode + our Ed25519 signature) downloaded over HTTPS, staged, health-checked, **automatic rollback** on failed start; rollout rings controlled from the control plane (canary hotel → all). No update ever changes OPERA.
- **Offline**: agent keeps running against OPERA; guests already activated keep working on the platform; new check-ins are activated as soon as the link is back (events are buffered, ordered and replayed).

### 7. Developer and test path
- The platform side of this link is the **Connector SDK transport** (`packages/contracts/connectors` + `packages/domain/integrations`), built in **Phase 2** and exercised by `apps/pms-simulator`, which speaks exactly this protocol over WSS/HTTPS from a container. Phase 10 only adds the real .NET agent on the other end.
- Contract tests pin the frame schemas; chaos tests cut the socket, duplicate frames, reorder frames and replay them.

## Alternatives considered
- **VPN / site-to-site tunnel**: heavy for hotel IT, per-site configuration, still needs an application protocol on top. Kept as an optional transport for hotels that mandate it; not default.
- **Platform polling the hotel / inbound ports**: violates outbound-first, exposes hotel networks.
- **Message broker (MQTT/AMQP) at the edge**: extra infrastructure at every hotel; WSS with our envelope gives the same guarantees with none of the footprint.
- **gRPC**: good fit technically; deferred because JSON frames are easier for hotel IT to inspect and the envelope is transport-agnostic; may be adopted later behind the same contract.

## Consequences
- Hotel onboarding = install MSI, paste enrollment token, allow outbound 443. No OPERA change, no firewall holes, no VPN.
- All guest-facing traffic (web, WhatsApp, OTP) terminates on the online platform only; the hotel network is never exposed.
- ADR-0013 "on-premises" is clarified: it means **Planova-operated servers reachable over the internet**, not servers inside hotels.

## Implementation notes (Phase 2, Sprint 2.3)
- **Where it runs.** `apps/agent-gateway` is its own process: a Nest *application context* (providers only, no HTTP routes) plus `AgentGatewayServer`, a `node:https` listener with TLS 1.3, `requestCert` and the agent CA as the only trust anchor for client certificates. It serves exactly `/agent/v1/enroll`, `/agent/v1/renew`, `/agent/v1/batches`, `/agent/v1/link` (WSS) and `/agent/v1/health`; staff routes are never reachable on this port. In the pilot it is published directly on 8443 (it terminates its own mutual TLS).
- **Identity.** Enrollment tokens are `hagt_` + 32 random bytes, stored as SHA-256, single use (compare-and-set), 24 h (`AGENT_ENROLLMENT_TTL_HOURS`). The agent sends a CSR for an ECDSA P-256 key it generated; the platform ignores the requested subject and issues `CN=instance:<id>` with SAN URIs `urn:hotella:instance|tenant|property:<id>` for 90 days (`AGENT_CERT_VALIDITY_DAYS`). P-256 instead of Ed25519 for TLS client certificates because .NET's TLS stack (Schannel/OpenSSL) supports it everywhere; Ed25519 remains the command-signature algorithm. The current certificate's SHA-256 fingerprint is the lookup key (`integration.agent_links`); renewal and re-enrollment replace it, revocation clears it, and an open session is closed within one command-poll interval (2 s).
- **Ordering.** Cumulative acks; the sequence advances only by compare-and-set; a gap answers `resend`; a repeat is re-acknowledged; `(instance, source_message_id)` stays the idempotency key underneath. If the agent's oldest buffered sequence is beyond what the platform expects (reinstall, evicted buffer), the platform accepts the jump and opens a `CONFLICT` integration exception (`sequence_gap`) so staff and reconciliation see it — never a silent loss. One instance is served by one gateway replica at a time; correctness does not depend on it.
- **Commands.** `INTEGRATIONS_API.requestCommand` validates the command against the connector manifest, the negotiated capability and the payload schema; delivery marks it `SENT` (re-queued after a reconnect), the agent verifies the Ed25519 signature over the canonical JSON before executing and answers `command_result`; expired commands become `EXPIRED`. Every transition is audited with actor `INTEGRATION`. First command: `SIM_PMS` `RESYNC_IN_HOUSE` (FIAS DS/DR/DE).
- **Capabilities.** `hello.capabilities` become the instance's reported capabilities; the effective set is enabled ∩ reported.
- **Reference agent.** `apps/pms-simulator` implements the agent side (durable file-backed queue, enrollment, reconnect with jitter, resend, signed-command verification, HTTPS batches) and is the executable specification for the .NET agent in Phase 10. It runs in CI twice: in-process (`apps/pms-simulator/test/link.e2e-spec.ts`, including duplicate/reorder/drop chaos, revocation and batches) and as a container against the deployed pilot stack (`infra/docker/pilot/smoke-agent.sh`).
- **Not yet built (Phase 10/11).** Throttle frames are sent at 200 frames/s per instance but the reference agent only logs them; license tokens, signed update packages and the CRL/OCSP-free revocation model are Phase 10/11 work.
