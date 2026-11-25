import ast
import base64
import json
import os
import pathlib
import sys
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock


ROOT = pathlib.Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "static" / "vps"))

import lite_manager
import proxy_server


class StopLoop(Exception):
    pass


class FakeProcess:
    def __init__(self, alive=True):
        self.alive = alive
        self.terminated = False
        self.killed = False
        self.terminate_hook = None

    def poll(self):
        return None if self.alive else 1

    def terminate(self):
        if self.terminate_hook is not None:
            self.terminate_hook()
        self.terminated = True
        self.alive = False

    def kill(self):
        self.killed = True
        self.alive = False

    def wait(self, timeout=None):
        return 0


class RecordingEvent:
    def __init__(self, raise_on_wait=False):
        self.set_calls = 0
        self.clear_calls = 0
        self.raise_on_wait = raise_on_wait

    def set(self):
        self.set_calls += 1

    def clear(self):
        self.clear_calls += 1

    def is_set(self):
        return bool(self.set_calls)

    def wait(self, timeout=None):
        if self.raise_on_wait:
            raise StopLoop()
        return False


class Completed:
    def __init__(self, returncode=0, stdout=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = ""


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return self.payload


def make_tunnel(name="tun_main", table_id=20101, **kwargs):
    tunnel = lite_manager.Tunnel(name, table_id)
    for key, value in kwargs.items():
        setattr(tunnel, key, value)
    return tunnel


def make_node(ip, country="JP", **kwargs):
    node = {
        "ip": ip,
        "country": country,
        "ping": 20,
        "speed": 0,
        "score": 0,
        "sessions": 0,
        "uptime": 0,
        "penalty": 0,
        "remote_proto": "tcp",
        "remote_port": 443,
        "config": "client\nremote %s 443\n" % ip,
        "harvested_at": time.time(),
    }
    node.update(kwargs)
    return node


class LiteManagerTestBase(unittest.TestCase):
    def setUp(self):
        self.saved = {
            "target_country": lite_manager.target_country,
            "config_generation": lite_manager.config_generation,
            "last_switch_trigger": lite_manager.last_switch_trigger,
            "tun_main": lite_manager.tun_main,
            "tun_backup": lite_manager.tun_backup,
            "PROXY_PORT": lite_manager.PROXY_PORT,
            "realtime_channel": lite_manager.realtime_channel,
            "public_ip": lite_manager.public_ip,
            "last_empty_candidate_log": lite_manager.last_empty_candidate_log,
            "last_blacklist_clear": lite_manager.last_blacklist_clear,
            "last_config_log": lite_manager.last_config_log,
            "last_reservoir_log_count": lite_manager.last_reservoir_log_count,
            "CONFIG_DIR": lite_manager.CONFIG_DIR,
            "WORKSPACE": lite_manager.WORKSPACE,
            "tun_main_ready": lite_manager.tun_main.ready,
            "tun_backup_ready": lite_manager.tun_backup.ready,
        }
        self.saved_env = {
            key: os.environ.get(key)
            for key in ("PROXY_USER", "PROXY_PASS", "MIN_TUNNEL_SPEED_KBPS", "BACKUP_RACE_INTERVAL")
        }
        lite_manager.target_country = "JP"
        lite_manager.config_generation = 0
        lite_manager.last_switch_trigger = 0
        lite_manager.tun_main = make_tunnel("tun_main", 20101)
        lite_manager.tun_backup = make_tunnel("tun_backup", 20102)
        lite_manager.PROXY_PORT = 7920
        lite_manager.realtime_channel = None
        lite_manager.public_ip = "198.51.100.10"
        lite_manager.last_empty_candidate_log = 0
        lite_manager.last_blacklist_clear = time.time()
        lite_manager._clear_dead_ips()
        lite_manager._clear_testisp_cache()
        lite_manager._clear_quality_cache()
        lite_manager._clear_purity_caches()
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir.clear()
        proxy_server.ACTIVE_BIND = "tun_main"
        for key, value in self.saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        lite_manager.pool_wakeup.clear()
        lite_manager.heartbeat_wakeup.clear()
        lite_manager.config_wakeup.clear()

    def tearDown(self):
        saved_main = self.saved["tun_main"]
        saved_backup = self.saved["tun_backup"]
        for key, value in self.saved.items():
            if key not in {"tun_main_ready", "tun_backup_ready"}:
                setattr(lite_manager, key, value)
        saved_main.ready = self.saved["tun_main_ready"]
        saved_main.process = None
        saved_main.is_connecting = False
        saved_backup.ready = self.saved["tun_backup_ready"]
        saved_backup.process = None
        saved_backup.is_connecting = False
        lite_manager._clear_dead_ips()
        lite_manager._clear_testisp_cache()
        lite_manager._clear_quality_cache()
        lite_manager._clear_purity_caches()
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir.clear()
        proxy_server.ACTIVE_BIND = "tun_main"


class CandidateScoringTests(LiteManagerTestBase):
    def test_measured_throughput_outweighs_advertised_speed(self):
        fast = {"speed": 10_000_000, "entry_rtt_ms": 60, "ttfb_ms": 120, "speed_kbps": 5000}
        slow = {"speed": 1_000_000_000, "entry_rtt_ms": 60, "ttfb_ms": 500, "speed_kbps": 100}
        self.assertGreater(lite_manager.compute_candidate_score(fast), lite_manager.compute_candidate_score(slow))

    def test_unknown_sessions_do_not_receive_zero_session_bonus(self):
        unknown = {"sessions": None}
        idle = {"sessions": 0}
        self.assertLess(lite_manager.compute_candidate_score(unknown), lite_manager.compute_candidate_score(idle))

    def test_uptime_is_a_bounded_stability_signal(self):
        new = {"uptime": 0}
        established = {"uptime": 7 * 86400 * 1000}
        self.assertGreater(lite_manager.compute_candidate_score(established), lite_manager.compute_candidate_score(new))
        self.assertLessEqual(lite_manager.compute_candidate_score(established) - lite_manager.compute_candidate_score(new), 20)

    def test_multi_dimension_score_prefers_fast_low_latency_node(self):
        fast = {
            "speed": 100_000_000,
            "score": 1_000_000,
            "ping": 9999,
            "entry_rtt_ms": 30,
            "sessions": 2,
            "ttfb_ms": 120,
            "speed_kbps": 5000,
        }
        slow = {
            "speed": 2_000_000,
            "score": 1000,
            "ping": 300,
            "entry_rtt_ms": 300,
            "sessions": 500,
            "ttfb_ms": 800,
            "speed_kbps": 100,
        }
        self.assertGreater(lite_manager.compute_candidate_score(fast), lite_manager.compute_candidate_score(slow))

    def test_entry_rtt_overrides_csv_ping(self):
        measured = {"entry_rtt_ms": 20, "ping": 9999}
        csv_only = {"entry_rtt_ms": 200, "ping": 10}
        self.assertGreater(
            lite_manager.compute_candidate_score(measured),
            lite_manager.compute_candidate_score(csv_only),
        )

    def test_penalty_sinks_even_an_excellent_node(self):
        excellent = {
            "speed": 1_000_000_000,
            "score": 10_000_000,
            "entry_rtt_ms": 10,
            "sessions": 0,
            "ttfb_ms": 80,
            "speed_kbps": 100_000,
        }
        penalized = dict(excellent, penalty=5000)
        mediocre = {"speed": 10_000_000, "entry_rtt_ms": 200, "ttfb_ms": 500, "speed_kbps": 500}
        self.assertLess(lite_manager.compute_candidate_score(penalized), lite_manager.compute_candidate_score(mediocre))

    def test_speed_is_capped_to_prevent_distortion(self):
        ten_gbps = lite_manager.compute_candidate_score({"speed": 10_000_000_000})
        one_gbps = lite_manager.compute_candidate_score({"speed": 1_000_000_000})
        self.assertEqual(ten_gbps, one_gbps)

    def test_sessions_penalize_congestion(self):
        quiet = {"speed": 50_000_000, "entry_rtt_ms": 50, "sessions": 0}
        crowded = dict(quiet, sessions=5000)
        self.assertGreater(lite_manager.compute_candidate_score(quiet), lite_manager.compute_candidate_score(crowded))

    def test_latest_measured_quality_overrides_stale_high_speed_fields(self):
        ip = "198.51.100.44"
        stale_fast = make_node(ip, speed=0, ttfb_ms=80, speed_kbps=100_000)
        stale_slow = make_node("198.51.100.45", speed=0, ttfb_ms=600, speed_kbps=100)
        lite_manager._record_measured_quality(ip, ttfb_ms=600, speed_kbps=100)
        self.assertEqual(
            lite_manager.compute_candidate_score(stale_fast),
            lite_manager.compute_candidate_score(stale_slow),
        )


class VpnGateParsingTests(LiteManagerTestBase):
    def test_index_parser_reads_public_quality_fields(self):
        html = '''<tr><td><img src="../images/flags/JP.png"></td>
        <td>42 sessions<br>3 days<br>Total 2,000 users</td>
        <td>467.20 Mbps<br>Ping: 12 ms</td>
        <td><a href="do_openvpn.aspx?ip=219.100.37.200&amp;tcp=443&amp;udp=1195&amp;sid=123&amp;hid=456">OpenVPN</a></td>
        <td>1,234,567</td></tr>'''
        node = lite_manager._parse_vpngate_index(html)[0]
        self.assertEqual(node["sessions"], 42)
        self.assertEqual(node["speed"], 467200000)
        self.assertEqual(node["uptime"], 3 * 86400 * 1000)
        self.assertEqual(node["score"], 1234567)

    def test_index_parser_marks_missing_sessions_unknown(self):
        html = '''<tr><td><img src="../images/flags/JP.png"></td>
        <td><a href="do_openvpn.aspx?ip=219.100.37.200&amp;tcp=443&amp;sid=123&amp;hid=456">OpenVPN</a></td></tr>'''
        self.assertIsNone(lite_manager._parse_vpngate_index(html)[0]["sessions"])

    def test_index_parser_handles_minutes_and_invalid_speed(self):
        html = '''<tr><td><img src="../images/flags/JP.png"></td>
        <td>31 mins</td><td>1..25 Mbps</td>
        <td><a href="do_openvpn.aspx?ip=219.100.37.200&amp;tcp=443&amp;sid=123&amp;hid=456">OpenVPN</a></td></tr>'''
        node = lite_manager._parse_vpngate_index(html)[0]
        self.assertEqual(node["uptime"], 31 * 60000)
        self.assertEqual(node["speed"], 0)

    def test_csv_parser_extracts_multidimensional_fields_and_remote_meta(self):
        config = "client\nproto tcp\nremote 219.100.37.200 443\ncipher AES-128-CBC\n"
        encoded = base64.b64encode(config.encode()).decode()
        header = "#HostName,IP,Ping,Speed,Score,NumVpnSessions,Uptime,CountryShort,OpenVPN_ConfigData_Base64"
        row = ",".join(["node", "219.100.37.200", "12", "12345678", "987654", "42", "3600", "JP", encoded])

        nodes = lite_manager._parse_vpngate_csv(header + "\n" + row + "\n")

        self.assertEqual(len(nodes), 1)
        node = nodes[0]
        self.assertEqual(node["speed"], 12345678)
        self.assertEqual(node["score"], 987654)
        self.assertEqual(node["sessions"], 42)
        self.assertEqual(node["uptime"], 3600)
        self.assertEqual(node["penalty"], 0)
        self.assertEqual(node["remote_proto"], "tcp")
        self.assertEqual(node["remote_port"], 443)

    def test_index_parser_fills_remote_meta_defaults(self):
        html = """
        <table><tr>
          <td><img src="../images/flags/JP.png"></td>
          <td>Ping: <b>12 ms</b></td>
          <td><a href="do_openvpn.aspx?ip=219.100.37.200&amp;tcp=443&amp;udp=1195&amp;sid=123&amp;hid=456">OpenVPN</a></td>
        </tr></table>
        """
        candidate = lite_manager._parse_vpngate_index(html)[0]
        self.assertEqual(candidate["remote_proto"], "tcp")
        self.assertEqual(candidate["remote_port"], 443)
        self.assertIsNone(candidate["sessions"])
        for field in ("speed", "score", "uptime", "penalty"):
            self.assertEqual(candidate[field], 0)

    def test_download_candidate_fills_defaults_and_remote_meta(self):
        candidate = {
            "ip": "219.100.37.200",
            "ping": 12,
            "country": "JP",
            "download_url": "https://www.vpngate.net/common/openvpn_download.aspx?x=1",
        }
        config = "client\nproto udp\nremote 219.100.37.200 1195\ncipher AES-128-CBC\n"
        with mock.patch.object(lite_manager, "_read_vpngate_response", return_value=config):
            node = lite_manager._download_vpngate_candidate(candidate)
        self.assertEqual(node["remote_proto"], "udp")
        self.assertEqual(node["remote_port"], 1195)
        self.assertEqual(node["speed"], 0)
        self.assertEqual(node["penalty"], 0)

    def test_html_fallback_selects_by_quality_instead_of_ping_alone(self):
        candidates = [make_node("1.1.1.%d" % index, country="JP", ping=10, speed=1000000)
                      for index in range(1, 9)]
        better = make_node("2.2.2.2", country="JP", ping=30, speed=500000000)
        with mock.patch.object(lite_manager, "_read_vpngate_response", return_value="html"), \
             mock.patch.object(lite_manager, "_parse_vpngate_index", return_value=candidates + [better]), \
             mock.patch.object(lite_manager, "_download_vpngate_candidate", side_effect=lambda node: node):
            nodes = lite_manager._harvest_vpngate_html_fallback("unavailable")
        self.assertIn(better, nodes)
        self.assertEqual(len(nodes), 8)

    def test_fetch_loop_preserves_penalty_probe_and_quality_fields(self):
        old = make_node(
            "219.100.37.200",
            ping=8000,
            penalty=5000,
            entry_rtt_ms=25,
            entry_probed_at=100.0,
            entry_reachable=True,
            ttfb_ms=120,
            speed_kbps=5000,
            last_attempted_at=123.0,
        )
        fresh = make_node("219.100.37.200", ping=20)
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir["219.100.37.200"] = old
        with mock.patch.object(lite_manager, "harvest_snapshot_nodes", return_value=[fresh]):
            with mock.patch.object(lite_manager, "prescreen_candidates_ipok", return_value=0):
                with mock.patch.object(lite_manager.time, "sleep", side_effect=StopLoop):
                    with self.assertRaises(StopLoop):
                        lite_manager.vpngate_fetch_loop()
        merged = lite_manager.global_node_reservoir["219.100.37.200"]
        self.assertEqual(merged["ping"], 8000)
        self.assertEqual(merged["penalty"], 5000)
        self.assertEqual(merged["entry_rtt_ms"], 25)
        self.assertEqual(merged["entry_probed_at"], 100.0)
        self.assertTrue(merged["entry_reachable"])
        self.assertEqual(merged["ttfb_ms"], 120)
        self.assertEqual(merged["speed_kbps"], 5000)
        self.assertEqual(merged["last_attempted_at"], 123.0)


class EntryProbeTests(LiteManagerTestBase):
    def test_probe_entry_tcp_returns_rtt_or_none(self):
        class Connection:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        with mock.patch.object(lite_manager.socket, "create_connection", return_value=Connection()):
            self.assertIsNotNone(lite_manager.probe_entry_tcp("1.1.1.1", 443))
        with mock.patch.object(lite_manager.socket, "create_connection", side_effect=OSError("down")):
            self.assertIsNone(lite_manager.probe_entry_tcp("1.1.1.1", 443))
        self.assertIsNone(lite_manager.probe_entry_tcp("1.1.1.1", 0))

    def test_probe_candidates_marks_stale_tcp_but_skips_udp_and_fresh(self):
        now = time.time()
        stale = make_node("1.1.1.1", entry_probed_at=now - 200)
        fresh = make_node("2.2.2.2", entry_probed_at=now - 10)
        udp = make_node("3.3.3.3", remote_proto="udp", remote_port=1194)
        with lite_manager.reservoir_lock:
            for node in (stale, fresh, udp):
                lite_manager.global_node_reservoir[node["ip"]] = node
        with mock.patch.object(lite_manager, "probe_entry_tcp", return_value=None) as probe:
            lite_manager.probe_candidates_entry_rtt([stale, fresh, udp], max_probe=8)
        self.assertEqual(probe.call_count, 1)
        self.assertFalse(stale["entry_reachable"])
        self.assertIsNone(stale["entry_rtt_ms"])
        self.assertEqual(stale["penalty"], 1500)
        self.assertNotIn("entry_reachable", fresh)
        self.assertNotIn("entry_probed_at", udp)

    def test_probe_candidates_respects_max_probe(self):
        now = time.time()
        nodes = [make_node("1.1.1.%d" % index, entry_probed_at=now - 300) for index in range(1, 4)]
        with mock.patch.object(lite_manager, "probe_entry_tcp", return_value=20.0) as probe:
            lite_manager.probe_candidates_entry_rtt(nodes, max_probe=1)
        self.assertEqual(probe.call_count, 1)

    def test_get_best_candidate_eliminates_unreachable_top_candidate(self):
        now = time.time()
        best = make_node("1.1.1.1", speed=100_000_000, entry_rtt_ms=20, entry_probed_at=now - 300)
        second = make_node("2.2.2.2", speed=10_000_000, entry_rtt_ms=80, entry_probed_at=now - 300)
        third = make_node("3.3.3.3", speed=1_000_000, entry_rtt_ms=200, entry_probed_at=now - 300)
        with lite_manager.reservoir_lock:
            for node in (best, second, third):
                lite_manager.global_node_reservoir[node["ip"]] = node
        with mock.patch.object(
            lite_manager,
            "probe_entry_tcp",
            side_effect=lambda ip, port, timeout=1.5: None if ip == "1.1.1.1" else 20.0,
        ):
            chosen = lite_manager.get_best_candidate()
        self.assertEqual(chosen["ip"], "2.2.2.2")
        self.assertFalse(best["entry_reachable"])
        self.assertEqual(best["penalty"], 1500)

    def test_get_best_candidate_does_not_tcp_probe_udp_only_node(self):
        node = make_node("4.4.4.4", remote_proto="udp", remote_port=1194)
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[node["ip"]] = node
        with mock.patch.object(lite_manager, "probe_entry_tcp") as probe:
            chosen = lite_manager.get_best_candidate()
        self.assertIs(chosen, node)
        probe.assert_not_called()

    def test_get_best_candidate_returns_none_when_top_candidates_are_unreachable(self):
        now = time.time()
        nodes = [make_node("5.5.5.%d" % index, entry_probed_at=now - 300) for index in range(1, 3)]
        with lite_manager.reservoir_lock:
            for node in nodes:
                lite_manager.global_node_reservoir[node["ip"]] = node
        with mock.patch.object(lite_manager, "probe_entry_tcp", return_value=None):
            self.assertIsNone(lite_manager.get_best_candidate())

    def test_get_best_candidate_skips_node_blacklisted_during_probe(self):
        now = time.time()
        best = make_node("1.1.1.1", speed=100_000_000, entry_probed_at=now - 300)
        second = make_node("2.2.2.2", speed=10_000_000, entry_probed_at=now - 300)
        with lite_manager.reservoir_lock:
            for node in (best, second):
                lite_manager.global_node_reservoir[node["ip"]] = node

        def probe_and_blacklist(candidates, max_probe=8):
            lite_manager._mark_dead_ip(best["ip"])

        with mock.patch.object(
            lite_manager,
            "probe_candidates_entry_rtt",
            side_effect=probe_and_blacklist,
        ):
            chosen = lite_manager.get_best_candidate()
        self.assertIs(chosen, second)

    def test_get_best_candidate_skips_fresh_tcp_failures_and_uses_ninth_node(self):
        now = time.time()
        nodes = []
        for index in range(8):
            node = make_node(
                "6.6.6.%d" % (index + 1),
                speed=100_000_000 - index,
                entry_probed_at=now - 10,
                entry_reachable=False,
            )
            nodes.append(node)
        ninth = make_node(
            "7.7.7.7",
            speed=1_000_000,
            entry_probed_at=now - 300,
        )
        nodes.append(ninth)
        with lite_manager.reservoir_lock:
            for node in nodes:
                lite_manager.global_node_reservoir[node["ip"]] = node

        with mock.patch.object(lite_manager, "probe_entry_tcp", return_value=20.0) as probe:
            chosen = lite_manager.get_best_candidate()

        self.assertIs(chosen, ninth)
        probe.assert_called_once_with("7.7.7.7", 443, timeout=1.5)

    def test_slow_tunnel_ignores_fresh_tcp_failure_when_selecting_alternative(self):
        now = time.time()
        node = make_node("1.1.1.1", country="JP")
        unreachable = make_node(
            "2.2.2.2",
            country="US",
            entry_probed_at=now - 10,
            entry_reachable=False,
        )
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[node["ip"]] = node
            lite_manager.global_node_reservoir[unreachable["ip"]] = unreachable
        lite_manager.target_country = "ANY"

        def fake_run(command, **kwargs):
            if "bytes=262144" in " ".join(command):
                return Completed(0, "\n200 60000 6.0")
            return Completed(0, "200 0.1")

        with mock.patch.object(lite_manager.subprocess, "run", side_effect=fake_run):
            quality = lite_manager.probe_tunnel_quality(
                "tun_main", node_ip=node["ip"], country="JP"
            )
        self.assertEqual(quality, lite_manager.TunnelQuality(100, 80))
        self.assertFalse(lite_manager._is_dead_ip(node["ip"]))


class TunnelQualityTests(LiteManagerTestBase):
    def test_probe_quality_runs_stream_checks_in_parallel_and_measures_throughput(self):
        barrier = threading.Barrier(4)
        commands = []
        lock = threading.Lock()

        def fake_run(command, **kwargs):
            with lock:
                commands.append(list(command))
            if "https://speed.cloudflare.com/__down?bytes=262144" in command:
                return Completed(0, "\n200 262144 0.2097152")
            if any(
                url in command
                for url in (
                    "https://www.youtube.com",
                    "https://www.gstatic.com/generate_204",
                    "https://cp.cloudflare.com/generate_204",
                    "https://www.google.com/robots.txt",
                )
            ):
                barrier.wait(timeout=2)
                return Completed(0, "204 0.12")
            return Completed(1, "")

        with mock.patch.object(lite_manager.subprocess, "run", side_effect=fake_run):
            quality = lite_manager.probe_tunnel_quality("tun_main", node_ip="1.1.1.1", country="JP")

        self.assertEqual(quality, lite_manager.TunnelQuality(120, 10000))
        stream_commands = [command for command in commands if "%{http_code} %{time_starttransfer}" in command]
        self.assertEqual(len(stream_commands), 4)
        self.assertTrue(all("-m" in command and "5" in command for command in stream_commands))
        speed_commands = [command for command in commands if "bytes=262144" in " ".join(command)]
        self.assertEqual(len(speed_commands), 1)
        self.assertIn("-m", speed_commands[0])
        self.assertIn("6", speed_commands[0])

    def test_speed_endpoint_failure_degrades_to_zero_without_killing_tunnel(self):
        def fake_run(command, **kwargs):
            if "bytes=262144" in " ".join(command):
                return Completed(28, "")
            return Completed(0, "200 0.1")

        with mock.patch.object(lite_manager.subprocess, "run", side_effect=fake_run):
            quality = lite_manager.probe_tunnel_quality("tun_main", node_ip="1.1.1.1", country="JP")
        self.assertEqual(quality, lite_manager.TunnelQuality(100, 0))

    def test_slow_timeout_sample_is_measured_and_eliminated_with_alternative(self):
        node = make_node("1.1.1.1", country="JP")
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[node["ip"]] = node

        def fake_run(command, **kwargs):
            if "bytes=262144" in " ".join(command):
                return Completed(28, "\n200 60000 6.0")
            return Completed(0, "200 0.1")

        with mock.patch.object(lite_manager.subprocess, "run", side_effect=fake_run):
            quality = lite_manager.probe_tunnel_quality("tun_main", node_ip=node["ip"], country="JP")
        self.assertEqual(quality, lite_manager.TunnelQuality(100, 80))
        self.assertEqual(node["penalty"], 0)

        alternative = make_node("2.2.2.2", country="JP")
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[alternative["ip"]] = alternative
        with mock.patch.object(lite_manager.subprocess, "run", side_effect=fake_run):
            self.assertIsNone(
                lite_manager.probe_tunnel_quality("tun_main", node_ip=node["ip"], country="JP")
            )
        self.assertEqual(node["penalty"], 2000)
        self.assertTrue(lite_manager._is_dead_ip(node["ip"]))

    def test_http_error_or_tiny_sample_is_not_counted_as_throughput(self):
        node = make_node("1.1.1.1", country="JP")
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[node["ip"]] = node

        for sample in ("\n403 1200 0.05", "\n502 1200 0.05", "\n200 1024 0.001"):
            with self.subTest(sample=sample):
                lite_manager._clear_dead_ips()
                with lite_manager.reservoir_lock:
                    node["penalty"] = 0
                with mock.patch.object(
                    lite_manager.subprocess,
                    "run",
                    side_effect=lambda command, **kwargs: (
                        Completed(0, sample)
                        if "bytes=262144" in " ".join(command)
                        else Completed(0, "200 0.1")
                    ),
                ):
                    quality = lite_manager.probe_tunnel_quality(
                        "tun_main", node_ip=node["ip"], country="JP"
                    )
                self.assertEqual(quality, lite_manager.TunnelQuality(100, 0))

    def test_http_errors_with_alternative_are_rejected_as_unusable(self):
        node = make_node("1.1.1.1", country="JP")
        alternative = make_node("2.2.2.2", country="JP")
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[node["ip"]] = node
            lite_manager.global_node_reservoir[alternative["ip"]] = alternative

        for sample in ("\n403 1200 0.05", "\n502 1200 0.05"):
            with self.subTest(sample=sample):
                lite_manager._clear_dead_ips()
                with lite_manager.reservoir_lock:
                    node["penalty"] = 0
                with mock.patch.object(
                    lite_manager.subprocess,
                    "run",
                    side_effect=lambda command, **kwargs: (
                        Completed(0, sample)
                        if "bytes=262144" in " ".join(command)
                        else Completed(0, "200 0.1")
                    ),
                ):
                    self.assertIsNone(
                        lite_manager.probe_tunnel_quality(
                            "tun_main", node_ip=node["ip"], country="JP"
                        )
                    )
                self.assertEqual(node["penalty"], 2000)
                self.assertTrue(lite_manager._is_dead_ip(node["ip"]))

    def test_real_200_and_206_high_speed_samples_pass(self):
        node = make_node("1.1.1.1", country="JP")
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[node["ip"]] = node

        for code in (200, 206):
            with self.subTest(code=code):
                with mock.patch.object(
                    lite_manager.subprocess,
                    "run",
                    side_effect=lambda command, **kwargs: (
                        Completed(0, "\n%d 262144 0.2097152" % code)
                        if "bytes=262144" in " ".join(command)
                        else Completed(0, "200 0.1")
                    ),
                ):
                    quality = lite_manager.probe_tunnel_quality(
                        "tun_main", node_ip=node["ip"], country="JP"
                    )
                self.assertEqual(quality, lite_manager.TunnelQuality(100, 10000))

    def test_any_mode_uses_target_policy_for_cross_country_quality_replacement(self):
        lite_manager.target_country = "ANY"
        node = make_node("1.1.1.1", country="JP")
        alternative = make_node("2.2.2.2", country="US")
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[node["ip"]] = node
            lite_manager.global_node_reservoir[alternative["ip"]] = alternative

        def fake_run(command, **kwargs):
            if "bytes=262144" in " ".join(command):
                return Completed(0, "\n200 60000 6.0")
            return Completed(0, "200 0.1")

        with mock.patch.object(lite_manager.subprocess, "run", side_effect=fake_run):
            self.assertIsNone(
                lite_manager.probe_tunnel_quality("tun_main", node_ip=node["ip"], country="JP")
            )
        self.assertEqual(node["penalty"], 2000)

    def test_two_node_pool_keeps_only_dialable_slow_backup(self):
        lite_manager.target_country = "ANY"
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=FakeProcess(),
            entry_ip="1.1.1.1",
            egress_ip="9.9.9.1",
            country="JP",
        )
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=FakeProcess(),
            entry_ip="2.2.2.2",
            egress_ip="9.9.9.2",
            country="US",
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        main_node = make_node("1.1.1.1", country="JP", speed=100_000_000)
        backup_node = make_node("2.2.2.2", country="US", speed=1_000_000)
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[main_node["ip"]] = main_node
            lite_manager.global_node_reservoir[backup_node["ip"]] = backup_node

        def fake_run(command, **kwargs):
            if "bytes=262144" in " ".join(command):
                return Completed(0, "\n200 60000 6.0")
            return Completed(0, "200 0.1")

        with mock.patch.object(lite_manager.subprocess, "run", side_effect=fake_run):
            quality = lite_manager.probe_tunnel_quality(
                "tun_backup", node_ip=backup_node["ip"], country="US"
            )
        self.assertEqual(quality, lite_manager.TunnelQuality(100, 80))
        self.assertEqual(backup_node["penalty"], 0)
        self.assertFalse(lite_manager._has_untried_higher_candidate(backup))

    def test_slow_tunnel_is_penalized_and_abandoned_when_alternatives_exist(self):
        node = make_node("1.1.1.1", country="JP")
        alternative = make_node("2.2.2.2", country="JP")
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[node["ip"]] = node
            lite_manager.global_node_reservoir[alternative["ip"]] = alternative

        def fake_run(command, **kwargs):
            if "bytes=262144" in " ".join(command):
                return Completed(0, "1000")
            return Completed(0, "200 0.1")

        with mock.patch.object(lite_manager.subprocess, "run", side_effect=fake_run):
            self.assertIsNone(lite_manager.probe_tunnel_quality("tun_main", node_ip=node["ip"], country="JP"))
        self.assertEqual(node["penalty"], 2000)
        self.assertTrue(lite_manager._is_dead_ip(node["ip"]))

    def test_slow_tunnel_is_kept_when_no_same_country_alternative_exists(self):
        node = make_node("1.1.1.1", country="JP")
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[node["ip"]] = node

        def fake_run(command, **kwargs):
            if "bytes=262144" in " ".join(command):
                return Completed(0, "1000")
            return Completed(0, "200 0.1")

        with mock.patch.object(lite_manager.subprocess, "run", side_effect=fake_run):
            quality = lite_manager.probe_tunnel_quality("tun_main", node_ip=node["ip"], country="JP")
        self.assertEqual(quality, lite_manager.TunnelQuality(100, 8))
        self.assertEqual(node["penalty"], 0)

    def test_no_stream_endpoint_is_reachable_returns_none_and_penalizes(self):
        node = make_node("1.1.1.1", country="JP")
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[node["ip"]] = node
        with mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(28, "")):
            self.assertIsNone(lite_manager.probe_tunnel_quality("tun_main", node_ip=node["ip"], country="JP"))
        self.assertEqual(node["penalty"], 3000)


