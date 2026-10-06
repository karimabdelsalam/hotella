#!/usr/bin/env bash
# Hotella — one-command installation on a fresh Ubuntu server (22.04 or 24.04 LTS).
#
# What it does (safe to run again; every step skips what is already done):
#   1. checks the host (Ubuntu LTS, root, CPU/RAM/disk, ports 80/443/8443 free)
#   2. installs Docker Engine + Compose (Docker's apt repository), Caddy (automatic HTTPS), ufw, unattended upgrades
#   3. puts the code in /opt/hotella (this checkout, or a clone of --repo/--ref)
#   4. runs the pilot deployment: credentials → images → OpenBao → migrations → api, worker, agent gateway, web apps
#   5. publishes https://api.<domain>, https://staff.<domain>, https://guest.<domain> through Caddy (Let's Encrypt) and
#      the hotel-agent gateway on agent.<domain>:8443 (mutual TLS, not behind the proxy)
#   6. creates the first platform administrator, the first full backup, the backup schedule and the platform monitor
#   7. with --hotel: creates the hotel from its profile (and with --demo, its demo content)
#
# Quick start (DNS A records for api., staff., guest. and agent.<domain> must point at this server first):
#   sudo bash infra/install/install-ubuntu.sh --domain hotel.example.com --email you@example.com
# From nothing (private repository: export GITHUB_TOKEN=<read-only token> first):
#   curl -fsSL https://raw.githubusercontent.com/karimabdelsalam/hotella/main/infra/install/install-ubuntu.sh \
#     | sudo -E bash -s -- --domain hotel.example.com --email you@example.com
# Trying it on a laptop or a VM without a domain (everything on 127.0.0.1, no HTTPS):
#   sudo bash infra/install/install-ubuntu.sh --local --email you@example.com
#
# Options:
#   --domain D        base domain; the names api., staff., guest. and agent. are created under it
#   --host H          instead of four names: one name for the company panel (staff web + control plane), with the API
#                     under H/api and the hotel agents on H:8443 — e.g. crm.example.com
#   --guest-host G    the guests' site (default guest.<domain>, or guest.<host> with --host)
#   --email E         first platform administrator and the Let's Encrypt contact
#   --admin-name N    the administrator's given name (default: Admin)
#   --local           no domain, no reverse proxy, no firewall changes: everything on localhost
#   --shared          a server that already runs other systems: no Caddy, no firewall changes; your own reverse
#                     proxy serves api., staff., guest.<domain> (an nginx and a Caddy example are written for you)
#   --api-port P --staff-port P --guest-port P --agent-port P
#                     host ports (defaults 3000, 3100, 3200, 8443) when other systems already use them
#   --dir PATH        installation directory (default: /opt/hotella)
#   --repo URL        git repository to clone when not run from a checkout
#   --ref REF         branch or tag to install (default: main)
#   --hotel FILE      a hotel profile to provision after the installation (docs/pilot/README.md)
#   --demo FILE       demo content for that hotel: staff accounts, services, restaurants, simulated guests
#   --skip-checks     install even below the recommended CPU/RAM/disk
#   -h, --help        this text
#
# The administrator's password is read from $HOTELLA_ADMIN_PASSWORD, else generated and shown once at the end.
set -euo pipefail

DOMAIN=""
PANEL_HOST=""
GUEST_HOST=""
EMAIL=""
ADMIN_NAME="Admin"
LOCAL=false
DIR="/opt/hotella"
REPO="https://github.com/karimabdelsalam/hotella.git"
REF="main"
SKIP_CHECKS=false
HOTEL=""
DEMO=""
SHARED=false
API_PORT=3000
STAFF_PORT=3100
GUEST_PORT=3200
AGENT_PORT=8443

