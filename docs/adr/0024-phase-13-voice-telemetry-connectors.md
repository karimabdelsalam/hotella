# ADR-0024: Phase 13 — voice, building telemetry and more connectors on the existing abstractions

**Status:** Accepted — 2026-10-05 (engineering; vendor choices remain owner decisions Q21–Q26 in `docs/BUILD_PLAN.md`)

## Context
Spec §44 (future channels), §45–§47 (integration platform, capabilities), §56 (Connector SDK) and Phase 13 ask for a
voice channel, an IoT/BMS telemetry path and POS/ERP/Wi-Fi/door-lock connectors **without redesigning the core**. What
exists (Phase 2–12): a typed connector manifest and pure `ConnectorAdapter` parsers, an ingest → map → canonical event
pipeline, per-property capability routing (`PMS_API`), signed commands and queries over the outbound-only hotel-agent
link (ADR-0017), channel adapters behind the Conversation Engine (rule 18), the Model Gateway with an `AUDIO`
capability and egress policy (ADR-0018), meters and work orders in engineering, alerts and room signals. Capabilities
for POS, ERP, PBX and Wi-Fi are already reserved; locks, BMS points and telemetry are not. The .NET agent selects its
adapter by hard-coded connector code and runs one connector per service. No vendor has been chosen.

## Decision
1. **Vendor-neutral first.** Each new kind of system gets a *Planova Standard Profile* (a documented message and
   command set, like the FIAS profile of ADR-0019), a neutral connector, a simulator face and contract-test vectors.
   Vendor adapters (a given PBX, lock or BMS) are later connectors implementing the same profile — no core change.
2. **Connector SDK v2.** The manifest gains an optional health hook and new record kinds; the .NET agent gets one
   `IConnectorAdapter` interface (message pump, commands, queries, health) and a registry instead of hard-coded codes;
   one agent service may host several connectors (link protocol 3: `hello` lists connectors, frames carry
   `connector_code`; protocol 2 agents keep working). Cloud-hosted vendor systems reach the platform through a signed
   webhook ingress per integration instance (HMAC over the raw body, replay window), never through core modules.
3. **Voice is a channel, not a module (rule 18).** A `VOICE` channel adapter (call events from a PBX/voice gateway)
   feeds the Conversation Engine; speech-to-text and text-to-speech are Model Gateway `AUDIO` calls under the egress
   policy — **on-prem by default**, audio never stored unless a property enables recording (owner decision Q23). The
   concierge answers voice turns with the same tools; hand-off is a call transfer command to an extension.
   `VOICE_MINUTES` are metered.
4. **Telemetry is owned by engineering** (assets, meters and work orders already live there): schema `eng` gains
   telemetry points (mapped to assets/locations through integration mappings — an unknown point is an
   `integration_exception`, rule 16) and a minute-downsampled, monthly-partitioned reading table. Rules are
   deterministic (threshold with hysteresis, rate of change, stuck value, missing data) and emit meaningful events
   (`eng.telemetry.alarm_raised/cleared.v1`); alerts, work orders, room signals and insights react to those events.
   Raw high-frequency samples are not kept beyond the downsampled minute.
5. **Stay-bound access (locks, Wi-Fi) follows rule 19:** the platform requests a key or a Wi-Fi session only for a
   checked-in stay through the capability-routed integration API, records it, and revokes it automatically on PMS
   check-out; door-lock commands are HIGH risk for AI (approval) and need a staff permission; no lock or Wi-Fi secret
   is stored (SecretRefs only; a mobile key is delivered by the vendor, not by us).
6. **POS and ERP are read-mostly in v1:** POS closed checks (spend per stay, no card data — PCI stays with the POS)
   become canonical events the twin and insights can use; ERP stock reads and requisitions from work-order parts go
   through engineering's existing parts flow.

## Consequences
- No new bounded context or schema: voice in `comms`, telemetry in `eng`, access and connector plumbing in
  `integration`. CLAUDE.md's schema list is unchanged.
- Each vendor integration is a connector + profile mapping + simulator vectors; the owner chooses vendors (Q21–Q26).
- Link protocol 3 is additive; the platform keeps accepting protocol 1 and 2 agents.
- Audio, door access and spend are privacy- and security-sensitive: data classes SENSITIVE (audio, transcripts quoting
  guests), RESTRICTED for key material (never stored), CONFIDENTIAL for spend; retention per class (rule 21).