class TestispCacheTests(LiteManagerTestBase):
    def test_cache_hits_then_expires_after_ttl(self):
        calls = []

        def fake_urlopen(request, timeout):
            calls.append(request.full_url)
            return FakeResponse(b'{"isp": {"flag": "isp"}}')

        with mock.patch.object(lite_manager, "_urlopen", side_effect=fake_urlopen):
            first = lite_manager._testisp_lookup("1.2.3.4")
            second = lite_manager._testisp_lookup("1.2.3.4")
        self.assertEqual(first, second)
        self.assertEqual(len(calls), 1)

        with lite_manager.testisp_cache_lock:
            lite_manager.testisp_cache["1.2.3.4"] = (
                time.time() - lite_manager.TESTISP_CACHE_TTL - 1,
                {"old": True},
            )
        with mock.patch.object(lite_manager, "_urlopen", side_effect=fake_urlopen):
            refreshed = lite_manager._testisp_lookup("1.2.3.4")
        self.assertEqual(refreshed, {"isp": {"flag": "isp"}})
        self.assertEqual(len(calls), 2)

    def test_cache_is_bounded_and_lru(self):
        for index in range(520):
            lite_manager._cache_testisp_result("10.0.%d.%d" % (index // 250, index % 250), {"index": index})
        with lite_manager.testisp_cache_lock:
            self.assertEqual(len(lite_manager.testisp_cache), lite_manager.TESTISP_CACHE_MAX_ENTRIES)
            self.assertNotIn("10.0.0.0", lite_manager.testisp_cache)
            self.assertIn("10.0.2.19", lite_manager.testisp_cache)

    def test_cache_updates_are_thread_safe(self):
        errors = []

        def worker(offset):
            try:
                for index in range(50):
                    lite_manager._cache_testisp_result("192.0.2.%d" % ((offset + index) % 600), {"index": index})
            except Exception as error:
                errors.append(error)

        threads = [threading.Thread(target=worker, args=(index * 10,), daemon=True) for index in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(5)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        if errors:
            print("CONCURRENT ERRORS:", errors)
            print("CONCURRENT OBSERVED:", outcomes)
        self.assertEqual(errors, [])
        with lite_manager.testisp_cache_lock:
            self.assertLessEqual(len(lite_manager.testisp_cache), lite_manager.TESTISP_CACHE_MAX_ENTRIES)


class PromotionTests(LiteManagerTestBase):
    def build(self, main_speed=1000, backup_speed=1500, main_ttfb=200, backup_ttfb=250):
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=FakeProcess(),
            country="JP",
            connected_at=900,
            speed_kbps=main_speed,
            ttfb_ms=main_ttfb,
        )
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=FakeProcess(),
            country="JP",
            connected_at=950,
            speed_kbps=backup_speed,
            ttfb_ms=backup_ttfb,
        )
        return main, backup

    def test_speed_hysteresis_requires_35_percent_and_ttfb_guard(self):
        main, backup = self.build()
        self.assertTrue(lite_manager.should_promote_backup(main, backup, now=1000, cooldown=60))
        backup.speed_kbps = 1300
        self.assertFalse(lite_manager.should_promote_backup(main, backup, now=1000, cooldown=60))
        backup.speed_kbps = 1500
        backup.ttfb_ms = 400
        self.assertFalse(lite_manager.should_promote_backup(main, backup, now=1000, cooldown=60))

    def test_ttfb_hysteresis_requires_150ms_gap_and_30_percent_improvement(self):
        main, backup = self.build(main_speed=0, backup_speed=0, main_ttfb=300, backup_ttfb=100)
        self.assertTrue(lite_manager.should_promote_backup(main, backup, now=1000, cooldown=60))
        backup.ttfb_ms = 200
        self.assertFalse(lite_manager.should_promote_backup(main, backup, now=1000, cooldown=60))

    def test_requires_ready_alive_idle_matching_country_and_cooldown(self):
        main, backup = self.build()
        backup.ready = False
        self.assertFalse(lite_manager.should_promote_backup(main, backup, now=1000))
        backup.ready = True
        backup.process = FakeProcess(alive=False)
        self.assertFalse(lite_manager.should_promote_backup(main, backup, now=1000))
        backup.process = FakeProcess()
        backup.is_connecting = True
        self.assertFalse(lite_manager.should_promote_backup(main, backup, now=1000))
        backup.is_connecting = False
        backup.country = "US"
        self.assertFalse(lite_manager.should_promote_backup(main, backup, now=1000))
        backup.country = "JP"
        self.assertFalse(lite_manager.should_promote_backup(main, backup, now=950, cooldown=60))

    def test_any_country_bypasses_country_match(self):
        main, backup = self.build()
        backup.country = "US"
        lite_manager.target_country = "ANY"
        self.assertTrue(lite_manager.should_promote_backup(main, backup, now=1000, cooldown=60))

    def test_specific_target_country_requires_both_tunnels_to_match(self):
        main, backup = self.build()
        main.country = "US"
        backup.country = "US"
        self.assertFalse(lite_manager.should_promote_backup(main, backup, now=1000, cooldown=60))
        main.country = "JP"
        backup.country = "US"
        self.assertFalse(lite_manager.should_promote_backup(main, backup, now=1000, cooldown=60))
        backup.country = "JP"
        self.assertTrue(lite_manager.should_promote_backup(main, backup, now=1000, cooldown=60))

    def test_backup_race_interval_honors_environment_override(self):
        with mock.patch.dict(os.environ, {"BACKUP_RACE_INTERVAL": "7"}):
            self.assertEqual(lite_manager._backup_race_interval(), 7)

    def test_untried_higher_candidate_detection(self):
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            country="JP",
            entry_ip="1.1.1.1",
            node=make_node("1.1.1.1", speed=1_000_000, entry_rtt_ms=300),
        )
        better = make_node("2.2.2.2", speed=100_000_000, entry_rtt_ms=20)
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[better["ip"]] = better
        self.assertTrue(lite_manager._has_untried_higher_candidate(backup))
        lite_manager._mark_node_attempted(better["ip"])
        self.assertFalse(lite_manager._has_untried_higher_candidate(backup))

    def test_small_score_improvement_does_not_trigger_backup_race(self):
        backup = make_tunnel("tun_backup", 20102, ready=True, country="JP", entry_ip="1.1.1.1",
                             node=make_node("1.1.1.1", speed=100_000_000, entry_rtt_ms=50))
        better = make_node("2.2.2.2", speed=101_000_000, entry_rtt_ms=50)
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[better["ip"]] = better
        self.assertFalse(lite_manager._has_untried_higher_candidate(backup))

    def test_unmeasured_better_candidate_can_challenge_measured_backup(self):
        backup = make_tunnel("tun_backup", 20102, ready=True, country="JP", entry_ip="1.1.1.1",
                             node=make_node("1.1.1.1", speed=1_000_000, entry_rtt_ms=300,
                                            ttfb_ms=100, speed_kbps=5000))
        candidate = make_node("2.2.2.2", speed=500_000_000, entry_rtt_ms=50)
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[candidate["ip"]] = candidate
        self.assertTrue(lite_manager._has_untried_higher_candidate(backup))

    def test_race_probes_candidate_before_rejecting_its_upstream_ping(self):
        backup = make_tunnel("tun_backup", 20102, ready=True, country="JP", entry_ip="1.1.1.1",
                             node=make_node("1.1.1.1", entry_rtt_ms=100))
        candidate = make_node("2.2.2.2", ping=200)
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[candidate["ip"]] = candidate
        with mock.patch.object(lite_manager, "probe_entry_tcp", return_value=40):
            self.assertEqual(lite_manager._select_viable_higher_candidate(backup), candidate)

    def test_race_selects_highest_scoring_candidate_after_probe(self):
        backup = make_tunnel("tun_backup", 20102, ready=True, country="JP", entry_ip="1.1.1.1",
                             node=make_node("1.1.1.1", entry_rtt_ms=300))
        first = make_node("2.2.2.2", ping=20)
        second = make_node("3.3.3.3", ping=80)
        with lite_manager.reservoir_lock:
            for node in (first, second):
                lite_manager.global_node_reservoir[node["ip"]] = node
        with mock.patch.object(lite_manager, "probe_entry_tcp", side_effect=lambda ip, port, timeout=1.5: 100 if ip == first["ip"] else 40):
            self.assertEqual(lite_manager._select_viable_higher_candidate(backup), second)

    def test_any_mode_backup_race_sees_cross_country_candidate(self):
        lite_manager.target_country = "ANY"
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="3.3.3.3",
            egress_ip="9.9.9.3",
        )
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="1.1.1.1",
            node=make_node("1.1.1.1", country="JP", speed=1_000_000, entry_rtt_ms=300),
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        better = make_node("2.2.2.2", country="US", speed=100_000_000, entry_rtt_ms=20)
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[better["ip"]] = better
        self.assertTrue(lite_manager._has_untried_higher_candidate(backup))


