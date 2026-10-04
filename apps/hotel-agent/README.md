# Hotella hotel agent

The only Hotella software a hotel installs (ADR-0013, ADR-0017). It runs beside the PMS, connects **outbound only**
to the platform's agent gateway over mutual TLS, keeps every PMS message in a durable local queue until the platform
acknowledges it, and runs only predefined commands signed by the platform. Built in Phase 10 (`docs/BUILD_PLAN.md`
§10); the TypeScript reference agent in `apps/pms-simulator` is the protocol's executable specification.

```text
src/Hotella.Agent.Core   identity (P-256 key + CSR, DPAPI / 0600), durable queue (SQLite WAL), link client,
                         Ed25519 command verification, settings and renewal policy
src/Hotella.Agent        hotella-agent: run | enroll | status | version (Windows service or systemd unit)
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
