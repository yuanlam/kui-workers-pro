#!/usr/bin/env python3
from __future__ import annotations
import os
import ipaddress
import select, socket, threading, urllib.parse, time, base64, hmac, secrets, struct
from collections import OrderedDict
from typing import Any

def env_secret(name: str) -> str:
    encoded = os.environ.get(name + "_B64")
    if encoded:
        try: return base64.b64decode(encoded).decode("utf-8")
        except Exception: return ""
    return os.environ.get(name, "")

_PROXY_USER = env_secret("PROXY_USER")
_PROXY_PASS = env_secret("PROXY_PASS")

def set_credentials(user: str, passwd: str) -> None:
    global _PROXY_USER, _PROXY_PASS, PROXY_USER, PROXY_PASS
    _PROXY_USER = user
    _PROXY_PASS = passwd
    PROXY_USER = user.encode()
    PROXY_PASS = passwd.encode()

def set_enabled(enabled: bool) -> None:
    if not enabled: set_credentials("", "")

PROXY_USER = _PROXY_USER.encode()
PROXY_PASS = _PROXY_PASS.encode()

# 全局软开关：由 lite_manager 动态更新，实现秒切
ACTIVE_BIND = "tun_main"
MAX_CONNECTIONS = max(16, int(os.environ.get("PROXY_MAX_CONNECTIONS", "256")))
RELAY_IDLE_TIMEOUT = max(60, int(os.environ.get("PROXY_IDLE_TIMEOUT", "600")))
CONNECTION_SLOTS = threading.BoundedSemaphore(MAX_CONNECTIONS)
listener_ready = threading.Event()
SO_BINDTODEVICE = getattr(socket, "SO_BINDTODEVICE", 25)

DEFAULT_DNS_SERVERS = ("1.1.1.1", "8.8.8.8")
DNS_CACHE_MIN_TTL = 30
DNS_CACHE_MAX_TTL = 600
DNS_CACHE_MAX_ENTRIES = 1024
_PROC_IF_INET6_PATH = "/proc/net/if_inet6"
_IPV6_CAPABILITY_TTL = 30.0
_DNS_CACHE_LOCK = threading.Lock()
_DNS_CACHE = OrderedDict()
_IPV6_CAPABILITY_CACHE = {}
_GLOBAL_CACHE_GENERATION = 0
_INTERFACE_GENERATIONS: dict[str, int] = {}
_DNS_DEADLINE = threading.local()

def _cache_generation(interface: str) -> tuple[int, int]:
    return (_GLOBAL_CACHE_GENERATION, _INTERFACE_GENERATIONS.get(interface, 0))

def _load_dns_servers(value: str | None = None) -> tuple[str, ...]:
    raw = os.environ.get("PROXY_DNS_SERVERS", "") if value is None else value
    servers = []
    seen = set()
    for item in raw.split(","):
        candidate = item.strip()
        if not candidate:
            continue
        try:
            normalized = str(ipaddress.ip_address(candidate))
        except ValueError:
            continue
        if normalized in seen:
            continue
        seen.add(normalized)
        servers.append(normalized)
    return tuple(servers) or DEFAULT_DNS_SERVERS

def _load_dns_timeout(value: str | None = None) -> float:
    raw = os.environ.get("PROXY_DNS_TIMEOUT", "2.0") if value is None else value
    try:
        timeout = float(raw)
    except (TypeError, ValueError):
        timeout = 2.0
    if timeout != timeout:
        timeout = 2.0
    return max(0.5, min(10.0, timeout))

DNS_SERVERS = _load_dns_servers()
DNS_TIMEOUT = _load_dns_timeout()

def _ipv6_env_override() -> bool | None:
    value = os.environ.get("PROXY_DNS_IPV6", "").strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return None