say() { printf '\033[1;36m[hotella]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[hotella] warning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[hotella] error:\033[0m %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,42p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:?}"; shift 2 ;;
    --host) PANEL_HOST="${2:?}"; shift 2 ;;
    --guest-host) GUEST_HOST="${2:?}"; shift 2 ;;
    --email) EMAIL="${2:?}"; shift 2 ;;
    --admin-name) ADMIN_NAME="${2:?}"; shift 2 ;;
    --local) LOCAL=true; shift ;;
    --shared) SHARED=true; shift ;;
    --api-port) API_PORT="${2:?}"; shift 2 ;;
    --staff-port) STAFF_PORT="${2:?}"; shift 2 ;;
    --guest-port) GUEST_PORT="${2:?}"; shift 2 ;;
    --agent-port) AGENT_PORT="${2:?}"; shift 2 ;;
    --dir) DIR="${2:?}"; shift 2 ;;
    --repo) REPO="${2:?}"; shift 2 ;;
    --ref) REF="${2:?}"; shift 2 ;;
    --hotel) HOTEL="$(realpath "${2:?}")"; shift 2 ;;
    --demo) DEMO="$(realpath "${2:?}")"; shift 2 ;;
    --skip-checks) SKIP_CHECKS=true; shift ;;
    -h | --help) usage 0 ;;
    *) warn "unknown option: $1"; usage 1 ;;
  esac
done

# ---------------------------------------------------------------- 1. the host
[ "$(id -u)" -eq 0 ] || die "run as root: sudo bash $0 …"
[ -z "$HOTEL" ] || [ -s "$HOTEL" ] || die "no such hotel profile: $HOTEL"
for p in "$API_PORT" "$STAFF_PORT" "$GUEST_PORT" "$AGENT_PORT"; do
  [[ "$p" =~ ^[0-9]+$ ]] && [ "$p" -ge 1024 ] && [ "$p" -le 65535 ] || die "not a usable port: $p (1024–65535)"
done
! { $SHARED && $LOCAL; } || die "--shared and --local exclude each other"
[ -z "$DEMO" ] || { [ -n "$HOTEL" ] && [ -s "$DEMO" ]; } || die "--demo needs --hotel and an existing file"
[ -n "$EMAIL" ] || die "--email is required (the first platform administrator)"
[[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "--email does not look like an e-mail address"
if ! $LOCAL; then
  [ -n "$DOMAIN$PANEL_HOST" ] || die "--domain (or --host) is required, or --local to try it without one"
  is_name() { [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$ ]]; }
  for n in $DOMAIN $PANEL_HOST $GUEST_HOST; do is_name "$n" || die "not a domain name: $n"; done
fi
# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "this installer supports Ubuntu Server LTS (found: ${PRETTY_NAME:-unknown})"
case "${VERSION_ID:-}" in
  22.04 | 24.04) ;;
  *) warn "Ubuntu ${VERSION_ID:-?} is not an LTS release this installer was tested on (22.04, 24.04)" ;;
esac

