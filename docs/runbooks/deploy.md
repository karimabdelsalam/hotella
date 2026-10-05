# Deploy the pilot

## Host prerequisites
- Ubuntu Server LTS (or Debian stable), unattended security upgrades on, SSH keys only, no password logins.
- Docker Engine with the Compose plugin; the operator account is in the `docker` group.
- Firewall: only 443/tcp, the agent gateway port (8443/tcp, `HOTELLA_AGENT_PORT`) and SSH from the admin network are reachable from outside. The API listens on `127.0.0.1:3000` and staff reach it through the reverse proxy; hotel agents (ADR-0017) connect to the agent gateway, which terminates its own mutual TLS and must **not** sit behind the reverse proxy. Set `HOTELLA_AGENT_HOSTNAME` before `pilot.sh init` so the gateway certificate names the public agent hostname.
- A TLS reverse proxy on the host (Caddy or NGINX) for the public names, e.g. `https://api.<customer>.hotella.app` → `http://127.0.0.1:3000`, the staff portal → `http://127.0.0.1:3100` and the guest web app (`{property}.guest.hotella.app`, BUILD_PLAN Q4; set `HOTELLA_PUBLIC_BASE_URL` to it so activation links and room QR codes open it) → `http://127.0.0.1:3200`, all with HSTS. Certificates from the internal CA or a public CA depending on exposure.
- Disk: separate volume for Docker data with room for the PostgreSQL data, the pgBackRest repository (≈ 4 full backups + WAL) and object storage.

