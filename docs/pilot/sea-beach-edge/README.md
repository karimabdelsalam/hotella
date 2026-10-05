# Sea Beach Edge — pilot readiness

**First pilot hotel** (owner, 2026-10-05). Checklist: [`../PILOT_READINESS_CHECKLIST.md`](../PILOT_READINESS_CHECKLIST.md)
v1.

> **DEMO DATA (owner, 2026-10-06).** Until the hotel answers §2, [`profile.json`](profile.json) and
> [`demo.json`](demo.json) hold demo values, so the platform can be tried end to end. The values are:
> - Egypt, Cairo time, EGP, English by default;
> - 50 rooms in a main building and beach villas, 5 room types, 7 departments;
> - 9 staff accounts, one per role;
> - the starter services, two à la carte restaurants, hotel information for the concierge and the brand;
> - a simulated PMS with 8 fictional stays: 6 in house, 1 arriving, 1 checked out.
>
> Everything is marked `demo`, and every name and e-mail is fictional (`@seabeachedge.example`). Section 4 shows how
> to set it all up on a server in one command, and how to replace the demo data with the hotel's own.

| Code | Value |
|---|---|
| Tenant | `SEA_BEACH_EDGE` — "Sea Beach Edge" (rename it if the hotel belongs to a company or group) |
| Property | `SBE` — "Sea Beach Edge" |
| Languages | English, Arabic, Italian, Russian, German (all five; owner, 2026-10-05) |

Legend: ✅ ready (evidence) · 🔧 Planova engineering, planned · ⛔ waiting for the hotel or the owner · n/a.

## 1. Status by checklist section

| § | Item | Status | Evidence or next step |
|---|---|---|---|
| 1.1 | Planova platform server | ⛔ owner | A host to the §1.1 sizing (8 vCPU, 32 GB, 500 GB NVMe + 1 TB backup), with DNS names and TLS certificates. The install is one command (`infra/install`, CI job "Ubuntu one-command install"). |
| 1.2 | Hotel agent host | ⛔ hotel | An always-on Windows or Linux machine (VM is fine) in the hotel LAN with reach to IFC8, the OPERA DB listener and OWS. |
| 2 | Agent MSI | ✅ / ⛔ owner | The MSI is built and tested in CI (WiX v5). The Authenticode certificate is open (Q16); until it exists, SmartScreen warns once and the hotel must agree to that. |
| 3 | Agent services | ✅ | One service per connector, with automatic restart (MSI CI job). |
| 4 | Platform database | ✅ | `pilot.sh migrate`; the application runs as an RLS-bound role (CI pilot smoke). |
| 5 | Network and firewall | ⛔ hotel | Outbound 443/8443 from the agent host to Planova; LAN access to IFC8, Oracle 1521 and OWS. Nothing inbound. |
| 6 | TLS | ⛔ owner | Public certificates for the API, staff, guest and agent-gateway names. |
| 7 | OpenBao | ✅ / ⛔ owner | `pilot.sh vault-init` (CI). Three unseal-key custodians must be named. |
| 8 | OPERA database (read-only) | ⛔ hotel | The DBA creates `HOTELLA_RO` from the grant script (OPERA guide §6.2). |
| 9 | IFC8 / FIAS | ⛔ hotel | IFC8 licence for a generic FIAS interface, an interface number, and the Interface Sheet. |
| 10 | OWS | ⛔ hotel | Optional: whether the hotel has it, its version, URL and user. |
| 11 | On-site integration tests | ⛔ | After §8–§10. |
| 12 | Hotel structure and modules | ✅ demo / ⛔ hotel | `infra/install/sea-beach-edge.sh` sets up the demo hotel (CI job "Ubuntu one-command install"). The hotel's administrator manages staff and roles (*Staff*) and services (*Services*) in the staff web (P.3). Real data waits for §2. |
| 13 | AI configuration | ⛔ owner | Provider keys in OpenBao (Anthropic / OpenAI) and the budget (default 100 USD per month). |
| 14 | Licensing | ✅ | `pilot.sh provision` licenses the tenant with `PILOT_ALL` for the pilot. The commercial plan is the owner's decision. |
| 15 | Offline behaviour | ✅ / ⛔ | Proven in CI (agent queue, reconnect, offline entitlements). To be repeated on site. |
| 16 | Backup and restore | ✅ / ⛔ owner | pgBackRest and a restore drill (CI). An off-site copy location is needed. |
| 17 | Monitoring and alerts | ✅ / ⛔ owner | `hotella monitor` every 5 minutes (P.2, `docs/runbooks/monitoring.md`). Choose where alerts go (Telegram or webhook) with `hotella alert-setup`, and who is on call. |
| 18 | Rollback | ✅ | `docs/runbooks/rollback.md`; the agent's signed update with rollback. |
| 19 | Acceptance | ⛔ | One week of live traffic and sign-off by each department. |
| — | Staff app "Hotella" (pushes) | ⛔ owner | Firebase project and store accounts (Q19). |
| — | Italian, Russian and German texts | ⛔ owner | Native-speaker review (Q17) before guests see them. |
| — | Voice, building systems, keys, POS, ERP | n/a | Phase 13 extras are future development (owner, 2026-10-05). The pilot runs without them. |