def _detect_interface_ipv6(interface: str) -> bool:
    if os.path.exists(_PROC_IF_INET6_PATH):
        try:
            with open(_PROC_IF_INET6_PATH, "r", encoding="utf-8") as proc_file:
                lines = proc_file.readlines()
        except OSError:
            return False
        for line in lines:
            parts = line.split()
            if len(parts) < 5 or parts[3] != "00":
                continue
            line_interface = parts[5] if len(parts) >= 6 else parts[2]
            if line_interface != interface:
                continue
            try:
                address = ipaddress.IPv6Address(bytes.fromhex(parts[0]))
            except ValueError:
                continue
            if address.is_global:
                return True
        return False

    try:
        probe = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
    except OSError:
        return False
    try:
        if interface:
            probe.setsockopt(socket.SOL_SOCKET, SO_BINDTODEVICE, interface.encode("utf-8"))
        probe.connect(("2001:4860:4860::8888", 53))
        return True
    except OSError:
        return False
    finally:
        probe.close()

def _interface_supports_ipv6(interface: str) -> bool:
    override = _ipv6_env_override()
    if override is not None:
        return override
    now = time.monotonic()
    with _DNS_CACHE_LOCK:
        cached = _IPV6_CAPABILITY_CACHE.get(interface)
        if cached and cached[1] > now:
            return cached[0]
        generation = _cache_generation(interface)
    supported = _detect_interface_ipv6(interface)
    with _DNS_CACHE_LOCK:
        current_generation = _cache_generation(interface)
        if generation == current_generation:
            _IPV6_CAPABILITY_CACHE[interface] = (supported, time.monotonic() + _IPV6_CAPABILITY_TTL)
    return supported

def clear_dns_cache(interface: str | None = None) -> None:
    global _GLOBAL_CACHE_GENERATION
    with _DNS_CACHE_LOCK:
        if interface is None:
            _GLOBAL_CACHE_GENERATION += 1
            _DNS_CACHE.clear()
            _IPV6_CAPABILITY_CACHE.clear()
            return
        _INTERFACE_GENERATIONS[interface] = _INTERFACE_GENERATIONS.get(interface, 0) + 1
        for key in list(_DNS_CACHE):
            if key[1] == interface:
                del _DNS_CACHE[key]
        _IPV6_CAPABILITY_CACHE.pop(interface, None)

def parse_int(value: Any) -> int:
    try: return int(value)
    except: return 0

def recv_exact(sock: socket.socket, size: int, deadline: float | None = None) -> bytes:
    if deadline is None:
        deadline = getattr(_DNS_DEADLINE, "value", None)
    data = b""
    while len(data) < size:
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise socket.timeout("DNS timeout")
            sock.settimeout(remaining)
        chunk = sock.recv(size - len(data))
        if not chunk: raise ConnectionError("Unexpected disconnect.")
        data += chunk
    return data

def parse_addr_port(raw: str):
    if not raw:
        return None
    if raw.startswith('['):
        idx = raw.find(']')
        if idx == -1:
            return None
        host = raw[1:idx]
        port_str = raw[idx + 2:] if len(raw) > idx + 1 and raw[idx + 1] == ':' else ''
        port = parse_int(port_str) or 443
        return host, port
    if ':' in raw:
        host, port_text = raw.rsplit(':', 1)
        return host, parse_int(port_text) or 443
    return raw, 443

def recv_socks5_address(sock: socket.socket, address_type: int) -> tuple[str, int]:
    if address_type == 1: host = socket.inet_ntoa(recv_exact(sock, 4))
    elif address_type == 3: host = recv_exact(sock, recv_exact(sock, 1)[0]).decode("ascii")
    elif address_type == 4: host = socket.inet_ntop(socket.AF_INET6, recv_exact(sock, 16))
    else: raise OSError("unsupported SOCKS5 address type")
    return host, int.from_bytes(recv_exact(sock, 2), "big")

