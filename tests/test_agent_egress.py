import ast
import os
import json
import pathlib
import tempfile
import unittest
from unittest import mock


SOURCE_PATH = pathlib.Path(__file__).parents[1] / "static" / "vps" / "agent.py"
SOURCE = SOURCE_PATH.read_text(encoding="utf-8")
TREE = ast.parse(SOURCE)
FUNCTION_NAMES = {"_load_egress_state", "_proxy_lite_owns_listener", "_residential_listener", "_safe_residential_rollback", "_write_private_text", "_config_has_residential_loop", "_strip_stale_residential_inbound", "_restore_singbox_config"}
SELECTED = [node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name in FUNCTION_NAMES]
NAMESPACE = {"os": os, "json": json}
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

    def test_listener_honors_node_toggle_credentials_and_managed_port(self):
        listener = NAMESPACE["_residential_listener"]
        namespace = {"PROXY_PORT": 7920, "PROXY_USER": "", "PROXY_PASS": "", "VPS_IP": "192.0.2.1", "node_listen_address": lambda ip: ip}
        credentials = {"user": "fixture", "pass": "test-value"}
        with mock.patch.dict(NAMESPACE, namespace), mock.patch("os.path.exists", return_value=False):
            self.assertIsNone(listener({"global": credentials, "toggle": {"enable": False}}, {}))
            self.assertIsNone(listener({"global": {}, "toggle": {"enable": True}}, {}))
            enabled = {"global": credentials, "toggle": {"enabled": True}}
            self.assertEqual(listener(enabled, {})["users"][0]["username"], "fixture")
            self.assertIsNone(listener(enabled, {"available": True, "port": 7920}))
            self.assertIsNone(listener({**credentials, "enabled": False}, {}))

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

    def test_legacy_local_state_retains_revision_and_normalizes_the_applied_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "egress-state.json"
            with mock.patch.dict(NAMESPACE, {"EGRESS_STATE_PATH": str(path)}):
                for legacy in ("warp_ipv4", "warp_ipv6", "warp_dual", "socks5"):
                    with self.subTest(mode=legacy):
                        path.write_text(json.dumps({"applied_mode": legacy, "applied_revision": 8,
                                                    "applied_config": {"mode": legacy}, "deployment_id": "old"}))
                        state = NAMESPACE["_load_egress_state"]()
                        self.assertEqual((state["applied_mode"], state["applied_config"]["mode"]), ("native", "native"))
                        self.assertEqual((state["applied_revision"], state["deployment_id"]), (8, "old"))


if __name__ == "__main__":
    unittest.main()
