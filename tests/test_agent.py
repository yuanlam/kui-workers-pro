import ast
import errno
import contextlib
import json
import pathlib
import re
import subprocess
import time
import types
import unittest
import urllib.request
import socket
from unittest import mock


SOURCE_PATH = pathlib.Path(__file__).parents[1] / "static" / "vps" / "agent.py"
SOURCE = SOURCE_PATH.read_text(encoding="utf-8")
TREE = ast.parse(SOURCE)
FUNCTION_NAMES = {
    "_parse_iptables_chain_bytes",
    "_collect_iptables_port_bytes_snapshot",
    "_read_iptables_port_bytes",
    "get_port_traffic",
    "report_status",
    "_probe_stack_route",
}
SELECTED = [
    node for node in TREE.body
    if isinstance(node, ast.FunctionDef) and node.name in FUNCTION_NAMES
]
SELECTED_MODULE = ast.Module(body=SELECTED, type_ignores=[])


class FakeProcess:
    def __init__(self, stdout="", returncode=0, stderr=""):
        self.stdout = stdout
        self.returncode = returncode
        self.stderr = stderr


class FakeSubprocess:
    def __init__(self, responder):
        self.calls = []
        self._responder = responder

    def run(self, command, **kwargs):
        self.calls.append((command, kwargs))
        return self._responder(command, kwargs)


class RecordingChannel:
    connected = True
    enabled = True
    last_disconnected = 0

    def __init__(self):
        self.statuses = []

    def send(self, status):
        self.statuses.append(dict(status))
        return True


def load_namespace(run=None):
    namespace = {
        "re": re,
        "subprocess": types.SimpleNamespace(run=run) if run else subprocess,
    }
    exec(compile(SELECTED_MODULE, str(SOURCE_PATH), "exec"), namespace)
    return namespace


def iptables_rule(byte_count, protocol, direction, port, ipv6=False):
    packets = byte_count // 10 if byte_count else 0
    if ipv6:
        return (
            f"{packets} {byte_count} ACCEPT {protocol} eth0 * ::/0 ::/0 "
            f"{protocol} {direction}:{port}"
        )
    return (
        f"{packets} {byte_count} ACCEPT {protocol} -- eth0 * 0.0.0.0/0 0.0.0.0/0 "
        f"{protocol} {direction}:{port}"
    )


def single_port_rule(port, chain, byte_count, ipv6=False):
    direction = "dpt" if chain == "INPUT" else "spt"
    return iptables_rule(byte_count, "tcp", direction, port, ipv6=ipv6)


def build_fixture(pairs):
    outputs = {
        ("iptables", "INPUT"): [],
        ("iptables", "OUTPUT"): [],
        ("ip6tables", "INPUT"): [],
        ("ip6tables", "OUTPUT"): [],
    }
    totals = {}
    for (protocol, port), counters in pairs.items():
        totals[(protocol, port)] = sum(counters.values())
        outputs[("iptables", "INPUT")].append(
            iptables_rule(counters["input_v4"], protocol, "dpt", port)
        )
        outputs[("iptables", "OUTPUT")].append(
            iptables_rule(counters["output_v4"], protocol, "spt", port)
        )
        outputs[("ip6tables", "INPUT")].append(
            iptables_rule(counters["input_v6"], protocol, "dpt", port, ipv6=True)
        )
        outputs[("ip6tables", "OUTPUT")].append(
            iptables_rule(counters["output_v6"], protocol, "spt", port, ipv6=True)
        )
    return outputs, totals


def fixture_subprocess(pairs):
    outputs, totals = build_fixture(pairs)

    def respond(command, _kwargs):
        return FakeProcess("\n".join(outputs.get((command[0], command[2]), [])))

    return FakeSubprocess(respond), totals


def report_namespace(fake_subprocess, baseline):
    namespace = load_namespace(run=fake_subprocess.run)
    namespace.update({
        "get_system_status": lambda _interval: {"net_rx": 0, "net_tx": 0},
        "VPS_IP": "203.0.113.8",
        "_stack_reachability": lambda: {'has_ipv4': True, 'has_ipv6': False},
        "last_reported_bytes": dict(baseline),
        "last_reported_system_bytes": 0,
        "global_interval": 5,
        "pending_report_id": None,
        "pending_report_bytes": None,
        "pending_node_traffic": None,
        "pending_system_bytes": None,
        "pending_report_payload": None,
        "_write_json_state": lambda _path, _value: None,
        "TRAFFIC_STATE_PATH": "/opt/kui/traffic-state.json",
        "realtime_channel": None,
        "REALTIME_HTTP_INTERVAL": 300,
        "last_http_report": 0,
        "time": time,
        "fast_mode": False,
        "dynamic_ping": {"ct": None, "cu": None, "cm": None},
        "config_wakeup": types.SimpleNamespace(set=lambda: None),
    })
    return namespace


