# ADR-0021: Offline-resilient entitlements — licensing never stops a hotel

**Status:** Accepted — 2026-10-04 (product owner requirement: "a temporary Planova server outage or internet outage
must not suddenly stop hotel operations")

## Context
Phase 11 built a real entitlement system (plans, immutable versions, subscriptions, grants, limits, usage, an
`EntitlementEngine` behind the action gate, a signed offline licence for the hotel agent). The owner requires that
licensing be designed for real hotel operations. Three situations matter:

1. **The hotel's internet link is down.** With central hosting (ADR-0013) staff and guest apps cannot reach the
   platform at all — that is connectivity, not licensing — while OPERA keeps running and the hotel agent keeps
   buffering PMS events under its signed licence with grace (ADR-0017, 10.4). Mitigation is network: a second WAN or
   LTE failover at the hotel (pilot readiness checklist).
2. **The licensing store of a central installation cannot be read** (a database fault, a failed deploy). The gate
   must not turn a licensing fault into an outage.
3. **A hotel-site installation** (ADR-0013 variant: the platform runs on a server inside the hotel) is cut off from
   Planova's central control plane. It must keep running on what it was last allowed.

## Decision
- **Licence ≠ boolean.** Entitlement is the computed set of capabilities and limits of a tenant at a property, from
  plan versions, subscriptions (with status and grace), grants and overrides — unchanged from Phase 11.
- **Last-known-good (all installations):** the `EntitlementEngine` keeps, per tenant, the last facts it read
  successfully. If reading fails, it answers from them for `LICENSING_STALE_GRACE_HOURS` (default 72 h) and logs a
  warning once per tenant; only past that does a failure refuse, and SYSTEM/INTEGRATION work is never gated (11.B).
- **Signed entitlement bundle (site installations):** the central control plane issues, per installation, a bundle
  `hotella.entitlements.v1` — installation id, tenant, per-property capability codes, limits, subscription statuses,
  `issued_at`, `valid_until` (the renewal horizon, default 7 days) and `grace_until` (`valid_until` + the contract's
  offline grace, default 30 days) — signed with the platform's Ed25519 licence key (the key that signs agent licences).
  A site in `LICENSING_MODE=site` verifies the bundle offline against the pinned public key, caches it, renews it over
  outbound HTTPS every few hours, and computes entitlements from it. Between `valid_until` and `grace_until` everything
  keeps working and administrators see a warning; past `grace_until` people's actions are refused with
  `license.offline_expired` while SYSTEM/INTEGRATION work (PMS truth, checkout revocations, timers) continues.
- **Installation identity:** each site installation is registered in the control plane (`license.installations`:
  tenant, name, public key, status, last seen) and fetches its bundle with a signed request; the control plane records
  every issue and renewal (audit).
- **Revocation:** suspending a subscription or revoking a grant takes effect centrally at once, and on a site at its
  next renewal; an installation can be revoked (no further bundles). A site that never comes back online keeps its
  last bundle until `grace_until` — the price of offline resilience, bounded by contract.
- **Clock:** a site refuses a bundle issued in its future beyond a small skew, and remembers the latest `issued_at`
  it accepted, so rolling the clock back cannot resurrect an older, broader bundle.

## Consequences
- BUILD_PLAN Sprint 11.7 implements the last-known-good cache, the bundle contract, issuance and renewal, site-mode
  verification and the refusal past grace. Central installations change only by the cache.
- The pilot runs centrally; site mode is ready for hotels that require an on-site platform.
