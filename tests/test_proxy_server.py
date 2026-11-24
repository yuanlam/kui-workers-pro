import ast
import os
import pathlib
import socket
import struct
import sys
import threading
import time
import unittest
from collections import defaultdict
from unittest import mock


ROOT = pathlib.Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "static" / "vps"))

import proxy_server


def encode_dns_name(name):
    labels = name.rstrip(".").split(".")
    return b"".join(bytes((len(label),)) + label.encode("ascii") for label in labels) + b"\x00"


def query_type(request):
    return struct.unpack("!H", request[-4:-2])[0]


def query_name(request):
    offset = 12
    labels = []
    while True:
        length = request[offset]
        offset += 1
        if length == 0:
            return ".".join(labels)
        labels.append(request[offset:offset + length].decode("ascii"))
        offset += length


def dns_response(request, records=(), *, flags=0x8180, rcode=0, response_id=None, question=None):
    query_id = int.from_bytes(request[:2], "big") if response_id is None else response_id
    answer_data = b""
    for record in records:
        if len(record) == 4:
            owner, record_type, ttl, data = record
            owner_data = owner if isinstance(owner, bytes) else encode_dns_name(owner)
        else:
            record_type, ttl, data = record
            owner_data = b"\xc0\x0c"
        answer_data += owner_data + struct.pack("!HHIH", record_type, 1, ttl, len(data)) + data
    header = struct.pack(
        "!HHHHHH",
        query_id,
        flags | (rcode & 0x000F),
        1,
        len(records),
        0,
        0,
    )
    return header + (request[12:] if question is None else question) + answer_data


def a_record(address, ttl):
    return 1, ttl, socket.inet_pton(socket.AF_INET, address)


def aaaa_record(address, ttl):
    return 28, ttl, socket.inet_pton(socket.AF_INET6, address)


def cname_record(target, ttl):
    return 5, ttl, encode_dns_name(target)


def owned_record(owner, record):
    record_type, ttl, data = record
    return owner, record_type, ttl, data


def ip_response(request, ipv4=None, ipv6=None, ttl=60):
    record_type = query_type(request)
    if record_type == 1 and ipv4:
        return dns_response(request, [a_record(ipv4, ttl)])
    if record_type == 28 and ipv6:
        return dns_response(request, [aaaa_record(ipv6, ttl)])
    return dns_response(request)


class FakeDnsSocket:
    def __init__(self, response=b"ok"):
        self.response = response
        self.family = None
        self.socktype = None
        self.timeout = None
        self.options = []
        self.connected = None
        self.sent = []
        self.closed = False

    def settimeout(self, timeout):
        self.timeout = timeout

    def setsockopt(self, level, option, value):
        self.options.append((level, option, value))

    def connect(self, address):
        self.connected = address

    def send(self, data):
        self.sent.append(data)
        return len(data)

    def sendall(self, data):
        self.sent.append(data)

    def recv(self, _size):
        return self.response

    def close(self):
        self.closed = True


class FakeIpv6Probe:
    def __init__(self, fail=False):
        self.fail = fail
        self.options = []
        self.connected = None
        self.closed = False

    def setsockopt(self, level, option, value):
        self.options.append((level, option, value))

    def connect(self, address):
        if self.fail:
            raise OSError("no IPv6 route")
        self.connected = address

    def close(self):
        self.closed = True


class ChunkedReadSocket:
    def __init__(self, data=b"", max_chunk=None, recv_error=None, chunks=None):
        self.data = data
        self.max_chunk = max_chunk
        self.recv_error = recv_error
        self.chunks = list(chunks) if chunks is not None else None
        self.pending = b""
        self.recv_sizes = []
        self.sent = []
        self.closed = False

    def recv(self, size):
        self.recv_sizes.append(size)
        if self.recv_error is not None:
            raise self.recv_error
        limit = size if self.max_chunk is None else min(size, self.max_chunk)
        if self.chunks is not None:
            if not self.pending:
                if not self.chunks:
                    return b""
                self.pending = self.chunks.pop(0)
            chunk = self.pending[:limit]
            self.pending = self.pending[limit:]
            return chunk
        chunk = self.data[:limit]
        self.data = self.data[limit:]
        return chunk

    def sendall(self, data):
        self.sent.append(data)

    def close(self):
        self.closed = True


class ScriptedOutboundSocket:
    def __init__(self, events, bind_error=None, connect_error=None, on_bind=None, on_connect=None):
        self.events = events
        self.bind_error = bind_error
        self.connect_error = connect_error
        self.on_bind = on_bind
        self.on_connect = on_connect
        self.closed = False

    def settimeout(self, timeout):
        pass

    def setsockopt(self, level, option, value):
        if option != proxy_server.SO_BINDTODEVICE:
            self.events.append(("setsockopt", level, option, value))
            return
        self.events.append(("bind", value.decode("utf-8")))
        if self.on_bind is not None:
            self.on_bind()
        if self.bind_error is not None:
            raise self.bind_error

    def connect(self, address):
        self.events.append(("connect", address))
        if self.on_connect is not None:
            self.on_connect()
        if self.connect_error is not None:
            raise self.connect_error

    def close(self):
        self.closed = True


class FakeControlEndpoint:
    def __init__(self, local_address, peer_address=None):
        self.local_address = local_address
        self.peer_address = peer_address or local_address

    def getsockname(self):
        return self.local_address

    def getpeername(self):
        return self.peer_address


