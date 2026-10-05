# Planova Pilot Readiness Checklist — Hotella at an OPERA hotel

**Version 1 · 2026-10-04.** Take this list to a new hotel to find out exactly what is needed before installation. It
covers both sides: **Planova's platform servers** (ADR-0013: Planova-operated, internet-reachable) and **the hotel**
(only the thin hotel agent, ADR-0017). The OPERA-specific technical detail is in
`docs/integrations/opera/OPERA_INTEGRATION_GUIDE.md`; the platform shows the integration part of this list live, per
property, in the control plane (tab *Integrations*, guide §16.6).

Mark each line ✅ done · ⛔ blocked (with owner and date) · n/a. The pilot starts when nothing is ⛔.

---

## 1. Server requirements

### 1.1 Planova platform server (central; hosts every pilot hotel)
Baseline for the pilot — one host running the Compose stack (PostgreSQL 18 + pgvector, Valkey, SeaweedFS, OpenBao,
API, worker, agent gateway, staff and guest web apps, observability):

| Item | Pilot (1–3 hotels, ≤ 600 rooms in total) | Growth (≈ 10–20 hotels) |
|---|---|---|
| Topology | 1 host, Docker Compose | k3s/RKE2: 3 application nodes + 1 database server (+ streaming replica) |
| CPU | 8 vCPU (x86-64, AVX2) | app nodes 8 vCPU each; database 16 vCPU |
| Memory | 32 GB | app nodes 32 GB each; database 64 GB |
| Disk | 500 GB NVMe SSD for data (database, object storage) + a **separate** 1 TB volume for backups, with an off-site copy | database 1 TB NVMe; object storage 2 TB; backup repository ≥ 3× database size off-host |
| OS | Ubuntu Server 24.04 LTS (or Debian 12), unattended security updates | same |
| Network | public IPv4, 100 Mbit/s symmetric, DNS names for API, staff, guest and agent gateway, TLS certificates | 1 Gbit/s, load balancer |
| GPU | not needed — AI runs at the providers through the Model Gateway | only if self-hosted models are chosen later |

A demo or trial installation (no live hotel) runs from 2 vCPU, 8 GB RAM and 40 GB of disk. The installer adds swap
and builds more slowly there (deploy runbook, "Small servers"). These figures are a planning baseline from the architecture (worker queues, pgvector, one Node process per role), not
yet a measured load test; the pilot's monitoring (§13) confirms or adjusts them before the next hotels.

### 1.2 Hotel agent host (at each hotel)
| Item | Requirement |
|---|---|
| Machine | a Windows or Linux machine (a VM is fine) that is always on, inside the hotel LAN with reach to IFC8, the OPERA database listener and OWS |
| OS | Windows Server 2019/2022/2025 or Windows 10/11 Pro 64-bit; or Ubuntu 22.04/24.04 / RHEL 9 |
| CPU / memory / disk | 2 vCPU · 4 GB RAM · 20 GB free SSD (the durable queue holds days of PMS messages during an internet outage) |
| Software | nothing to install beforehand: the agent is self-contained (.NET 10 inside) |
| Time | synchronised clock (NTP / domain time) — licence and signature checks depend on it |
| Rights | local administrator for the installation only; the service runs as LocalSystem (Windows) / its own user (Linux) |

## 2. Windows installation and MSI
- [ ] The agent MSI for this release (`hotella-agent-<version>-win-x64.msi`, WiX v5 — ADR-0020) and its SHA-256 from
      the release notes; one enrollment code per connector, issued in the control plane (Integrations → connector →
      *Enrollment code*; single use, 24 hours).
- [ ] Installed by the hotel's IT with Planova on the call: the MSI asks for up to three enrollment codes (silent
      install: `msiexec /i … ENROLLMENT_CODES_FILE=<file with one code per line> /qn`); codes are never typed on a
      command line and never reach the MSI log (CI proves it on every build).
