# Planova OPERA Integration Guide

**Product:** Hotella (Planova) · **Applies to:** Oracle Hospitality OPERA 5.6 (on-premise) with IFC8 · **Version:** 1.0
(2026-10-04) · **Owner:** Planova integration engineering · **Decision record:** ADR-0019 (supersedes ADR-0014 §3)

This guide is the standard reference for every OPERA hotel deployment. A new hotel is **compared against this
standard**; the integration is never redesigned per property. Hotel-specific facts go into the property's integration
settings and its commissioning record (§16), never into code.

Contents: 1 Principles · 2 Supported versions · 3 Architecture · 4 Unified OPERA Adapter · 5 Capability registry ·
6 Connector A — OPERA DB Read-Only · 7 Connector B — IFC8/FIAS and the Planova Standard Profile · 8 Connector C — OWS ·
9 Data mapping · 10 Synchronisation strategy · 11 Network, ports and firewall · 12 Security, credentials and OpenBao ·
13 Reliability, errors, logging and audit · 14 Health checks · 15 Installation · 16 Commissioning (Interface Sheet
comparison) · 17 Testing · 18 Troubleshooting · 19 Rollback · 20 Pilot readiness checklist · 21 Research basis and
verification status.

---

## 1. Principles

1. **Never write to the OPERA database.** The database connection is strictly read-only. Every write to OPERA goes
   through an officially supported interface — IFC8/FIAS or OWS — chosen by operation and by what the hotel has.
2. **Best available method per operation**, never dependence on one method: reads from the DB where available,
   real-time events from IFC8/FIAS, structured read/write operations from OWS where licensed.
3. **Modules ask for business operations**, not connectors (`PMS_API`, §4). They check capabilities (§5) before
   offering an action; the core runs unchanged for *DB + IFC8*, *DB + IFC8 + OWS* or *IFC8 + OWS* hotels.
4. **OPERA stays the source of truth** for guests, reservations, stays, check-in and check-out (CLAUDE.md rule 19).
   Hotella never creates a guest or stay itself and never checks a guest in or out in OPERA.
5. **Outbound-only from the hotel**: only the Hotella agent runs in the hotel; it connects out to the platform
   (ADR-0017). No inbound port to the hotel is opened for Hotella.
6. **Our standard, verified per hotel**: the Planova Standard IFC8/FIAS Profile (§7.3), the OWS connector requirements
   (§8) and the DB data contract (§6.3) are fixed by Planova; each hotel's Interface Sheet and setup are checked
   against them at commissioning (§16).

## 2. Supported versions

| Component | Supported | Notes |
|---|---|---|
| OPERA PMS | 5.6.x on-premise (also 5.5 where IFC8 and OWS 5.1 are present) | OPERA Cloud is a separate integration (OHIP), not covered here. |
| Interface controller | IFC8 with a FIAS vendor interface (TCP/IP) | one IFC8 instance per vendor interface |
| FIAS specification | 2.20 – 2.25 records and fields as listed in §7.3 | |
| OWS | OPERA Web Services 5.1 (`/OWS_WS_51/`), SOAP 1.1 | optional, licence-dependent |
| Database | Oracle Database as shipped with the OPERA 5.6 installation (19c on current installs) | read-only account; no 23ai "read-only user" feature assumed |
| Hotella agent | 0.10.x or later (link protocol 2 for DB/OWS queries, §4.4) | one agent service per connector instance |

## 3. Architecture

```text
                    Hotella platform (Planova-hosted)
  ┌───────────────────────────────────────────────────────────────────┐
  │ Core contexts (guest, housekeeping, engineering, catalog, …)       │
  │        │ business operations              ▲ canonical events      │
  │        ▼                                   │                       │
  │  PMS_API — Unified OPERA Adapter ── capability registry (§5)       │
  │        │ routes by operation + capability + health                 │
  │  integration context: OPERA5_DB · OPERA5_FIAS · OPERA5_OWS          │
  │        │ signed commands / signed queries ▲ messages, query results│
  │  agent gateway (mTLS, WSS/HTTPS, ADR-0017)                          │
  └────────┼──────────────────────────────────────────────────────────┘
           │ outbound 443 only (from the hotel)
  ┌────────┼──────────────── hotel network ───────────────────────────┐
  │  Hotella agent(s): one service per connector instance             │
  │   A: OPERA DB read-only ──► Oracle listener (SELECT only)          │
  │   B: IFC8 / FIAS ◄──────► IFC8 (TCP, STX/ETX records)              │
  │   C: OWS ──────────────► OPERA Web Services (HTTPS, SOAP)          │
  └───────────────────────────────────────────────────────────────────┘
```

- **Connector A — OPERA DB Read-Only (`OPERA5_DB`)**: reliable, efficient retrieval — reservations, arrivals,
  departures, in-house list, profiles, rooms; reconciliation snapshots; change polling where no event source exists.
