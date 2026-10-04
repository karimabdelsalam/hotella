# ADR-0019: Unified OPERA Integration Layer — three read/write-separated connectors behind one capability-routed adapter

**Status:** Accepted — 2026-10-04 (product owner decisions of 2026-10-04; supersedes ADR-0014 decision 3 and refines
decisions 1, 2 and 5)

## Context
ADR-0014 made FIAS (via IFC8) primary, OWS secondary and a read-only database view *optional and reconciliation-only*.
Phase 10 built the hotel agent with `OPERA5_FIAS` and `OPERA5_OWS` connectors. On 2026-10-04 the product owner
decided:

1. **Direct read-only access to the OPERA database is an officially supported integration method** — through a
   dedicated Oracle account holding only `SELECT` privileges; never `INSERT`/`UPDATE`/`DELETE`, DDL, procedure
   execution or any other write. It is used primarily for reliable, efficient retrieval of OPERA data.
2. **Every write to OPERA goes through an officially supported interface** (IFC8/FIAS or OWS, by operation and by what
   the hotel has). The database is never written.
3. The integration is a **product standard**, not one hotel's setup: a *Planova Standard OPERA IFC8/FIAS Profile*, a
   *standard OWS connector* with per-hotel settings, and an *OPERA DB read-only data contract*; a new hotel's IFC8
   Interface Sheet and OWS setup are **compared against the standard**, never the other way round.
4. OWS is an **optional enhanced capability** (some hotels are licensed, others not).
5. Application modules never talk to OPERA-specific code: a **Unified OPERA Adapter** routes each business operation to
   the best available connector, using a **per-property capability registry** — so hotels with *DB + IFC8*,
   *DB + IFC8 + OWS* or *IFC8 + OWS* all run the same core without hotel-specific code.

## Decision

### 1. Three connectors, separated by purpose
| Connector | Code | Direction | Used for | Never used for |
|---|---|---|---|---|
| A — OPERA DB Read-Only | `OPERA5_DB` | read | reservations, arrivals/departures, in-house list, profiles, room inventory, reconciliation snapshots; change detection where no event source covers a fact | any write; real-time event delivery when IFC8 covers it |
| B — IFC8 / FIAS | `OPERA5_FIAS` | events in, limited writes out | real-time check-in/out, room move, guest change, room status; database swap; room-status write-back (`RE`) | future reservations (FIAS has none) |
| C — OWS | `OPERA5_OWS` | read and write | structured operations where licensed: profile read/update, reservation read and supported modifications, future bookings | anything when not licensed |

Each connector is a separate integration instance of the property (its own agent identity, data directory and health)
— one agent service per instance (ADR-0017). The platform groups a property's OPERA instances into one **OPERA
integration profile**.