class MaintainPoolTests(LiteManagerTestBase):
    def run_once(self):
        fake_pool = RecordingEvent(raise_on_wait=True)
        with mock.patch.object(lite_manager, "pool_wakeup", fake_pool):
            with self.assertRaises(StopLoop):
                lite_manager.maintain_pool()
        return fake_pool

    def test_backup_takes_over_even_when_main_is_connecting(self):
        main_process = FakeProcess()
        main = make_tunnel("tun_main", 20101, ready=False, is_connecting=True, process=main_process, entry_ip="1.1.1.1")
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="2.2.2.2",
            egress_ip="9.9.9.2",
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        with mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(proxy_server, "clear_dns_cache") as clear_dns:
            self.run_once()
        self.assertIs(lite_manager.tun_main, backup)
        self.assertIs(lite_manager.tun_backup, main)
        self.assertEqual(proxy_server.ACTIVE_BIND, "tun_backup")
        self.assertTrue(lite_manager.heartbeat_wakeup.is_set())
        self.assertFalse(main_process.terminated)
        self.assertTrue(main.is_connecting)
        self.assertIs(main.process, main_process)
        self.assertEqual(main.entry_ip, "1.1.1.1")
        cleanup.assert_not_called()
        self.assertTrue(clear_dns.called)

    def test_takeover_releases_connecting_main_without_process(self):
        main = make_tunnel(
            "tun_main",
            20101,
            ready=False,
            is_connecting=True,
            process=None,
            entry_ip="1.1.1.1",
        )
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="2.2.2.2",
            egress_ip="9.9.9.2",
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        started = []

        class FakeThread:
            def __init__(self, target=None, args=(), daemon=None, **kwargs):
                started.append((target, args))

            def start(self):
                pass

        candidate = make_node("3.3.3.3")
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[candidate["ip"]] = candidate
        with mock.patch.object(lite_manager.threading, "Thread", FakeThread), \
             mock.patch.object(lite_manager, "get_best_candidate", return_value=candidate), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(proxy_server, "clear_dns_cache"):
            self.run_once()

        self.assertIs(lite_manager.tun_main, backup)
        self.assertIs(lite_manager.tun_backup, main)
        self.assertTrue(main.is_connecting)
        self.assertIsNone(main.process)
        self.assertEqual(main.entry_ip, "3.3.3.3")
        self.assertNotIn(("tun_main", 20101), [(item[0], item[1]) for item in cleanup.call_args_list])
        self.assertEqual(len(started), 1)
        self.assertIs(started[0][1][0], main)
        self.assertIsNone(main.slot_owner)

    def test_takeover_with_connecting_main_process_keeps_ownership_check(self):
        main_process = FakeProcess()
        main = make_tunnel(
            "tun_main",
            20101,
            ready=False,
            is_connecting=True,
            process=main_process,
            entry_ip="1.1.1.1",
        )
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="2.2.2.2",
            egress_ip="9.9.9.2",
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        with mock.patch.object(lite_manager, "get_best_candidate", return_value=None), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(proxy_server, "clear_dns_cache"):
            self.run_once()

        self.assertIs(lite_manager.tun_main, backup)
        self.assertIs(lite_manager.tun_backup, main)
        self.assertFalse(main_process.terminated)
        self.assertTrue(main.is_connecting)
        self.assertIs(main.process, main_process)
        cleanup.assert_not_called()

    def test_takeover_cleans_dead_old_main_when_not_connecting(self):
        main = make_tunnel("tun_main", 20101, ready=False, is_connecting=False, process=FakeProcess())
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="2.2.2.2",
            egress_ip="9.9.9.2",
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        main_process = main.process
        with mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(proxy_server, "clear_dns_cache"):
            self.run_once()
        self.assertIs(lite_manager.tun_main, backup)
        self.assertIs(lite_manager.tun_backup, main)
        self.assertTrue(main_process.terminated)
        self.assertFalse(main.ready)
        self.assertEqual(main.entry_ip, "")
        cleanup.assert_any_call("tun_main", 20101, 30101, 31101)

    def test_dead_main_process_triggers_backup_takeover(self):
        main_process = FakeProcess(alive=False)
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            is_connecting=False,
            process=main_process,
            entry_ip="1.1.1.1",
        )
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="2.2.2.2",
            egress_ip="9.9.9.2",
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        with mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(lite_manager, "get_best_candidate", return_value=None), \
             mock.patch.object(proxy_server, "clear_dns_cache"):
            self.run_once()
        self.assertIs(lite_manager.tun_main, backup)
        self.assertIs(lite_manager.tun_backup, main)
        self.assertEqual(proxy_server.ACTIVE_BIND, "tun_backup")
        self.assertFalse(main.ready)
        self.assertIsNone(main.process)
        cleanup.assert_any_call("tun_main", 20101, 30101, 31101)

    def test_takeover_revalidates_main_health_after_interface_lock(self):
        main_process = FakeProcess(alive=False)
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=main_process,
            entry_ip="1.1.1.1",
        )
        backup_process = FakeProcess()
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=backup_process,
            country="JP",
            entry_ip="2.2.2.2",
            egress_ip="9.9.9.2",
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        original_lock = lite_manager._lock_tunnel_io

        def lock_then_recover(*tunnels):
            main.process = FakeProcess()
            main.ready = True
            return original_lock(*tunnels)

        with mock.patch.object(lite_manager, "_lock_tunnel_io", side_effect=lock_then_recover), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(lite_manager, "get_best_candidate", return_value=None), \
             mock.patch.object(proxy_server, "clear_dns_cache"):
            self.run_once()

        self.assertIs(lite_manager.tun_main, main)
        self.assertIs(lite_manager.tun_backup, backup)
        self.assertFalse(backup_process.terminated)
        self.assertTrue(backup.ready)
        cleanup.assert_not_called()

    def test_dead_backup_process_is_cleaned_and_redialed(self):
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="1.1.1.1",
            connected_at=time.time() - 100,
        )
        backup_process = FakeProcess(alive=False)
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=backup_process,
            country="JP",
            entry_ip="2.2.2.2",
        )
        candidate = make_node(
            "3.3.3.3",
            speed=100_000_000,
            entry_rtt_ms=20,
            entry_probed_at=time.time() - 5,
            entry_reachable=True,
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[candidate["ip"]] = candidate
        started = []

        class FakeThread:
            def __init__(self, target=None, args=(), daemon=None, **kwargs):
                started.append((target, args))

            def start(self):
                pass

        with mock.patch.object(lite_manager.threading, "Thread", FakeThread), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(proxy_server, "clear_dns_cache"):
            self.run_once()
        self.assertFalse(backup.ready)
        self.assertIsNone(backup.process)
        self.assertTrue(backup.is_connecting)
        self.assertEqual(backup.entry_ip, "3.3.3.3")
        self.assertEqual(len(started), 1)
        self.assertIs(started[0][1][0], backup)
        cleanup.assert_any_call("tun_backup", 20102, 30102, 31102)

    def test_dual_tunnels_dial_concurrently_with_distinct_reserved_ips(self):
        now = time.time()
        first = make_node("1.1.1.1", entry_probed_at=now - 5, entry_reachable=True, speed=100_000_000)
        second = make_node("2.2.2.2", entry_probed_at=now - 5, entry_reachable=True, speed=10_000_000)
        with lite_manager.reservoir_lock:
            for node in (first, second):
                lite_manager.global_node_reservoir[node["ip"]] = node
        started = []

        class FakeThread:
            def __init__(self, target=None, args=(), daemon=None, **kwargs):
                started.append((target, args))

            def start(self):
                pass

        with mock.patch.object(lite_manager.threading, "Thread", FakeThread), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing"):
            self.run_once()

        self.assertEqual(len(started), 2)
        self.assertIs(started[0][1][0], lite_manager.tun_main)
        self.assertIs(started[1][1][0], lite_manager.tun_backup)
        self.assertEqual(lite_manager.tun_main.entry_ip, "1.1.1.1")
        self.assertEqual(lite_manager.tun_backup.entry_ip, "2.2.2.2")
        self.assertTrue(lite_manager.tun_main.is_connecting)
        self.assertTrue(lite_manager.tun_backup.is_connecting)

    def test_race_replacement_is_not_reused_by_main_and_backup_after_main_drops(self):
        main_process = FakeProcess()
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=main_process,
            country="JP",
            entry_ip="1.1.1.1",
            connected_at=time.time() - 100,
            node=make_node("1.1.1.1", speed=100_000_000, entry_rtt_ms=20),
        )
        backup_process = FakeProcess()
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=backup_process,
            country="JP",
            entry_ip="2.2.2.2",
            connected_at=time.time() - lite_manager.BACKUP_RACE_INTERVAL - 10,
            node=make_node("2.2.2.2", speed=1_000_000, entry_rtt_ms=300),
        )
        candidate = make_node(
            "5.5.5.5",
            speed=100_000_000,
            entry_rtt_ms=10,
            entry_probed_at=time.time() - 5,
            entry_reachable=True,
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        lite_manager.config_generation = 72
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[candidate["ip"]] = candidate
        started = []
        main_dropped = threading.Event()

        class FakeThread:
            def __init__(self, target=None, args=(), daemon=None, **kwargs):
                started.append((target, args))

            def start(self):
                pass

        original_retire = lite_manager._retire_tunnel_unlocked

        def retire_then_drop_main(*args, **kwargs):
            retired = original_retire(*args, **kwargs)
            if retired and kwargs.get("expected_backup"):
                with lite_manager.state_lock:
                    main.ready = False
                    main.is_connecting = False
                    main.process = FakeProcess(alive=False)
                    main.entry_ip = ""
                    main.egress_ip = ""
                    main.country = ""
                    main.slot_owner = None
                main_dropped.set()
            return retired

        pool_event = RecordingEvent(raise_on_wait=True)
        with mock.patch.object(lite_manager, "pool_wakeup", pool_event), \
             mock.patch.object(lite_manager, "_select_viable_higher_candidate", return_value=candidate), \
             mock.patch.object(lite_manager, "_retire_tunnel_unlocked", side_effect=retire_then_drop_main), \
             mock.patch.object(lite_manager.threading, "Thread", FakeThread), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing"), \
             mock.patch.object(proxy_server, "clear_dns_cache"):
            with self.assertRaises(StopLoop):
                lite_manager.maintain_pool()

        self.assertTrue(main_dropped.is_set())
        self.assertTrue(backup_process.terminated)
        self.assertEqual(len(started), 1)
        self.assertIs(started[0][1][0], main)
        self.assertEqual(main.entry_ip, candidate["ip"])
        self.assertTrue(main.is_connecting)
        self.assertFalse(backup.is_connecting)
        self.assertEqual(backup.entry_ip, "")
        self.assertIsNone(backup.slot_owner)
        self.assertGreaterEqual(pool_event.set_calls, 1)

    def test_better_backup_is_promoted_and_active_bind_updates(self):
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="1.1.1.1",
            egress_ip="9.9.9.1",
            connected_at=time.time() - 100,
            speed_kbps=1000,
            ttfb_ms=200,
        )
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="2.2.2.2",
            egress_ip="9.9.9.2",
            connected_at=time.time() - 100,
            speed_kbps=2000,
            ttfb_ms=220,
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        with mock.patch.object(proxy_server, "clear_dns_cache") as clear_dns:
            self.run_once()
        self.assertIs(lite_manager.tun_main, backup)
        self.assertIs(lite_manager.tun_backup, main)
        self.assertEqual(proxy_server.ACTIVE_BIND, "tun_backup")
        clear_dns.assert_any_call("tun_backup")

    def test_periodic_race_recycles_only_backup(self):
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="1.1.1.1",
            connected_at=time.time() - 100,
            speed_kbps=100_000,
            ttfb_ms=50,
            node=make_node("1.1.1.1", speed=100_000_000, entry_rtt_ms=20),
        )
        backup_process = FakeProcess()
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=backup_process,
            country="JP",
            entry_ip="2.2.2.2",
            connected_at=time.time() - lite_manager.BACKUP_RACE_INTERVAL - 10,
            speed_kbps=1000,
            ttfb_ms=500,
            node=make_node("2.2.2.2", speed=1_000_000, entry_rtt_ms=300),
        )
        candidate = make_node(
            "3.3.3.3",
            speed=100_000_000,
            entry_rtt_ms=20,
            entry_probed_at=time.time() - 5,
            entry_reachable=True,
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[candidate["ip"]] = candidate
        dial_started = threading.Event()
        dial_args = []

        def fake_connect(*args):
            dial_args.append(args)
            dial_started.set()

        with mock.patch.object(lite_manager, "get_best_candidate", return_value=None), \
             mock.patch.object(lite_manager, "connect_node", side_effect=fake_connect), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(proxy_server, "clear_dns_cache"):
            self.run_once()
        self.assertIs(lite_manager.tun_main, main)
        self.assertIs(lite_manager.tun_backup, backup)
        self.assertTrue(backup_process.terminated)
        self.assertFalse(backup.ready)
        self.assertTrue(dial_started.wait(2))
        self.assertEqual(len(dial_args), 1)
        self.assertIs(dial_args[0][0], backup)
        self.assertIs(dial_args[0][1], candidate)
        self.assertEqual(backup.entry_ip, candidate["ip"])
        cleanup.assert_any_call("tun_backup", 20102, 30102, 31102)

    def test_periodic_race_recycles_backup_with_reachable_higher_candidate(self):
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=FakeProcess(),
            country="JP",
            connected_at=time.time() - 100,
            node=make_node("1.1.1.1", speed=100_000_000, entry_rtt_ms=20),
        )
        backup_process = FakeProcess()
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=backup_process,
            country="JP",
            connected_at=time.time() - lite_manager.BACKUP_RACE_INTERVAL - 10,
            node=make_node("2.2.2.2", speed=1_000_000, entry_rtt_ms=300),
        )
        candidate = make_node(
            "3.3.3.3",
            speed=100_000_000,
            entry_rtt_ms=20,
            entry_probed_at=time.time() - lite_manager.TCP_PROBE_CACHE_SECONDS - 10,
            entry_reachable=False,
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[candidate["ip"]] = candidate
        with mock.patch.object(lite_manager, "probe_entry_tcp", return_value=12.0) as probe, \
             mock.patch.object(lite_manager, "get_best_candidate", return_value=None), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(proxy_server, "clear_dns_cache"):
            self.run_once()
        self.assertTrue(probe.called)
        self.assertTrue(backup_process.terminated)
        self.assertFalse(backup.ready)
        self.assertIs(lite_manager.tun_main, main)
        cleanup.assert_any_call("tun_backup", 20102, 30102, 31102)

    def test_race_retirement_rechecks_backup_identity_after_previous_promotion(self):
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="1.1.1.1",
            connected_at=time.time() - 100,
            speed_kbps=100_000,
            ttfb_ms=50,
            node=make_node("1.1.1.1", speed=100_000_000, entry_rtt_ms=20),
        )
        promoted_process = FakeProcess()
        promoted = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=promoted_process,
            country="JP",
            entry_ip="2.2.2.2",
            connected_at=time.time() - lite_manager.BACKUP_RACE_INTERVAL - 10,
            speed_kbps=1000,
            ttfb_ms=500,
            node=make_node("2.2.2.2", speed=1_000_000, entry_rtt_ms=300),
        )
        stale_backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="3.3.3.3",
            connected_at=time.time() - lite_manager.BACKUP_RACE_INTERVAL - 10,
            node=make_node("3.3.3.3", speed=1_000_000, entry_rtt_ms=300),
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = promoted
        candidate = make_node(
            "4.4.4.4",
            speed=100_000_000,
            entry_rtt_ms=20,
            entry_probed_at=time.time() - 5,
            entry_reachable=True,
        )
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[candidate["ip"]] = candidate
        calls = []

        def promote_before_race(backup):
            calls.append(backup)
            with lite_manager.state_lock:
                lite_manager.tun_main = promoted
                lite_manager.tun_backup = stale_backup
            if len(calls) == 1:
                return candidate
            return None

        with mock.patch.object(lite_manager, "get_best_candidate", return_value=None), \
             mock.patch.object(lite_manager, "_select_viable_higher_candidate", side_effect=promote_before_race), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(proxy_server, "clear_dns_cache"):
            self.run_once()

        self.assertIs(lite_manager.tun_main, promoted)
        self.assertIs(lite_manager.tun_backup, stale_backup)
        self.assertFalse(promoted_process.terminated)
        self.assertTrue(promoted.ready)
        self.assertTrue(stale_backup.ready)
        cleanup.assert_not_called()

    def test_race_skips_backup_recycle_when_main_exits_during_candidate_check(self):
        main_process = FakeProcess()
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=main_process,
            country="JP",
            entry_ip="1.1.1.1",
            connected_at=time.time() - 100,
            speed_kbps=100_000,
            ttfb_ms=50,
            node=make_node("1.1.1.1", speed=100_000_000, entry_rtt_ms=20),
        )
        backup_process = FakeProcess()
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=backup_process,
            country="JP",
            entry_ip="2.2.2.2",
            connected_at=time.time() - lite_manager.BACKUP_RACE_INTERVAL - 10,
            speed_kbps=1000,
            ttfb_ms=500,
            node=make_node("2.2.2.2", speed=1_000_000, entry_rtt_ms=300),
        )
        candidate = make_node(
            "3.3.3.3",
            speed=100_000_000,
            entry_rtt_ms=20,
            entry_probed_at=time.time() - 5,
            entry_reachable=True,
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[candidate["ip"]] = candidate
        candidate_checked = threading.Event()
        release_check = threading.Event()

        def check_then_main_exits(backup_ref):
            candidate_checked.set()
            release_check.wait(2)
            main_process.alive = False
            return candidate

        def run():
            with mock.patch.object(lite_manager, "get_best_candidate", return_value=None), \
                 mock.patch.object(lite_manager, "_select_viable_higher_candidate", side_effect=check_then_main_exits), \
                 mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
                 mock.patch.object(proxy_server, "clear_dns_cache"):
                self.run_once()

        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        self.assertTrue(candidate_checked.wait(2))
        release_check.set()
        worker.join(2)

        self.assertFalse(worker.is_alive())
        self.assertFalse(backup_process.terminated)
        self.assertTrue(backup.ready)
        self.assertIs(lite_manager.tun_backup, backup)

    def test_periodic_race_requires_reachable_higher_candidate(self):
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="1.1.1.1",
            connected_at=time.time() - 100,
            speed_kbps=100_000,
            ttfb_ms=50,
            node=make_node("1.1.1.1", speed=100_000_000, entry_rtt_ms=20),
        )
        backup_process = FakeProcess()
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=backup_process,
            country="JP",
            entry_ip="2.2.2.2",
            connected_at=time.time() - lite_manager.BACKUP_RACE_INTERVAL - 10,
            speed_kbps=1000,
            ttfb_ms=500,
            node=make_node("2.2.2.2", speed=1_000_000, entry_rtt_ms=300),
        )
        unreachable = make_node(
            "3.3.3.3",
            speed=100_000_000,
            entry_rtt_ms=20,
            entry_probed_at=time.time() - lite_manager.TCP_PROBE_CACHE_SECONDS - 10,
            entry_reachable=False,
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[unreachable["ip"]] = unreachable
        with mock.patch.object(lite_manager, "probe_entry_tcp", return_value=None), \
             mock.patch.object(lite_manager, "get_best_candidate", return_value=None), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(proxy_server, "clear_dns_cache"):
            self.run_once()
        self.assertFalse(backup_process.terminated)
        self.assertTrue(backup.ready)
        self.assertIs(lite_manager.tun_backup, backup)
        cleanup.assert_not_called()

    def test_race_revalidates_main_after_candidate_check_before_backup_retirement(self):
        main_process = FakeProcess()
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=main_process,
            country="JP",
            entry_ip="1.1.1.1",
            connected_at=time.time() - 100,
            speed_kbps=100_000,
            ttfb_ms=50,
            node=make_node("1.1.1.1", speed=100_000_000, entry_rtt_ms=20),
        )
        backup_process = FakeProcess()
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=backup_process,
            country="JP",
            entry_ip="2.2.2.2",
            connected_at=time.time() - lite_manager.BACKUP_RACE_INTERVAL - 10,
            speed_kbps=1000,
            ttfb_ms=500,
            node=make_node("2.2.2.2", speed=1_000_000, entry_rtt_ms=300),
        )
        candidate = make_node(
            "3.3.3.3",
            speed=100_000_000,
            entry_rtt_ms=20,
            entry_probed_at=time.time() - 5,
            entry_reachable=True,
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[candidate["ip"]] = candidate
        main_health_checked = threading.Event()
        original_verified = lite_manager._is_verified_tcp_race_candidate

        def verify_then_kill_main(*args, **kwargs):
            verified = original_verified(*args, **kwargs)
            self.assertTrue(verified)
            main_process.alive = False
            main_health_checked.set()
            return verified

        def run():
            with mock.patch.object(lite_manager, "_is_verified_tcp_race_candidate", side_effect=verify_then_kill_main), \
                 mock.patch.object(lite_manager, "get_best_candidate", return_value=None), \
                 mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
                 mock.patch.object(proxy_server, "clear_dns_cache"):
                self.run_once()

        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        worker.join(2)

        self.assertFalse(worker.is_alive())
        self.assertTrue(main_health_checked.is_set())
        self.assertFalse(backup_process.terminated)
        self.assertTrue(backup.ready)
        self.assertIs(lite_manager.tun_backup, backup)

    def test_race_does_not_recycle_backup_for_unverified_udp_candidate(self):
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="1.1.1.1",
            connected_at=time.time() - 100,
            node=make_node("1.1.1.1", speed=100_000_000, entry_rtt_ms=20),
        )
        backup_process = FakeProcess()
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=backup_process,
            country="JP",
            entry_ip="2.2.2.2",
            connected_at=time.time() - lite_manager.BACKUP_RACE_INTERVAL - 10,
            node=make_node("2.2.2.2", speed=1_000_000, entry_rtt_ms=300),
        )
        udp_candidate = make_node(
            "3.3.3.3",
            remote_proto="udp",
            remote_port=1194,
            speed=100_000_000,
            entry_rtt_ms=20,
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[udp_candidate["ip"]] = udp_candidate
        with mock.patch.object(lite_manager, "probe_entry_tcp") as probe, \
             mock.patch.object(lite_manager, "get_best_candidate", return_value=None), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(proxy_server, "clear_dns_cache"):
            self.run_once()
        probe.assert_not_called()
        self.assertNotIn("entry_reachable", udp_candidate)
        self.assertFalse(backup_process.terminated)
        self.assertTrue(backup.ready)
        self.assertIs(lite_manager.tun_backup, backup)
        cleanup.assert_not_called()

    def test_race_rejects_stale_udp_success_cache_without_fresh_probe(self):
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="1.1.1.1",
            connected_at=time.time() - 100,
            node=make_node("1.1.1.1", speed=100_000_000, entry_rtt_ms=20),
        )
        backup_process = FakeProcess()
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=backup_process,
            country="JP",
            entry_ip="2.2.2.2",
            connected_at=time.time() - lite_manager.BACKUP_RACE_INTERVAL - 10,
            node=make_node("2.2.2.2", speed=1_000_000, entry_rtt_ms=300),
        )
        udp_candidate = make_node(
            "3.3.3.3",
            remote_proto="udp",
            remote_port=1194,
            speed=100_000_000,
            entry_rtt_ms=20,
            entry_probed_at=time.time() - lite_manager.TCP_PROBE_CACHE_SECONDS - 10,
            entry_reachable=True,
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[udp_candidate["ip"]] = udp_candidate
        with mock.patch.object(lite_manager, "probe_entry_tcp") as probe, \
             mock.patch.object(lite_manager, "get_best_candidate", return_value=None), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(proxy_server, "clear_dns_cache"):
            self.run_once()
        probe.assert_not_called()
        self.assertFalse(backup_process.terminated)
        self.assertTrue(backup.ready)
        self.assertIs(lite_manager.tun_backup, backup)
        cleanup.assert_not_called()

    def test_idle_slot_can_still_dial_unverified_udp_candidate(self):
        udp_candidate = make_node(
            "3.3.3.3",
            remote_proto="udp",
            remote_port=1194,
            speed=100_000_000,
            entry_rtt_ms=20,
        )
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[udp_candidate["ip"]] = udp_candidate
        with mock.patch.object(lite_manager, "probe_entry_tcp") as probe:
            chosen = lite_manager.get_best_candidate()
        probe.assert_not_called()
        self.assertIs(chosen, udp_candidate)

    def test_periodic_race_dials_verified_tcp_instead_of_higher_scored_udp(self):
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="1.1.1.1",
            connected_at=time.time() - 100,
            node=make_node("1.1.1.1", speed=100_000_000, entry_rtt_ms=20),
        )
        backup_process = FakeProcess()
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=backup_process,
            country="JP",
            entry_ip="2.2.2.2",
            connected_at=time.time() - lite_manager.BACKUP_RACE_INTERVAL - 10,
            node=make_node("2.2.2.2", speed=1_000_000, entry_rtt_ms=300),
        )
        udp_candidate = make_node(
            "3.3.3.3",
            remote_proto="udp",
            remote_port=1194,
            speed=100_000_000,
            entry_rtt_ms=10,
        )
        tcp_candidate = make_node(
            "4.4.4.4",
            remote_proto="tcp",
            remote_port=443,
            speed=50_000_000,
            entry_rtt_ms=40,
            entry_probed_at=time.time() - lite_manager.TCP_PROBE_CACHE_SECONDS - 10,
            entry_reachable=False,
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[udp_candidate["ip"]] = udp_candidate
            lite_manager.global_node_reservoir[tcp_candidate["ip"]] = tcp_candidate
        dial_started = threading.Event()
        dial_args = []

        def fake_connect(*args):
            dial_args.append(args)
            dial_started.set()

        with mock.patch.object(lite_manager, "probe_entry_tcp", return_value=18.0), \
             mock.patch.object(lite_manager, "connect_node", side_effect=fake_connect), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing"), \
             mock.patch.object(proxy_server, "clear_dns_cache"):
            self.run_once()

        self.assertTrue(backup_process.terminated)
        self.assertFalse(backup.ready)
        self.assertTrue(dial_started.wait(2))
        self.assertEqual(len(dial_args), 1)
        self.assertIs(dial_args[0][0], backup)
        self.assertIs(dial_args[0][1], tcp_candidate)
        self.assertEqual(backup.entry_ip, tcp_candidate["ip"])

    def test_periodic_race_keeps_backup_when_verified_tcp_fails_to_connect(self):
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="1.1.1.1",
            connected_at=time.time() - 100,
            node=make_node("1.1.1.1", speed=100_000_000, entry_rtt_ms=20),
        )
        backup_process = FakeProcess()
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=backup_process,
            country="JP",
            entry_ip="2.2.2.2",
            connected_at=time.time() - lite_manager.BACKUP_RACE_INTERVAL - 10,
            node=make_node("2.2.2.2", speed=1_000_000, entry_rtt_ms=300),
        )
        tcp_candidate = make_node(
            "4.4.4.4",
            remote_proto="tcp",
            remote_port=443,
            speed=50_000_000,
            entry_rtt_ms=40,
            entry_probed_at=time.time() - lite_manager.TCP_PROBE_CACHE_SECONDS - 10,
            entry_reachable=False,
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[tcp_candidate["ip"]] = tcp_candidate

        original_select_candidate = lite_manager._select_viable_higher_candidate
        verified = threading.Event()
        release = threading.Event()

        def verified_then_candidate_fails(backup_ref):
            selected = original_select_candidate(backup_ref)
            self.assertIs(selected, tcp_candidate)
            verified.set()
            release.wait(2)
            tcp_candidate["entry_reachable"] = False
            tcp_candidate["entry_probed_at"] = time.time()
            return selected

        def run():
            with mock.patch.object(lite_manager, "probe_entry_tcp", return_value=18.0), \
                 mock.patch.object(lite_manager, "_select_viable_higher_candidate", side_effect=verified_then_candidate_fails), \
                 mock.patch.object(lite_manager, "get_best_candidate", return_value=None), \
                 mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
                 mock.patch.object(proxy_server, "clear_dns_cache"):
                self.run_once()

        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        self.assertTrue(verified.wait(2))
        release.set()
        worker.join(2)

        self.assertFalse(worker.is_alive())
        self.assertFalse(backup_process.terminated)
        self.assertTrue(backup.ready)
        self.assertIs(lite_manager.tun_backup, backup)

    def test_periodic_race_keeps_backup_when_verified_tcp_dial_is_cancelled(self):
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="1.1.1.1",
            connected_at=time.time() - 100,
            node=make_node("1.1.1.1", speed=100_000_000, entry_rtt_ms=20),
        )
        backup_process = FakeProcess()
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=backup_process,
            country="JP",
            entry_ip="2.2.2.2",
            connected_at=time.time() - lite_manager.BACKUP_RACE_INTERVAL - 10,
            node=make_node("2.2.2.2", speed=1_000_000, entry_rtt_ms=300),
        )
        tcp_candidate = make_node(
            "4.4.4.4",
            remote_proto="tcp",
            remote_port=443,
            speed=50_000_000,
            entry_rtt_ms=40,
            entry_probed_at=time.time() - lite_manager.TCP_PROBE_CACHE_SECONDS - 10,
            entry_reachable=False,
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[tcp_candidate["ip"]] = tcp_candidate

        original_select_candidate = lite_manager._select_viable_higher_candidate
        verified = threading.Event()
        release = threading.Event()

        def verified_then_cancel(backup_ref):
            selected = original_select_candidate(backup_ref)
            self.assertIs(selected, tcp_candidate)
            verified.set()
            release.wait(2)
            with lite_manager.state_lock:
                lite_manager.config_generation += 1
            return selected

        def run():
            with mock.patch.object(lite_manager, "probe_entry_tcp", return_value=18.0), \
                 mock.patch.object(lite_manager, "_select_viable_higher_candidate", side_effect=verified_then_cancel), \
                 mock.patch.object(lite_manager, "get_best_candidate", return_value=None), \
                 mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
                 mock.patch.object(proxy_server, "clear_dns_cache"):
                self.run_once()

        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        self.assertTrue(verified.wait(2))
        release.set()
        worker.join(2)

        self.assertFalse(worker.is_alive())
        self.assertFalse(backup_process.terminated)
        self.assertTrue(backup.ready)
        self.assertIs(lite_manager.tun_backup, backup)

    def test_race_retirement_does_not_redial_stale_country_after_full_redial(self):
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="1.1.1.1",
            connected_at=time.time() - 100,
            node=make_node("1.1.1.1", speed=100_000_000, entry_rtt_ms=20),
        )
        backup_process = FakeProcess()
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=backup_process,
            country="JP",
            entry_ip="2.2.2.2",
            connected_at=time.time() - lite_manager.BACKUP_RACE_INTERVAL - 10,
            node=make_node("2.2.2.2", speed=1_000_000, entry_rtt_ms=300),
        )
        stale_jp = make_node(
            "5.5.5.5",
            country="JP",
            speed=100_000_000,
            entry_rtt_ms=10,
            entry_probed_at=time.time() - 5,
            entry_reachable=True,
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        lite_manager.config_generation = 41
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[stale_jp["ip"]] = stale_jp
        retired = threading.Event()
        race_dispatched = threading.Event()
        race_paused = threading.Event()
        resume_race = threading.Event()
        dials = []
        lock = threading.Lock()

        def fake_connect(tun_ref, node, generation, token, expected_country=None, expected_role=None):
            with lock:
                dials.append((tun_ref, node, generation, token, expected_country, expected_role))
            race_dispatched.set()
            race_paused.set()
            resume_race.wait(2)

        original_retire = lite_manager._retire_tunnel_unlocked

        def retire_then_mark(*args, **kwargs):
            result = original_retire(*args, **kwargs)
            if result:
                retired.set()
            return result

        with mock.patch.object(lite_manager, "_select_viable_higher_candidate", return_value=stale_jp), \
             mock.patch.object(lite_manager, "_retire_tunnel_unlocked", side_effect=retire_then_mark), \
             mock.patch.object(lite_manager, "connect_node", side_effect=fake_connect), \
             mock.patch.object(lite_manager, "get_best_candidate", return_value=None), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing"), \
             mock.patch.object(proxy_server, "clear_dns_cache"):
            worker = threading.Thread(target=self.run_once, daemon=True)
            worker.start()
            self.assertTrue(retired.wait(2))
            self.assertTrue(race_dispatched.wait(2))
            lite_manager._perform_full_redial("US", 0, False, set())
            self.assertTrue(race_paused.wait(2))
            resume_race.set()
            worker.join(2)

        self.assertFalse(worker.is_alive())
        self.assertTrue(stale_jp.get("last_attempted_at"))
        self.assertTrue(backup_process.terminated)
        self.assertFalse(backup.ready)
        self.assertEqual(backup.entry_ip, "")
        self.assertEqual(len(dials), 1)
        self.assertEqual(dials[0][4], "JP")
        self.assertEqual(lite_manager.target_country, "US")
        self.assertEqual(lite_manager.config_generation, 42)

    def test_race_probe_budget_skips_high_score_udp_candidates(self):
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="1.1.1.1",
            connected_at=time.time() - 100,
            node=make_node("1.1.1.1", speed=100_000_000, entry_rtt_ms=20),
        )
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="2.2.2.2",
            connected_at=time.time() - lite_manager.BACKUP_RACE_INTERVAL - 10,
            node=make_node("2.2.2.2", speed=100_000, entry_rtt_ms=900),
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        udp_nodes = [
            make_node(
                "3.3.3.%d" % index,
                remote_proto="udp",
                remote_port=1194,
                speed=100_000_000,
                entry_rtt_ms=1,
            )
            for index in range(1, 9)
        ]
        tcp_nodes = [
            make_node(
                "4.4.4.%d" % index,
                remote_proto="tcp",
                remote_port=443,
                speed=50_000_000,
                entry_rtt_ms=40,
                entry_probed_at=time.time() - lite_manager.TCP_PROBE_CACHE_SECONDS - 10,
                entry_reachable=False,
            )
            for index in range(1, 4)
        ]
        with lite_manager.reservoir_lock:
            for node in udp_nodes + tcp_nodes:
                lite_manager.global_node_reservoir[node["ip"]] = node
        probed = []

        def fake_probe_entry_tcp(ip, port, timeout=1.5):
            probed.append(ip)
            return 20.0

        with mock.patch.object(lite_manager, "probe_entry_tcp", side_effect=fake_probe_entry_tcp), \
             mock.patch.object(lite_manager, "get_best_candidate", return_value=None):
            selected = lite_manager._select_viable_higher_candidate(backup)

        self.assertIn(selected["ip"], {node["ip"] for node in tcp_nodes})
        self.assertEqual(probed, [node["ip"] for node in tcp_nodes])

    def test_stale_race_candidate_does_not_start_openvpn_after_target_switch(self):
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="1.1.1.1",
            connected_at=time.time() - 100,
            node=make_node("1.1.1.1", speed=100_000_000, entry_rtt_ms=20),
        )
        backup_process = FakeProcess()
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=backup_process,
            country="JP",
            entry_ip="2.2.2.2",
            connected_at=time.time() - lite_manager.BACKUP_RACE_INTERVAL - 10,
            node=make_node("2.2.2.2", speed=1_000_000, entry_rtt_ms=300),
        )
        stale_jp = make_node(
            "5.5.5.5",
            country="JP",
            speed=100_000_000,
            entry_rtt_ms=10,
            entry_probed_at=time.time() - 5,
            entry_reachable=True,
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        lite_manager.target_country = "JP"
        lite_manager.config_generation = 70
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[stale_jp["ip"]] = stale_jp

        race_retired = threading.Event()
        race_paused = threading.Event()
        resume_race = threading.Event()
        redial_done = threading.Event()
        spawned_threads = []
        original_retire = lite_manager._retire_tunnel_unlocked
        original_full_redial = lite_manager._perform_full_redial
        real_thread = threading.Thread

        def retire_then_mark(*args, **kwargs):
            result = original_retire(*args, **kwargs)
            if result and kwargs.get("expected_backup"):
                race_retired.set()
            return result

        class ControlledThread:
            def __init__(self, target=None, args=(), daemon=None, **kwargs):
                self.target = target
                self.args = args
                self.thread = real_thread(target=self.run, daemon=True)
                spawned_threads.append(self.thread)

            def start(self):
                self.thread.start()

            def run(self):
                if not race_retired.is_set():
                    self.target(*self.args)
                    return
                race_paused.set()
                resume_race.wait(2)
                self.args[0].is_connecting = True
                self.target(*self.args)

        process = FakeProcess()

        def fake_popen(command, **kwargs):
            stdout = kwargs.get("stdout")
            if hasattr(stdout, "write"):
                stdout.write("Initialization Sequence Completed\n")
                stdout.flush()
            return process

        def fake_run(command, *args, **kwargs):
            if command[:2] == ["openvpn", "--version"]:
                return Completed(0, "OpenVPN 2.5")
            return Completed(0, "203.0.113.9")

        with mock.patch.object(lite_manager, "_select_viable_higher_candidate", return_value=stale_jp), \
             mock.patch.object(lite_manager, "_retire_tunnel_unlocked", side_effect=retire_then_mark), \
             mock.patch.object(lite_manager.threading, "Thread", ControlledThread), \
             mock.patch.object(lite_manager.subprocess, "Popen", side_effect=fake_popen) as popen, \
             mock.patch.object(lite_manager.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(lite_manager, "get_best_candidate", return_value=None), \
             mock.patch.object(lite_manager, "setup_routing"), \
             mock.patch.object(lite_manager, "_testisp_lookup", return_value={"isp": {"flag": "isp"}}), \
             mock.patch.object(lite_manager, "probe_tunnel_quality", return_value=lite_manager.TunnelQuality(100, 5000)), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing"), \
             mock.patch.object(proxy_server, "clear_dns_cache"), \
             mock.patch.object(lite_manager.time, "sleep"):
            worker = threading.Thread(target=self.run_once, daemon=True)
            worker.start()
            self.assertTrue(race_paused.wait(2))
            original_full_redial("US", 0, False, set())
            redial_done.set()
            resume_race.set()
            spawned_threads[-1].join(2)
            for thread in spawned_threads:
                thread.join(2)

        self.assertTrue(redial_done.is_set())
        self.assertFalse(any(thread.is_alive() for thread in spawned_threads))
        popen.assert_not_called()
        self.assertEqual(lite_manager.target_country, "US")
        self.assertEqual(lite_manager.config_generation, 71)
        self.assertFalse(backup.ready)
        self.assertEqual(backup.entry_ip, "")
        self.assertIsNone(backup.slot_owner)

    def test_stale_race_candidate_is_rejected_after_jp_us_jp_redials(self):
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="1.1.1.1",
            connected_at=time.time() - 100,
            node=make_node("1.1.1.1", speed=100_000_000, entry_rtt_ms=20),
        )
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="2.2.2.2",
            connected_at=time.time() - lite_manager.BACKUP_RACE_INTERVAL - 10,
            node=make_node("2.2.2.2", speed=1_000_000, entry_rtt_ms=300),
        )
        stale_jp = make_node(
            "5.5.5.5",
            country="JP",
            speed=100_000_000,
            entry_rtt_ms=10,
            entry_probed_at=time.time() - 5,
            entry_reachable=True,
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        lite_manager.target_country = "JP"
        lite_manager.config_generation = 70
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[stale_jp["ip"]] = stale_jp

        started = []
        original_retire = lite_manager._retire_tunnel_unlocked
        original_full_redial = lite_manager._perform_full_redial

        def retire_then_round_trip(*args, **kwargs):
            result = original_retire(*args, **kwargs)
            if result:
                original_full_redial("US", 0, False, set())
                original_full_redial("JP", 0, False, set())
            return result

        class FakeThread:
            def __init__(self, target=None, args=(), daemon=None, **kwargs):
                started.append((target, args))

            def start(self):
                pass

        with mock.patch.object(lite_manager, "_select_viable_higher_candidate", return_value=stale_jp), \
             mock.patch.object(lite_manager, "_retire_tunnel_unlocked", side_effect=retire_then_round_trip), \
             mock.patch.object(lite_manager.threading, "Thread", FakeThread), \
             mock.patch.object(lite_manager, "get_best_candidate", return_value=None), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing"), \
             mock.patch.object(proxy_server, "clear_dns_cache"):
            self.run_once()

        self.assertEqual(started, [])
        self.assertEqual(lite_manager.target_country, "JP")
        self.assertEqual(lite_manager.config_generation, 72)
        self.assertFalse(backup.ready)
        self.assertFalse(backup.is_connecting)
        self.assertEqual(backup.entry_ip, "")
        self.assertIsNone(backup.slot_owner)

    def test_stale_race_dispatch_does_not_dial_after_jp_us_jp_redials(self):
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="1.1.1.1",
            connected_at=time.time() - 100,
            node=make_node("1.1.1.1", speed=100_000_000, entry_rtt_ms=20),
        )
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="2.2.2.2",
            connected_at=time.time() - lite_manager.BACKUP_RACE_INTERVAL - 10,
            node=make_node("2.2.2.2", speed=1_000_000, entry_rtt_ms=300),
        )
        stale_jp = make_node(
            "5.5.5.5",
            country="JP",
            speed=100_000_000,
            entry_rtt_ms=10,
            entry_probed_at=time.time() - 5,
            entry_reachable=True,
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        lite_manager.target_country = "JP"
        lite_manager.config_generation = 80
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[stale_jp["ip"]] = stale_jp

        dials = []
        original_retire = lite_manager._retire_tunnel_unlocked
        original_full_redial = lite_manager._perform_full_redial

        def retire_then_round_trip(*args, **kwargs):
            result = original_retire(*args, **kwargs)
            if result:
                original_full_redial("US", 0, False, set())
                original_full_redial("JP", 0, False, set())
            return result

        def fake_connect(tun_ref, node, generation, token, expected_country=None, expected_role=None):
            dials.append((tun_ref, node, generation, token, expected_country, expected_role))

        with mock.patch.object(lite_manager, "_select_viable_higher_candidate", return_value=stale_jp), \
             mock.patch.object(lite_manager, "_retire_tunnel_unlocked", side_effect=retire_then_round_trip), \
             mock.patch.object(lite_manager, "connect_node", side_effect=fake_connect), \
             mock.patch.object(lite_manager, "get_best_candidate", return_value=None), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing"), \
             mock.patch.object(proxy_server, "clear_dns_cache"):
            self.run_once()

        self.assertEqual(dials, [])
        self.assertFalse(backup.is_connecting)
        self.assertEqual(backup.entry_ip, "")
        self.assertIsNone(backup.slot_owner)

    def test_race_dispatch_passes_its_captured_generation_without_target_changes(self):
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="1.1.1.1",
            connected_at=time.time() - 100,
            node=make_node("1.1.1.1", speed=100_000_000, entry_rtt_ms=20),
        )
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="2.2.2.2",
            connected_at=time.time() - lite_manager.BACKUP_RACE_INTERVAL - 10,
            node=make_node("2.2.2.2", speed=1_000_000, entry_rtt_ms=300),
        )
        candidate = make_node(
            "5.5.5.5",
            country="JP",
            speed=100_000_000,
            entry_rtt_ms=10,
            entry_probed_at=time.time() - 5,
            entry_reachable=True,
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        lite_manager.target_country = "JP"
        lite_manager.config_generation = 81
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[candidate["ip"]] = candidate
        dials = []

        def fake_connect(tun_ref, node, generation, token, expected_country=None, expected_role=None):
            dials.append((tun_ref, node, generation, token, expected_country, expected_role))

        with mock.patch.object(lite_manager, "_select_viable_higher_candidate", return_value=candidate), \
             mock.patch.object(lite_manager, "connect_node", side_effect=fake_connect), \
             mock.patch.object(lite_manager, "get_best_candidate", return_value=None), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing"), \
             mock.patch.object(proxy_server, "clear_dns_cache"):
            self.run_once()

        self.assertEqual(len(dials), 1)
        self.assertEqual(dials[0][2], 81)
        self.assertEqual(dials[0][4], "JP")
        self.assertEqual(dials[0][5], "backup")


class DialReservationTests(LiteManagerTestBase):
    def test_peer_ready_entry_conflict_rejects_reservation_without_mutation(self):
        main = lite_manager.tun_main
        backup = lite_manager.tun_backup
        backup.ready = True
        backup.process = FakeProcess()
        backup.entry_ip = "2.2.2.2"
        backup.egress_ip = "9.9.9.2"
        main.dial_token = 1
        lite_manager.config_generation = 80

        reserved = lite_manager._reserve_dial_slot(
            main,
            80,
            1,
            make_node("2.2.2.2"),
            expected_country="JP",
            expected_role="main",
        )

        self.assertFalse(reserved)
        self.assertFalse(main.is_connecting)
        self.assertEqual(main.entry_ip, "")
        self.assertIsNone(main.slot_owner)

    def test_ready_peer_with_exited_process_still_conflicts(self):
        main = lite_manager.tun_main
        backup = lite_manager.tun_backup
        backup.ready = True
        backup.process = FakeProcess(alive=False)
        backup.entry_ip = "2.2.2.2"
        main.dial_token = 1
        lite_manager.config_generation = 84

        reserved = lite_manager._reserve_dial_slot(
            main,
            84,
            1,
            make_node("2.2.2.2"),
            expected_country="JP",
            expected_role="main",
        )

        self.assertFalse(reserved)
        self.assertFalse(main.is_connecting)
        self.assertEqual(main.entry_ip, "")

    def test_peer_ready_egress_conflict_rejects_reservation(self):
        main = lite_manager.tun_main
        backup = lite_manager.tun_backup
        backup.ready = True
        backup.process = FakeProcess()
        backup.entry_ip = "2.2.2.2"
        backup.egress_ip = "9.9.9.2"
        main.dial_token = 1
        lite_manager.config_generation = 81

        reserved = lite_manager._reserve_dial_slot(
            main,
            81,
            1,
            make_node("9.9.9.2"),
            expected_country="JP",
            expected_role="main",
        )

        self.assertFalse(reserved)
        self.assertFalse(main.is_connecting)
        self.assertEqual(main.entry_ip, "")

    def test_concurrent_main_and_backup_reservations_allow_exactly_one(self):
        main = lite_manager.tun_main
        backup = lite_manager.tun_backup
        node = make_node("3.3.3.3")
        main.dial_token = 1
        backup.dial_token = 1
        lite_manager.config_generation = 82
        barrier = threading.Barrier(2)
        results = {}

        def reserve(name, tun, role):
            barrier.wait(2)
            results[name] = lite_manager._reserve_dial_slot(
                tun,
                82,
                1,
                node,
                expected_country="JP",
                expected_role=role,
            )

        threads = [
            threading.Thread(target=reserve, args=("main", main, "main"), daemon=True),
            threading.Thread(target=reserve, args=("backup", backup, "backup"), daemon=True),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(2)

        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(sum(1 for reserved in results.values() if reserved), 1)
        reserved_tunnels = [tun for tun in (main, backup) if tun.is_connecting]
        self.assertEqual(len(reserved_tunnels), 1)
        self.assertEqual(reserved_tunnels[0].entry_ip, node["ip"])
        other = backup if reserved_tunnels[0] is main else main
        self.assertFalse(other.is_connecting)
        self.assertEqual(other.entry_ip, "")
        self.assertIsNone(other.slot_owner)

    def test_released_peer_entry_does_not_block_new_reservation(self):
        main = lite_manager.tun_main
        backup = lite_manager.tun_backup
        backup.ready = False
        backup.is_connecting = False
        backup.process = None
        backup.entry_ip = "4.4.4.4"
        backup.slot_owner = None
        main.dial_token = 1
        lite_manager.config_generation = 83

        reserved = lite_manager._reserve_dial_slot(
            main,
            83,
            1,
            make_node("4.4.4.4"),
            expected_country="JP",
            expected_role="main",
        )

        self.assertTrue(reserved)
        self.assertTrue(main.is_connecting)
        self.assertEqual(main.entry_ip, "4.4.4.4")

    def test_peer_dialing_egress_conflict_rejects_reservation(self):
        main = lite_manager.tun_main
        backup = lite_manager.tun_backup
        backup.ready = False
        backup.is_connecting = True
        backup.entry_ip = "4.4.4.4"
        backup.egress_ip = "8.8.8.8"
        backup.slot_owner = (85, 1)
        main.dial_token = 1
        lite_manager.config_generation = 85

        reserved = lite_manager._reserve_dial_slot(
            main,
            85,
            1,
            make_node("8.8.8.8"),
            expected_country="JP",
            expected_role="main",
        )

        self.assertFalse(reserved)
        self.assertFalse(main.is_connecting)
        self.assertEqual(main.entry_ip, "")


class SwitchModeTests(LiteManagerTestBase):
    def run_config_once(self, data):
        fake_config_wakeup = RecordingEvent(raise_on_wait=True)
        fake_pool = RecordingEvent()
        fake_heartbeat = RecordingEvent()
        with mock.patch.object(lite_manager, "config_wakeup", fake_config_wakeup), \
             mock.patch.object(lite_manager, "pool_wakeup", fake_pool), \
             mock.patch.object(lite_manager, "heartbeat_wakeup", fake_heartbeat), \
             mock.patch.object(lite_manager, "check_for_updates"), \
             mock.patch.object(lite_manager, "fetch_controller_config", return_value=data), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(proxy_server, "clear_dns_cache"):
            with self.assertRaises(StopLoop):
                lite_manager.update_config_loop()
        return fake_pool, fake_heartbeat, cleanup

    def build_ready_pair(self):
        main = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="1.1.1.1",
            egress_ip="9.9.9.1",
            connected_at=time.time() - 100,
        )
        backup = make_tunnel(
            "tun_backup",
            20102,
            ready=True,
            process=FakeProcess(),
            country="JP",
            entry_ip="2.2.2.2",
            egress_ip="9.9.9.2",
            connected_at=time.time() - 100,
        )
        lite_manager.tun_main = main
        lite_manager.tun_backup = backup
        with lite_manager.reservoir_lock:
            for node in (make_node("1.1.1.1"), make_node("2.2.2.2")):
                lite_manager.global_node_reservoir[node["ip"]] = node
        return main, backup

    def test_hot_switch_promotes_backup_and_redials_old_main(self):
        main, backup = self.build_ready_pair()
        main_process = main.process
        lite_manager.config_generation = 3
        lite_manager.last_switch_trigger = 0
        pool_event, heartbeat_event, cleanup = self.run_config_once(
            {"country": "JP", "switch_trigger": 1, "switch_mode": "hot", "port": 7920}
        )
        self.assertIs(lite_manager.tun_main, backup)
        self.assertIs(lite_manager.tun_backup, main)
        self.assertEqual(proxy_server.ACTIVE_BIND, "tun_backup")
        self.assertTrue(main_process.terminated)
        self.assertFalse(main.ready)
        self.assertEqual(main.entry_ip, "")
        self.assertTrue(lite_manager._is_dead_ip("1.1.1.1"))
        self.assertEqual(lite_manager.global_node_reservoir["1.1.1.1"]["penalty"], 3000)
        self.assertEqual(lite_manager.last_switch_trigger, 1)
        self.assertEqual(lite_manager.config_generation, 3)
        self.assertGreaterEqual(pool_event.set_calls, 1)
        self.assertGreaterEqual(heartbeat_event.set_calls, 1)
        cleanup.assert_any_call("tun_main", 20101, 30101, 31101)

    def test_full_switch_redials_both_tunnels_and_penalizes_both(self):
        main, backup = self.build_ready_pair()
        main_process = main.process
        backup_process = backup.process
        lite_manager.config_generation = 3
        lite_manager.last_switch_trigger = 0
        self.run_config_once(
            {"country": "JP", "switch_trigger": 2, "switch_mode": "full", "port": 7920}
        )
        self.assertEqual(lite_manager.config_generation, 4)
        self.assertTrue(main_process.terminated)
        self.assertTrue(backup_process.terminated)
        self.assertFalse(main.ready)
        self.assertFalse(backup.ready)
        self.assertTrue(lite_manager._is_dead_ip("1.1.1.1"))
        self.assertTrue(lite_manager._is_dead_ip("2.2.2.2"))
        self.assertEqual(lite_manager.global_node_reservoir["1.1.1.1"]["penalty"], 3000)
        self.assertEqual(lite_manager.global_node_reservoir["2.2.2.2"]["penalty"], 3000)
        self.assertEqual(lite_manager.last_switch_trigger, 2)

    def test_country_change_forces_full_redial_without_force_penalty(self):
        main, backup = self.build_ready_pair()
        main_process = main.process
        backup_process = backup.process
        lite_manager.config_generation = 3
        self.run_config_once(
            {"country": "US", "switch_trigger": 0, "switch_mode": "hot", "port": 7920}
        )
        self.assertEqual(lite_manager.config_generation, 4)
        self.assertEqual(lite_manager.target_country, "US")
        self.assertTrue(main_process.terminated)
        self.assertTrue(backup_process.terminated)
        self.assertFalse(lite_manager._is_dead_ip("1.1.1.1"))
        self.assertFalse(lite_manager._is_dead_ip("2.2.2.2"))

    def test_hot_request_falls_back_to_full_when_backup_not_ready(self):
        main, backup = self.build_ready_pair()
        main_process = main.process
        backup.ready = False
        lite_manager.config_generation = 3
        self.run_config_once(
            {"country": "JP", "switch_trigger": 3, "switch_mode": "hot", "port": 7920}
        )
        self.assertEqual(lite_manager.config_generation, 4)
        self.assertTrue(lite_manager._is_dead_ip("1.1.1.1"))
        self.assertTrue(main_process.terminated)
        self.assertEqual(lite_manager.last_switch_trigger, 3)

    def test_unknown_switch_mode_falls_back_to_hot(self):
        main, backup = self.build_ready_pair()
        lite_manager.config_generation = 3
        self.run_config_once(
            {"country": "JP", "switch_trigger": 4, "switch_mode": "unexpected", "port": 7920}
        )
        self.assertIs(lite_manager.tun_main, backup)
        self.assertEqual(lite_manager.config_generation, 3)


class ConnectNodeTests(LiteManagerTestBase):
    def setUp(self):
        super().setUp()
        self.tempdir = tempfile.TemporaryDirectory()
        lite_manager.CONFIG_DIR = Path(self.tempdir.name)
        lite_manager.WORKSPACE = Path(self.tempdir.name)

    def tearDown(self):
        self.tempdir.cleanup()
        super().tearDown()

    def fake_popen(self, process):
        def popen(command, **kwargs):
            stdout = kwargs.get("stdout")
            if hasattr(stdout, "write"):
                stdout.write("Initialization Sequence Completed\n")
                stdout.flush()
            return process
        return popen

    def test_generation_change_after_setup_terminates_and_cleans_routing(self):
        tun = lite_manager.tun_main
        tun.is_connecting = True
        tun.entry_ip = "1.1.1.1"
        tun.connect_token = 1
        node = make_node("1.1.1.1", config="client\nremote 1.1.1.1 1194\n")
        process = FakeProcess()
        lite_manager.config_generation = 7

        def bump_generation(*args, **kwargs):
            lite_manager.config_generation += 1

        with mock.patch.object(lite_manager.subprocess, "Popen", side_effect=self.fake_popen(process)), \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "OpenVPN 2.5")), \
             mock.patch.object(lite_manager, "setup_routing", side_effect=bump_generation), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(lite_manager.time, "sleep"):
            lite_manager.connect_node(tun, node, 7, token=1)

        self.assertTrue(process.terminated)
        cleanup.assert_called_once_with("tun_main", 20101, 30101, 31101)
        self.assertFalse(tun.ready)
        self.assertFalse(tun.is_connecting)
        self.assertEqual(tun.entry_ip, "")
        self.assertIsNone(tun.process)
        self.assertTrue(lite_manager.pool_wakeup.is_set())

    def test_generation_change_during_wait_terminates_before_setup(self):
        tun = lite_manager.tun_main
        tun.is_connecting = True
        tun.entry_ip = "1.1.1.1"
        tun.connect_token = 1
        node = make_node("1.1.1.1", config="client\nremote 1.1.1.1 1194\n")
        process = FakeProcess()
        lite_manager.config_generation = 8

        def bump_generation(*args, **kwargs):
            lite_manager.config_generation += 1

        with mock.patch.object(lite_manager.subprocess, "Popen", side_effect=self.fake_popen(process)), \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "OpenVPN 2.5")), \
             mock.patch.object(lite_manager, "setup_routing") as setup, \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing"), \
             mock.patch.object(lite_manager.time, "sleep", side_effect=bump_generation):
            lite_manager.connect_node(tun, node, 8, token=1)

        self.assertTrue(process.terminated)
        setup.assert_not_called()
        self.assertFalse(tun.is_connecting)

    def test_policy_cancel_after_handshake_terminates_owned_process(self):
        tun = lite_manager.tun_main
        tun.is_connecting = True
        tun.entry_ip = "1.1.1.1"
        tun.slot_owner = (24, 1)
        tun.connect_token = 1
        node = make_node("1.1.1.1", config="client\nremote 1.1.1.1 1194\n")
        process = FakeProcess()
        lite_manager.config_generation = 24
        policy_checks = []
        original_matches_policy = lite_manager._dial_matches_policy

        def cancel_on_third_policy_check(tun_ref, generation, token, process_ref, node_ref=None):
            policy_checks.append(process_ref)
            if len(policy_checks) == 3:
                with lite_manager.state_lock:
                    tun_ref.dial_token += 1
                return False
            return original_matches_policy(tun_ref, generation, token, process_ref, node_ref)

        with mock.patch.object(lite_manager.subprocess, "Popen", side_effect=self.fake_popen(process)), \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "OpenVPN 2.5")), \
             mock.patch.object(lite_manager, "_dial_matches_policy", side_effect=cancel_on_third_policy_check), \
             mock.patch.object(lite_manager, "setup_routing") as setup, \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(lite_manager.time, "sleep"):
            lite_manager.connect_node(tun, node, 24, token=1)

        self.assertGreaterEqual(len(policy_checks), 3)
        self.assertTrue(process.terminated)
        self.assertIsNone(tun.process)
        self.assertFalse(tun.is_connecting)
        self.assertEqual(tun.entry_ip, "")
        setup.assert_not_called()
        cleanup.assert_not_called()

    def test_cancel_after_quality_without_side_effects_discards_ended_process(self):
        tun = lite_manager.tun_main
        tun.is_connecting = True
        tun.entry_ip = "1.1.1.1"
        tun.slot_owner = (25, 1)
        tun.connect_token = 1
        node = make_node("1.1.1.1", config="client\nremote 1.1.1.1 1194\n")
        process = FakeProcess()
        lite_manager.config_generation = 25
        quality_done = threading.Event()
        original_side_effects = lite_manager._dial_side_effects

        def cancel_after_quality(
            tun_ref,
            generation,
            token,
            process_ref=None,
            expected_country=None,
            expected_role=None,
        ):
            if quality_done.is_set() and process_ref is not None:
                process_ref.alive = False
                with lite_manager.state_lock:
                    tun_ref.dial_token += 1
            return original_side_effects(
                tun_ref,
                generation,
                token,
                process_ref,
                expected_country=expected_country,
                expected_role=expected_role,
            )

        with mock.patch.object(lite_manager.subprocess, "Popen", side_effect=self.fake_popen(process)), \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "203.0.113.9")), \
             mock.patch.object(lite_manager, "setup_routing"), \
             mock.patch.object(lite_manager, "_testisp_lookup", return_value={"isp": {"flag": "isp"}}), \
             mock.patch.object(
                 lite_manager,
                 "probe_tunnel_quality",
                 side_effect=lambda *args, **kwargs: quality_done.set() or lite_manager.TunnelQuality(100, 5000),
             ), \
             mock.patch.object(lite_manager, "_dial_side_effects", side_effect=cancel_after_quality), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(proxy_server, "clear_dns_cache"), \
             mock.patch.object(lite_manager.time, "sleep"):
            lite_manager.connect_node(tun, node, 25, token=1)

        self.assertTrue(process.terminated)
        self.assertIsNone(tun.process)
        self.assertFalse(tun.is_connecting)
        self.assertEqual(tun.entry_ip, "")
        cleanup.assert_called_once_with("tun_main", 20101, 30101, 31101)

    def test_policy_cancel_after_quality_discards_ended_process_after_side_effects(self):
        tun = lite_manager.tun_main
        tun.is_connecting = True
        tun.entry_ip = "1.1.1.1"
        tun.slot_owner = (26, 1)
        tun.connect_token = 1
        node = make_node("1.1.1.1", config="client\nremote 1.1.1.1 1194\n")
        process = FakeProcess()
        lite_manager.config_generation = 26
        quality_done = threading.Event()
        original_side_effects = lite_manager._dial_side_effects

        def cancel_while_side_effects_held(
            tun_ref,
            generation,
            token,
            process_ref=None,
            expected_country=None,
            expected_role=None,
        ):
            lock = original_side_effects(
                tun_ref,
                generation,
                token,
                process_ref,
                expected_country=expected_country,
                expected_role=expected_role,
            )
            if lock is not None and quality_done.is_set() and process_ref is not None:
                process_ref.alive = False
                with lite_manager.state_lock:
                    tun_ref.dial_token += 1
            return lock

        with mock.patch.object(lite_manager.subprocess, "Popen", side_effect=self.fake_popen(process)), \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "203.0.113.9")), \
             mock.patch.object(lite_manager, "setup_routing"), \
             mock.patch.object(lite_manager, "_testisp_lookup", return_value={"isp": {"flag": "isp"}}), \
             mock.patch.object(
                 lite_manager,
                 "probe_tunnel_quality",
                 side_effect=lambda *args, **kwargs: quality_done.set() or lite_manager.TunnelQuality(100, 5000),
             ), \
             mock.patch.object(lite_manager, "_dial_side_effects", side_effect=cancel_while_side_effects_held), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(proxy_server, "clear_dns_cache"), \
             mock.patch.object(lite_manager.time, "sleep"):
            lite_manager.connect_node(tun, node, 26, token=1)

        self.assertTrue(process.terminated)
        self.assertIsNone(tun.process)
        self.assertFalse(tun.is_connecting)
        self.assertEqual(tun.entry_ip, "")
        cleanup.assert_called_once_with("tun_main", 20101, 30101, 31101)

    def test_token_change_immediately_after_popen_terminates_orphan(self):
        tun = lite_manager.tun_main
        tun.is_connecting = True
        tun.entry_ip = "1.1.1.1"
        tun.connect_token = 1
        node = make_node("1.1.1.1", config="client\nremote 1.1.1.1 1194\n")
        process = FakeProcess()
        lite_manager.config_generation = 11

        def popen_and_advance_token(command, **kwargs):
            stdout = kwargs.get("stdout")
            if hasattr(stdout, "write"):
                stdout.write("Initialization Sequence Completed\n")
                stdout.flush()
            tun.dial_token += 1
            return process

        with mock.patch.object(lite_manager.subprocess, "Popen", side_effect=popen_and_advance_token), \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "OpenVPN 2.5")), \
             mock.patch.object(lite_manager, "setup_routing") as setup:
            lite_manager.connect_node(tun, node, 11, token=1)

        self.assertTrue(process.terminated)
        setup.assert_not_called()

    def test_redial_during_popen_registration_does_not_leave_connecting_slot(self):
        tun = lite_manager.tun_main
        tun.is_connecting = True
        tun.entry_ip = "1.1.1.1"
        tun.connect_token = 1
        node = make_node("1.1.1.1", config="client\nremote 1.1.1.1 1194\n")
        old_process = FakeProcess()
        lite_manager.config_generation = 20
        process_created = threading.Event()
        allow_redial = threading.Event()

        def popen_then_pause(command, **kwargs):
            stdout = kwargs.get("stdout")
            if hasattr(stdout, "write"):
                stdout.write("Initialization Sequence Completed\n")
                stdout.flush()
            process_created.set()
            allow_redial.wait(1)
            return old_process

        old_thread = threading.Thread(
            target=lite_manager.connect_node,
            args=(tun, node, 20, 1),
            daemon=True,
        )
        with mock.patch.object(lite_manager.subprocess, "Popen", side_effect=popen_then_pause), \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "OpenVPN 2.5")), \
             mock.patch.object(lite_manager, "setup_routing") as setup, \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing"), \
             mock.patch.object(lite_manager.time, "sleep"):
            old_thread.start()
            self.assertTrue(process_created.wait(1))
            lite_manager._perform_full_redial("JP", 0, False, set())
            allow_redial.set()
            old_thread.join(1)

        self.assertFalse(old_thread.is_alive())
        self.assertTrue(old_process.terminated)
        self.assertIsNone(tun.process)
        self.assertFalse(tun.is_connecting)
        setup.assert_not_called()

    def test_redial_before_popen_terminates_orphan_without_clearing_new_slot(self):
        tun = lite_manager.tun_main
        tun.is_connecting = True
        tun.entry_ip = "1.1.1.1"
        tun.connect_token = 1
        process = FakeProcess()
        node = make_node("1.1.1.1", config="client\nremote 1.1.1.1 1194\n")
        lite_manager.config_generation = 21

        def redial_before_popen(*args, **kwargs):
            lite_manager.config_generation += 1
            tun.dial_token += 1
            tun.ready = False
            tun.is_connecting = True
            tun.process = None
            tun.entry_ip = "2.2.2.2"
            tun.slot_owner = None
            return process

        with mock.patch.object(lite_manager.subprocess, "Popen", side_effect=redial_before_popen), \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "OpenVPN 2.5")), \
             mock.patch.object(lite_manager, "setup_routing") as setup, \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing"):
            lite_manager.connect_node(tun, node, 21, token=1)

        self.assertTrue(process.terminated)
        self.assertIsNone(tun.process)
        self.assertTrue(tun.is_connecting)
        self.assertEqual(tun.entry_ip, "2.2.2.2")
        setup.assert_not_called()

    def test_config_is_written_under_interface_lock_and_after_ownership_check(self):
        tun = lite_manager.tun_main
        tun.is_connecting = True
        tun.entry_ip = "1.1.1.1"
        tun.connect_token = 1
        node = make_node("1.1.1.1", config="client\nremote 1.1.1.1 1194\n")
        lite_manager.config_generation = 22
        observations = []

        class RecordingPath(type(Path(self.tempdir.name))):
            def __new__(cls, *args, **kwargs):
                path = super().__new__(cls, *args, **kwargs)
                path.record = record
                return path

            def __truediv__(self, key):
                path = type(self)(self, key)
                path.record = self.record
                return path

            def write_text(self, data, *args, **kwargs):
                self.record(data)
                return super().write_text(data, *args, **kwargs)

        def record(data):
            lock_owned = bool(
                getattr(tun.io_lock, "_is_owned", lambda: False)()
            ) or (
                hasattr(tun.io_lock, "_recursion_count")
                and tun.io_lock._recursion_count() > 0
            )
            observations.append(("lock_owned", lock_owned))
            with lite_manager.state_lock:
                observations.append(
                    (
                        "current",
                        lite_manager.config_generation == 22
                        and tun.dial_token == 1
                        and tun.process is None,
                    )
                )
            return len(data)

        process = FakeProcess()
        original_side_effects = lite_manager._dial_side_effects
        side_effect_locks = []

        def tracked_side_effects(tun_ref, generation, token, process_ref=None, expected_country=None, expected_role=None):
            if process_ref is None:
                acquired = tun_ref.io_lock.acquire(blocking=False)
                side_effect_locks.append(acquired)
                if acquired:
                    tun_ref.io_lock.release()
            return original_side_effects(
                tun_ref,
                generation,
                token,
                process_ref,
                expected_country=expected_country,
                expected_role=expected_role,
            )

        with mock.patch.object(lite_manager, "CONFIG_DIR", RecordingPath(self.tempdir.name)), \
             mock.patch.object(lite_manager, "_dial_side_effects", side_effect=tracked_side_effects), \
             mock.patch.object(lite_manager.subprocess, "Popen", side_effect=self.fake_popen(process)), \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "OpenVPN 2.5")), \
             mock.patch.object(lite_manager, "setup_routing"), \
             mock.patch.object(lite_manager, "_testisp_lookup", return_value={"isp": {"flag": "isp"}}), \
             mock.patch.object(lite_manager, "probe_tunnel_quality", return_value=lite_manager.TunnelQuality(100, 5000)), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing"), \
             mock.patch.object(proxy_server, "clear_dns_cache"), \
             mock.patch.object(lite_manager.time, "sleep"):
            lite_manager.connect_node(tun, node, 22, token=1)

        self.assertIn(("current", True), observations)
        self.assertIn(("lock_owned", True), observations)
        self.assertTrue(side_effect_locks)

    def test_connect_node_rejects_stale_country_before_reserving_or_popen(self):
        tun = lite_manager.tun_backup
        tun.is_connecting = False
        tun.entry_ip = "5.5.5.5"
        tun.connect_token = 1
        node = make_node("5.5.5.5", country="JP")
        lite_manager.target_country = "US"
        lite_manager.config_generation = 51

        with mock.patch.object(lite_manager.subprocess, "Popen") as popen, \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "OpenVPN 2.5")), \
             mock.patch.object(lite_manager, "setup_routing") as setup:
            lite_manager.connect_node(tun, node, 51, token=1, expected_country="JP", expected_role="backup")

        popen.assert_not_called()
        setup.assert_not_called()
        self.assertEqual(tun.entry_ip, "5.5.5.5")
        self.assertIsNone(tun.slot_owner)
        self.assertFalse(tun.is_connecting)

    def test_connect_node_rechecks_country_and_backup_role_inside_slot_lock(self):
        tun = lite_manager.tun_backup
        tun.is_connecting = True
        tun.entry_ip = "5.5.5.5"
        tun.connect_token = 1
        node = make_node("5.5.5.5", country="JP")
        lite_manager.target_country = "JP"
        lite_manager.config_generation = 52
        original_reserve = lite_manager._reserve_dial_slot

        def switch_country_before_reserve(*args, **kwargs):
            lite_manager.target_country = "US"
            return original_reserve(*args, **kwargs)

        with mock.patch.object(lite_manager, "_reserve_dial_slot", side_effect=switch_country_before_reserve), \
             mock.patch.object(lite_manager.subprocess, "Popen") as popen, \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "OpenVPN 2.5")):
            lite_manager.connect_node(tun, node, 52, token=1, expected_country="JP", expected_role="backup")

        popen.assert_not_called()
        self.assertEqual(tun.entry_ip, "")
        self.assertIsNone(tun.slot_owner)

    def test_connect_node_rechecks_role_before_popen_after_slot_swap(self):
        main = lite_manager.tun_main
        backup = lite_manager.tun_backup
        backup.is_connecting = True
        backup.entry_ip = "5.5.5.5"
        backup.connect_token = 1
        node = make_node("5.5.5.5", country="JP")
        lite_manager.target_country = "JP"
        lite_manager.config_generation = 53
        original_reserve = lite_manager._reserve_dial_slot

        def swap_roles_before_reserve(*args, **kwargs):
            lite_manager.tun_main, lite_manager.tun_backup = backup, main
            return original_reserve(*args, **kwargs)

        with mock.patch.object(lite_manager, "_reserve_dial_slot", side_effect=swap_roles_before_reserve), \
             mock.patch.object(lite_manager.subprocess, "Popen") as popen, \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "OpenVPN 2.5")):
            lite_manager.connect_node(backup, node, 53, token=1, expected_country="JP", expected_role="backup")

        popen.assert_not_called()
        self.assertEqual(backup.entry_ip, "")
        self.assertIsNone(backup.slot_owner)

    def test_connect_node_allows_captured_country_when_target_is_any(self):
        tun = lite_manager.tun_backup
        tun.is_connecting = True
        tun.entry_ip = "5.5.5.5"
        tun.connect_token = 1
        node = make_node("5.5.5.5", country="JP")
        process = FakeProcess()
        lite_manager.target_country = "ANY"
        lite_manager.config_generation = 54

        def fake_run(command, *args, **kwargs):
            if command[:2] == ["openvpn", "--version"]:
                return Completed(0, "OpenVPN 2.5")
            return Completed(0, "203.0.113.9")

        with mock.patch.object(lite_manager.subprocess, "Popen", side_effect=self.fake_popen(process)) as popen, \
             mock.patch.object(lite_manager.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(lite_manager, "setup_routing"), \
             mock.patch.object(lite_manager, "_testisp_lookup", return_value={"isp": {"flag": "isp"}, "geo": {"is_native": True}}), \
             mock.patch.object(lite_manager, "probe_tunnel_quality", return_value=lite_manager.TunnelQuality(100, 5000)), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing"), \
             mock.patch.object(proxy_server, "clear_dns_cache"), \
             mock.patch.object(lite_manager.time, "sleep"):
            lite_manager.connect_node(tun, node, 54, token=1, expected_country="JP", expected_role="backup")

        popen.assert_called_once()
        self.assertTrue(tun.ready)
        self.assertEqual(tun.country, "JP")

    def test_connect_node_rejects_role_mismatch_when_target_is_any(self):
        tun = lite_manager.tun_main
        tun.is_connecting = True
        tun.entry_ip = "5.5.5.5"
        tun.connect_token = 1
        node = make_node("5.5.5.5", country="JP")
        lite_manager.target_country = "ANY"
        lite_manager.config_generation = 55

        with mock.patch.object(lite_manager.subprocess, "Popen") as popen, \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "OpenVPN 2.5")), \
             mock.patch.object(lite_manager, "setup_routing") as setup:
            lite_manager.connect_node(tun, node, 55, token=1, expected_country="JP", expected_role="backup")

        popen.assert_not_called()
        setup.assert_not_called()

    def test_connect_node_clears_owned_slot_when_generation_is_stale(self):
        tun = lite_manager.tun_backup
        tun.is_connecting = True
        tun.entry_ip = "5.5.5.5"
        tun.connect_token = 1
        tun.slot_owner = (56, 1)
        node = make_node("5.5.5.5", country="JP")
        lite_manager.target_country = "JP"
        lite_manager.config_generation = 57

        with mock.patch.object(lite_manager.subprocess, "Popen") as popen, \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "OpenVPN 2.5")), \
             mock.patch.object(lite_manager, "setup_routing") as setup:
            lite_manager.connect_node(tun, node, 56, token=1, expected_country="JP", expected_role="backup")

        popen.assert_not_called()
        setup.assert_not_called()
        self.assertFalse(tun.is_connecting)
        self.assertEqual(tun.entry_ip, "")
        self.assertIsNone(tun.slot_owner)

    def test_connect_node_releases_pre_reserved_slot_without_owner_when_generation_is_stale(self):
        tun = lite_manager.tun_backup
        tun.is_connecting = True
        tun.entry_ip = "5.5.5.5"
        tun.connect_token = 1
        tun.slot_owner = None
        node = make_node("5.5.5.5", country="JP")
        lite_manager.target_country = "JP"
        lite_manager.config_generation = 58

        with mock.patch.object(lite_manager.subprocess, "Popen") as popen, \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "OpenVPN 2.5")), \
             mock.patch.object(lite_manager, "setup_routing") as setup:
            lite_manager.connect_node(tun, node, 57, token=1, expected_country="JP", expected_role="backup")

        popen.assert_not_called()
        setup.assert_not_called()
        self.assertFalse(tun.is_connecting)
        self.assertEqual(tun.entry_ip, "")
        self.assertIsNone(tun.slot_owner)

    def test_stale_dial_does_not_release_newer_pre_reserved_slot(self):
        tun = lite_manager.tun_backup
        tun.is_connecting = True
        tun.entry_ip = "9.9.9.9"
        tun.connect_token = 2
        tun.slot_owner = None
        node = make_node("5.5.5.5", country="JP")
        lite_manager.target_country = "JP"
        lite_manager.config_generation = 60

        with mock.patch.object(lite_manager.subprocess, "Popen") as popen, \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "OpenVPN 2.5")):
            lite_manager.connect_node(tun, node, 59, token=1, expected_country="JP", expected_role="backup")

        popen.assert_not_called()
        self.assertTrue(tun.is_connecting)
        self.assertEqual(tun.entry_ip, "9.9.9.9")
        self.assertIsNone(tun.slot_owner)

    def test_stale_dial_does_not_release_newer_slot_in_same_generation(self):
        tun = lite_manager.tun_backup
        tun.is_connecting = True
        tun.entry_ip = "9.9.9.9"
        tun.connect_token = 2
        tun.slot_owner = (60, 2)
        node = make_node("5.5.5.5", country="JP")
        lite_manager.target_country = "JP"
        lite_manager.config_generation = 60

        with mock.patch.object(lite_manager.subprocess, "Popen") as popen, \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "OpenVPN 2.5")):
            lite_manager.connect_node(tun, node, 60, 1, expected_country="JP", expected_role="backup")

        popen.assert_not_called()
        self.assertTrue(tun.is_connecting)
        self.assertEqual(tun.entry_ip, "9.9.9.9")
        self.assertEqual(tun.slot_owner, (60, 2))

    def test_stale_dial_does_not_clear_newer_entry_without_slot_owner(self):
        tun = lite_manager.tun_backup
        tun.is_connecting = True
        tun.entry_ip = "9.9.9.9"
        tun.connect_token = 2
        tun.slot_owner = None
        node = make_node("5.5.5.5", country="JP")
        lite_manager.target_country = "JP"
        lite_manager.config_generation = 62

        with mock.patch.object(lite_manager.subprocess, "Popen") as popen, \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "OpenVPN 2.5")):
            lite_manager.connect_node(tun, node, 62, 1, expected_country="JP", expected_role="backup")

        popen.assert_not_called()
        self.assertTrue(tun.is_connecting)
        self.assertEqual(tun.entry_ip, "9.9.9.9")
        self.assertIsNone(tun.slot_owner)

    def test_connect_node_passes_captured_context_to_all_side_effect_checks(self):
        tun = lite_manager.tun_main
        tun.is_connecting = True
        tun.entry_ip = "1.1.1.1"
        tun.connect_token = 1
        node = make_node("1.1.1.1", country="JP")
        process = FakeProcess()
        lite_manager.target_country = "JP"
        lite_manager.config_generation = 61
        observed = []
        original_side_effects = lite_manager._dial_side_effects

        def tracked_side_effects(
            tun_ref,
            generation,
            token,
            process_ref=None,
            expected_country=None,
            expected_role=None,
        ):
            observed.append((process_ref is None, expected_country, expected_role))
            return original_side_effects(
                tun_ref,
                generation,
                token,
                process_ref,
                expected_country=expected_country,
                expected_role=expected_role,
            )

        with mock.patch.object(lite_manager, "_dial_side_effects", side_effect=tracked_side_effects), \
             mock.patch.object(lite_manager.subprocess, "Popen", side_effect=self.fake_popen(process)), \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "203.0.113.9")), \
             mock.patch.object(lite_manager, "setup_routing"), \
             mock.patch.object(lite_manager, "_testisp_lookup", return_value={"isp": {"flag": "isp"}}), \
             mock.patch.object(lite_manager, "probe_tunnel_quality", return_value=lite_manager.TunnelQuality(100, 5000)), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing"), \
             mock.patch.object(proxy_server, "clear_dns_cache"), \
             mock.patch.object(lite_manager.time, "sleep"):
            lite_manager.connect_node(tun, node, 61, token=1, expected_country="JP", expected_role="main")

        self.assertEqual(
            observed,
            [
                (True, "JP", "main"),
                (False, "JP", "main"),
                (False, "JP", "main"),
            ],
        )

    def test_current_process_exit_during_handshake_is_penalized(self):
        tun = lite_manager.tun_main
        tun.is_connecting = True
        tun.entry_ip = "1.1.1.1"
        tun.connect_token = 1
        node = make_node("1.1.1.1", config="client\nremote 1.1.1.1 1194\n")
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[node["ip"]] = node
        process = FakeProcess()
        lite_manager.config_generation = 23

        def popen_then_exit(command, **kwargs):
            stdout = kwargs.get("stdout")
            if hasattr(stdout, "write"):
                stdout.write("Initialization Sequence Completed\n")
                stdout.flush()
            process.alive = False
            return process

        with mock.patch.object(lite_manager.subprocess, "Popen", side_effect=popen_then_exit), \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "OpenVPN 2.5")), \
             mock.patch.object(lite_manager, "setup_routing") as setup, \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing"), \
             mock.patch.object(lite_manager.time, "sleep"):
            lite_manager.connect_node(tun, node, 23, token=1)

        self.assertEqual(node["penalty"], 5000)
        self.assertTrue(lite_manager._is_dead_ip(node["ip"]))
        self.assertFalse(tun.is_connecting)
        self.assertIsNone(tun.process)
        setup.assert_not_called()

    def test_ready_tunnel_records_quality_and_clears_connecting(self):
        tun = lite_manager.tun_main
        tun.is_connecting = True
        tun.entry_ip = "1.1.1.1"
        tun.connect_token = 1
        node = make_node("1.1.1.1", config="client\nremote 1.1.1.1 1194\n")
        process = FakeProcess()
        lite_manager.config_generation = 9

        with mock.patch.object(lite_manager.subprocess, "Popen", side_effect=self.fake_popen(process)), \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "203.0.113.9")), \
             mock.patch.object(lite_manager, "setup_routing"), \
             mock.patch.object(lite_manager, "_testisp_lookup", return_value={"isp": {"flag": "isp"}, "geo": {"is_native": True}}), \
             mock.patch.object(lite_manager, "probe_tunnel_quality", return_value=lite_manager.TunnelQuality(123, 456)), \
             mock.patch.object(proxy_server, "clear_dns_cache"), \
             mock.patch.object(lite_manager.time, "sleep"):
            lite_manager.connect_node(tun, node, 9, token=1)

        self.assertTrue(tun.ready)
        self.assertFalse(tun.is_connecting)
        self.assertEqual(tun.ttfb_ms, 123)
        self.assertEqual(tun.speed_kbps, 456)
        self.assertEqual(tun.egress_ip, "203.0.113.9")
        self.assertEqual(tun.country, "JP")
        self.assertTrue(lite_manager.pool_wakeup.is_set())
        self.assertTrue(lite_manager.heartbeat_wakeup.is_set())

    def test_egress_is_published_before_quality_probe_finishes(self):
        tun = lite_manager.tun_main
        lite_manager.tun_backup = make_tunnel("tun_backup", 20102)
        tun.is_connecting = True
        tun.entry_ip = "4.4.4.4"
        tun.connect_token = 1
        node = make_node("4.4.4.4", config="client\nremote 4.4.4.4 1194\n")
        process = FakeProcess()
        lite_manager.config_generation = 86
        observed = {}
        probe_started = threading.Event()
        release_probe = threading.Event()

        def delayed_probe(*args, **kwargs):
            with lite_manager.state_lock:
                observed["ready"] = tun.ready
                observed["egress"] = tun.egress_ip
                observed["peer_sees_egress"] = lite_manager._peer_reservation_conflicts_locked(
                    lite_manager.tun_backup, "8.8.8.8"
                )
            probe_started.set()
            release_probe.wait(2)
            return lite_manager.TunnelQuality(100, 5000)

        dial_thread = threading.Thread(
            target=lite_manager.connect_node,
            args=(tun, node, 86, 1, "JP", "main"),
            daemon=True,
        )
        with mock.patch.object(lite_manager.subprocess, "Popen", side_effect=self.fake_popen(process)), \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "8.8.8.8")), \
             mock.patch.object(lite_manager, "setup_routing"), \
             mock.patch.object(lite_manager, "_testisp_lookup", return_value={"isp": {"flag": "isp"}, "geo": {"is_native": True}}), \
             mock.patch.object(lite_manager, "probe_tunnel_quality", side_effect=delayed_probe), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing"), \
             mock.patch.object(proxy_server, "clear_dns_cache"), \
             mock.patch.object(lite_manager.time, "sleep"):
            dial_thread.start()
            self.assertTrue(probe_started.wait(2))
            self.assertFalse(tun.ready)
            self.assertEqual(tun.egress_ip, "8.8.8.8")
            reserved = lite_manager._reserve_dial_slot(
                lite_manager.tun_backup,
                86,
                2,
                make_node("8.8.8.8"),
                expected_country="JP",
                expected_role="backup",
            )
            self.assertFalse(reserved)
            release_probe.set()
            dial_thread.join(2)

        self.assertFalse(dial_thread.is_alive())
        self.assertTrue(observed["ready"] is False)
        self.assertEqual(observed["egress"], "8.8.8.8")
        self.assertTrue(observed["peer_sees_egress"])
        self.assertTrue(tun.ready)
        self.assertEqual(tun.egress_ip, "8.8.8.8")

    def test_concurrent_same_exit_converges_to_one_ready_tunnel(self):
        main = lite_manager.tun_main
        backup = lite_manager.tun_backup
        main.is_connecting = True
        main.entry_ip = "4.4.4.4"
        main.connect_token = 1
        main_process = FakeProcess()
        backup.is_connecting = True
        backup.entry_ip = "5.5.5.5"
        backup.connect_token = 1
        backup_process = FakeProcess()
        lite_manager.config_generation = 87
        main_node = make_node("4.4.4.4", config="client\nremote 4.4.4.4 1194\n")
        backup_node = make_node("5.5.5.5", config="client\nremote 5.5.5.5 1194\n")
        egress_barrier = threading.Barrier(2, timeout=2)
        errors = []
        processes_by_config = {
            "tun_main.ovpn": main_process,
            "tun_backup.ovpn": backup_process,
        }

        def fake_run(command, *args, **kwargs):
            if command[:2] == ["openvpn", "--version"]:
                return Completed(0, "OpenVPN 2.5")
            if any("ipify" in str(part) for part in command):
                egress_barrier.wait(2)
                return Completed(0, "8.8.8.8")
            return Completed(0, "")

        def popen(command, **kwargs):
            config_name = Path(command[command.index("--config") + 1]).name
            stdout = kwargs.get("stdout")
            if hasattr(stdout, "write"):
                stdout.write("Initialization Sequence Completed\n")
                stdout.flush()
            return processes_by_config[config_name]

        def dial(tun, node, role):
            try:
                lite_manager.connect_node(tun, node, 87, 1, "JP", role)
            except Exception as error:
                errors.append(error)

        threads = {
            "main": threading.Thread(target=dial, args=(main, main_node, "main"), daemon=True),
            "backup": threading.Thread(target=dial, args=(backup, backup_node, "backup"), daemon=True),
        }
        with mock.patch.object(lite_manager.subprocess, "Popen", side_effect=popen), \
             mock.patch.object(lite_manager.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(lite_manager, "setup_routing"), \
             mock.patch.object(lite_manager, "_testisp_lookup", return_value={"isp": {"flag": "isp"}, "geo": {"is_native": True}}), \
             mock.patch.object(lite_manager, "probe_tunnel_quality", return_value=lite_manager.TunnelQuality(100, 5000)), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing"), \
             mock.patch.object(proxy_server, "clear_dns_cache"), \
             mock.patch.object(lite_manager.time, "sleep"):
            for thread in threads.values():
                thread.start()
            for thread in threads.values():
                thread.join(3)

        self.assertFalse(any(thread.is_alive() for thread in threads.values()))
        self.assertEqual([str(error) for error in errors], [])
        ready_tunnels = [tun for tun in (main, backup) if tun.ready]
        self.assertEqual(len(ready_tunnels), 1)
        winner = ready_tunnels[0]
        loser = backup if winner is main else main
        winner_process = main_process if winner is main else backup_process
        loser_process = backup_process if winner is main else main_process
        self.assertTrue(winner_process.alive)
        self.assertFalse(loser_process.alive)
        self.assertFalse(loser.ready)
        self.assertEqual(loser.egress_ip, "")
        self.assertIsNone(loser.process)
        self.assertEqual(winner.egress_ip, "8.8.8.8")
        self.assertTrue(lite_manager._is_dead_ip("5.5.5.5") or lite_manager._is_dead_ip("4.4.4.4"))

    def test_concurrent_backup_entry_matching_main_exit_keeps_single_ready_tunnel(self):
        main = lite_manager.tun_main
        backup = lite_manager.tun_backup
        main.is_connecting = True
        main.entry_ip = "4.4.4.4"
        main.connect_token = 1
        main_process = FakeProcess()
        backup.is_connecting = True
        backup.entry_ip = "8.8.8.8"
        backup.connect_token = 1
        backup_process = FakeProcess()
        lite_manager.config_generation = 89
        main_node = make_node("4.4.4.4", config="client\nremote 4.4.4.4 1194\n")
        backup_node = make_node("8.8.8.8", config="client\nremote 8.8.8.8 1194\n")
        egress_barrier = threading.Barrier(2, timeout=2)
        processes_by_config = {
            "tun_main.ovpn": main_process,
            "tun_backup.ovpn": backup_process,
        }
        errors = []

        def fake_run(command, *args, **kwargs):
            if command[:2] == ["openvpn", "--version"]:
                return Completed(0, "OpenVPN 2.5")
            if any("ipify" in str(part) for part in command):
                egress_barrier.wait(2)
                return Completed(0, "8.8.8.8")
            return Completed(0, "")

        def popen(command, **kwargs):
            config_name = Path(command[command.index("--config") + 1]).name
            stdout = kwargs.get("stdout")
            if hasattr(stdout, "write"):
                stdout.write("Initialization Sequence Completed\n")
                stdout.flush()
            return processes_by_config[config_name]

        def dial(tun, node, role):
            try:
                lite_manager.connect_node(tun, node, 89, 1, "JP", role)
            except Exception as error:
                errors.append(error)

        threads = [
            threading.Thread(target=dial, args=(main, main_node, "main"), daemon=True),
            threading.Thread(target=dial, args=(backup, backup_node, "backup"), daemon=True),
        ]
        with mock.patch.object(lite_manager.subprocess, "Popen", side_effect=popen), \
             mock.patch.object(lite_manager.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(lite_manager, "setup_routing"), \
             mock.patch.object(lite_manager, "_testisp_lookup", return_value={"isp": {"flag": "isp"}, "geo": {"is_native": True}}), \
             mock.patch.object(lite_manager, "probe_tunnel_quality", return_value=lite_manager.TunnelQuality(100, 5000)), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(proxy_server, "clear_dns_cache"), \
             mock.patch.object(lite_manager.time, "sleep"):
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(3)

        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual([str(error) for error in errors], [])
        ready_tunnels = [tun for tun in (main, backup) if tun.ready]
        self.assertEqual(len(ready_tunnels), 1)
        winner = ready_tunnels[0]
        loser = backup if winner is main else main
        loser_process = backup_process if loser is backup else main_process
        self.assertEqual(winner.egress_ip, "8.8.8.8")
        self.assertFalse(loser.ready)
        self.assertFalse(loser.is_connecting)
        self.assertEqual(loser.egress_ip, "")
        self.assertIsNone(loser.process)
        self.assertTrue(loser_process.terminated)
        cleanup.assert_called_once_with(
            loser.name,
            loser.table_id,
            loser.table_id + 10000,
            loser.table_id + 11000,
        )

    def test_ready_peer_exit_conflict_preserves_healthy_side(self):
        main = lite_manager.tun_main
        backup = lite_manager.tun_backup
        backup.ready = True
        backup.process = FakeProcess()
        backup.entry_ip = "5.5.5.5"
        backup.egress_ip = "8.8.8.8"
        main.is_connecting = True
        main.entry_ip = "4.4.4.4"
        main.connect_token = 1
        main.slot_owner = (88, 1)
        main_process = FakeProcess()
        lite_manager.config_generation = 88
        node = make_node("4.4.4.4", config="client\nremote 4.4.4.4 1194\n")

        with mock.patch.object(lite_manager.subprocess, "Popen", side_effect=self.fake_popen(main_process)), \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "8.8.8.8")), \
             mock.patch.object(lite_manager, "setup_routing"), \
             mock.patch.object(lite_manager, "_testisp_lookup", return_value={"isp": {"flag": "isp"}, "geo": {"is_native": True}}), \
             mock.patch.object(lite_manager, "probe_tunnel_quality", return_value=lite_manager.TunnelQuality(100, 5000)), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(proxy_server, "clear_dns_cache"), \
             mock.patch.object(lite_manager.time, "sleep"):
            lite_manager.connect_node(main, node, 88, 1, "JP", "main")

        self.assertFalse(main.ready)
        self.assertIsNone(main.process)
        self.assertFalse(main.is_connecting)
        self.assertEqual(main.egress_ip, "")
        self.assertTrue(main_process.terminated)
        self.assertTrue(backup.ready)
        self.assertTrue(backup.process.alive)
        self.assertEqual(backup.egress_ip, "8.8.8.8")
        cleanup.assert_called_once_with("tun_main", 20101, 30101, 31101)
        self.assertTrue(lite_manager.pool_wakeup.is_set())

    def test_ready_peer_still_connecting_during_dns_cleanup_wins_exit_conflict(self):
        main = lite_manager.tun_main
        backup = lite_manager.tun_backup
        quality_started = threading.Event()
        release_quality = threading.Event()

        def probe_during_peer_dns_cleanup(*args, **kwargs):
            with lite_manager.state_lock:
                backup.ready = True
            quality_started.set()
            release_quality.wait(2)
            return lite_manager.TunnelQuality(100, 5000)

        backup.is_connecting = True
        backup.process = FakeProcess()
        backup.entry_ip = "5.5.5.5"
        backup.egress_ip = "8.8.8.8"
        main.is_connecting = True
        main.entry_ip = "4.4.4.4"
        main.connect_token = 1
        main.slot_owner = (90, 1)
        main_process = FakeProcess()
        lite_manager.config_generation = 90
        node = make_node("4.4.4.4", config="client\nremote 4.4.4.4 1194\n")

        dial_thread = threading.Thread(
            target=lite_manager.connect_node,
            args=(main, node, 90, 1, "JP", "main"),
            daemon=True,
        )
        with mock.patch.object(lite_manager.subprocess, "Popen", side_effect=self.fake_popen(main_process)), \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "8.8.8.8")), \
             mock.patch.object(lite_manager, "setup_routing"), \
             mock.patch.object(lite_manager, "_testisp_lookup", return_value={"isp": {"flag": "isp"}, "geo": {"is_native": True}}), \
             mock.patch.object(lite_manager, "probe_tunnel_quality", side_effect=probe_during_peer_dns_cleanup), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(proxy_server, "clear_dns_cache"), \
             mock.patch.object(lite_manager.time, "sleep"):
            dial_thread.start()
            self.assertTrue(quality_started.wait(2))

            self.assertTrue(backup.ready)
            self.assertTrue(backup.is_connecting)
            self.assertFalse(main.ready)
            self.assertEqual(main.egress_ip, "8.8.8.8")
            release_quality.set()
            dial_thread.join(2)

        self.assertFalse(dial_thread.is_alive())
        self.assertFalse(main.ready)
        self.assertFalse(main.is_connecting)
        self.assertIsNone(main.process)
        self.assertEqual(main.egress_ip, "")
        self.assertTrue(main_process.terminated)
        self.assertTrue(backup.ready)
        self.assertTrue(backup.is_connecting)
        self.assertTrue(backup.process.alive)
        self.assertEqual(backup.egress_ip, "8.8.8.8")
        cleanup.assert_called_once_with("tun_main", 20101, 30101, 31101)
        self.assertTrue(lite_manager.pool_wakeup.is_set())
        self.assertTrue(lite_manager.heartbeat_wakeup.is_set())
        backup.is_connecting = False
        with mock.patch.object(lite_manager, "_cleanup_tunnel_routing"), \
             mock.patch.object(proxy_server, "clear_dns_cache"), \
             mock.patch.object(lite_manager.time, "sleep"):
            self.assertTrue(lite_manager._perform_hot_switch("JP", 1, set()))
        self.assertIs(lite_manager.tun_main, backup)
        self.assertEqual(proxy_server.ACTIVE_BIND, "tun_backup")
        self.assertEqual(lite_manager.tun_main.egress_ip, "8.8.8.8")

    def test_measured_quality_is_written_back_and_changes_candidate_score(self):
        tun = lite_manager.tun_main
        tun.is_connecting = True
        tun.entry_ip = "1.1.1.1"
        tun.connect_token = 1
        node = make_node("1.1.1.1", config="client\nremote 1.1.1.1 1194\n")
        process = FakeProcess()
        lite_manager.config_generation = 10

        with mock.patch.object(lite_manager.subprocess, "Popen", side_effect=self.fake_popen(process)), \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "203.0.113.9")), \
             mock.patch.object(lite_manager, "setup_routing"), \
             mock.patch.object(lite_manager, "_testisp_lookup", return_value={"isp": {"flag": "isp"}, "geo": {"is_native": True}}), \
             mock.patch.object(lite_manager, "probe_tunnel_quality", return_value=lite_manager.TunnelQuality(123, 456)), \
             mock.patch.object(proxy_server, "clear_dns_cache"), \
             mock.patch.object(lite_manager.time, "sleep"):
            lite_manager.connect_node(tun, node, 10, token=1)

        measured = lite_manager._get_measured_quality("1.1.1.1")
        self.assertEqual(measured["ttfb_ms"], 123)
        self.assertEqual(measured["speed_kbps"], 456)
        self.assertEqual(node["ttfb_ms"], 123)
        self.assertEqual(node["speed_kbps"], 456)
        self.assertGreater(
            lite_manager.compute_candidate_score(make_node("1.1.1.1")),
            lite_manager.compute_candidate_score(make_node("2.2.2.2")),
        )

    def test_old_dial_cannot_install_or_clean_routes_after_interface_reuse(self):
        tun = lite_manager.tun_main
        tun.is_connecting = True
        tun.entry_ip = "1.1.1.1"
        tun.connect_token = 1
        node = make_node("1.1.1.1", config="client\nremote 1.1.1.1 1194\n")
        old_process = FakeProcess()
        new_process = FakeProcess()
        lite_manager.tun_main = tun
        lite_manager.tun_backup = make_tunnel("tun_backup", 20102)
        lite_manager.config_generation = 1

        route_guard = threading.Event()
        allow_route = threading.Event()
        redial_done = threading.Event()
        setup_after_redial = []

        def fake_setup(*args, **kwargs):
            setup_after_redial.append(redial_done.is_set())

        original_side_effects = lite_manager._dial_side_effects

        def guarded_side_effects(
            tun_ref,
            generation,
            token,
            process=None,
            expected_country=None,
            expected_role=None,
        ):
            if process is not None:
                route_guard.set()
                allow_route.wait(2)
            return original_side_effects(
                tun_ref,
                generation,
                token,
                process,
                expected_country=expected_country,
                expected_role=expected_role,
            )

        old_thread = threading.Thread(
            target=lite_manager.connect_node,
            args=(tun, node, 1, 1),
            daemon=True,
        )
        with mock.patch.object(lite_manager, "_dial_side_effects", side_effect=guarded_side_effects), \
             mock.patch.object(lite_manager.subprocess, "Popen", side_effect=self.fake_popen(old_process)), \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "OpenVPN 2.5")), \
             mock.patch.object(lite_manager, "setup_routing", side_effect=fake_setup), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(lite_manager.time, "sleep"), \
             mock.patch.object(proxy_server, "clear_dns_cache"):
            old_thread.start()
            self.assertTrue(route_guard.wait(2))
            redial_thread = threading.Thread(
                target=lambda: (
                    lite_manager._perform_full_redial("JP", 0, False, set()),
                    redial_done.set(),
                ),
                daemon=True,
            )
            redial_thread.start()
            redial_thread.join(2)
            self.assertTrue(redial_done.is_set())

            cleanup.reset_mock()
            allow_route.set()
            old_thread.join(2)

        self.assertFalse(old_thread.is_alive())
        self.assertEqual(setup_after_redial, [])
        cleanup.assert_not_called()
        self.assertTrue(old_process.terminated)
        self.assertFalse(new_process.terminated)

    def test_old_dial_cannot_submit_ready_after_interface_reuse(self):
        tun = lite_manager.tun_main
        tun.is_connecting = True
        tun.entry_ip = "1.1.1.1"
        tun.connect_token = 1
        node = make_node("1.1.1.1", config="client\nremote 1.1.1.1 1194\n")
        old_process = FakeProcess()
        new_process = FakeProcess()
        lite_manager.config_generation = 12
        quality_started = threading.Event()
        allow_commit = threading.Event()

        def old_dial():
            with mock.patch.object(lite_manager.subprocess, "Popen", side_effect=self.fake_popen(old_process)), \
                 mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "OpenVPN 2.5")), \
                 mock.patch.object(lite_manager, "setup_routing"), \
                 mock.patch.object(lite_manager, "_cleanup_tunnel_routing"), \
                 mock.patch.object(lite_manager, "_testisp_lookup", return_value={"isp": {"flag": "isp"}}), \
                 mock.patch.object(proxy_server, "clear_dns_cache"), \
                 mock.patch.object(lite_manager.time, "sleep"):
                lite_manager.connect_node(tun, node, 12, token=1)

        def delayed_probe(*args, **kwargs):
            quality_started.set()
            allow_commit.wait(2)
            return lite_manager.TunnelQuality(100, 10000)

        with mock.patch.object(lite_manager, "probe_tunnel_quality", side_effect=delayed_probe):
            old_thread = threading.Thread(target=old_dial, daemon=True)
            old_thread.start()
            self.assertTrue(quality_started.wait(2))
            with mock.patch.object(lite_manager.subprocess, "Popen", side_effect=self.fake_popen(new_process)), \
                 mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "OpenVPN 2.5")), \
                 mock.patch.object(lite_manager, "setup_routing"), \
                 mock.patch.object(lite_manager, "_cleanup_tunnel_routing"), \
                 mock.patch.object(proxy_server, "clear_dns_cache"), \
                 mock.patch.object(lite_manager.time, "sleep"):
                lite_manager._perform_full_redial("JP", 0, False, set())
                tun.process = new_process
                tun.dial_token = 2
                tun.entry_ip = "9.9.9.9"
                tun.egress_ip = "9.9.9.9"
                tun.ready = False
            allow_commit.set()
            old_thread.join(2)

        self.assertFalse(old_thread.is_alive())
        self.assertTrue(old_process.terminated)
        self.assertFalse(new_process.terminated)
        self.assertFalse(tun.ready)
        self.assertEqual(tun.entry_ip, "9.9.9.9")
        self.assertEqual(tun.egress_ip, "9.9.9.9")

    def test_full_redial_takes_interface_locks_before_invalidating_old_dial(self):
        tun = lite_manager.tun_main
        tun.is_connecting = True
        tun.entry_ip = "1.1.1.1"
        tun.connect_token = 1
        old_process = FakeProcess()
        old_process._kui_routing_installed = True
        tun.process = old_process
        lite_manager.tun_main = tun
        lite_manager.tun_backup = make_tunnel("tun_backup", 20102)
        lite_manager.config_generation = 30
        lock_reached = threading.Event()
        allow_lock = threading.Event()
        redial_finished = threading.Event()
        observed = {}
        original_lock = lite_manager._lock_tunnel_io

        def observed_lock(*tunnels):
            with lite_manager.state_lock:
                observed.setdefault("generation_at_lock", []).append(lite_manager.config_generation)
                observed.setdefault("process_at_lock", []).append(tun.process)
            return original_lock(*tunnels)

        redial_thread = threading.Thread(
            target=lambda: (
                lite_manager._perform_full_redial("JP", 0, False, set()),
                redial_finished.set(),
            ),
            name="redial",
            daemon=True,
        )
        with mock.patch.object(lite_manager, "_lock_tunnel_io", side_effect=observed_lock), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing"), \
             mock.patch.object(proxy_server, "clear_dns_cache"):
            redial_thread.start()
            redial_thread.join(2)

        self.assertTrue(redial_finished.is_set())
        self.assertEqual(observed["generation_at_lock"], [30])
        self.assertEqual(observed["process_at_lock"], [old_process])
        self.assertIsNone(tun.process)
        self.assertFalse(tun.is_connecting)

    def test_ready_commit_and_process_start_share_interface_lock(self):
        tun = lite_manager.tun_main
        tun.is_connecting = True
        tun.entry_ip = "1.1.1.1"
        tun.connect_token = 1
        node = make_node("1.1.1.1", config="client\nremote 1.1.1.1 1194\n")
        process = FakeProcess()
        lite_manager.config_generation = 13
        events = []

        def popen(command, **kwargs):
            events.append("popen")
            if hasattr(kwargs.get("stdout"), "write"):
                kwargs["stdout"].write("Initialization Sequence Completed\n")
                kwargs["stdout"].flush()
            return process

        def probe(*args, **kwargs):
            events.append("probe")
            return lite_manager.TunnelQuality(100, 5000)

        def setup(*args, **kwargs):
            events.append("setup")

        original_side_effects = lite_manager._dial_side_effects
        lock_attempts = []

        def side_effects(
            tun_ref,
            generation,
            token,
            process=None,
            expected_country=None,
            expected_role=None,
        ):
            acquired = tun_ref.io_lock.acquire(blocking=False)
            lock_attempts.append(acquired)
            if acquired:
                tun_ref.io_lock.release()
            return original_side_effects(
                tun_ref,
                generation,
                token,
                process,
                expected_country=expected_country,
                expected_role=expected_role,
            )

        with mock.patch.object(lite_manager.subprocess, "Popen", side_effect=popen), \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "203.0.113.9")), \
             mock.patch.object(lite_manager, "setup_routing", side_effect=setup), \
             mock.patch.object(lite_manager, "_testisp_lookup", return_value={"isp": {"flag": "isp"}}), \
             mock.patch.object(lite_manager, "probe_tunnel_quality", side_effect=probe), \
             mock.patch.object(lite_manager, "_dial_side_effects", side_effect=side_effects), \
             mock.patch.object(proxy_server, "clear_dns_cache"), \
             mock.patch.object(lite_manager.time, "sleep"):
            lite_manager.connect_node(tun, node, 13, token=1)

        self.assertEqual(events, ["popen", "setup", "probe"])
        self.assertTrue(all(lock_attempts))
        self.assertTrue(tun.ready)
        self.assertTrue(tun.io_lock.acquire(blocking=False))
        tun.io_lock.release()

    def test_egress_publish_cancellation_discards_exited_owned_process(self):
        tun = lite_manager.tun_backup
        tun.is_connecting = True
        tun.entry_ip = "5.5.5.5"
        tun.slot_owner = (91, 1)
        tun.connect_token = 1
        node = make_node("5.5.5.5", config="client\nremote 5.5.5.5 1194\n")
        process = FakeProcess()
        lite_manager.config_generation = 91
        policy_checked = threading.Event()
        allow_cancel = threading.Event()
        original_matches_policy = lite_manager._dial_matches_policy
        policy_calls = []

        def pause_before_publish(tun_ref, generation, token, process_ref, node_ref=None):
            policy_calls.append(process_ref)
            result = original_matches_policy(tun_ref, generation, token, process_ref, node_ref)
            if len(policy_calls) == 4:
                policy_checked.set()
                allow_cancel.wait(2)
            return result

        dial_thread = threading.Thread(
            target=lite_manager.connect_node,
            args=(tun, node, 91, 1, "JP", "backup"),
            daemon=True,
        )
        with mock.patch.object(lite_manager, "_dial_matches_policy", side_effect=pause_before_publish), \
             mock.patch.object(lite_manager.subprocess, "Popen", side_effect=self.fake_popen(process)), \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "8.8.8.8")), \
             mock.patch.object(lite_manager, "setup_routing"), \
             mock.patch.object(lite_manager, "_testisp_lookup", return_value={"isp": {"flag": "isp"}}), \
             mock.patch.object(lite_manager, "probe_tunnel_quality", return_value=lite_manager.TunnelQuality(100, 5000)), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(proxy_server, "clear_dns_cache"), \
             mock.patch.object(lite_manager.time, "sleep"):
            dial_thread.start()
            self.assertTrue(policy_checked.wait(2))
            with lite_manager.state_lock:
                tun.dial_token += 1
            allow_cancel.set()
            dial_thread.join(2)

        self.assertFalse(dial_thread.is_alive())
        self.assertTrue(process.terminated)
        self.assertIsNone(tun.process)
        self.assertFalse(tun.is_connecting)
        self.assertEqual(tun.entry_ip, "")
        self.assertEqual(tun.egress_ip, "")
        cleanup.assert_called_once_with("tun_backup", 20102, 30102, 31102)

    def test_egress_publish_cancellation_cleans_ended_owned_process_with_routing(self):
        tun = lite_manager.tun_backup
        tun.is_connecting = True
        tun.entry_ip = "5.5.5.5"
        tun.slot_owner = (92, 1)
        tun.connect_token = 1
        node = make_node("5.5.5.5", config="client\nremote 5.5.5.5 1194\n")
        process = FakeProcess()
        process._kui_routing_installed = True
        lite_manager.config_generation = 92
        original_side_effects = lite_manager._dial_side_effects
        cancel_on_publish = []

        def cancel_after_publish_check(
            tun_ref,
            generation,
            token,
            process_ref=None,
            expected_country=None,
            expected_role=None,
        ):
            lock = original_side_effects(
                tun_ref,
                generation,
                token,
                process_ref,
                expected_country=expected_country,
                expected_role=expected_role,
            )
            if process_ref is not None and lock is not None:
                process_ref.alive = False
                with lite_manager.state_lock:
                    tun_ref.dial_token += 1
                process_ref._kui_routing_installed = True
                cancel_on_publish.append(True)
            return lock

        with mock.patch.object(lite_manager, "_dial_side_effects", side_effect=cancel_after_publish_check), \
             mock.patch.object(lite_manager.subprocess, "Popen", side_effect=self.fake_popen(process)), \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, "8.8.8.8")), \
             mock.patch.object(lite_manager, "setup_routing"), \
             mock.patch.object(lite_manager, "_testisp_lookup", return_value={"isp": {"flag": "isp"}}), \
             mock.patch.object(lite_manager, "probe_tunnel_quality", return_value=lite_manager.TunnelQuality(100, 5000)), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(proxy_server, "clear_dns_cache"), \
             mock.patch.object(lite_manager.time, "sleep"):
            lite_manager.connect_node(tun, node, 92, 1, "JP", "backup")

        self.assertEqual(cancel_on_publish, [True])
        self.assertTrue(process.terminated)
        self.assertIsNone(tun.process)
        self.assertFalse(tun.is_connecting)
        self.assertEqual(tun.entry_ip, "")
        self.assertEqual(tun.egress_ip, "")
        cleanup.assert_called_once_with("tun_backup", 20102, 30102, 31102)