def parse_socks5_udp_packet(packet: bytes) -> tuple[str, int, bytes]:
    if len(packet) < 7 or packet[:2] != b"\x00\x00": raise OSError("invalid SOCKS5 UDP packet")
    fragment, address_type = packet[2], packet[3]
    if fragment != 0: raise OSError("fragmented SOCKS5 UDP is unsupported")
    offset = 4
    if address_type == 1:
        if len(packet) < offset + 6: raise OSError("truncated SOCKS5 UDP IPv4 address")
        host = socket.inet_ntop(socket.AF_INET, packet[offset:offset + 4]); offset += 4
    elif address_type == 4:
        if len(packet) < offset + 18: raise OSError("truncated SOCKS5 UDP IPv6 address")
        host = socket.inet_ntop(socket.AF_INET6, packet[offset:offset + 16]); offset += 16
    elif address_type == 3:
        if len(packet) <= offset: raise OSError("truncated SOCKS5 UDP domain")
        length = packet[offset]; offset += 1
        if not length or len(packet) < offset + length + 2: raise OSError("truncated SOCKS5 UDP domain")
        host = packet[offset:offset + length].decode("ascii"); offset += length
    else:
        raise OSError("unsupported SOCKS5 UDP address type")
    port = int.from_bytes(packet[offset:offset + 2], "big"); offset += 2
    if not port: raise OSError("invalid SOCKS5 UDP port")
    return host, port, packet[offset:]

def build_socks5_udp_packet(address: tuple, payload: bytes) -> bytes:
    host, port = address[0], address[1]
    parsed = ipaddress.ip_address(host)
    address_type = 1 if parsed.version == 4 else 4
    packed = parsed.packed
    return b"\x00\x00\x00" + bytes((address_type,)) + packed + int(port).to_bytes(2, "big") + payload

def _dns_name_labels(packet: bytes, offset: int) -> tuple[tuple[str, ...], int]:
    labels = []
    next_offset = offset
    jumped = False
    seen = set()
    pointer_jumps = 0
    wire_length = 1
    while True:
        if offset < 0 or offset >= len(packet): raise OSError("truncated DNS name")
        length = packet[offset]
        if length == 0:
            if not jumped: next_offset = offset + 1
            return tuple(labels), next_offset
        if length & 0xC0 == 0xC0:
            if offset + 1 >= len(packet): raise OSError("truncated DNS pointer")
            pointer = ((length & 0x3F) << 8) | packet[offset + 1]
            if pointer >= len(packet): raise OSError("invalid DNS pointer")
            if pointer in seen: raise OSError("recursive DNS pointer")
            pointer_jumps += 1
            if pointer_jumps > 64: raise OSError("too many DNS pointer jumps")
            seen.add(pointer)
            if not jumped: next_offset = offset + 2
            offset = pointer
            jumped = True
            continue
        if length & 0xC0 or offset + 1 + length > len(packet):
            raise OSError("invalid DNS label")
        wire_length += 1 + length
        if wire_length > 255: raise OSError("invalid DNS name")
        try:
            labels.append(packet[offset + 1:offset + 1 + length].decode("ascii").lower())
        except UnicodeDecodeError as error:
            raise OSError("invalid DNS label") from error
        offset += 1 + length
        if not jumped: next_offset = offset

def _dns_name(packet: bytes, offset: int) -> tuple[str, int]:
    labels, next_offset = _dns_name_labels(packet, offset)
    return ".".join(labels), next_offset

def _host_to_labels(host: str) -> tuple[str, ...]:
    try:
        labels = host.strip().rstrip(".").encode("idna").split(b".")
    except UnicodeError as error:
        raise OSError("invalid DNS name") from error
    if not labels or any(not label or len(label) > 63 for label in labels):
        raise OSError("invalid DNS name")
    if 1 + sum(1 + len(label) for label in labels) > 255:
        raise OSError("invalid DNS name")
    try:
        return tuple(label.decode("ascii").lower() for label in labels)
    except UnicodeDecodeError as error:
        raise OSError("invalid DNS name") from error

def _dns_question(host: str, query_type: int) -> bytes:
    labels = _host_to_labels(host)
    wire_name = b"".join(bytes((len(label),)) + label.encode("ascii") for label in labels) + b"\x00"
    return wire_name + struct.pack("!HH", query_type, 1)

def _dns_request(question: bytes, query_id: int) -> bytes:
    return struct.pack("!HHHHHH", query_id, 0x0100, 1, 0, 0, 0) + question

def _dns_header(response: bytes) -> tuple[int, int, int, int, int, int]:
    if len(response) < 12:
        raise OSError("truncated DNS response")
    return struct.unpack("!HHHHHH", response[:12])

