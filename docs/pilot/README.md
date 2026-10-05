# Pilot hotels

How a pilot hotel is prepared. The checklist to take to the hotel is
[`PILOT_READINESS_CHECKLIST.md`](PILOT_READINESS_CHECKLIST.md). Each hotel has a folder here with its profile and its
readiness status:

| Hotel | Folder | Status |
|---|---|---|
| Sea Beach Edge (first pilot) | [`sea-beach-edge/`](sea-beach-edge/README.md) | demo data; collecting the hotel's own |

Nothing about a hotel is in code (CLAUDE.md rule 15). Its names, rooms and settings are in its profile; its brand,
services, staff and knowledge are entered on the platform by Planova or by the hotel.

## 1. The hotel profile (version 1)

A JSON file describing the hotel's structure.

| Field | Meaning |
|---|---|
| `profileVersion` | `1` |
| `demo` | optional, `true` while the values are demo data (the provisioner says so in its output) |
| `tenant` | `{ code, name }` — the customer account (a hotel company or group). Codes are 2–32 of `A–Z 0–9 _ -` and never change. |
| `property` | `{ code, name, timezone, currency, country, defaultLocale, enabledLocales }`. The timezone is an IANA zone (e.g. `Africa/Cairo`), the currency ISO 4217 (`EGP`), the country ISO 3166 alpha-2 (`EG`). Locales are `en ar it ru de`. |
| `roomTypes[]` | `{ code, capacity, names }`. `code` is the hotel's own room-type code; the PMS mapping links it to OPERA later. |
| `buildings[]` | `{ code, names, floors[] }`. Each floor is `{ code, names, floorLabel?, rooms[] }`; a room entry is a range `{ from, to, roomType? }` or one room `{ number, roomType? }` (for numbers such as `P1` or `1012A`). |
| `departments[]` | `{ code, names }`. `HK`, `ENG` and `FO` are required: housekeeping, engineering and front-office work is routed to them by code. |
| `settings[]` | `{ key, value }` — property settings from the configuration catalog (`GET /config/definitions`), e.g. `hk.stayover.hour`. |

`names` is `{ en, ar, it, ru, de }`, and `en` is required. Any value still unknown is written `TBD`. The provisioner
lists every `TBD` and refuses to apply the profile, so nothing is guessed (rule 16). The example
[`infra/docker/pilot/profiles/example.json`](../../infra/docker/pilot/profiles/example.json) is the one the CI pilot
smoke applies.

The profile is structure only. The platform administrator's role has no right to the hotel's content (Spec §64), so
the hotel's administrator adds these:
- the service catalog;
- staff accounts and roles;
- knowledge documents;
- restaurants;
- the brand.

Personal data (staff names, e-mails, phone numbers) never goes into a profile or this repository.

## 2. Applying it

On the Planova server, after the stack is up and a platform administrator exists (`docs/runbooks/deploy.md`):

```bash
node infra/docker/pilot/provision.mjs --check docs/pilot/<hotel>/profile.json   # optional (Node.js 22+); the next step checks too
token=$(curl -fsS localhost:3000/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"<admin e-mail>","password":"<password>"}' | jq -r .accessToken)
infra/docker/pilot/pilot.sh provision docs/pilot/<hotel>/profile.json "$token"
```

`pilot.sh provision` runs these steps in order:
1. Validates the profile.
2. Creates the tenant.
3. Licenses it for the pilot with every module (`license-pilot.sh`, plan `PILOT_ALL`; the commercial plan replaces it
   later).
4. Creates the property, room types, buildings, floors, rooms and departments, and applies the settings.

Run it again whenever the profile grows. What exists is kept, only what is missing is created, and an unchanged
setting is not written again. Everything goes through the normal API, so it is permission-checked and audited, and
row-level security applies.

The run ends with one line, `result {…}`, giving the tenant and property ids and the counts created and already
present. The token is never printed.

## 3. After provisioning

These steps are in checklist order:
1. Brand (`/branding`).
2. The hotel's administrator invited, with MFA.
3. Staff accounts and roles.
4. The service catalog (`POST /properties/{id}/catalog/starter`, then the hotel's own services).
5. The OPERA connectors: enrollment codes, the agent MSI, mappings and commissioning (`docs/runbooks/agent-enrollment.md`,
   OPERA guide §16).
6. Channels: WhatsApp and SMS.
7. AI providers and budget.
8. Room QR sheet.

Then the on-site tests of checklist §11–§15.

## 4. Demo content

To try a hotel before its data arrives, a demo file next to its profile adds fictional content:
- brand;
- staff accounts, one per role;
- the starter services, restaurants with sittings, and hotel information documents;
- a simulated PMS with stays dated from today.

The tool is `infra/docker/pilot/demo-content.mjs`, run with
`pilot.sh demo <profile.json> <demo.json> <token>`. It works through the API:
- The brand, the accounts and the simulated PMS are created as the platform administrator.
- The hotel's content is entered as the demo general manager, because the platform administrator may not touch it.

The generated passwords are kept only in `.secrets/demo/accounts.json` (0600) and are never printed. The tool is
idempotent.

`infra/install/sea-beach-edge.sh` runs the installer with `--hotel` and `--demo` for the first pilot. Its CI job
installs the whole demo hotel on a fresh Ubuntu runner and signs in as its manager. Replacing demo data with real data:
`sea-beach-edge/README.md` §5.