- [ ] Code-signing: until the owner buys an Authenticode certificate, SmartScreen warns once — agreed with the hotel.
- [ ] PowerShell (`install.ps1`) only for diagnostics or emergencies, never as the standard path.

## 3. Services
- [ ] One Windows service per connector — **HotellaAgent-opera5-fias**, **-opera5-db**, **-opera5-ows** as used (or
      systemd units) — automatic start, recovery actions set (restart on failure).
- [ ] `hotella-agent status --instance <connector>`: enrolled, linked, licence VALID, health HEALTHY, queue depth
      near 0.

## 4. Database (platform)
- [ ] PostgreSQL 18 running; migrations applied as the admin role; the application connects as `hotella_app`
      (row-level security in force) — `pilot.sh migrate`, `pilot.sh status`.
- [ ] pgBackRest configured; first full backup taken; WAL archiving proven (§11).

## 5. Network and firewall
| From → to | Port | Purpose |
|---|---|---|
| Hotel agent → Planova agent gateway | TCP 443 (or the configured gateway port, default 8443), outbound only | mutual-TLS link, HTTPS batches |
| Hotel agent → IFC8 | TCP port of the Hotella IFC8 interface (LAN) | FIAS |
| Hotel agent → OPERA Oracle listener | TCP 1521 or the hotel's listener port (LAN) | read-only database |
| Hotel agent → OWS server | TCP 443 (LAN) | OWS |
| Staff and guests → Planova | TCP 443 | apps, APIs |
| Planova → AI providers / WhatsApp / SMS | TCP 443 outbound, allow-listed | providers |
- [ ] Nothing inbound to the hotel. No VPN needed.
- [ ] The hotel's internet: a second WAN or LTE failover recommended — Hotella apps need the internet; OPERA keeps
      working without it and the agent buffers (ADR-0021).

## 6. TLS
- [ ] Public certificates (or the internal CA trusted by staff devices) for API, staff, guest and agent hostnames;
      HSTS on; the agent gateway terminates its own mutual TLS (never behind the reverse proxy).
- [ ] OWS over HTTPS with a certificate the agent trusts (hotel CA file configured if private).

## 7. OpenBao and credentials
- [ ] OpenBao initialised, unsealed, audit device on; unseal shares with three custodians; root token revoked
      (`docs/runbooks/deploy.md`, `docs/security/SECRETS_LIFECYCLE.md`).
- [ ] Platform secrets present; AI provider keys under `kv/hotella/ai/<provider>`; channel tokens under
      `kv/hotella/comms/<channel>`; nothing in files, tickets or chat.
- [ ] Hotel-side credentials (OWS password, OPERA DB password) entered on the agent host with
      `hotella-agent secret set …` by the hotel or Planova on site — they never leave the hotel.

## 8. OPERA database (read-only)
- [ ] The hotel DBA created the dedicated account (e.g. `HOTELLA_RO`) from the grant script (guide §6.2): `CREATE
      SESSION` + `SELECT` on the data-contract objects only — nothing else.
- [ ] `hotella-agent opera-db probe` passes (objects, columns, privileges, counts; no personal data printed).
- [ ] Commissioning run of the `OPERA5_DB` connector PASSED.

## 9. IFC8 / FIAS
- [ ] IFC8 licence for a generic FIAS vendor interface; interface number; Hotella's own IFC8 instance (guide §7.4).
- [ ] The hotel's Interface Sheet compared with the **Planova Standard Profile v1** row by row in the commissioning
      tab; every required row MATCH or the gap accepted (guide §16.2).
- [ ] Profile coverage after a day of traffic shows no unexpected gaps; database swap tested.

## 10. OWS (when the hotel has it)
- [ ] Licence and version (5.1), URL over HTTPS, OGHeader entities and domain, dedicated user with the standard rights.
- [ ] Commissioning run with the hotel's test reservation and profile PASSED; contact write verified with the hotel
      present if wanted (guide §16.3).

