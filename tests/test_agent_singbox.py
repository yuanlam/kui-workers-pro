import ast
import ipaddress
import pathlib
import re
import unittest
import sys


SOURCE_PATH = pathlib.Path(__file__).parents[1] / "static" / "vps" / "agent.py"
SOURCE = SOURCE_PATH.read_text(encoding="utf-8")
sys.path.insert(0, str(SOURCE_PATH.parent))
from routing_engine import build_routing_policy

TREE = ast.parse(SOURCE)
FUNCTION_NAMES = {"normalize_ss2022_network", "node_transports", "node_listen_address", "tune_inbound", "tune_outbound", "get_port_traffic", "normalize_ping_target"}
SELECTED = [node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name in FUNCTION_NAMES]
COUNTERS = {"tcp": 120, "udp": 80}
NAMESPACE = {"_read_iptables_port_bytes": lambda _port, protocol: COUNTERS.get(protocol), "ipaddress": ipaddress, "re": re}
exec(compile(ast.Module(body=SELECTED, type_ignores=[]), str(SOURCE_PATH), "exec"), NAMESPACE)


class AgentSingBoxTests(unittest.TestCase):
    def test_node_listener_matches_the_managed_vps_address_family(self):
        listen_address = NAMESPACE["node_listen_address"]
        self.assertEqual(listen_address("203.0.113.8"), "0.0.0.0")
        self.assertEqual(listen_address("2001:db8::8"), "::")
        self.assertEqual(listen_address("invalid"), "0.0.0.0")

    def test_ping_targets_reject_shell_metacharacters(self):
        self.assertEqual(NAMESPACE["normalize_ping_target"]("probe.example.com"), "probe.example.com")
        self.assertEqual(NAMESPACE["normalize_ping_target"]("203.0.113.8"), "203.0.113.8")
        for value in ("example.com;id", "$(id)", "https://example.com", "example.com/path", ""):
            with self.assertRaises(ValueError):
                NAMESPACE["normalize_ping_target"](value)

    def test_ss2022_network_defaults_to_tcp_and_udp(self):
        self.assertEqual(NAMESPACE["normalize_ss2022_network"](""), ["tcp", "udp"])
        self.assertEqual(NAMESPACE["normalize_ss2022_network"]("tcp"), ["tcp"])
        self.assertEqual(NAMESPACE["normalize_ss2022_network"]("udp"), ["udp"])
        with self.assertRaises(ValueError):
            NAMESPACE["normalize_ss2022_network"]("icmp")

    def test_dual_network_traffic_sums_persistent_counters(self):
        self.assertEqual(NAMESPACE["get_port_traffic"](8388, "both", "node-1"), 200)
        self.assertEqual(NAMESPACE["get_port_traffic"](8388, "tcp", "node-1"), 120)

    def test_connection_tuning_is_transport_aware(self):
        tcp = NAMESPACE["tune_inbound"]({}, ["tcp"])
        udp = NAMESPACE["tune_inbound"]({}, ["udp"])
        dual = NAMESPACE["tune_inbound"]({}, ["tcp", "udp"])
        self.assertTrue(tcp["reuse_addr"])
        self.assertTrue(tcp["tcp_fast_open"])
        self.assertNotIn("udp_timeout", tcp)
        self.assertNotIn("reuse_addr", udp)
        self.assertEqual(udp["udp_timeout"], "5m")
        self.assertNotIn("tcp_fast_open", udp)
        self.assertNotIn("reuse_addr", dual)
        self.assertTrue(dual["tcp_fast_open"])
        self.assertEqual(dual["udp_timeout"], "5m")

    def test_tuic_uses_dns_hijacking_without_traffic_sniffing(self):
        result = build_routing_policy({"mode": "native"}, proxy_inbounds=["in-ss", "in-tuic"], sniff_inbounds=["in-ss"])
        routes = result["route"]["rules"]
        self.assertEqual([rule["inbound"] for rule in routes if rule.get("action") == "sniff"], [["in-ss"]])
        self.assertEqual([rule["inbound"] for rule in routes if rule.get("action") == "hijack-dns"], [["in-ss", "in-tuic"]])
        self.assertEqual(result["dns"]["final"], "local-dns")

    def test_legacy_custom_domains_still_follow_residential_route_and_dns(self):
        config = {"mode": "residential", "proxy_mode": "selective", "proxy_categories": "custom",
                  "proxy_custom_domains": ["*.Example.org"]}
        result = build_routing_policy(config, proxy_inbounds=["in-node"])
        routes = [rule for rule in result["route"]["rules"] if rule.get("outbound") == "socks5-outbound"]
        self.assertTrue(any("example.org" in rule.get("domain_suffix", []) for rule in routes))
        dns = [rule for rule in result["dns"]["rules"] if "example.org" in rule.get("domain_suffix", [])]
        self.assertTrue(any(rule.get("server") == "proxy-dns" and rule.get("strategy") == "ipv4_only" for rule in dns))


if __name__ == "__main__":
    unittest.main()
