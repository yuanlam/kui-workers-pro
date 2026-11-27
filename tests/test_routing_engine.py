import json
import io
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "static" / "vps"))
import routing_engine
from route_monitor import RouteIndex


class RoutingEngineTests(unittest.TestCase):
    @staticmethod
    def _route_index(policy, directory):
        path = pathlib.Path(directory, "rules.json")
        path.write_text(json.dumps({"version": 2, "rules": []}), encoding="utf-8")
        relative_paths = {ruleset["tag"]: str(path) for ruleset in policy["rulesets"]}
        return RouteIndex(policy["index"], proxy_inbounds=("in-node",), rule_set_paths=relative_paths)

    def test_modes_and_stack_matrix(self):
        for mode, proxy_mode in (("native", "global"), ("residential", "global"), ("residential", "selective")):
            for stack in ("dual", "ipv4_only", "ipv6_only"):
                config = {"mode": mode, "proxy_mode": proxy_mode, "ip_stack": stack, "proxy_categories": "custom", "proxy_custom_rules": ["full:example.com"]}
                with self.subTest(mode=mode, proxy_mode=proxy_mode, stack=stack):
                    if mode == "residential" and proxy_mode == "global" and stack == "ipv6_only":
                        with self.assertRaises(ValueError):
                            routing_engine.build_routing_policy(config)
                        continue
                    policy = routing_engine.build_routing_policy(config, proxy_inbounds=["in-node"])
                    self.assertEqual(len(policy["index"]), len(policy["route_rules"]))
                    self.assertEqual(len(policy["groups"]), len(set(policy["groups"])))
                    self.assertTrue(policy["dns"]["reverse_mapping"])
                    self.assertEqual(policy["dns"]["cache_capacity"], 4096)
                    if mode == "residential":
                        self.assertTrue(any(rule.get("action") == "resolve" and rule.get("server") == "proxy-dns" for rule in policy["route_rules"]))

    def test_cache_keeps_previous_content_when_refreshed(self):
        entry = {"tag": "fixture", "format": "source", "url": "https://example.org/rules.json"}
        class Response:
            def __init__(self, content): self.content = content
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, _size): return self.content
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(routing_engine, "SELECTIVE_PROXY_RULE_SETS", [entry]), mock.patch.object(routing_engine.subprocess, "run") as compile_rules:
            with mock.patch.object(routing_engine, "_download_rule_set", return_value=Response(b'{"version":2,"rules":[]}')):
                first = routing_engine.prepare_rule_sets(directory)["fixture"]
            with mock.patch.object(routing_engine.time, "time", return_value=9999999999), mock.patch.object(routing_engine, "_download_rule_set", return_value=Response(b'{"version":2,"rules":[{"domain":["example.com"]}]}')):
                second = routing_engine.prepare_rule_sets(directory)["fixture"]
            self.assertNotEqual(first, second)
            self.assertEqual(json.loads(pathlib.Path(first).read_text())["rules"], [])
            self.assertTrue(pathlib.Path(second).exists())

    def test_quic_protocol_reject_is_separate_from_udp_443(self):
        policy = routing_engine.build_routing_policy({
            "mode": "residential", "proxy_mode": "selective", "ip_stack": "dual",
            "proxy_categories": "custom", "proxy_custom_rules": ["full:example.com"],
        }, proxy_inbounds=["in-node"])
        rules = policy["route_rules"]
        self.assertTrue(any(item.get("protocol") == ["quic"] for item in rules))
        self.assertTrue(any(item.get("network") == ["udp"] and item.get("port") == [443] for item in rules))
        self.assertTrue(any((item or {}).get("match", {}).get("protocol") == ["quic"] for item in policy["index"]))

    def test_ai_exact_domains_route_matrix(self):
        domains = ("geminiweb-pa.clients6.google.com", "gemini.gstatic.com")
        cases = (
            ("ai", {"proxy_categories": "ai"}, "socks5-outbound", {
                domains[0]: {"rule_group": "ai", "outbound": "residential", "action": "route"},
                domains[1]: {"rule_group": "ai", "outbound": "residential", "action": "route"},
            }),
            ("google", {"proxy_categories": "google"}, "direct-out", {
                domains[0]: {"rule_group": "ai", "outbound": "direct", "action": "route"},
                domains[1]: {"rule_group": "ai", "outbound": "direct", "action": "route"},
            }),
            ("custom_direct", {"proxy_categories": "ai", "proxy_direct_rules": ["full:gemini.gstatic.com"]}, "socks5-outbound", {
                domains[0]: {"rule_group": "ai", "outbound": "residential", "action": "route"},
                domains[1]: {"rule_group": "custom_direct", "outbound": "direct", "action": "route"},
            }),
        )
        with tempfile.TemporaryDirectory() as directory:
            for name, settings, exact_outbound, expected in cases:
                config = {"mode": "residential", "proxy_mode": "selective", "ip_stack": "dual", **settings}
                policy = routing_engine.build_routing_policy(config, proxy_inbounds=["in-node"])
                rules = policy["route_rules"]
                exact_rule = next(rule for rule in rules if rule.get("domain") == ["geminiweb-pa.clients6.google.com", "gemini.gstatic.com"] and "outbound" in rule)
                rule_set_rule = next(rule for rule in rules if "kui-ai-domain" in (rule.get("rule_set") or []))
                route_index = self._route_index(policy, directory)
                with self.subTest(case=name):
                    self.assertEqual(exact_rule["outbound"], exact_outbound)
                    self.assertLess(rules.index(exact_rule), rules.index(rule_set_rule))
                    for domain, decision in expected.items():
                        self.assertEqual(route_index.test(domain, 0), decision)
                    if name == "ai":
                        self.assertTrue(any(
                            rule.get("domain") == ["geminiweb-pa.clients6.google.com", "gemini.gstatic.com"]
                            and rule.get("server") == "proxy-dns"
                            for rule in policy["dns_rules"]
                        ))

    def test_ai_exact_domains_do_not_match_subdomains(self):
        with tempfile.TemporaryDirectory() as directory:
            policy = routing_engine.build_routing_policy({
                "mode": "residential", "proxy_mode": "selective", "proxy_categories": "ai",
            }, proxy_inbounds=["in-node"])
            route_index = self._route_index(policy, directory)
            self.assertEqual(route_index.test("gemini.gstatic.com", 0), {"rule_group": "ai", "outbound": "residential", "action": "route"})
            self.assertEqual(route_index.test("sub.gemini.gstatic.com", 0), {"rule_group": "final", "outbound": "direct", "action": "route"})

    def test_invalid_mirror_candidate_preserves_cache_pointer(self):
        entry = {"tag": "fixture", "format": "source", "url": "https://example.org/rules.json"}
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(routing_engine, "SELECTIVE_PROXY_RULE_SETS", [entry]), mock.patch.object(routing_engine.subprocess, "run") as compile_rules:
            with mock.patch.object(routing_engine, "_download_rule_set", return_value=io.BytesIO(b'{"version":2,"rules":[]}')):
                current = routing_engine.prepare_rule_sets(directory)
            marker = pathlib.Path(directory, "fixture.current")
            previous = marker.read_bytes()
            compile_rules.side_effect = routing_engine.subprocess.CalledProcessError(1, "sing-box")
            with mock.patch.object(routing_engine, "_download_rule_set", return_value=io.BytesIO(b'{"version":2,"rules":[{"domain":12}]}')) as fetch:
                self.assertEqual(routing_engine.prepare_rule_sets(directory, mirror_prefix="https://mirror.example"), current)
            self.assertEqual(fetch.call_args.args[0].full_url, "https://mirror.example/example.org/rules.json")
            self.assertEqual(marker.read_bytes(), previous)


if __name__ == "__main__":
    unittest.main()
