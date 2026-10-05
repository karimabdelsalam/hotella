#!/usr/bin/env python3
"""Hotella platform monitor (BUILD_PLAN pilot P.2, checklist §17).

Run by cron every five minutes on the platform host (`pilot.sh monitor`). It reads the platform's state, evaluates
fixed rules (deterministic, CLAUDE.md rule 11), and notifies each alert once when it starts, again every
REMIND_AFTER while it lasts, and once when it clears.

Probes:
- containers that should run;
- API readiness;
- OpenBao sealed;
- backup age and archive status (pgBackRest);
- disk use;
- certificate expiry (public sites, agent gateway, agent CA);
- hotel agents offline and integration health;
- queue backlog and new failed jobs (BullMQ on Valkey);
- AI spend against each hotel's monthly budget.

Messages carry codes and numbers only, never guest or staff data. Delivery is to a webhook that accepts {"text": …}
(Slack, Google Chat, Mattermost, Rocket.Chat, Teams workflows) and/or a Telegram bot, configured in
.secrets/alerting.env (`pilot.sh alert-setup`). Without a destination, alerts are only written to the log.

  monitor.py run [--dry-run] [--json]    probe, evaluate, notify (dry run: print, send nothing, keep no state)
  monitor.py test                        send a test message to the configured destinations
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DOCKER_DIR = HERE.parent
SECRETS = HERE / ".secrets"
PROJECT = "hotella-pilot"

# Rules. Changing one is a reviewed code change, like any other business rule.
EXPECTED_SERVICES = ("postgres", "valkey", "s3", "openbao", "api", "worker", "agent-gateway", "staff-web", "guest-web")
AGENT_OFFLINE_AFTER_S = 180  # integrations: AGENT_OFFLINE_AFTER_MS (domain/instance.ts)
AGENT_BACKLOG_WARN = 1_000  # messages queued on a hotel agent
BACKUP_WARN_H, BACKUP_CRIT_H = 26, 50  # nightly differential, weekly full
DISK_WARN_PCT, DISK_CRIT_PCT = 85, 95
CERT_WARN_DAYS, CERT_CRIT_DAYS = 14, 3
QUEUES = ("critical-operational", "guest-realtime", "normal", "analytics", "background-ai")  # platform-queue QUEUE_NAMES
QUEUE_WARN = {"critical-operational": 100, "guest-realtime": 100}
QUEUE_WARN_DEFAULT = 1_000
FAILED_JOBS_WARN = 20  # new failed jobs between two runs
AI_BUDGET_WARN_PCT = 80
AI_BUDGET_DEFAULT_MINOR = 10_000  # ai.budget.monthly_limit_minor default (ai domain/settings.ts)
REMIND_AFTER_S = 12 * 3600

SEVERITY_ICON = {"CRITICAL": "🔴", "WARNING": "🟠"}


# ------------------------------------------------------------------ evaluation (pure, unit-tested)
def alert(key: str, severity: str, text: str) -> dict:
    return {"key": key, "severity": severity, "text": text}


def evaluate(facts: dict, previous: dict | None = None) -> list[dict]:
    """The alerts active for these facts. `previous` is the last run's facts (for counters such as failed jobs)."""
    out: list[dict] = []
    previous = previous or {}
    for probe in sorted(facts.get("probe_errors", {})):
        out.append(alert(f"probe:{probe}", "WARNING", f"monitor could not check {probe}: {facts['probe_errors'][probe]}"))

    if "containers" in facts:
        states = facts["containers"]
        for svc in EXPECTED_SERVICES:
            s = states.get(svc)
            if s is None or s.get("state") != "running":
                out.append(alert(f"container:{svc}", "CRITICAL", f"service {svc} is not running ({(s or {}).get('state', 'missing')})"))
            elif s.get("health") == "unhealthy":
                out.append(alert(f"container:{svc}", "CRITICAL", f"service {svc} is unhealthy"))

    if "api_ready" in facts and not facts["api_ready"]["ok"]:
        out.append(alert("api:ready", "CRITICAL", f"API not ready ({facts['api_ready']['detail']})"))

    if facts.get("openbao", {}).get("sealed"):
        out.append(alert("openbao:sealed", "CRITICAL", "OpenBao is sealed: run `hotella unseal && hotella start`"))

    if "backup" in facts:
        b = facts["backup"]
        age = b.get("last_backup_age_h")
        if age is None:
            out.append(alert("backup:age", "CRITICAL", "no backup exists"))
        elif age >= BACKUP_CRIT_H:
            out.append(alert("backup:age", "CRITICAL", f"last backup is {age:.0f} h old"))
        elif age >= BACKUP_WARN_H:
            out.append(alert("backup:age", "WARNING", f"last backup is {age:.0f} h old"))
        if age is not None and b.get("status_code", 0) != 0:
            out.append(alert("backup:status", "CRITICAL", f"pgBackRest reports: {b.get('status_message', 'error')}"))

    for path, pct in sorted(facts.get("disk", {}).items()):
        if pct >= DISK_CRIT_PCT:
            out.append(alert(f"disk:{path}", "CRITICAL", f"disk {path} is {pct:.0f}% full"))
        elif pct >= DISK_WARN_PCT:
            out.append(alert(f"disk:{path}", "WARNING", f"disk {path} is {pct:.0f}% full"))

    for name, c in sorted(facts.get("certificates", {}).items()):
        if c.get("error"):
            out.append(alert(f"cert:{name}", "CRITICAL", f"certificate of {name}: {c['error']}"))
            continue
        days = c["days_left"]
        if days <= CERT_CRIT_DAYS:
            out.append(alert(f"cert:{name}", "CRITICAL", f"certificate of {name} expires in {days} days"))
        elif days <= CERT_WARN_DAYS:
            out.append(alert(f"cert:{name}", "WARNING", f"certificate of {name} expires in {days} days"))

    for a in facts.get("agents", []):
        where = f"{a['tenant']}/{a['property']}/{a['instance']}"
        key = f"agent:{a['tenant']}:{a['property']}:{a['instance']}"
        unseen = a.get("unseen_s")
        if unseen is not None and unseen > AGENT_OFFLINE_AFTER_S:
            out.append(alert(f"{key}:offline", "CRITICAL", f"hotel agent offline: {where} (unseen {unseen // 60} min)"))
        elif a.get("status") in ("DEGRADED", "AUTH_FAILED", "MISCONFIGURED"):
            out.append(alert(f"{key}:health", "WARNING", f"integration {where} is {a['status']}"))
        if (a.get("queue_depth") or 0) >= AGENT_BACKLOG_WARN:
            out.append(alert(f"{key}:backlog", "WARNING", f"{a['queue_depth']} messages queued on {where}"))

    queues = facts.get("queues", {})
    for q in QUEUES:
        if q not in queues:
            continue
        waiting = queues[q]["waiting"]
        limit = QUEUE_WARN.get(q, QUEUE_WARN_DEFAULT)
        if waiting >= limit:
            out.append(alert(f"queue:{q}:backlog", "WARNING", f"queue {q} has {waiting} jobs waiting"))
        before = previous.get("queues", {}).get(q, {}).get("failed")
        if before is not None and queues[q]["failed"] - before >= FAILED_JOBS_WARN:
            out.append(alert(f"queue:{q}:failed", "WARNING", f"queue {q}: {queues[q]['failed'] - before} jobs failed since the last check"))

    for b in facts.get("ai_budget", []):
        limit, spent = b["limit_minor"], b["spent_minor"]
        if limit <= 0:
            continue
        pct = spent * 100 / limit
        key = f"ai-budget:{b['tenant']}:{b['property']}"
        if pct >= 100:
            out.append(alert(key, "CRITICAL", f"AI budget of {b['tenant']}/{b['property']} used up ({spent / 100:.2f} of {limit / 100:.2f}); external AI is off until next month"))
        elif pct >= AI_BUDGET_WARN_PCT:
            out.append(alert(key, "WARNING", f"AI budget of {b['tenant']}/{b['property']} at {pct:.0f}% ({spent / 100:.2f} of {limit / 100:.2f})"))
    return out


