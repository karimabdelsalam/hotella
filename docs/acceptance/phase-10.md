# Phase 10 acceptance — Real OPERA 5 on-premise integration (M4a)

**Date:** 2026-10-04 · **Branch:** `claude/hopeful-archimedes-jskowx` · **CI:** GitHub Actions workflow `CI` run 37176477045 on `3f608da` — "lint · typecheck · build · test" and "pilot deployment smoke" green. Agent evidence from that run: `Passed! - Failed: 0, Passed: 49` (Hotella.Agent.Tests) · `agent update smoke: OK` · `✓ test/dotnet-agent.e2e-spec.ts (9 tests)` · `✓ test/opera5-fias.e2e-spec.ts (4 tests)` · `✓ test/opera5-ows.e2e-spec.ts (3 tests)` · `✓ test/link.e2e-spec.ts (8 tests)`

Goal (Spec §48–§54, §57, §62; ADR-0013, ADR-0014, ADR-0017; BUILD_PLAN §10 Phase 10): a hotel installs one agent,
gives it an enrollment token and allows outbound 443; from then on OPERA 5's FIAS records reach the platform as
canonical events in order, exactly once, through link failures and days offline; OWS adds future reservations and ETA
where licensed; reconciliation finds what was missed; the platform can only send predefined signed commands; the agent
runs under a signed licence with an offline grace and updates itself from signed packages with rollback. Proven end to
end against the simulator's byte-level IFC8 and OWS faces; the pilot swaps the simulator for the hotel's OPERA.
✅ verified by automation · 🟡 needs a human or the pilot hotel.

| # | Criterion (BUILD_PLAN 10.A–10.C) | Status | Evidence |
|---|---|---|---|
| 1 | One .NET 10 agent: Windows service or systemd unit, self-contained (no .NET at the hotel), analyzers as errors | ✅ | `apps/hotel-agent` (`Hotella.Agent.slnx`, 49 xUnit tests); CI publishes linux-x64 and win-x64 (`packaging/publish.sh`); `packaging/linux/hotella-agent.service`, `packaging/windows/install.ps1`. |
| 2 | Enrollment with a single-use token; key and CSR made on the hotel machine; the key is protected by the OS; token never on the command line | ✅ | `dotnet-agent.e2e-spec.ts` ("enrolls once…", "the hotella-agent service: enroll from a token file…"); `IdentityTests`; `IdentityStore` (DPAPI / 0600). |
| 3 | Outbound-only mutual TLS link, same protocol as the reference agent (shared vectors pin canonical bytes and signatures) | ✅ | `vector.spec.ts` + `CanonicalJsonTests`; `dotnet-agent.e2e-spec.ts` runs the reference scenario with duplicate/reorder/drop chaos through the .NET link — sequences 1…n, exactly once. |
| 4 | Durable ordered queue; nothing lost while the platform is unreachable; HTTPS batches for large resyncs | ✅ | `DurableOutboxTests` (restart, acks, eviction only past retention); e2e "uploads HTTPS batches…", platform-link drop in `opera5-fias.e2e-spec.ts`. |
| 5 | OPERA5_FIAS: IFC8 link (LS/LD/LR/LA, link-alive, LE), records forwarded verbatim, IFC8 repeats are no-ops, in order through an IFC8 drop | ✅ | `FiasTests` (framing, handshake, commands, reconnect); `opera5-fias.e2e-spec.ts` ("links to IFC8…", "a stay arrives in order through an IFC8 drop and a platform link drop, exactly once"); platform `OPERA5_FIAS` adapter tests in `domain.spec.ts`. |
| 6 | Reconciliation through a signed RESYNC_IN_HOUSE (FIAS database sync) | ✅ | `opera5-fias.e2e-spec.ts` ("reconciliation asks IFC8 for a database sync…": DR → DS / GI SF / DE → snapshot → MATCH). |
| 7 | OPERA5_OWS: future reservations with ETA and sharers, only changes forwarded, OWS password in the protected store | ✅ | `OwsTests`; `opera5-ows.e2e-spec.ts` (expected stays, repeated polls forward nothing, change and cancellation once, password from stdin never shown). |
| 8 | Only predefined signed commands; no shell; room-status writes gated per hotel and carrying occupancy | ✅ | Manifests `OPERA5_FIAS` / `OPERA5_OWS` (`domain.spec.ts`); unknown command refused (`link.e2e-spec.ts`); `opera5-fias.e2e-spec.ts` ("writes a room status… only as a predefined signed command"); `ROOM_STATUS_WRITE` left out of the sample agent capabilities until verified. |
| 9 | Signed licence verified offline with a grace; past it commands stop, buffering continues | ✅ | `LicenceAndHealthTests`; `link.e2e-spec.ts` (reference agent verifies it); `dotnet-agent.e2e-spec.ts` ("offline past its licence grace it refuses commands; a fresh licence lifts that"). |
| 10 | Health states with reasons for support | ✅ | `LicenceAndHealthTests` (classification table); `health.json`, `hotella-agent status`. |
| 11 | Signed self-update with probation and rollback | ✅ | `UpdaterTests` (forged/tampered/corrupt refused, failing starts and unhealthy probation roll back and block); CI `packaging/smoke-update.sh` with the real binaries (0.10.1 → 0.10.2 → rollback; foreign key refused). |
| 12 | Core contexts untouched by the PMS swap: they see only canonical events | ✅ | No domain change beyond `SET_ROOM_STATUS` carrying occupancy; the same projector tests pass for `SIM_PMS`, `OPERA5_FIAS` and `OPERA5_OWS` instances. |
| 13 | Tenant isolation | ✅ | Instances, messages, commands and licences are per tenant and instance (RLS on `integration`); a licence or command for another instance is refused by the agent (`LicenceAndHealthTests`, signature + instance check). |
| 14 | Works with the hotel's real OPERA | 🟡 | Pilot: IFC8 interface sheet (direction, port, character set, LR fields, link-alive timing), OWS WSDL version and entity codes, then a week of live traffic with reconciliation. |