## 2. Questions for the hotel (fills `profile.json`)

**About the hotel**
1. Legal or company name. Does the hotel belong to a group that may add more hotels later?
2. Country, city and time zone.
3. Currency used on guest bills.
4. Default language for staff and guests. Which guest languages matter most?
5. The hotel's logo (SVG or PNG) and brand colours.
6. Contact details shown to guests: phone, WhatsApp and e-mail.

**Rooms**
7. Buildings or wings, with their names.
8. Floors in each building, and how staff name them (e.g. "Ground", "1").
9. Room numbers on each floor, as ranges (e.g. 101–124), plus any special numbers (suites, villas).
10. Room types with OPERA's codes, capacity and names.
11. Public areas used for requests or inspections (lobby, pool, beach, restaurants).

**Departments and people**
12. Departments beyond housekeeping, engineering and front office (e.g. guest relations, F&B, spa, security).
13. Who is the hotel's system administrator?
14. How many staff per department will use Hotella? Which roles do they have? (Names and e-mails are entered on the
    platform, never sent in documents.)
15. Shift times and the hour stayover cleaning starts.

**Systems**
16. OPERA version. Who is the OPERA administrator and the DBA?
17. IFC8: is a generic FIAS interface licence available? Interface number and the Interface Sheet.
18. OWS: available? Version and URL.
19. The machine for the hotel agent (Windows or Linux, always on, on the LAN).
20. Internet: speed, and whether there is a second line or LTE backup.
21. WhatsApp: which number guests should write to, whether it is already on WhatsApp Business, and Meta Business
    verification status.
22. SMS provider for one-time codes, if the hotel already has one.

**Services and content**
23. The guest services to offer at launch (towels, cleaning, maintenance, late check-out, …) and which department
    handles each.
24. Hotel information for the AI concierge: facilities, opening hours, policies and FAQs (documents).
25. À la carte restaurants: names, opening times, capacity, and the allowance per stay.

## 3. Next steps
1. Collect the answers to §2 and fill `profile.json` (only structure; nothing personal).
2. The owner decides on the platform server, DNS and TLS, OpenBao custodians, AI keys, Firebase (Q19) and the Italian,
   Russian and German review (Q17).
3. Engineering: done (P.1 provisioning, P.2 monitoring and alerts, P.3 hotel administration screens).
4. On site: `pilot.sh provision`, enrollment and commissioning, then the §11–§15 tests.

## 4. Setting it up on a server (demo)

On a fresh Ubuntu 22.04/24.04 server, after pointing `api.`, `staff.`, `guest.` and `agent.<domain>` at it:

```bash
git clone https://github.com/karimabdelsalam/hotella.git && cd hotella
sudo bash infra/install/sea-beach-edge.sh --domain <domain> --email <your e-mail>
# no domain yet (a VM or a laptop):  sudo bash infra/install/sea-beach-edge.sh --local --email <your e-mail>
```

At the end it prints the URLs, the platform administrator's password (once), and where the demo accounts are:
`sudo cat /opt/hotella/infra/docker/pilot/.secrets/demo/accounts.json`. The file has the hotel code
(`SEA_BEACH_EDGE`), each e-mail, its role and its password. Sign in to the staff web with the hotel code. The general
manager is `gm@seabeachedge.example`.

Then:
- `sudo hotella alert-setup telegram` sets where alerts go.
- `sudo hotella monitor --dry-run` shows the platform's state now.

The demo stays come from the simulated PMS. The guest web and the room QR sheet work with them. AI answers need a
provider key (checklist §13).

## 5. From demo to the hotel's real data
1. **Structure.** Put the hotel's answers into `profile.json`, remove `"demo": true` and run
   `sudo hotella provision docs/pilot/sea-beach-edge/profile.json <token>`. New rooms, types and departments are added.
   Demo rooms that do not exist at the hotel must be retired by the administrator; codes are never reused for something
   else.
2. **People.** The hotel's administrator invites the real staff (*Staff* → *Invite a person*) and disables every
   `@seabeachedge.example` account. Disabling signs it out everywhere.
3. **Services, restaurants, information.** The hotel edits and publishes its own (*Services*, *Restaurant* →
   *Setup*). The demo information document is archived.
4. **PMS.** The control plane sets *Demo PMS (simulator)* to DISABLED. The real OPERA connectors are enrolled and
   commissioned (OPERA guide §16). The demo stays stay in history as checked-in data of the simulator. Before go-live,
   a fresh tenant can be provisioned instead if the hotel prefers no demo history (an owner decision).