cpus=$(nproc)
mem_gb=$(($(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 / 1024))
disk_gb=$(($(df -Pk / | awk 'NR==2 {print $4}') / 1024 / 1024))
say "host: ${PRETTY_NAME}, ${cpus} vCPU, ${mem_gb} GB RAM, ${disk_gb} GB free on /"
# Tiers: below 2 vCPU / 7 GB / 40 GB it does not run; below 16 GB it is a demo or trial installation (swap added,
# smaller builds); a hotel pilot needs 8 vCPU, 32 GB RAM, 500 GB NVMe (checklist §1.1).
SMALL=false
if [ "$cpus" -lt 2 ] || [ "$mem_gb" -lt 7 ] || [ "$disk_gb" -lt 40 ]; then
  msg="below the minimum (2 vCPU, 8 GB RAM, 40 GB free); a hotel pilot needs 8 vCPU, 32 GB RAM, 500 GB NVMe"
  $SKIP_CHECKS && warn "$msg" || die "$msg — use --skip-checks to install anyway"
  SMALL=true
elif [ "$mem_gb" -lt 15 ] || [ "$cpus" -lt 4 ]; then
  warn "a small server: fine for a demo or a trial, not for a live hotel (pilot: 8 vCPU, 32 GB RAM, 500 GB NVMe)"
  SMALL=true
elif [ "$cpus" -lt 8 ] || [ "$mem_gb" -lt 30 ]; then
  warn "fine for trying it; a hotel pilot should have 8 vCPU, 32 GB RAM, 500 GB NVMe"
fi
# Ports: a port Hotella's own containers already hold (a second run) is fine; anything else is a conflict.
port_owner() { ss -ltnpH "( sport = :$1 )" 2>/dev/null | head -1; }
hotella_running() { command -v docker >/dev/null && [ -n "$(docker ps -q --filter label=com.docker.compose.project=hotella-pilot)" ]; }
check_port() {
  local owner; owner="$(port_owner "$1")"
  [ -z "$owner" ] && return 0
  hotella_running && [[ "$owner" == *docker-proxy* ]] && return 0
  die "port $1 is already in use ($owner) — choose another with $2"
}
check_port "$API_PORT" --api-port
check_port "$STAFF_PORT" --staff-port
check_port "$GUEST_PORT" --guest-port
if ! $LOCAL; then
  check_port "$AGENT_PORT" --agent-port
  if ! $SHARED; then
    for port in 80 443; do
      if [ -n "$(port_owner "$port")" ] && ! systemctl is-active --quiet caddy; then
        die "port $port is already in use: $(port_owner "$port") — on a server with other systems use --shared"
      fi
    done
  fi
fi

export DEBIAN_FRONTEND=noninteractive
apt_install() { apt-get install -y -qq --no-install-recommends "$@" >/dev/null; }

# ---------------------------------------------------------------- 2. packages
say "installing base packages"
apt-get update -qq
apt_install ca-certificates curl git gnupg openssl python3 ufw unattended-upgrades cron

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  say "installing Docker Engine and the Compose plugin (Docker's repository)"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker >/dev/null

if ! $LOCAL && ! $SHARED && ! command -v caddy >/dev/null; then
  say "installing Caddy (HTTPS with automatic certificates)"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
    gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt_install caddy
fi

# A small server builds the images with fewer tasks at once, and gets swap if it has none, so the build cannot run
# out of memory (the running platform needs about 4 GB).
if $SMALL && [ "$(awk '/SwapTotal/ {print $2}' /proc/meminfo)" -eq 0 ] && [ ! -e /swapfile ]; then
  say "adding 4 GB of swap (/swapfile) for this small server"
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

# Security updates install themselves (deploy runbook: host prerequisites); a shared server keeps its own policy.
$SHARED || printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' \
  >/etc/apt/apt.conf.d/20auto-upgrades

# ---------------------------------------------------------------- 3. the code
# Run from a checkout (infra/install/ two levels below the root)? Found without git: as root, git refuses a checkout
# that another user owns ("dubious ownership"). Through `curl | bash` there is no script file, so nothing is found.
src=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  src="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
if [ -n "$src" ] && [ -x "$src/infra/docker/pilot/pilot.sh" ]; then
  if [ "$src" != "$DIR" ]; then
    say "copying this checkout ($src) to $DIR"
    mkdir -p "$DIR"
    tar -C "$src" --exclude=node_modules --exclude=.turbo --exclude='infra/docker/pilot/.secrets' -cf - . |
      tar -C "$DIR" -xf -
  fi
elif [ -d "$DIR/.git" ]; then
  say "updating $DIR to $REF"
  git -C "$DIR" fetch -q origin "$REF" && git -C "$DIR" checkout -q FETCH_HEAD
else
  say "cloning $REPO ($REF) into $DIR"
  url="$REPO"
  # A private repository: a read-only token from the environment, never written to disk or the remote URL.
  [ -n "${GITHUB_TOKEN:-}" ] && url="${REPO/https:\/\//https://x-access-token:${GITHUB_TOKEN}@}"
  git clone -q --depth 1 --branch "$REF" "$url" "$DIR"
  git -C "$DIR" remote set-url origin "$REPO"
fi
PILOT="$DIR/infra/docker/pilot/pilot.sh"
[ -x "$PILOT" ] || die "$PILOT not found — is $DIR a Hotella checkout?"

# ---------------------------------------------------------------- 4. the platform
if $LOCAL; then
  API_URL="http://localhost:$API_PORT"; STAFF_URL="http://localhost:$STAFF_PORT"; GUEST_URL="http://localhost:$GUEST_PORT"
  WS_URL="ws://localhost:$API_PORT/api/v1/realtime"; AGENT_HOST="localhost"; AGENT_BIND="127.0.0.1"
else
  # Four names under --domain, or one panel name (--host) that also carries the API under /api and the agents' port.
  if [ -n "$PANEL_HOST" ]; then
    STAFF_HOST="$PANEL_HOST"; API_HOST="$PANEL_HOST"; AGENT_HOST="$PANEL_HOST"; GUEST_HOST="${GUEST_HOST:-guest.$PANEL_HOST}"
  else
    STAFF_HOST="staff.$DOMAIN"; API_HOST="api.$DOMAIN"; AGENT_HOST="agent.$DOMAIN"; GUEST_HOST="${GUEST_HOST:-guest.$DOMAIN}"
  fi
  API_URL="https://$API_HOST"; STAFF_URL="https://$STAFF_HOST"; GUEST_URL="https://$GUEST_HOST"
  WS_URL="wss://$API_HOST/api/v1/realtime"; AGENT_BIND="0.0.0.0"
fi
# Compose reads this file next to compose.pilot.yml; the URLs are public, nothing secret is in it. A Firebase project
# set earlier with `hotella push-setup` is kept.
fcm="$(grep -s '^HOTELLA_FCM_PROJECT_ID=' "$DIR/infra/docker/.env" || true)"
cat >"$DIR/infra/docker/.env" <<EOF
HOTELLA_PUBLIC_BASE_URL=$GUEST_URL
HOTELLA_PUBLIC_WS_URL=$WS_URL
HOTELLA_AGENT_BIND=$AGENT_BIND
HOTELLA_API_PORT=$API_PORT
HOTELLA_STAFF_WEB_PORT=$STAFF_PORT
HOTELLA_GUEST_WEB_PORT=$GUEST_PORT
HOTELLA_AGENT_PORT=$AGENT_PORT
HOTELLA_BUILD_CONCURRENCY=$($SMALL && echo 2 || echo 4)
HOTELLA_TLS_HOSTS="$($LOCAL || printf '%s\n' "$STAFF_HOST" "$API_HOST" "$GUEST_HOST" | sort -u | tr '\n' ' ')"
${fcm}
EOF
export HOTELLA_AGENT_HOSTNAME="$AGENT_HOST"
export HOTELLA_API_PORT="$API_PORT" HOTELLA_STAFF_WEB_PORT="$STAFF_PORT" HOTELLA_GUEST_WEB_PORT="$GUEST_PORT"
export HOTELLA_AGENT_PORT="$AGENT_PORT"

say "generating credentials (kept in $DIR/infra/docker/pilot/.secrets, mode 0700)"
"$PILOT" init
say "building and starting PostgreSQL, Valkey, object storage and OpenBao (first build takes a while)"
"$PILOT" up
say "configuring OpenBao (secrets store)"
"$PILOT" vault-init
say "applying database migrations"
"$PILOT" migrate
say "starting the API, worker, agent gateway, staff web and guest web"
"$PILOT" start

# ---------------------------------------------------------------- 5. HTTPS and firewall
# The sites behind a reverse proxy: the panel (staff web; the API under /api when it shares the panel's name), the API
# on its own name otherwise, and the guests' site. The agent gateway terminates its own mutual TLS and is never proxied.
caddy_sites() { # $1: a line to put in every site (e.g. "import hotella"), or empty
  if [ "$API_HOST" = "$STAFF_HOST" ]; then
    printf '%s {\n\t%s\n\thandle /api/* {\n\t\treverse_proxy 127.0.0.1:%s\n\t}\n\thandle {\n\t\treverse_proxy 127.0.0.1:%s\n\t}\n}\n\n' \
      "$STAFF_HOST" "$1" "$API_PORT" "$STAFF_PORT"
  else
    printf '%s {\n\t%s\n\treverse_proxy 127.0.0.1:%s\n}\n\n%s {\n\t%s\n\treverse_proxy 127.0.0.1:%s\n}\n\n' \
      "$API_HOST" "$1" "$API_PORT" "$STAFF_HOST" "$1" "$STAFF_PORT"
  fi
  printf '%s {\n\t%s\n\treverse_proxy 127.0.0.1:%s\n}\n' "$GUEST_HOST" "$1" "$GUEST_PORT"
}
nginx_sites() {
  local api_loc="proxy_pass http://127.0.0.1:$API_PORT; proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade; proxy_set_header Connection \$hotella_connection;
    proxy_set_header Host \$host; proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https; client_max_body_size 25m;"
  local web="proxy_set_header Host \$host; proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;"
  echo "map \$http_upgrade \$hotella_connection { default upgrade; '' close; }"
  if [ "$API_HOST" = "$STAFF_HOST" ]; then
    printf 'server {\n  listen 80; server_name %s;\n  location /api/ { %s }\n  location / { proxy_pass http://127.0.0.1:%s; %s }\n}\n' \
      "$STAFF_HOST" "$api_loc" "$STAFF_PORT" "$web"
  else
    printf 'server {\n  listen 80; server_name %s;\n  location / { %s }\n}\n' "$API_HOST" "$api_loc"
    printf 'server {\n  listen 80; server_name %s;\n  location / { proxy_pass http://127.0.0.1:%s; %s }\n}\n' \
      "$STAFF_HOST" "$STAFF_PORT" "$web"
  fi
  printf 'server {\n  listen 80; server_name %s;\n  location / { proxy_pass http://127.0.0.1:%s; %s }\n}\n' \
    "$GUEST_HOST" "$GUEST_PORT" "$web"
}
if ! $LOCAL; then
  ip="$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || true)"
  for name in $(printf '%s\n' "$STAFF_HOST" "$API_HOST" "$GUEST_HOST" "$AGENT_HOST" | sort -u); do
    resolved="$(getent ahostsv4 "$name" | awk 'NR==1 {print $1}')"
    if [ -z "$resolved" ]; then
      warn "$name does not resolve yet — create an A record to ${ip:-this server}; HTTPS starts once it does"
    elif [ -n "$ip" ] && [ "$resolved" != "$ip" ]; then
      warn "$name points at $resolved, but this server is $ip"
    fi
  done
fi
if $SHARED; then
  # Another reverse proxy already owns 80/443 on this server: write examples for it, touch nothing of it.
  {
    echo "# Hotella behind an existing nginx (written by install-ubuntu.sh --shared). Copy to /etc/nginx/conf.d/hotella.conf,"
    echo "# nginx -t && systemctl reload nginx, then add HTTPS with certbot --nginx for: $(printf '%s\n' "$STAFF_HOST" "$API_HOST" "$GUEST_HOST" | sort -u | tr '\n' ' ')"
    echo "# The hotel agents' gateway ($AGENT_HOST:$AGENT_PORT) terminates its own mutual TLS: it is NOT proxied here."
    nginx_sites
  } >"$DIR/infra/docker/reverse-proxy.nginx.conf"
  {
    echo "# Hotella behind an existing Caddy (written by install-ubuntu.sh --shared): add these sites to your Caddyfile."
    caddy_sites ""
  } >"$DIR/infra/docker/reverse-proxy.Caddyfile"
  # Only the hotel agents' port is opened, and only when the server already runs ufw (other rules stay as they are).
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    ufw allow "$AGENT_PORT/tcp" >/dev/null
  fi
  say "shared server: Caddy and the firewall were not touched; reverse-proxy examples in $DIR/infra/docker/reverse-proxy.*"
fi
if ! $LOCAL && ! $SHARED; then
  say "publishing the sites through Caddy"
  cat >/etc/caddy/Caddyfile <<EOF
# Hotella (written by infra/install/install-ubuntu.sh). The agent gateway ($AGENT_HOST:$AGENT_PORT) terminates its own
# mutual TLS and is not proxied here.
{
	email $EMAIL
}

(hotella) {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		-Server
	}
}