def _dns_exchange(request: bytes, interface: str, use_tcp: bool = False, server: str = "1.1.1.1") -> bytes:
    try:
        server_address = ipaddress.ip_address(server)
    except ValueError:
        raise OSError("invalid DNS server")
    family = socket.AF_INET6 if server_address.version == 6 else socket.AF_INET
    deadline = time.monotonic() + DNS_TIMEOUT
    previous_deadline = getattr(_DNS_DEADLINE, "value", None)
    _DNS_DEADLINE.value = deadline
    try:
        dns_socket = socket.socket(family, socket.SOCK_STREAM if use_tcp else socket.SOCK_DGRAM)
        try:
            dns_socket.settimeout(DNS_TIMEOUT)
            dns_socket.setsockopt(socket.SOL_SOCKET, SO_BINDTODEVICE, interface.encode("utf-8"))
            dns_socket.connect((server, 53))
            if use_tcp:
                remaining = deadline - time.monotonic()
                if remaining <= 0: raise socket.timeout("DNS timeout")
                dns_socket.settimeout(remaining)
                dns_socket.sendall(len(request).to_bytes(2, "big") + request)
                response_length = int.from_bytes(recv_exact(dns_socket, 2), "big")
                if response_length < 12 or response_length > 65535: raise OSError("invalid DNS TCP length")
                return recv_exact(dns_socket, response_length)
            dns_socket.send(request)
            return dns_socket.recv(4096)
        finally:
            dns_socket.close()
    finally:
        if previous_deadline is None:
            try: del _DNS_DEADLINE.value
            except AttributeError: pass
        else:
            _DNS_DEADLINE.value = previous_deadline

class _DnsAuthoritativeError(OSError):
    pass


def _parse_dns_question(
    response: bytes,
    offset: int,
    query_type: int,
    expected_labels: tuple[str, ...] | None = None,
) -> tuple[tuple[str, ...], int]:
    qname_labels, offset = _dns_name_labels(response, offset)
    if offset + 4 > len(response):
        raise OSError("truncated DNS question")
    qtype, qclass = struct.unpack("!HH", response[offset:offset + 4])
    if qtype != query_type or qclass != 1:
        raise OSError("invalid DNS question")
    if expected_labels is not None and qname_labels != expected_labels:
        raise OSError("invalid DNS question")
    return qname_labels, offset + 4

def _validate_dns_response_header_and_question(
    response: bytes,
    query_id: int,
    query_type: int,
    expected_labels: tuple[str, ...] | None = None,
) -> tuple[int, int, tuple[str, ...], int]:
    response_id, flags, qd_count, answer_count, _, _ = _dns_header(response)
    if response_id != query_id or not flags & 0x8000:
        raise OSError("invalid DNS response")
    if flags & 0x7800:
        raise OSError("invalid DNS opcode")
    if qd_count != 1 or answer_count > 256:
        raise OSError("invalid DNS section counts")

    offset = 12
    qname_labels, offset = _parse_dns_question(response, offset, query_type, expected_labels)
    return flags, answer_count, qname_labels, offset