def transition(state: dict, active: list[dict], now: float) -> tuple[list[dict], dict]:
    """What to send now and the new state: a new alert fires, a lasting one is repeated after REMIND_AFTER_S, a gone
    one resolves once. A change of severity counts as a new alert."""
    firing = dict(state.get("firing", {}))
    send: list[dict] = []
    current = {a["key"]: a for a in active}
    for key, a in current.items():
        was = firing.get(key)
        if was is None or was["severity"] != a["severity"]:
            send.append({**a, "event": "FIRING"})
            firing[key] = {"severity": a["severity"], "since": now, "notified": now, "text": a["text"]}
        elif now - was["notified"] >= REMIND_AFTER_S:
            send.append({**a, "event": "STILL FIRING"})
            firing[key] = {**was, "notified": now, "text": a["text"]}
    for key in sorted(set(firing) - set(current)):
        send.append({"key": key, "severity": firing[key]["severity"], "text": firing[key]["text"], "event": "RESOLVED"})
        del firing[key]
    return send, {**state, "firing": firing}


def format_message(installation: str, m: dict) -> str:
    icon = "✅" if m["event"] == "RESOLVED" else SEVERITY_ICON.get(m["severity"], "•")
    return f"{icon} [Hotella {installation}] {m['event']} {m['severity']}: {m['text']}"