## One-command installation (Ubuntu 22.04 / 24.04)
Point the DNS A records `api.`, `staff.`, `guest.` and `agent.<domain>` at the server, then:
```bash
git clone https://github.com/karimabdelsalam/hotella.git /opt/hotella      # private repo: use a read-only token
sudo bash /opt/hotella/infra/install/install-ubuntu.sh --domain hotel.example.com --email you@planova.example
```
It checks the host, installs Docker, Caddy (Let's Encrypt certificates, HSTS), ufw (SSH, 80, 443, 8443 only) and
unattended upgrades, runs every step of "First installation" below, creates the first administrator (password from
`$HOTELLA_ADMIN_PASSWORD`, or generated and shown once), takes the first full backup, schedules nightly backups
(`/etc/cron.d/hotella`) and installs the `hotella` command (`sudo hotella status|unseal|start|backup full|…`, the same
as `pilot.sh`). It is safe to run again. `--local` installs on localhost without a domain (a laptop or a VM). Then do
"Immediately after the first installation" below — the installer leaves the OpenBao unseal keys on the host for you
to move.

For the first pilot hotel with its demo data, `sudo bash infra/install/sea-beach-edge.sh --domain <domain> --email
<e-mail>` runs the same installer and then creates Sea Beach Edge and its demo content (`docs/pilot/sea-beach-edge/`
§4). Any hotel: `install-ubuntu.sh --hotel <profile.json> [--demo <demo.json>]`.

## One name for the company panel (`--host`)

Hotella is one SaaS installation for every hotel.
- **Planova's control panel** (tenants, licences, plans) is the staff web's `/control`, for platform administrators.
- **Each hotel's staff** sign in to the same site with their hotel code.
- **Guests** use the guest site.

By default the installer publishes four names under `--domain`: `staff.`, `api.`, `guest.`, `agent.`. With
`--host crm.example.com --guest-host guest.example.com` it uses one name for the panel instead:

| Name | Serves |
|---|---|
| `crm.example.com` | the staff web and control panel |
| `crm.example.com/api/…` | the API: realtime, webhooks, developer API |
| `crm.example.com:8443` | the hotel agents (mutual TLS, never proxied) |
| `guest.example.com` | the guests' site (QR codes and activation links) |

Only two DNS records are needed. The guests' site keeps its own name because it is a separate app. The agent gateway's
certificate takes the name given at the first installation (`HOTELLA_AGENT_HOSTNAME`); changing it later is a
certificate rotation (secret-rotation runbook).

## Sharing a server with other systems

Hotella runs as its own Docker Compose project (`hotella-pilot`). Its containers, volumes and internal network are
separate from anything else on the host. Its web ports are bound to `127.0.0.1` only. The exception is the hotel
agents' gateway, which must be reachable from the hotels (`HOTELLA_AGENT_PORT`, default 8443).

On a server that already runs other systems, install with `--shared`:

```bash
sudo bash infra/install/sea-beach-edge.sh --shared --domain <domain> --email <e-mail> \
  [--api-port 3000 --staff-port 3100 --guest-port 3200 --agent-port 8443]
```

| What the installer normally does | With `--shared` |
|---|---|
| Installs Caddy and writes `/etc/caddy/Caddyfile` | Untouched. Writes `infra/docker/reverse-proxy.nginx.conf` and `reverse-proxy.Caddyfile` with the chosen ports for **your** proxy |
| Enables ufw with only SSH, 80, 443 and the agent port | Untouched. If ufw is already active, only the agent port is allowed (other rules stay as they are) |
| Refuses when 80/443 are taken | 80/443 belong to your proxy. Only Hotella's own ports are checked, and a busy one names the option to move it |
| Sets the host's automatic security updates | Left as the server has them |
| Docker | Reuses the Docker already installed, or installs it |

Then add the three sites to your proxy:
- **nginx:** copy the example to `/etc/nginx/conf.d/hotella.conf`, run `nginx -t && systemctl reload nginx`, then
  `certbot --nginx -d api.<domain> -d staff.<domain> -d guest.<domain>`.
- **Caddy:** paste the example into your Caddyfile.

The proxy must pass WebSocket upgrades for `api.` (realtime). Open the agent port to the internet, and never proxy it:
the gateway terminates mutual TLS itself.

**Small servers (demo or trial).** From 2 vCPU, 8 GB RAM and 40 GB of disk, the installer runs as a demo/trial
installation. It warns, adds 4 GB of swap when the server has none, and builds the images with two tasks at a time
(`HOTELLA_BUILD_CONCURRENCY=2` in `infra/docker/.env`). The running platform needs about 4 GB. A live hotel needs the
pilot baseline. Below 8 GB the installer stops unless `--skip-checks` is given.

**Sizing on a shared host.** The pilot baseline (checklist §1.1: 8 vCPU, 32 GB) is for Hotella alone. Add what the
other systems use, or install with `--skip-checks` knowingly and watch `hotella monitor`. To isolate Hotella fully (its
own kernel limits, firewall and Docker), run the same command inside a VM or a system container (Incus/LXD with
`security.nesting=true`) instead. Docker-in-Docker is not supported.

## First installation
```bash
git clone <repo> /opt/hotella && cd /opt/hotella        # or unpack the release bundle
infra/docker/pilot/pilot.sh init          # credentials, pilot CA, service configs → infra/docker/pilot/.secrets (0700)
infra/docker/pilot/pilot.sh up            # builds images (or uses HOTELLA_VERSION from the registry), starts postgres, valkey, s3, openbao
infra/docker/pilot/pilot.sh vault-init    # OpenBao: init (3 shares / threshold 2), unseal, KV v2, read-only policy, AppRoles, app secrets
infra/docker/pilot/pilot.sh migrate       # migrations as hotella_admin, then grants for hotella_app
infra/docker/pilot/pilot.sh start         # api + worker, waits for /api/v1/ready
infra/docker/pilot/pilot.sh admin you@planova.example You   # first platform administrator (password prompted, never echoed)
infra/docker/pilot/pilot.sh backup full   # first full backup; also proves WAL archiving works
infra/docker/pilot/pilot.sh provision docs/pilot/<hotel>/profile.json <admin token>
                                          # the hotel from its profile: tenant + pilot licence, property, rooms, departments (docs/pilot/README.md)
```

### Immediately after the first installation (manual)
1. Move `infra/docker/pilot/.secrets/openbao-init.json` (unseal keys + root token) **off the host**: print the three unseal keys for three different custodians, store the file encrypted in the company password vault, delete it from the host. Keep `pilot.sh unseal` usable by giving two custodians a procedure to paste their keys (`docker compose -p hotella-pilot -f infra/docker/compose.pilot.yml exec openbao bao operator unseal`).
2. Revoke the root token once configuration is done: `bao token revoke <root>`; create a new one only with `bao operator generate-root` when needed (see secret-rotation.md).
3. Back up `infra/docker/pilot/.secrets` (encrypted, offline). It contains the admin database password and the material OpenBao was seeded from.
4. Install the backup schedule (backup-restore.md) and confirm the first scheduled run in `pilot.sh status`.
5. Staff e-mail (escalations, approvals): add `NOTIFY_SMTP_HOST`, `NOTIFY_SMTP_PORT`, `NOTIFY_SMTP_USER`, `NOTIFY_EMAIL_FROM` and `NOTIFY_SMTP_PASSWORD_REF: vault://kv/hotella/app#smtp_password` to the app environment of `compose.pilot.yml` and put the password into OpenBao (`bao kv patch kv/hotella/app smtp_password=…`). Until then e-mail deliveries are recorded as skipped (`channel_not_configured`) and staff rely on the in-app inbox; nothing else changes.

6. Guest messaging (Phase 4): create the property's channels as a general manager (`POST /api/v1/properties/{p}/channels`)
   with the provider's configuration and a `credentialRef` pointing at OpenBao (`bao kv patch kv/hotella/app
   whatsapp_<property>='{"accessToken":"…","appSecret":"…","verifyToken":"…"}'`; BSP/SMS: `{"apiKey":"…","webhookSecret":"…"}`),
   then register the webhook URL with the provider: `https://<public host>/api/v1/webhooks/whatsapp/{channelId}`
   (Meta: same URL for the verification handshake; BSP/SMS: add the header `X-Hotella-Webhook-Secret`). Approve the
   `otp`, `activation` and `service_update` (request updates: service name, status) templates with the provider and
   map them in the channel's `config.templates`. Any reverse
   proxy in front of the API must pass WebSocket upgrades on `/api/v1/realtime` (staff inbox and guest chat updates).
   Print room QR codes from `POST /api/v1/properties/{p}/room-qr-codes/sheet` (printing rotates the codes).

## Upgrade to a new release
```bash
infra/docker/pilot/pilot.sh backup full                 # always, before anything else
export HOTELLA_VERSION=<release tag>                    # images built by CI and pushed to the private registry
docker compose -p hotella-pilot -f infra/docker/compose.pilot.yml pull api worker migrate
infra/docker/pilot/pilot.sh migrate                     # forward-only, expand/contract (ADR-0002)
infra/docker/pilot/pilot.sh start                       # recreates api/worker with the new images, waits for readiness
```
Releases that introduce a new secret say so in their notes. Add it to OpenBao **before** `start`, with `kv patch`
(never rewrite the whole `kv/hotella/app` secret: values added by hand, such as `smtp_password`, would be lost). The
Phase 4 release needs the guest OTP key: `bao kv patch kv/hotella/app otp_hmac_key="$(openssl rand -base64 32)"`
(fresh installations get it from `pilot.sh init`). Without it guests cannot receive codes (`comms.otp.unavailable`).
The Phase 11 release (developer platform) needs the webhook signing key:
`bao kv patch kv/hotella/app webhook_signing_key="$(openssl rand -base64 32)"`. Never change it afterwards: every
tenant's webhook secret derives from it, so a new key silently invalidates all of them (tenants rotate one endpoint at a
time instead).

Read the release notes first: a release that contains a *contract* migration (dropping a column) requires that the previous release was already running the *expand* step; never skip releases that say so.

## After a host reboot
OpenBao starts sealed. Until it is unsealed the API and worker cannot read their secrets and stay unready:
```bash
infra/docker/pilot/pilot.sh unseal     # or two custodians run `bao operator unseal` with their keys
infra/docker/pilot/pilot.sh start
```

## Health
- `GET /api/v1/health` — process alive (no dependencies). `GET /api/v1/ready` — PostgreSQL and Valkey reachable; 503 with per-dependency details otherwise.
- `pilot.sh status` — containers, readiness, backup inventory.
- Observability stack (optional profile): `docker compose -p hotella-pilot -f infra/docker/compose.pilot.yml --profile observability up -d otel-lgtm`, set `HOTELLA_OTEL_ENABLED=true`, Grafana on `127.0.0.1:3003`.
