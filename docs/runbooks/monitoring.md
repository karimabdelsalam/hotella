# Runbook — monitoring and alerts

The platform host checks itself every five minutes and sends an alert when something needs a person (checklist §17,
BUILD_PLAN pilot P.2). Logs, metrics and traces for investigation stay in the Grafana stack (`otel-lgtm`, profile
`observability`).

## How it works
`/etc/cron.d/hotella` runs `hotella monitor` every five minutes (installer). The monitor is
`infra/docker/pilot/monitor.py` (Python standard library, no packages). For each run:
1. **Probe.** Docker Compose, the API, OpenBao, pgBackRest, the disks, the TLS endpoints, PostgreSQL (read-only
   queries as the admin role) and Valkey.
2. **Evaluate.** It applies fixed rules (below).
3. **Notify.**
   - A new alert is sent once (`FIRING`).
   - An alert that lasts is repeated every 12 hours (`STILL FIRING`).
   - An alert that clears is sent once (`RESOLVED`).
   - A change of severity counts as a new alert.

State lives in `infra/docker/pilot/.secrets/monitor-state.json`. If delivery fails, the state is not saved, so the
same notifications go out on the next run.

Messages carry codes and numbers only: service names, tenant/property codes, connector names, ages, percentages. They
never carry guest or staff data.

| Alert | Severity | Rule |
|---|---|---|
| `container:<service>` | CRITICAL | postgres, valkey, s3, openbao, api, worker, agent-gateway, staff-web or guest-web not running or unhealthy |
| `api:ready` | CRITICAL | `GET /api/v1/ready` is not 200 |
| `openbao:sealed` | CRITICAL | OpenBao is sealed (after a reboot: `hotella unseal && hotella start`) |
| `backup:age` | WARNING ≥ 26 h, CRITICAL ≥ 50 h or none | age of the newest pgBackRest backup |
| `backup:status` | CRITICAL | pgBackRest reports an error for the stanza |
| `disk:<path>` | WARNING ≥ 85 %, CRITICAL ≥ 95 % | `/` and `/var/lib/docker` |
| `cert:<name>` | WARNING ≤ 14 days, CRITICAL ≤ 3 days or unreachable | `api.`, `staff.`, `guest.<domain>` (443), the agent gateway and the agent CA |
| `agent:…:offline` | CRITICAL | an active connector's agent unseen for more than 3 minutes (the integration's own rule) |
| `agent:…:health` | WARNING | integration health DEGRADED, AUTH_FAILED or MISCONFIGURED |
| `agent:…:backlog` | WARNING | ≥ 1000 messages queued on a hotel agent |
| `queue:<queue>:backlog` | WARNING | waiting jobs ≥ 100 (critical-operational, guest-realtime) or ≥ 1000 (others) |
| `queue:<queue>:failed` | WARNING | ≥ 20 new failed jobs since the last run |
| `ai-budget:<tenant>:<property>` | WARNING ≥ 80 %, CRITICAL 100 % | external AI spend this month against `ai.budget.monthly_limit_minor` |
| `probe:<name>` | WARNING | a probe could not run (the others still do) |

Changing a threshold is a code change with its unit test (`monitor_test.py`).

## Setting up where alerts go
Either destination works, or both:

```bash
sudo hotella alert-setup telegram   # asks for the bot token and the chat id (create the bot with @BotFather)
sudo hotella alert-setup webhook    # asks for an https URL that accepts {"text": "…"} (Slack, Google Chat, Mattermost, Teams workflow)
```

The values are asked for, never passed on the command line, and are kept in `.secrets/alerting.env` (mode 0600). A test
message is sent at once. `hotella monitor --dry-run` shows what would be sent without sending it or saving state.
`--json` prints the facts as well.

Without a destination, alerts only go to `/var/log/hotella-monitor.log`.

## When an alert arrives
| Alert | First step |
|---|---|
| container / api | `hotella status`; `docker compose -p hotella-pilot -f /opt/hotella/infra/docker/compose.pilot.yml logs --tail=200 <service>`; `hotella start` |
| openbao:sealed | two custodians unseal (deploy runbook), then `hotella start` |
| backup | `hotella backup full`; read `/var/log/hotella-backup.log`; backup-restore runbook |
| disk | find what grew (`docker system df`, the backup repository); never delete WAL archives by hand |
| cert | Caddy renews public certificates by itself; an alert means renewal failed (`journalctl -u caddy`) — check DNS and port 80. The agent gateway certificate and CA: secret-rotation runbook |
| agent offline | ask the hotel whether the agent host and its internet are up; `hotella-agent status` on the agent host; nothing is lost while it is offline (its queue holds the messages) |
| queue | worker logs; failed jobs are kept in Valkey for inspection |
| ai-budget | the hotel's manager decides whether to raise `ai.budget.monthly_limit_minor`; guest AI falls back to staff when it is used up |