# ------------------------------------------------------------------ parsing helpers (pure, unit-tested)
def parse_compose_ps(output: str) -> dict:
    """`docker compose ps --format json`: one JSON object per line (Compose ≥ 2.21) or one JSON array (older)."""
    output = output.strip()
    if not output:
        return {}
    rows = json.loads(output) if output.startswith("[") else [json.loads(line) for line in output.splitlines() if line.strip()]
    return {r["Service"]: {"state": r.get("State", ""), "health": r.get("Health", "")} for r in rows}


def parse_pgbackrest_info(output: str, now: datetime) -> dict:
    stanzas = json.loads(output)
    if not stanzas:
        return {"last_backup_age_h": None, "status_code": 1, "status_message": "no stanza"}
    s = stanzas[0]
    backups = s.get("backup") or []
    last = max((b["timestamp"]["stop"] for b in backups), default=None)
    status = s.get("status", {})
    return {
        "last_backup_age_h": None if last is None else (now.timestamp() - last) / 3600,
        "status_code": status.get("code", 0),
        "status_message": status.get("message", ""),
    }


def parse_env(text: str) -> dict:
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def public_names(config: dict) -> list[str]:
    """The public sites whose certificates are watched: as installed (HOTELLA_TLS_HOSTS), else the four-name layout."""
    if config.get("HOTELLA_TLS_HOSTS", "").strip():
        return config["HOTELLA_TLS_HOSTS"].split()
    domain = config.get("HOTELLA_DOMAIN")
    return [f"{n}.{domain}" for n in ("api", "staff", "guest")] if domain else []


def domain_from_public_url(url: str) -> str | None:
    """`https://guest.example.com` → `example.com` (the installer names the sites api., staff., guest.)."""
    if not url.startswith("https://guest."):
        return None
    return url[len("https://guest."):].split("/")[0].split(":")[0] or None


# ------------------------------------------------------------------ probes (need the host)
def sh(args: list[str], timeout: int = 60) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout).stdout


def compose(*args: str) -> list[str]:
    return ["docker", "compose", "-p", PROJECT, "-f", str(DOCKER_DIR / "compose.pilot.yml"), *args]


def psql_json(sql: str) -> list:
    out = sh(compose("exec", "-T", "postgres", "psql", "-U", "hotella_admin", "-d", "hotella", "-XAtc", sql))
    return json.loads(out.strip() or "[]")


AGENTS_SQL = """
select coalesce(json_agg(r), '[]') from (
  select t.code as tenant, p.code as property, i.name as instance, h.status::text as status, h.queue_depth,
         case when h.agent_last_seen_at is null then null
              else extract(epoch from now() - h.agent_last_seen_at)::int end as unseen_s
  from integration.integration_instances i
  join integration.integration_health h on h.instance_id = i.id
  join org.properties p on p.id = i.property_id
  join org.tenants t on t.id = i.tenant_id
  where i.status = 'ACTIVE') r
"""

# The effective limit resolves property → tenant → platform → the setting's default, as the configuration service does.
AI_BUDGET_SQL = f"""
select coalesce(json_agg(r), '[]') from (
  select t.code as tenant, p.code as property,
         coalesce((select sum(m.cost_minor) from ai.model_calls m
                   where m.property_id = p.id and m.egress = 'EXTERNAL'
                     and m.created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'), 0)::int
           as spent_minor,
         coalesce(
           (select (c.value #>> '{{}}')::int from platform.configuration c
             where c.key = 'ai.budget.monthly_limit_minor' and c.scope = 'PROPERTY' and c.scope_id = p.id),
           (select (c.value #>> '{{}}')::int from platform.configuration c
             where c.key = 'ai.budget.monthly_limit_minor' and c.scope = 'TENANT' and c.scope_id = t.id),
           (select (c.value #>> '{{}}')::int from platform.configuration c
             where c.key = 'ai.budget.monthly_limit_minor' and c.scope = 'PLATFORM'),
           {AI_BUDGET_DEFAULT_MINOR}) as limit_minor
  from org.properties p join org.tenants t on t.id = p.tenant_id) r
where r.spent_minor > 0
"""


