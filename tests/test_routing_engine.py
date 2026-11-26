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


class RoutingEngineTests(unittest.TestCase):
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