def _parse_dns_response(
    response: bytes,
    query_id: int,
    query_type: int,
    expected_host: str | None = None,
) -> tuple[list[str], int | None]:
    expected_labels = _host_to_labels(expected_host) if expected_host is not None else None
    flags, answer_count, qname, offset = _validate_dns_response_header_and_question(
        response, query_id, query_type, expected_labels
    )
    rcode = flags & 0x000F
    if rcode == 3:
        raise _DnsAuthoritativeError("DNS server returned NXDOMAIN")
    if rcode:
        raise OSError(f"DNS server returned rcode {rcode}")
    if flags & 0x0200:
        raise OSError("truncated DNS response after TCP fallback")

    target_owner = expected_labels if expected_labels is not None else qname
    cnames = {}
    address_records = []

    for _ in range(answer_count):
        owner_labels, offset = _dns_name_labels(response, offset)
        if offset + 10 > len(response):
            raise OSError("truncated DNS answer")
        record_type, record_class, ttl, data_length = struct.unpack("!HHIH", response[offset:offset + 10])
        offset += 10
        if offset + data_length > len(response):
            raise OSError("truncated DNS data")
        rdata_start = offset
        data = response[offset:offset + data_length]
        offset += data_length
        if ttl & 0x80000000:
            ttl = 0
        if record_class != 1:
            continue

        if record_type == 5:
            target_labels, target_end = _dns_name_labels(response, rdata_start)
            if target_end != rdata_start + data_length:
                raise OSError("invalid DNS CNAME record")
            existing = cnames.get(owner_labels)
            if existing is not None:
                if existing[0] != target_labels:
                    raise OSError("conflicting DNS CNAME records")
                cnames[owner_labels] = (target_labels, min(existing[1], ttl))
            else:
                cnames[owner_labels] = (target_labels, ttl)
            continue
        if record_type != query_type or query_type not in (1, 28):
            continue
        if query_type == 1:
            if len(data) != 4:
                raise OSError("invalid DNS address record")
            address = socket.inet_ntop(socket.AF_INET, data)
        else:
            if len(data) != 16:
                raise OSError("invalid DNS address record")
            address = socket.inet_ntop(socket.AF_INET6, data)
        address_records.append((owner_labels, address, ttl))

    canonical_owner = target_owner
    chain_ttls = []
    visited = {target_owner}
    while canonical_owner in cnames:
        next_owner, ttl = cnames[canonical_owner]
        if next_owner in visited:
            raise OSError("invalid DNS CNAME chain")
        visited.add(next_owner)
        chain_ttls.append(ttl)
        canonical_owner = next_owner

    wanted_owner = canonical_owner if chain_ttls else target_owner
    addresses = []
    ttl_values = list(chain_ttls)
    for owner_labels, address, ttl in address_records:
        if owner_labels == wanted_owner:
            addresses.append(address)
            ttl_values.append(ttl)

    if not addresses:
        return [], None
    ttl = min(ttl_values)
    if ttl == 0:
        return addresses, 0
    return addresses, max(DNS_CACHE_MIN_TTL, min(DNS_CACHE_MAX_TTL, ttl))

def _dns_query_with_ttl(host: str, query_type: int, interface: str) -> tuple[list[str], int | None]:
    expected_labels = _host_to_labels(host)
    expected_host = ".".join(expected_labels)
    question = _dns_question(expected_host, query_type)
    last_error = None
    for server in DNS_SERVERS:
        query_id = secrets.randbelow(65536)
        request = _dns_request(question, query_id)
        try:
            response = _dns_exchange(request, interface, server=server)
            response_id, flags, _, _, _, _ = _dns_header(response)
            if flags & 0x0200:
                _validate_dns_response_header_and_question(response, query_id, query_type, expected_labels)
                query_id = secrets.randbelow(65536)
                request = _dns_request(question, query_id)
                response = _dns_exchange(request, interface, use_tcp=True, server=server)
            return _parse_dns_response(response, query_id, query_type, expected_host=expected_host)
        except _DnsAuthoritativeError:
            raise
        except (OSError, UnicodeError, ValueError, struct.error) as error:
            last_error = error if isinstance(error, OSError) else OSError(str(error))
    raise last_error or OSError("DNS query failed")

def _dns_query(host: str, query_type: int, interface: str) -> list[str]:
    addresses, _ = _dns_query_with_ttl(host, query_type, interface)
    return addresses

def _addrinfos_for_addresses(addresses: tuple[str, ...], port: int) -> list[tuple]:
    results = []
    for address in dict.fromkeys(addresses):
        parsed = ipaddress.ip_address(address)
        family = socket.AF_INET6 if parsed.version == 6 else socket.AF_INET
        sockaddr = (address, port, 0, 0) if family == socket.AF_INET6 else (address, port)
        results.append((family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr))
    return results