class HeartbeatTests(LiteManagerTestBase):
    def test_details_include_ready_and_quality_fields(self):
        process = FakeProcess()
        tun = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=process,
            country="JP",
            entry_ip="1.1.1.1",
            egress_ip="9.9.9.1",
            connected_at=time.time() - 10,
            ttfb_ms=123,
            speed_kbps=456,
        )
        lite_manager.tun_main = tun
        lite_manager.tun_backup = make_tunnel("tun_backup", 20102)
        proxy_server.ACTIVE_BIND = "tun_main"

        class FakeRealtime:
            connected = False
            enabled = False
            ever_connected = False
            last_disconnected = 0
            started_at = 0

            def send(self, status, message_type="status"):
                return False

        lite_manager.realtime_channel = FakeRealtime()
        submitted = []
        fake_heartbeat = RecordingEvent(raise_on_wait=True)
        with mock.patch.object(lite_manager, "heartbeat_wakeup", fake_heartbeat), \
             mock.patch.object(lite_manager, "get_recent_logs", return_value=""), \
             mock.patch.object(lite_manager, "submit_http_report", side_effect=lambda status, background=False: submitted.append(status) or True):
            with self.assertRaises(StopLoop):
                lite_manager.c2_heartbeat_loop()

        self.assertEqual(len(submitted), 1)
        detail = submitted[0]["details"][0]
        self.assertTrue(detail["ready"])
        self.assertEqual(detail["ttfb_ms"], 123)
        self.assertEqual(detail["speed_kbps"], 456)
        self.assertEqual(detail["node_ip"], "9.9.9.1")
        self.assertEqual(detail["exit_ip"], "9.9.9.1")