class AgentTrafficSnapshotTests(unittest.TestCase):
    def test_stack_probe_distinguishes_no_route_from_timeout_and_retries_other_resolvers(self):
        addresses = ('1.1.1.1', '8.8.8.8')
        namespace = load_namespace()
        for outcomes, expected in [([OSError(errno.ENETUNREACH, 'route')] * 2, False), ([socket.timeout()] * 2, None), ([socket.timeout(), None], True)]:
            with self.subTest(expected=expected), mock.patch('socket.socket') as factory:
                connection = factory.return_value.__enter__.return_value
                connection.connect.side_effect = outcomes
                namespace.update(socket=socket, errno=errno)
                self.assertIs(namespace['_probe_stack_route'](socket.AF_INET, addresses), expected)
                self.assertEqual(connection.connect.call_count, 2)

    def test_parser_aggregates_accept_rules_with_direction_and_port_boundaries(self):
        namespace = load_namespace()
        parse_bytes = namespace["_parse_iptables_chain_bytes"]
        output = "\n".join([
            "Chain INPUT (policy ACCEPT 0 packets, 0 bytes)",
            "pkts bytes target prot opt in out source destination",
            "0 0 ACCEPT tcp -- eth0 * 0.0.0.0/0 0.0.0.0/0 tcp dpt:81",
            "1 10 ACCEPT tcp -- eth0 * 0.0.0.0/0 0.0.0.0/0 tcp dpt:80",
            "2 20 ACCEPT tcp -- eth0 * 0.0.0.0/0 0.0.0.0/0 tcp dpt:80",
            "3 30 ACCEPT tcp -- eth0 * 0.0.0.0/0 0.0.0.0/0 tcp dpt:8080",
            "4 40 ACCEPT tcp -- eth0 * 0.0.0.0/0 0.0.0.0/0 tcp dpts:80:90",
            "5 50 ACCEPT tcp -- eth0 * 0.0.0.0/0 0.0.0.0/0 tcp spt:80",
            "6 60 DROP tcp -- eth0 * 0.0.0.0/0 0.0.0.0/0 tcp dpt:80",
            "7 70 REJECT tcp -- eth0 * 0.0.0.0/0 0.0.0.0/0 tcp dpt:80",
            "8 invalid ACCEPT tcp -- eth0 * 0.0.0.0/0 0.0.0.0/0 tcp dpt:80",
            "9 90 ACCEPT udp -- eth0 * 0.0.0.0/0 0.0.0.0/0 udp dpt:80",
        ])

        self.assertEqual(
            parse_bytes(output, "dpt"),
            {("tcp", "81"): 0, ("tcp", "80"): 30, ("tcp", "8080"): 30, ("udp", "80"): 90},
        )
        self.assertEqual(
            parse_bytes(
                "\n".join([
                    "1 100 ACCEPT tcp -- eth0 * 0.0.0.0/0 0.0.0.0/0 tcp spt:80",
                    "2 200 ACCEPT udp -- eth0 * 0.0.0.0/0 0.0.0.0/0 udp spt:80",
                    "3 300 ACCEPT tcp -- eth0 * 0.0.0.0/0 0.0.0.0/0 tcp dpt:80",
                    "4 400 ACCEPT tcp -- eth0 * 0.0.0.0/0 0.0.0.0/0 tcp spts:80:90",
                ]),
                "spt",
            ),
            {("tcp", "80"): 100, ("udp", "80"): 200},
        )

    def test_parser_supports_legacy_nft_numeric_and_ip6_layouts(self):
        namespace = load_namespace()
        parse_bytes = namespace["_parse_iptables_chain_bytes"]
        output = "\n".join([
            "1 100 ACCEPT 6 -- eth0 * 0.0.0.0/0 0.0.0.0/0 tcp dpt:443",
            "2 200 ACCEPT 17 -- eth0 * 0.0.0.0/0 0.0.0.0/0 udp dpt:443",
            "3 300 ACCEPT tcp eth0 * ::/0 ::/0 tcp dpt:443",
            "4 400 ACCEPT 6 eth0 * ::/0 ::/0 tcp dpt:443",
            "5 500 ACCEPT all -- eth0 * 0.0.0.0/0 0.0.0.0/0 tcp dpt:8443",
        ])

        self.assertEqual(
            parse_bytes(output, "dpt"),
            {("tcp", "443"): 800, ("udp", "443"): 200, ("tcp", "8443"): 500},
        )

    def test_parser_strips_comments_before_extracting_ports(self):
        line = (
            "1 100 ACCEPT tcp -- eth0 * 0.0.0.0/0 0.0.0.0/0 "
            "/* managed dpt:80 */ tcp dpt:8080"
        )

        def respond(command, _kwargs):
            if command == ["iptables", "-nvxL", "INPUT"]:
                return FakeProcess(line)
            return FakeProcess("")

        fake_subprocess = FakeSubprocess(respond)
        namespace = load_namespace(run=fake_subprocess.run)

        parsed = namespace["_parse_iptables_chain_bytes"](line, "dpt")

        self.assertEqual(parsed, {("tcp", "8080"): 100})
        self.assertNotIn(("tcp", "80"), parsed)
        self.assertEqual(namespace["_read_iptables_port_bytes"](8080, "tcp"), 100)

    def test_parser_ignores_negated_ranges_multiport_and_invalid_values(self):
        namespace = load_namespace()
        parse_bytes = namespace["_parse_iptables_chain_bytes"]
        output = "\n".join([
            "1 -100 ACCEPT tcp -- eth0 * 0.0.0.0/0 0.0.0.0/0 tcp dpt:80",
            "2 10 ACCEPT tcp -- eth0 * 0.0.0.0/0 0.0.0.0/0 tcp ! dpt:80",
            "3 20 ACCEPT tcp -- eth0 * 0.0.0.0/0 0.0.0.0/0 tcp dpt:80:90",
            "4 30 ACCEPT tcp -- eth0 * 0.0.0.0/0 0.0.0.0/0 tcp dpts:80:90",
            "5 40 ACCEPT tcp -- eth0 * 0.0.0.0/0 0.0.0.0/0 tcp multiport dports 80,443",
            "6 50 ACCEPT tcp -- eth0 * 0.0.0.0/0 0.0.0.0/0 tcp dpt:0",
            "7 60 ACCEPT tcp -- eth0 * 0.0.0.0/0 0.0.0.0/0 tcp dpt:65536",
            "8 70 ACCEPT tcp -- eth0 * 0.0.0.0/0 0.0.0.0/0 tcp dpt:8080",
        ])

        self.assertEqual(parse_bytes(output, "dpt"), {("tcp", "8080"): 70})

    def test_parser_ignores_ports_in_fixed_interface_columns(self):
        namespace = load_namespace()
        parse_bytes = namespace["_parse_iptables_chain_bytes"]
        output = "\n".join([
            "1 70 ACCEPT tcp -- dpt:80 * 0.0.0.0/0 0.0.0.0/0",
            "2 80 ACCEPT tcp -- * spt:80 0.0.0.0/0 0.0.0.0/0",
            "3 90 ACCEPT tcp dpt:80 * ::/0 ::/0",
            "4 100 ACCEPT tcp * spt:80 ::/0 ::/0",
        ])

        self.assertEqual(parse_bytes(output, "dpt"), {})
        self.assertEqual(parse_bytes(output, "spt"), {})

    def test_parser_does_not_infer_protocol_from_fixed_interface_column(self):
        namespace = load_namespace()
        parse_bytes = namespace["_parse_iptables_chain_bytes"]
        line = "1 70 ACCEPT all -- tcp * 0.0.0.0/0 0.0.0.0/0 dpt:80"

        self.assertEqual(parse_bytes(line, "dpt"), {})

    def test_collector_runs_four_fixed_commands_and_merges_ipv4_ipv6(self):
        pairs = {
            ("tcp", "31001"): {
                "input_v4": 100, "output_v4": 20, "input_v6": 10, "output_v6": 2,
            },
            ("udp", "31002"): {
                "input_v4": 200, "output_v4": 30, "input_v6": 20, "output_v6": 3,
            },
        }
        fake_subprocess, totals = fixture_subprocess(pairs)
        namespace = load_namespace(run=fake_subprocess.run)

        snapshot = namespace["_collect_iptables_port_bytes_snapshot"]()

        self.assertEqual(snapshot, totals)
        self.assertFalse(getattr(snapshot, "is_degraded", True))
        self.assertEqual(
            fake_subprocess.calls,
            [
                (["iptables", "-nvxL", "INPUT"], {"capture_output": True, "text": True, "timeout": 3}),
                (["iptables", "-nvxL", "OUTPUT"], {"capture_output": True, "text": True, "timeout": 3}),
                (["ip6tables", "-nvxL", "INPUT"], {"capture_output": True, "text": True, "timeout": 3}),
                (["ip6tables", "-nvxL", "OUTPUT"], {"capture_output": True, "text": True, "timeout": 3}),
            ],
        )

    def test_collector_keeps_ipv4_counts_when_ipv6_fails(self):
        ipv4_input = iptables_rule(100, "tcp", "dpt", "32001")
        ipv4_output = iptables_rule(23, "tcp", "spt", "32001")

        def respond(command, _kwargs):
            if command[0] == "ip6tables" and command[2] == "INPUT":
                raise TimeoutError("ip6tables timed out")
            if command[0] == "ip6tables" and command[2] == "OUTPUT":
                return FakeProcess("permission denied", returncode=4)
            return FakeProcess(ipv4_input if command[2] == "INPUT" else ipv4_output)

        fake_subprocess = FakeSubprocess(respond)
        namespace = load_namespace(run=fake_subprocess.run)

        snapshot = namespace["_collect_iptables_port_bytes_snapshot"]()

        self.assertEqual(snapshot, {("tcp", "32001"): 123})
        self.assertIs(getattr(snapshot, "is_degraded", None), True)
        self.assertEqual(
            getattr(snapshot, "failed_chains", None),
            frozenset({("ip6tables", "INPUT"), ("ip6tables", "OUTPUT")}),
        )
        self.assertEqual(len(fake_subprocess.calls), 4)

    def test_collector_marks_half_failed_ipv6_chain_as_degraded(self):
        port = 32002

        def respond(command, _kwargs):
            tool, chain = command[0], command[2]
            if tool == "ip6tables" and chain == "OUTPUT":
                raise TimeoutError("ip6tables OUTPUT timed out")
            if tool == "ip6tables":
                return FakeProcess(single_port_rule(port, chain, 10, ipv6=True))
            return FakeProcess(single_port_rule(port, chain, 100))

        fake_subprocess = FakeSubprocess(respond)
        namespace = load_namespace(run=fake_subprocess.run)

        snapshot = namespace["_collect_iptables_port_bytes_snapshot"]()

        self.assertEqual(snapshot, {("tcp", str(port)): 210})
        self.assertIs(getattr(snapshot, "is_degraded", None), True)
        self.assertEqual(
            getattr(snapshot, "failed_chains", None),
            frozenset({("ip6tables", "OUTPUT")}),
        )

    def test_collector_marks_iptables_chain_failure_as_degraded(self):
        port = 32003

        def respond(command, _kwargs):
            tool, chain = command[0], command[2]
            if tool == "iptables" and chain == "OUTPUT":
                return FakeProcess("", returncode=1, stderr="xtables lock")
            if tool == "iptables":
                return FakeProcess(single_port_rule(port, chain, 100))
            return FakeProcess(single_port_rule(port, chain, 10, ipv6=True))

        fake_subprocess = FakeSubprocess(respond)
        namespace = load_namespace(run=fake_subprocess.run)

        snapshot = namespace["_collect_iptables_port_bytes_snapshot"]()

        self.assertEqual(snapshot, {("tcp", str(port)): 120})
        self.assertIs(getattr(snapshot, "is_degraded", None), True)
        self.assertEqual(
            getattr(snapshot, "failed_chains", None),
            frozenset({("iptables", "OUTPUT")}),
        )

    def test_collector_treats_missing_ipv6_tables_as_healthy(self):
        port = 32004

        def respond(command, _kwargs):
            if command[0] == "ip6tables":
                raise FileNotFoundError("ip6tables")
            return FakeProcess(single_port_rule(port, command[2], 100))

        fake_subprocess = FakeSubprocess(respond)
        namespace = load_namespace(run=fake_subprocess.run)

        snapshot = namespace["_collect_iptables_port_bytes_snapshot"]()

        self.assertEqual(snapshot, {("tcp", str(port)): 200})
        self.assertIs(getattr(snapshot, "is_degraded", None), False)
        self.assertEqual(
            getattr(snapshot, "failed_chains", None),
            frozenset({("ip6tables", "INPUT"), ("ip6tables", "OUTPUT")}),
        )

    def test_collector_treats_explicit_missing_ipv6_table_as_unavailable(self):
        port = 32005

        def respond(command, _kwargs):
            if command[0] == "ip6tables":
                return FakeProcess(
                    "",
                    returncode=3,
                    stderr=(
                        "ip6tables v1.8.7: can't initialize ip6tables table "
                        "'filter': Table does not exist (do you need to insmod?)"
                    ),
                )
            return FakeProcess(single_port_rule(port, command[2], 100))

        fake_subprocess = FakeSubprocess(respond)
        namespace = load_namespace(run=fake_subprocess.run)

        snapshot = namespace["_collect_iptables_port_bytes_snapshot"]()

        self.assertEqual(snapshot, {("tcp", str(port)): 200})
        self.assertIs(getattr(snapshot, "is_degraded", None), False)
        self.assertEqual(
            getattr(snapshot, "failed_chains", None),
            frozenset({("ip6tables", "INPUT"), ("ip6tables", "OUTPUT")}),
        )

    def test_collector_marks_unrelated_missing_files_as_degraded(self):
        port = 32006
        missing_file = (
            "ip6tables: can't open /etc/foo: No such file or directory"
        )

        def respond(command, _kwargs):
            if command[0] == "ip6tables":
                return FakeProcess("", returncode=4, stderr=missing_file)
            return FakeProcess(single_port_rule(port, command[2], 100))

        fake_subprocess = FakeSubprocess(respond)
        namespace = load_namespace(run=fake_subprocess.run)

        snapshot = namespace["_collect_iptables_port_bytes_snapshot"]()

        self.assertEqual(snapshot, {("tcp", str(port)): 200})
        self.assertIs(getattr(snapshot, "is_degraded", None), True)

    def test_snapshot_traffic_matches_legacy_per_port_and_protocol(self):
        pairs = {
            ("tcp", "21001"): {
                "input_v4": 100, "output_v4": 11, "input_v6": 5, "output_v6": 1,
            },
            ("udp", "21002"): {
                "input_v4": 200, "output_v4": 22, "input_v6": 10, "output_v6": 2,
            },
            ("tcp", "21003"): {
                "input_v4": 300, "output_v4": 33, "input_v6": 15, "output_v6": 3,
            },
            ("udp", "21003"): {
                "input_v4": 400, "output_v4": 44, "input_v6": 20, "output_v6": 4,
            },
            ("tcp", "21004"): {
                "input_v4": 500, "output_v4": 55, "input_v6": 25, "output_v6": 5,
            },
            ("udp", "21005"): {
                "input_v4": 600, "output_v4": 66, "input_v6": 30, "output_v6": 6,
            },
        }
        fake_subprocess, totals = fixture_subprocess(pairs)
        namespace = load_namespace(run=fake_subprocess.run)
        get_traffic = namespace["get_port_traffic"]

        snapshot = namespace["_collect_iptables_port_bytes_snapshot"]()

        self.assertEqual(snapshot, totals)
        self.assertEqual(len(fake_subprocess.calls), 4)
        for port, protocol in (
            ("21001", "tcp"),
            ("21002", "udp"),
            ("21003", "tcp"),
            ("21003", "udp"),
            ("21003", "both"),
            ("21003", "tcp,udp"),
            ("21004", "tcp,udp"),
            ("21005", "udp"),
        ):
            with self.subTest(port=port, protocol=protocol):
                self.assertEqual(
                    get_traffic(port, protocol, snapshot=snapshot),
                    get_traffic(port, protocol),
                )

    def test_get_port_traffic_snapshot_preserves_zero_and_missing_rules(self):
        namespace = load_namespace()
        get_traffic = namespace["get_port_traffic"]

        self.assertEqual(
            get_traffic(8388, "tcp", "node-1", snapshot={("tcp", "8388"): 0}),
            0,
        )
        self.assertIsNone(get_traffic(8388, "tcp", "node-1", snapshot={}))
        self.assertEqual(
            get_traffic(8388, "both", "node-1", snapshot={("tcp", "8388"): 120}),
            120,
        )
        self.assertEqual(
            get_traffic(8388, "both", "node-1", snapshot={("udp", "8388"): 80}),
            80,
        )
        self.assertEqual(
            get_traffic(
                8388,
                "TCP,UDP",
                "node-1",
                snapshot={("tcp", "8388"): 120, ("udp", "8388"): 80},
            ),
            200,
        )

    def test_get_port_traffic_without_snapshot_keeps_legacy_fallback(self):
        namespace = load_namespace()
        counters = {"tcp": 120, "udp": 80}
        namespace["_read_iptables_port_bytes"] = (
            lambda _port, protocol: counters.get(protocol)
        )
        get_traffic = namespace["get_port_traffic"]

        self.assertEqual(get_traffic(8388, "both", "node-1"), 200)
        self.assertEqual(get_traffic(8388, "tcp", "node-1"), 120)
        self.assertEqual(get_traffic(8388, None, "node-1"), 120)

    def test_report_status_samples_once_for_mixed_nodes(self):
        pairs = {
            ("tcp", "21001"): {
                "input_v4": 100, "output_v4": 11, "input_v6": 5, "output_v6": 1,
            },
            ("udp", "21002"): {
                "input_v4": 200, "output_v4": 22, "input_v6": 10, "output_v6": 2,
            },
            ("tcp", "21003"): {
                "input_v4": 300, "output_v4": 33, "input_v6": 15, "output_v6": 3,
            },
            ("udp", "21003"): {
                "input_v4": 400, "output_v4": 44, "input_v6": 20, "output_v6": 4,
            },
            ("tcp", "21004"): {
                "input_v4": 500, "output_v4": 55, "input_v6": 25, "output_v6": 5,
            },
            ("udp", "21005"): {
                "input_v4": 600, "output_v4": 66, "input_v6": 30, "output_v6": 6,
            },
        }
        fake_subprocess, totals = fixture_subprocess(pairs)
        nodes = [
            {"id": "node-tcp", "port": 21001, "protocol": "VLESS"},
            {"id": "node-udp", "port": 21002, "protocol": "Hysteria2"},
            {
                "id": "node-dual",
                "port": 21003,
                "protocol": "Shadowsocks2022",
                "network": "tcp,udp",
            },
            {
                "id": "node-ss-tcp",
                "port": 21004,
                "protocol": "Shadowsocks2022",
                "network": "tcp",
            },
            {"id": "node-tuic", "port": 21005, "protocol": "TUIC"},
        ]
        expected_deltas = {
            "node-tcp": 17,
            "node-udp": 34,
            "node-dual": 51,
            "node-ss-tcp": 68,
            "node-tuic": 85,
        }
        baseline = {
            node["id"]: totals[
                ("tcp", str(node["port"]))
                if node["id"] in {"node-tcp", "node-ss-tcp"}
                else ("udp", str(node["port"]))
            ] - expected_deltas[node["id"]]
            for node in nodes
            if node["id"] not in {"node-dual"}
        }
        baseline["node-dual"] = (
            totals[("tcp", "21003")] + totals[("udp", "21003")]
        ) - expected_deltas["node-dual"]
        namespace = report_namespace(fake_subprocess, baseline)

        result = namespace["report_status"](nodes, [], allow_http=False)

        self.assertFalse(result)
        self.assertEqual(len(fake_subprocess.calls), 4)
        self.assertEqual(
            namespace["pending_node_traffic"],
            [
                {"id": node["id"], "delta_bytes": expected_deltas[node["id"]]}
                for node in nodes
            ],
        )

    def test_report_status_skips_sampling_for_empty_nodes(self):
        def respond(_command, _kwargs):
            raise AssertionError("iptables must not run without nodes")

        fake_subprocess = FakeSubprocess(respond)
        namespace = report_namespace(fake_subprocess, {})

        result = namespace["report_status"]([], [], allow_http=False)

        self.assertFalse(result)
        self.assertEqual(fake_subprocess.calls, [])
        self.assertEqual(namespace["pending_node_traffic"], [])

    def test_report_status_does_not_bill_degraded_ipv6_timeout(self):
        port = 33001
        round_state = {"call": 0}

        def respond(command, _kwargs):
            round_index = round_state["call"] // 4
            round_state["call"] += 1
            tool, chain = command[0], command[2]
            if tool == "ip6tables":
                if round_index == 0:
                    raise TimeoutError("ip6tables timed out")
                byte_count = 100 if chain == "INPUT" else 10
                return FakeProcess(single_port_rule(port, chain, byte_count, ipv6=True))
            byte_count = 100 if chain == "INPUT" else (10 if round_index == 0 else 20)
            return FakeProcess(single_port_rule(port, chain, byte_count))

        fake_subprocess = FakeSubprocess(respond)
        namespace = report_namespace(fake_subprocess, {"node": 200})
        nodes = [{"id": "node", "port": port, "protocol": "VLESS"}]

        self.assertFalse(namespace["report_status"](nodes, [], allow_http=False))
        self.assertEqual(namespace["pending_node_traffic"], [])
        self.assertEqual(namespace["last_reported_bytes"], {"node": 200})
        self.assertEqual(namespace["pending_report_bytes"], {"node": 200})

        self.assertFalse(namespace["report_status"](nodes, [], allow_http=False))
        self.assertEqual(
            namespace["pending_node_traffic"],
            [{"id": "node", "delta_bytes": 30}],
        )
        self.assertEqual(namespace["last_reported_bytes"], {"node": 200})

    def test_report_status_does_not_bill_degraded_ipv6_returncode_failure(self):
        port = 33002
        round_state = {"call": 0}

        def respond(command, _kwargs):
            round_index = round_state["call"] // 4
            round_state["call"] += 1
            tool, chain = command[0], command[2]
            if tool == "ip6tables":
                if round_index == 0:
                    return FakeProcess("", returncode=4, stderr="permission denied")
                byte_count = 100 if chain == "INPUT" else 10
                return FakeProcess(single_port_rule(port, chain, byte_count, ipv6=True))
            if round_index == 0:
                byte_count = 150 if chain == "INPUT" else 60
            else:
                byte_count = 160 if chain == "INPUT" else 60
            return FakeProcess(single_port_rule(port, chain, byte_count))

        fake_subprocess = FakeSubprocess(respond)
        namespace = report_namespace(fake_subprocess, {"node": 200})
        nodes = [{"id": "node", "port": port, "protocol": "VLESS"}]

        self.assertFalse(namespace["report_status"](nodes, [], allow_http=False))
        self.assertEqual(namespace["pending_node_traffic"], [])
        self.assertEqual(namespace["last_reported_bytes"], {"node": 200})

        self.assertFalse(namespace["report_status"](nodes, [], allow_http=False))
        self.assertEqual(
            namespace["pending_node_traffic"],
            [{"id": "node", "delta_bytes": 130}],
        )
        self.assertEqual(namespace["last_reported_bytes"], {"node": 200})

    def test_report_status_does_not_bill_ipv6_permission_denied(self):
        port = 33005
        permission_denied = (
            "ip6tables v1.8.7 (nf_tables): can't initialize ip6tables table "
            "'filter': Permission denied (you must be root)"
        )

        def respond_with_permission_error(command, _kwargs):
            if command[0] == "ip6tables":
                return FakeProcess("", returncode=3, stderr=permission_denied)
            byte_count = 100 if command[2] == "INPUT" else 10
            return FakeProcess(single_port_rule(port, command[2], byte_count))

        snapshot_namespace = load_namespace(
            run=FakeSubprocess(respond_with_permission_error).run
        )
        snapshot = snapshot_namespace["_collect_iptables_port_bytes_snapshot"]()

        self.assertEqual(snapshot, {("tcp", str(port)): 110})
        self.assertIs(getattr(snapshot, "is_degraded", None), True)

        round_state = {"call": 0}

        def respond_by_round(command, _kwargs):
            round_index = round_state["call"] // 4
            round_state["call"] += 1
            if command[0] == "ip6tables":
                if round_index == 0:
                    return FakeProcess("", returncode=3, stderr=permission_denied)
                return FakeProcess("")
            byte_count = (100 if round_index == 0 else 200) if command[2] == "INPUT" else (10 if round_index == 0 else 30)
            return FakeProcess(single_port_rule(port, command[2], byte_count))

        fake_subprocess = FakeSubprocess(respond_by_round)
        namespace = report_namespace(fake_subprocess, {"node": 200})
        nodes = [{"id": "node", "port": port, "protocol": "VLESS"}]

        self.assertFalse(namespace["report_status"](nodes, [], allow_http=False))
        self.assertEqual(namespace["pending_node_traffic"], [])
        self.assertEqual(namespace["last_reported_bytes"], {"node": 200})
        self.assertEqual(namespace["pending_report_bytes"], {"node": 200})

        self.assertFalse(namespace["report_status"](nodes, [], allow_http=False))
        self.assertEqual(
            namespace["pending_node_traffic"],
            [{"id": "node", "delta_bytes": 30}],
        )
        self.assertEqual(namespace["last_reported_bytes"], {"node": 200})

    def test_report_status_does_not_bill_ipv6_lock_file_failure(self):
        port = 33006
        lock_failure = (
            "Fatal: can't open lock file /run/xtables.lock: "
            "No such file or directory"
        )

        def respond_with_lock_error(command, _kwargs):
            if command[0] == "ip6tables":
                return FakeProcess("", returncode=4, stderr=lock_failure)
            byte_count = 100 if command[2] == "INPUT" else 10
            return FakeProcess(single_port_rule(port, command[2], byte_count))

        snapshot_namespace = load_namespace(
            run=FakeSubprocess(respond_with_lock_error).run
        )
        snapshot = snapshot_namespace["_collect_iptables_port_bytes_snapshot"]()

        self.assertEqual(snapshot, {("tcp", str(port)): 110})
        self.assertIs(getattr(snapshot, "is_degraded", None), True)

        round_state = {"call": 0}

        def respond_by_round(command, _kwargs):
            round_index = round_state["call"] // 4
            round_state["call"] += 1
            if command[0] == "ip6tables":
                if round_index == 0:
                    return FakeProcess("", returncode=4, stderr=lock_failure)
                return FakeProcess("")
            byte_count = (100 if round_index == 0 else 200) if command[2] == "INPUT" else (10 if round_index == 0 else 30)
            return FakeProcess(single_port_rule(port, command[2], byte_count))

        fake_subprocess = FakeSubprocess(respond_by_round)
        namespace = report_namespace(fake_subprocess, {"node": 200})
        nodes = [{"id": "node", "port": port, "protocol": "VLESS"}]

        self.assertFalse(namespace["report_status"](nodes, [], allow_http=False))
        self.assertEqual(namespace["pending_node_traffic"], [])
        self.assertEqual(namespace["last_reported_bytes"], {"node": 200})
        self.assertEqual(namespace["pending_report_bytes"], {"node": 200})

        self.assertFalse(namespace["report_status"](nodes, [], allow_http=False))
        self.assertEqual(
            namespace["pending_node_traffic"],
            [{"id": "node", "delta_bytes": 30}],
        )
        self.assertEqual(namespace["last_reported_bytes"], {"node": 200})

    def test_report_status_preserves_baseline_when_ipv6_half_fails(self):
        port = 33003

        def respond(command, _kwargs):
            tool, chain = command[0], command[2]
            if tool == "ip6tables" and chain == "OUTPUT":
                raise TimeoutError("ip6tables OUTPUT timed out")
            if tool == "ip6tables":
                return FakeProcess(single_port_rule(port, chain, 110, ipv6=True))
            return FakeProcess(single_port_rule(port, chain, 105))

        fake_subprocess = FakeSubprocess(respond)
        namespace = report_namespace(fake_subprocess, {"node": 200})
        nodes = [{"id": "node", "port": port, "protocol": "VLESS"}]

        self.assertFalse(namespace["report_status"](nodes, [], allow_http=False))
        self.assertEqual(namespace["pending_node_traffic"], [])
        self.assertEqual(namespace["last_reported_bytes"], {"node": 200})

    def test_report_status_reports_ipv4_delta_when_ipv6_tables_are_absent(self):
        port = 33004

        def respond(command, _kwargs):
            if command[0] == "ip6tables":
                raise FileNotFoundError("ip6tables")
            byte_count = 100 if command[2] == "INPUT" else 30
            return FakeProcess(single_port_rule(port, command[2], byte_count))

        fake_subprocess = FakeSubprocess(respond)
        namespace = report_namespace(fake_subprocess, {"node": 100})
        channel = RecordingChannel()
        namespace.update({
            "realtime_channel": channel,
            "urllib": urllib,
            "json": json,
            "REPORT_URL": "https://example.invalid/report",
            "HEADERS": {},
            "_urlopen": lambda _request, timeout: contextlib.nullcontext(
                types.SimpleNamespace(read=lambda: b"{}")
            ),
        })
        nodes = [{"id": "node", "port": port, "protocol": "VLESS"}]

        result = namespace["report_status"](nodes, [], allow_http=True)

        self.assertTrue(result)
        self.assertEqual(
            channel.statuses[-1]["node_traffic"],
            [{"id": "node", "delta_bytes": 30}],
        )
        self.assertEqual(namespace["last_reported_bytes"], {"node": 130})


if __name__ == "__main__":
    unittest.main()