## 11. Integration testing (on site, guide §17)
- [ ] Check-in, room move, guest change, check-out on a test reservation; room status both ways (if verified).
- [ ] IFC8 restart and an internet outage: no message lost, order kept, backlog drained.
- [ ] Reconciliation from the database snapshot: all MATCH.
- [ ] Capabilities verified and every connector signed off; the commissioning checklist shows **Ready for go-live**.

## 12. Module testing
- [ ] Mappings confirmed (rooms, room types, VIP, market, rate codes); no open integration exception.
- [ ] Guest activation and requests (guest web, WhatsApp if used); housekeeping board; engineering work orders;
      inspections; guest relations; lost & found; logbook — each smoke-tested in English and Arabic with the
      property's real configuration.
- [ ] Roles and staff accounts created; MFA for managers.
- [ ] The hotel's structure (property, buildings, floors, room types, rooms, departments) created from its profile with
      `pilot.sh provision` and no `TBD` left (`docs/pilot/README.md`); the status of each hotel in
      `docs/pilot/<hotel>/README.md`.

## 13. AI configuration
- [ ] Providers (Anthropic / OpenAI) with keys in OpenBao; routing per capability; monthly budget (default 100 USD per
      hotel); kill switches tested.
- [ ] Guest AI and staff assistants enabled only where the hotel wants them; knowledge documents published.
- [ ] **Lost & Found vision**: off unless the property enables it (owner decision); if enabled, the provider and the
      privacy note agreed with the hotel.

## 14. Licensing
- [ ] Tenant created; plan version published; subscription active for the property (or a trial); entitlements shown
      in the control plane match the contract.
- [ ] Agent licences VALID (issued only for entitled connectors).
- [ ] Offline behaviour understood and tested: agent licence grace; the platform's last-known-good entitlements
      (72 h, `LICENSING_STALE_GRACE_HOURS`); for an on-site installation, the installation registered in the control
      plane, its key in the site's OpenBao, the platform key pinned, a first bundle renewed and its grace (7 + 30 days)
      agreed in the contract (ADR-0021).

## 15. Offline behaviour (test it, do not assume it)
- [ ] Hotel internet down 30 minutes: OPERA unaffected; agent queues; on return everything arrives once, in order.
- [ ] Planova platform restart: agents reconnect on their own; nothing lost.
- [ ] Agent host reboot: service starts by itself; queue intact.

## 16. Backup and recovery
- [ ] Scheduled pgBackRest full/differential backups; off-site copy after each full backup.
- [ ] A restore drill done on a scratch host (`docs/runbooks/backup-restore.md`) — RPO ≤ 15 min, RTO ≤ 2 h.
- [ ] OpenBao storage and the `.secrets` material backed up encrypted and offline.

## 17. Logging and monitoring
- [ ] Logs (no personal data) and metrics/traces in the Grafana stack; alerts for agent offline, integration health
      DEGRADED/OFFLINE, queue depth, backup failure, disk space, certificate expiry, AI budget — the platform monitor
      (`hotella monitor`, every 5 minutes; `docs/runbooks/monitoring.md`) with a destination set (`hotella alert-setup`)
      and its test message received.
- [ ] Who is on call, and how the hotel reports a problem.

## 18. Rollback
- [ ] Platform: previous release images kept; `docs/runbooks/rollback.md` rehearsed.
- [ ] Agent: signed update with automatic rollback; previous MSI kept.
- [ ] Integration: disabling a connector or a write capability is one action in the control plane; OPERA is never
      changed by Hotella, so stopping Hotella leaves the hotel as it was (guide §19).
- [ ] Rollback contacts and steps agreed with the hotel (recorded on the commissioning sheet).

## 19. Acceptance testing
- [ ] The phase acceptance documents' 🟡 items checked at this hotel (`docs/acceptance/*.md`).
- [ ] A week of live traffic with daily reconciliation all MATCH; staff sign-off per department.
- [ ] Go-live decision recorded (who, when).