class ProxyServerDnsTests(unittest.TestCase):
    def setUp(self):
        self._saved_servers = proxy_server.DNS_SERVERS
        self._saved_timeout = proxy_server.DNS_TIMEOUT
        self._saved_max_entries = proxy_server.DNS_CACHE_MAX_ENTRIES
        self._saved_active_bind = proxy_server.ACTIVE_BIND
        self._env = mock.patch.dict(os.environ, {"PROXY_DNS_IPV6": "0"}, clear=False)
        self._env.start()
        self.addCleanup(self._env.stop)
        if hasattr(proxy_server, "clear_dns_cache"):
            proxy_server.clear_dns_cache()

    def tearDown(self):
        proxy_server.DNS_SERVERS = self._saved_servers
        proxy_server.DNS_TIMEOUT = self._saved_timeout
        proxy_server.DNS_CACHE_MAX_ENTRIES = self._saved_max_entries
        proxy_server.ACTIVE_BIND = self._saved_active_bind
        if hasattr(proxy_server, "clear_dns_cache"):
            proxy_server.clear_dns_cache()

    def cache_entry(self, host, interface="tun_main", ipv6=False):
        with proxy_server._DNS_CACHE_LOCK:
            return proxy_server._DNS_CACHE[(host, interface, ipv6)]

    def test_ttl_is_parsed_and_clamped_for_a_and_cname_records(self):
        now = 1000.0
        cases = (
            ("small", "192.0.2.1", [a_record("192.0.2.1", 5)], 30),
            ("large", "192.0.2.2", [a_record("192.0.2.2", 5000)], 600),
            (
                "cname",
                "192.0.2.3",
                [
                    owned_record("ttl.example", cname_record("alias.example.com", 45)),
                    owned_record("alias.example.com", a_record("192.0.2.3", 120)),
                ],
                45,
            ),
        )

        for name, expected_address, records, expected_ttl in cases:
            with self.subTest(name=name):
                proxy_server.clear_dns_cache()
                calls = []

                def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
                    calls.append((interface, use_tcp, server))
                    return dns_response(request, records)

                with mock.patch.object(proxy_server, "_dns_exchange", side_effect=exchange), mock.patch.object(
                    proxy_server.time, "monotonic", return_value=now
                ):
                    addrinfos = proxy_server.resolve_on_landing("ttl.example", 443, "tun_main")

                self.assertEqual(addrinfos[0][4], (expected_address, 443))
                _, expires_at = self.cache_entry("ttl.example")
                self.assertEqual(expires_at, now + expected_ttl)
                self.assertEqual(len(calls), 1)

    def test_a_and_aaaa_use_the_smaller_clamped_ttl(self):
        now = 2000.0
        with mock.patch.dict(os.environ, {"PROXY_DNS_IPV6": "1"}):
            with mock.patch.object(
                proxy_server,
                "_dns_exchange",
                side_effect=lambda request, interface, use_tcp=False, server="1.1.1.1": ip_response(
                    request, ipv4="192.0.2.10", ipv6="2001:db8::10", ttl=50 if query_type(request) == 28 else 900
                ),
            ), mock.patch.object(proxy_server.time, "monotonic", return_value=now):
                addrinfos = proxy_server.resolve_on_landing("dual.example", 8443, "tun_main")

        self.assertEqual({item[0] for item in addrinfos}, {socket.AF_INET, socket.AF_INET6})
        _, expires_at = self.cache_entry("dual.example", ipv6=True)
        self.assertEqual(expires_at, now + 50)

    def test_cache_hit_reuses_result_and_expired_entry_requeries(self):
        clock = {"now": 3000.0}
        calls = []

        def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
            calls.append(1)
            return ip_response(request, ipv4="192.0.2.20", ttl=30)

        with mock.patch.object(proxy_server, "_dns_exchange", side_effect=exchange), mock.patch.object(
            proxy_server.time, "monotonic", side_effect=lambda: clock["now"]
        ):
            first = proxy_server.resolve_on_landing("cache.example", 80, "tun_main")
            clock["now"] = 3029.9
            second = proxy_server.resolve_on_landing("cache.example", 443, "tun_main")
            self.assertEqual(len(calls), 1)
            clock["now"] = 3030.0
            third = proxy_server.resolve_on_landing("cache.example", 8080, "tun_main")

        self.assertEqual(first[0][4], ("192.0.2.20", 80))
        self.assertEqual(second[0][4], ("192.0.2.20", 443))
        self.assertEqual(third[0][4], ("192.0.2.20", 8080))
        self.assertEqual(len(calls), 2)

    def test_lru_evicts_the_least_recently_used_entry(self):
        proxy_server.DNS_CACHE_MAX_ENTRIES = 2
        counts = defaultdict(int)

        def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
            host = query_name(request)
            counts[host] += 1
            last_octet = int(host.split("-", 1)[1].split(".", 1)[0]) + 1
            return ip_response(request, ipv4=f"192.0.2.{last_octet}")

        with mock.patch.object(proxy_server, "_dns_exchange", side_effect=exchange):
            proxy_server.resolve_on_landing("host-1.example", 80, "tun_main")
            proxy_server.resolve_on_landing("host-2.example", 80, "tun_main")
            proxy_server.resolve_on_landing("host-1.example", 81, "tun_main")
            proxy_server.resolve_on_landing("host-3.example", 80, "tun_main")
            proxy_server.resolve_on_landing("host-1.example", 82, "tun_main")
            proxy_server.resolve_on_landing("host-2.example", 83, "tun_main")

        self.assertEqual(counts["host-1.example"], 1)
        self.assertEqual(counts["host-2.example"], 2)
        self.assertEqual(counts["host-3.example"], 1)
        self.assertEqual(len(proxy_server._DNS_CACHE), 2)

    def test_concurrent_resolution_is_safe_and_cache_stays_bounded(self):
        proxy_server.DNS_CACHE_MAX_ENTRIES = 4
        barrier = threading.Barrier(12)
        errors = []
        counts = defaultdict(int)
        counts_lock = threading.Lock()

        def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
            host = query_name(request)
            with counts_lock:
                counts[host] += 1
            time.sleep(0.01)
            last_octet = int(host.split("-", 1)[1].split(".", 1)[0]) + 10
            return ip_response(request, ipv4=f"192.0.2.{last_octet}")

        def worker(index):
            try:
                barrier.wait(timeout=2)
                for iteration in range(4):
                    host = f"race-{index % 6}.example"
                    infos = proxy_server.resolve_on_landing(host, 1000 + index + iteration, "tun_main")
                    expected = f"192.0.2.{index % 6 + 10}"
                    if infos[0][4][0] != expected:
                        raise AssertionError((host, infos))
            except BaseException as error:
                errors.append(error)

        with mock.patch.object(proxy_server, "_dns_exchange", side_effect=exchange):
            threads = [threading.Thread(target=worker, args=(index,)) for index in range(12)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=5)

        self.assertEqual(errors, [])
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertLessEqual(len(proxy_server._DNS_CACHE), 4)
        self.assertTrue(counts)

    def test_cache_is_isolated_by_interface_and_targeted_clear_keeps_others(self):
        calls = []

        def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
            calls.append(interface)
            return ip_response(request, ipv4="192.0.2.1" if interface == "tun_main" else "192.0.2.2")

        with mock.patch.object(proxy_server, "_dns_exchange", side_effect=exchange):
            main = proxy_server.resolve_on_landing("interface.example", 80, "tun_main")
            backup = proxy_server.resolve_on_landing("interface.example", 80, "tun_backup")
            proxy_server.clear_dns_cache("tun_main")
            backup_again = proxy_server.resolve_on_landing("interface.example", 80, "tun_backup")
            main_again = proxy_server.resolve_on_landing("interface.example", 80, "tun_main")

        self.assertEqual(main[0][4][0], "192.0.2.1")
        self.assertEqual(backup[0][4][0], "192.0.2.2")
        self.assertEqual(backup_again[0][4][0], "192.0.2.2")
        self.assertEqual(main_again[0][4][0], "192.0.2.1")
        self.assertEqual(calls, ["tun_main", "tun_backup", "tun_main"])

    def test_same_interface_redial_does_not_hit_old_egress_cache(self):
        calls = defaultdict(int)

        def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
            calls[interface] += 1
            address = "192.0.2.110" if calls[interface] == 1 else "192.0.2.111"
            return ip_response(request, ipv4=address)

        with mock.patch.object(proxy_server, "_dns_exchange", side_effect=exchange):
            old_main = proxy_server.resolve_on_landing("redial.example", 80, "tun_main")
            proxy_server.resolve_on_landing("redial.example", 80, "tun_backup")
            proxy_server.clear_dns_cache("tun_main")
            new_main = proxy_server.resolve_on_landing("redial.example", 80, "tun_main")

        self.assertEqual(old_main[0][4][0], "192.0.2.110")
        self.assertEqual(new_main[0][4][0], "192.0.2.111")
        self.assertEqual(calls["tun_main"], 2)
        self.assertEqual(calls["tun_backup"], 1)

    def test_failed_and_empty_resolutions_are_not_cached(self):
        proxy_server.DNS_SERVERS = ("1.1.1.1",)
        calls = []

        def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
            calls.append(1)
            if len(calls) == 1:
                return dns_response(request)
            if len(calls) == 2:
                raise socket.timeout("timed out")
            return ip_response(request, ipv4="192.0.2.30")

        with mock.patch.object(proxy_server, "_dns_exchange", side_effect=exchange):
            with self.assertRaises(OSError):
                proxy_server.resolve_on_landing("retry.example", 80, "tun_main")
            with self.assertRaises(OSError):
                proxy_server.resolve_on_landing("retry.example", 80, "tun_main")
            resolved = proxy_server.resolve_on_landing("retry.example", 80, "tun_main")

        self.assertEqual(resolved[0][4], ("192.0.2.30", 80))
        self.assertEqual(len(calls), 3)

    def test_literal_ip_skips_cache_and_dns(self):
        with mock.patch.object(proxy_server, "_dns_exchange", side_effect=AssertionError("DNS must not be called")):
            infos = proxy_server.resolve_on_landing("192.0.2.40", 443, "tun_main")
            proxy_server.resolve_on_landing("2001:db8::40", 443, "tun_main")

        self.assertEqual(infos[0][4], ("192.0.2.40", 443))
        self.assertEqual(len(proxy_server._DNS_CACHE), 0)

    def test_host_normalization_and_different_ports_share_cache(self):
        calls = []

        def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
            calls.append(query_name(request))
            return ip_response(request, ipv4="192.0.2.50")

        with mock.patch.object(proxy_server, "_dns_exchange", side_effect=exchange):
            first = proxy_server.resolve_on_landing("  Example.COM.  ", 80, "tun_main")
            second = proxy_server.resolve_on_landing("example.com", 443, "tun_main")

        self.assertEqual(calls, ["example.com"])
        self.assertEqual(first[0][4], ("192.0.2.50", 80))
        self.assertEqual(second[0][4], ("192.0.2.50", 443))

    def test_ipv6_env_override_precedes_proc_detection(self):
        proc_content = "20014860486000000000000000008888 02 40 00 80 tun_main\n"
        with mock.patch.object(proxy_server.os.path, "exists", return_value=True), mock.patch(
            "builtins.open", mock.mock_open(read_data=proc_content)
        ):
            with mock.patch.dict(os.environ, {"PROXY_DNS_IPV6": "0"}):
                self.assertFalse(proxy_server._interface_supports_ipv6("tun_main"))
            with mock.patch.dict(os.environ, {"PROXY_DNS_IPV6": "yes"}):
                self.assertTrue(proxy_server._interface_supports_ipv6("tun_main"))

    def test_ipv6_proc_detection_requires_a_global_address_for_the_interface(self):
        global_line = "20014860486000000000000000008888 02 40 00 80 tun_main\n"
        local_line = "fe800000000000000000000000000001 02 40 20 80 tun_main\n"

        with mock.patch.dict(os.environ, {"PROXY_DNS_IPV6": ""}):
            with mock.patch.object(proxy_server.os.path, "exists", return_value=True), mock.patch(
                "builtins.open", mock.mock_open(read_data=global_line)
            ):
                self.assertTrue(proxy_server._interface_supports_ipv6("tun_main"))

            proxy_server.clear_dns_cache()
            with mock.patch.object(proxy_server.os.path, "exists", return_value=True), mock.patch(
                "builtins.open", mock.mock_open(read_data=local_line)
            ):
                self.assertFalse(proxy_server._interface_supports_ipv6("tun_main"))

            proxy_server.clear_dns_cache()
            with mock.patch.object(proxy_server.os.path, "exists", return_value=True), mock.patch(
                "builtins.open", mock.mock_open(read_data=global_line)
            ):
                self.assertFalse(proxy_server._interface_supports_ipv6("tun_backup"))

    def test_ipv6_probe_uses_an_inet6_udp_socket_when_proc_is_unavailable(self):
        probe = FakeIpv6Probe()
        with mock.patch.dict(os.environ, {"PROXY_DNS_IPV6": ""}):
            with mock.patch.object(proxy_server.os.path, "exists", return_value=False), mock.patch.object(
                proxy_server.socket, "socket", return_value=probe
            ):
                self.assertTrue(proxy_server._interface_supports_ipv6("tun_main"))

            self.assertEqual(probe.connected, ("2001:4860:4860::8888", 53))
            self.assertIn((socket.SOL_SOCKET, proxy_server.SO_BINDTODEVICE, b"tun_main"), probe.options)
            self.assertTrue(probe.closed)

            proxy_server.clear_dns_cache()
            failed = FakeIpv6Probe(fail=True)
            with mock.patch.object(proxy_server.os.path, "exists", return_value=False), mock.patch.object(
                proxy_server.socket, "socket", return_value=failed
            ):
                self.assertFalse(proxy_server._interface_supports_ipv6("tun_main"))

    def test_clear_dns_cache_also_expires_ipv6_capability_cache(self):
        proc_content = "20014860486000000000000000008888 02 40 00 80 tun_main\n"
        with mock.patch.dict(os.environ, {"PROXY_DNS_IPV6": ""}):
            with mock.patch.object(proxy_server.os.path, "exists", return_value=True), mock.patch(
                "builtins.open", mock.mock_open(read_data=proc_content)
            ):
                self.assertTrue(proxy_server._interface_supports_ipv6("tun_main"))

            proxy_server.clear_dns_cache("tun_main")
            with mock.patch.object(proxy_server.os.path, "exists", return_value=True), mock.patch(
                "builtins.open", mock.mock_open(read_data="")
            ):
                self.assertFalse(proxy_server._interface_supports_ipv6("tun_main"))

    def test_resolve_skips_aaaa_for_an_ipv4_only_tunnel(self):
        calls = []

        def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
            calls.append(query_type(request))
            return ip_response(request, ipv4="192.0.2.60", ipv6="2001:db8::60")

        with mock.patch.object(proxy_server, "_dns_exchange", side_effect=exchange):
            proxy_server.resolve_on_landing("ipv4-only.example", 443, "tun_main")

        self.assertEqual(calls, [1])

    def test_resolve_queries_both_a_and_aaaa_for_a_dual_stack_tunnel(self):
        calls = []

        def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
            calls.append(query_type(request))
            return ip_response(request, ipv4="192.0.2.61", ipv6="2001:db8::61")

        with mock.patch.dict(os.environ, {"PROXY_DNS_IPV6": "on"}), mock.patch.object(
            proxy_server, "_dns_exchange", side_effect=exchange
        ):
            infos = proxy_server.resolve_on_landing("dual-stack.example", 443, "tun_main")

        self.assertEqual(calls, [1, 28])
        self.assertEqual({item[0] for item in infos}, {socket.AF_INET, socket.AF_INET6})

    def test_dns_failover_handles_timeout_oserror_servfail_malformed_and_id_mismatch(self):
        def timeout(_request):
            raise socket.timeout("timeout")

        def oserror(_request):
            raise OSError("network error")

        def servfail(request):
            return dns_response(request, flags=0x8180, rcode=2)

        def malformed(_request):
            return b"\x00\x01"

        def mismatched(request):
            response_id = (int.from_bytes(request[:2], "big") + 1) & 0xFFFF
            return dns_response(request, response_id=response_id)

        for name, failure in (
            ("timeout", timeout),
            ("oserror", oserror),
            ("servfail", servfail),
            ("malformed", malformed),
            ("mismatch", mismatched),
        ):
            with self.subTest(name=name):
                calls = []

                def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
                    calls.append(server)
                    if server == "1.1.1.1":
                        return failure(request)
                    return ip_response(request, ipv4="192.0.2.70")

                with mock.patch.object(proxy_server, "DNS_SERVERS", ("1.1.1.1", "8.8.8.8")), mock.patch.object(
                    proxy_server, "_dns_exchange", side_effect=exchange
                ):
                    addresses = proxy_server._dns_query("failover.example", 1, "tun_main")

                self.assertEqual(addresses, ["192.0.2.70"])
                self.assertEqual(calls, ["1.1.1.1", "8.8.8.8"])

    def test_dns_question_mismatches_are_rejected_and_fail_over(self):
        for case in ("qname", "qtype", "qclass", "opcode"):
            with self.subTest(case=case):
                calls = []

                def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
                    calls.append((use_tcp, server))
                    if server != "1.1.1.1":
                        return ip_response(request, ipv4="192.0.2.90")
                    if case == "qname":
                        question = encode_dns_name("forged.example") + request[-4:]
                        return dns_response(request, question=question)
                    if case == "qtype":
                        question = request[12:-4] + struct.pack("!H", 28) + request[-2:]
                        return dns_response(request, question=question)
                    if case == "qclass":
                        question = request[12:-2] + struct.pack("!H", 3)
                        return dns_response(request, question=question)
                    return dns_response(request, flags=0x8980)

                with mock.patch.object(proxy_server, "DNS_SERVERS", ("1.1.1.1", "8.8.8.8")), mock.patch.object(
                    proxy_server, "_dns_exchange", side_effect=exchange
                ):
                    addresses = proxy_server._dns_query("question.example", 1, "tun_main")

                self.assertEqual(addresses, ["192.0.2.90"])
                self.assertEqual(calls, [(False, "1.1.1.1"), (False, "8.8.8.8")])

    def test_unrelated_answer_owner_is_ignored_and_not_cached(self):
        now = 4000.0
        records = [
            owned_record("target.example", a_record("192.0.2.100", 600)),
            owned_record("unrelated.example", a_record("192.0.2.101", 30)),
        ]

        with mock.patch.object(
            proxy_server,
            "_dns_exchange",
            side_effect=lambda request, interface, use_tcp=False, server="1.1.1.1": dns_response(request, records),
        ), mock.patch.object(proxy_server.time, "monotonic", return_value=now):
            infos = proxy_server.resolve_on_landing("target.example", 443, "tun_main")

        self.assertEqual([item[4][0] for item in infos], ["192.0.2.100"])
        addresses, expires_at = self.cache_entry("target.example")
        self.assertEqual(addresses, ("192.0.2.100",))
        self.assertEqual(expires_at, now + 600)

    def test_literal_dot_inside_dns_label_cannot_impersonate_a_name_boundary(self):
        forged_name = b"\x03a.b\x07example\x00"

        with self.subTest(section="question"):
            calls = []

            def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
                calls.append(server)
                if server == "1.1.1.1":
                    question = forged_name + request[-4:]
                    return dns_response(request, [a_record("192.0.2.200", 600)], question=question)
                return ip_response(request, ipv4="192.0.2.201", ttl=600)

            with mock.patch.object(proxy_server, "DNS_SERVERS", ("1.1.1.1", "8.8.8.8")), mock.patch.object(
                proxy_server, "_dns_exchange", side_effect=exchange
            ):
                addresses = proxy_server._dns_query("a.b.example", 1, "tun_main")

            self.assertEqual(addresses, ["192.0.2.201"])
            self.assertEqual(calls, ["1.1.1.1", "8.8.8.8"])

        with self.subTest(section="answer-owner"):
            records = [owned_record(forged_name, a_record("192.0.2.202", 600))]

            with mock.patch.object(proxy_server, "DNS_SERVERS", ("1.1.1.1",)), mock.patch.object(
                proxy_server,
                "_dns_exchange",
                side_effect=lambda request, interface, use_tcp=False, server="1.1.1.1": dns_response(request, records),
            ):
                with self.assertRaises(OSError):
                    proxy_server.resolve_on_landing("a.b.example", 443, "tun_main")

            with proxy_server._DNS_CACHE_LOCK:
                self.assertNotIn(("a.b.example", "tun_main", False), proxy_server._DNS_CACHE)

    def test_conflicting_cnames_for_the_same_owner_are_rejected_and_not_cached(self):
        calls = []
        records = [
            owned_record("conflict.example", cname_record("first.example", 120)),
            owned_record("conflict.example", cname_record("second.example", 60)),
            owned_record("first.example", a_record("192.0.2.203", 300)),
            owned_record("second.example", a_record("192.0.2.204", 300)),
        ]

        def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
            calls.append(server)
            return dns_response(request, records)

        with mock.patch.object(proxy_server, "DNS_SERVERS", ("1.1.1.1", "8.8.8.8")), mock.patch.object(
            proxy_server, "_dns_exchange", side_effect=exchange
        ):
            with self.assertRaisesRegex(OSError, "conflicting DNS CNAME records"):
                proxy_server.resolve_on_landing("conflict.example", 443, "tun_main")

        self.assertEqual(calls, ["1.1.1.1", "8.8.8.8"])
        with proxy_server._DNS_CACHE_LOCK:
            self.assertNotIn(("conflict.example", "tun_main", False), proxy_server._DNS_CACHE)

    def test_duplicate_cname_for_the_same_owner_keeps_the_minimum_ttl(self):
        now = 4500.0
        records = [
            owned_record("duplicate.example", cname_record("alias.example", 60)),
            owned_record("duplicate.example", cname_record("alias.example", 120)),
            owned_record("alias.example", a_record("192.0.2.205", 300)),
        ]

        with mock.patch.object(
            proxy_server,
            "_dns_exchange",
            side_effect=lambda request, interface, use_tcp=False, server="1.1.1.1": dns_response(request, records),
        ), mock.patch.object(proxy_server.time, "monotonic", return_value=now):
            infos = proxy_server.resolve_on_landing("duplicate.example", 443, "tun_main")

        self.assertEqual(infos[0][4][0], "192.0.2.205")
        _, expires_at = self.cache_entry("duplicate.example")
        self.assertEqual(expires_at, now + 60)

    def test_overlong_dns_names_and_pointer_depth_are_rejected(self):
        overlong_name = ".".join(["a" * 63] * 4)
        with self.assertRaisesRegex(OSError, "invalid DNS name"):
            proxy_server._dns_question(overlong_name, 1)
        with self.assertRaises(OSError):
            proxy_server._dns_name(encode_dns_name(overlong_name), 0)

        pointers = bytearray()
        for index in range(66):
            target = (index + 1) * 2
            pointers += bytes((0xC0 | (target >> 8), target & 0xFF))
        pointers += b"\x00"
        with self.assertRaises(OSError):
            proxy_server._dns_name(bytes(pointers), 0)
        with self.assertRaises(OSError):
            proxy_server._dns_name(b"\xc0\xff", 0)

    def test_zero_ttl_results_are_returned_but_not_cached(self):
        for ttl in (0, 0x8000003C):
            with self.subTest(ttl=ttl):
                proxy_server.clear_dns_cache()
                calls = []

                def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
                    calls.append(1)
                    return ip_response(request, ipv4="192.0.2.102", ttl=ttl)

                with mock.patch.object(proxy_server, "_dns_exchange", side_effect=exchange):
                    first = proxy_server.resolve_on_landing("zero-ttl.example", 80, "tun_main")
                    with proxy_server._DNS_CACHE_LOCK:
                        self.assertNotIn(("zero-ttl.example", "tun_main", False), proxy_server._DNS_CACHE)
                    second = proxy_server.resolve_on_landing("zero-ttl.example", 443, "tun_main")

                self.assertEqual(first[0][4], ("192.0.2.102", 80))
                self.assertEqual(second[0][4], ("192.0.2.102", 443))
                self.assertEqual(len(calls), 2)

    def test_nxdomain_is_authoritative_and_does_not_query_backup(self):
        calls = []

        def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
            calls.append(server)
            if server != "1.1.1.1":
                raise AssertionError("backup DNS must not be queried for NXDOMAIN")
            return dns_response(request, rcode=3)

        with mock.patch.object(proxy_server, "DNS_SERVERS", ("1.1.1.1", "8.8.8.8")), mock.patch.object(
            proxy_server, "_dns_exchange", side_effect=exchange
        ):
            with self.assertRaises(proxy_server._DnsAuthoritativeError):
                proxy_server._dns_query("missing.example", 1, "tun_main")

        self.assertEqual(calls, ["1.1.1.1"])

    def test_dual_stack_single_family_failure_is_retried_and_then_cached(self):
        calls = []

        def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
            record_type = query_type(request)
            calls.append(record_type)
            if record_type == 1:
                return ip_response(request, ipv4="192.0.2.103", ttl=600)
            if calls.count(28) == 1:
                raise socket.timeout("AAAA timeout")
            return ip_response(request, ipv6="2001:db8::103", ttl=600)

        with mock.patch.dict(os.environ, {"PROXY_DNS_IPV6": "1"}), mock.patch.object(
            proxy_server, "DNS_SERVERS", ("1.1.1.1",)
        ), mock.patch.object(proxy_server, "_dns_exchange", side_effect=exchange):
            first = proxy_server.resolve_on_landing("dual-retry.example", 443, "tun_main")
            with proxy_server._DNS_CACHE_LOCK:
                self.assertNotIn(("dual-retry.example", "tun_main", True), proxy_server._DNS_CACHE)
            second = proxy_server.resolve_on_landing("dual-retry.example", 443, "tun_main")

        self.assertEqual({item[0] for item in first}, {socket.AF_INET})
        self.assertEqual({item[0] for item in second}, {socket.AF_INET, socket.AF_INET6})
        self.assertEqual(calls, [1, 28, 1, 28])
        self.cache_entry("dual-retry.example", ipv6=True)

    def test_clear_dns_cache_prevents_inflight_result_from_backfilling(self):
        started = threading.Event()
        release = threading.Event()
        calls = []
        errors = []
        results = []

        def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
            calls.append(1)
            if len(calls) == 1:
                started.set()
                if not release.wait(2):
                    raise socket.timeout("test release timeout")
                return ip_response(request, ipv4="192.0.2.104", ttl=600)
            return ip_response(request, ipv4="192.0.2.105", ttl=600)

        def worker():
            try:
                results.append(proxy_server.resolve_on_landing("generation.example", 80, "tun_main"))
            except BaseException as error:
                errors.append(error)

        with mock.patch.object(proxy_server, "_dns_exchange", side_effect=exchange):
            thread = threading.Thread(target=worker, daemon=True)
            thread.start()
            self.assertTrue(started.wait(2))
            proxy_server.clear_dns_cache("tun_main")
            release.set()
            thread.join(timeout=3)

            self.assertEqual(errors, [])
            self.assertFalse(thread.is_alive())
            self.assertEqual(results[0][0][4][0], "192.0.2.104")
            with proxy_server._DNS_CACHE_LOCK:
                self.assertNotIn(("generation.example", "tun_main", False), proxy_server._DNS_CACHE)

            second = proxy_server.resolve_on_landing("generation.example", 443, "tun_main")

        self.assertEqual(second[0][4][0], "192.0.2.105")
        self.assertEqual(len(calls), 2)

    def test_clear_during_ipv6_probe_prevents_dns_cache_backfill(self):
        calls = []

        def detect_and_clear(interface):
            proxy_server.clear_dns_cache(interface)
            return False

        def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
            calls.append(query_type(request))
            return ip_response(request, ipv4="192.0.2.206", ttl=600)

        with mock.patch.dict(os.environ, {"PROXY_DNS_IPV6": ""}), mock.patch.object(
            proxy_server, "_detect_interface_ipv6", side_effect=detect_and_clear
        ), mock.patch.object(proxy_server, "_dns_exchange", side_effect=exchange):
            infos = proxy_server.resolve_on_landing("probe-race.example", 443, "tun_main")

        self.assertEqual(infos[0][4][0], "192.0.2.206")
        self.assertEqual(calls, [1])
        with proxy_server._DNS_CACHE_LOCK:
            self.assertNotIn("tun_main", proxy_server._IPV6_CAPABILITY_CACHE)
            self.assertNotIn(("probe-race.example", "tun_main", False), proxy_server._DNS_CACHE)

    def test_truncated_udp_with_forged_question_does_not_use_tcp(self):
        calls = []

        def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
            calls.append((use_tcp, server))
            if use_tcp:
                raise AssertionError("forged truncated UDP must not trigger TCP")
            if server == "1.1.1.1":
                question = encode_dns_name("forged.example") + request[-4:]
                return dns_response(request, flags=0x8380, question=question)
            return ip_response(request, ipv4="192.0.2.106")

        with mock.patch.object(proxy_server, "DNS_SERVERS", ("1.1.1.1", "8.8.8.8")), mock.patch.object(
            proxy_server, "_dns_exchange", side_effect=exchange
        ):
            addresses = proxy_server._dns_query("truncated-forged.example", 1, "tun_main")

        self.assertEqual(addresses, ["192.0.2.106"])
        self.assertEqual(calls, [(False, "1.1.1.1"), (False, "8.8.8.8")])

    def test_tcp_dns_exchange_uses_one_shared_deadline(self):
        class SlowTcpDnsSocket:
            def __init__(self):
                self.first = True

            def settimeout(self, _timeout):
                pass

            def setsockopt(self, _level, _option, _value):
                pass

            def connect(self, _address):
                pass

            def sendall(self, _data):
                pass

            def recv(self, _size):
                if self.first:
                    self.first = False
                    time.sleep(0.06)
                    return b"\x00"
                raise socket.timeout("socket timeout")

            def close(self):
                pass

        with mock.patch.object(proxy_server, "DNS_TIMEOUT", 0.05), mock.patch.object(
            proxy_server.socket, "socket", return_value=SlowTcpDnsSocket()
        ):
            with self.assertRaises(socket.timeout) as caught:
                proxy_server._dns_exchange(b"\x00" * 12, "tun_main", use_tcp=True)

        self.assertEqual(str(caught.exception), "DNS timeout")

    def test_lite_manager_clears_dns_cache_at_lifecycle_points(self):
        source = (ROOT / "static" / "vps" / "lite_manager.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        calls = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "clear_dns_cache"
        ]

        self.assertGreaterEqual(len(calls), 5)
        self.assertTrue(any(not call.args for call in calls))
        self.assertGreaterEqual(
            sum(
                1
                for call in calls
                if call.args and isinstance(call.args[0], ast.Attribute) and call.args[0].attr == "name"
            ),
            3,
        )

    def test_health_check_loop_clears_dns_cache_after_kicking_a_tunnel(self):
        source = (ROOT / "static" / "vps" / "lite_manager.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        health_check = next(
            node
            for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "health_check_loop"
        )
        calls = [
            node
            for node in ast.walk(health_check)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "proxy_server"
            and node.func.attr == "clear_dns_cache"
        ]

        self.assertTrue(
            any(
                len(call.args) == 1
                and isinstance(call.args[0], ast.Name)
                and call.args[0].id == "target_tun"
                for call in calls
            )
        )

    def test_dns_failover_raises_the_last_error_after_all_servers_fail(self):
        def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
            raise OSError(f"{server} failed")

        with mock.patch.object(proxy_server, "DNS_SERVERS", ("1.1.1.1", "8.8.8.8")), mock.patch.object(
            proxy_server, "_dns_exchange", side_effect=exchange
        ):
            with self.assertRaisesRegex(OSError, "8.8.8.8 failed"):
                proxy_server._dns_query("all-fail.example", 1, "tun_main")

    def test_nodata_is_a_valid_result_and_does_not_query_the_backup(self):
        calls = []

        def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
            calls.append(server)
            if server != "1.1.1.1":
                raise AssertionError("backup DNS must not be queried")
            return dns_response(request)

        with mock.patch.object(proxy_server, "DNS_SERVERS", ("1.1.1.1", "8.8.8.8")), mock.patch.object(
            proxy_server, "_dns_exchange", side_effect=exchange
        ):
            addresses = proxy_server._dns_query("nodata.example", 1, "tun_main")

        self.assertEqual(addresses, [])
        self.assertEqual(calls, ["1.1.1.1"])

    def test_truncated_udp_retries_tcp_on_the_same_server(self):
        calls = []

        def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
            calls.append((request[:2], use_tcp, server))
            if not use_tcp:
                return dns_response(request, flags=0x8380)
            return ip_response(request, ipv4="192.0.2.80")

        with mock.patch.object(proxy_server, "DNS_SERVERS", ("1.1.1.1", "8.8.8.8")), mock.patch.object(
            proxy_server, "_dns_exchange", side_effect=exchange
        ), mock.patch.object(proxy_server.secrets, "randbelow", side_effect=(100, 200)):
            addresses = proxy_server._dns_query("truncated.example", 1, "tun_main")

        self.assertEqual(addresses, ["192.0.2.80"])
        self.assertEqual([(use_tcp, server) for _, use_tcp, server in calls], [(False, "1.1.1.1"), (True, "1.1.1.1")])
        self.assertNotEqual(calls[0][0], calls[1][0])

    def test_truncated_response_with_mismatched_id_does_not_use_tcp(self):
        calls = []

        def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
            calls.append((use_tcp, server))
            if server == "1.1.1.1":
                response_id = (int.from_bytes(request[:2], "big") + 1) & 0xFFFF
                return dns_response(request, flags=0x8380, response_id=response_id)
            return ip_response(request, ipv4="192.0.2.81")

        with mock.patch.object(proxy_server, "DNS_SERVERS", ("1.1.1.1", "8.8.8.8")), mock.patch.object(
            proxy_server, "_dns_exchange", side_effect=exchange
        ):
            addresses = proxy_server._dns_query("mismatch-tc.example", 1, "tun_main")

        self.assertEqual(addresses, ["192.0.2.81"])
        self.assertEqual(calls, [(False, "1.1.1.1"), (False, "8.8.8.8")])

    def test_dns_server_environment_is_filtered_and_deduplicated(self):
        self.assertEqual(
            proxy_server._load_dns_servers(" 1.1.1.1, 8.8.8.8,1.1.1.1,invalid,2001:4860:4860::8888 "),
            ("1.1.1.1", "8.8.8.8", "2001:4860:4860::8888"),
        )
        self.assertEqual(proxy_server._load_dns_servers("invalid,also-invalid"), proxy_server.DEFAULT_DNS_SERVERS)

        with mock.patch.dict(os.environ, {"PROXY_DNS_SERVERS": "9.9.9.9"}):
            self.assertEqual(proxy_server._load_dns_servers(), ("9.9.9.9",))

    def test_dns_timeout_environment_is_clamped(self):
        self.assertEqual(proxy_server._load_dns_timeout("0.1"), 0.5)
        self.assertEqual(proxy_server._load_dns_timeout("30"), 10.0)
        self.assertEqual(proxy_server._load_dns_timeout("invalid"), 2.0)

        with mock.patch.dict(os.environ, {"PROXY_DNS_TIMEOUT": "1.5"}):
            self.assertEqual(proxy_server._load_dns_timeout(), 1.5)

    def test_dns_exchange_uses_the_server_address_family_and_configured_timeout(self):
        for server, expected_family in (("1.1.1.1", socket.AF_INET), ("2001:4860:4860::8888", socket.AF_INET6)):
            with self.subTest(server=server):
                fake_socket = FakeDnsSocket()
                with mock.patch.object(proxy_server.socket, "socket", return_value=fake_socket):
                    response = proxy_server._dns_exchange(b"\x00" * 12, "tun_main", server=server)

                self.assertEqual(response, b"ok")
                self.assertEqual(fake_socket.connected, (server, 53))
                self.assertEqual(fake_socket.timeout, proxy_server.DNS_TIMEOUT)
                self.assertIn(
                    (socket.SOL_SOCKET, proxy_server.SO_BINDTODEVICE, b"tun_main"),
                    fake_socket.options,
                )
                self.assertEqual(fake_socket.sent, [b"\x00" * 12])
                self.assertTrue(fake_socket.closed)

    def test_relay_socks5_udp_reuses_dns_cache_for_multiple_datagrams(self):
        proxy_server.clear_dns_cache()
        proxy_server.ACTIVE_BIND = "tun_test"
        dns_calls = []

        echo_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        echo_socket.bind(("127.0.0.1", 0))
        echo_socket.settimeout(2)
        echo_port = echo_socket.getsockname()[1]

        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        control_client = socket.create_connection(listener.getsockname())
        control_server, _ = listener.accept()
        control_server.settimeout(2)
        control_client.settimeout(2)

        class NoBindSocket(socket.socket):
            def setsockopt(self, level, option, value):
                if option == proxy_server.SO_BINDTODEVICE:
                    return None
                return super().setsockopt(level, option, value)

        def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
            dns_calls.append((query_name(request), interface))
            return ip_response(request, ipv4="127.0.0.1")

        def echo_twice():
            for _ in range(2):
                payload, source = echo_socket.recvfrom(4096)
                echo_socket.sendto(payload, source)

        relay_errors = []

        def run_relay():
            try:
                proxy_server.relay_socks5_udp(control_server, "127.0.0.1")
            except BaseException as error:
                relay_errors.append(error)

        udp_client = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        udp_client.settimeout(2)
        echo_thread = threading.Thread(target=echo_twice, daemon=True)

        try:
            with mock.patch.object(proxy_server, "_dns_exchange", side_effect=exchange), mock.patch.object(
                proxy_server.socket, "socket", NoBindSocket
            ):
                relay_thread = threading.Thread(target=run_relay, daemon=True)
                relay_thread.start()
                reply = proxy_server.recv_exact(control_client, 10)
                self.assertEqual(reply[:4], b"\x05\x00\x00\x01")
                relay_port = int.from_bytes(reply[8:10], "big")
                echo_thread.start()

                domain = b"udp-cache.example"
                for payload in (b"first", b"second"):
                    packet = (
                        b"\x00\x00\x00\x03"
                        + bytes((len(domain),))
                        + domain
                        + echo_port.to_bytes(2, "big")
                        + payload
                    )
                    udp_client.sendto(packet, ("127.0.0.1", relay_port))
                    response, _ = udp_client.recvfrom(4096)
                    self.assertTrue(response.endswith(payload))

                control_client.close()
                relay_thread.join(timeout=3)
                self.assertFalse(relay_thread.is_alive())
        finally:
            try:
                control_client.close()
            except OSError:
                pass
            control_server.close()
            listener.close()
            udp_client.close()
            echo_socket.close()
            echo_thread.join(timeout=1)

        self.assertEqual(relay_errors, [])
        self.assertEqual(dns_calls, [("udp-cache.example", "tun_test")])