$(caddy_sites "import hotella")
EOF
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  systemctl enable caddy >/dev/null
  systemctl reload caddy 2>/dev/null || systemctl restart caddy

  say "firewall: SSH, HTTP/HTTPS and the agent gateway only"
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow "$AGENT_PORT/tcp" >/dev/null
  ufw --force enable >/dev/null
fi

# ---------------------------------------------------------------- 6. administrator, backups, the `hotella` command
password="${HOTELLA_ADMIN_PASSWORD:-}"
generated=false
if [ -z "$password" ]; then
  password="$(openssl rand -base64 24 | tr -d '/+=\n' | cut -c1-24)"
  generated=true
fi
say "creating the platform administrator $EMAIL"
can_login=true
if ! HOTELLA_ADMIN_PASSWORD="$password" "$PILOT" admin "$EMAIL" "$ADMIN_NAME" >/dev/null 2>&1; then
  warn "the administrator was not created (it may already exist); sign in with your existing password"
  generated=false
  [ -n "${HOTELLA_ADMIN_PASSWORD:-}" ] || can_login=false
fi

say "first full backup (also proves WAL archiving works)"
"$PILOT" backup full >/dev/null

cat >/etc/cron.d/hotella <<EOF
# Hotella backups (docs/runbooks/backup-restore.md): differential every night, full every Sunday.
SHELL=/bin/bash
30 2 * * 1-6 root $PILOT backup diff >>/var/log/hotella-backup.log 2>&1
30 2 * * 0 root $PILOT backup full >>/var/log/hotella-backup.log 2>&1
EOF
chmod 0644 /etc/cron.d/hotella
# Platform monitor (docs/runbooks/monitoring.md): every five minutes; destinations with `hotella alert-setup`.
cat >/etc/cron.d/hotella-monitor <<EOF
SHELL=/bin/bash
*/5 * * * * root $PILOT monitor >>/var/log/hotella-monitor.log 2>&1
EOF
chmod 0644 /etc/cron.d/hotella-monitor

