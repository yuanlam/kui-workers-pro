#!/usr/bin/env python3
from __future__ import annotations
import base64, csv, math, os, subprocess, threading, time, urllib.request, urllib.parse, json, ipaddress, hashlib, hmac, sys, re, socket, http.client
from collections import OrderedDict, deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from html.parser import HTMLParser
from pathlib import Path
from typing import NamedTuple
import proxy_server
try:
    from realtime_client import RealtimeChannel
except ImportError:
    class RealtimeChannel:
        def __init__(self, *args, **kwargs): self.connected = False; self.enabled = False; self.ever_connected = False; self.last_disconnected = 0; self.started_at = 0
        def start(self): pass
        def stop(self): pass
        def send(self, data, message_type="status"): return False


def _prefer_ipv4_create_connection(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None):
    host, port = address
    addresses = socket.getaddrinfo(host, port, socket.AF_UNSPEC, socket.SOCK_STREAM)
    addresses.sort(key=lambda item: 0 if item[0] == socket.AF_INET else 1)
    errors = []
    for family, socktype, proto, _, socket_address in addresses:
        connection = None
        try:
            connection = socket.socket(family, socktype, proto)
            if timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:
                connection.settimeout(timeout)
            if source_address:
                connection.bind(source_address)
            connection.connect(socket_address)
            return connection
        except OSError as error:
            errors.append(error)
            if connection is not None:
                connection.close()
    if errors:
        raise errors[-1]
    raise OSError("getaddrinfo returned no addresses")


class _PreferIPv4HTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = _prefer_ipv4_create_connection


class _PreferIPv4HTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, request):
        options = {}
        context = getattr(self, "_context", None)
        check_hostname = getattr(self, "_check_hostname", None)
        if context is not None:
            options["context"] = context
        if check_hostname is not None:
            options["check_hostname"] = check_hostname
        return self.do_open(_PreferIPv4HTTPSConnection, request, **options)


def _urlopen(request, timeout):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _PreferIPv4HTTPSHandler())
    return opener.open(request, timeout=timeout)


class _VPNGateIndexParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows = []
        self.current = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "tr":
            self.current = {"country": "", "detail_url": "", "text": [], "cells": []}
        elif tag == "td" and self.current is not None:
            self.current["cells"].append([])
        elif self.current is not None and tag == "img":
            match = re.search(r"/flags/([A-Za-z]{2})\.png(?:$|\?)", attrs.get("src", ""))
            if match:
                self.current["country"] = match.group(1).upper()
        elif self.current is not None and tag == "a":
            href = attrs.get("href", "")
            if "do_openvpn.aspx?" in href:
                self.current["detail_url"] = href

    def handle_data(self, data):
        if self.current is not None:
            self.current["text"].append(data)
            if self.current["cells"]:
                self.current["cells"][-1].append(data)

    def handle_endtag(self, tag):
        if tag == "tr" and self.current is not None:
            if self.current["country"] and self.current["detail_url"]:
                self.rows.append(self.current)
            self.current = None


def _parse_vpngate_index(text):
    parser = _VPNGateIndexParser()
    parser.feed(text)
    candidates = []
    for row in parser.rows:
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(row["detail_url"]).query)
        values = {key: str(query.get(key, [""])[0]) for key in ("ip", "tcp", "udp", "sid", "hid")}
        try:
            parsed_ip = ipaddress.ip_address(values["ip"])
            tcp_port = int(values["tcp"] or 0)
            udp_port = int(values["udp"] or 0)
        except ValueError:
            continue
        if parsed_ip.version != 4 or not parsed_ip.is_global:
            continue
        if not re.fullmatch(r"\d{1,20}", values["sid"]) or not re.fullmatch(r"\d{1,20}", values["hid"]):
            continue
        use_tcp = 1 <= tcp_port <= 65535
        port = tcp_port if use_tcp else udp_port
        if not 1 <= port <= 65535:
            continue
        text_content = " ".join(row["text"])
        ping_match = re.search(r"Ping:\s*(\d+)\s*ms", text_content, re.I)
        sessions_match = re.search(r"\b([\d,]+)\s+sessions?\b", text_content, re.I)
        speed_match = re.search(r"\b([\d,.]+)\s*([kmg])bps\b", text_content, re.I)
        uptime_match = re.search(r"\b([\d,]+)\s+(days?|hours?|minutes?|mins?)\b", text_content, re.I)
        last_cell = " ".join(row["cells"][-1]).strip() if row["cells"] else ""
        score = _safe_int(last_cell.replace(",", "")) if re.fullmatch(r"[\d,]+", last_cell) else 0
        speed_units = {"k": 1000, "m": 1000000, "g": 1000000000}
        uptime_units = {"day": 86400000, "hour": 3600000, "minute": 60000, "min": 60000}
        download_query = urllib.parse.urlencode({
            "sid": values["sid"],
            "tcp": "1" if use_tcp else "0",
            "host": str(parsed_ip),
            "port": str(port),
            "hid": values["hid"],
        })
        candidates.append({
            "ip": str(parsed_ip),
            "country": row["country"],
            "ping": int(ping_match.group(1)) if ping_match else 9999,
            "speed": _safe_int(_safe_float(speed_match.group(1).replace(",", "")) * speed_units[speed_match.group(2).lower()]) if speed_match else 0,
            "score": score,
            "sessions": _safe_int(sessions_match.group(1).replace(",", "")) if sessions_match else None,
            "uptime": _safe_int(uptime_match.group(1).replace(",", "")) * uptime_units[uptime_match.group(2).lower().rstrip("s")] if uptime_match else 0,
            "penalty": 0,
            "remote_proto": "tcp" if use_tcp else "udp",
            "remote_port": port,
            "download_url": f"https://www.vpngate.net/common/openvpn_download.aspx?{download_query}",
        })
    return candidates

API_URL = "https://www.vpngate.net/api/iphone/"
C2_URL = os.environ.get("C2_URL", "https://YOUR_CONTROLLER_DOMAIN")
UPDATE_ORIGIN = os.environ.get("UPDATE_ORIGIN", "")
# 控制器 API 前缀：本地 (CF Pages) 控制器为 /api/proxy；独立部署的原版控制器为 /api
C2_API_PREFIX = os.environ.get("C2_API_PREFIX", "/api/proxy")
if urllib.parse.urlsplit(C2_URL).scheme != "https":
    raise RuntimeError("C2_URL must use HTTPS")
if UPDATE_ORIGIN and urllib.parse.urlsplit(UPDATE_ORIGIN).scheme != "https":
    raise RuntimeError("UPDATE_ORIGIN must use HTTPS")
if C2_API_PREFIX not in {"/api", "/api/proxy"}:
    raise RuntimeError("invalid C2_API_PREFIX")

WORKSPACE = Path("/opt/proxy_lite")
CONFIG_DIR = WORKSPACE / "configs"
AUTH_FILE = WORKSPACE / "auth.txt"

def env_secret(name, default=""):
    encoded = os.environ.get(name + "_B64")
    if encoded:
        try: return base64.b64decode(encoded).decode("utf-8")
        except Exception: return default
    return os.environ.get(name, default)

WEB_USER = env_secret("WEB_USER", "admin")
WEB_PASS = env_secret("WEB_PASS")
AGENT_TOKEN = os.environ.get("AGENT_TOKEN", "")
if not AGENT_TOKEN:
    try: AGENT_TOKEN = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "kui", "config.json"))).get("token", "")
    except Exception: pass
VPS_IP = os.environ.get("VPS_IP", "")

PROXY_PORT = 7920
PROXY_PUBLIC_LISTENER = False
PROXY_LISTEN_HOST = "127.0.0.1"
target_country = "JP"
last_switch_trigger = 0
config_generation = 0
last_config_sync = 0
last_config_log = ""
last_update_check = 0
REALTIME_URL = os.environ.get("REALTIME_URL", "")
realtime_channel = None
config_wakeup = threading.Event()
heartbeat_wakeup = threading.Event()
pool_wakeup = threading.Event()
last_http_report = 0
last_http_report_attempt = 0
# Persist a regular HTTP snapshot even while realtime is connected. This keeps
# the dashboard usable when a Durable Object websocket reconnects or is stale.
# Realtime carries live proxy state; HTTP is only the durable fallback.
REALTIME_HTTP_INTERVAL = 300
REALTIME_STATUS_ACTIVE_INTERVAL = 5
REALTIME_STATUS_IDLE_INTERVAL = 30
realtime_status_interval = REALTIME_STATUS_ACTIVE_INTERVAL
C2_REQUEST_TIMEOUT = 12
C2_REQUEST_ATTEMPTS = 3
CONTROL_FAILURE_LOG_INTERVAL = 1800
http_report_lock = threading.Lock()
control_health = {
    "config": {"failures": 0, "last_log": 0, "logged": False},
    "report": {"failures": 0, "last_log": 0, "logged": False},
}

def normalize_listener_host(value):
    """Accept only a concrete IPv4 address for private bridge binding."""
    host = str(value or "").strip()
    if not host:
        return "127.0.0.1"
    try:
        parsed = ipaddress.ip_address(host)
        if parsed.version != 4 or parsed.is_unspecified:
            return "127.0.0.1"
        return str(parsed)
    except ValueError:
        return "127.0.0.1"

state_lock = threading.Lock()
dead_ips = set()
dead_ips_lock = threading.Lock()
last_blacklist_clear = time.time()
public_ip = ""
_tun_io_locks = {"tun_main": threading.RLock(), "tun_backup": threading.RLock()}
_tun_io_locks_guard = threading.Lock()
quality_cache = OrderedDict()
quality_cache_lock = threading.Lock()
QUALITY_CACHE_MAX_ENTRIES = 1024
MIN_THROUGHPUT_SAMPLE_BYTES = 4096

global_node_reservoir = {} 
reservoir_lock = threading.Lock()
last_reservoir_log_count = None
last_empty_candidate_log = 0
html_fallback_cache = {}
last_vpngate_source_log = 0
VPNGATE_HTML_FALLBACK_INTERVAL = 1800
VPNGATE_HTML_FALLBACK_LIMIT = 8
TESTISP_CACHE_TTL = 1800
TESTISP_CACHE_MAX_ENTRIES = 512
testisp_cache = OrderedDict()
testisp_cache_lock = threading.Lock()
MIN_TUNNEL_SPEED_KBPS = 150
BACKUP_RACE_INTERVAL = 900
BACKUP_RACE_MIN_SCORE_GAIN = 25.0
TCP_PROBE_CACHE_SECONDS = 180


def _is_dead_ip(ip: str) -> bool:
    if not ip:
        return False
    with dead_ips_lock:
        return ip in dead_ips


def _mark_dead_ip(ip: str) -> None:
    if not ip:
        return
    with dead_ips_lock:
        dead_ips.add(ip)


def _clear_dead_ips() -> None:
    with dead_ips_lock:
        dead_ips.clear()


def _dead_ips_count() -> int:
    with dead_ips_lock:
        return len(dead_ips)


def _safe_int(value, default: int = 0) -> int:
    try:
        return int(float(str(value).strip()))
    except (TypeError, ValueError, OverflowError):
        return default


def _safe_float(value, default: float = 0.0) -> float:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError, OverflowError):
        return default


def _min_tunnel_speed_kbps() -> int:
    try:
        return max(0, int(os.environ.get("MIN_TUNNEL_SPEED_KBPS", MIN_TUNNEL_SPEED_KBPS)))
    except (TypeError, ValueError):
        return MIN_TUNNEL_SPEED_KBPS


def _backup_race_interval() -> int:
    try:
        return max(0, int(os.environ.get("BACKUP_RACE_INTERVAL", BACKUP_RACE_INTERVAL)))
    except (TypeError, ValueError):
        return BACKUP_RACE_INTERVAL


def _tunnel_io_lock(tun: "Tunnel") -> threading.Lock:
    name = getattr(tun, "name", "")
    with _tun_io_locks_guard:
        return _tun_io_locks.setdefault(name, threading.RLock())


@contextmanager
def _lock_tunnel_io(*tunnels):
    """Acquire physical-interface locks in a stable order."""
    with _tun_io_locks_guard:
        locks = [
            _tun_io_locks.setdefault(name, threading.RLock())
            for name in sorted({tun.name for tun in tunnels})
        ]
    for lock in locks:
        lock.acquire()
    try:
        yield
    finally:
        for lock in reversed(locks):
            lock.release()


def _clear_quality_cache() -> None:
    with quality_cache_lock:
        quality_cache.clear()