class ProxyServerHttpHeadTests(unittest.TestCase):
    def test_reads_http_head_across_socket_chunks_and_preserves_remaining_body(self):
        head = (
            b"CONNECT example.com:443 HTTP/1.1\r\n"
            b"Proxy-Authorization: Basic dXNlcjpwYXNz\r\n"
            b"Cookie: session=" + b"a" * 120 + b"\r\n\r\n"
        )
        body = b"\x16\x03\x01\x00\x10tls-client-hello"
        wire = head + body
        chunks = [wire[1:9]]
        offset = 9
        while offset < len(head) - 5:
            next_offset = min(offset + 32, len(head) - 5)
            chunks.append(wire[offset:next_offset])
            offset = next_offset
        chunks.append(wire[len(head) - 5:])
        sock = ChunkedReadSocket(chunks=chunks)

        parsed_head, rest = proxy_server._read_http_request_head(
            sock,
            max_bytes=4096,
            chunk_size=64,
            initial_data=wire[:1],
        )

        self.assertEqual(parsed_head + b"\r\n\r\n", head)
        self.assertEqual(rest, body)
        self.assertEqual(len(sock.recv_sizes), len(chunks))

    def test_rejects_oversized_http_head_and_http_client_returns_431(self):
        oversized = ChunkedReadSocket(b"X" * 40000, max_chunk=1024)
        with self.assertRaises(proxy_server._HttpRequestHeadError) as caught:
            proxy_server._read_http_request_head(oversized, max_bytes=128, chunk_size=64)

        self.assertEqual(caught.exception.status, 431)

        response_socket = ChunkedReadSocket(b"X" * 40000, max_chunk=4096)
        with mock.patch.object(proxy_server, "PROXY_USER", b"user"), mock.patch.object(
            proxy_server, "PROXY_PASS", b"pass"
        ):
            proxy_server.http_client(response_socket, b"G")

        self.assertTrue(any(response.startswith(b"HTTP/1.1 431 ") for response in response_socket.sent))
        self.assertTrue(response_socket.closed)

    def test_http_head_eof_and_timeout_are_reported_without_uncaught_errors(self):
        cases = (
            (ChunkedReadSocket(b"GET / HTTP/1.1\r\nHost: partial"), 400),
            (ChunkedReadSocket(recv_error=socket.timeout("timed out")), 408),
        )
        for sock, expected_status in cases:
            with self.subTest(expected_status=expected_status):
                with self.assertRaises(proxy_server._HttpRequestHeadError) as caught:
                    proxy_server._read_http_request_head(sock, max_bytes=4096, chunk_size=64)
                self.assertEqual(caught.exception.status, expected_status)