def resolve_on_landing(host: str, port: int, interface: str):
    host_text = host.strip()
    try:
        parsed = ipaddress.ip_address(host_text)
        family = socket.AF_INET6 if parsed.version == 6 else socket.AF_INET
        sockaddr = (host_text, port, 0, 0) if family == socket.AF_INET6 else (host_text, port)
        return [(family, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sockaddr)]
    except ValueError:
        pass

    normalized_host = host_text.rstrip(".").lower()
    with _DNS_CACHE_LOCK:
        generation = _cache_generation(interface)
    ipv6_enabled = _interface_supports_ipv6(interface)
    cache_key = (normalized_host, interface, ipv6_enabled)
    now = time.monotonic()
    cached_addresses = None
    with _DNS_CACHE_LOCK:
        cached = _DNS_CACHE.get(cache_key)
        if cached:
            cached_addresses, expires_at = cached
            if expires_at > now:
                _DNS_CACHE.move_to_end(cache_key)
            else:
                del _DNS_CACHE[cache_key]
                cached_addresses = None
    if cached_addresses is not None:
        return _addrinfos_for_addresses(cached_addresses, port)

    addresses = []
    ttl_values = []
    errors = []
    query_types = (1, 28) if ipv6_enabled else (1,)
    for query_type in query_types:
        try:
            resolved, ttl = _dns_query_with_ttl(normalized_host, query_type, interface)
            if resolved:
                addresses.extend(resolved)
                if ttl is not None:
                    ttl_values.append(ttl)
        except OSError as error:
            errors.append(error)
    if not addresses:
        raise errors[-1] if errors else OSError("landing DNS returned no addresses")

    unique_addresses = tuple(dict.fromkeys(addresses))
    ttl = min(ttl_values) if ttl_values else None
    if not errors and ttl is not None and ttl > 0:
        cache_ttl = max(DNS_CACHE_MIN_TTL, min(DNS_CACHE_MAX_TTL, ttl))
        with _DNS_CACHE_LOCK:
            current_generation = _cache_generation(interface)
            if generation == current_generation:
                _DNS_CACHE[cache_key] = (unique_addresses, time.monotonic() + cache_ttl)
                _DNS_CACHE.move_to_end(cache_key)
                while len(_DNS_CACHE) > DNS_CACHE_MAX_ENTRIES:
                    _DNS_CACHE.popitem(last=False)
    return _addrinfos_for_addresses(unique_addresses, port)

def create_connection(address: tuple[str, int], timeout: float = 20) -> socket.socket:
    global ACTIVE_BIND
    bind_interface = ACTIVE_BIND
    host, port = address
    err = None
    addrinfos = resolve_on_landing(host, port, bind_interface)
    if not addrinfos:
        raise OSError("getaddrinfo empty")

    def sort_key(res):
        af, socktype, proto, canonname, sa = res
        if bind_interface and af != socket.AF_INET:
            return (1, 0)
        return (0, 0)

    addrinfos.sort(key=sort_key)

    for af, socktype, proto, canonname, sa in addrinfos:
        sock = None
        try:
            sock = socket.socket(af, socktype, proto)
            sock.settimeout(timeout)
            if bind_interface and af in (socket.AF_INET, socket.AF_INET6):
                try:
                    sock.setsockopt(socket.SOL_SOCKET, SO_BINDTODEVICE, bind_interface.encode('utf-8'))
                except OSError:
                    continue
            sock.connect(sa)
            sock.settimeout(None)
            return sock
        except OSError as e:
            err = e
            if sock:
                sock.close()
    raise err or OSError("getaddrinfo empty")

def relay(left: socket.socket, right: socket.socket) -> None:
    def pump(source: socket.socket, target: socket.socket) -> None:
        try:
            while True:
                data = source.recv(65536)
                if not data:
                    break
                target.sendall(data)
        except OSError:
            pass
        finally:
            try: target.shutdown(socket.SHUT_WR)
            except OSError: pass

    upload = threading.Thread(target=pump, args=(left, right), daemon=True)
    upload.start()
    pump(right, left)
    upload.join(timeout=5)

