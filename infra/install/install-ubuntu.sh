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
#   6. creates the first platform administrator, the first full backup, and the backup schedule
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
#   --email E         first platform administrator and the Let's Encrypt contact
#   --admin-name N    the administrator's given name (default: Admin)
#   --local           no domain, no reverse proxy, no firewall changes: everything on localhost
#   --dir PATH        installation directory (default: /opt/hotella)
#   --repo URL        git repository to clone when not run from a checkout
#   --ref REF         branch or tag to install (default: main)
#   --skip-checks     install even below the recommended CPU/RAM/disk
#   -h, --help        this text
#
# The administrator's password is read from $HOTELLA_ADMIN_PASSWORD, else generated and shown once at the end.
set -euo pipefail

DOMAIN=""
EMAIL=""
ADMIN_NAME="Admin"
LOCAL=false
DIR="/opt/hotella"
REPO="https://github.com/karimabdelsalam/hotella.git"
REF="main"
SKIP_CHECKS=false

say() { printf '\033[1;36m[hotella]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[hotella] warning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[hotella] error:\033[0m %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,36p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:?}"; shift 2 ;;
    --email) EMAIL="${2:?}"; shift 2 ;;
    --admin-name) ADMIN_NAME="${2:?}"; shift 2 ;;
    --local) LOCAL=true; shift ;;
    --dir) DIR="${2:?}"; shift 2 ;;
    --repo) REPO="${2:?}"; shift 2 ;;
    --ref) REF="${2:?}"; shift 2 ;;
    --skip-checks) SKIP_CHECKS=true; shift ;;
    -h | --help) usage 0 ;;
    *) warn "unknown option: $1"; usage 1 ;;
  esac
done

# ---------------------------------------------------------------- 1. the host
[ "$(id -u)" -eq 0 ] || die "run as root: sudo bash $0 …"
[ -n "$EMAIL" ] || die "--email is required (the first platform administrator)"
[[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "--email does not look like an e-mail address"
if ! $LOCAL; then
  [ -n "$DOMAIN" ] || die "--domain is required (or --local to try it without one)"
  [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$ ]] || die "--domain is not a domain name"
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
if [ "$cpus" -lt 4 ] || [ "$mem_gb" -lt 15 ] || [ "$disk_gb" -lt 80 ]; then
  msg="below the minimum (4 vCPU, 16 GB RAM, 80 GB free); a hotel pilot needs 8 vCPU, 32 GB RAM, 500 GB NVMe"
  $SKIP_CHECKS && warn "$msg" || die "$msg — use --skip-checks to install anyway"
elif [ "$cpus" -lt 8 ] || [ "$mem_gb" -lt 30 ]; then
  warn "fine for trying it; a hotel pilot should have 8 vCPU, 32 GB RAM, 500 GB NVMe"
fi
if ! $LOCAL; then
  for port in 80 443 8443; do
    if ss -ltnH "( sport = :$port )" 2>/dev/null | grep -q . && ! systemctl is-active --quiet caddy; then
      die "port $port is already in use: $(ss -ltnpH "( sport = :$port )" | head -1)"
    fi
  done
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

if ! $LOCAL && ! command -v caddy >/dev/null; then
  say "installing Caddy (HTTPS with automatic certificates)"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
    gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt_install caddy
fi

# Security updates install themselves (deploy runbook: host prerequisites).
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' \
  >/etc/apt/apt.conf.d/20auto-upgrades

# ---------------------------------------------------------------- 3. the code
src="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null || true)"
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
  API_URL="http://localhost:3000"; STAFF_URL="http://localhost:3100"; GUEST_URL="http://localhost:3200"
  WS_URL="ws://localhost:3000/api/v1/realtime"; AGENT_HOST="localhost"; AGENT_BIND="127.0.0.1"
else
  API_URL="https://api.$DOMAIN"; STAFF_URL="https://staff.$DOMAIN"; GUEST_URL="https://guest.$DOMAIN"
  WS_URL="wss://api.$DOMAIN/api/v1/realtime"; AGENT_HOST="agent.$DOMAIN"; AGENT_BIND="0.0.0.0"
fi
# Compose reads this file next to compose.pilot.yml; the URLs are public, nothing secret is in it.
cat >"$DIR/infra/docker/.env" <<EOF
HOTELLA_PUBLIC_BASE_URL=$GUEST_URL
HOTELLA_PUBLIC_WS_URL=$WS_URL
HOTELLA_AGENT_BIND=$AGENT_BIND
EOF
export HOTELLA_AGENT_HOSTNAME="$AGENT_HOST"

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
if ! $LOCAL; then
  ip="$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || true)"
  for name in api staff guest agent; do
    resolved="$(getent ahostsv4 "$name.$DOMAIN" | awk 'NR==1 {print $1}')"
    if [ -z "$resolved" ]; then
      warn "$name.$DOMAIN does not resolve yet — create an A record to ${ip:-this server}; HTTPS starts once it does"
    elif [ -n "$ip" ] && [ "$resolved" != "$ip" ]; then
      warn "$name.$DOMAIN points at $resolved, but this server is $ip"
    fi
  done
  say "publishing the sites through Caddy"
  cat >/etc/caddy/Caddyfile <<EOF
# Hotella (written by infra/install/install-ubuntu.sh). The agent gateway (agent.$DOMAIN:8443) terminates its own
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

api.$DOMAIN {
	import hotella
	reverse_proxy 127.0.0.1:3000
}

staff.$DOMAIN {
	import hotella
	reverse_proxy 127.0.0.1:3100
}

guest.$DOMAIN {
	import hotella
	reverse_proxy 127.0.0.1:3200
}
EOF
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  systemctl enable caddy >/dev/null
  systemctl reload caddy 2>/dev/null || systemctl restart caddy

  say "firewall: SSH, HTTP/HTTPS and the agent gateway only"
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 8443/tcp >/dev/null
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
if ! HOTELLA_ADMIN_PASSWORD="$password" "$PILOT" admin "$EMAIL" "$ADMIN_NAME" >/dev/null 2>&1; then
  warn "the administrator was not created (it may already exist); sign in with your existing password"
  generated=false
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
  Hotel agents   $AGENT_HOST:8443   (mutual TLS; enrollment codes from the staff web)
  Administrator  $EMAIL
EOF
if $generated; then
  cat <<EOF
  Password       $password
                 ↑ shown once and stored nowhere: save it in your password manager now.
EOF
fi
cat <<EOF

Next (docs/runbooks/deploy.md):
  1. Move $DIR/infra/docker/pilot/.secrets/openbao-init.json (unseal keys + root token) OFF this server and keep it
     with two custodians. After every reboot OpenBao starts sealed: run  sudo hotella unseal && sudo hotella start
  2. Back up $DIR/infra/docker/pilot/.secrets (encrypted, offline).
  3. Sign in to the staff web, create the hotel (tenant, property) and its staff; connect the hotel agent.

Everyday commands:  sudo hotella status · sudo hotella backup full · sudo hotella unseal · sudo hotella start
EOF
