import ast
import base64
import hashlib
import ipaddress
import json
import os
import pathlib
import subprocess
import struct
import tempfile
import unittest
from unittest import mock


SOURCE_PATH = pathlib.Path(__file__).parents[1] / "static" / "vps" / "agent.py"
SOURCE = SOURCE_PATH.read_text(encoding="utf-8")
TREE = ast.parse(SOURCE)
FUNCTION_NAMES = {
    "_doh_wire_query",
    "_valid_doh_response",
    "_probe_residential_doh",
    "_rollback_singbox_apply",
    "_archive_legacy_profiles",
    "normalize_check_host",
}
SELECTED = [node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name in FUNCTION_NAMES]
NAMESPACE = {"base64": base64, "hashlib": hashlib, "ipaddress": ipaddress, "json": json, "os": os, "struct": struct, "subprocess": subprocess, "tempfile": tempfile}
exec(compile(ast.Module(body=SELECTED, type_ignores=[]), str(SOURCE_PATH), "exec"), NAMESPACE)

GOOD_RESPONSE = bytes.fromhex(
    "abcd81800001000200000000076578616d706c6503636f6d0000010001"
    "c00c000100010000010700046814179ac00c00010001000001070004ac4293f3"
)


class AgentBuilderTests(unittest.TestCase):
    def test_doh_query_has_valid_example_labels_and_type(self):
        query = NAMESPACE["_doh_wire_query"]()
        self.assertEqual(
            base64.urlsafe_b64encode(query).decode().rstrip("="),
            "q80BAAABAAAAAAAAB2V4YW1wbGUDY29tAAABAAE",
        )
        self.assertEqual(query[:12], bytes.fromhex("abcd01000001000000000000"))
        self.assertIn(b"\x07example\x03com\x00", query)
        self.assertEqual(query[-4:], bytes.fromhex("00010001"))

    def test_real_cloudflare_and_google_wire_response_is_accepted(self):
        self.assertTrue(NAMESPACE["_valid_doh_response"](GOOD_RESPONSE))
        self.assertTrue(NAMESPACE["_valid_doh_response"](bytearray(GOOD_RESPONSE)))

    def test_formerr_and_malformed_headers_are_rejected(self):
        valid = NAMESPACE["_valid_doh_response"]
        self.assertFalse(valid(bytes.fromhex("abcd81010000000000000000")))
        for payload in (
            b"",
            b"\xab\xcd\x81",
            GOOD_RESPONSE[:11],
            GOOD_RESPONSE[:-1],
            GOOD_RESPONSE + b"\x00",
            GOOD_RESPONSE.replace(b"\xab\xcd", b"\xab\xce", 1),
            GOOD_RESPONSE.replace(b"example", b"invalid", 1),
            GOOD_RESPONSE.replace(b"\xc0\x0c\x00\x01", b"\xc0\x0c\x00\x10"),
        ):
            self.assertFalse(valid(payload))

    def test_bad_flags_questions_and_empty_answers_are_rejected(self):
        valid = NAMESPACE["_valid_doh_response"]
        header = bytearray(GOOD_RESPONSE)
        cases = (
            (2, b"\x01\x00"),  # QR clear
            (2, b"\x89\x00"),  # opcode
            (2, b"\x83\x00"),  # truncated
            (2, b"\x81\x01"),  # FORMERR
            (4, b"\x00\x00"),  # no question
            (4, b"\x00\x02"),  # extra question
            (6, b"\x00\x00"),  # no answer
        )
        for offset, replacement in cases:
            payload = bytearray(GOOD_RESPONSE)
            payload[offset:offset + 2] = replacement
            self.assertFalse(valid(bytes(payload)), (offset, replacement))

    def test_dns_wire_walker_rejects_pointer_question_truncation_and_bad_rdlength(self):
        valid = NAMESPACE["_valid_doh_response"]
        question_pointer = bytearray(GOOD_RESPONSE)
        question_pointer[12:14] = b"\xc0\x0c"
        answer_truncated = GOOD_RESPONSE[:-4]
        bad_rdlength = bytearray(GOOD_RESPONSE)
        bad_rdlength[12 + 17 + 10:12 + 17 + 12] = b"\x00\x05"
        endless_label = bytearray(GOOD_RESPONSE)
        endless_label[12] = 0x40
        for payload in (question_pointer, answer_truncated, bad_rdlength, endless_label):
            self.assertFalse(valid(bytes(payload)))

    def test_probe_uses_rfc8484_wire_and_bytes_without_text_decoding(self):
        completed = mock.Mock(returncode=0, stdout=GOOD_RESPONSE, stderr=b"")
        with mock.patch.object(NAMESPACE["subprocess"], "run", return_value=completed) as run:
            self.assertTrue(NAMESPACE["_probe_residential_doh"]("203.0.113.10", "dns.google"))
        command = run.call_args.args[0]
        self.assertIn("socks5h://127.0.0.1:39482", command)
        url = next(item for item in command if item.startswith("https://"))
        query = base64.urlsafe_b64decode(url.rsplit("dns=", 1)[1] + "===")
        self.assertEqual(query, NAMESPACE["_doh_wire_query"]())
        self.assertNotIn("text", run.call_args.kwargs)
        self.assertEqual(completed.stdout, GOOD_RESPONSE)

    def test_probe_rejects_wire_formerr(self):
        completed = mock.Mock(returncode=0, stdout=bytes.fromhex("abcd81010000000000000000"), stderr=b"")
        with mock.patch.object(NAMESPACE["subprocess"], "run", return_value=completed) as run:
            self.assertFalse(NAMESPACE["_probe_residential_doh"]("203.0.113.10", "cloudflare-dns.com"))
        self.assertIn("socks5h://127.0.0.1:39482", run.call_args.args[0])

    def test_rollback_first_install_removes_candidate_even_if_stop_fails(self):
        rollback = NAMESPACE["_rollback_singbox_apply"]
        for failure in (OSError("missing service manager"), subprocess.TimeoutExpired(["systemctl", "stop"], 30)):
            with tempfile.TemporaryDirectory() as directory:
                path = pathlib.Path(directory) / "config.json"
                path.write_text("{}", encoding="utf-8")
                with mock.patch.dict(NAMESPACE, {
                    "SINGBOX_CONF_PATH": str(path),
                    "subprocess": mock.Mock(run=mock.Mock(side_effect=failure), TimeoutExpired=subprocess.TimeoutExpired),
                    "_singbox_service_healthy": lambda: False,
                }), mock.patch("os.path.exists", return_value=False):
                    self.assertFalse(rollback(None, True))
                self.assertFalse(path.exists())

    def test_rollback_previous_install_requires_real_restore_health(self):
        rollback = NAMESPACE["_rollback_singbox_apply"]
        with mock.patch.dict(NAMESPACE, {
            "_restore_singbox_config": lambda _previous: False,
            "_singbox_service_healthy": lambda: True,
        }):
            self.assertFalse(rollback('{"old": true}', True))
        with mock.patch.dict(NAMESPACE, {"_restore_singbox_config": lambda _previous: True}):
            self.assertTrue(rollback('{"old": true}', True))
        with mock.patch.dict(NAMESPACE, {"_singbox_service_healthy": lambda: True}):
            self.assertTrue(rollback('{"old": true}', False))

    def test_legacy_warp_profiles_are_archived_before_removal(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            for name in ("warp.json", "warp-benchmark.json", "warp-optimizer.json"):
                (base / name).write_text('{"legacy": "' + name + '"}', encoding="utf-8")
            (base / "egress-state.json").write_text("{}", encoding="utf-8")
            archived = NAMESPACE["_archive_legacy_profiles"](str(base))
            self.assertEqual(archived, ["warp.json", "warp-benchmark.json", "warp-optimizer.json"])
            archive = base / "archive" / "legacy-warp"
            self.assertEqual(archive.stat().st_mode & 0o777, 0o700)
            for name in ("warp.json", "warp-benchmark.json", "warp-optimizer.json"):
                self.assertFalse((base / name).exists())
                self.assertEqual(json.loads((archive / name).read_text(encoding="utf-8")), {"legacy": name})
                self.assertEqual((archive / name).stat().st_mode & 0o777, 0o600)
            self.assertTrue((base / "egress-state.json").exists())

    def test_legacy_archive_preserves_a_differing_backup_in_a_digest_named_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            archive = base / "archive" / "legacy-warp"
            archive.mkdir(parents=True)
            (base / "warp.json").write_text("new", encoding="utf-8")
            (archive / "warp.json").write_text("old", encoding="utf-8")
            digest = hashlib.sha256(b"new").hexdigest()
            self.assertEqual(NAMESPACE["_archive_legacy_profiles"](str(base)), ["warp.json"])
            self.assertFalse((base / "warp.json").exists())
            self.assertEqual((archive / "warp.json").read_text(encoding="utf-8"), "old")
            self.assertEqual((archive / f"warp.json.{digest}").read_text(encoding="utf-8"), "new")
            self.assertEqual((archive / f"warp.json.{digest}").stat().st_mode & 0o777, 0o600)

    def test_legacy_archive_retry_reuses_an_existing_digest_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            archive = base / "archive" / "legacy-warp"
            archive.mkdir(parents=True)
            digest = hashlib.sha256(b"new").hexdigest()
            (base / "warp.json").write_text("new", encoding="utf-8")
            (archive / "warp.json").write_text("old", encoding="utf-8")
            (archive / f"warp.json.{digest}").write_text("new", encoding="utf-8")
            self.assertEqual(NAMESPACE["_archive_legacy_profiles"](str(base)), ["warp.json"])
            self.assertFalse((base / "warp.json").exists())

    def test_legacy_archive_keeps_source_when_verified_digest_copy_has_wrong_content(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            archive = base / "archive" / "legacy-warp"
            archive.mkdir(parents=True)
            digest = hashlib.sha256(b"new").hexdigest()
            (base / "warp.json").write_text("new", encoding="utf-8")
            (archive / "warp.json").write_text("old", encoding="utf-8")
            (archive / f"warp.json.{digest}").write_text("corrupt", encoding="utf-8")
            with mock.patch.object(NAMESPACE["tempfile"], "mkstemp") as mkstemp:
                self.assertEqual(NAMESPACE["_archive_legacy_profiles"](str(base)), [])
            mkstemp.assert_not_called()
            self.assertTrue((base / "warp.json").exists())

    def test_legacy_archive_retries_after_a_failed_write(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            source = base / "warp.json"
            source.write_text("legacy", encoding="utf-8")
            real_mkstemp = tempfile.mkstemp

            def fail_mkstemp(*args, **kwargs):
                raise OSError("disk full")

            with mock.patch.object(NAMESPACE["tempfile"], "mkstemp", side_effect=fail_mkstemp):
                self.assertEqual(NAMESPACE["_archive_legacy_profiles"](str(base)), [])
            self.assertTrue(source.exists())
            self.assertEqual(NAMESPACE["_archive_legacy_profiles"](str(base)), ["warp.json"])
            self.assertFalse(source.exists())
            self.assertEqual((base / "archive" / "legacy-warp" / "warp.json").read_text(encoding="utf-8"), "legacy")

    def test_legacy_archive_waits_for_pending_update_before_removing_profiles(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            pending = base / ".update-pending"
            pending.write_text("{}", encoding="utf-8")
            profiles = ("warp.json", "warp-benchmark.json", "warp-optimizer.json")
            for name in profiles:
                (base / name).write_text(name, encoding="utf-8")
            self.assertEqual(NAMESPACE["_archive_legacy_profiles"](str(base)), [])
            self.assertFalse((base / "archive").exists())
            for name in profiles:
                self.assertEqual((base / name).read_text(encoding="utf-8"), name)
            pending.unlink()
            self.assertEqual(NAMESPACE["_archive_legacy_profiles"](str(base)), list(profiles))
            for name in profiles:
                self.assertFalse((base / name).exists())


if __name__ == "__main__":
    unittest.main()
