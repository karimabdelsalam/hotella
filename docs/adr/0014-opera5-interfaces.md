# ADR-0014: OPERA 5 integration interfaces — FIAS primary, OWS secondary, optional read-only DB reconciliation

**Status:** Accepted — 2026-10-03 (product owner confirmed FIAS; additional interface recommended by engineering and approved).
**Amended by [ADR-0019](0019-unified-opera-integration-layer.md) (2026-10-04):** the read-only database is a first-class read connector (`OPERA5_DB`), not reconciliation-only; all three connectors sit behind the Unified OPERA Adapter and a per-property capability registry; the OPERA database is never written.

## Context
Spec §48–§54 and Phase 10 require an on-prem .NET hotel agent integrating OPERA 5.x without modifying OPERA. The product owner confirmed **FIAS** is the available interface and asked whether an additional interface should be added.

FIAS (Fidelio Interface Application Specification, via the OPERA IFC8 interface controller) is an event/record protocol over TCP designed for guest-facing systems (PBX, door locks, video, POS). It delivers the real-time events the platform needs most:

| FIAS record | Canonical event |
|---|---|
| `GI` Guest Check-In | `hotel.guest.checked_in.v1` |
| `GO` Guest Check-Out | `hotel.guest.checked_out.v1` |
| `GC` Guest Change / room move | `hotel.stay.room_changed.v1` (also `hotel.guest.profile_updated.v1` for name/language/VIP changes) |
| `RE` Room Equipment / room status | `hotel.room.status_changed.v1` |
| `DS`/`DR`/`DE` Database sync (start / record / end) | full in-house resync at link start and on demand |
| `LA`/`LD`/`LS` link alive / description / start | connector health |
| `PS`/`PA` Posting (outbound) | later: charge posting capability (`POST_CHARGE`) |
| `WR`/`WA`/`WC` Wake-up | later, voice phase |

FIAS limitations relevant to our scope: it only knows **in-house** (checked-in) guests; it carries **no future reservations**, no arrival ETA, no detailed profile or preferences, and a limited character set/field length. The spec's pre-arrival capabilities (§22), expected-stay grants (Phase 4) and arrival-risk intelligence (§17) therefore cannot be served by FIAS alone.

## Decision
1. **FIAS over IFC8 is the primary, real-time interface.** The agent implements the FIAS protocol as a connector adapter (`OPERA5_FIAS`) with link-alive handling, database-sync handshake, durable local queue and idempotent forwarding keyed on FIAS record + sequence/time + room/reservation number.
2. **OPERA Web Services (OWS, SOAP) is the secondary, query interface**, when licensed at the property. Used for: future reservations and arrivals lists (`FetchBookedReservations`/`Availability`/`Reservation` services), guest profile lookups (`Name` service), and reservation detail enrichment after a FIAS event. Enables pre-arrival activation, expected-stay grants, VIP flags and arrival ETA. Implemented as a separate adapter (`OPERA5_OWS`) advertising capabilities `RESERVATION_READ`, `GUEST_READ`; the instance's negotiated capabilities (Spec §47) decide whether pre-arrival features are offered.
3. **Optional read-only database access** (Oracle, read-only account, explicit views only), *only where the property's contract with Oracle/the hotel permits*, used exclusively for **reconciliation** (Spec §52: MATCH / MISSING_INTERNAL / MISSING_EXTERNAL / DIFFERENT), never as an event source and never written to. Adapter `OPERA5_DBVIEW`, capability `RECONCILIATION_READ`.
4. OXI (OPERA Xchange Interface) is **not** adopted now: it targets CRS/channel two-way synchronisation and typically requires additional licensing and configuration on the OPERA side; revisit only if a customer already runs it.
5. Room status / OOO writes toward OPERA (`ROOM_STATUS_WRITE`, `OOO_WRITE`) are **not** assumed. FIAS supports limited room-status updates from interfaces depending on IFC configuration; the capability is enabled per instance only after verification at the pilot property, and goes through the Integration Command path (Spec §53).
6. The core domains see only canonical events; the three adapters share one connector manifest family and one mapping/exception model. No core code references FIAS or OWS types.

## Consequences
- With FIAS only, M1 (in-house activation) is fully achievable; with OWS added, pre-arrival and arrival-risk features light up without core changes.
- The PMS simulator (Phase 2) must emulate both an event stream (FIAS-like) and a query API (OWS-like) so that capability negotiation is tested before Phase 10.
- Pilot preparation checklist: IFC8 interface license for a new "generic" interface, OWS license status, and whether a read-only DB account is contractually possible.