- **Connector B — IFC8/FIAS (`OPERA5_FIAS`)**: real-time PMS events (check-in, check-out, room move, guest change,
  room status) and the supported FIAS writes (room status `RE`; later postings).
- **Connector C — OWS (`OPERA5_OWS`)**: supported structured API operations — future bookings, reservation and profile
  reads, and the writes OPERA exposes through OWS (profile contact data, supported reservation changes).

The core never imports OPERA types. Each connector turns vendor data into canonical records (Spec §51); writes leave
as signed Integration Commands (Spec §53).

## 4. Unified OPERA Adapter (`PMS_API`)

### 4.1 Responsibility
`PMS_API` is the only way a module reaches the PMS. It offers business operations, decides which connector serves
each one for the property, and returns canonical results or a typed refusal (`pms.capability_unavailable`, with the
capability and the reason). It is vendor-neutral by name so another PMS can sit behind it later.

### 4.2 Operations (v1)
| Operation | Kind | Capability | Preference order |
|---|---|---|---|
| `lookupReservation(confirmation \| externalId)` | read | `RESERVATION_LOOKUP` | DB → OWS (`FetchBooking`) |
| `listArrivals(date range)` | read | `ARRIVALS_READ` | DB → OWS (`FutureBookingSummary`) |
| `inHouseSnapshot()` | read | `IN_HOUSE_SNAPSHOT` | DB → FIAS database swap (`DR`) → OWS |
| `lookupProfile(profileId \| reservation)` | read | `PROFILE_LOOKUP` | DB → OWS (`FetchProfile`) |
| `roomInventory()` | read | `ROOM_INVENTORY_READ` | DB |
| `setRoomStatus(room, status, occupied)` | write | `ROOM_STATUS_WRITE` | FIAS `RE` (verified) → OWS (where supported) |
| `setRoomRestriction(room, kind, active)` | write | `OOO_WRITE` | OWS (where supported) → FIAS (where the interface supports it) |
| `updateProfileContact(profile, email/phone)` | write | `PROFILE_WRITE` | OWS (`Name` service) only |
| `updateReservationNote/ETA(...)` | write | `RESERVATION_WRITE` | OWS only |
| Real-time stay events (in) | event | `CHECKIN_EVENT`, `CHECKOUT_EVENT`, `ROOM_MOVE_EVENT`, `PROFILE_EVENT`, `ROOM_STATUS_READ` | FIAS → OWS polling → DB change polling (fallbacks marked *degraded*) |
| `reconciliationSnapshot()` | read | `RECONCILIATION_READ` | DB → FIAS database swap → OWS |

**No operation ever routes a write to the database.** Writes that OPERA does not expose through a supported interface
are not offered.

### 4.3 Routing rules (deterministic)
1. Take the preference order for the operation (above; a property may reorder within allowed connectors, never add the
   DB as a write target).
2. Keep connectors whose capability is **effective** (§5.3) for the property.
3. Choose the first; if it fails with a transient error, a read may fall through to the next; a write is never
   silently retried on another connector (the command reports FAILED and the operator or the module decides).
4. Record the routing decision (operation, connector chosen, reason) on the command/query for audit (§13.4).

### 4.4 Link protocol 2 — queries
Reads need answers. Protocol 2 adds a signed **`query`** frame (predefined `query_type` from the connector manifest,
typed parameters, deadline) and a **`query_result`** frame (canonical rows, at most 2 000 per answer, truncated flag;
no page token in v1 — the standard reads of one property stay below the cap).
There is no free-form SQL, SOAP or shell: the agent executes only query types compiled into it. Protocol 1 agents keep
working; queries are routed only to agents that announce protocol 2 in `hello`.

## 5. Per-property capability registry

### 5.1 Two levels
- **Connector facts** — `DB_READ`, `IFC8_LINK`, `OWS_API`: is this connector installed, enrolled, licensed and healthy?
- **Business capabilities** — what the platform may do: `RESERVATION_READ`, `RESERVATION_LOOKUP`, `ARRIVALS_READ`,
  `IN_HOUSE_SNAPSHOT`, `GUEST_READ`, `PROFILE_LOOKUP`, `ROOM_INVENTORY_READ`, `CHECKIN_EVENT`, `CHECKOUT_EVENT`,
  `ROOM_MOVE_EVENT`, `PROFILE_EVENT`, `ROOM_STATUS_READ`, `ROOM_STATUS_WRITE`, `OOO_READ`, `OOO_WRITE`,
  `PROFILE_WRITE`, `RESERVATION_WRITE`, `RECONCILIATION_READ`, `POST_CHARGE` (later).

