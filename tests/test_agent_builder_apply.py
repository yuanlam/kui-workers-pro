import ast
import base64
import ipaddress
import json
import os
import pathlib
import re
import secrets
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).parents[1]
SOURCE_PATH = ROOT / "static" / "vps" / "agent.py"
SOURCE = SOURCE_PATH.read_text(encoding="utf-8")
sys.path.insert(0, str(SOURCE_PATH.parent))
from routing_engine import build_routing_policy

TREE = ast.parse(SOURCE)
FUNCTION_NAMES = {
    "_doh_wire_query",
    "_valid_doh_response",
    "_probe_residential_doh",
    "_rollback_singbox_apply",
    "normalize_check_host",
    "normalize_ss2022_network",
    "node_transports",
    "node_listen_address",
    "tune_inbound",
    "tune_outbound",
    "build_node_inbounds",
    "_residential_listener",
    "build_singbox_config",
}
SELECTED = [node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name in FUNCTION_NAMES]
NAMESPACE = {
    "base64": base64,
    "ipaddress": ipaddress,
    "json": json,
    "os": os,
    "re": re,
    "secrets": secrets,
    "struct": __import__("struct"),
    "subprocess": subprocess,
    "build_routing_policy": build_routing_policy,
    "_normalize_egress_config": lambda config, *unused: __import__("routing_engine").normalize_egress_config(config),
    "_write_private_text": lambda path, content: pathlib.Path(path).write_text(content),
}
exec(compile(ast.Module(body=SELECTED, type_ignores=[]), str(SOURCE_PATH), "exec"), NAMESPACE)


class BuildApplyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.directory.name)
        self.config_path = self.root / "config.json"
        self.restarts = []
        self.healthy = True
        self.namespace = {
            "SINGBOX_CONF_PATH": str(self.config_path),
            "PROXY_PORT": 7920,
            "PROXY_USER": "",
            "PROXY_PASS": "",
            "VPS_IP": "192.0.2.2",
            "API_URL": "https://panel.example/api/config",
            "BASE_URL": "https://panel.example",
            "HEADERS": {},
            "node_listen_address": lambda value: "0.0.0.0",
            "build_node_inbounds": lambda nodes, config: (nodes, set()),
            "prepare_rule_sets": lambda directory, mirror_prefix="", tags=None: {tag: str(self.root / (tag + ".json")) for tag in tags or []},
            "ensure_firewall_open": mock.Mock(),
            "_singbox_service_healthy": lambda: self.healthy,
            "_restart_singbox": lambda: self.restarts.append(True) or self.healthy,
            "_verify_socks5_exit": lambda *args, **kwargs: "198.51.100.20",
            "_verify_native_exit": lambda *args, **kwargs: "198.51.100.20",
            "_probe_residential_doh": lambda *args, **kwargs: True,
            "_rollback_singbox_apply": lambda previous, replaced: False,
            "_write_private_text": lambda path, content: pathlib.Path(path).write_text(content, encoding="utf-8"),
        }

    def tearDown(self):
        self.directory.cleanup()

    def build(self, residential=True):
        runtime = {"mode": "residential" if residential else "native", "ip_stack": "dual", "proxy_mode": "global"}
        options = {"available": True, "addr": "203.0.113.10", "port": 1080}
        with mock.patch.dict(NAMESPACE, self.namespace), mock.patch.object(NAMESPACE["subprocess"], "run", return_value=mock.Mock(returncode=0, stdout="", stderr="")):
            return NAMESPACE["build_singbox_config"]([], runtime, residential=options)

    def test_equivalent_config_keeps_secret_and_skips_restart_when_healthy(self):
        first = self.build()
        first_text = self.config_path.read_text(encoding="utf-8")
        self.assertEqual(len(self.restarts), 1)
        second = self.build()
        self.assertEqual(self.config_path.read_text(encoding="utf-8"), first_text)
        self.assertEqual(len(self.restarts), 1)
        self.assertEqual(second["clash_api_secret"], first["clash_api_secret"])
        self.assertFalse(second["replaced"])

    def test_equivalent_config_restarts_stopped_service_and_rechecks_health(self):
        first = self.build()
        self.healthy = False
        self.restarts.clear()
        restart_results = []

        def restart():
            restart_results.append(True)
            self.healthy = True
            return True

        self.namespace["_restart_singbox"] = restart
        second = self.build()
        self.assertEqual(restart_results, [True])
        self.assertEqual(second["clash_api_secret"], first["clash_api_secret"])
        self.assertFalse(second["replaced"])

    def test_equivalent_config_fails_closed_when_restart_cannot_recover(self):
        self.build()
        self.healthy = False
        self.namespace["_restart_singbox"] = lambda: False
        with self.assertRaisesRegex(RuntimeError, "unhealthy"):
            self.build()

    def test_residential_check_listener_is_loopback_only(self):
        built = self.build()
        inbound = next(item for item in built["config"]["inbounds"] if item["tag"] == "egress-check-in")
        self.assertEqual(inbound["listen"], "127.0.0.1")
        self.assertEqual(inbound["listen_port"], 39482)

    def test_normal_proxy_config_does_not_create_an_empty_socks_listener(self):
        options = {"global": {}, "toggle": {"enable": False}}
        self.namespace["_residential_listener_original"] = NAMESPACE["_residential_listener"]
        self.namespace["_residential_listener"] = lambda proxy_cfg, residential: NAMESPACE["_residential_listener_original"](proxy_cfg, residential)
        runtime = {"mode": "native", "ip_stack": "dual", "proxy_mode": "global"}
        with mock.patch.dict(NAMESPACE, self.namespace), mock.patch.object(NAMESPACE["subprocess"], "run", return_value=mock.Mock(returncode=0, stdout="", stderr="")):
            built = NAMESPACE["build_singbox_config"]([], runtime, residential={}, proxy_cfg=options)
        self.assertFalse(any(item.get("tag") == "residential-socks5" for item in built["config"]["inbounds"]))


if __name__ == "__main__":
    unittest.main()
