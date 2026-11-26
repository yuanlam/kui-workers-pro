import ast
import ipaddress
import json
import pathlib
import tempfile
import unittest
from unittest import mock


SOURCE_PATH = pathlib.Path(__file__).parents[1] / "static" / "vps" / "agent.py"
SOURCE = SOURCE_PATH.read_text(encoding="utf-8")
TREE = ast.parse(SOURCE)
FUNCTION_NAMES = {"normalize_check_host", "normalize_proxy_custom_domains", "_normalize_egress_config", "_runtime_egress_args", "_warp_candidate_endpoints", "_rank_warp_candidates", "_normalize_warp_optimizer_policy", "_select_warp_exit_ip", "_proxy_lite_owns_listener", "_safe_residential_rollback", "_write_private_text", "_config_has_residential_loop", "_strip_stale_residential_inbound", "_restore_singbox_config"}
SELECTED = [node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name in FUNCTION_NAMES]
NAMESPACE = {"os": __import__("os"), "ipaddress": ipaddress, "json": json, "re": __import__("re"), "random": __import__("random"), "EGRESS_MODES": {"native", "residential", "socks5", "warp_ipv4", "warp_ipv6", "warp_dual"}, "PROXY_CATEGORIES": {"youtube", "ai", "google", "streaming", "custom"}}
exec(compile(ast.Module(body=SELECTED, type_ignores=[]), str(SOURCE_PATH), "exec"), NAMESPACE)