### 5.2 Registry row (per property × capability × connector)
| Field | Meaning |
|---|---|
| `capability` | business capability |
| `connector` | `OPERA5_DB` / `OPERA5_FIAS` / `OPERA5_OWS` |
| `supported` | the connector manifest can serve it |
| `enabled` | the hotel enabled it in the integration settings |
| `reported` | the agent announced it (it has the configuration to serve it) |
| `verified` | proven at commissioning (§16); who and when |
| `status` | AVAILABLE / DEGRADED / UNAVAILABLE from live health (§14) |
| `licence` | covered by the agent licence (Spec §62) |

Implementation (BUILD_PLAN 10.6): only `verified` is stored by the registry (`integration.property_capabilities`);
the other facts are read from their owners — the manifest, the instance's enabled list, the agent's hello, the
licence and the instance health (HEALTHY = AVAILABLE; DEGRADED/OFFLINE = DEGRADED; MISCONFIGURED/AUTH_FAILED =
UNAVAILABLE). `GET /properties/:id/integration/capabilities` shows every connector's verdict with its reasons.

### 5.3 Effective capability (rule 11: code, not judgement)
`effective = supported ∧ enabled ∧ reported ∧ verified ∧ licence ∧ status ≠ UNAVAILABLE`. A property capability is
effective when **any** connector serves it effectively; `PMS_API.can(property, capability)` answers modules, the UI and
the AI tools (Spec §47: never offer what the hotel cannot do). Write capabilities additionally require `verified`
(read capabilities may run before verification only in commissioning mode).

### 5.4 Examples
| Hotel | Connectors | Pre-arrival (`ARRIVALS_READ`) | Real-time events | Room-status write-back | Profile write |
|---|---|---|---|---|---|
| A | DB + IFC8 | DB | FIAS | FIAS `RE` (if verified) | not offered |
| B | DB + IFC8 + OWS | DB (OWS fallback) | FIAS | FIAS `RE` (OWS fallback) | OWS |
| C | IFC8 + OWS | OWS | FIAS | FIAS `RE` (OWS fallback) | OWS |

## 6. Connector A — OPERA DB Read-Only (`OPERA5_DB`)