def _record_measured_quality(ip: str, ttfb_ms: int, speed_kbps: int, measured_at=None, node=None) -> None:
    if not ip:
        return
    measured_at = time.time() if measured_at is None else measured_at
    entry = {
        "ttfb_ms": max(0, int(ttfb_ms)),
        "speed_kbps": max(0, int(speed_kbps)),
        "measured_at": float(measured_at),
    }
    with quality_cache_lock:
        quality_cache[ip] = entry
        quality_cache.move_to_end(ip)
        while len(quality_cache) > QUALITY_CACHE_MAX_ENTRIES:
            quality_cache.popitem(last=False)
    with reservoir_lock:
        stored_node = global_node_reservoir.get(ip)
        if stored_node is not None:
            stored_node.update(
                {
                    "ttfb_ms": entry["ttfb_ms"],
                    "speed_kbps": entry["speed_kbps"],
                    "quality_measured_at": entry["measured_at"],
                }
            )
        if node is not None:
            node.update(
                {
                    "ttfb_ms": entry["ttfb_ms"],
                    "speed_kbps": entry["speed_kbps"],
                    "quality_measured_at": entry["measured_at"],
                }
            )


def _get_measured_quality(ip: str) -> dict | None:
    if not ip:
        return None
    with quality_cache_lock:
        entry = quality_cache.get(ip)
        return dict(entry) if entry is not None else None


class Tunnel:
    def __init__(self, name: str, table_id: int):
        self.name = name
        self.table_id = table_id
        self.process = None
        self.node = None
        self.entry_ip = ""
        self.egress_ip = ""
        self.country = ""
        self.ready = False
        self.connected_at = 0
        self.is_connecting = False
        self.ttfb_ms = 0
        self.speed_kbps = 0
        self.dial_token = 0
        self.slot_owner: tuple[int, int] | None = None
        self.io_lock = _tunnel_io_lock(self)

    @property
    def proc(self):
        return self.process

    @proc.setter
    def proc(self, value):
        self.process = value

    @property
    def connect_token(self):
        return self.dial_token

    @connect_token.setter
    def connect_token(self, value):
        self.dial_token = value


class TunnelQuality(NamedTuple):
    ttfb_ms: int
    speed_kbps: int

# Use dedicated high-numbered tables. The old 101/102 tables and preferences
# overlap with policy routing installed by several cloud images and could
# remove the VPS public return route, immediately breaking SSH.
KUI_ROUTE_TABLES = {"tun_main": 20101, "tun_backup": 20102}
LEGACY_KUI_ROUTE_TABLES = {"tun_main": 101, "tun_backup": 102}
tun_main = Tunnel("tun_main", KUI_ROUTE_TABLES["tun_main"])
tun_backup = Tunnel("tun_backup", KUI_ROUTE_TABLES["tun_backup"])


def _openvpn_remote_meta(config: str) -> tuple[str, int]:
    proto = "udp"
    port = 1194
    for line in str(config or "").splitlines():
        parts = line.split()
        if not parts:
            continue
        directive = parts[0].lower()
        if directive == "remote" and len(parts) >= 3:
            candidate_port = _safe_int(parts[2], 0)
            if 1 <= candidate_port <= 65535:
                port = candidate_port
        elif directive == "proto" and len(parts) >= 2:
            value = parts[1].lower()
            if value.startswith("tcp"):
                proto = "tcp"
            elif value.startswith("udp"):
                proto = "udp"
    return proto, port


def compute_candidate_score(node: dict, include_measured: bool = True) -> float:
    """Rank a VPNGate candidate without performing any network I/O."""
    node = node or {}
    speed_mbps = min(1000.0, max(0.0, _safe_float(node.get("speed")) / 1_000_000.0))
    speed_component = speed_mbps * 0.3

    raw_score = max(0.0, _safe_float(node.get("score")))
    score_component = math.log1p(raw_score) * 8.0

    entry_rtt = _safe_float(node.get("entry_rtt_ms"))
    rtt = entry_rtt if entry_rtt > 0 else _safe_float(node.get("ping"), 9999.0)
    rtt_component = 300.0 * (50.0 / max(50.0, rtt))

    sessions = max(0, _safe_int(node.get("sessions"), 20))
    session_component = -min(80.0, math.log1p(sessions) * 8.0)

    measured = _get_measured_quality(str(node.get("ip") or ""))
    ttfb_ms = (
        _safe_float(measured.get("ttfb_ms"))
        if measured and "ttfb_ms" in measured
        else _safe_float(node.get("ttfb_ms"))
    )
    ttfb_component = min(120.0, 12000.0 / max(100.0, ttfb_ms)) if include_measured and ttfb_ms > 0 else 0.0

    speed_kbps = max(
        0.0,
        _safe_float(
            measured.get("speed_kbps")
            if measured and "speed_kbps" in measured
            else node.get("speed_kbps")
        ),
    )
    measured_component = min(500.0, speed_kbps / 10.0) if include_measured else 0.0
    uptime_days = max(0.0, _safe_float(node.get("uptime")) / 86400000.0)
    uptime_component = min(20.0, math.log1p(uptime_days) * 5.0)

    penalty_component = -max(0.0, _safe_float(node.get("penalty")))
    return (
        speed_component
        + score_component
        + rtt_component
        + session_component
        + ttfb_component
        + measured_component
        + uptime_component
        + penalty_component
    )


def probe_entry_tcp(ip: str, port: int, timeout: float = 1.5) -> float | None:
    """Return TCP handshake RTT in milliseconds, or None when unreachable."""
    try:
        target_port = int(port)
        if not 1 <= target_port <= 65535:
            return None
        started = time.perf_counter()
        with socket.create_connection((str(ip), target_port), timeout=timeout):
            return max(0.0, (time.perf_counter() - started) * 1000.0)
    except (OSError, ValueError, TypeError):
        return None


def probe_candidates_entry_rtt(candidates, max_probe: int = 8, timeout: float = 1.5):
    """Probe stale TCP entry points concurrently and write results back."""
    if max_probe <= 0:
        return candidates
    now = time.time()
    pending = []
    for node in candidates:
        proto = str(node.get("remote_proto") or "").lower()
        if proto != "tcp":
            continue
        if _tcp_failure_cached(node, now):
            continue
        port = _safe_int(node.get("remote_port"), 0)
        if not 1 <= port <= 65535:
            continue
        probed_at = _safe_float(node.get("entry_probed_at"))
        if probed_at > 0 and now - probed_at <= TCP_PROBE_CACHE_SECONDS:
            continue
        pending.append(node)
        if len(pending) >= max_probe:
            break

    def probe(node):
        rtt = probe_entry_tcp(node.get("ip", ""), node.get("remote_port", 0), timeout=timeout)
        with reservoir_lock:
            node["entry_rtt_ms"] = rtt
            node["entry_probed_at"] = time.time()
            node["entry_reachable"] = rtt is not None
        if rtt is None:
            penalize_node(node.get("ip", ""), 1500)
        return node

    if pending:
        with ThreadPoolExecutor(max_workers=4) as executor:
            list(executor.map(probe, pending))
    return candidates


def _tcp_failure_cached(node: dict, now=None) -> bool:
    if node.get("entry_reachable") is not False:
        return False
    now = time.time() if now is None else now
    probed_at = _safe_float(node.get("entry_probed_at"))
    return probed_at > 0 and now - probed_at <= TCP_PROBE_CACHE_SECONDS


def _terminate_process(process, timeout: float = 2.0) -> None:
    if process is None:
        return
    try:
        process.terminate()
        process.wait(timeout)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


def _reset_tunnel_state(tun: Tunnel) -> None:
    tun.ready = False
    tun.process = None
    tun.node = None
    tun.entry_ip = ""
    tun.egress_ip = ""
    tun.country = ""
    tun.connected_at = 0
    tun.is_connecting = False
    tun.ttfb_ms = 0
    tun.speed_kbps = 0
    tun.dial_token += 1
    tun.slot_owner = None


def _dial_owns_slot_locked(tun: Tunnel, generation: int, token: int) -> bool:
    return (
        generation == config_generation
        and tun.dial_token == token
        and tun.slot_owner == (generation, token)
    )


def _dial_is_current_locked(tun: Tunnel, generation: int, token: int, process) -> bool:
    return (
        _dial_owns_slot_locked(tun, generation, token)
        and tun.process is process
        and process is not None
        and process.poll() is None
    )


def _dial_owns_process_locked(tun: Tunnel, generation: int, token: int, process) -> bool:
    """Check ownership even after the child exited; exit is not cancellation."""
    return (
        _dial_owns_slot_locked(tun, generation, token)
        and tun.process is process
        and process is not None
    )


def _dial_is_current(tun: Tunnel, generation: int, token: int, process) -> bool:
    with state_lock:
        return _dial_is_current_locked(tun, generation, token, process)


def _dial_context_is_current_locked(
    tun: Tunnel,
    generation: int,
    token: int,
    expected_country: str | None = None,
    expected_role: str | None = None,
) -> bool:
    if generation != config_generation or tun.dial_token != token:
        return False
    if expected_country is not None and target_country != "ANY":
        if expected_country not in ("ANY", target_country):
            return False
    if expected_role is not None:
        if expected_role == "main":
            if tun is not tun_main:
                return False
        elif expected_role == "backup":
            if tun is not tun_backup:
                return False
        else:
            return False
    return True


def _dial_context_is_current(tun: Tunnel, generation: int, token: int) -> bool:
    with state_lock:
        return _dial_context_is_current_locked(tun, generation, token)


def _dial_slot_is_reserved_locked(
    tun: Tunnel,
    generation: int,
    token: int,
    expected_country: str | None = None,
    expected_role: str | None = None,
) -> bool:
    return (
        _dial_context_is_current_locked(
            tun,
            generation,
            token,
            expected_country=expected_country,
            expected_role=expected_role,
        )
        and tun.is_connecting
        and tun.process is None
        and not tun.ready
        and tun.slot_owner == (generation, token)
    )


def _dial_matches_policy_locked(tun: Tunnel, generation: int, token: int, process, node=None) -> bool:
    if not _dial_owns_process_locked(tun, generation, token, process):
        return False
    return node is None or target_country == "ANY" or node.get("country") == target_country


def _dial_matches_policy(tun: Tunnel, generation: int, token: int, process, node=None) -> bool:
    with state_lock:
        return _dial_matches_policy_locked(tun, generation, token, process, node)


def _peer_tunnel_locked(tun: Tunnel) -> Tunnel | None:
    if tun is tun_main:
        return tun_backup
    if tun is tun_backup:
        return tun_main
    return None


def _peer_reservation_conflicts_locked(tun: Tunnel, candidate_ip: str) -> bool:
    """Check peer entry/egress occupancy; caller must hold state_lock."""
    peer = _peer_tunnel_locked(tun)
    if peer is None or not candidate_ip:
        return False
    if not (peer.ready or peer.is_connecting):
        return False
    return candidate_ip in {peer.entry_ip, peer.egress_ip}


def _tunnel_ip_conflicts_locked(
    tun: Tunnel,
    entry_ip: str,
    egress_ip: str,
) -> bool:
    """Check overlapping entry/egress pairs; caller holds state_lock."""
    peer = _peer_tunnel_locked(tun)
    if peer is None or not (peer.ready or peer.is_connecting):
        return False
    own_ips = {ip for ip in (entry_ip, egress_ip) if ip}
    peer_ips = {ip for ip in (peer.entry_ip, peer.egress_ip) if ip}
    return bool(own_ips & peer_ips)


def _dial_loses_ip_conflict_locked(tun: Tunnel) -> bool:
    """Choose one conflicting dial without tearing down a healthy peer."""
    peer = _peer_tunnel_locked(tun)
    if peer is None:
        return True
    # A ready tunnel with a live process remains the protected side even
    # while is_connecting is still set for post-ready DNS cleanup.
    peer_healthy = peer.ready and _process_is_alive(peer.process)
    if peer_healthy:
        return True
    if tun is tun_main and peer is tun_backup:
        return False
    if tun is tun_backup and peer is tun_main:
        return True
    return str(tun.name or "") > str(peer.name or "")


def _dial_side_effects(
    tun: Tunnel,
    generation: int,
    token: int,
    process=None,
    expected_country: str | None = None,
    expected_role: str | None = None,
):
    """Serialize tunnel I/O and re-check ownership before each side effect."""
    lock = _tunnel_io_lock(tun)
    acquired = False
    try:
        lock.acquire()
        acquired = True
        with state_lock:
            if process is not None:
                current = _dial_owns_process_locked(tun, generation, token, process)
            else:
                current = (
                    _dial_context_is_current_locked(
                        tun,
                        generation,
                        token,
                        expected_country=expected_country,
                        expected_role=expected_role,
                    )
                    and tun.is_connecting
                    and tun.process is None
                    and not tun.ready
                    and tun.slot_owner in (None, (generation, token))
                )
            if not current:
                lock.release()
                return None
        return lock
    except BaseException:
        if acquired:
            lock.release()
        raise


