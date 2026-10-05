# Sea Beach Edge — pilot readiness

**First pilot hotel** (owner, 2026-10-05). Checklist: [`../PILOT_READINESS_CHECKLIST.md`](../PILOT_READINESS_CHECKLIST.md)
v1. Profile: [`profile.json`](profile.json). It does not validate yet: `node infra/docker/pilot/provision.mjs --check
docs/pilot/sea-beach-edge/profile.json` lists the `TBD` values left to fill.

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
| 12 | Hotel structure and modules | 🔧 / ⛔ hotel | Structure: `pilot.sh provision` (P.1, CI pilot smoke), waiting for the profile data below. Staff accounts and the service catalog have no screens yet (P.3). |
| 13 | AI configuration | ⛔ owner | Provider keys in OpenBao (Anthropic / OpenAI) and the budget (default 100 USD per month). |
| 14 | Licensing | ✅ | `pilot.sh provision` licenses the tenant with `PILOT_ALL` for the pilot. The commercial plan is the owner's decision. |
| 15 | Offline behaviour | ✅ / ⛔ | Proven in CI (agent queue, reconnect, offline entitlements). To be repeated on site. |
| 16 | Backup and restore | ✅ / ⛔ owner | pgBackRest and a restore drill (CI). An off-site copy location is needed. |
| 17 | Monitoring and alerts | 🔧 | Logs, metrics and traces exist (Grafana stack). The alert rules are not built yet (P.2). |
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
3. Engineering: P.2 monitoring and alerts; P.3 hotel administration screens (staff accounts and roles, service
   catalog).
4. On site: `pilot.sh provision`, enrollment and commissioning, then the §11–§15 tests.
