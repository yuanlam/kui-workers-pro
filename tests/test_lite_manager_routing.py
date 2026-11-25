import ast
import pathlib
import unittest
from unittest import mock


SOURCE_PATH = pathlib.Path(__file__).parents[1] / "static" / "vps" / "lite_manager.py"
SOURCE = SOURCE_PATH.read_text(encoding="utf-8")
TREE = ast.parse(SOURCE)
NAMES = {"KUI_ROUTE_TABLES", "LEGACY_KUI_ROUTE_TABLES", "UPDATE_READY_WAIT_SECONDS"}
FUNCTIONS = {"_delete_ip_rule", "_cleanup_tunnel_routing", "setup_routing", "run_proxy_server"}
SELECTED = [
    node for node in TREE.body
    if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS
    or isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id in NAMES for target in node.targets)
]


class Result:
    def __init__(self, returncode=0):
        self.returncode = returncode


class FakeSubprocess:
    def __init__(self, fail_on=None):
        self.commands = []
        self.deleted = set()
        self.fail_on = fail_on

    def run(self, command, **kwargs):
        self.commands.append((command, kwargs))
        if self.fail_on and self.fail_on(command):
            raise RuntimeError("simulated ip failure")
        if command[:3] == ["ip", "rule", "del"]:
            key = tuple(command)
            if key not in self.deleted:
                self.deleted.add(key)
                return Result(0)
            return Result(2)
        return Result(0)


def load_namespace(fake):
    namespace = {"subprocess": fake}
    exec(compile(ast.Module(body=SELECTED, type_ignores=[]), str(SOURCE_PATH), "exec"), namespace)
    return namespace


class LiteManagerRoutingTests(unittest.TestCase):
    def test_update_pending_uses_listener_recovery_window(self):
        namespace = load_namespace(FakeSubprocess())
        self.assertEqual(namespace["UPDATE_READY_WAIT_SECONDS"], 180)
        main_node = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == "main")
        wait_calls = [
            node for node in ast.walk(main_node)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "wait"
        ]
        self.assertTrue(
            any(
                any(isinstance(argument, ast.Name) and argument.id == "UPDATE_READY_WAIT_SECONDS" for argument in call.args)
                for call in wait_calls
            )
        )

    def test_failed_listener_is_retried_after_delay(self):
        namespace = load_namespace(FakeSubprocess())
        server = mock.Mock()
        server.start_proxy_server.side_effect = [OSError("address in use"), KeyboardInterrupt()]
        clock = mock.Mock()
        namespace.update(proxy_server=server, time=clock, PROXY_LISTEN_HOST="127.0.0.1", PROXY_PORT=7920)
        with self.assertRaises(KeyboardInterrupt):
            namespace["run_proxy_server"]()
        self.assertEqual(server.start_proxy_server.call_count, 2)
        clock.sleep.assert_called_once()
        self.assertGreater(clock.sleep.call_args.args[0], 0)

    def test_routes_use_dedicated_tables_without_flushing_system_tables(self):
        fake = FakeSubprocess()
        namespace = load_namespace(fake)
        namespace["setup_routing"]("tun_main", namespace["KUI_ROUTE_TABLES"]["tun_main"])
        commands = [command for command, _ in fake.commands]

        self.assertEqual(namespace["KUI_ROUTE_TABLES"], {"tun_main": 20101, "tun_backup": 20102})
        self.assertFalse(any(command[:3] == ["ip", "route", "flush"] for command in commands))
        self.assertFalse(any(command == ["ip", "rule", "del", "pref", "101"] for command in commands))
        self.assertIn(["ip", "route", "del", "default", "dev", "tun_main", "table", "101"], commands)
        self.assertIn(["ip", "route", "replace", "default", "dev", "tun_main", "table", "20101"], commands)
        self.assertIn(["ip", "rule", "add", "pref", "30101", "oif", "tun_main", "lookup", "20101"], commands)
        self.assertIn(["ip", "rule", "add", "pref", "31101", "iif", "tun_main", "lookup", "20101"], commands)

    def test_partial_setup_is_rolled_back(self):
        fake = FakeSubprocess(fail_on=lambda command: command[:3] == ["ip", "rule", "add"] and "iif" in command)
        namespace = load_namespace(fake)

        with self.assertRaises(RuntimeError):
            namespace["setup_routing"]("tun_backup", namespace["KUI_ROUTE_TABLES"]["tun_backup"])

        commands = [command for command, _ in fake.commands]
        self.assertGreaterEqual(commands.count(["ip", "route", "del", "default", "dev", "tun_backup", "table", "20102"]), 2)
        self.assertTrue(any(command[:3] == ["ip", "rule", "del"] and "30102" in command for command in commands))


if __name__ == "__main__":
    unittest.main()