### 6.1 Requirements
- Network path from the agent host to the Oracle listener (default TCP 1521; the hotel's listener port), service name
  of the OPERA database.
- A **dedicated Oracle account** (e.g. `HOTELLA_RO`) created by the hotel's DBA from Planova's grant script; never the
  OPERA schema owner, never a shared or personal account.
- Privileges: `CREATE SESSION`, and **`SELECT` on the objects of the data contract (§6.3) only**. No roles granting
  write or `ANY` privileges (`SELECT ANY TABLE`, `DBA`, `RESOURCE`, …), no `EXECUTE` on packages, no `INSERT`,
  `UPDATE`, `DELETE`, DDL or database links. Oracle 19c has no "read-only user" switch — read-only is achieved by
  privileges, enforced again by the agent (§6.4).
- Optional, recommended by DBAs: a profile limiting sessions (2), idle time and CPU per call for the account.
- Contractual: the hotel (and, where its OPERA contract requires, Oracle) permits read access to its own data.

### 6.2 Grant script (template, executed by the hotel's DBA)
```sql
-- Run as a DBA. Replace <opera_owner> with the OPERA schema owner (commonly OPERA) and set a strong password,
-- which is then stored only in the agent: `hotella-agent secret set opera.db.password` (from stdin).
CREATE USER HOTELLA_RO IDENTIFIED BY "<strong password>" DEFAULT TABLESPACE USERS QUOTA 0 ON USERS;
GRANT CREATE SESSION TO HOTELLA_RO;
-- Data contract v1 objects (§6.3) — SELECT only:
GRANT SELECT ON <opera_owner>.RESORT TO HOTELLA_RO;
GRANT SELECT ON <opera_owner>.RESERVATION_NAME TO HOTELLA_RO;
GRANT SELECT ON <opera_owner>.RESERVATION_DAILY_ELEMENT_NAME TO HOTELLA_RO;
GRANT SELECT ON <opera_owner>.RESERVATION_DAILY_ELEMENTS TO HOTELLA_RO;
GRANT SELECT ON <opera_owner>.NAME TO HOTELLA_RO;
GRANT SELECT ON <opera_owner>.NAME_PHONE TO HOTELLA_RO;
GRANT SELECT ON <opera_owner>.ROOM TO HOTELLA_RO;
GRANT SELECT ON <opera_owner>.ROOM_CATEGORY_TEMPLATE TO HOTELLA_RO;
-- Nothing else. Verify: SELECT * FROM DBA_SYS_PRIVS / DBA_TAB_PRIVS / DBA_ROLE_PRIVS WHERE GRANTEE = 'HOTELLA_RO';
```
The object list is **data contract v1**; it is verified against the hotel's schema by the agent's probe
(`hotella-agent opera-db probe`, §16.4) before go-live. A change to the list is a new contract version, reviewed by
Planova and re-granted by the hotel's DBA.

### 6.3 Data contract v1 (logical → OPERA 5.6 physical)
The **logical contract** is what Hotella needs; the **physical mapping** is how OPERA 5.6 stores it. Statements are
predefined, versioned and parameterised in the agent; the platform receives canonical rows only.

| Logical entity | Fields Hotella needs | OPERA 5.6 source (v1) | Status |
|---|---|---|---|
| Property | resort code, name, timezone | `RESORT` | expected |
| Reservation | reservation id, confirmation no., status, arrival, departure, adults, children, ETA, room, rate code, market code, primary profile, sharers | `RESERVATION_NAME` (`RESV_NAME_ID`, `NAME_ID`, `CONFIRMATION_NO`, `RESV_STATUS`, dates, persons); per-night room from `RESERVATION_DAILY_ELEMENT_NAME` / `RESERVATION_DAILY_ELEMENTS` | `RESERVATION_NAME`, `RESV_NAME_ID`, `NAME_ID` confirmed; columns to verify |
| Stay status | reserved / in house / checked out / cancelled / no-show | `RESERVATION_NAME.RESV_STATUS` (e.g. RESERVED, CHECKED IN, CHECKED OUT, CANCELLED, NO SHOW) | values to verify |
| Profile | profile id, first/last name, title, language, VIP code, e-mail, phone | `NAME` (`NAME_ID`, names, title, language, VIP); contact data from `NAME_PHONE` (role phone/e-mail) | to verify |
| Room | room number, room type, floor | `ROOM` (by `RESORT`) | to verify |
| In-house list | reservations with status in house on the business date | `RESERVATION_NAME` filtered by status | to verify |
| Arrivals / departures | reservations arriving/departing in a date window | `RESERVATION_NAME` by arrival/departure date | to verify |

Rules:
- Every statement filters by the property's `RESORT` code, uses bind variables only, a `FETCH FIRST n ROWS` cap and a
  statement timeout; reads run in `SET TRANSACTION READ ONLY`.
- Personal data is read only to the extent of the logical contract (data minimisation); card numbers, IDs/passports,
  folios and rates amounts are **not** in the contract.
- OPERA internal codes (statuses, VIP, market, rate, room type) are mapped through the platform's mapping tables;
  an unknown code raises an `integration_exception`, never a guess (rule 16).

### 6.4 Read-only enforcement in the agent (defence in depth)
1. Only statements from the compiled allow-list run; there is no API to submit SQL.
2. Each session starts with `SET TRANSACTION READ ONLY`.
3. **Privilege self-check at start and daily**: the agent queries `USER_SYS_PRIVS`, `USER_TAB_PRIVS`,
   `USER_ROLE_PRIVS`; any privilege other than `CREATE SESSION` and `SELECT` on contract objects ⇒ health UNHEALTHY,
   the connector refuses to run, the operator is told why.
4. Connection pool max 2, query timeout 30 s, row cap per query, polling intervals no tighter than 60 s.

### 6.5 Uses
- Lookups and lists for `PMS_API` (§4.2).
- **Reconciliation snapshot** (Spec §52) — preferred over the FIAS database swap because it does not interrupt IFC8.
- **Change polling** (fallback only): reservation changes in the arrival window when OWS is absent; detected by
  fingerprint like the OWS poller, forwarded as `OPERA_DB_RESERVATION` messages.

## 7. Connector B — IFC8 / FIAS (`OPERA5_FIAS`)

### 7.1 How IFC8 and FIAS work
- IFC8 is OPERA's interface controller for property systems; **each vendor connection uses its own IFC8 instance**
  and an interface number configured in OPERA. The vendor system speaks **FIAS** (Fidelio Interface Application
  Specification) records over TCP/IP; IFC8 can be configured as TCP server or client.
- A record is `STX` (0x02) + `RecordId|FieldId value|FieldId value|…|` + `ETX` (0x03); each field is a two-character
  field id followed by its value.
- **Link control**: the PMS sends **Link Start (`LS`)**; the vendor answers with **Link Description (`LD`)**, one
  **Link Record (`LR`)** per record type it wants (`RI` = record id, `FL` = the field ids it wants), then **Link Alive
  (`LA`)**. Whenever an `LS` arrives again, `LD` and the `LR`s are retransmitted. `LA` keeps the link verified; `LE`
  ends it. Timeouts default to 30 s (60 s for posting requests) and are configurable.
- **Database swap / resync**: the vendor may send **`DR`** (database resync request); the PMS answers **`DS`** (start),
  the in-house records (`GI` … with the **swap flag `SF`**) and **`DE`** (end). The PMS may intermix real-time records;
  the vendor must not send records during the swap — any message is held until `DE`.
- Optional link security: FIAS over TCP supports authentication with a static AES key protecting an RSA key
  ("IfcAuthKey") when enabled on the IFC8 side.

### 7.2 What Hotella needs from FIAS
In-house life of a stay in real time (check-in, guest changes, room moves, check-out), room status, and a resync of the
in-house list. FIAS carries **no future reservations** — those come from the DB or OWS.

### 7.3 Planova Standard OPERA IFC8/FIAS Profile v1
**Records OPERA → Hotella (requested with `LR`):**

| Record | Purpose | Fields requested (`FL`) | Hotella use | Required? |
|---|---|---|---|---|
| `GI` Guest In | check-in | `RN` room, `G#` reservation no., `GN` last name, `GF` first name, `GT` title, `GL` language, `GV` VIP, `GS` share flag, `GG` group, `GA` arrival, `GD` departure, `SF` swap flag, `DA` date, `TI` time | `hotel.guest.checked_in.v1`; activation; grants | **required** |
| `GO` Guest Out | check-out | `RN`, `G#`, `GS`, `SF`, `DA`, `TI` | `hotel.guest.checked_out.v1`; revoke stay access | **required** |
| `GC` Guest Change | guest data change / room move | `RN`, `RO` old room, `G#`, `GN`, `GF`, `GT`, `GL`, `GV`, `GS`, `GG`, `GA`, `GD`, `DA`, `TI` | `hotel.stay.room_changed.v1` (when `RO` ≠ `RN`), `hotel.guest.profile_updated.v1` | **required** |
| `RE` Room Equipment | room status from PMS | `RN`, `RS` maid status, `DA`, `TI` | `hotel.room.status_changed.v1` (housekeeping) | required for housekeeping |
| `DS` / `DE` | database swap start/end | `DA`, `TI` | reconciliation snapshot boundaries | **required** |
| `NS` / `NE` | night audit start/end | `DA`, `TI` | business-date rollover hint | optional |

**Records Hotella → OPERA:**

| Record | Purpose | Fields | When | Required? |
|---|---|---|---|---|
| `LD` | link description | `V#` interface version, `IF` interface family, `DA`, `TI` | after every `LS` | **required** |
| `LR` | link record per wanted record | `RI`, `FL` | after `LD` | **required** |
| `LA` | link alive | `DA`, `TI` | after `LR`s, and when idle | **required** |
| `LE` | link end | `DA`, `TI` | orderly shutdown | recommended |
| `DR` | database resync request | `DA`, `TI` | `RESYNC_IN_HOUSE` command, after long outages | **required** |
| `RE` | room status to PMS | `RN`, `RS`, `DA`, `TI` | `SET_ROOM_STATUS` (only when verified, §16) | optional |
| `PS` / `PR` | postings | — | not in v1 (later `POST_CHARGE`) | not used |

**Field rules:** `DA` = `YYMMDD`, `TI` = `HHMMSS`, hotel local time (converted with the property's time zone). `RS`
maid status values: 1 dirty/vacant, 2 dirty/occupied, 3 clean/vacant, 4 clean/occupied, 5 inspected/vacant,
6 inspected/occupied — a write must carry the occupancy; the agent refuses a write without it. `GS` share: one `GI`
per sharer, same `RN`, own `G#`. Unknown fields are ignored; unknown record ids are reported, never guessed.

**Behaviour rules:** forward every business record verbatim (the platform parses); message id = SHA-256(instance,
record) so an IFC8 repeat is a no-op; LA when idle for `LinkAliveSeconds` (default 60); reconnect after three silent
intervals; no sending during a database swap; a `DR` after any outage longer than the configured threshold.

**Configuration (agent `Fias` section, per hotel):** `Mode` (Client/Server), `Host`, `Port`, `Encoding`
(utf-8 / windows-1252 / iso-8859-1 as configured in IFC8), `LinkAliveSeconds`, `LinkStartSeconds`, `ReconnectSeconds`.

### 7.4 IFC8 configuration checklist (hotel side, with the hotel's IFC8 administrator)
1. IFC8 licence for a new **generic FIAS vendor interface** for Hotella; interface number assigned in OPERA.
2. Its own IFC8 instance; communication **TCP/IP**; decide who is server (default: IFC8 server, agent client) and the port.
3. Records enabled per §7.3 (the agent's `LR`s request them; IFC8 must allow them for this interface).
4. Database swap allowed for the interface.
5. Room status: send `RE` to the interface (if housekeeping uses it); accept `RE` from the interface only after
   verification (§16).
6. Character set noted (matches the agent `Fias:Encoding`).
7. IfcAuthKey enabled or not (agent setting must match).
8. Night audit records `NS`/`NE` optional.

## 8. Connector C — OWS (`OPERA5_OWS`)

### 8.1 Architecture and services
OPERA Web Services is a set of SOAP 1.1 web services hosted on the OPERA application server(s), version **5.1** at
`https://<ows-host>/OWS_WS_51/<Service>.asmx`. Services used by the standard connector:

| Service | Operations used | Purpose |
|---|---|---|
| `Reservation.asmx` | `FutureBookingSummary`, `FetchBooking` | arrivals window, reservation detail |
| `Name.asmx` | `FetchProfile`; contact updates (e-mail/phone insert/update operations as exposed by the hotel's OWS 5.1) | profile read; `PROFILE_WRITE` |
| `ResvAdvanced.asmx` | — (not used: check-in/check-out stay OPERA's own business, rule 19) | — |
| `Information.asmx` | lookups of code lists where needed | mapping assistance |

### 8.2 Authentication and security
- Each request carries an **`OGHeader`** SOAP header: `transactionID`, `timeStamp`, `Origin entityID` (Planova's channel
  code configured in OPERA for this interface), `Destination entityID` (the hotel/chain), and
  `Authentication/UserCredentials` (`UserName`, `UserPassword`, `Domain`).
- A **dedicated OWS user** for Hotella with only the functions the standard connector uses; password in the agent's
  protected store (`hotella-agent secret set ows.password`), never in settings or the platform.
- **HTTPS only** (TLS 1.2+); the agent validates the server certificate (hotel CA file configurable); plain HTTP only on
  loopback for tests.
- OWS is **stateless** per request (no session to keep); requests are idempotent reads except the explicit writes.

### 8.3 Request/response and errors
- Responses carry `Result resultStatusFlag` (`SUCCESS` / `FAIL`) with `Text` / `GDSError` details; SOAP faults
  (HTTP 500) for authentication and malformed requests. The connector reports the **reason only** (never echoes
  credentials or full payloads with personal data).
- Retries: reads retried with back-off (1 s → 60 s); writes are not retried blindly — a write that times out is
  re-checked by a read before any retry.
- Polling: arrivals window (default yesterday … +14 days) every 5 minutes; change detection by fingerprint; NEW,
  CHANGE, CANCEL/NOSHOW forwarded once.

### 8.4 Network
Agent host → OWS host TCP 443 inside the hotel LAN; no inbound to the hotel.

### 8.5 Hotel-specific configuration (agent `Ows` section)
`Url`, `Username`, `PasswordSecret`, `Domain`, `HotelCode`, `ChainCode`, `OriginEntity`, `DestinationEntity`,
`PollSeconds`, `WindowDays`, `TimeoutSeconds`. Operations not licensed or not exposed at the hotel are simply not
reported as capabilities.

## 9. Data mapping
| Canonical (Spec §51) | FIAS | OWS | DB |
|---|---|---|---|
| reservation external id | `G#` | `UniqueID source=RESV_NAME_ID` | `RESERVATION_NAME.RESV_NAME_ID` |
| confirmation number | — | `UniqueID` (confirmation) | `CONFIRMATION_NO` |
| profile external id | — | `ProfileIDs/UniqueID source=NAME_ID` | `NAME.NAME_ID` |
| room | `RN` (old: `RO`) | `RoomStay/…/RoomNumber` | daily element room |
| arrival / departure | `GA` / `GD` | `TimeSpan StartDate/EndDate` | arrival / departure columns |
| names, title, language, VIP | `GN`, `GF`, `GT`, `GL`, `GV` | `PersonName`, `languageCode`, `vipCode` | `NAME` columns |
| room status | `RS` 1–6 | — | — |
External ids live only in `integration.external_references` (rule 3). Codes (VIP, rate, market, room type, status) map
through confirmed mappings; unknown codes create exceptions (rule 16).

## 10. Synchronisation strategy
1. **Real time**: FIAS events as they happen (seconds).
2. **Near real time future data**: DB (or OWS) arrival-window polling every 5 minutes, change-detected.
3. **Lookups on demand**: `PMS_API` queries (DB first).
4. **Reconciliation**: daily and after any outage — DB snapshot (or FIAS `DR` swap, or OWS) compared with the platform
   (Spec §52); differences become exceptions for people, never silent fixes.
5. **Ordering**: per-instance sequences on the link; the guest projector converges to the same history in any delivery
   order.

## 11. Network, ports and firewall
| From | To | Port | Purpose |
|---|---|---|---|
| Agent host | Hotella agent gateway (internet) | TCP 443 outbound | link (WSS/HTTPS, mTLS) |
| Agent host | IFC8 host | hotel-assigned TCP port (or IFC8 → agent when IFC8 is client) | FIAS |
| Agent host | OWS host | TCP 443 | OWS (optional) |
| Agent host | Oracle listener | TCP 1521 (hotel listener port) | DB read-only (optional) |
| Agent host | Planova updates host | TCP 443 outbound | signed updates |
No inbound connection from the internet to the hotel. Proxies: the agent honours the system HTTPS proxy for outbound
443.

## 12. Security, credentials and OpenBao
- **Hotel-side credentials** (OPERA DB password, OWS password, IfcAuthKey) are stored **only in the agent's protected
  store** (DPAPI machine scope on Windows, 0600 in a 0700 directory on Linux), set from stdin with
  `hotella-agent secret set <name>`; never in settings files, logs, or messages to the platform.
- **Platform-side keys live in OpenBao** (ADR-0013): agent CA, command/licence signing key, update signing key (release
  pipeline). No OPERA credential is stored on the platform.
- Link: TLS 1.3 mutual TLS with a pinned Planova CA (ADR-0017); commands and queries are Ed25519-signed and verified
  against the pinned key; the licence gates commands (§14).
- Least privilege everywhere: DB `SELECT` on contract objects only; OWS user limited to the used functions; IFC8
  interface limited to the profile's records.
- Personal data: minimised by contract; no PII in logs (rule 17); data classes per column (rule 21).

## 13. Reliability, errors, logging and audit
1. **Durability**: every message is in the agent's SQLite queue before it is sent; nothing is lost while the platform
   or the link is down (ADR-0017).
2. **Retry / reconnection**: link back-off 1 s → 60 s with jitter; IFC8 reconnect every `ReconnectSeconds`; OWS/DB
   reads back-off; writes never retried blindly.
3. **Errors**: parse errors and unknown codes become integration exceptions with the raw message kept for replay;
   connector failures surface in health with a reason.
4. **Audit**: every write command (who/what asked, routing decision, signed command id, result) and every query
   (type, requester, row count — not the data) is recorded; licence and update events too.
5. **Logs**: structured, without personal data or credentials; FIAS/OWS payloads are never logged in clear.

## 14. Health checks
Per connector: link up, last message time, backlog, last error, licence state, certificate expiry (agent
`health.json`, platform integration health). Additional:
- **DB**: connect + privilege self-check + a probe query per contract object (daily and at start).
- **IFC8**: link handshake state, last `LA`, last record time, swap in progress.
- **OWS**: last successful poll, consecutive failures, authentication failures (immediately DEGRADED).
Capability status in the registry follows health (§5.3).

## 15. Installation
1. Agent host prepared (Windows Server or Linux, outbound 443, LAN access to IFC8/OWS/Oracle as used).
2. Install the agent package once per connector instance (`install.ps1` / `install.sh`), each with its own data
   directory and service name.
3. In Hotella: create the property's OPERA integration instances (`OPERA5_FIAS`, optionally `OPERA5_DB`,
   `OPERA5_OWS`), issue enrollment tokens.
4. On the agent host: `hotella-agent enroll --token-file - --ca <planova-ca.pem>`; set connector settings; set secrets
   from stdin; `hotella-agent status` must show no problems.
5. Start the services; confirm the platform shows the agents connected and licences VALID.

## 16. Commissioning — compare the hotel against the standard
### 16.1 Inputs
The hotel's **IFC8 Interface Sheet**, OWS details (licence, version, URL, entity codes), DBA confirmation of the
read-only account.
### 16.2 Interface Sheet comparison (fill one row per requirement of §7.3)
| Requirement (standard v1) | Standard | Hotel's sheet | Status (OK / change needed / not available) | Capability impact |
|---|---|---|---|---|
| Interface type / FIAS version | FIAS ≥ 2.20 over TCP/IP | | | all FIAS capabilities |
| Connect direction, host, port | IFC8 server, agent client | | | link |
| Records `GI`/`GO`/`GC` with listed fields | §7.3 | | | `CHECKIN_EVENT`, `CHECKOUT_EVENT`, `ROOM_MOVE_EVENT`, `PROFILE_EVENT` |
| `RE` to interface | enabled | | | `ROOM_STATUS_READ` |
| `RE` from interface | enabled after verification | | | `ROOM_STATUS_WRITE` |
| Database swap (`DR`/`DS`/`DE`) | allowed | | | `RECONCILIATION_READ` (FIAS path) |
| Character set | noted | | | correctness of names |
| IfcAuthKey | noted | | | link |
| Interface number / identifiers | noted | | | support |
The sheet **verifies** the hotel; it never changes the standard. "Change needed" items go to the hotel's IFC8
administrator; "not available" items simply leave the capability off.
### 16.3 OWS verification
Licence, version 5.1, URL reachable over HTTPS from the agent host, entity codes, user rights; run
`FutureBookingSummary` for tomorrow and `FetchProfile` for one known profile.
### 16.4 DB verification
`hotella-agent opera-db probe`: connects, runs the privilege self-check (must show only `CREATE SESSION` + `SELECT` on
contract objects), runs each contract statement with a 1-row limit, reports missing objects/columns.
### 16.5 Capability sign-off
Each capability is marked **verified** in the registry by the commissioning engineer with evidence (record seen,
command acknowledged and checked in OPERA, query result compared with the OPERA screen). Write capabilities
(`ROOM_STATUS_WRITE`, `PROFILE_WRITE`, `RESERVATION_WRITE`) are verified with the hotel present, on a test room/profile.

## 17. Testing
- **Automated (Planova CI)**: the PMS simulator's byte-level IFC8 face and OWS SOAP face run the standard profile end
  to end against the real gateway with the production agent (`opera5-fias.e2e-spec.ts`, `opera5-ows.e2e-spec.ts`);
  the DB connector against a contract fixture schema (Sprint 10.7).
- **On site**: check-in, room move, guest change, check-out on a test reservation; room status both ways (if
  verified); `DR` swap; an IFC8 restart and an internet outage with recovery and no loss; reconciliation MATCH.

## 18. Troubleshooting
| Symptom | Check |
|---|---|
| IFC8 link never comes up | direction/port, firewall, IFC8 instance started, `LS` received (agent log "FIAS link up"), IfcAuthKey match |
| Records missing for some events | `LR` fields vs Interface Sheet; record enabled in IFC8 for this interface |
| Wrong characters in names | `Fias:Encoding` vs IFC8 character set |
| Room status write ignored | capability verified? IFC8 accepts `RE` from interface? occupancy sent? |
| OWS FAIL / SOAP fault | credentials (`hotella-agent status` shows secret set), entity codes, licence, URL/TLS |
| DB connector UNHEALTHY "privileges" | the account can do more than SELECT — DBA must revoke; the agent refuses to run otherwise |
| DB probe "object missing" | schema owner/synonyms; contract version vs OPERA version |
| Platform shows agent disconnected | outbound 443, proxy, certificate expiry, revoked (re-enroll) |

## 19. Rollback
- **Agent version**: automatic on failed probation, or `hotella-agent update rollback` (ADR-0017 §updates).
- **Connector**: disable the instance in Hotella (capabilities drop, modules stop offering dependent actions); stop the
  agent service. Nothing in OPERA needs rollback for reads.
- **Writes**: disable the write capability (registry `enabled=false`); room statuses already written are corrected in
  OPERA by the hotel as usual.
- **IFC8**: stop the Hotella IFC8 instance; other interfaces are unaffected (separate instance).
- **DB**: the DBA drops or locks `HOTELLA_RO`.

## 20. Pilot readiness checklist
- [ ] OPERA version recorded (5.6.x), IFC8 version, OWS version (if any)
- [ ] IFC8 licence for a generic FIAS interface; interface number; IFC8 instance for Hotella
- [ ] Interface Sheet compared (§16.2) — all required rows OK
- [ ] OWS licence status known; if licensed: user, entity codes, URL, certificate
- [ ] Read-only DB account created from the grant script; probe passes
- [ ] Agent host: OS, outbound 443, LAN reachability to IFC8 / OWS / Oracle
- [ ] Agents enrolled; licences VALID; health HEALTHY
- [ ] Mappings confirmed (rooms, room types, VIP, market, rate codes)
- [ ] Capabilities verified and signed off (§16.5)
- [ ] On-site tests (§17) passed; reconciliation MATCH
- [ ] Rollback contacts and steps agreed (§19)

## 21. Research basis and verification status
Sources consulted (2026-10-04): Oracle Hospitality *IFC8 FIAS Specification* 2.20–2.25 and *IFC8 Configuration*
guides; *OPERA Property Management Developer's Guide* (OWS); OPERA 5.5/5.6 help (OWS configuration, data extraction);
OWS 5.1 service pages; vendor implementation notes from FIAS integrators (Mitel, Loxone, 3CX, ClearlyIP, Casablanca).
Confirmed from those sources: link control and `LS`/`LD`/`LR`(`RI`,`FL`)/`LA`/`LE` semantics; database resync
`DR`/`DS`/`DE` with `SF` and the no-send rule during swaps; field ids `RN`, `G#`, `GN`, `GL`, `GV`, `GS`, `GG`, `GA`,
`GD`, `RO`, `SF`, `RS`; `RE` room status records; 30 s / 60 s timeouts; IfcAuthKey; one IFC8 instance per vendor;
OWS 5.1 endpoints, `OGHeader` with `Origin`/`Destination`/`UserCredentials`, `FutureBookingSummary`, `FetchBooking`,
`FetchProfile`, `CheckIn`/`CheckOut` in `ResvAdvanced`, `resultStatusFlag`; OPERA DB keys `RESERVATION_NAME`,
`RESV_NAME_ID`, `NAME_ID`; Oracle 19c has no read-only-user feature.

**To verify against the full official documents before the first production go-live** (they could not be read in full
from the design environment; Planova should keep licensed copies): the exact `RS` value table for 5/6 in FIAS 2.25;
`GF`/`GT`/`NS`/`NE` field and record definitions; the OWS 5.1 Name-service contact update operations and whether the
hotel's OWS exposes room-status updates; the physical columns of the DB contract tables in OPERA 5.6. Each is also
checked per hotel at commissioning (§16), so a difference is found before it can affect a guest.
