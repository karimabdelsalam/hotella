#!/usr/bin/env bash
# Sea Beach Edge — the first pilot hotel, in one command on a fresh Ubuntu server (22.04 or 24.04 LTS).
#
# Installs Hotella (install-ubuntu.sh: Docker, the platform, HTTPS, firewall, backups, the platform monitor), then
# creates the hotel from docs/pilot/sea-beach-edge/profile.json and adds the demo content of demo.json: staff accounts
# for every role, guest services, two à la carte restaurants, hotel information for the AI concierge, the brand, and a
# simulated PMS with guests in house. The profile and the demo hold DEMO DATA until the hotel's real data arrives
# (docs/pilot/sea-beach-edge/README.md). Safe to run again: what exists is kept.
#
#   git clone https://github.com/karimabdelsalam/hotella.git && cd hotella       (private: a read-only token)
#   sudo bash infra/install/sea-beach-edge.sh --domain seabeachedge.example.com --email you@planova.com.eg
#   sudo bash infra/install/sea-beach-edge.sh --local --email you@planova.com.eg   (a VM or laptop, no domain)
#   sudo bash infra/install/sea-beach-edge.sh --shared --domain … --email …       (a server with other systems:
#                                     your reverse proxy, your firewall — docs/runbooks/deploy.md "Sharing a server")
#
# DNS first (with --domain): A records for api., staff., guest. and agent.<domain> pointing at this server.
# Every other option of install-ubuntu.sh works here too (--admin-name, --dir, --skip-checks, …).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOTEL_DIR="$(cd "$HERE/../../docs/pilot/sea-beach-edge" && pwd)"
case "${1:-}" in
  -h | --help | "") sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac
exec bash "$HERE/install-ubuntu.sh" --hotel "$HOTEL_DIR/profile.json" --demo "$HOTEL_DIR/demo.json" "$@"