def relay_socks5_udp(control: socket.socket, client_ip: str) -> None:
    bind_interface = ACTIVE_BIND
    relay_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    outbound_sockets = {}
    remote_addresses = {}
    client_endpoint = None
    try:
        relay_socket.bind(("0.0.0.0", 0))
        relay_socket.setblocking(False)
        bound_host, bound_port = relay_socket.getsockname()
        reply_host = control.getsockname()[0]
        try: packed_reply = socket.inet_pton(socket.AF_INET, reply_host)
        except OSError: packed_reply = socket.inet_pton(socket.AF_INET, "0.0.0.0")
        control.sendall(b"\x05\x00\x00\x01" + packed_reply + bound_port.to_bytes(2, "big"))
        control.setblocking(False)
        last_activity = time.monotonic()
        while time.monotonic() - last_activity < RELAY_IDLE_TIMEOUT:
            readable, _, _ = select.select([control, relay_socket, *outbound_sockets.values()], [], [], 1.0)
            if control in readable:
                try:
                    if not control.recv(1): break
                except BlockingIOError: pass
            if relay_socket in readable:
                packet, source = relay_socket.recvfrom(65535)
                if source[0] != client_ip or (client_endpoint and source != client_endpoint):
                    continue
                if client_endpoint is None: client_endpoint = source
                try:
                    host, port, payload = parse_socks5_udp_packet(packet)
                    addrinfos = resolve_on_landing(host, port, bind_interface)
                    destination = next((info[4] for info in addrinfos if info[0] in (socket.AF_INET, socket.AF_INET6)), None)
                    if not destination: continue
                    family = socket.AF_INET6 if len(destination) == 4 else socket.AF_INET
                    outbound = outbound_sockets.get(family)
                    if outbound is None:
                        outbound = socket.socket(family, socket.SOCK_DGRAM)
                        outbound.setsockopt(socket.SOL_SOCKET, SO_BINDTODEVICE, bind_interface.encode("utf-8"))
                        outbound.setblocking(False)
                        outbound_sockets[family] = outbound
                    outbound.sendto(payload, destination)
                    remote_addresses[(family, destination[0], destination[1])] = time.monotonic()
                    last_activity = time.monotonic()
                except (OSError, UnicodeError):
                    continue
            for family, outbound in list(outbound_sockets.items()):
                if outbound not in readable: continue
                payload, source = outbound.recvfrom(65535)
                if (family, source[0], source[1]) not in remote_addresses or not client_endpoint: continue
                relay_socket.sendto(build_socks5_udp_packet(source, payload), client_endpoint)
                last_activity = time.monotonic()
            cutoff = time.monotonic() - RELAY_IDLE_TIMEOUT
            remote_addresses = {key: seen for key, seen in remote_addresses.items() if seen >= cutoff}
    finally:
        relay_socket.close()
        for outbound in outbound_sockets.values(): outbound.close()

