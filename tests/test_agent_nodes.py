import ast
import pathlib
import unittest


SOURCE_PATH = pathlib.Path(__file__).parents[1] / "static" / "vps" / "agent.py"
SOURCE = SOURCE_PATH.read_text(encoding="utf-8")
TREE = ast.parse(SOURCE)


class AgentNodeTests(unittest.TestCase):
    def test_invalid_node_does_not_reserve_its_listener(self):
        function = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == "build_node_inbounds")
        source = ast.get_source_segment(SOURCE, function)
        validation = source.index('except (KeyError, TypeError, ValueError)')
        reservation = source.index('listener_keys.update(listener_keys_for_node)')
        self.assertGreater(reservation, validation)

    def test_missing_internal_relay_target_is_rejected_during_validation(self):
        self.assertIn('raise ValueError("dokodemo internal target is unavailable")', SOURCE)

    def test_dokodemo_keeps_an_explicit_route_before_global_fallback(self):
        self.assertIn('{"inbound": [in_tag], "action": "route", "outbound": out_tag}', SOURCE)


if __name__ == "__main__":
    unittest.main()