class AgentEgressTests(unittest.TestCase):
    def test_restore_starts_singbox_with_old_proxy_lite_listener_removed(self):
        config = json.dumps({"inbounds": [{"type": "socks", "tag": "residential-socks5"}, {"type": "socks", "tag": "in-1"}]})
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "config.json"
            process = mock.Mock()
            process.run.return_value.returncode = 0
            with mock.patch.dict(NAMESPACE, {"SINGBOX_CONF_PATH": str(path), "subprocess": process, "_singbox_service_healthy": lambda: True}), mock.patch("os.path.exists", side_effect=lambda value: value == "/etc/proxy-lite/env"):
                self.assertTrue(NAMESPACE["_restore_singbox_config"](config))
            self.assertEqual(json.loads(path.read_text())["inbounds"], [{"type": "socks", "tag": "in-1"}])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            process.run.assert_called_once()

    def test_rollback_removes_stale_residential_listener_when_proxy_lite_owns_it(self):
        config = json.dumps({"inbounds": [{"type": "socks", "tag": "residential-socks5"}, {"tag": "in-1"}]})
        safe = NAMESPACE["_safe_residential_rollback"]
        self.assertEqual(json.loads(safe(config, True))["inbounds"], [{"tag": "in-1"}])
        self.assertEqual(safe(config, False), config)

    def test_proxy_lite_listener_is_reserved_during_install_and_residential_egress(self):
        owns = NAMESPACE["_proxy_lite_owns_listener"]
        with mock.patch("os.path.exists", side_effect=lambda path: path == "/etc/proxy-lite/env"):
            self.assertTrue(owns(7920, {}))
        with mock.patch("os.path.exists", return_value=False):
            self.assertTrue(owns(7920, {"enabled": True, "source": "residential", "port": 7920}))
            self.assertFalse(owns(7920, {"enabled": True, "source": "manual", "port": 1080}))
            self.assertFalse(owns(7920, {"enabled": True, "source": "residential", "port": 1080}))

    def test_restore_strips_self_loop_even_without_proxy_lite_env_marker(self):
        loop_config = json.dumps({
            "inbounds": [
                {"type": "socks", "tag": "residential-socks5", "listen_port": 7920},
                {"type": "shadowsocks", "tag": "in-1", "listen_port": 8443},
            ],
            "outbounds": [
                {"type": "socks", "tag": "socks5-outbound", "server": "127.0.0.1", "server_port": 7920},
            ],
        })
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "config.json"
            process = mock.Mock()
            process.run.return_value.returncode = 0
            with mock.patch.dict(NAMESPACE, {"SINGBOX_CONF_PATH": str(path), "subprocess": process, "_singbox_service_healthy": lambda: True}), \
                    mock.patch("os.path.exists", return_value=False):
                self.assertTrue(NAMESPACE["_restore_singbox_config"](loop_config))
            restored = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(restored["inbounds"], [{"type": "shadowsocks", "tag": "in-1", "listen_port": 8443}])
            self.assertEqual(restored["outbounds"], [{"type": "socks", "tag": "socks5-outbound", "server": "127.0.0.1", "server_port": 7920}])

    def test_restore_preserves_manual_external_socks5_without_proxy_lite_env(self):
        manual_config = json.dumps({
            "inbounds": [
                {"type": "socks", "tag": "residential-socks5", "listen_port": 7920},
                {"type": "shadowsocks", "tag": "in-1", "listen_port": 8443},
            ],
            "outbounds": [
                {"type": "socks", "tag": "socks5-outbound", "server": "203.0.113.10", "server_port": 7920},
            ],
        })
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "config.json"
            process = mock.Mock()
            process.run.return_value.returncode = 0
            with mock.patch.dict(NAMESPACE, {"SINGBOX_CONF_PATH": str(path), "subprocess": process, "_singbox_service_healthy": lambda: True}), \
                    mock.patch("os.path.exists", return_value=False):
                self.assertTrue(NAMESPACE["_restore_singbox_config"](manual_config))
            restored = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(len(restored["inbounds"]), 2)

    def test_strip_stale_residential_inbound_runs_before_availability_gate_and_restarts_singbox(self):
        stale_config = json.dumps({
            "inbounds": [
                {"type": "socks", "tag": "residential-socks5", "listen_port": 7920},
                {"type": "shadowsocks", "tag": "in-1", "listen_port": 8443},
            ],
            "outbounds": [{"type": "socks", "tag": "socks5-outbound", "server": "127.0.0.1", "server_port": 7920}],
        })
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "config.json"
            path.write_text(stale_config, encoding="utf-8")
            process = mock.Mock()
            process.run.return_value.returncode = 0
            restart_calls = []
            with mock.patch.dict(NAMESPACE, {
                "SINGBOX_CONF_PATH": str(path),
                "subprocess": process,
                "_restart_singbox": lambda: restart_calls.append(True) or True,
            }):
                self.assertTrue(NAMESPACE["_strip_stale_residential_inbound"](True))
            updated = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(updated["inbounds"], [{"type": "shadowsocks", "tag": "in-1", "listen_port": 8443}])
            self.assertEqual(len(restart_calls), 1)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertFalse((path.parent / "config.json.strip-res-pending").exists())

        gate_pos = SOURCE.index('if runtime_egress == "residential" and not residential.get("available"):')
        sync_block_start = SOURCE.rfind("try:", 0, gate_pos)
        strip_pos = SOURCE.index("_strip_stale_residential_inbound(", sync_block_start, gate_pos)
        self.assertLess(strip_pos, gate_pos)
        self.assertNotIn("SINGBOX_CONF_PATH + \".warp-rollback\"", SOURCE)

    def test_strip_stale_residential_inbound_retries_restart_after_initial_restart_failure(self):
        stale_config = json.dumps({
            "inbounds": [
                {"type": "socks", "tag": "residential-socks5", "listen_port": 7920},
                {"type": "shadowsocks", "tag": "in-1", "listen_port": 8443},
            ],
            "outbounds": [{"type": "socks", "tag": "socks5-outbound", "server": "127.0.0.1", "server_port": 7920}],
        })
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "config.json"
            pending = pathlib.Path(directory) / "config.json.strip-res-pending"
            path.write_text(stale_config, encoding="utf-8")
            process = mock.Mock()
            process.run.return_value.returncode = 0
            restart_results = [False, True]
            restart_calls = []

            def fake_restart():
                restart_calls.append(True)
                return restart_results.pop(0)

            with mock.patch.dict(NAMESPACE, {
                "SINGBOX_CONF_PATH": str(path),
                "subprocess": process,
                "_restart_singbox": fake_restart,
            }):
                self.assertFalse(NAMESPACE["_strip_stale_residential_inbound"](True))
                self.assertTrue(pending.exists())
                self.assertTrue(NAMESPACE["_strip_stale_residential_inbound"](True))
                self.assertFalse(pending.exists())
                self.assertFalse(NAMESPACE["_strip_stale_residential_inbound"](True))

            self.assertEqual(len(restart_calls), 2)

    def test_strip_stale_residential_inbound_leaves_config_untouched_if_pending_marker_write_fails(self):
        stale_config = json.dumps({
            "inbounds": [
                {"type": "socks", "tag": "residential-socks5", "listen_port": 7920},
                {"type": "shadowsocks", "tag": "in-1", "listen_port": 8443},
            ],
            "outbounds": [{"type": "socks", "tag": "socks5-outbound", "server": "127.0.0.1", "server_port": 7920}],
        })
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "config.json"
            pending = pathlib.Path(directory) / "config.json.strip-res-pending"
            path.write_text(stale_config, encoding="utf-8")
            process = mock.Mock()
            process.run.return_value.returncode = 0
            real_write = NAMESPACE["_write_private_text"]
            fail_pending = {"active": True}
            restart_calls = []

            def flaky_write(target, content):
                if target == str(pending) and fail_pending["active"]:
                    raise OSError("disk full")
                return real_write(target, content)

            with mock.patch.dict(NAMESPACE, {
                "SINGBOX_CONF_PATH": str(path),
                "subprocess": process,
                "_write_private_text": flaky_write,
                "_restart_singbox": lambda: restart_calls.append(True) or True,
            }):
                self.assertFalse(NAMESPACE["_strip_stale_residential_inbound"](True))
                self.assertEqual(path.read_text(encoding="utf-8"), stale_config)
                self.assertEqual(restart_calls, [])
                fail_pending["active"] = False
                self.assertTrue(NAMESPACE["_strip_stale_residential_inbound"](True))

            self.assertEqual(len(restart_calls), 1)
            self.assertFalse(pending.exists())

    def test_new_deployment_identity_is_persisted_immediately(self):
        deployment_branch = SOURCE[
            SOURCE.index("if deployment_changed:"):
            SOURCE.index("elif not deployment_id", SOURCE.index("if deployment_changed:"))
        ]
        self.assertIn("_save_egress_state", deployment_branch)
        self.assertIn("deployment_id=deployment_id", deployment_branch)

    def test_dual_stack_verification_reports_the_preferred_ipv4_exit(self):
        select = NAMESPACE["_select_warp_exit_ip"]
        exits = {"ipv4": "104.28.1.1", "ipv6": "2606:4700:100::1"}
        self.assertEqual(select("dual", exits), "104.28.1.1")
        self.assertEqual(select("ipv4", exits), "104.28.1.1")
        self.assertEqual(select("ipv6", exits), "2606:4700:100::1")

    def test_warp_candidates_keep_current_endpoint_and_are_bounded(self):
        profile = {"peer_address": "162.159.192.1", "peer_port": 2408}
        candidates = NAMESPACE["_warp_candidate_endpoints"](profile, ["162.159.192.2", "2606:4700:d0::a29f:c001"], seed=7, limit=24)
        self.assertEqual(candidates[0], {"address": "162.159.192.1", "port": 2408, "current": True})
        self.assertLessEqual(len(candidates), 24)
        self.assertEqual(len({(item["address"], item["port"]) for item in candidates}), len(candidates))
        self.assertTrue(all(1 <= item["port"] <= 65535 for item in candidates))
        self.assertIn(1701, {item["port"] for item in candidates})
        self.assertGreaterEqual(len({item["address"] for item in candidates}), 10)

    def test_warp_ranking_prefers_valid_low_loss_candidates(self):
        results = [
            {"address": "162.159.192.1", "port": 2408, "success": True, "loss_pct": 20, "latency_ms": 12},
            {"address": "162.159.192.2", "port": 2408, "success": True, "loss_pct": 0, "latency_ms": 45},
            {"address": "162.159.192.3", "port": 2408, "success": False, "loss_pct": 100, "latency_ms": 0},
        ]
        ranked = NAMESPACE["_rank_warp_candidates"](results)
        self.assertEqual(ranked[0]["address"], "162.159.192.2")
        self.assertEqual(ranked[-1]["address"], "162.159.192.3")

    def test_warp_optimizer_policy_is_closed_by_default(self):
        normalize = NAMESPACE["_normalize_warp_optimizer_policy"]
        self.assertEqual(normalize("manual"), "manual")
        self.assertEqual(normalize("on_failure"), "on_failure")
        self.assertEqual(normalize("first_enable"), "first_enable")
        self.assertEqual(normalize("always"), "manual")

    def test_manual_socks5_runtime_uses_the_applied_snapshot(self):
        applied = NAMESPACE["_normalize_egress_config"]({
            "mode": "socks5",
            "proxy_mode": "global",
            "proxy_categories": "",
            "socks5": {"addr": "old.proxy.example", "port": 1080, "user": "old-user", "pass": "old-pass"},
        })
        runtime_socks, runtime_warp = NAMESPACE["_runtime_egress_args"](applied, {}, "127.0.0.1")
        self.assertEqual(runtime_warp, "off")
        self.assertEqual(runtime_socks["addr"], "old.proxy.example")
        self.assertEqual(runtime_socks["user"], "old-user")
        self.assertEqual(runtime_socks["pass"], "old-pass")

    def test_warp_and_socks5_runtime_modes_are_mutually_exclusive(self):
        warp = NAMESPACE["_normalize_egress_config"]({"mode": "warp_dual"})
        runtime_socks, runtime_warp = NAMESPACE["_runtime_egress_args"](warp, {}, "127.0.0.1")
        self.assertEqual(runtime_socks, {})
        self.assertEqual(runtime_warp, "dual")

    def test_selective_categories_are_normalized_before_runtime(self):
        config = NAMESPACE["_normalize_egress_config"]({
            "mode": "residential",
            "proxy_mode": "selective",
            "proxy_categories": "youtube,unknown,ai,youtube,custom",
            "proxy_custom_domains": ["*.Example.COM", "例子.测试"],
        })
        self.assertEqual(config["proxy_categories"], "youtube,ai,custom")
        self.assertEqual(config["proxy_custom_domains"], ["example.com", "xn--fsqu00a.xn--0zwm56d"])
        runtime_socks, _ = NAMESPACE["_runtime_egress_args"](config, {"addr": "172.17.0.1", "port": 7920}, "172.17.0.1")
        self.assertEqual(json.loads(runtime_socks["domains"]), {"categories": ["youtube", "ai", "custom"], "custom_domains": ["example.com", "xn--fsqu00a.xn--0zwm56d"]})

    def test_residential_application_verifies_the_singbox_data_path(self):
        build = ast.get_source_segment(
            SOURCE,
            next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == "build_singbox_config"),
        )
        self.assertNotIn("_verify_residential_exit", build)
        self.assertIn("_verify_socks5_exit(egress_check_host, require_distinct_exit=True)", build)


if __name__ == "__main__":
    unittest.main()
