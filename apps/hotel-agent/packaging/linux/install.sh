#!/usr/bin/env bash
# Installs (or adds a version of) the hotel agent on Linux:
#   sudo packaging/linux/install.sh hotella-agent-<version>-linux-x64.zip
# Layout: /opt/hotella-agent/versions/<version>/, /opt/hotella-agent/current → the running version (the updater
# switches it), /etc/hotella-agent/agent.json (settings, no secrets), /var/lib/hotella-agent (identity, queue; 0700).
# Then: hotella-agent enroll --token-file - --ca planova-agent-ca.pem  (the token from the platform, on stdin).
set -euo pipefail
package="${1:?package zip}"
root=/opt/hotella-agent
version="$(basename "$package" | sed -E 's/^hotella-agent-([0-9.]+)-linux-x64\.zip$/\1/')"
[[ "$version" =~ ^[0-9]+(\.[0-9]+){1,3}$ ]] || { echo "not an agent package: $package" >&2; exit 1; }
id -u hotella-agent >/dev/null 2>&1 || useradd --system --home-dir /var/lib/hotella-agent --shell /usr/sbin/nologin hotella-agent
install -d -o hotella-agent -g hotella-agent -m 0755 "$root" "$root/versions"
target="$root/versions/$version"
if [[ ! -d "$target" ]]; then
  tmp="$(mktemp -d "$root/versions/.install-XXXX")"
  unzip -q "$package" -d "$tmp"
  chmod 0755 "$tmp/hotella-agent"
  chown -R hotella-agent:hotella-agent "$tmp"
  mv "$tmp" "$target"
fi
ln -sfn "$target" "$root/current.next" && mv -T "$root/current.next" "$root/current"
install -d -m 0755 /etc/hotella-agent
[[ -f /etc/hotella-agent/agent.json ]] || install -m 0644 "$target/agent.example.json" /etc/hotella-agent/agent.json
install -d -o hotella-agent -g hotella-agent -m 0700 /var/lib/hotella-agent
ln -sfn "$root/current/hotella-agent" /usr/local/bin/hotella-agent
install -m 0644 "$(dirname "$0")/hotella-agent.service" /etc/systemd/system/hotella-agent.service
systemctl daemon-reload
systemctl enable hotella-agent.service >/dev/null
echo "installed $version; edit /etc/hotella-agent/agent.json, enroll as the service user, then: systemctl start hotella-agent"
echo "  sudo -u hotella-agent hotella-agent enroll --token-file - --ca <planova-agent-ca.pem>"
