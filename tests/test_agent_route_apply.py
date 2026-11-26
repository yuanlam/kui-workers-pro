import ast
import hashlib
import json
import os
import time
import unittest
from pathlib import Path
from unittest.mock import Mock


class AgentRouteApplyTests(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / 'static/vps/agent.py'
        function = next(item for item in ast.parse(source.read_text()).body if getattr(item, 'name', '') == 'fetch_and_apply_configs')
        self.native = {'mode': 'native', 'ip_stack': 'dual'}
        self.residential = {'mode': 'residential', 'ip_stack': 'ipv4_only'}
        self.packet = {'success': True, 'configs': [], 'deployment_id': 'test', 'egress': {
            'desired_config': self.residential, 'applied_config': self.native, 'revision': 8, 'applied_revision': 7,
        }, 'residential_outbound': {'available': True}, 'ruleset_mirror_prefix': 'https://mirror.example/net'}
        self.state = {'deployment_id': 'test', 'applied_mode': 'native', 'applied_revision': 7, 'applied_config': self.native}
        self.build = Mock(return_value={'egress_ip': '192.0.2.1', 'index': ['fixture'], 'rule_set_paths': {}, 'clash_api_secret': 'fixture', 'proxy_inbounds': [], 'previous_config': 'original', 'replaced': True, 'active_certs': []})
        self.scope = {'API_URL': 'https://panel.example/api/config', 'VPS_IP': '192.0.2.2', 'json': json, 'hashlib': hashlib,
                      'os': os, 'time': time, 'realtime_channel': None, 'REALTIME_URL': '', 'route_monitor': Mock(),
                      '_controller_json_request': Mock(return_value=self.packet), 'persist_agent_token': Mock(),
                      '_normalize_egress_config': lambda value, *unused: value, '_load_egress_state': lambda: self.state,
                      '_strip_stale_residential_inbound': Mock(), 'prepare_mtproxy_nodes': Mock(), 'sync_mtproxy_nodes': Mock(),
                      '_clean_unused_certificates': Mock(), '_archive_legacy_profiles': Mock(), '_rollback_singbox_apply': Mock(return_value=True),
                      'build_singbox_config': self.build, '_deliver_egress_result': Mock(return_value={'accepted': True}),
                      '_save_egress_state': Mock(), '_singbox_service_healthy': lambda: True, '_schedule_egress_retry': Mock()}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), self.scope)

    def test_published_index_uses_the_verified_revision_and_deployed_rules(self):
        self.assertEqual(self.scope['fetch_and_apply_configs'](), [])
        self.build.assert_called_once_with([], self.residential, residential={'available': True}, proxy_cfg={}, mirror_prefix='https://mirror.example/net')
        self.scope['route_monitor'].update.assert_called_once_with(index=['fixture'], revision=8, proxy_inbounds=[], rule_set_paths={}, secret='fixture')
        self.assertTrue(self.scope['_deliver_egress_result'].call_args.args[0]['success'])
        self.scope['_clean_unused_certificates'].assert_called_once_with([])
        self.scope['_archive_legacy_profiles'].assert_called_once_with()

    def test_apply_failure_retains_the_previous_revision_and_index(self):
        self.build.side_effect = RuntimeError('rule set unavailable')
        self.assertIsNone(self.scope['fetch_and_apply_configs']())
        self.scope['route_monitor'].update.assert_not_called()
        saved = self.scope['_save_egress_state'].call_args.args
        self.assertEqual(saved[:2], ('native', 7))
        self.assertEqual(saved[2]['revision'], 8)
        self.assertFalse(saved[2]['success'])
        self.scope['_schedule_egress_retry'].assert_called_once()

    def test_index_failure_rolls_back_before_acknowledgement(self):
        self.scope['route_monitor'].update.side_effect = RuntimeError('invalid route index')
        self.assertIsNone(self.scope['fetch_and_apply_configs']())
        self.scope['_rollback_singbox_apply'].assert_called_once_with('original', True)
        self.scope['_deliver_egress_result'].assert_called_once()
        self.assertFalse(self.scope['_deliver_egress_result'].call_args.args[0]['success'])

    def test_persistence_failure_restores_monitor_and_exact_deployment(self):
        for original, replaced, healthy in [(None, True, False), ('same configuration', False, True)]:
            with self.subTest(original=original, replaced=replaced):
                self.build.return_value.update(previous_config=original, replaced=replaced)
                self.scope['_rollback_singbox_apply'].return_value = healthy
                self.scope['_save_egress_state'].side_effect = OSError('write failed')
                self.scope['route_monitor'].update.return_value = {'revision': 7, 'index': ['previous']}
                self.assertIsNone(self.scope['fetch_and_apply_configs']())
                self.scope['_rollback_singbox_apply'].assert_called_with(original, replaced)
                restored = self.scope['route_monitor'].update.call_args.kwargs
                self.assertEqual(restored['revision'], 7 if healthy else 0)
                self.assertEqual(restored['index'], ['previous'] if healthy else [])
                self.assertEqual(self.scope['_deliver_egress_result'].call_args.args[0]['rollback_healthy'], healthy)
                self.scope['_clean_unused_certificates'].assert_not_called()
                self.scope['_archive_legacy_profiles'].assert_not_called()

    def test_cleanup_failures_do_not_block_successful_apply_or_ack(self):
        self.scope['_clean_unused_certificates'].side_effect = OSError('certificate cleanup failed')
        self.scope['_archive_legacy_profiles'].side_effect = OSError('archive failed')
        self.assertEqual(self.scope['fetch_and_apply_configs'](), [])
        self.assertTrue(self.scope['_deliver_egress_result'].call_args.args[0]['success'])

    def test_failed_restore_reports_unhealthy_even_if_a_process_is_running(self):
        error = RuntimeError('previous configuration could not restart')
        error.rollback_healthy = False
        self.build.side_effect = error
        self.assertIsNone(self.scope['fetch_and_apply_configs']())
        result = self.scope['_deliver_egress_result'].call_args.args[0]
        self.assertFalse(result['rollback_healthy'])
        self.assertFalse(result['rolled_back'])