# ---------------------------------------------------------------- 7. the hotel
if [ -n "$HOTEL" ]; then
  token=""
  if $can_login; then
    token="$(python3 - "$EMAIL" "$password" "$API_PORT" <<'PY' || true
import json, sys, urllib.request
req = urllib.request.Request(f"http://127.0.0.1:{sys.argv[3]}/api/v1/auth/login", method="POST",
    data=json.dumps({"email": sys.argv[1], "password": sys.argv[2]}).encode(), headers={"content-type": "application/json"})
print(json.load(urllib.request.urlopen(req, timeout=30))["accessToken"])
PY
)"
  fi
  if [ -z "$token" ]; then
    warn "could not sign in as $EMAIL: run  sudo hotella provision $HOTEL <token>  (and  hotella demo …) by hand"
  else
    say "creating the hotel from $(basename "$HOTEL")"
    "$PILOT" provision "$HOTEL" "$token"
    if [ -n "$DEMO" ]; then
      say "adding the demo content ($(basename "$DEMO"))"
      "$PILOT" demo "$HOTEL" "$DEMO" "$token"
    fi
  fi
fi

cat >/usr/local/bin/hotella <<EOF
#!/usr/bin/env bash
# Operate this Hotella installation: hotella status | unseal | start | backup full | down | …
export HOTELLA_AGENT_HOSTNAME="$AGENT_HOST"
exec "$PILOT" "\$@"
EOF
chmod 0755 /usr/local/bin/hotella

