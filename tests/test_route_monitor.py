import json
import pathlib
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "static" / "vps"))

import route_monitor
import realtime_client


class MutableClock:
    def __init__(self, value=0.0):
        self.value = value

    def __call__(self):
        return self.value


class FakeClient:
    def __init__(self, connections=None, log_response=None):
        self.connections_data = list(connections or [])
        self.connections_calls = 0
        self.log_calls = 0
        self.log_response = log_response

    def connections(self):
        self.connections_calls += 1
        return {"connections": list(self.connections_data)}

    def logs(self, timeout=30.0):
        self.log_calls += 1
        return self.log_response


class BlockingLogResponse:
    def __init__(self):
        self.started = threading.Event()
        self.closed = threading.Event()

    def __iter__(self):
        self.started.set()
        self.closed.wait(2)
        return iter(())

    def close(self):
        self.closed.set()


class FakeHTTPResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _size=-1):
        return self.payload


def connection(
    connection_id="c1",
    host="example.com",
    target_ip="",
    port=443,
    network="tcp",
    inbound="in-a",
    rule="rule_set=kui-ai-domain",
    rule_payload="",
    chains=("direct-out",),
):
    return {
        "id": connection_id,
        "metadata": {
            "host": host,
            "destinationIP": target_ip,
            "destinationPort": port,
            "network": network,
            "inboundTag": inbound,
        },
        "rule": rule,
        "rulePayload": rule_payload,
        "chains": list(chains),
        "upload": 12,
        "download": 34,
        "start": "2026-01-01T00:00:00Z",
    }


def log_line(payload):
    return json.dumps({"type": "debug", "payload": payload})


def recording_send(sent):
    def send(data, message_type):
        sent.append((message_type, data))
        return True

    return send


def index_rule(group, outbound, action, **match):
    return {
        "group": group,
        "outbound": outbound,
        "action": action,
        "match": match,
    }