class HealthCheckTests(LiteManagerTestBase):
    def test_three_failed_probes_terminate_cleanup_and_wake_loops(self):
        process = FakeProcess()
        tunnel = make_tunnel(
            "tun_main",
            20101,
            ready=True,
            process=process,
            country="JP",
            entry_ip="1.1.1.1",
            egress_ip="9.9.9.1",
            connected_at=time.time() - 30,
        )
        lite_manager.tun_main = tunnel
        lite_manager.tun_backup = make_tunnel("tun_backup", 20102)
        sleeps = []
        fake_pool = RecordingEvent()
        fake_heartbeat = RecordingEvent()

        def fake_sleep(seconds):
            sleeps.append(seconds)
            if len(sleeps) >= 4:
                raise StopLoop()

        with mock.patch.object(lite_manager.time, "sleep", side_effect=fake_sleep), \
             mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(1, "")), \
             mock.patch.object(lite_manager, "_cleanup_tunnel_routing") as cleanup, \
             mock.patch.object(lite_manager, "pool_wakeup", fake_pool), \
             mock.patch.object(lite_manager, "heartbeat_wakeup", fake_heartbeat), \
             mock.patch.object(proxy_server, "clear_dns_cache") as clear_dns:
            with self.assertRaises(StopLoop):
                lite_manager.health_check_loop()

        self.assertTrue(process.terminated)
        self.assertFalse(tunnel.ready)
        self.assertIsNone(tunnel.process)
        self.assertEqual(tunnel.entry_ip, "")
        self.assertTrue(lite_manager._is_dead_ip("1.1.1.1"))
        cleanup.assert_any_call("tun_main", 20101, 30101, 31101)
        clear_dns.assert_any_call("tun_main")
        self.assertGreaterEqual(fake_pool.set_calls, 1)
        self.assertGreaterEqual(fake_heartbeat.set_calls, 1)