class ProxyServerConnectionTests(unittest.TestCase):
    def setUp(self):
        self._saved_active_bind = proxy_server.ACTIVE_BIND
        proxy_server.ACTIVE_BIND = "tun_main"
        self.addrinfos = [
            (
                socket.AF_INET,
                socket.SOCK_STREAM,
                socket.IPPROTO_TCP,
                "",
                ("192.0.2.10", 443),
            )
        ]

    def tearDown(self):
        proxy_server.ACTIVE_BIND = self._saved_active_bind
        proxy_server.clear_dns_cache()

    def test_bind_failure_without_interface_change_never_connects_unbound(self):
        events = []
        sock = ScriptedOutboundSocket(events, bind_error=OSError("device unavailable"))

        with mock.patch.object(proxy_server.socket, "socket", return_value=sock), mock.patch.object(
            proxy_server, "resolve_on_landing", return_value=self.addrinfos
        ):
            with self.assertRaisesRegex(OSError, "SO_BINDTODEVICE"):
                proxy_server.create_connection(("example.com", 443))

        self.assertEqual(events, [("bind", "tun_main")])
        self.assertTrue(sock.closed)

    def test_bind_failure_retries_once_on_new_active_bind(self):
        events = []

        def switch_interface():
            proxy_server.ACTIVE_BIND = "tun_backup"

        first = ScriptedOutboundSocket(
            events,
            bind_error=OSError("old interface removed"),
            on_bind=switch_interface,
        )
        second = ScriptedOutboundSocket(events)
        resolved_interfaces = []

        def resolve(host, port, interface):
            resolved_interfaces.append((host, port, interface))
            return self.addrinfos

        with mock.patch.object(proxy_server.socket, "socket", side_effect=[first, second]), mock.patch.object(
            proxy_server, "resolve_on_landing", side_effect=resolve
        ):
            connected = proxy_server.create_connection(("example.com", 443))

        self.assertIs(connected, second)
        self.assertEqual(
            resolved_interfaces,
            [("example.com", 443, "tun_main"), ("example.com", 443, "tun_backup")],
        )
        self.assertEqual(
            events,
            [("bind", "tun_main"), ("bind", "tun_backup"), ("connect", ("192.0.2.10", 443))],
        )
        self.assertTrue(first.closed)
        self.assertFalse(second.closed)

    def test_connect_failure_retries_once_when_active_bind_changes(self):
        events = []

        def switch_interface():
            proxy_server.ACTIVE_BIND = "tun_backup"

        first = ScriptedOutboundSocket(
            events,
            connect_error=OSError("route disappeared"),
            on_connect=switch_interface,
        )
        second = ScriptedOutboundSocket(events)
        resolved_interfaces = []

        def resolve(host, port, interface):
            resolved_interfaces.append(interface)
            return self.addrinfos

        with mock.patch.object(proxy_server.socket, "socket", side_effect=[first, second]), mock.patch.object(
            proxy_server, "resolve_on_landing", side_effect=resolve
        ):
            connected = proxy_server.create_connection(("example.com", 443))

        self.assertIs(connected, second)
        self.assertEqual(resolved_interfaces, ["tun_main", "tun_backup"])
        self.assertTrue(first.closed)
        self.assertFalse(second.closed)

    def test_retry_is_limited_to_one_new_interface_attempt(self):
        events = []

        def switch_interface():
            proxy_server.ACTIVE_BIND = "tun_backup"

        first = ScriptedOutboundSocket(
            events,
            bind_error=OSError("old interface removed"),
            on_bind=switch_interface,
        )
        second = ScriptedOutboundSocket(events, bind_error=OSError("backup bind failed"))

        with mock.patch.object(proxy_server.socket, "socket", side_effect=[first, second]) as socket_factory, mock.patch.object(
            proxy_server, "resolve_on_landing", return_value=self.addrinfos
        ):
            with self.assertRaisesRegex(OSError, "SO_BINDTODEVICE"):
                proxy_server.create_connection(("example.com", 443))

        self.assertEqual(socket_factory.call_count, 2)
        self.assertTrue(first.closed)
        self.assertTrue(second.closed)
        self.assertNotIn(("connect", ("192.0.2.10", 443)), events)