class RouteMonitorTests(unittest.TestCase):
    def make_monitor(self, *, client=None, index=None, rule_set_paths=None, revision=1):
        sent = []
        clock = MutableClock()
        monitor = route_monitor.RouteMonitor(
            recording_send(sent),
            client=client or FakeClient(),
            index=index,
            revision=revision,
            proxy_inbounds=("in-a",),
            rule_set_paths=rule_set_paths,
            clock=clock,
            wall_clock=lambda: 1000.0,
            autostart=False,
            async_tests=False,
        )
        self.addCleanup(monitor.close)
        return monitor, sent, clock

    @staticmethod
    def frames(sent, message_type):
        return [data for frame_type, data in sent if frame_type == message_type]

    def test_collection_starts_only_after_subscribe_and_stops_on_unsubscribe_or_lease(self):
        client = FakeClient()
        monitor, sent, clock = self.make_monitor(client=client)

        monitor.tick(0)
        self.assertEqual(client.connections_calls, 0)
        self.assertEqual(sent, [])

        self.assertTrue(monitor.handle_command({"type": "route_log.subscribe"}))
        clock.value = 1.0
        monitor.tick(1.0)
        self.assertEqual(client.connections_calls, 1)
        self.assertEqual(len(self.frames(sent, "route_log.connections")), 1)

        self.assertTrue(monitor.handle_command({"type": "route_log.unsubscribe"}))
        clock.value = 2.0
        monitor.tick(2.0)
        self.assertEqual(client.connections_calls, 1)
        sent_after_unsubscribe = len(sent)

        self.assertTrue(monitor.handle_command({"type": "route_log.ping"}))
        clock.value = 3.0
        monitor.tick(3.0)
        self.assertEqual(client.connections_calls, 2)

        clock.value = 94.0
        monitor.tick(94.0)
        self.assertEqual(client.connections_calls, 2)
        self.assertEqual(len(sent), sent_after_unsubscribe + 1)
        self.assertFalse(monitor._active)

    def test_batches_and_connection_lists_are_bounded(self):
        client = FakeClient(connections=[connection(connection_id=f"c{i}") for i in range(130)])
        monitor, sent, clock = self.make_monitor(client=client)
        monitor.handle_command({"type": "route_log.subscribe"})
        clock.value = 1.0
        monitor.tick(1.0)

        batches = self.frames(sent, "route_log.batch")
        self.assertEqual(len(batches), 1)
        self.assertLessEqual(len(batches[0]["events"]), 50)
        self.assertEqual(len(self.frames(sent, "route_log.connections")[0]["connections"]), 100)
        self.assertTrue(all(event["action"] == "route" for event in batches[0]["events"]))
        self.assertEqual(len({event["id"] for event in batches[0]["events"]}), 50)

        clock.value = 1.6
        monitor.tick(1.6)
        batches = self.frames(sent, "route_log.batch")
        self.assertEqual(len(batches), 2)
        self.assertTrue(all(len(batch["events"]) <= 50 for batch in batches))
        event_ids = [event["id"] for batch in batches for event in batch["events"]]
        self.assertEqual(len(event_ids), 100)
        self.assertEqual(len(set(event_ids)), 100)
        self.assertEqual(len(self.frames(sent, "route_log.connections")), 1)

    def test_connection_rows_are_truncated_and_include_action(self):
        raw = connection(
            connection_id="i" * 80,
            host="h" * 300,
            target_ip="[2001:db8::1]",
            network="tcp-very-long",
            inbound="in-" + "x" * 80,
            rule="r" * 300,
            rule_payload="p" * 300,
        )
        monitor, sent, clock = self.make_monitor(client=FakeClient([raw]))
        monitor.handle_command({"type": "route_log.subscribe"})
        clock.value = 1.0
        monitor.tick(1.0)

        row = self.frames(sent, "route_log.connections")[0]["connections"][0]
        self.assertEqual(row["id"], "i" * 64)
        self.assertEqual(len(row["host"]), 253)
        self.assertEqual(row["target_ip"], "2001:db8::1")
        self.assertEqual(len(row["inbound"]), 64)
        self.assertEqual(row["network"], "tcp-very")
        self.assertEqual(len(row["rule"]), 128)
        self.assertEqual(row["action"], "route")
        self.assertEqual(row["ip_version"], 6)

    def test_reject_log_maps_position_and_dns(self):
        index = [
            index_rule("ai", "residential", "route", inbound=["in-a"], rule_set=["kui-ai-domain"]),
            index_rule("quic_reject", "reject", "reject", inbound=["in-a"], domain_suffix=["blocked.example"]),
            index_rule("final", "direct", "route"),
        ]
        monitor, sent, clock = self.make_monitor(client=FakeClient(), index=index)
        monitor.handle_command({"type": "route_log.subscribe"})
        monitor._handle_log_line(log_line("[123 1ms] inbound/socks[in-a]: inbound connection to blocked.example:443"))
        monitor._handle_log_line(log_line("[123 1ms] dns: lookup succeed for blocked.example: 198.18.8.2"))
        monitor._handle_log_line(
            log_line("[123 1ms] router: match[1] inbound=in-a domain_suffix=blocked.example => reject")
        )
        clock.value = 1.0
        monitor.tick(1.0)

        event = self.frames(sent, "route_log.batch")[0]["events"][0]
        self.assertEqual(event["id"], "123")
        self.assertEqual(event["host"], "blocked.example")
        self.assertEqual(event["target_ip"], "198.18.8.2")
        self.assertEqual(event["rule_group"], "quic_reject")
        self.assertEqual(event["outbound"], "reject")
        self.assertEqual(event["action"], "reject")
        self.assertEqual(event["ip_version"], 4)

    def test_truncated_cidr_and_explicit_catch_all(self):
        cidrs = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"]
        index = [
            index_rule("lan", "direct", "route", inbound=["in-a"], ip_cidr=cidrs),
            index_rule("final", "direct", "route"),
        ]
        raw = connection(rule="inbound=in-a ip_cidr=[10.0.0.0/8 172.16.0.0/12 192.168.0.0/16...] => route(direct-out)")
        monitor, sent, clock = self.make_monitor(client=FakeClient([raw]), index=index)
        monitor.handle_command({"type": "route_log.subscribe"})
        clock.value = 1.0
        monitor.tick(1.0)
        row = self.frames(sent, "route_log.connections")[0]["connections"][0]
        self.assertEqual(row["rule_group"], "lan")
        self.assertLessEqual(len(row["rule"]), 128)
        route_index = route_monitor.RouteIndex(index)
        self.assertEqual(route_index.map_connection(" => route(direct-out)", ["direct-out"])["rule_group"], "final")
        self.assertEqual(route_monitor.RouteIndex(index[:1]).map_connection(" => route(direct-out)", ["direct-out"])["rule_group"], "unknown")

    def test_log_context_never_maps_to_connection_id(self):
        index = [
            index_rule("ai", "residential", "route", inbound=["in-a"], domain_suffix=["ai.example"]),
            index_rule("final", "direct", "route"),
        ]
        monitor, sent, clock = self.make_monitor(client=FakeClient([connection(connection_id="123", rule="unrecognized")]), index=index)
        monitor.handle_command({"type": "route_log.subscribe"})
        monitor._handle_log_line(log_line("[123 1ms] router: match[0] inbound=in-a domain_suffix=ai.example => route(socks5-outbound)"))
        clock.value = 1.0
        monitor.tick(1.0)
        row = self.frames(sent, "route_log.connections")[0]["connections"][0]
        self.assertEqual(row["rule_group"], "unknown")
        self.assertEqual(row["outbound"], "direct")

    def test_udp_reject_with_user_prefix(self):
        index = [index_rule("quic_reject", "reject", "reject", network=["udp"], port=[443])]
        monitor, sent, clock = self.make_monitor(client=FakeClient(), index=index)
        monitor.handle_command({"type": "route_log.subscribe"})
        monitor._handle_log_line(log_line("[42 112ms] inbound/socks[in-a]: [fixture] inbound packet connection to blocked.example:443"))
        monitor._handle_log_line(log_line("[42 2ms] router: match[0] network=udp port=443 => reject"))
        clock.value = 1.0
        monitor.tick(1.0)
        event = self.frames(sent, "route_log.batch")[0]["events"][0]
        self.assertEqual((event["network"], event["rule_group"], event["action"]), ("udp", "quic_reject", "reject"))

    def test_tuic_tcp_stream_reports_inner_transport(self):
        index = [index_rule("ipv6_reject", "reject", "reject", ip_version=6)]
        monitor, sent, clock = self.make_monitor(client=FakeClient(), index=index)
        monitor.handle_command({"type": "route_log.subscribe"})
        monitor._handle_log_line(log_line("[31 1ms] inbound/tuic[in-a]: [fixture] inbound connection to [2001:db8::1]:443"))
        monitor._handle_log_line(log_line("[31 2ms] router: match[0] ip_version=6 => reject"))
        clock.value = 1.0
        monitor.tick(1.0)
        event = self.frames(sent, "route_log.batch")[0]["events"][0]
        self.assertEqual(event["network"], "tcp")

    def test_dns_supplements_connection_target_ip(self):
        monitor, sent, clock = self.make_monitor(
            client=FakeClient([connection(host="chatgpt.com", target_ip="")])
        )
        monitor.handle_command({"type": "route_log.subscribe"})
        monitor._handle_log_line(log_line("[9 1ms] dns: lookup succeed for chatgpt.com: 198.18.8.2"))
        clock.value = 1.0
        monitor.tick(1.0)

        event = self.frames(sent, "route_log.batch")[0]["events"][0]
        self.assertEqual(event["host"], "chatgpt.com")
        self.assertEqual(event["target_ip"], "198.18.8.2")
        self.assertEqual(event["action"], "route")

    def test_ipv6_inbound_is_unwrapped(self):
        index = [
            index_rule("custom_direct", "direct", "route", inbound=["in-a"], domain_suffix=["blocked.example"]),
            index_rule("quic_reject", "reject", "reject", inbound=["in-a"], domain_suffix=["blocked.example"]),
            index_rule("final", "direct", "route"),
        ]
        monitor, sent, clock = self.make_monitor(client=FakeClient(), index=index)
        monitor.handle_command({"type": "route_log.subscribe"})
        monitor._handle_log_line(
            log_line("[55 1ms] inbound/socks[in-a]: inbound connection to [2001:db8::1]:443")
        )
        monitor._handle_log_line(
            log_line("[55 1ms] router: match[1] inbound=in-a domain_suffix=blocked.example => reject")
        )
        clock.value = 1.0
        monitor.tick(1.0)

        event = self.frames(sent, "route_log.batch")[0]["events"][0]
        self.assertEqual(event["host"], "2001:db8::1")
        self.assertNotIn("[", event["host"])
        self.assertEqual(event["ip_version"], 6)

    def test_rule_set_matching_is_exact_with_or_semantics(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = pathlib.Path(temp_dir) / "rules.json"
            path.write_text(
                json.dumps({
                    "version": 2,
                    "rules": [
                        {"domain_suffix": ["ai.example"]},
                        {"domain_suffix": ["exact.example"], "domain_keyword": ["needle"]},
                        {"domain_keyword": ["video"]},
                        {"ip_cidr": ["198.18.0.0/15"]},
                        {"ip_version": [6]},
                    ],
                }),
                encoding="utf-8",
            )
            matcher = route_monitor.RuleSetMatcher(str(path))
            self.assertTrue(matcher.matches("sub.ai.example", 0))
            self.assertTrue(matcher.matches("exact.example", 0))
            self.assertTrue(matcher.matches("needle.exact.example", 0))
            self.assertTrue(matcher.matches("needle.other.example", 0))
            self.assertTrue(matcher.matches("video.example", 0))
            self.assertTrue(matcher.matches("198.18.8.2", 4))
            self.assertTrue(matcher.matches("2001:db8::1", 6))
            self.assertFalse(matcher.matches("other.example", 0))

    def test_rule_set_address_and_ip_version_conditions(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = pathlib.Path(temp_dir) / "rules.json"
            path.write_text(
                json.dumps({
                    "version": 2,
                    "rules": [
                        {
                            "domain_suffix": ["mixed.example"],
                            "ip_cidr": ["198.18.0.0/15"],
                        },
                        {"ip_cidr": ["192.0.2.0/24"], "ip_version": [6]},
                    ],
                }),
                encoding="utf-8",
            )
            matcher = route_monitor.RuleSetMatcher(str(path))
            self.assertTrue(matcher.matches("mixed.example", 0))
            self.assertTrue(matcher.matches("sub.mixed.example", 0))
            self.assertTrue(matcher.matches("198.18.8.2", 4))
            self.assertFalse(matcher.matches("192.0.2.1", 4))
            self.assertFalse(matcher.matches("2001:db8::1", 6))

    def test_route_index_mixed_address_or_and_ip_version_and(self):
        index = [
            index_rule(
                "custom_direct", "direct", "route",
                inbound=["in-a"],
                domain_suffix=["mixed.example"],
                ip_cidr=["198.18.0.0/15"],
            ),
            index_rule(
                "stack_reject", "reject", "reject",
                inbound=["in-a"],
                ip_cidr=["198.18.0.0/15"],
                ip_version=[4],
            ),
            index_rule(
                "stack_reject", "reject", "reject",
                inbound=["in-a"],
                ip_cidr=["2001:db8::/32"],
                ip_version=[6],
            ),
            index_rule("final", "direct", "route"),
        ]
        route_index = route_monitor.RouteIndex(index, proxy_inbounds=("in-a",))
        self.assertEqual(
            route_index.test("mixed.example", 0)["rule_group"], "custom_direct"
        )
        self.assertEqual(
            route_index.test("198.18.8.2", 4)["rule_group"], "custom_direct"
        )
        self.assertEqual(
            route_index.test("2001:db8::1", 6)["rule_group"], "stack_reject"
        )
        self.assertIsNone(
            route_monitor.RouteIndex(
                [
                    index_rule(
                        "stack_reject", "reject", "reject",
                        inbound=["in-a"],
                        ip_cidr=["198.18.0.0/15"],
                        ip_version=[6],
                    ),
                ],
                proxy_inbounds=("in-a",),
            ).test("198.18.8.2", 4)
        )

    def test_route_index_invert_applies_to_the_whole_rule(self):
        index = [
            index_rule(
                "custom_direct", "direct", "route",
                inbound=["in-a"],
                domain_suffix=["blocked.example"],
                invert=True,
            ),
            index_rule("final", "direct", "route"),
        ]
        route_index = route_monitor.RouteIndex(index, proxy_inbounds=("in-a",))
        self.assertEqual(
            route_index.test("blocked.example", 0)["rule_group"], "final"
        )
        self.assertEqual(
            route_index.test("allowed.example", 0)["rule_group"], "custom_direct"
        )

    def test_route_test_or_semantics_and_exact_precedence(self):
        index = [
            index_rule(
                "custom_direct", "direct", "route",
                inbound=["in-a"],
                domain_suffix=["exact.example"],
                domain_keyword=["needle"],
            ),
            index_rule("ai", "residential", "route", inbound=["in-a"], domain_suffix=["example"]),
            index_rule("final", "direct", "route", inbound=["in-a"]),
        ]
        route_index = route_monitor.RouteIndex(index, proxy_inbounds=("in-a",))
        self.assertEqual(route_index.test("exact.example", 0)["rule_group"], "custom_direct")
        self.assertEqual(route_index.test("needle.other.test", 0)["rule_group"], "custom_direct")
        self.assertEqual(route_index.test("sub.example", 0)["rule_group"], "ai")
        self.assertEqual(route_index.test("unlisted.test", 0)["rule_group"], "final")

    def test_default_route_test_is_tcp_443_and_skips_quic_stack_rules(self):
        index = [
            index_rule(
                "quic_reject", "reject", "reject",
                inbound=["in-a"],
                network=["udp"],
                port=[443],
                domain_suffix=["quic.example"],
            ),
            index_rule("quic_reject", "reject", "reject", protocol=["quic"], domain_suffix=["quic.example"]),
            index_rule(
                "stack_reject", "reject", "reject",
                inbound=["in-a"],
                ip_version=[6],
                ip_cidr=["::/0"],
            ),
            index_rule(
                "custom_direct", "direct", "route",
                inbound=["in-a"],
                domain_suffix=["quic.example"],
            ),
        ]
        route_index = route_monitor.RouteIndex(index, proxy_inbounds=("in-a",))
        decision = route_index.test("quic.example", 0)
        self.assertEqual(decision["rule_group"], "custom_direct")
        decision = route_index.test("2001:db8::1", 6)
        self.assertEqual(decision["rule_group"], "stack_reject")
        decision = route_index.test(
            "quic.example", 0, network="udp", port=443
        )
        self.assertEqual(decision["rule_group"], "quic_reject")

    def test_route_test_never_assumes_final_without_a_matching_rule(self):
        route_index = route_monitor.RouteIndex(
            [index_rule("ai", "residential", "route", inbound=["in-a"], domain_suffix=["ai.example"])],
            proxy_inbounds=("in-a",),
        )
        self.assertIsNone(route_index.test("other.example", 0))

        monitor, sent, _clock = self.make_monitor(index=route_index.raw, revision=5)
        monitor.handle_command({
            "type": "route_log.test",
            "request_id": "no-final",
            "target": "other.example",
            "revision": 5,
        })
        result = self.frames(sent, "route_log.test.result")[-1]
        self.assertNotIn("scope", result)
        self.assertIn("error", result)

    def test_map_connection_requires_exact_rule_and_never_guesses_final(self):
        index = [
            index_rule("ai", "residential", "route", inbound=["in-a"], rule_set=["shared"]),
            index_rule(
                "quic_reject", "reject", "reject",
                inbound=["in-a"],
                rule_set=["shared"],
                network=["udp"],
                port=[443],
            ),
            index_rule("final", "direct", "route"),
        ]
        route_index = route_monitor.RouteIndex(index, proxy_inbounds=("in-a",))

        decision = route_index.map_connection("", ["direct-out"])
        self.assertEqual(decision["outbound"], "direct")
        self.assertEqual(decision["rule_group"], "unknown")

        decision = route_index.map_connection("rule_set=shared", ["direct-out"])
        self.assertEqual(decision["rule_group"], "unknown")
        self.assertEqual(decision["outbound"], "direct")

        decision = route_index.map_connection(
            "inbound=in-a rule_set=shared network=udp port=443 => reject", []
        )
        self.assertEqual(decision["rule_group"], "quic_reject")
        self.assertEqual(decision["action"], "reject")

        decision = route_index.map_connection("final", ["direct-out"])
        self.assertEqual(decision["rule_group"], "final")

    def test_dns_prefers_ipv4_and_keeps_first_family(self):
        monitor, _sent, _clock = self.make_monitor(client=FakeClient())
        monitor.handle_command({"type": "route_log.subscribe"})
        monitor._handle_log_line(
            log_line("[123 1ms] dns: lookup succeed for localhost: 127.0.0.1 ::1")
        )
        self.assertEqual(monitor._dns_cache["localhost"], "127.0.0.1")
        monitor._handle_log_line(
            log_line("[123 1ms] dns: lookup succeed for localhost: ::1")
        )
        self.assertEqual(monitor._dns_cache["localhost"], "127.0.0.1")

        monitor._handle_log_line(
            log_line("[123 1ms] dns: lookup succeed for v6.example: ::1 2001:db8::1")
        )
        self.assertEqual(monitor._dns_cache["v6.example"], "::1")

    def test_rule_set_missing_or_unsupported_is_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            missing = pathlib.Path(temp_dir) / "missing.json"
            unsupported = pathlib.Path(temp_dir) / "unsupported.json"
            unsupported.write_text(
                json.dumps({"version": 2, "rules": [{"process_name": ["curl"]}]}),
                encoding="utf-8",
            )
            index = [index_rule("final", "direct", "route")]

            missing_index = route_monitor.RouteIndex(
                [index_rule("ai", "residential", "route", rule_set=["missing"])] + index,
                proxy_inbounds=("in-a",),
                rule_set_paths={"missing": str(missing)},
            )
            with self.assertRaises(route_monitor.RuleSetUnavailable):
                missing_index.test("example.com", 0)

            unsupported_index = route_monitor.RouteIndex(
                [index_rule("ai", "residential", "route", rule_set=["unsupported"])] + index,
                proxy_inbounds=("in-a",),
                rule_set_paths={"unsupported": str(unsupported)},
            )
            with self.assertRaises(route_monitor.RuleSetUnavailable):
                unsupported_index.test("example.com", 0)

            unknown_match_index = route_monitor.RouteIndex(
                [index_rule("final", "direct", "route", process_name=["curl"])],
                proxy_inbounds=("in-a",),
            )
            with self.assertRaises(route_monitor.RouteTestUnavailable):
                unknown_match_index.test("example.com", 0)

            monitor, sent, _clock = self.make_monitor(
                index=[
                    index_rule("ai", "residential", "route", rule_set=["missing"]),
                    index_rule("final", "direct", "route"),
                ],
                rule_set_paths={"missing": str(missing)},
                revision=3,
            )
            monitor.handle_command({
                "type": "route_log.test",
                "request_id": "missing-rule-set",
                "target": "example.com",
                "revision": 3,
            })
            result = self.frames(sent, "route_log.test.result")[-1]
            self.assertNotIn("scope", result)
            self.assertIn("error", result)

    def test_route_test_uses_loaded_rule_set_path(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = pathlib.Path(temp_dir) / "ai.json"
            path.write_text(
                json.dumps({"version": 2, "rules": [{"domain_suffix": ["ai.example"]}]}),
                encoding="utf-8",
            )
            index = [
                index_rule("ai", "residential", "route", inbound=["in-a"], rule_set=["kui-ai-domain"]),
                index_rule("final", "direct", "route"),
            ]
            monitor, sent, _clock = self.make_monitor(
                index=index,
                rule_set_paths={"kui-ai-domain": str(path)},
                revision=4,
            )
            monitor.handle_command({
                "type": "route_log.test",
                "request_id": "rule-set",
                "target": "chat.ai.example",
                "revision": 4,
            })
            result = self.frames(sent, "route_log.test.result")[-1]
            self.assertEqual(result["scope"], "agent")
            self.assertEqual(result["rule_group"], "ai")

            monitor.handle_command({
                "type": "route_log.test",
                "request_id": "final",
                "target": "other.example",
                "revision": 4,
            })
            result = self.frames(sent, "route_log.test.result")[-1]
            self.assertEqual(result["scope"], "agent")
            self.assertEqual(result["rule_group"], "final")
            self.assertEqual(result["outbound"], "direct")

    def test_map_connection_does_not_infer_group_from_rule_set_tag_alone(self):
        index = [
            None,
            index_rule("ai", "residential", "route", inbound=["in-a"], rule_set=["kui-ai-domain"]),
            index_rule("final", "direct", "route"),
        ]
        route_index = route_monitor.RouteIndex(index, proxy_inbounds=("in-a",))
        decision = route_index.map_connection("rule_set=kui-ai-domain", [])
        self.assertEqual(decision["rule_group"], "unknown")
        self.assertEqual(decision["outbound"], "unknown")

    def test_map_connection_separates_quic_and_stack_reject_with_same_tag(self):
        index = [
            index_rule("ai", "residential", "route", inbound=["in-a"], rule_set=["shared"]),
            index_rule(
                "quic_reject", "reject", "reject",
                inbound=["in-a"],
                rule_set=["shared"],
                network=["udp"],
                port=[443],
            ),
            index_rule(
                "stack_reject", "reject", "reject",
                inbound=["in-a"],
                rule_set=["shared"],
                ip_version=[6],
            ),
            index_rule("final", "direct", "route"),
        ]
        route_index = route_monitor.RouteIndex(index, proxy_inbounds=("in-a",))

        decision = route_index.map_connection("rule_set=shared", ["direct-out"])
        self.assertEqual(decision["rule_group"], "unknown")
        self.assertEqual(decision["outbound"], "direct")

        decision = route_index.map_connection(
            "inbound=in-a rule_set=shared network=udp port=443 => reject", []
        )
        self.assertEqual(decision["rule_group"], "quic_reject")
        decision = route_index.map_connection(
            "inbound=in-a rule_set=shared ip_version=6 => reject", []
        )
        self.assertEqual(decision["rule_group"], "stack_reject")

    def test_map_connection_fallback_keeps_known_outbound_only(self):
        route_index = route_monitor.RouteIndex(
            [index_rule("final", "direct", "route")],
            proxy_inbounds=("in-a",),
        )
        self.assertEqual(
            route_index.map_connection("", ["reject-out"]),
            {"rule_group": "unknown", "outbound": "reject", "action": "reject"},
        )
        self.assertEqual(
            route_index.map_connection("", ["socks5-outbound"]),
            {"rule_group": "unknown", "outbound": "residential", "action": "route"},
        )
        self.assertEqual(
            route_index.map_connection("", ["some-proxy-out"]),
            {"rule_group": "unknown", "outbound": "residential", "action": "route"},
        )
        self.assertEqual(
            route_index.map_connection("", ["unknown-out"]),
            {"rule_group": "unknown", "outbound": "unknown", "action": "unknown"},
        )

    def test_invalid_new_index_keeps_matching_previous_revision(self):
        index = [index_rule("ai", "residential", "route", domain_suffix=["ai.example"])]
        monitor, sent, _clock = self.make_monitor(index=index, revision=7)
        with mock.patch.object(route_monitor, "RouteIndex", side_effect=ValueError("invalid rule")):
            with self.assertRaises(ValueError):
                monitor.update(index=[], revision=8, secret="changed")
        monitor.handle_command({"type": "route_log.test", "request_id": "fixture-1", "target": "ai.example", "revision": 7})
        self.assertEqual(self.frames(sent, "route_log.test.result")[-1]["rule_group"], "ai")
        previous = monitor.update(index=[], revision=8)
        monitor.update(**previous)
        monitor.handle_command({"type": "route_log.test", "request_id": "fixture-2", "target": "ai.example", "revision": 7})
        self.assertEqual(self.frames(sent, "route_log.test.result")[-1]["rule_group"], "ai")

    def test_route_test_contract_revision_and_update_preserves_index(self):
        index = [
            index_rule("ai", "residential", "route", inbound=["in-a"], domain_suffix=["ai.example"]),
            index_rule("final", "direct", "route"),
        ]
        monitor, sent, _clock = self.make_monitor(index=index, revision=7)

        self.assertTrue(monitor.handle_command({
            "type": "route_log.test",
            "request_id": "request-1",
            "target": "sub.ai.example",
            "revision": 7,
        }))
        result = self.frames(sent, "route_log.test.result")[-1]
        self.assertEqual(result["request_id"], "request-1")
        self.assertEqual(result["revision"], 7)
        self.assertEqual(result["scope"], "agent")
        self.assertEqual(result["rule_group"], "ai")
        self.assertEqual(result["outbound"], "residential")
        self.assertEqual(result["action"], "route")

        monitor.update(revision=8, rule_set_paths="not-a-dict")
        self.assertTrue(monitor.handle_command({
            "type": "route_log.test",
            "request_id": "request-2",
            "target": "sub.ai.example",
            "revision": 8,
        }))
        result = self.frames(sent, "route_log.test.result")[-1]
        self.assertEqual(result["scope"], "agent")
        self.assertEqual(result["rule_group"], "ai")

        monitor.handle_command({
            "type": "route_log.test",
            "request_id": "request-3",
            "target": "sub.ai.example",
            "revision": 7,
        })
        result = self.frames(sent, "route_log.test.result")[-1]
        self.assertNotIn("scope", result)
        self.assertIn("revision", result)

        monitor.handle_command({
            "type": "route_log.test",
            "request_id": "request-4",
            "target": "not a target",
            "revision": 8,
        })
        result = self.frames(sent, "route_log.test.result")[-1]
        self.assertNotIn("scope", result)

    def test_clash_secret_never_leaks(self):
        secret = "probe-secret-that-must-not-leak"
        client = route_monitor.ClashApiClient("http://127.0.0.1:39483", secret=secret)
        self.assertNotIn(secret, repr(client))

        captured = {}

        def fake_open(request, timeout=None):
            captured["url"] = request.full_url
            captured["headers"] = dict(request.header_items())
            return FakeHTTPResponse(json.dumps({"connections": []}).encode("utf-8"))

        with mock.patch.object(client._opener, "open", side_effect=fake_open):
            client.connections()
        self.assertNotIn(secret, captured["url"])
        self.assertIn(secret, captured["headers"].get("Authorization", ""))

        logs = []
        monitor = route_monitor.RouteMonitor(
            recording_send([]),
            client=client,
            secret=secret,
            clock=MutableClock(),
            autostart=False,
            logger=logs.append,
        )
        self.addCleanup(monitor.close)
        monitor.handle_command({"type": "route_log.subscribe"})
        with mock.patch.object(client._opener, "open", side_effect=RuntimeError(f"failed {secret}")):
            monitor.tick(1.0)
        self.assertNotIn(secret, "\n".join(logs))
        self.assertNotIn(secret, repr(monitor))

    def test_stop_releases_log_stream(self):
        response = BlockingLogResponse()
        client = FakeClient(log_response=response)
        monitor = route_monitor.RouteMonitor(
            recording_send([]),
            client=client,
            autostart=True,
            clock=time.monotonic,
            wall_clock=time.time,
            poll_interval=0.2,
            batch_interval=0.1,
            connections_interval=0.5,
        )
        self.addCleanup(monitor.close)
        monitor.handle_command({"type": "route_log.subscribe"})
        self.assertTrue(response.started.wait(1.0))
        monitor.stop()
        self.assertTrue(response.closed.wait(1.0))
        self.assertFalse(monitor._active)

    def test_unsubscribe_releases_log_stream(self):
        response = BlockingLogResponse()
        client = FakeClient(log_response=response)
        monitor = route_monitor.RouteMonitor(
            recording_send([]),
            client=client,
            autostart=True,
            clock=time.monotonic,
            wall_clock=time.time,
            poll_interval=0.2,
            batch_interval=0.1,
            connections_interval=0.5,
        )
        self.addCleanup(monitor.close)
        monitor.handle_command({"type": "route_log.subscribe"})
        self.assertTrue(response.started.wait(1.0))
        monitor.handle_command({"type": "route_log.unsubscribe"})
        self.assertTrue(response.closed.wait(1.0))
        self.assertFalse(monitor._active)

    def test_hello_capabilities_only_announce_route_log_for_opted_in_core(self):
        default_core = realtime_client.RealtimeChannel(
            "https://example.invalid", "198.51.100.10", "token", "core"
        )._hello_capabilities()
        self.assertEqual(
            default_core,
            ["http-fallback", "config-refresh", "config-result", "egress-probe"],
        )
        self.assertNotIn("route_log", default_core)
        self.assertNotIn("warp-optimizer", default_core)

        opted_in_core = realtime_client.RealtimeChannel(
            "https://example.invalid", "198.51.100.10", "token", "core",
            capabilities=["route_log", "warp-optimizer"],
        )._hello_capabilities()
        self.assertIn("route_log", opted_in_core)
        self.assertNotIn("warp-optimizer", opted_in_core)

        proxy = realtime_client.RealtimeChannel(
            "https://example.invalid", "198.51.100.11", "token", "proxy",
            capabilities=["route_log"],
        )._hello_capabilities()
        self.assertNotIn("route_log", proxy)
        self.assertNotIn("warp-optimizer", proxy)


if __name__ == "__main__":
    unittest.main()