def _reserve_dial_slot(
    tun: Tunnel,
    generation: int,
    token: int,
    node: dict,
    expected_country: str | None = None,
    expected_role: str | None = None,
) -> bool:
    """Reserve the slot for this dial, or confirm this dial already owns it."""
    with state_lock:
        if not _dial_context_is_current_locked(
            tun,
            generation,
            token,
            expected_country=expected_country,
            expected_role=expected_role,
        ):
            return False
        if not _matches_target_country(node):
            return False
        node_ip = str(node.get("ip") or "")
        peer = _peer_tunnel_locked(tun)
        if (
            peer is not None
            and (peer.ready or peer.is_connecting)
            and node_ip in {ip for ip in (peer.entry_ip, peer.egress_ip) if ip}
        ):
            pool_wakeup.set()
            return False
        if tun.ready or tun.process is not None:
            return False
        if not tun.is_connecting:
            if tun.entry_ip or tun.slot_owner is not None:
                return False
            tun.is_connecting = True
        if tun.slot_owner not in (None, (generation, token)):
            return False
        tun.entry_ip = node["ip"]
        tun.slot_owner = (generation, token)
        return True


def _register_dial_process(tun: Tunnel, generation: int, token: int, process) -> bool:
    """Atomically publish a freshly spawned process or reject it."""
    with state_lock:
        if not _dial_owns_slot_locked(tun, generation, token):
            return False
        if tun.ready or tun.process is not None:
            return False
        tun.process = process
        return _dial_owns_process_locked(tun, generation, token, process)


def _clear_dial_slot_if_current(tun: Tunnel, generation: int, token: int) -> bool:
    """Release the reserved dial slot unless a newer dial now owns it."""
    with state_lock:
        if not _dial_slot_is_reserved_locked(tun, generation, token):
            return False
        tun.is_connecting = False
        tun.entry_ip = ""
        tun.slot_owner = None
        return True


def _release_unowned_dial_slot(tun: Tunnel, generation: int, token: int) -> bool:
    """Release a pre-reserved slot after rejecting its stale dial context."""
    with state_lock:
        owns_this_slot = tun.slot_owner == (generation, token)
        if (
            tun.dial_token != token
            or tun.process is not None
            or tun.ready
            or not tun.is_connecting
            or (tun.slot_owner is not None and not owns_this_slot)
        ):
            return False
        tun.is_connecting = False
        tun.entry_ip = ""
        tun.slot_owner = None
        return True


def _tunnel_has_routing(tun: Tunnel, process) -> bool:
    return bool(process is not None and getattr(process, "_kui_routing_installed", False))


def _terminate_dial_process(tun: Tunnel, process) -> None:
    if process is None:
        return
    with _tunnel_io_lock(tun):
        _terminate_process(process)


def _retire_tunnel_unlocked(
    tun: Tunnel,
    process,
    *,
    cleanup_routes: bool = True,
    require_idle: bool = False,
    expected_generation: int | None = None,
    expected_backup: bool = False,
    extra_check=None,
    terminate_exited: bool = False,
) -> bool:
    """Retire a tunnel while its physical-interface lock is held."""
    with state_lock:
        if expected_backup and tun is not tun_backup:
            return False
        if expected_generation is not None and config_generation != expected_generation:
            return False
        if require_idle and tun.is_connecting:
            return False
        if process is None:
            if tun.process is not None:
                return False
            owns_process = True
            already_exited = False
        elif tun.process is not process:
            owns_process = False
            already_exited = False
        else:
            owns_process = True
            already_exited = process.poll() is not None
        if extra_check is not None and not extra_check(already_exited):
            return False
        should_terminate = owns_process and (not already_exited or terminate_exited)
        if owns_process and not already_exited:
            tun.dial_token += 1
            tun.ready = False
            tun.is_connecting = True
    if should_terminate:
        _terminate_process(process)
    if not owns_process:
        return False
    if cleanup_routes:
        _cleanup_tunnel_routing(tun.name, tun.table_id, tun.table_id + 10000, tun.table_id + 11000)
    with state_lock:
        if tun.process is not process:
            return False
        _reset_tunnel_state(tun)
        if hasattr(proxy_server, "clear_dns_cache"):
            proxy_server.clear_dns_cache(tun.name)
    return True


def _retire_tunnel(
    tun: Tunnel,
    process,
    *,
    cleanup_routes: bool = True,
    require_idle: bool = False,
    expected_generation: int | None = None,
    expected_backup: bool = False,
    extra_check=None,
    terminate_exited: bool = False,
) -> bool:
    with _tunnel_io_lock(tun):
        return _retire_tunnel_unlocked(
            tun,
            process,
            cleanup_routes=cleanup_routes,
            require_idle=require_idle,
            expected_generation=expected_generation,
            expected_backup=expected_backup,
            extra_check=extra_check,
            terminate_exited=terminate_exited,
        )


def _abandon_tunnel(tun: Tunnel, process) -> bool:
    return _retire_tunnel(tun, process)


def _discard_dial_process(tun: Tunnel, process) -> None:
    """Terminate a dial process that never installed routing."""
    if process is None:
        return
    with _tunnel_io_lock(tun):
        with state_lock:
            owns_process = tun.process is process
            routeless = not _tunnel_has_routing(tun, process)
        if not owns_process:
            _terminate_process(process)
            return
        _retire_tunnel_unlocked(
            tun,
            process,
            cleanup_routes=not routeless,
            extra_check=lambda already_exited: True,
            terminate_exited=True,
        )


def _discard_conflicting_dial(tun: Tunnel, process, generation: int, token: int, *ips: str) -> bool:
    """Retire only if this exact dial still owns the conflicting tunnel."""
    with _tunnel_io_lock(tun):
        with state_lock:
            if not _dial_owns_process_locked(tun, generation, token, process):
                return False
            if not _tunnel_ip_conflicts_locked(tun, *ips):
                return False
            routeless = not _tunnel_has_routing(tun, process)
        if routeless:
            _discard_dial_process(tun, process)
        else:
            _retire_tunnel_unlocked(
                tun,
                process,
                cleanup_routes=True,
                extra_check=lambda already_exited: True,
                terminate_exited=True,
            )
        return True


def _mark_node_attempted(ip: str) -> None:
    if not ip:
        return
    with reservoir_lock:
        node = global_node_reservoir.get(ip)
        if node is not None:
            node["last_attempted_at"] = time.time()


def _matches_target_country(node: dict) -> bool:
    return target_country == "ANY" or node.get("country") == target_country


def _is_dialable_candidate(node: dict, occupied_ips: set[str], require_untried: bool = False) -> bool:
    node_ip = str(node.get("ip") or "")
    if not node_ip or node_ip in occupied_ips or _is_dead_ip(node_ip):
        return False
    if not _matches_target_country(node):
        return False
    if require_untried and node.get("last_attempted_at"):
        return False
    return True


def _reservoir_nodes() -> list[dict]:
    with reservoir_lock:
        return list(global_node_reservoir.values())


def _has_other_country_candidate(ip: str, country: str = "") -> bool:
    occupied_ips = _occupied_tunnel_ips()
    now = time.time()
    for node in _reservoir_nodes():
        if node.get("ip") == ip:
            continue
        if _tcp_failure_cached(node, now):
            continue
        if _is_dialable_candidate(node, occupied_ips):
            return True
    return False


def _race_score_gain(candidate: dict, backup: dict) -> float:
    def has_quality(node):
        quality = _get_measured_quality(str(node.get("ip") or "")) or node
        return _safe_float(quality.get("ttfb_ms")) > 0 and _safe_float(quality.get("speed_kbps")) > 0

    include_measured = has_quality(candidate) and has_quality(backup)
    return compute_candidate_score(candidate, include_measured) - compute_candidate_score(backup, include_measured)


def _has_untried_higher_candidate(backup_tun: Tunnel) -> bool:
    """Return whether a higher-scored untried candidate exists.

    This compatibility helper only checks the non-network portion. Pool
    maintenance uses _has_viable_higher_candidate so TCP failures and
    unreachable replacements cannot cause a healthy backup to be recycled.
    """
    backup_node = backup_tun.node or {}
    occupied_ips = _occupied_tunnel_ips()
    for node in _reservoir_nodes():
        if not _is_dialable_candidate(node, occupied_ips, require_untried=True):
            continue
        if _tcp_failure_cached(node):
            continue
        if _race_score_gain(node, backup_node) > BACKUP_RACE_MIN_SCORE_GAIN:
            return True
    return False


def _has_viable_higher_candidate(backup_tun: Tunnel) -> bool:
    """Confirm a higher-scored replacement has positive reachability evidence."""
    return _select_viable_higher_candidate(backup_tun) is not None


def _is_verified_tcp_race_candidate(
    node: dict,
    backup_tun: Tunnel,
    occupied_ips: set[str] | None = None,
    now: float | None = None,
) -> bool:
    """Require fresh positive TCP evidence before retiring a healthy backup."""
    if not node:
        return False
    if str(node.get("remote_proto") or "").lower() != "tcp":
        return False
    if node.get("entry_reachable") is not True:
        return False
    now = time.time() if now is None else now
    probed_at = _safe_float(node.get("entry_probed_at"))
    if probed_at <= 0 or now - probed_at > TCP_PROBE_CACHE_SECONDS:
        return False
    occupied_ips = _occupied_tunnel_ips() if occupied_ips is None else occupied_ips
    if not _is_dialable_candidate(node, occupied_ips, require_untried=True):
        return False
    return _race_score_gain(node, backup_tun.node or {}) > BACKUP_RACE_MIN_SCORE_GAIN


def _select_viable_higher_candidate(backup_tun: Tunnel) -> dict | None:
    """Probe Top-N replacements and return the best TCP-verified node."""
    backup_node = backup_tun.node or {}
    occupied_ips = _occupied_tunnel_ips()
    candidates = []
    for node in _reservoir_nodes():
        if not _is_dialable_candidate(node, occupied_ips, require_untried=True):
            continue
        if _tcp_failure_cached(node):
            continue
        probed_at = _safe_float(node.get("entry_probed_at"))
        if probed_at > 0 and time.time() - probed_at <= TCP_PROBE_CACHE_SECONDS and _race_score_gain(node, backup_node) <= BACKUP_RACE_MIN_SCORE_GAIN:
            continue
        candidates.append(node)
    if not candidates:
        return None
    tcp_candidates = [
        node for node in candidates
        if str(node.get("remote_proto") or "").lower() == "tcp"
        and 1 <= _safe_int(node.get("remote_port"), 0) <= 65535
    ]
    ranked = sorted(tcp_candidates, key=lambda node: _race_score_gain(node, backup_node), reverse=True)[:8]
    probe_candidates_entry_rtt(ranked, max_probe=8)
    occupied_ips = _occupied_tunnel_ips()
    now = time.time()
    verified = [node for node in ranked if _is_verified_tcp_race_candidate(node, backup_tun, occupied_ips, now)]
    return max(verified, key=lambda node: _race_score_gain(node, backup_node), default=None)


def _occupied_tunnel_ips() -> set[str]:
    with state_lock:
        return {
            ip
            for tun in (tun_main, tun_backup)
            for ip in (tun.entry_ip, tun.egress_ip)
            if ip
        }


def _process_is_alive(process) -> bool:
    return process is not None and process.poll() is None


def should_promote_backup(main_tun: Tunnel, backup_tun: Tunnel, now=None, cooldown: int = 60) -> bool:
    """Apply hysteresis before promoting a merely slightly better backup."""
    if now is None:
        now = time.time()
    if not main_tun.ready or not backup_tun.ready:
        return False
    if main_tun.is_connecting or backup_tun.is_connecting:
        return False
    if not _process_is_alive(main_tun.process) or not _process_is_alive(backup_tun.process):
        return False
    if target_country != "ANY":
        if (
            not main_tun.country
            or main_tun.country != target_country
            or backup_tun.country != target_country
        ):
            return False
    if now - _safe_float(main_tun.connected_at) < cooldown:
        return False

    main_speed = max(0.0, _safe_float(main_tun.speed_kbps))
    backup_speed = max(0.0, _safe_float(backup_tun.speed_kbps))
    main_ttfb = max(0.0, _safe_float(main_tun.ttfb_ms))
    backup_ttfb = max(0.0, _safe_float(backup_tun.ttfb_ms))
    if main_speed > 0 and backup_speed > 0:
        return (
            backup_speed >= main_speed * 1.35
            and (main_ttfb <= 0 or backup_ttfb <= main_ttfb + 150)
        )
    if main_ttfb > 0 and backup_ttfb > 0:
        return (
            main_ttfb - backup_ttfb >= 150
            and backup_ttfb <= main_ttfb * 0.7
        )
    return False


def _cache_testisp_result(ip: str, data: dict) -> None:
    with testisp_cache_lock:
        testisp_cache[ip] = (time.time(), data)
        testisp_cache.move_to_end(ip)
        while len(testisp_cache) > TESTISP_CACHE_MAX_ENTRIES:
            testisp_cache.popitem(last=False)


def _clear_testisp_cache() -> None:
    with testisp_cache_lock:
        testisp_cache.clear()