class ProxyServerUdpTests(unittest.TestCase):
    def setUp(self):
        self._saved_active_bind = proxy_server.ACTIVE_BIND
        proxy_server.ACTIVE_BIND = "tun_main"
        self._env = mock.patch.dict(os.environ, {"PROXY_DNS_IPV6": "0"}, clear=False)
        self._env.start()
        self.addCleanup(self._env.stop)

    def tearDown(self):
        proxy_server.ACTIVE_BIND = self._saved_active_bind
        proxy_server.clear_dns_cache()

    def test_udp_associate_endpoint_and_reply_distinguish_ipv4_ipv6_and_mapped(self):
        cases = (
            ("127.0.0.1", socket.AF_INET, "127.0.0.1", 1, socket.AF_INET),
            ("2001:db8::1", socket.AF_INET6, "2001:db8::1", 4, socket.AF_INET6),
            ("::ffff:127.0.0.1", socket.AF_INET, "127.0.0.1", 1, socket.AF_INET),
        )
        for local_address, expected_family, expected_host, expected_atyp, address_family in cases:
            with self.subTest(local_address=local_address):
                control = FakeControlEndpoint((local_address, 1080))
                family, reply_host = proxy_server._udp_associate_endpoint(control)
                reply = proxy_server.build_socks5_udp_associate_reply(reply_host, 53000)

                self.assertEqual(family, expected_family)
                self.assertEqual(reply_host, expected_host)
                self.assertEqual(reply[:4], b"\x05\x00\x00" + bytes((expected_atyp,)))
                self.assertEqual(
                    socket.inet_ntop(address_family, reply[4:8] if expected_atyp == 1 else reply[4:20]),
                    expected_host,
                )
                self.assertEqual(int.from_bytes(reply[-2:], "big"), 53000)

    def test_udp_packet_builder_normalizes_ipv4_mapped_sources(self):
        packet = proxy_server.build_socks5_udp_packet(("::ffff:192.0.2.9", 5353), b"dns")

        self.assertEqual(packet[:4], b"\x00\x00\x00\x01")
        self.assertEqual(socket.inet_ntop(socket.AF_INET, packet[4:8]), "192.0.2.9")
        self.assertEqual(int.from_bytes(packet[8:10], "big"), 5353)
        self.assertEqual(packet[10:], b"dns")
        self.assertEqual(
            proxy_server._normalize_udp_endpoint(("::ffff:192.0.2.9", 5353, 0, 0)),
            ("192.0.2.9", 5353),
        )
        self.assertEqual(
            proxy_server._normalize_udp_endpoint(("2001:db8::9", 5353, 0, 0)),
            ("2001:db8::9", 5353, 0, 0),
        )

    def test_relay_socks5_udp_rebuilds_outbound_socket_after_active_bind_switch(self):
        proxy_server.clear_dns_cache()
        dns_interfaces = []

        echo_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        echo_socket.bind(("127.0.0.1", 0))
        echo_socket.settimeout(2)
        echo_port = echo_socket.getsockname()[1]

        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        control_client = socket.create_connection(listener.getsockname())
        control_server, _ = listener.accept()
        control_server.settimeout(2)
        control_client.settimeout(2)

        class TrackingSocket(socket.socket):
            instances = []

            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self.bind_interfaces = []
                TrackingSocket.instances.append(self)

            def setsockopt(self, level, option, value):
                if option == proxy_server.SO_BINDTODEVICE:
                    self.bind_interfaces.append(value.decode("utf-8"))
                    return None
                return super().setsockopt(level, option, value)

        def exchange(request, interface, use_tcp=False, server="1.1.1.1"):
            dns_interfaces.append(interface)
            return ip_response(request, ipv4="127.0.0.1")

        def echo_twice():
            for _ in range(2):
                payload, source = echo_socket.recvfrom(4096)
                echo_socket.sendto(payload, source)

        relay_errors = []

        def run_relay():
            try:
                proxy_server.relay_socks5_udp(control_server, "127.0.0.1")
            except BaseException as error:
                relay_errors.append(error)

        udp_client = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        udp_client.settimeout(2)
        echo_thread = threading.Thread(target=echo_twice, daemon=True)

        try:
            with mock.patch.object(proxy_server, "_dns_exchange", side_effect=exchange), mock.patch.object(
                proxy_server.socket, "socket", TrackingSocket
            ):
                relay_thread = threading.Thread(target=run_relay, daemon=True)
                relay_thread.start()
                reply = proxy_server.recv_exact(control_client, 10)
                self.assertEqual(reply[:4], b"\x05\x00\x00\x01")
                relay_port = int.from_bytes(reply[8:10], "big")
                echo_thread.start()

                domain = b"udp-switch.example"
                for index, payload in enumerate((b"before", b"after")):
                    if index == 1:
                        proxy_server.ACTIVE_BIND = "tun_backup"
                    packet = (
                        b"\x00\x00\x00\x03"
                        + bytes((len(domain),))
                        + domain
                        + echo_port.to_bytes(2, "big")
                        + payload
                    )
                    udp_client.sendto(packet, ("127.0.0.1", relay_port))
                    response, _ = udp_client.recvfrom(4096)
                    self.assertTrue(response.endswith(payload))

                bound_sockets = [item for item in TrackingSocket.instances if item.bind_interfaces]
                self.assertEqual(
                    [item.bind_interfaces for item in bound_sockets],
                    [["tun_main"], ["tun_backup"]],
                )
                self.assertEqual(bound_sockets[0].fileno(), -1)
                self.assertNotEqual(bound_sockets[1].fileno(), -1)

                control_client.close()
                relay_thread.join(timeout=3)
                self.assertFalse(relay_thread.is_alive())
        finally:
            try:
                control_client.close()
            except OSError:
                pass
            control_server.close()
            listener.close()
            udp_client.close()
            echo_socket.close()
            echo_thread.join(timeout=1)

        self.assertEqual(relay_errors, [])
        self.assertEqual(dns_interfaces, ["tun_main", "tun_backup"])


if __name__ == "__main__":
    unittest.main()
