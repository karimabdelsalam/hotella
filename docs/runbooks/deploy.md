# Deploy the pilot

## Host prerequisites
- Ubuntu Server LTS (or Debian stable), unattended security upgrades on, SSH keys only, no password logins.
- Docker Engine with the Compose plugin; the operator account is in the `docker` group.
- Firewall: only 443/tcp, the agent gateway port (8443/tcp, `HOTELLA_AGENT_PORT`) and SSH from the admin network are reachable from outside. The API listens on `127.0.0.1:3000` and staff reach it through the reverse proxy; hotel agents (ADR-0017) connect to the agent gateway, which terminates its own mutual TLS and must **not** sit behind the reverse proxy. Set `HOTELLA_AGENT_HOSTNAME` before `pilot.sh init` so the gateway certificate names the public agent hostname.
- A TLS reverse proxy on the host (Caddy or NGINX) for the public name, e.g. `https://api.<customer>.hotella.app` → `http://127.0.0.1:3000` with HSTS. Certificates from the internal CA or a public CA depending on exposure.
- Disk: separate volume for Docker data with room for the PostgreSQL data, the pgBackRest repository (≈ 4 full backups + WAL) and object storage.

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