def _testisp_lookup(ip: str, timeout: int = 10) -> dict:
    now = time.time()
    with testisp_cache_lock:
        cached = testisp_cache.get(ip)
        if cached and now - cached[0] < TESTISP_CACHE_TTL:
            testisp_cache.move_to_end(ip)
            return cached[1]
        if cached:
            testisp_cache.pop(ip, None)
    req_url = f"https://testisp.info/api/check?ip={ip}"
    request = urllib.request.Request(
        req_url,
        headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
        method="GET",
    )
    with _urlopen(request, timeout=timeout) as response:
        data = json.loads(response.read().decode("utf-8"))
    if isinstance(data, dict):
        _cache_testisp_result(ip, data)
    return data


def _tunnel_context(tun_name: str) -> tuple[str, str]:
    with state_lock:
        for tun in (tun_main, tun_backup):
            if tun.name == tun_name:
                return tun.entry_ip, tun.country or target_country
    return "", target_country


def probe_tunnel_quality(tun_name: str, node_ip: str = "", country: str = "") -> TunnelQuality | None:
    """Measure streaming reachability and a bounded 256 KiB throughput sample."""
    stream_urls = [
        "https://www.youtube.com",
        "https://www.gstatic.com/generate_204",
        "https://cp.cloudflare.com/generate_204",
        "https://www.google.com/robots.txt",
    ]

    def check_stream(url):
        try:
            result = subprocess.run(
                [
                    "curl", "-o", "/dev/null", "-s", "-w", "%{http_code} %{time_starttransfer}",
                    "-A", "Mozilla/5.0", "-m", "5", "--interface", tun_name, url,
                ],
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                return None
            parts = str(result.stdout).strip().split()
            if len(parts) < 2:
                return None
            code = _safe_int(parts[0], 0)
            ttfb = _safe_float(parts[1], -1.0)
            if not 100 <= code < 600 or ttfb < 0:
                return None
            return ttfb * 1000.0
        except Exception:
            return None

    with ThreadPoolExecutor(max_workers=4) as executor:
        measured = [value for value in executor.map(check_stream, stream_urls) if value is not None]

    resolved_ip = node_ip
    resolved_country = country
    if not resolved_ip:
        resolved_ip, resolved_country = _tunnel_context(tun_name)
    if not measured:
        penalize_node(resolved_ip, 3000)
        return None
    ttfb_ms = int(round(min(measured)))

    speed_kbps = 0
    throughput_valid = False
    try:
        speed_result = subprocess.run(
            [
                "curl", "-o", "/dev/null", "-s",
                "-w", "\n%{http_code} %{size_download} %{time_total}",
                "-A", "Mozilla/5.0", "-m", "6", "--interface", tun_name,
                "https://speed.cloudflare.com/__down?bytes=262144",
            ],
            capture_output=True,
            text=True,
        )
        parts = str(speed_result.stdout or "").strip().splitlines()
        if parts:
            metrics = parts[-1].split()
            if len(metrics) == 1:
                bytes_per_second = _safe_float(metrics[0], 0.0)
                if bytes_per_second > 0:
                    speed_kbps = int(round(bytes_per_second * 8.0 / 1000.0))
                    throughput_valid = True
            elif len(metrics) == 3:
                code = _safe_int(metrics[0], 0)
                size_download = _safe_float(metrics[1], 0.0)
                time_total = _safe_float(metrics[2], 0.0)
                if (
                    code in (200, 206)
                    and size_download >= MIN_THROUGHPUT_SAMPLE_BYTES
                    and time_total > 0
                ):
                    speed_kbps = int(round((size_download * 8.0) / (time_total * 1000.0)))
                    throughput_valid = True
    except Exception:
        speed_kbps = 0

    if _has_other_country_candidate(resolved_ip, resolved_country):
        if not throughput_valid or speed_kbps < _min_tunnel_speed_kbps():
            penalize_node(resolved_ip, 2000)
            _mark_dead_ip(resolved_ip)
            return None
    return TunnelQuality(ttfb_ms, speed_kbps)


def penalize_node(ip: str, penalty: int):
    """
    节点信誉动态降级机制：
    给不可用或低质的节点加上高额的虚拟 ping 值惩罚，
    确保下一次调度排序时，该节点被永久压入蓄水池底部，从而避免"死循环假性枯竭"。
    """
    with reservoir_lock:
        if ip in global_node_reservoir:
            node = global_node_reservoir[ip]
            node["penalty"] = _safe_int(node.get("penalty")) + penalty
            node["ping"] = _safe_int(node.get("ping"), 9999) + penalty

def get_public_ip():
    global public_ip
    try:
        req = urllib.request.Request("https://api.ipify.org", headers={"User-Agent": "curl/7.68.0"})
        with _urlopen(req, timeout=5) as res:
            public_ip = res.read().decode("utf-8").strip()
        if public_ip and ':' in public_ip:
            raise ValueError("Got IPv6")
    except:
        try:
            req = urllib.request.Request("https://api.ipify.org?format=text",
                                          headers={"User-Agent": "curl/7.68.0"})
            with _urlopen(req, timeout=5) as res:
                public_ip = res.read().decode("utf-8").strip()
        except:
            public_ip = "Unknown_IP"

def get_c2_headers():
    if AGENT_TOKEN:
        return {"User-Agent": "KUI-Residential-Agent/2.0", "Authorization": AGENT_TOKEN}
    auth_ptr = base64.b64encode(f"{WEB_USER}:{WEB_PASS}".encode()).decode()
    return {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Authorization": f"Basic {auth_ptr}"
    }

def c2_request(url, *, data=None, method=None):
    """Retry transient Cloudflare/control-plane read stalls before failing."""
    last_error = None
    for attempt in range(C2_REQUEST_ATTEMPTS):
        try:
            request = urllib.request.Request(url, data=data, headers=get_c2_headers(), method=method)
            with _urlopen(request, timeout=C2_REQUEST_TIMEOUT) as response:
                return response.read()
        except Exception as error:
            last_error = error
            if attempt < C2_REQUEST_ATTEMPTS - 1: time.sleep(2 ** attempt)
    raise last_error

def record_control_failure(kind, error, realtime_ok=False):
    state = control_health[kind]
    state["failures"] += 1
    threshold = 3 if kind == "report" and realtime_ok else 1
    now = time.time()
    if state["failures"] < threshold:
        return
    if state["failures"] > threshold and now - state["last_log"] < CONTROL_FAILURE_LOG_INTERVAL:
        return
    state["last_log"] = now
    state["logged"] = True
    if kind == "config":
        print(f"[cfg] 控制面暂时不可达，继续使用上次配置 (连续 {state['failures']} 次): {error}", flush=True)
    elif realtime_ok:
        print(f"[c2] HTTP 快照连续失败 {state['failures']} 次，Realtime 状态通道仍正常: {error}", flush=True)
    else:
        print(f"[c2] 状态上报失败 (连续 {state['failures']} 次): {error}", flush=True)

def record_control_success(kind):
    state = control_health[kind]
    if state["logged"]:
        label = "配置同步" if kind == "config" else "HTTP 状态上报"
        print(f"[{('cfg' if kind == 'config' else 'c2')}] {label}已恢复", flush=True)
    state.update({"failures": 0, "last_log": 0, "logged": False})

def submit_http_report(status, background=False):
    """Serialize HTTP snapshots and keep them off the realtime heartbeat path."""
    global last_http_report, last_http_report_attempt
    if not http_report_lock.acquire(blocking=False):
        return False
    last_http_report_attempt = time.time()
    realtime_ok = background

    def send():
        global last_http_report
        try:
            c2_request(f"{C2_URL}{C2_API_PREFIX}/report", data=json.dumps(status).encode("utf-8"), method="POST")
            last_http_report = time.time()
            record_control_success("report")
        except Exception as error:
            record_control_failure("report", error, realtime_ok=realtime_ok)
        finally:
            http_report_lock.release()

    if background:
        threading.Thread(target=send, daemon=True).start()
    else:
        send()
    return True

def check_for_updates():
    global last_update_check
    if os.environ.get("KUI_DISABLE_AUTO_UPDATE") == "1":
        return
    now = time.time()
    if not AGENT_TOKEN or now - last_update_check < 3600:
        return
    last_update_check = now
    components = (("realtime-client", (Path(__file__).parent / "realtime_client.py").resolve()), ("proxy-manager", Path(__file__).resolve()), ("proxy-server", (Path(__file__).parent / "proxy_server.py").resolve()))
    staged = []
    temporary_files = []
    try:
        for component, target in components:
            if not UPDATE_ORIGIN: raise ValueError("UPDATE_OR is required for updates")
            url = f"{UPDATE_ORIGIN.rstrip('/')}/api/agent_update?ip={urllib.parse.quote(VPS_IP, safe='')}&component={component}"
            request = urllib.request.Request(url, headers=get_c2_headers())
            with _urlopen(request, timeout=20) as response:
                source = response.read(2 * 1024 * 1024 + 1)
                expected = response.headers.get("X-Agent-SHA256", "").lower()
                version = response.headers.get("X-Agent-Manifest-Version", "")
                length = response.headers.get("X-Agent-Length", "")
                supplied_mac = response.headers.get("X-Agent-MAC", "").lower()
            manifest = f"v1\n{component}\n{expected}\n{len(source)}\n".encode()
            expected_mac = hmac.new(AGENT_TOKEN.encode(), manifest, hashlib.sha256).hexdigest()
            if len(source) > 2 * 1024 * 1024 or version != "1" or length != str(len(source)) or not re.fullmatch(r"[0-9a-f]{64}", expected) or not hmac.compare_digest(supplied_mac, expected_mac) or hashlib.sha256(source).hexdigest() != expected:
                raise ValueError(f"{component} checksum mismatch")
            if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == expected:
                continue
            temporary = target.with_name(target.name + ".update.py")
            temporary_files.append(temporary)
            temporary.write_bytes(source)
            temporary.chmod(0o700)
            checked = subprocess.run([sys.executable, "-m", "py_compile", str(temporary)], capture_output=True, text=True)
            if checked.returncode != 0:
                raise ValueError(f"{component} compile failed: {checked.stderr.strip()}")
            staged.append((temporary, target))
        if not staged:
            return
        replaced = []
        try:
            for temporary, target in staged:
                backup = target.with_name(target.name + ".last-good")
                if target.exists(): backup.write_bytes(target.read_bytes()); backup.chmod(0o700)
                os.replace(temporary, target); replaced.append((target, backup))
        except Exception:
            for target, backup in reversed(replaced):
                if backup.exists(): target.write_bytes(backup.read_bytes()); target.chmod(0o700)
            raise
        marker = WORKSPACE / ".update-pending"
        marker.write_text(json.dumps({"updated_at": int(time.time()), "deadline_at": int(time.time()) + 120})); marker.chmod(0o600)
        print("[update] residential proxy components updated; restarting", flush=True)
        subprocess.run(["pkill", "-f", "openvpn.*tun_main"], capture_output=True)
        subprocess.run(["pkill", "-f", "openvpn.*tun_backup"], capture_output=True)
        os.execv(sys.executable, [sys.executable, str(Path(__file__).resolve())])
    except Exception as error:
        print(f"[update] update check failed: {error}", flush=True)
        for temporary in temporary_files:
            try: temporary.unlink(missing_ok=True)
            except Exception: pass

def get_recent_logs():
    try:
        alpine_log = Path("/var/log/proxy-lite.log")
        if alpine_log.exists():
            with alpine_log.open("r", encoding="utf-8", errors="replace") as log_file:
                return "".join(deque(log_file, maxlen=30))
        res = subprocess.run(["journalctl", "-u", "proxy-lite.service", "-n", "30", "--no-pager", "--output=cat"], capture_output=True, text=True, errors="replace", timeout=10)
        return res.stdout or "Waiting for logs..."
    except: return "Waiting for logs..."

def fetch_controller_config():
    """拉取控制器下发的配置，仅使用代理控制器专用端点。
    注意：/api/config 和 /config 返回的是节点配置而非代理配置，
    缺少 "0"/"country" 字段，使用后会迫使 desired_country 回退为 "JP"，
    导致 VPS 永远无法感知地区变更。
    """
    base = C2_URL.rstrip('/')
    url = f"{base}{C2_API_PREFIX}/config?ip={VPS_IP}"
    try:
        raw = c2_request(url).decode("utf-8")
        data = json.loads(raw)
        if isinstance(data, dict) and (data.get("0") or data.get("country")):
            record_control_success("config")
            return data
        raise ValueError("端点返回数据缺少地区字段 (0/country)")
    except Exception as e:
        record_control_failure("config", f"{url}: {e}", realtime_ok=bool(realtime_channel and realtime_channel.connected))
    return None


def _tunnel_can_switch(tun: Tunnel) -> bool:
    return bool(tun.ready and _process_is_alive(tun.process) and not tun.is_connecting)


def _perform_hot_switch(desired_country: str, switch_trigger: int, penalized_ips: set) -> bool:
    global tun_main, tun_backup, last_switch_trigger
    with state_lock:
        if target_country != desired_country or not _tunnel_can_switch(tun_backup):
            return False
        new_main = tun_backup
        old_main = tun_main
        old_process = old_main.process
        old_main_ip = tun_main.entry_ip
    if old_main_ip:
        _mark_dead_ip(old_main_ip)
        penalize_node(old_main_ip, 3000)
        penalized_ips.add(old_main_ip)
    with _tunnel_io_lock(old_main):
        with state_lock:
            if (
                target_country != desired_country
                or tun_main is not old_main
                or tun_backup is not new_main
                or not _tunnel_can_switch(new_main)
                or old_main.process is not old_process
            ):
                return False
            tun_main, tun_backup = new_main, old_main
            old_main.dial_token += 1
            old_main.ready = False
            old_main.is_connecting = True
            old_main.slot_owner = None
            proxy_server.ACTIVE_BIND = tun_main.name
            if hasattr(proxy_server, "clear_dns_cache"):
                proxy_server.clear_dns_cache(tun_main.name)
        _terminate_process(old_process)
        _cleanup_tunnel_routing(old_main.name, old_main.table_id, old_main.table_id + 10000, old_main.table_id + 11000)
        with state_lock:
            if tun_backup is old_main and old_main.process is old_process:
                _reset_tunnel_state(old_main)
        if hasattr(proxy_server, "clear_dns_cache"):
            proxy_server.clear_dns_cache(old_main.name)
        with state_lock:
            last_switch_trigger = switch_trigger
    print(
        f"[*] ⚡ 热切备用通道完成，新连接已切换至备用通道: {tun_main.entry_ip} -> "
        f"{tun_main.egress_ip or tun_main.entry_ip}",
        flush=True,
    )
    return True


def _perform_full_redial(desired_country: str, switch_trigger: int, force_switch: bool, penalized_ips: set) -> None:
    global target_country, last_switch_trigger, tun_main, tun_backup, config_generation
    with state_lock:
        tunnels = (tun_main, tun_backup)
    with _lock_tunnel_io(*tunnels):
        with state_lock:
            tunnels = (tun_main, tun_backup)
            processes = (tun_main.process, tun_backup.process)
            entry_ips = (tun_main.entry_ip, tun_backup.entry_ip)
            config_generation += 1
            target_country = desired_country
            last_switch_trigger = switch_trigger
            for tun in tunnels:
                tun.dial_token += 1
                tun.ready = False
                tun.is_connecting = True
                tun.slot_owner = None
            # The generation bump and old-process snapshot happen only after
            # both interface locks are held, so no dial can reuse a slot while
            # stale routing teardown is still pending.
        if force_switch:
            for ip in entry_ips:
                if ip and ip not in penalized_ips:
                    _mark_dead_ip(ip)
                    penalize_node(ip, 3000)
                    penalized_ips.add(ip)
        for tun, process in zip(tunnels, processes):
            _terminate_process(process)
            _cleanup_tunnel_routing(tun.name, tun.table_id, tun.table_id + 10000, tun.table_id + 11000)
        with state_lock:
            for tun, process in zip(tunnels, processes):
                if tun.process is process:
                    _reset_tunnel_state(tun)
        if hasattr(proxy_server, "clear_dns_cache"):
            for tun in tunnels:
                proxy_server.clear_dns_cache(tun.name)


def update_config_loop():
    global target_country, last_switch_trigger, PROXY_PORT, PROXY_PUBLIC_LISTENER, PROXY_LISTEN_HOST, tun_main, tun_backup, last_config_log, REALTIME_URL, realtime_channel, config_generation
    while True:
        config_wakeup.clear()
        while realtime_channel and realtime_channel.enabled and not realtime_channel.connected:
            grace_remaining = 30 - (time.time() - (realtime_channel.last_disconnected or realtime_channel.started_at))
            if grace_remaining <= 0:
                break
            config_wakeup.wait(timeout=grace_remaining)
            config_wakeup.clear()
        try:
            check_for_updates()
            data = fetch_controller_config()
            if not data:
                config_wakeup.wait(timeout=300)
                continue
            desired_country = str(data.get("0") or data.get("country") or "JP").upper()
            if not re.fullmatch(r"[A-Z]{2}|ANY", desired_country): raise ValueError("invalid country")
            new_realtime_url = data.get("realtime_url") or ""
            if new_realtime_url and new_realtime_url != REALTIME_URL:
                REALTIME_URL = new_realtime_url
                if realtime_channel: realtime_channel.stop()
                realtime_channel = create_realtime_channel()
                realtime_channel.start()
            switch_trigger = int(data.get("switch_trigger", 0))
            new_port = int(data.get("port", 7920))
            if not 1 <= new_port <= 65535: raise ValueError("invalid proxy port")
            config_log = f"country={desired_country}, port={new_port}, trigger={switch_trigger}"
            if config_log != last_config_log:
                print(f"[cfg] 配置同步: {config_log}", flush=True)
                last_config_log = config_log
            # 同步代理凭证到 proxy_server 模块（让其实时生效，无需重启进程）
            try:
                pc = data.get("proxy") or {}
                if isinstance(pc, dict):
                    enabled = pc.get("enabled") is not False
                    new_public_listener = pc.get("public_listener") is True
                    new_listen_host = "::" if new_public_listener else normalize_listener_host(pc.get("listen_host"))
                    pu = str(pc.get("user", "")) or env_secret("PROXY_USER")
                    pp = str(pc.get("pass", "")) or env_secret("PROXY_PASS")
                    os.environ["PROXY_USER"] = pu
                    os.environ["PROXY_PASS"] = pp
                    if hasattr(proxy_server, "set_credentials"):
                        proxy_server.set_credentials(pu if enabled else "", pp if enabled else "")
                    else:
                        proxy_server.PROXY_USER = pu.encode()
                        proxy_server.PROXY_PASS = pp.encode()
                    if not pu or not pp:
                        print("[cfg] 代理凭证未配置，监听器保持拒绝连接状态", flush=True)
                    if new_public_listener != PROXY_PUBLIC_LISTENER or new_listen_host != PROXY_LISTEN_HOST:
                        PROXY_PUBLIC_LISTENER = new_public_listener
                        PROXY_LISTEN_HOST = new_listen_host
                        print("[cfg] 监听范围变化，重启代理服务以应用", flush=True)
                        os._exit(0)
            except Exception as e:
                print(f"[cfg] 凭证同步失败: {e}", flush=True)
            if new_port != PROXY_PORT:
                print(f"[*] 收到端口变更指令 ({PROXY_PORT} -> {new_port})，重启守护进程...", flush=True)
                os._exit(0)

            switch_mode = str(data.get("switch_mode") or "hot").lower()
            if switch_mode not in {"hot", "full"}:
                switch_mode = "hot"
            with state_lock:
                force_switch = (switch_trigger > last_switch_trigger)
                country_changed = target_country != desired_country
                hot_ready = (
                    force_switch
                    and not country_changed
                    and switch_mode != "full"
                    and _tunnel_can_switch(tun_backup)
                )
            if country_changed or force_switch:
                if hot_ready:
                    penalized_ips = set()
                    if _perform_hot_switch(desired_country, switch_trigger, penalized_ips):
                        print(f"[*] 强制更换指令已热切执行，旧主节点已拉黑", flush=True)
                    else:
                        print("[*] 热切条件失效，回退全量重拨", flush=True)
                        _perform_full_redial(desired_country, switch_trigger, force_switch, penalized_ips)
                else:
                    if force_switch:
                        print("[*] 收到强制更换指令，正在清退通道并拉黑当前 IP...", flush=True)
                    else:
                        print(f"[*] 策略切换: 目标重定向到 {desired_country}...", flush=True)
                    _perform_full_redial(desired_country, switch_trigger, force_switch, set())
                pool_wakeup.set()
                heartbeat_wakeup.set()
            if realtime_channel and realtime_channel.connected:
                realtime_channel.send({"success": True, "country": desired_country, "switch_trigger": switch_trigger, "applied_at": int(time.time() * 1000)}, "config.result")
        except Exception as e:
            print(f"[cfg] 拉取配置失败: {e}", flush=True)
            if realtime_channel and realtime_channel.connected:
                realtime_channel.send({"success": False, "error": str(e)[:500], "applied_at": int(time.time() * 1000)}, "config.result")
        config_wakeup.wait(timeout=REALTIME_HTTP_INTERVAL if realtime_channel and realtime_channel.connected else 300)

def c2_heartbeat_loop():
    global public_ip, PROXY_PORT, tun_main, tun_backup
    while True:
        if not public_ip or public_ip == "Unknown_IP": get_public_ip()
        details = []
        with state_lock:
            for tun in [tun_main, tun_backup]:
                if tun.ready and tun.process and tun.process.poll() is None:
                    uptime = time.time() - tun.connected_at
                    details.append({
                        "tunnel": tun.name,
                        "active": proxy_server.ACTIVE_BIND == tun.name,
                        "country": tun.country, 
                        "port": PROXY_PORT, 
                        "connected_time": int(uptime), 
                        "ready": True,
                        "node_ip": tun.egress_ip if tun.egress_ip else tun.entry_ip,
                        "exit_ip": tun.egress_ip if tun.egress_ip else tun.entry_ip,
                        "ttfb_ms": int(tun.ttfb_ms),
                        "speed_kbps": int(tun.speed_kbps),
                    })
        
        status = {"ip": VPS_IP, "socks_ip": public_ip, "details": details, "logs": get_recent_logs()}
        websocket_sent = realtime_channel.send(status) if realtime_channel and realtime_channel.connected else False
        fallback_ready = not realtime_channel or not realtime_channel.enabled or time.time() - (realtime_channel.last_disconnected or realtime_channel.started_at) >= 30
        if realtime_channel and realtime_channel.enabled and not websocket_sent and time.time() - realtime_channel.last_disconnected < 30:
            fallback_ready = False
        if websocket_sent and time.time() - last_http_report_attempt >= REALTIME_HTTP_INTERVAL:
            submit_http_report(status, background=True)
        elif not websocket_sent and fallback_ready:
            submit_http_report(status)
        if realtime_channel and realtime_channel.connected:
            interval = realtime_status_interval
        elif realtime_channel and realtime_channel.enabled and not realtime_channel.ever_connected and time.time() - realtime_channel.started_at < 30:
            interval = max(1, 30 - (time.time() - realtime_channel.started_at))
        elif realtime_channel and realtime_channel.ever_connected and time.time() - realtime_channel.last_disconnected < 30:
            interval = max(1, 30 - (time.time() - realtime_channel.last_disconnected))
        else:
            interval = 90
        heartbeat_wakeup.wait(timeout=interval)
        heartbeat_wakeup.clear()

def on_realtime_message(message):
    global realtime_status_interval
    if message.get("type") == "status.interval":
        requested_interval = int(message.get("seconds", REALTIME_STATUS_IDLE_INTERVAL))
        realtime_status_interval = max(REALTIME_STATUS_ACTIVE_INTERVAL, min(REALTIME_STATUS_IDLE_INTERVAL, requested_interval))
        heartbeat_wakeup.set()
    if message.get("type") in {"config.refresh", "transport.connected", "transport.disconnected"}: config_wakeup.set()
    if message.get("type") in {"transport.connected", "transport.disconnected"}: heartbeat_wakeup.set()

def create_realtime_channel():
    return RealtimeChannel(REALTIME_URL, VPS_IP, AGENT_TOKEN, "proxy", on_realtime_message)

def setup_env():
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if not AUTH_FILE.exists():
        AUTH_FILE.write_text("vpn\nvpn\n", encoding="utf-8")
        AUTH_FILE.chmod(0o600)
    # proxy-lite is an application-level SOCKS relay. It never needs kernel
    # forwarding, which can disable IPv6 RA routes and disconnect host SSH.
    # Rewrite the file owned by older releases so the unsafe settings do not
    # return after the next reboot.
    proxy_sysctl = Path("/etc/sysctl.d/99-proxy-lite.conf")
    try:
        proxy_sysctl.write_text("net.ipv4.conf.all.rp_filter=2\nnet.ipv4.conf.default.rp_filter=2\n", encoding="utf-8")
        proxy_sysctl.chmod(0o644)
    except OSError:
        pass
    subprocess.run(["sysctl", "-w", "net.ipv4.conf.all.rp_filter=2"], capture_output=True)
    subprocess.run(["sysctl", "-w", "net.ipv4.conf.default.rp_filter=2"], capture_output=True)

def _read_vpngate_response(url, max_bytes, timeout=15):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname != "www.vpngate.net":
        raise ValueError("untrusted VPNGate source")
    request = urllib.request.Request(url, headers={"User-Agent": "KUI-Residential-Agent/2.0", "Accept": "text/csv,text/html;q=0.9,*/*;q=0.1"})
    with _urlopen(request, timeout=timeout) as response:
        raw = response.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise ValueError("VPNGate response exceeds size limit")
    return raw.decode("utf-8", errors="replace")


def _parse_vpngate_csv(text):
    lines = [line for line in text.splitlines() if line and not line.startswith("*")]
    if not lines or "OpenVPN_ConfigData_Base64" not in lines[0]:
        raise ValueError("VPNGate CSV endpoint returned non-CSV content")
    if lines[0].startswith("#"):
        lines[0] = lines[0][1:]
    nodes = []
    for row in csv.DictReader(lines):
        try:
            node_ip = str(ipaddress.ip_address(row.get("IP", "")))
            if ipaddress.ip_address(node_ip).version != 4 or not ipaddress.ip_address(node_ip).is_global:
                continue
            encoded_config = row.get("OpenVPN_ConfigData_Base64", "")
            if not encoded_config:
                continue
            raw_ping = row.get("Ping", "")
            config = sanitize_openvpn_config(base64.b64decode(encoded_config, validate=True).decode("utf-8", errors="replace"), node_ip)
            remote_proto, remote_port = _openvpn_remote_meta(config)
            nodes.append({
                "ip": node_ip,
                "ping": int(raw_ping) if raw_ping.isdigit() else 9999,
                "country": row.get("CountryShort", "").upper(),
                "config": config,
                "speed": _safe_int(row.get("Speed")),
                "score": _safe_int(row.get("Score")),
                "sessions": _safe_int(row.get("NumVpnSessions")) if str(row.get("NumVpnSessions") or "").isdigit() else None,
                "uptime": _safe_int(row.get("Uptime")),
                "penalty": 0,
                "remote_proto": remote_proto,
                "remote_port": remote_port,
                "harvested_at": time.time(),
            })
        except Exception:
            continue
    if not nodes:
        raise ValueError("VPNGate CSV contained no usable OpenVPN nodes")
    return nodes


def _download_vpngate_candidate(candidate):
    try:
        raw_config = _read_vpngate_response(candidate["download_url"], 256 * 1024)
        config = sanitize_openvpn_config(raw_config, candidate["ip"])
        remote_proto, remote_port = _openvpn_remote_meta(config)
        return {
            "ip": candidate["ip"],
            "ping": candidate["ping"],
            "country": candidate["country"],
            "config": config,
            "speed": _safe_int(candidate.get("speed")),
            "score": _safe_int(candidate.get("score")),
            "sessions": candidate.get("sessions"),
            "uptime": _safe_int(candidate.get("uptime")),
            "penalty": _safe_int(candidate.get("penalty")),
            "remote_proto": remote_proto,
            "remote_port": remote_port,
            "harvested_at": time.time(),
        }
    except Exception:
        return None


def _harvest_vpngate_html_fallback(source_error):
    global last_vpngate_source_log
    country = target_country if target_country == "ANY" or re.fullmatch(r"[A-Z]{2}", target_country) else "JP"
    now = time.time()
    cached = html_fallback_cache.get(country)
    if cached and now - cached["updated_at"] < VPNGATE_HTML_FALLBACK_INTERVAL:
        return [{**node, "harvested_at": now} for node in cached["nodes"]]
    try:
        index_text = _read_vpngate_response("https://www.vpngate.net/en/", 2 * 1024 * 1024, timeout=20)
        candidates = [candidate for candidate in _parse_vpngate_index(index_text) if country == "ANY" or candidate["country"] == country]
        candidates = sorted(candidates, key=compute_candidate_score, reverse=True)[:VPNGATE_HTML_FALLBACK_LIMIT]
        if not candidates:
            raise ValueError(f"official page contained no {country} candidates")
        with ThreadPoolExecutor(max_workers=2) as executor:
            nodes = [node for node in executor.map(_download_vpngate_candidate, candidates) if node]
        if not nodes:
            raise ValueError("official OpenVPN downloads returned no usable profiles")
        html_fallback_cache[country] = {"updated_at": now, "nodes": nodes}
        print(f"[source] VPNGate CSV unavailable ({source_error}); official HTTPS fallback loaded {len(nodes)} {country} nodes", flush=True)
        last_vpngate_source_log = now
        return nodes
    except Exception as fallback_error:
        if cached:
            return [{**node, "harvested_at": now} for node in cached["nodes"]]
        if now - last_vpngate_source_log >= VPNGATE_HTML_FALLBACK_INTERVAL:
            print(f"[source] VPNGate sources unavailable: CSV={source_error}; fallback={fallback_error}", flush=True)
            last_vpngate_source_log = now
        return []


def harvest_snapshot_nodes() -> list:
    try:
        return _parse_vpngate_csv(_read_vpngate_response(API_URL, 20 * 1024 * 1024))
    except Exception as error:
        return _harvest_vpngate_html_fallback(str(error))

def vpngate_fetch_loop():
    global global_node_reservoir, last_reservoir_log_count
    while True:
        snapshot = harvest_snapshot_nodes()
        if snapshot:
            with reservoir_lock:
                for n in snapshot:
                    # 保留信誉与实测结果，防止新快照把坏节点或已验证节点洗回初始值。
                    existing = global_node_reservoir.get(n["ip"])
                    if existing:
                        n["ping"] = max(_safe_int(n.get("ping"), 9999), _safe_int(existing.get("ping")))
                        n["penalty"] = max(_safe_int(n.get("penalty")), _safe_int(existing.get("penalty")))
                        for key in (
                            "entry_rtt_ms",
                            "entry_probed_at",
                            "entry_reachable",
                            "ttfb_ms",
                            "speed_kbps",
                            "last_attempted_at",
                        ):
                            if key in existing:
                                n[key] = existing[key]
                    global_node_reservoir[n["ip"]] = n
                reservoir_count = len(global_node_reservoir)
            if reservoir_count != last_reservoir_log_count:
                print(f"[*] ⚡ 节点库更新，当前囤积有效节点 -> {reservoir_count} 个", flush=True)
                last_reservoir_log_count = reservoir_count
        else:
            # FIX 3: 如果 VPNGate 接口被限流或不通，延长现有节点的生命周期，防止库干涸
            with reservoir_lock:
                now = time.time()
                for n in global_node_reservoir.values():
                    n["harvested_at"] = now
        time.sleep(300)

def _delete_ip_rule(arguments):
    # Delete only a complete rule selector. Never delete by preference alone:
    # that preference may belong to cloud-init, DHCP or the hosting provider.
    while subprocess.run(["ip", "rule", "del", *arguments], capture_output=True).returncode == 0:
        pass

def _cleanup_tunnel_routing(tun_name: str, table_id: int, oif_pref: int, iif_pref: int):
    _delete_ip_rule(["pref", str(oif_pref), "oif", tun_name, "lookup", str(table_id)])
    _delete_ip_rule(["pref", str(iif_pref), "iif", tun_name, "lookup", str(table_id)])
    subprocess.run(["ip", "route", "del", "default", "dev", tun_name, "table", str(table_id)], capture_output=True)

def setup_routing(tun_name: str, table_id: int):
    oif_pref, iif_pref = table_id + 10000, table_id + 11000
    legacy_table = LEGACY_KUI_ROUTE_TABLES.get(tun_name)
    if legacy_table:
        # Remove only rules/routes that match the previous KUI installation.
        # Do not flush the legacy table because it may contain system routes.
        _cleanup_tunnel_routing(tun_name, legacy_table, legacy_table, legacy_table + 1000)
    _cleanup_tunnel_routing(tun_name, table_id, oif_pref, iif_pref)
    try:
        subprocess.run(["ip", "route", "replace", "default", "dev", tun_name, "table", str(table_id)], capture_output=True, check=True)
        subprocess.run(["ip", "rule", "add", "pref", str(oif_pref), "oif", tun_name, "lookup", str(table_id)], capture_output=True, check=True)
        subprocess.run(["ip", "rule", "add", "pref", str(iif_pref), "iif", tun_name, "lookup", str(table_id)], capture_output=True, check=True)
    except Exception:
        _cleanup_tunnel_routing(tun_name, table_id, oif_pref, iif_pref)
        raise

def connect_node(
    tun: Tunnel,
    node: dict,
    generation: int,
    token: int = 0,
    expected_country: str | None = None,
    expected_role: str | None = None,
):
    process = None
    routing_installed = False
    egress_owned = False
    egress_ip = ""
    token = token or tun.connect_token
    if expected_country is None:
        expected_country = str(node.get("country") or "")
    with state_lock:
        context_current = _dial_context_is_current_locked(
            tun,
            generation,
            token,
            expected_country=expected_country,
            expected_role=expected_role,
        )
    if not context_current:
        _release_unowned_dial_slot(tun, generation, token)
        return
    reserved = False
    try:
        print(f"[*] {tun.name} 开始拨号: {node['country']} {node['ip']} (ping={node['ping']})", flush=True)
        cfg_path = CONFIG_DIR / f"{tun.name}.ovpn"
        log_file = WORKSPACE / f"{tun.name}_err.log"
        
        ovpn_version = subprocess.run(["openvpn", "--version"], capture_output=True, text=True).stdout
        cipher_args = ["--ncp-ciphers", "AES-128-CBC:AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305"] if "2.4" in ovpn_version else ["--data-ciphers", "AES-128-CBC:AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305", "--data-ciphers-fallback", "AES-128-CBC"]
        
        # route-noexec is the hard boundary: OpenVPN may configure only its
        # TUN address; all routing remains owned by setup_routing() below.
        cmd = ["openvpn", "--config", str(cfg_path), "--dev", tun.name, "--dev-type", "tun", 
               "--nobind", "--route-nopull", "--route-noexec",
               "--pull-filter", "ignore", "redirect-gateway",
               "--pull-filter", "ignore", "route-ipv6", "--pull-filter", "ignore", "ifconfig-ipv6", 
               "--auth-user-pass", str(AUTH_FILE),
               "--connect-timeout", "5", "--connect-retry-max", "1", "--verb", "3",
               "--ping", "10", "--ping-exit", "35", "--remap-usr1", "SIGTERM"] + cipher_args

        side_effects = _dial_side_effects(
            tun,
            generation,
            token,
            expected_country=expected_country,
            expected_role=expected_role,
        )
        if side_effects is None:
            return
        try:
            if not _dial_context_is_current_locked(
                tun,
                generation,
                token,
                expected_country=expected_country,
                expected_role=expected_role,
            ):
                return
            if not _reserve_dial_slot(
                tun,
                generation,
                token,
                node,
                expected_country=expected_country,
                expected_role=expected_role,
            ):
                if tun.slot_owner == (generation, token):
                    _clear_dial_slot_if_current(tun, generation, token)
                return
            reserved = True
            cfg_path.write_text(node["config"], encoding="utf-8")
            with open(log_file, "w") as log_stream:
                process = subprocess.Popen(cmd, stdout=log_stream, stderr=subprocess.STDOUT)
            if not _register_dial_process(tun, generation, token, process):
                _terminate_process(process)
                return
        finally:
            side_effects.release()

        success = False
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            time.sleep(0.5)
            if not _dial_matches_policy(tun, generation, token, process, node):
                if _tunnel_has_routing(tun, process):
                    _abandon_tunnel(tun, process)
                else:
                    _discard_dial_process(tun, process)
                return
            if process.poll() is not None:
                break
            try:
                if "Initialization Sequence Completed" in log_file.read_text():
                    success = True; break
            except: pass

        if not _dial_matches_policy(tun, generation, token, process, node):
            if _tunnel_has_routing(tun, process):
                _abandon_tunnel(tun, process)
            else:
                _discard_dial_process(tun, process)
            return

        if not (success and process.poll() is None):
            try:
                error_tail = "\n".join(log_file.read_text(errors="replace").splitlines()[-12:])
            except Exception:
                error_tail = "无法读取 OpenVPN 日志"
            print(f"[-] {tun.name} 建连失败: {node['ip']}\n{error_tail}", flush=True)
            penalize_node(node["ip"], 5000)  # 建连超时中度惩罚
            _mark_dead_ip(node["ip"])
            _discard_dial_process(tun, process)
            return

        if not _dial_matches_policy(tun, generation, token, process, node):
            _discard_dial_process(tun, process)
            return

        side_effects = _dial_side_effects(
            tun,
            generation,
            token,
            process,
            expected_country=expected_country,
            expected_role=expected_role,
        )
        if side_effects is None:
            _discard_dial_process(tun, process)
            return
        try:
            if not _dial_matches_policy_locked(tun, generation, token, process, node):
                _discard_dial_process(tun, process)
                return
            setup_routing(tun.name, tun.table_id)
            routing_installed = True
            setattr(process, "_kui_routing_installed", True)
        finally:
            side_effects.release()

        time.sleep(1)
        if not _dial_matches_policy(tun, generation, token, process, node):
            _abandon_tunnel(tun, process)
            return

        # --- 穿透获取通道真实出口 IP（纯IPv6+WARP兼容） ---
        true_ip = ""
        try:
            true_ip_res = subprocess.run(["curl", "-s", "-m", "10", "--interface", tun.name, "-4", "https://api.ipify.org"], capture_output=True, text=True)
            candidate_ip = true_ip_res.stdout.strip()
            try:
                ipaddress.IPv4Address(candidate_ip)
                true_ip = candidate_ip
            except (ipaddress.AddressValueError, ValueError):
                pass
        except: pass

        if not true_ip:
            try:
                true_ip_res = subprocess.run(["curl", "-s", "-m", "10", "--interface", tun.name, "-6", "https://api6.ipify.org"], capture_output=True, text=True)
                candidate_ip = true_ip_res.stdout.strip()
                try:
                    ipaddress.IPv6Address(candidate_ip)
                    true_ip = candidate_ip
                except (ipaddress.AddressValueError, ValueError):
                    pass
            except: pass

        egress_ip = true_ip if true_ip else node['ip']

        if true_ip and true_ip != node['ip']:
            print(f"[*] {tun.name} 探测到真实出口 IP 与入口不一致: 入口 {node['ip']} -> 出口 {true_ip}", flush=True)

        if not _dial_matches_policy(tun, generation, token, process, node):
            _abandon_tunnel(tun, process)
            return

        with _tunnel_io_lock(tun):
            discard_after_unlock = False
            egress_conflict = False
            conflict_lost = False
            with state_lock:
                if not _dial_owns_process_locked(tun, generation, token, process):
                    discard_after_unlock = True
                else:
                    egress_conflict = _tunnel_ip_conflicts_locked(
                        tun,
                        str(node.get("ip") or ""),
                        egress_ip,
                    )
                    conflict_lost = egress_conflict and _dial_loses_ip_conflict_locked(tun)
                    if not conflict_lost:
                        if not _dial_matches_policy_locked(tun, generation, token, process, node):
                            discard_after_unlock = True
                        else:
                            tun.egress_ip = egress_ip
                            egress_owned = True
            if discard_after_unlock:
                # Ownership can change while probing egress. Retire by process
                # identity so an old dial cannot leave a process or routing
                # behind or clear a newer dial's state.
                if _tunnel_has_routing(tun, process):
                    _retire_tunnel_unlocked(
                        tun,
                        process,
                        cleanup_routes=True,
                        extra_check=lambda already_exited: True,
                        terminate_exited=True,
                    )
                else:
                    _discard_dial_process(tun, process)
                pool_wakeup.set()
                return
            if conflict_lost:
                print(
                    f"[-] {tun.name} 出口 {egress_ip} 与另一通道冲突，回收本次拨号",
                    flush=True,
                )
                penalize_node(node["ip"], 2000)
                _mark_dead_ip(node["ip"])
                _discard_dial_process(tun, process)
                pool_wakeup.set()
                heartbeat_wakeup.set()
                return

        is_residential = True
        try:
            data = _testisp_lookup(egress_ip)
            print(f"[*] {tun.name} testisp.info 报告 {egress_ip}: {data.get('isp',{})} / native={data.get('geo',{}).get('is_native','?')}", flush=True)
            isp = data.get("isp", {})
            geo = data.get("geo", {})
            isp_flag = str(isp.get("flag", "")).lower()
            isp_type = str(isp.get("type", "")).lower()
            isp_warn = str(isp.get("warning", "")).lower()
            is_native = geo.get("is_native", False)

            # 综合判断：仅凭 isp.flag == "hosting" 不够可靠
            # 真机房判定：flag=hosting 且 type 不含 isp/broadband/dsl/cable 且 is_native=False
            if isp_flag == "hosting":
                residential_indicators = [
                    "isp" in isp_type,
                    "broadband" in isp_type,
                    "dsl" in isp_type,
                    "cable" in isp_type,
                    is_native is True,
                    "hosting" not in isp_warn and "datacenter" not in isp_warn
                ]
                if not any(residential_indicators):
                    is_residential = False
        except Exception as e:
            print(f"[*] {tun.name} testisp.info 查询失败: {e}", flush=True)

        if not is_residential:
            print(f"[-] {tun.name} 节点出口 ({egress_ip}) 检测为机房 IP，残忍抛弃！", flush=True)
            penalize_node(node["ip"], 50000)  # 机房 IP 极重惩罚，几乎不再启用
            _mark_dead_ip(node["ip"])
            _abandon_tunnel(tun, process)
            return

        if not _dial_matches_policy(tun, generation, token, process, node):
            _abandon_tunnel(tun, process)
            return

        print(f"[*] {tun.name} 流媒体连通性与 256KB 吞吐检测...", flush=True)
        quality = probe_tunnel_quality(tun.name, node_ip=node["ip"], country=node.get("country", ""))
        if quality is None:
            print(f"[-] {tun.name} 质量验收未通过，放弃节点: {node['ip']}", flush=True)
            _abandon_tunnel(tun, process)
            return

        side_effects = _dial_side_effects(
            tun,
            generation,
            token,
            process,
            expected_country=expected_country,
            expected_role=expected_role,
        )
        if side_effects is None:
            _discard_dial_process(tun, process)
            return
        discard_after_unlock = False
        discard_conflict = False
        conflict_lost = False
        try:
            with state_lock:
                if not _dial_matches_policy_locked(tun, generation, token, process, node):
                    discard_after_unlock = True
                elif _tunnel_ip_conflicts_locked(
                    tun,
                    str(node.get("ip") or ""),
                    egress_ip,
                ):
                    conflict_lost = _dial_loses_ip_conflict_locked(tun)
                    if conflict_lost:
                        discard_after_unlock = True
                        discard_conflict = True
                    else:
                        tun.node = node
                        tun.egress_ip = egress_ip
                        egress_owned = True
                        tun.country = node["country"]
                        tun.connected_at = time.time()
                        tun.ttfb_ms = int(quality.ttfb_ms)
                        tun.speed_kbps = int(quality.speed_kbps)
                        tun.ready = True
                else:
                    tun.node = node
                    tun.egress_ip = egress_ip
                    egress_owned = True
                    tun.country = node["country"]
                    tun.connected_at = time.time()
                    tun.ttfb_ms = int(quality.ttfb_ms)
                    tun.speed_kbps = int(quality.speed_kbps)
                    tun.ready = True
        finally:
            side_effects.release()
        if discard_after_unlock:
            if discard_conflict:
                penalize_node(node["ip"], 2000)
                _mark_dead_ip(node["ip"])
                _discard_dial_process(tun, process)
                pool_wakeup.set()
                heartbeat_wakeup.set()
            else:
                _discard_dial_process(tun, process)
            return
        _record_measured_quality(node["ip"], quality.ttfb_ms, quality.speed_kbps, node=node)
        if hasattr(proxy_server, "clear_dns_cache"):
            proxy_server.clear_dns_cache(tun.name)
        role = "主网卡" if proxy_server.ACTIVE_BIND == tun.name else "备用网卡"
        print(
            f"[+] {tun.name} ({role}) 完全就绪: 入口 {node['ip']} -> 出口 {egress_ip}, "
            f"ttfb={int(quality.ttfb_ms)}ms, speed={int(quality.speed_kbps)}kbps",
            flush=True,
        )
        heartbeat_wakeup.set()
    except Exception as error:
        print(f"[-] {tun.name} 拨号异常: {error}", flush=True)
        if node.get("ip"):
            penalize_node(node["ip"], 3000)
            _mark_dead_ip(node["ip"])
        if process is not None:
            if routing_installed or _tunnel_has_routing(tun, process):
                _abandon_tunnel(tun, process)
            else:
                _discard_dial_process(tun, process)
    finally:
        with state_lock:
            owns_released_slot = bool(token) and tun.slot_owner == (generation, token)
            if not token or tun.connect_token == token or owns_released_slot:
                tun.is_connecting = False
                # A rejected dial may still own the reserved slot until its
                # process is registered. Never release a newer dial's slot.
                if not tun.ready:
                    tun.entry_ip = ""
                    if egress_owned and tun.egress_ip:
                        tun.egress_ip = ""
                    if owns_released_slot:
                        tun.slot_owner = None
            if reserved and token and tun.slot_owner == (generation, token) and tun.process is None:
                tun.is_connecting = False
                tun.entry_ip = ""
                tun.slot_owner = None
        pool_wakeup.set()

def health_check_loop():
    global tun_main, tun_backup
    fail_counts = {}
    while True:
        time.sleep(15 if not any(fail_counts.values()) else 5)
        targets = []
        with state_lock:
            for tunnel in (tun_main, tun_backup):
                if tunnel.ready and tunnel.process and tunnel.process.poll() is None and time.time() - tunnel.connected_at > 20:
                    targets.append((tunnel, tunnel.name, tunnel.entry_ip, tunnel.process))

        for tunnel, target_tun, target_entry_ip, proc_ref in targets:
            is_alive = False
            for endpoint in ["http://www.gstatic.com/generate_204", "http://cp.cloudflare.com/generate_204", "http://1.1.1.1", "http://8.8.8.8"]:
                result = subprocess.run(["curl", "-I", "-s", "-m", "5", "--interface", target_tun, endpoint], capture_output=True)
                if result.returncode == 0:
                    is_alive = True
                    break
            if not is_alive:
                is_alive = subprocess.run(["ping", "-c", "2", "-W", "3", "-I", target_tun, "8.8.8.8"], capture_output=True).returncode == 0

            process_key = id(proc_ref)
            if is_alive:
                fail_counts[process_key] = 0
                continue
            fail_counts[process_key] = fail_counts.get(process_key, 0) + 1
            if fail_counts[process_key] >= 3:
                print(f"[!] {target_tun} 连续探针无响应，执行踢线: {target_entry_ip}", flush=True)
                penalize_node(target_entry_ip, 3000)
                _mark_dead_ip(target_entry_ip)
                _abandon_tunnel(tunnel, proc_ref)
                if hasattr(proxy_server, "clear_dns_cache"):
                    proxy_server.clear_dns_cache(target_tun)
                pool_wakeup.set()
                heartbeat_wakeup.set()
                fail_counts.pop(process_key, None)
            else:
                print(f"[*] {target_tun} 探针无响应，快速复核 ({fail_counts[process_key]}/3)...", flush=True)

def get_best_candidate():
    global target_country, last_empty_candidate_log
    with reservoir_lock:
        all_pool_nodes = list(global_node_reservoir.values())
    occupied_ips = _occupied_tunnel_ips()
    country_nodes = [node for node in all_pool_nodes if _matches_target_country(node)]
    candidates = [
        node for node in country_nodes
        if _is_dialable_candidate(node, occupied_ips)
    ]
    if not candidates and any(_is_dead_ip(node.get("ip")) for node in country_nodes):
        _clear_dead_ips()
        print(f"[!] ⚡ 紧急熔断：[{target_country}] 节点黑名单释放救场（由于动态信誉系统存在，历史坏节点将被沉底）", flush=True)
        candidates = [
            node for node in country_nodes
            if node.get("ip") not in occupied_ips
        ]

    if not candidates:
        country_counts = {}
        for node in all_pool_nodes:
            country_counts[node.get("country", "")] = country_counts.get(node.get("country", ""), 0) + 1
        now = time.time()
        if now - last_empty_candidate_log >= 30:
            print(f"[!] 无可用 {target_country} 候选；节点分布={country_counts}，黑名单={_dead_ips_count()}", flush=True)
            last_empty_candidate_log = now
        return None

    ranked = sorted(candidates, key=compute_candidate_score, reverse=True)
    available = [node for node in ranked if not _tcp_failure_cached(node)]
    top_candidates = available[:8]
    probe_candidates_entry_rtt(top_candidates, max_probe=8)

    occupied_ips = _occupied_tunnel_ips()
    reachable = [
        node for node in ranked
        if (
            node.get("entry_reachable") is not False
            and _is_dialable_candidate(node, occupied_ips)
            and (
                node in top_candidates
                or _safe_float(node.get("entry_probed_at")) > 0
                and time.time() - _safe_float(node.get("entry_probed_at")) <= TCP_PROBE_CACHE_SECONDS
            )
        )
    ]
    if not reachable:
        now = time.time()
        if now - last_empty_candidate_log >= 30:
            print(f"[!] {target_country} 候选入口 TCP 预探针全部失败，等待下一轮", flush=True)
            last_empty_candidate_log = now
        return None
    return max(reachable, key=compute_candidate_score)

def sanitize_openvpn_config(raw: str, expected_ip: str) -> str:
    allowed = {"proto", "port", "cipher", "auth", "auth-nocache", "remote-cert-tls", "verify-x509-name", "tls-version-min", "tls-cipher", "compress", "comp-lzo", "key-direction", "reneg-sec"}
    blocked = {"script-security", "up", "down", "route-up", "route-pre-down", "plugin", "management", "config", "cd", "chroot", "daemon", "log", "log-append", "writepid", "client-connect", "client-disconnect", "learn-address"}
    blocks = {"ca", "cert", "key", "tls-auth", "tls-crypt", "tls-crypt-v2"}
    output = ["client", "dev tun", "nobind", "persist-key", "persist-tun", "remote-random"]
    in_block = None
    for original in raw.splitlines():
        line = original.strip()
        if not line or line.startswith(('#', ';')): continue
        if in_block:
            output.append(line)
            if line.lower() == f"</{in_block}>": in_block = None
            continue
        if line.startswith('<') and line.endswith('>') and not line.startswith('</'):
            name = line[1:-1].strip().lower()
            if name not in blocks: raise ValueError(f"unsafe OpenVPN inline block: {name}")
            in_block = name; output.append(f"<{name}>"); continue
        parts = line.split()
        directive = parts[0].lower()
        if directive in blocked: raise ValueError(f"unsafe OpenVPN directive: {directive}")
        if directive == "remote":
            port = int(parts[2]) if len(parts) > 2 else 1194
            if not 1 <= port <= 65535: raise ValueError("invalid OpenVPN remote port")
            output.append(f"remote {expected_ip} {port}")
        elif directive in allowed:
            output.append(line)
    if in_block: raise ValueError(f"unterminated OpenVPN block: {in_block}")
    if not any(line.startswith("remote ") for line in output): raise ValueError("OpenVPN profile has no remote")
    return "\n".join(output) + "\n"

def maintain_pool():
    global last_blacklist_clear, tun_main, tun_backup
    while True:
        if time.time() - last_blacklist_clear > 600:
            _clear_dead_ips()
            last_blacklist_clear = time.time()

        with reservoir_lock:
            now = time.time()
            stale_ips = [
                ip for ip, node in global_node_reservoir.items()
                if now - _safe_float(node.get("harvested_at")) > 10800
            ]
            for ip in stale_ips: global_node_reservoir.pop(ip, None)

        with state_lock:
            current_main = tun_main
            current_backup = tun_backup
        with _lock_tunnel_io(current_main, current_backup):
            retire_old_main = False
            release_old_main_slot = False
            retire_old_main_process = None
            retire_dead_backup_process = None
            takeover = False
            with state_lock:
                roles_current = tun_main is current_main and tun_backup is current_backup
                main_unready = not current_main.ready or not _process_is_alive(current_main.process)
                backup_live = (
                    current_backup.ready
                    and _process_is_alive(current_backup.process)
                    and not current_backup.is_connecting
                )
                if roles_current and main_unready and backup_live:
                    print(f"[*] ⚡ 主通道未就绪，立即接管业务至备用通道: 出口 {current_backup.egress_ip or current_backup.entry_ip}", flush=True)
                    tun_main, tun_backup = current_backup, current_main
                    current_main.dial_token += 1
                    proxy_server.ACTIVE_BIND = tun_main.name
                    if hasattr(proxy_server, "clear_dns_cache"):
                        proxy_server.clear_dns_cache(tun_main.name)
                    heartbeat_wakeup.set()
                    if current_main.is_connecting and current_main.process is None:
                        current_main.is_connecting = False
                        current_main.entry_ip = ""
                        current_main.slot_owner = None
                        release_old_main_slot = True
                        current_main.dial_token += 1
                    elif not current_main.is_connecting:
                        retire_old_main = True
                        retire_old_main_process = current_main.process
                    takeover = True
                backup_dead = (
                    roles_current
                    and not takeover
                    and current_backup.ready
                    and not _process_is_alive(current_backup.process)
                    and not current_backup.is_connecting
                )
                if backup_dead:
                    retire_dead_backup_process = current_backup.process
            if takeover:
                if retire_old_main:
                    _retire_tunnel_unlocked(current_main, retire_old_main_process)
            elif roles_current and main_unready and not current_main.is_connecting:
                _retire_tunnel_unlocked(current_main, current_main.process)
            if backup_dead:
                _retire_tunnel_unlocked(current_backup, retire_dead_backup_process)

        promoted = False
        with state_lock:
            promote_main = tun_main
            promote_backup = tun_backup
            both_healthy = (
                promote_main.ready
                and promote_backup.ready
                and _process_is_alive(promote_main.process)
                and _process_is_alive(promote_backup.process)
                and not promote_main.is_connecting
                and not promote_backup.is_connecting
            )
            should_promote = both_healthy and should_promote_backup(promote_main, promote_backup)
        if should_promote:
            with state_lock:
                if tun_main is not promote_main or tun_backup is not promote_backup:
                    should_promote = False
                else:
                    print(f"[*] ⚡ 备用通道实测更优，切换主出口: {promote_main.entry_ip} -> {promote_backup.entry_ip}", flush=True)
                    tun_main, tun_backup = promote_backup, promote_main
                    proxy_server.ACTIVE_BIND = tun_main.name
                    if hasattr(proxy_server, "clear_dns_cache"):
                        proxy_server.clear_dns_cache(tun_main.name)
                    heartbeat_wakeup.set()
                    promoted = True

        backup_replacement = None
        backup_replacement_generation = None
        backup_replacement_country = None
        race_retired = False
        if not promoted:
            with state_lock:
                race_main = tun_main
                race_backup = tun_backup
                race_process = race_backup.process
                race_generation = config_generation
                race_due = (
                    race_main.ready
                    and race_backup.ready
                    and _process_is_alive(race_main.process)
                    and _process_is_alive(race_backup.process)
                    and not race_main.is_connecting
                    and not race_backup.is_connecting
                    and time.time() - _safe_float(race_backup.connected_at) >= _backup_race_interval()
                )
            race_candidate = _select_viable_higher_candidate(race_backup) if race_due else None
            race_occupied_ips = _occupied_tunnel_ips() if race_candidate is not None else set()
            if race_candidate is not None:
                def race_guard(already_exited):
                    if tun_main is not race_main or tun_backup is not race_backup:
                        return False
                    if config_generation != race_generation:
                        return False
                    if not race_main.ready or race_main.is_connecting:
                        return False
                    if not _process_is_alive(race_main.process):
                        return False
                    if not race_backup.ready or race_backup.is_connecting:
                        return False
                    if race_backup.process is not race_process:
                        return False
                    if not _is_verified_tcp_race_candidate(
                        race_candidate,
                        race_backup,
                        occupied_ips=race_occupied_ips,
                    ):
                        return False
                    return _process_is_alive(race_main.process)

                with _lock_tunnel_io(race_main, race_backup):
                    if _retire_tunnel_unlocked(
                        race_backup,
                        race_process,
                        require_idle=True,
                        expected_generation=race_generation,
                        expected_backup=True,
                        extra_check=race_guard,
                    ):
                        print(f"[*] 备用通道周期赛马，回收重拨更优候选: {race_backup.entry_ip}", flush=True)
                        backup_replacement = race_candidate
                        backup_replacement_generation = race_generation
                        backup_replacement_country = str(race_candidate.get("country") or "")
                        race_retired = True
                        pool_wakeup.set()

        with state_lock:
            dispatch_country = target_country
            dispatch_generation = config_generation
            needs_main = (not tun_main.ready or not _process_is_alive(tun_main.process)) and not tun_main.is_connecting
            main_ref = tun_main
            needs_backup = (not tun_backup.ready or not _process_is_alive(tun_backup.process)) and not tun_backup.is_connecting
            backup_ref = tun_backup
            generation = dispatch_generation
        wake_for_new_pick = False

        if needs_main:
            node = get_best_candidate()
            if node:
                with state_lock:
                    if (
                        tun_main is main_ref
                        and (not tun_main.ready or not _process_is_alive(tun_main.process))
                        and not tun_main.is_connecting
                    ):
                        if _peer_reservation_conflicts_locked(tun_main, node["ip"]):
                            token = 0
                            wake_for_new_pick = True
                        else:
                            tun_main.is_connecting = True
                            tun_main.entry_ip = node["ip"]  # 提前占住坑位，防止主备选到同一 IP
                            tun_main.connect_token += 1
                            token = tun_main.connect_token
                            expected_country = dispatch_country if dispatch_country != "ANY" else str(node.get("country") or "")
                            slot_current = _dial_context_is_current_locked(
                                tun_main,
                                generation,
                                token,
                                expected_country=expected_country,
                                expected_role="main",
                            )
                            if not slot_current:
                                tun_main.is_connecting = False
                                tun_main.entry_ip = ""
                                tun_main.slot_owner = None
                                token = 0
                    else:
                        token = 0
                if token:
                    _mark_node_attempted(node["ip"])
                    threading.Thread(
                        target=connect_node,
                        args=(main_ref, node, generation, token, expected_country, "main"),
                        daemon=True,
                    ).start()

        if needs_backup:
            node = backup_replacement
            if node is None and not race_retired:
                node = get_best_candidate()
            if node:
                backup_generation = (
                    backup_replacement_generation
                    if backup_replacement is not None
                    else generation
                )
                expected_country = (
                    backup_replacement_country
                    if backup_replacement is not None
                    else str(node.get("country") or "")
                )
                with state_lock:
                    if (
                        tun_backup is backup_ref
                        and (not tun_backup.ready or not _process_is_alive(tun_backup.process))
                        and not tun_backup.is_connecting
                    ):
                        if _peer_reservation_conflicts_locked(tun_backup, node["ip"]):
                            token = 0
                            wake_for_new_pick = True
                        else:
                            tun_backup.is_connecting = True
                            tun_backup.entry_ip = node["ip"]  # 提前占住坑位
                            tun_backup.connect_token += 1
                            token = tun_backup.connect_token
                            slot_current = _dial_context_is_current_locked(
                                tun_backup,
                                backup_generation,
                                token,
                                expected_country=expected_country,
                                expected_role="backup",
                            )
                            if not slot_current:
                                tun_backup.is_connecting = False
                                tun_backup.entry_ip = ""
                                tun_backup.slot_owner = None
                                token = 0
                    else:
                        token = 0
                if token:
                    _mark_node_attempted(node["ip"])
                    threading.Thread(
                        target=connect_node,
                        args=(backup_ref, node, backup_generation, token, expected_country, "backup"),
                        daemon=True,
                    ).start()

        if wake_for_new_pick:
            pool_wakeup.set()
        pool_wakeup.wait(timeout=2)
        pool_wakeup.clear()

def main():
    global PROXY_PORT, PROXY_PUBLIC_LISTENER, PROXY_LISTEN_HOST, tun_main, target_country, last_switch_trigger, REALTIME_URL, realtime_channel
    if os.geteuid() != 0: return
    check_for_updates()
    get_public_ip()
    setup_env()
    try:
        initial = fetch_controller_config()
        if initial:
            candidate_port = int(initial.get("port", 7920))
            PROXY_PORT = candidate_port if 1 <= candidate_port <= 65535 else 7920
            target_country = str(initial.get("0") or initial.get("country") or "JP").upper()
            last_switch_trigger = int(initial.get("switch_trigger", 0))
            pc = initial.get("proxy") or {}
            if pc:
                enabled = pc.get("enabled") is not False
                PROXY_PUBLIC_LISTENER = pc.get("public_listener") is True
                PROXY_LISTEN_HOST = "::" if PROXY_PUBLIC_LISTENER else normalize_listener_host(pc.get("listen_host"))
                proxy_server.set_credentials((str(pc.get("user", "")) or env_secret("PROXY_USER")) if enabled else "", (str(pc.get("pass", "")) or env_secret("PROXY_PASS")) if enabled else "")
    except Exception as error:
        print(f"[cfg] initial controller sync failed, using fallback values: {error}", flush=True)
    subprocess.run(["pkill", "-f", "openvpn.*tun_main"], capture_output=True)
    subprocess.run(["pkill", "-f", "openvpn.*tun_backup"], capture_output=True)
    
    proxy_server.ACTIVE_BIND = tun_main.name
    if hasattr(proxy_server, "clear_dns_cache"):
        proxy_server.clear_dns_cache()
    
    print("========================================", flush=True)

    realtime_channel = create_realtime_channel()
    realtime_channel.start()
    listener_label = "公网" if PROXY_PUBLIC_LISTENER else PROXY_LISTEN_HOST
    print(f"  Proxy Controller (主备双活引擎) 启动！端口: {PROXY_PORT}，监听: {listener_label}", flush=True)
    print("========================================", flush=True)

    threading.Thread(target=vpngate_fetch_loop, daemon=True).start()
    threading.Thread(target=update_config_loop, daemon=True).start()
    # 默认仅监听本机；也可绑定到 Docker 网桥 IPv4 地址。
    def run_proxy_server():
        try:
            proxy_server.start_proxy_server(PROXY_LISTEN_HOST, PROXY_PORT)
        except Exception as error:
            print(f"[proxy] listener stopped: {error}; tunnel manager remains online", flush=True)
    threading.Thread(target=run_proxy_server, daemon=True).start()
    threading.Thread(target=health_check_loop, daemon=True).start()
    threading.Thread(target=c2_heartbeat_loop, daemon=True).start()
    marker = WORKSPACE / ".update-pending"
    if marker.exists():
        if not initial or not proxy_server.listener_ready.wait(30):
            print("[proxy] updated version failed controller readiness", flush=True)
            raise SystemExit(1)
        try: marker.unlink()
        except FileNotFoundError: pass
    maintain_pool()

if __name__ == "__main__":
    main()
