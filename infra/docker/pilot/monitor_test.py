"""Unit tests of the platform monitor's rules (python3 -m unittest discover -s infra/docker/pilot -p '*_test.py')."""

import json
import unittest
from datetime import datetime, timezone

import monitor as m

HEALTHY = {
    "containers": {s: {"state": "running", "health": "healthy"} for s in m.EXPECTED_SERVICES},
    "api_ready": {"ok": True, "detail": "HTTP 200"},
    "openbao": {"sealed": False},
    "backup": {"last_backup_age_h": 3.0, "status_code": 0, "status_message": "ok"},
    "disk": {"/": 40.0},
    "certificates": {"api.example.com": {"days_left": 80}, "agent CA": {"days_left": 3000}},
    "agents": [{"tenant": "SEA", "property": "SBE", "instance": "fias", "status": "HEALTHY", "queue_depth": 0, "unseen_s": 20}],
    "queues": {q: {"waiting": 0, "failed": 5} for q in m.QUEUES},
    "ai_budget": [{"tenant": "SEA", "property": "SBE", "spent_minor": 1000, "limit_minor": 10000}],
}


def keys(alerts):
    return sorted(a["key"] for a in alerts)


class EvaluateTest(unittest.TestCase):
    def test_a_healthy_platform_has_no_alert(self):
        self.assertEqual(m.evaluate(HEALTHY, HEALTHY), [])

    def test_every_rule_fires(self):
        f = json.loads(json.dumps(HEALTHY))
        f["containers"]["worker"]["state"] = "exited"
        del f["containers"]["guest-web"]
        f["containers"]["api"]["health"] = "unhealthy"
        f["api_ready"] = {"ok": False, "detail": "HTTP 503"}
        f["openbao"]["sealed"] = True
        f["backup"] = {"last_backup_age_h": 30, "status_code": 103, "status_message": "archive error"}
        f["disk"] = {"/": 86.0, "/var/lib/docker": 97.0}
        f["certificates"] = {"api.example.com": {"days_left": 10}, "staff.example.com": {"days_left": 2}, "guest.example.com": {"error": "handshake failed"}}
        f["agents"] = [
            {"tenant": "SEA", "property": "SBE", "instance": "fias", "status": "OFFLINE", "queue_depth": 0, "unseen_s": 600},
            {"tenant": "SEA", "property": "SBE", "instance": "db", "status": "AUTH_FAILED", "queue_depth": 1500, "unseen_s": 10},
            {"tenant": "SEA", "property": "SBE", "instance": "pos", "status": "OFFLINE", "queue_depth": None, "unseen_s": None},
        ]
        f["queues"]["guest-realtime"]["waiting"] = 150
        f["queues"]["normal"]["failed"] = 40
        f["ai_budget"] = [
            {"tenant": "SEA", "property": "SBE", "spent_minor": 8500, "limit_minor": 10000},
            {"tenant": "SEA", "property": "B2", "spent_minor": 10000, "limit_minor": 10000},
        ]
        f["probe_errors"] = {"queues": "valkey down"}
        got = {a["key"]: a["severity"] for a in m.evaluate(f, HEALTHY)}
        self.assertEqual(
            got,
            {
                "probe:queues": "WARNING",
                "container:worker": "CRITICAL",
                "container:guest-web": "CRITICAL",
                "container:api": "CRITICAL",
                "api:ready": "CRITICAL",
                "openbao:sealed": "CRITICAL",
                "backup:age": "WARNING",
                "backup:status": "CRITICAL",
                "disk:/": "WARNING",
                "disk:/var/lib/docker": "CRITICAL",
                "cert:api.example.com": "WARNING",
                "cert:staff.example.com": "CRITICAL",
                "cert:guest.example.com": "CRITICAL",
                "agent:SEA:SBE:fias:offline": "CRITICAL",
                "agent:SEA:SBE:db:health": "WARNING",
                "agent:SEA:SBE:db:backlog": "WARNING",
                "queue:guest-realtime:backlog": "WARNING",
                "queue:normal:failed": "WARNING",
                "ai-budget:SEA:SBE": "WARNING",
                "ai-budget:SEA:B2": "CRITICAL",
            },
        )

    def test_boundaries(self):
        f = json.loads(json.dumps(HEALTHY))
        f["backup"]["last_backup_age_h"] = 50
        f["agents"][0]["unseen_s"] = m.AGENT_OFFLINE_AFTER_S  # exactly at the limit: still online
        f["queues"]["normal"]["waiting"] = m.QUEUE_WARN_DEFAULT - 1
        f["queues"]["normal"]["failed"] = 5 + m.FAILED_JOBS_WARN - 1
        self.assertEqual(keys(m.evaluate(f, HEALTHY)), ["backup:age"])
        self.assertEqual(m.evaluate(f, HEALTHY)[0]["severity"], "CRITICAL")
        f["backup"] = {"last_backup_age_h": None, "status_code": 2, "status_message": "no valid backups"}
        self.assertEqual([a["text"] for a in m.evaluate(f, HEALTHY)], ["no backup exists"])

    def test_failed_jobs_need_a_previous_run(self):
        f = json.loads(json.dumps(HEALTHY))
        f["queues"]["normal"]["failed"] = 500
        self.assertEqual(m.evaluate(f, None), [])
        self.assertEqual(keys(m.evaluate(f, HEALTHY)), ["queue:normal:failed"])

    def test_messages_carry_codes_and_numbers_only(self):
        f = json.loads(json.dumps(HEALTHY))
        f["agents"][0]["unseen_s"] = 3600
        (a,) = m.evaluate(f, HEALTHY)
        self.assertEqual(a["text"], "hotel agent offline: SEA/SBE/fias (unseen 60 min)")