def socks5_client(client: socket.socket, first_byte: bytes) -> None:
    if not PROXY_USER or not PROXY_PASS:
        client.sendall(b"\x05\xff")
        return
    upstream = None
    try:
        methods_count = recv_exact(client, 1)[0]
        methods = recv_exact(client, methods_count)
        
        if b"\x02" not in methods:
            client.sendall(b"\x05\xFF")
            return
        client.sendall(b"\x05\x02")
        
        auth_req = recv_exact(client, 2)
        if auth_req[0] != 1: return
        ulen = auth_req[1]
        uname = recv_exact(client, ulen)
        plen = recv_exact(client, 1)[0]
        upass = recv_exact(client, plen)
        
        if not hmac.compare_digest(uname, PROXY_USER) or not hmac.compare_digest(upass, PROXY_PASS):
            client.sendall(b"\x01\x01")
            return
        client.sendall(b"\x01\x00") 

        version, command, _, address_type = recv_exact(client, 4)
        if version != 5:
            return
        if command not in (1, 3):
            client.sendall(b"\x05\x07\x00\x01\x00\x00\x00\x00\x00\x00")
            return
        host, port = recv_socks5_address(client, address_type)
        if command == 3:
            relay_socks5_udp(client, client.getpeername()[0])
            return
        
        upstream = create_connection((host, port), timeout=20)
        client.settimeout(None)
        upstream.settimeout(RELAY_IDLE_TIMEOUT); client.settimeout(RELAY_IDLE_TIMEOUT)
        client.sendall(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")
        relay(client, upstream)
    except: pass
    finally:
        client.close()
        if upstream: upstream.close()

def http_client(client: socket.socket, first_byte: bytes) -> None:
    if not PROXY_USER or not PROXY_PASS:
        client.sendall(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n")
        return
    upstream = None
    try:
        data = first_byte
        while b"\r\n\r\n" not in data and len(data) < 65536:
            chunk = client.recv(4096)
            if not chunk: break
            data += chunk
        head, rest = data.split(b"\r\n\r\n", 1)
        lines = head.decode("iso-8859-1", errors="replace").split("\r\n")
        
        expected_auth = "Basic " + base64.b64encode(PROXY_USER + b":" + PROXY_PASS).decode("ascii")
        auth_passed = False
        for line in lines[1:]:
            if line.lower().startswith("proxy-authorization:"):
                if hmac.compare_digest(line.split(":", 1)[1].strip(), expected_auth):
                    auth_passed = True
                    break
                    
        if not auth_passed:
            client.sendall(b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"Proxy\"\r\n\r\n")
            return

        method, target, version = lines[0].split(" ", 2)
        if method.upper() == "CONNECT":
            parsed = parse_addr_port(target)
            if not parsed:
                return
            host, port = parsed
            upstream = create_connection((host, port), timeout=20)
            client.settimeout(None)
            upstream.settimeout(RELAY_IDLE_TIMEOUT); client.settimeout(RELAY_IDLE_TIMEOUT)
            client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            if rest: upstream.sendall(rest)
            relay(client, upstream)
            return
        parsed = urllib.parse.urlsplit(target)
        if not parsed.hostname: return
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        path = urllib.parse.urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
        headers = [line for line in lines[1:] if not line.lower().startswith(("proxy-connection:", "connection:", "proxy-authorization:"))]
        request = f"{method} {path} {version}\r\n" + "\r\n".join(headers) + "\r\nConnection: close\r\n\r\n"
        upstream = create_connection((parsed.hostname, port), timeout=20)
        client.settimeout(None)
        upstream.settimeout(RELAY_IDLE_TIMEOUT); client.settimeout(RELAY_IDLE_TIMEOUT)
        upstream.sendall(request.encode("iso-8859-1") + rest)
        relay(client, upstream)
    except: pass
    finally:
        client.close()
        if upstream: upstream.close()

def proxy_client(client: socket.socket, address: tuple[str, int]) -> None:
    try:
        client.settimeout(30)
        first = recv_exact(client, 1)
        if first == b"\x05": socks5_client(client, first)
        else: http_client(client, first)
    except:
        try: client.close()
        except: pass
    finally:
        CONNECTION_SLOTS.release()

def start_proxy_server(host: str, port: int) -> None:
    servers = []
    public_listener = host in {"0.0.0.0", "::", "*"}
    # Private Docker bridge addresses are intentionally supported here. The
    # controller validates the value before it reaches this process.
    ipv4_host = "0.0.0.0" if public_listener else (host or "127.0.0.1")
    retry_delay = 1
    attempts = 0
    while attempts < 5:
        attempts += 1
        try:
            server4 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            server4.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server4.bind((ipv4_host, port))
            server4.listen(256)
            servers.append(server4)
            break
        except Exception as error:
            print(f"[proxy] IPv4 bind failed on {port}: {error}", flush=True)
            try: server4.close()
            except Exception: pass
            print(f"[proxy] retrying bind in {retry_delay}s", flush=True)
            time.sleep(retry_delay)
            retry_delay = min(retry_delay * 2, 30)
    if not servers:
        print(f"[proxy] IPv4 unavailable after {attempts} attempts; trying IPv6-only mode", flush=True)

    if public_listener:
        try:
            server6 = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
            server6.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server6.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            server6.bind(("::", port))
            server6.listen(256)
            servers.append(server6)
        except Exception as error:
            print(f"[proxy] IPv6 listener unavailable on {port}: {error}", flush=True)
            try: server6.close()
            except Exception: pass
    if not servers:
        raise OSError(f"unable to bind proxy port {port} on IPv4 or IPv6")
    listener_ready.set()
    while True:
        try:
            readable, _, _ = select.select(servers, [], [], 1.0)
            for server in readable:
                client, address = server.accept()
                if not CONNECTION_SLOTS.acquire(blocking=False):
                    client.close()
                    continue
                try:
                    threading.Thread(target=proxy_client, args=(client, address), daemon=True).start()
                except Exception:
                    CONNECTION_SLOTS.release()
                    client.close()
        except Exception:
            time.sleep(0.5)