## Deviations recorded during Phase 10
- `OPERA5_DBVIEW` (optional) deferred: it needs Oracle's driver and a read-only account whose contractual possibility
  is an open owner prerequisite; reconciliation works through FIAS database sync — 10.3 notes.
- One agent service per integration instance; a hotel with FIAS and OWS runs two services — 10.3 notes.
- The MSI is not built: WiX v6 requires a paid maintenance fee for commercial users (owner decision); Windows hotels
  install with `install.ps1` — 10.4 notes.
- A candidate update that crashes before reading its update state cannot roll itself back (the 3-start rule covers
  later crashes); a separate launcher is the follow-up if the pilot needs it — 10.4 notes.
- Fixed on the way (found by the cross-language tests): resend undone by a send pass in flight, the link stopping
  silently on an unexpected exception, a renewed certificate not used, the simulator writing to a dropping socket.
- Found while collecting this evidence: CI had skipped the .NET cross-language suites (Turborepo dropped
  `TEST_DOTNET_AGENT`) and had never built the agent host (`dotnet test` builds test projects only); both fixed, and
  on CI those suites now fail instead of skipping. The pilot smoke also showed that a pre-assignment recorded after
  a check-in could stay in the room history out of order — the guest projector now gives the same history in any
  delivery order (commit `fix(guest)`).

## Open items carried forward
- 🟡 Owner decisions: MSI toolset (WiX v6 fee or another installer); contractual possibility of a read-only OPERA DB
  account (DBVIEW).
- 🟡 Pilot prerequisites: IFC8 licence for a new generic interface and its interface sheet; OWS licence status and
  credentials (set on the agent with `hotella-agent secret set ows.password`); outbound 443 to the agent gateway.
- 🟡 Planova release pipeline: the update signing key in OpenBao and a `stable` manifest at the updates host.
- Phase 11 issues the licence from entitlements and adds the control plane.
- Carried from earlier phases: see `docs/acceptance/phase-9.md`.