# ---------------------------------------------------------------- done
cat <<EOF

$(printf '\033[1;32m')Hotella is installed.$(printf '\033[0m')

  Staff web      $STAFF_URL
  Guest web      $GUEST_URL
  API            $API_URL/api/v1   (health: $API_URL/api/v1/ready)
  Hotel agents   $AGENT_HOST:$AGENT_PORT   (mutual TLS; enrollment codes from the staff web)
  Administrator  $EMAIL
EOF
if $generated; then
  cat <<EOF
  Password       $password
                 ↑ shown once and stored nowhere: save it in your password manager now.
EOF
fi
cat <<EOF

EOF
if [ -n "$DEMO" ] && [ -s "$DIR/infra/docker/pilot/.secrets/demo/accounts.json" ]; then
  cat <<EOF
  Demo hotel     $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tenant"]["code"])' "$HOTEL") — DEMO DATA (fictional staff and guests)
  Demo accounts  sudo cat $DIR/infra/docker/pilot/.secrets/demo/accounts.json   (hotel code, e-mail, password)
EOF
fi
if $SHARED; then
  cat <<EOF
  Shared server  your reverse proxy must serve $(printf '%s\n' "$STAFF_HOST" "$API_HOST" "$GUEST_HOST" | sort -u | tr '\n' ' ')— examples:
                 $DIR/infra/docker/reverse-proxy.nginx.conf   ·   $DIR/infra/docker/reverse-proxy.Caddyfile
                 open TCP $AGENT_PORT to the internet for the hotel agents (mutual TLS, never through the proxy)
EOF
fi
cat <<EOF

Next (docs/runbooks/deploy.md):
  1. Move $DIR/infra/docker/pilot/.secrets/openbao-init.json (unseal keys + root token) OFF this server and keep it
     with two custodians. After every reboot OpenBao starts sealed: run  sudo hotella unseal && sudo hotella start
  2. Back up $DIR/infra/docker/pilot/.secrets (encrypted, offline).
  3. Sign in to the staff web, create the hotel (tenant, property) and its staff; connect the hotel agent.

Everyday commands:  sudo hotella status · sudo hotella backup full · sudo hotella unseal · sudo hotella start
Pushes to the Hotella app: sudo hotella push-setup <firebase-project-id> <service-account.json>
Alerts (checked every 5 minutes): sudo hotella alert-setup telegram   (or: webhook)
EOF