def tls_days_left(host: str, port: int, cafile: str | None = None, server_name: str | None = None) -> int:
    ctx = ssl.create_default_context(cafile=cafile)
    if cafile:
        ctx.check_hostname = False
    with socket.create_connection((host, port), timeout=10) as raw:
        with ctx.wrap_socket(raw, server_hostname=server_name or host) as s:
            not_after = s.getpeercert()["notAfter"]
    return int((ssl.cert_time_to_seconds(not_after) - datetime.now(timezone.utc).timestamp()) // 86400)


def file_cert_days_left(path: Path) -> int:
    end = sh(["openssl", "x509", "-enddate", "-noout", "-in", str(path)]).strip().split("=", 1)[1]
    return int((ssl.cert_time_to_seconds(end) - datetime.now(timezone.utc).timestamp()) // 86400)


def valkey(*cmd: str) -> str:
    script = 'valkey-cli --no-auth-warning -a "$(sed -n "s/^requirepass //p" /usr/local/etc/valkey/valkey.conf)" "$@"'
    return sh(compose("exec", "-T", "valkey", "sh", "-c", script, "valkey-cli", *cmd)).strip()


def collect(config: dict) -> dict:
    facts: dict = {"probe_errors": {}}

    def probe(name: str, fn) -> None:
        try:
            fn()
        except Exception as e:  # one failing probe never hides the others
            facts["probe_errors"][name] = str(e).splitlines()[0][:200] if str(e) else type(e).__name__

    def containers():
        facts["containers"] = parse_compose_ps(sh(compose("ps", "--all", "--format", "json")))

    def api_ready():
        url = f"http://127.0.0.1:{config.get('HOTELLA_API_PORT', '3000')}/api/v1/ready"
        try:
            with urllib.request.urlopen(url, timeout=10) as r:
                facts["api_ready"] = {"ok": r.status == 200, "detail": f"HTTP {r.status}"}
        except urllib.error.HTTPError as e:
            facts["api_ready"] = {"ok": False, "detail": f"HTTP {e.code}"}
        except OSError as e:
            facts["api_ready"] = {"ok": False, "detail": str(e)[:120]}

    def openbao():
        r = subprocess.run(compose("exec", "-T", "openbao", "bao", "status", "-format=json"), capture_output=True, text=True, timeout=30)
        facts["openbao"] = {"sealed": bool(json.loads(r.stdout or "{}").get("sealed", True))}

    def backup():
        out = sh(compose("exec", "-T", "-u", "postgres", "postgres", "pgbackrest", "--stanza=hotella", "info", "--output=json"))
        facts["backup"] = parse_pgbackrest_info(out, datetime.now(timezone.utc))

    def disk():
        facts["disk"] = {}
        for path in ("/", "/var/lib/docker"):
            if os.path.isdir(path):
                u = shutil.disk_usage(path)
                facts["disk"][path] = u.used * 100 / u.total

    def certificates():
        certs = facts.setdefault("certificates", {})
        names = public_names(config)
        for host in names:
            try:
                certs[host] = {"days_left": tls_days_left(host, 443)}
            except Exception as e:
                certs[host] = {"error": str(e)[:120]}
        ca = SECRETS / "agent" / "ca.crt"
        if ca.exists():
            certs["agent CA"] = {"days_left": file_cert_days_left(ca)}
            try:
                port = int(config.get("HOTELLA_AGENT_PORT", "8443"))
                certs["agent gateway"] = {"days_left": tls_days_left("127.0.0.1", port, cafile=str(ca), server_name="localhost")}
            except Exception as e:
                certs["agent gateway"] = {"error": str(e)[:120]}

    def agents():
        facts["agents"] = psql_json(AGENTS_SQL)

    def queues():
        facts["queues"] = {}
        for q in QUEUES:
            waiting = int(valkey("LLEN", f"hotella:{q}:wait") or 0) + int(valkey("ZCARD", f"hotella:{q}:prioritized") or 0)
            failed = int(valkey("ZCARD", f"hotella:{q}:failed") or 0)
            facts["queues"][q] = {"waiting": waiting, "failed": failed}

    def ai_budget():
        facts["ai_budget"] = psql_json(AI_BUDGET_SQL)

    for name, fn in (
        ("containers", containers), ("api", api_ready), ("openbao", openbao), ("backup", backup), ("disk", disk),
        ("certificates", certificates), ("agents", agents), ("queues", queues), ("ai budget", ai_budget),
    ):
        probe(name, fn)
    if not facts["probe_errors"]:
        del facts["probe_errors"]
    return facts


# ------------------------------------------------------------------ delivery
def post_json(url: str, body: dict) -> None:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=15) as r:
        if r.status >= 300:
            raise OSError(f"HTTP {r.status}")


def deliver(config: dict, texts: list[str]) -> list[str]:
    """Sends to every configured destination; returns the destinations that failed (never their URLs or tokens)."""
    failed = []
    text = "\n".join(texts)
    if config.get("HOTELLA_ALERT_WEBHOOK_URL"):
        try:
            post_json(config["HOTELLA_ALERT_WEBHOOK_URL"], {"text": text})
        except Exception:
            failed.append("webhook")
    if config.get("HOTELLA_ALERT_TELEGRAM_TOKEN") and config.get("HOTELLA_ALERT_TELEGRAM_CHAT_ID"):
        try:
            post_json(
                f"https://api.telegram.org/bot{config['HOTELLA_ALERT_TELEGRAM_TOKEN']}/sendMessage",
                {"chat_id": config["HOTELLA_ALERT_TELEGRAM_CHAT_ID"], "text": text, "disable_web_page_preview": True},
            )
        except Exception:
            failed.append("telegram")
    return failed


def has_destination(config: dict) -> bool:
    return bool(config.get("HOTELLA_ALERT_WEBHOOK_URL") or (config.get("HOTELLA_ALERT_TELEGRAM_TOKEN") and config.get("HOTELLA_ALERT_TELEGRAM_CHAT_ID")))


def load_config() -> dict:
    config: dict = {}
    env_file = DOCKER_DIR / ".env"
    if env_file.exists():
        compose_env = parse_env(env_file.read_text())
        domain = domain_from_public_url(compose_env.get("HOTELLA_PUBLIC_BASE_URL", ""))
        if domain:
            config["HOTELLA_DOMAIN"] = domain
        if compose_env.get("HOTELLA_TLS_HOSTS"):  # the public names the installer configured
            config["HOTELLA_TLS_HOSTS"] = compose_env["HOTELLA_TLS_HOSTS"]
        for k in ("HOTELLA_API_PORT", "HOTELLA_AGENT_PORT"):  # host ports chosen at installation
            if compose_env.get(k):
                config[k] = compose_env[k]
    alerting = SECRETS / "alerting.env"
    if alerting.exists():
        config.update(parse_env(alerting.read_text()))
    for k in ("HOTELLA_API_PORT", "HOTELLA_AGENT_PORT", "HOTELLA_DOMAIN", "HOTELLA_INSTALLATION"):
        if os.environ.get(k):
            config[k] = os.environ[k]
    config.setdefault("HOTELLA_INSTALLATION", config.get("HOTELLA_DOMAIN") or socket.gethostname())
    return config


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "run"
    dry = "--dry-run" in argv
    config = load_config()
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if cmd == "test":
        if not has_destination(config):
            print("no alert destination configured (pilot.sh alert-setup)", file=sys.stderr)
            return 2
        failed = deliver(config, [f"✅ [Hotella {config['HOTELLA_INSTALLATION']}] test message from the platform monitor"])
        print("delivery failed: " + ", ".join(failed) if failed else "test message sent")
        return 1 if failed else 0
    if cmd != "run":
        print(__doc__)
        return 2

    state_file = SECRETS / "monitor-state.json"
    state = json.loads(state_file.read_text()) if state_file.exists() else {}
    facts = collect(config)
    active = evaluate(facts, state.get("facts"))
    send, new_state = transition(state, active, datetime.now(timezone.utc).timestamp())
    new_state["facts"] = {"queues": facts.get("queues", state.get("facts", {}).get("queues", {}))}
    texts = [format_message(config["HOTELLA_INSTALLATION"], m) for m in send]

    if "--json" in argv:
        print(json.dumps({"at": stamp, "facts": facts, "active": active, "send": send}, indent=2, default=str))
    else:
        for t in texts:
            print(f"{stamp} {t}")
        print(f"{stamp} monitor: {len(active)} active alert(s), {len(send)} notification(s)")
    if dry:
        return 0
    if texts and has_destination(config):
        failed = deliver(config, texts)
        if failed:
            # Keep the old state so the same notifications are tried again on the next run.
            print(f"{stamp} monitor: delivery failed ({', '.join(failed)}); will retry", file=sys.stderr)
            return 1
    state_file.write_text(json.dumps(new_state))
    os.chmod(state_file, 0o600)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