class TransitionTest(unittest.TestCase):
    def test_fires_once_reminds_and_resolves_once(self):
        a = m.alert("api:ready", "CRITICAL", "API not ready")
        send, s1 = m.transition({}, [a], 1000)
        self.assertEqual([x["event"] for x in send], ["FIRING"])
        send, s2 = m.transition(s1, [a], 1300)
        self.assertEqual(send, [])
        send, s3 = m.transition(s2, [a], 1000 + m.REMIND_AFTER_S)
        self.assertEqual([x["event"] for x in send], ["STILL FIRING"])
        send, s4 = m.transition(s3, [], 1000 + m.REMIND_AFTER_S + 300)
        self.assertEqual([(x["event"], x["text"]) for x in send], [("RESOLVED", "API not ready")])
        self.assertEqual(s4["firing"], {})
        send, _ = m.transition(s4, [], 99999)
        self.assertEqual(send, [])

    def test_a_change_of_severity_is_a_new_alert(self):
        _, s = m.transition({}, [m.alert("backup:age", "WARNING", "30 h")], 0)
        send, s = m.transition(s, [m.alert("backup:age", "CRITICAL", "60 h")], 60)
        self.assertEqual([(x["event"], x["severity"]) for x in send], [("FIRING", "CRITICAL")])

    def test_format(self):
        self.assertEqual(
            m.format_message("demo", {"event": "RESOLVED", "severity": "CRITICAL", "text": "x"}),
            "✅ [Hotella demo] RESOLVED CRITICAL: x",
        )
        self.assertTrue(m.format_message("demo", {"event": "FIRING", "severity": "CRITICAL", "text": "x"}).startswith("🔴"))


class ParsingTest(unittest.TestCase):
    def test_compose_ps_both_formats(self):
        lines = '{"Service":"api","State":"running","Health":"healthy"}\n{"Service":"worker","State":"exited","Health":""}\n'
        array = '[{"Service":"api","State":"running","Health":"healthy"},{"Service":"worker","State":"exited","Health":""}]'
        want = {"api": {"state": "running", "health": "healthy"}, "worker": {"state": "exited", "health": ""}}
        self.assertEqual(m.parse_compose_ps(lines), want)
        self.assertEqual(m.parse_compose_ps(array), want)
        self.assertEqual(m.parse_compose_ps(""), {})

    def test_pgbackrest_info(self):
        now = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)
        stop = int(now.timestamp()) - 7200
        out = json.dumps([{"backup": [{"timestamp": {"start": stop - 600, "stop": stop - 86400}}, {"timestamp": {"start": stop - 60, "stop": stop}}], "status": {"code": 0, "message": "ok"}}])
        info = m.parse_pgbackrest_info(out, now)
        self.assertAlmostEqual(info["last_backup_age_h"], 2.0)
        self.assertEqual(info["status_code"], 0)
        none = m.parse_pgbackrest_info(json.dumps([{"backup": [], "status": {"code": 2, "message": "no valid backups"}}]), now)
        self.assertIsNone(none["last_backup_age_h"])

    def test_env_and_domain(self):
        self.assertEqual(m.parse_env("# c\nA=1\nB='x y'\n\nC=\"z\"\n"), {"A": "1", "B": "x y", "C": "z"})
        self.assertEqual(m.domain_from_public_url("https://guest.seabeachedge.example/x"), "seabeachedge.example")
        self.assertIsNone(m.domain_from_public_url("http://localhost:3200"))


class DeliveryTest(unittest.TestCase):
    def test_failures_name_the_destination_never_the_secret(self):
        calls = []

        def boom(url, body):
            calls.append(url)
            raise OSError("refused")

        original = m.post_json
        m.post_json = boom
        try:
            failed = m.deliver(
                {"HOTELLA_ALERT_WEBHOOK_URL": "https://hooks.example/secret-path", "HOTELLA_ALERT_TELEGRAM_TOKEN": "123:abc", "HOTELLA_ALERT_TELEGRAM_CHAT_ID": "-1"},
                ["x"],
            )
        finally:
            m.post_json = original
        self.assertEqual(failed, ["webhook", "telegram"])
        self.assertEqual(len(calls), 2)
        self.assertFalse(m.has_destination({}))


if __name__ == "__main__":
    unittest.main()
