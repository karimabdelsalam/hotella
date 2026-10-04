# Hotella hotel agent

The only Hotella software a hotel installs (ADR-0013, ADR-0017). It runs beside the PMS, connects **outbound only**
to the platform's agent gateway over mutual TLS, keeps every PMS message in a durable local queue until the platform
acknowledges it, and runs only predefined commands signed by the platform. Built in Phase 10 (`docs/BUILD_PLAN.md`
§10); the TypeScript reference agent in `apps/pms-simulator` is the protocol's executable specification.

```text
src/Hotella.Agent.Core   identity (P-256 key + CSR, DPAPI / 0600), durable queue (SQLite WAL), link client,
                         Ed25519 command verification, settings and renewal policy
src/Hotella.Agent.Fias   OPERA5_FIAS: the IFC8/FIAS session
src/Hotella.Agent.Ows    OPERA5_OWS: OWS polling
src/Hotella.Agent.OperaDb OPERA5_DB: read-only OPERA database connector (data contract v1, privilege self-check)
src/Hotella.Agent        hotella-agent: run | enroll | status | secret | update | opera-db probe | version
test/…Tests              xUnit, including the vector shared with packages/platform/pki
test/…Conformance        JSON-lines driver for the cross-language e2e (never shipped)
```

```sh
dotnet test Hotella.Agent.slnx                       # build (analyzers are errors) and unit tests
hotella-agent enroll --token-file token.txt --ca planova-agent-ca.pem --Agent:Gateway=https://agents.example
hotella-agent status
hotella-agent run                                    # what the service runs
```

Settings (`Agent` section): `Gateway`, `ConnectorCode`, `Capabilities`, `DataDirectory`, `QueueRetentionDays`,
`RenewAtRemainingFraction` — see `src/Hotella.Agent/agent.example.json`. Secrets never go in settings: the device key
lives in the data directory, protected by the operating system. Exit codes: 2 not configured or not enrolled,
3 certificate revoked (enroll again with a new token), 4 enrollment refused.

## OPERA database (read-only, `OPERA5_DB`)

The hotel's DBA creates a dedicated account (e.g. `HOTELLA_RO`) with `CREATE SESSION` and `SELECT` on the data
contract objects only (OPERA Integration Guide §6). The agent never writes: only the compiled statements of data
contract v1 exist, every read runs in a `SET TRANSACTION READ ONLY` transaction that is rolled back, and an account
with any other privilege, role or grant is refused (checked at start and daily) until the DBA removes it.

```json
"Agent":  { "ConnectorCode": "OPERA5_DB", "Capabilities": ["RESERVATION_READ", "RESERVATION_LOOKUP",
            "ARRIVALS_READ", "IN_HOUSE_SNAPSHOT", "GUEST_READ", "PROFILE_LOOKUP", "ROOM_INVENTORY_READ",
            "RECONCILIATION_READ"] },
"OperaDb": { "Host": "10.0.0.30", "Port": 1521, "ServiceName": "OPERA", "Username": "HOTELLA_RO",
            "SchemaOwner": "OPERA", "ResortCode": "HOTEL1", "QueryTimeoutSeconds": 30,
            "ChangePolling": false, "PollSeconds": 300, "WindowDays": 14 }
```

```sh
hotella-agent secret set opera.db.password            # read from stdin into the protected store
hotella-agent opera-db probe                          # objects, columns, privileges, counts — no personal data
```

`ChangePolling` forwards changed reservations of the arrival window as `OPERA_DB_RESERVATION` messages; enable it
only where OWS is absent. The driver is Oracle's fully managed `Oracle.ManagedDataAccess.Core` (no Oracle client, no
native code).

## FIAS and OWS settings (standard profile v1)

`Fias`: `Mode`, `Host`, `Port`, `Encoding`, `LinkAliveSeconds`, `LinkStartSeconds`, `ReconnectSeconds`,
`OptionalRecords` (`NS`, `NE`), `ResyncAfterOutageSeconds` (300; 0 = off), `SwapWaitSeconds` (120). The `LR` requests
are the Planova Standard FIAS Profile v1 (`FiasProfile`, checked against the platform's vector). Nothing is sent to
IFC8 during a database swap.

`Ows`: `Url`, `Username`, `PasswordSecret` (`ows.password`), `Domain`, `HotelCode`, `ChainCode`, `OriginEntity`,
`DestinationEntity`, `PollSeconds`, `WindowDays`, `TimeoutSeconds`. The OWS connector answers the standard reads
(`FetchBooking`, `FutureBookingSummary`, `FetchProfile`) and, when `PROFILE_WRITE` is among `Agent:Capabilities` and
verified on the platform, adds contacts with `InsertEmail` / `InsertPhone` after reading the profile first.