### 2. Unified OPERA Adapter (platform side)
A new application service in the integration context, exposed to other contexts as **`PMS_API`** (vendor-neutral
name; OPERA is its first implementation, rule 19). It offers *business operations* — `lookupReservation`,
`listArrivals`, `inHouseSnapshot`, `lookupProfile`, `setRoomStatus`, `setRoomRestriction`, `updateProfileContact`, … —
and resolves each to a connector by an **operation routing table** (preference order per operation, filtered by the
property's capability registry and live health). Modules ask `PMS_API.can(property, operation)` before offering an
action (Spec §47: never offer what the hotel cannot do). Core contexts keep receiving only canonical events; reads are
answered as canonical records; writes go out as signed Integration Commands (Spec §53).

Default routing preference (configurable per property, deterministic):
- **Real-time events:** IFC8/FIAS → (OWS polling) → (DB change polling) — fallbacks are explicitly *degraded*.
- **Reads / lookups / snapshots:** DB read-only → OWS → FIAS database swap (in-house only).
- **Writes:** room status / room restriction → IFC8 `RE` where verified, else OWS where supported; profile /
  reservation changes → OWS only. **Never the database.**

### 3. Per-property capability registry
The registry records, per property and per **business capability** (not per "connected" flag): which connector can
serve it, whether the hotel enabled it, whether it was **verified at commissioning**, and its live status from health
(AVAILABLE / DEGRADED / UNAVAILABLE). Capabilities extend the existing vocabulary (`RESERVATION_READ`, `GUEST_READ`,
`CHECKIN_EVENT`, …) with lookup and write capabilities (`RESERVATION_LOOKUP`, `PROFILE_LOOKUP`, `ARRIVALS_READ`,
`IN_HOUSE_SNAPSHOT`, `PROFILE_WRITE`, `RESERVATION_WRITE`, …) and connector-level facts (`DB_READ`, `IFC8_LINK`,
`OWS_API`). Effective capability = connector manifest ∩ instance enabled ∩ agent reported ∩ commissioning verified ∩
healthy — computed deterministically (rule 11).

### 4. Agent link: request/response queries
DB and OWS lookups need answers, not just acknowledgements. Link protocol **2** adds a signed `query` frame
(predefined query type + parameters, like commands — no free SQL, no remote shell) and a `query_result` frame
(rows in the connector's canonical shape, paginated, size-capped). Protocol 1 agents keep working; queries are offered
only to agents that announce protocol 2.

### 5. Read-only database discipline (enforced in depth)
- Oracle account with `CREATE SESSION` and `SELECT` on an explicit object list only (the data contract), no roles with
  write or `ANY` privileges; created by the hotel's DBA from Planova's grant script.
- The agent executes only **predefined, versioned, parameterised `SELECT` statements** from the data contract
  (statement allow-list compiled into the agent; bind variables only), in **read-only transactions**
  (`SET TRANSACTION READ ONLY`), with row limits, timeouts and a low connection count.
- A start-up **privilege self-check** refuses to run (health UNHEALTHY) if the account can write anything.
- Credentials are a secret in the agent's protected store (`hotella-agent secret set opera.db.password`), never in
  settings, logs or the platform.

### 6. Standards owned by Planova
`docs/integrations/opera/OPERA_INTEGRATION_GUIDE.md` is the deployment reference: Planova Standard IFC8/FIAS Profile
(records, fields, directions, why each is needed), the OWS connector requirements, the DB read-only data contract,
the Interface Sheet comparison procedure, network/security, commissioning, testing, troubleshooting, rollback and the
pilot-readiness checklist. Hotel-specific facts live in the property's integration settings and its commissioning
record, never in code.

## Consequences
- ADR-0014's "DB view for reconciliation only" is replaced: DB read is a first-class read source; it stays read-only.
- New work (BUILD_PLAN §10 Phase 10, Sprints 10.6–10.9): capability registry and `PMS_API` routing; link protocol 2
  queries; `OPERA5_DB` connector (agent: `Hotella.Agent.OperaDb` with Oracle's managed driver, platform: data-contract
  parser); OWS write operations and the profile/sheet conformance tooling. Scheduled after Phase 11 and before the M4
  pilot; Phase 11 does not wait for them.
- The Oracle managed driver (`Oracle.ManagedDataAccess.Core`) enters the agent only in the DB project (pure managed
  code, no native install; ADR-0016 maturity gate satisfied).
- Research limits recorded honestly: the profile and data contract are derived from Oracle's published FIAS 2.25 / OWS
  5.1 / OPERA 5.6 material as reachable during design; each is marked *to verify against the official document* where a
  detail could not be read in full, and the commissioning checklist verifies them per hotel.

## Amendment 2026-10-04 (Sprint 10.9) — one PMS, one id namespace
Implementing the acceptance of hotel shape B showed a gap the decision implied but did not state: OPERA5_DB,
OPERA5_FIAS and OPERA5_OWS read the **same** OPERA, so a reservation's id (`RESV_NAME_ID`, FIAS `G#`) and a profile's
`NAME_ID` are the same whichever connector reports them (guide §9). External references therefore form one namespace
per **connector family** at a property: connector manifests declare `family` (`OPERA5` for the three), the integration
context resolves and links references across the property's instances of that family (the family's first holder
wins, as within one instance), the guest projector locks reservations and profiles per property, and reconciliation
compares a snapshot with stays linked through any connector of the family. Without it a reservation seen by OWS and
checked in through FIAS would become two stays. Rule 3 is unchanged: external ids still live only in
`integration.external_references`. Connectors without a family keep their own namespace.