class DeadIpLockTests(LiteManagerTestBase):
    def test_helpers_are_thread_safe(self):
        errors = []
        barrier = threading.Barrier(8)

        def worker(offset):
            try:
                barrier.wait(timeout=2)
                for index in range(100):
                    ip = "198.51.100.%d" % ((offset * 100 + index) % 250)
                    lite_manager._mark_dead_ip(ip)
                    lite_manager._is_dead_ip(ip)
                    lite_manager._dead_ips_count()
                if offset == 0:
                    lite_manager._clear_dead_ips()
            except Exception as error:
                errors.append(error)

        threads = [threading.Thread(target=worker, args=(index,), daemon=True) for index in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(5)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(errors, [])
        self.assertGreaterEqual(lite_manager._dead_ips_count(), 0)

    def test_only_leaf_helpers_touch_dead_ips_directly(self):
        source = (ROOT / "static" / "vps" / "lite_manager.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        allowed = {"_is_dead_ip", "_mark_dead_ip", "_clear_dead_ips", "_dead_ips_count"}
        offenders = []

        class Visitor(ast.NodeVisitor):
            def __init__(self):
                self.function = None

            def visit_FunctionDef(self, node):
                previous = self.function
                self.function = node.name
                self.generic_visit(node)
                self.function = previous

            def visit_Name(self, node):
                if node.id == "dead_ips" and self.function is not None and self.function not in allowed:
                    offenders.append((self.function, node.lineno))
                self.generic_visit(node)

        Visitor().visit(tree)
        self.assertEqual(offenders, [])


class PuritySelectionTests(LiteManagerTestBase):
    def test_ipok_batch_prescreen_caches_and_scores_clean_residential_above_proxy(self):
        clean = make_node("61.46.101.187", speed=200_000_000, sessions=30, ping=15)
        proxy_node = make_node("219.100.37.49", speed=900_000_000, sessions=30, ping=15)
        with lite_manager.reservoir_lock:
            lite_manager.global_node_reservoir[clean["ip"]] = clean
            lite_manager.global_node_reservoir[proxy_node["ip"]] = proxy_node
        payload = json.dumps({
            "results": [
                {
                    "ip": clean["ip"],
                    "ok": True,
                    "type": "residential",
                    "risk": 8,
                    "hosting": False,
                    "proxy": False,
                    "vpn": False,
                    "tor": False,
                    "abuse": False,
                    "asn": "AS9617",
                    "isp": "JCOM",
                },
                {
                    "ip": proxy_node["ip"],
                    "ok": True,
                    "type": "residential",
                    "risk": 50,
                    "hosting": False,
                    "proxy": True,
                    "vpn": False,
                    "tor": False,
                    "abuse": False,
                    "asn": "AS36599",
                    "isp": "SoftEther",
                },
            ]
        }).encode("utf-8")

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return payload

        with mock.patch.object(lite_manager, "_urlopen", return_value=FakeResponse()) as urlopen_mock:
            first_updated = lite_manager.prescreen_candidates_ipok([clean, proxy_node])
            second_updated = lite_manager.prescreen_candidates_ipok([clean, proxy_node])

        self.assertEqual(first_updated, 2)
        self.assertEqual(second_updated, 0)
        self.assertEqual(urlopen_mock.call_count, 1)
        self.assertGreater(
            lite_manager.compute_candidate_score(clean, include_measured=False),
            lite_manager.compute_candidate_score(proxy_node, include_measured=False),
        )

    def test_ipok_batch_prescreen_failure_sets_cooldown_and_degrades(self):
        candidate = make_node("61.46.101.187")
        with mock.patch.object(lite_manager, "_urlopen", side_effect=OSError("network down")) as urlopen_mock:
            first = lite_manager.prescreen_candidates_ipok([candidate])
            second = lite_manager.prescreen_candidates_ipok([candidate])
        self.assertEqual(first, 0)
        self.assertEqual(second, 0)
        self.assertEqual(urlopen_mock.call_count, 1)

    def test_evaluate_egress_purity_accepts_clean_ippure_and_ipok(self):
        ippure_data = {
            "ip": "111.111.20.245",
            "country": "JP",
            "asn_org": "KDDI CORPORATION",
            "is_residential": True,
            "is_native": True,
            "fraud_score": 3,
            "purity_source": "ippure",
        }
        ipok_json = json.dumps({
            "geo": {"ip": "111.111.20.245", "isp": "Kddi Corporation"},
            "ipType": "residential",
            "nativeType": "unknown",
            "risk": 3,
            "riskAssessment": {"scoreAvailable": True},
            "signals": [],
        })
        with mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, ipok_json)):
            purity, accepted, reason = lite_manager._evaluate_egress_purity(
                "tun_main",
                "111.111.20.245",
                ippure_data=ippure_data,
            )
        self.assertTrue(accepted)
        self.assertEqual(reason, "")
        self.assertEqual(purity["is_residential"], True)
        self.assertEqual(purity["is_native"], True)
        self.assertEqual(purity["fraud_score"], 3)
        self.assertEqual(purity["ipok_risk"], 3)
        self.assertEqual(purity["purity_source"], "ippure+ipok")

    def test_evaluate_egress_purity_rejects_non_residential_high_risk_and_high_fraud(self):
        softether = {
            "ip": "219.100.37.240",
            "asn_org": "SoftEther Corporation",
            "is_residential": False,
            "is_native": True,
            "fraud_score": 77,
            "purity_source": "ippure",
        }
        with mock.patch.object(lite_manager, "_probe_tunnel_ipok") as ipok_mock:
            purity, accepted, reason = lite_manager._evaluate_egress_purity(
                "tun_backup",
                "219.100.37.240",
                ippure_data=softether,
            )
        self.assertFalse(accepted)
        self.assertIn("非住宅", reason)
        self.assertEqual(purity["fraud_score"], 77)
        ipok_mock.assert_not_called()

        high_fraud = {
            "ip": "198.51.100.77",
            "is_residential": True,
            "is_native": True,
            "fraud_score": 90,
            "purity_source": "ippure",
        }
        _, accepted_fraud, reason_fraud = lite_manager._evaluate_egress_purity(
            "tun_backup",
            "198.51.100.77",
            ippure_data=high_fraud,
        )
        self.assertFalse(accepted_fraud)
        self.assertIn("fraudScore=90", reason_fraud)

    def test_evaluate_egress_purity_rejects_ipok_blocklisted_or_high_risk(self):
        ippure_clean = {
            "ip": "203.0.113.55",
            "is_residential": True,
            "is_native": True,
            "fraud_score": 20,
            "purity_source": "ippure",
        }
        ipok_flagged = json.dumps({
            "geo": {"ip": "203.0.113.55", "isp": "Example ISP"},
            "ipType": "residential",
            "nativeType": "native",
            "risk": 72,
            "riskAssessment": {"scoreAvailable": True},
            "signals": ["blocklisted", "abuser"],
        })
        with mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(0, ipok_flagged)):
            purity, accepted, reason = lite_manager._evaluate_egress_purity(
                "tun_backup",
                "203.0.113.55",
                ippure_data=ippure_clean,
            )
        self.assertFalse(accepted)
        self.assertIn("abuser", reason)
        self.assertEqual(purity["ipok_risk"], 72)

    def test_evaluate_egress_purity_falls_back_to_testisp_when_ippure_and_ipok_fail(self):
        with mock.patch.object(lite_manager.subprocess, "run", return_value=Completed(1, "")), \
             mock.patch.object(
                 lite_manager,
                 "_testisp_lookup",
                 return_value={"isp": {"flag": "hosting", "type": "datacenter", "warning": "hosting"}, "geo": {"is_native": False}},
             ):
            purity, accepted, reason = lite_manager._evaluate_egress_purity("tun_main", "203.0.113.99")
        self.assertFalse(accepted)
        self.assertIn("testisp.info", reason)
        self.assertEqual(purity["is_residential"], False)

    def test_should_promote_backup_prefers_higher_purity_and_blocks_purity_regression(self):
        main = make_tunnel("tun_main", 20101, ready=True, process=FakeProcess(), country="JP", connected_at=500, speed_kbps=2000, ttfb_ms=150)
        backup = make_tunnel("tun_backup", 20102, ready=True, process=FakeProcess(), country="JP", connected_at=900, speed_kbps=1600, ttfb_ms=180)
        lite_manager._apply_tunnel_purity(
            main,
            {"is_residential": True, "is_native": False, "fraud_score": 55, "ipok_risk": 50},
        )
        lite_manager._apply_tunnel_purity(
            backup,
            {"is_residential": True, "is_native": True, "fraud_score": 5, "ipok_risk": 5},
        )
        self.assertTrue(lite_manager.should_promote_backup(main, backup, now=1000, cooldown=60))

        fast_dirty_backup = make_tunnel("tun_backup", 20102, ready=True, process=FakeProcess(), country="JP", connected_at=900, speed_kbps=8000, ttfb_ms=80)
        lite_manager._apply_tunnel_purity(
            main,
            {"is_residential": True, "is_native": True, "fraud_score": 3, "ipok_risk": 3},
        )
        lite_manager._apply_tunnel_purity(
            fast_dirty_backup,
            {"is_residential": True, "is_native": False, "fraud_score": 60, "ipok_risk": 55},
        )
        self.assertFalse(lite_manager.should_promote_backup(main, fast_dirty_backup, now=1000, cooldown=60))

    def test_heartbeat_includes_optional_purity_fields_and_reset_clears_them(self):
        tun = make_tunnel("tun_main", 20101, ready=True, process=FakeProcess(), country="JP", connected_at=time.time() - 30, speed_kbps=3200, ttfb_ms=110)
        tun.egress_ip = "111.111.20.245"
        lite_manager._apply_tunnel_purity(
            tun,
            {
                "is_residential": True,
                "is_native": True,
                "fraud_score": 3,
                "ipok_risk": 5,
                "purity_source": "ippure+ipok",
                "asn_org": "KDDI CORPORATION",
            },
        )
        lite_manager.tun_main = tun
        lite_manager.tun_backup = make_tunnel("tun_backup", 20102, ready=False)
        captured = []
        with mock.patch.object(lite_manager, "submit_http_report", side_effect=lambda payload, **kwargs: captured.append(payload)), \
             mock.patch.object(lite_manager.heartbeat_wakeup, "wait", side_effect=StopLoop):
            with self.assertRaises(StopLoop):
                lite_manager.c2_heartbeat_loop()
        self.assertEqual(len(captured), 1)
        detail = captured[0]["details"][0]
        self.assertEqual(detail["is_residential"], True)
        self.assertEqual(detail["is_native"], True)
        self.assertEqual(detail["fraud_score"], 3)
        self.assertEqual(detail["ipok_risk"], 5)
        self.assertEqual(detail["purity_source"], "ippure+ipok")
        self.assertEqual(detail["asn_org"], "KDDI CORPORATION")

        lite_manager._reset_tunnel_state(tun)
        self.assertIsNone(lite_manager._tunnel_purity_record(tun))


if __name__ == "__main__":
    unittest.main()
