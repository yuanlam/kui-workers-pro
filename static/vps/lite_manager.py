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
last_probe_trigger = 0
probe_trigger_initialized = False
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
UPDATE_READY_WAIT_SECONDS = 180
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
IPOK_BATCH_URL = "https://ipok.io/api/batch"
IPOK_IP_URL = "https://ipok.io/api/ip"
IPPURE_INFO_URL = "https://my.ippure.com/v1/info"
IPOK_BATCH_CACHE_TTL = 6 * 3600
IPOK_BATCH_CACHE_MAX_ENTRIES = 1024
IPOK_BATCH_CHUNK_SIZE = 100
IPOK_BATCH_COOLDOWN_SECONDS = 300
IPPURE_CACHE_TTL = 3600
IPPURE_CACHE_MAX_ENTRIES = 512
IPOK_DETAIL_CACHE_TTL = 3600
IPOK_DETAIL_CACHE_MAX_ENTRIES = 512
EGRESS_PURITY_CACHE_TTL = 3600
EGRESS_PURITY_CACHE_MAX_ENTRIES = 512
IPPURE_HARD_REJECT_FRAUD_SCORE = 85
IPPURE_NON_RES_REJECT_FRAUD_SCORE = 60
IPOK_HARD_REJECT_RISK = 70
IPOK_HARD_REJECT_SIGNALS = frozenset({"blocklisted", "abuser", "tor"})
ipok_batch_cache = OrderedDict()
ippure_cache = OrderedDict()
ipok_detail_cache = OrderedDict()
egress_purity_cache = OrderedDict()
purity_cache_lock = threading.Lock()
ipok_batch_cooldown_until = 0.0
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


def _clear_purity_caches() -> None:
    global ipok_batch_cooldown_until
    with purity_cache_lock:
        ipok_batch_cache.clear()
        ippure_cache.clear()
        ipok_detail_cache.clear()
        egress_purity_cache.clear()
        ipok_batch_cooldown_until = 0.0


def _normalize_risk_score(value) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        numeric = float(str(value).strip())
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(numeric) or numeric < 0 or numeric > 100:
        return None
    return int(round(numeric))


_IP_PROFILE_FLAG_KEYS = ("proxy", "hosting", "vpn", "tor", "mobile", "abuser")
_IP_PROFILE_FLAG_ALIASES = {
    "proxy": ("proxy", "is_proxy", "isProxy"),
    "hosting": ("hosting", "is_hosting", "isHosting", "datacenter"),
    "vpn": ("vpn", "is_vpn", "isVpn"),
    "tor": ("tor", "is_tor", "isTor"),
    "mobile": ("mobile", "is_mobile", "isMobile", "cellular"),
    "abuser": ("abuser", "abuse", "is_abuser", "isAbuser", "blocklisted"),
}
_IP_PROFILE_SCENARIO_KEYS = frozenset(
    {"ai", "ecommerce", "social", "tiktok", "netflix", "paypal", "stripe", "google"}
)
_IP_PROFILE_TEXT_LIMITS = {
    "asn": 32,
    "isp": 80,
    "org": 80,
    "region": 48,
    "city": 48,
    "timezone": 48,
    "reverse": 128,
    "usage_type": 32,
    "ip_type": 32,
    "native_type": 32,
    "shared_users": 24,
    "purity_label": 48,
    "purity_tone": 16,
}


def _profile_text(value, limit: int) -> str:
    if value is None or isinstance(value, (bool, dict, list, tuple, set)):
        return ""
    text = re.sub(r"[\x00-\x1f\x7f<>]", "", str(value))
    text = re.sub(r"\s+", " ", text).strip()
    return text[:max(0, int(limit))]


def _profile_token(value, limit: int = 32) -> str:
    text = _profile_text(value, limit).lower()
    return re.sub(r"[^a-z0-9_.-]", "", text)[:max(0, int(limit))]


def _profile_status(value, limit: int = 24) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, dict):
        value = value.get("status") or value.get("state") or value.get("result")
    return _profile_text(value, limit)


def _profile_number(value) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        numeric = float(str(value).strip())
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(numeric):
        return None
    return numeric


def _normalize_drift_km(value):
    numeric = _profile_number(value)
    if numeric is None or numeric < 0 or numeric > 1_000_000:
        return None
    return int(numeric) if numeric.is_integer() else round(numeric, 3)


def _normalize_stars(value):
    numeric = _profile_number(value)
    if numeric is None:
        return 0
    numeric = max(0.0, min(5.0, numeric))
    return int(numeric) if numeric.is_integer() else round(numeric, 1)


def _normalize_country_code(value) -> str:
    text = _profile_text(value, 8).upper()
    return text[:2] if len(text) >= 2 and text[:2].isalpha() else ""


def _normalize_profile_signals(value) -> list[str]:
    if isinstance(value, dict):
        raw_signals = [key for key, enabled in value.items() if enabled]
    elif isinstance(value, (list, tuple, set)):
        raw_signals = list(value)
    else:
        raw_signals = []
    signals = []
    seen = set()
    for raw_signal in raw_signals:
        signal = _profile_text(raw_signal, 24).lower()
        if not signal or signal in seen:
            continue
        seen.add(signal)
        signals.append(signal)
        if len(signals) >= 8:
            break
    return signals


def _profile_items(value):
    if isinstance(value, dict):
        if any(key in value for key in ("key", "name", "label", "source", "status", "stars")):
            yield None, value
            return
        for key, item in value.items():
            yield key, item
        return
    if isinstance(value, (list, tuple)):
        for item in value:
            yield None, item


def _profile_services(value, limit: int = 6) -> list[dict]:
    entries = []
    seen = set()
    for fallback_key, item in _profile_items(value):
        if isinstance(item, dict):
            key = _profile_token(item.get("key") or item.get("id") or fallback_key, 24)
            name = _profile_text(item.get("name") or item.get("label") or key, 32)
            status = _profile_status(item.get("status") or item.get("state") or item.get("result"), 24)
        elif isinstance(item, str) and fallback_key:
            key = _profile_token(fallback_key, 24)
            name = _profile_text(fallback_key, 32)
            status = _profile_status(item, 24)
        elif isinstance(item, (str, int, float)):
            key = _profile_token(fallback_key or item, 24)
            name = _profile_text(fallback_key or item, 32)
            status = ""
        else:
            continue
        if not key:
            key = _profile_token(name, 24)
        if not key or key in seen:
            continue
        seen.add(key)
        entries.append({"key": key, "name": name or key, "status": status})
        if len(entries) >= limit:
            break
    return entries


def _profile_scenarios(value, limit: int = 8) -> list[dict]:
    entries = []
    seen = set()
    for fallback_key, item in _profile_items(value):
        if isinstance(item, dict):
            key = _profile_token(item.get("key") or item.get("id") or fallback_key, 24)
            stars = _normalize_stars(item.get("stars", item.get("score", item.get("rating"))))
            verdict = _profile_status(item.get("verdict") or item.get("status") or item.get("label"), 32)
        elif isinstance(item, (int, float)) and fallback_key:
            key = _profile_token(fallback_key, 24)
            stars = _normalize_stars(item)
            verdict = ""
        else:
            continue
        if key not in _IP_PROFILE_SCENARIO_KEYS or key in seen:
            continue
        seen.add(key)
        entries.append({"key": key, "stars": stars, "verdict": verdict})
        if len(entries) >= limit:
            break
    return entries


def _profile_sources(value, limit: int = 8) -> list[dict]:
    entries = []
    seen = set()
    for fallback_key, item in _profile_items(value):
        if isinstance(item, dict):
            name = _profile_text(item.get("source") or item.get("name") or item.get("key") or fallback_key, 32)
            risk_value = item.get("risk", item.get("score", item.get("value")))
        elif isinstance(item, (int, float, str)):
            name = _profile_text(fallback_key or item, 32)
            risk_value = item if fallback_key else None
        else:
            continue
        if not name:
            continue
        risk_key = name.lower()
        if risk_key in seen:
            continue
        seen.add(risk_key)
        risk = _normalize_risk_score(risk_value)
        entries.append({"source": name, "risk": risk if risk is not None else 0})
        if len(entries) >= limit:
            break
    return entries


def _profile_blocklist(value) -> dict | None:
    if not isinstance(value, dict):
        return None
    if not any(key in value for key in ("listed", "checked", "total")):
        return None
    listed_raw = value.get("listed")
    if isinstance(listed_raw, (list, tuple, set, dict)):
        listed = len(listed_raw)
    else:
        listed = max(0, _safe_int(listed_raw, 0))
    checked = max(0, _safe_int(value.get("checked"), 0))
    total = max(0, _safe_int(value.get("total"), 0))
    return {
        "listed": min(1_000_000, listed),
        "checked": min(1_000_000, checked),
        "total": min(1_000_000, total),
    }


def _iter_profile_flag_candidates(value):
    if isinstance(value, list):
        for item in value:
            if isinstance(item, dict):
                yield item
        return
    if isinstance(value, dict):
        if any(key in value for key in ("flags", "source", "name", "risk")):
            yield value
            return
        for item in value.values():
            if isinstance(item, dict):
                yield item


def _collect_profile_flags(payload: dict | None) -> dict | None:
    if not isinstance(payload, dict):
        return None
    flags = {}
    checked = False

    def merge_candidate(candidate) -> None:
        nonlocal checked
        if not isinstance(candidate, dict):
            return
        raw_flags = candidate.get("flags")
        if isinstance(raw_flags, dict):
            for name in _IP_PROFILE_FLAG_KEYS:
                if name in raw_flags and isinstance(raw_flags[name], bool):
                    checked = True
                    flags[name] = bool(flags.get(name, False) or raw_flags[name])
        for name, aliases in _IP_PROFILE_FLAG_ALIASES.items():
            for alias in aliases:
                if alias in candidate and isinstance(candidate[alias], bool):
                    checked = True
                    flags[name] = bool(flags.get(name, False) or candidate[alias])
                    break

    merge_candidate(payload)
    merge_candidate(payload.get("flags"))
    merge_candidate(payload.get("riskAssessment"))
    for source_item in _iter_profile_flag_candidates(payload.get("sources")):
        merge_candidate(source_item)
    risk_breakdown = payload.get("riskBreakdown")
    if isinstance(risk_breakdown, dict):
        for contributor in _iter_profile_flag_candidates(risk_breakdown.get("contributors")):
            merge_candidate(contributor)

    raw_signals = payload.get("signals")
    if isinstance(raw_signals, (list, tuple, set, dict)):
        checked = True
        for signal in _normalize_profile_signals(raw_signals):
            if "proxy" in signal:
                flags["proxy"] = True
            if "hosting" in signal or "datacenter" in signal:
                flags["hosting"] = True
            if "vpn" in signal:
                flags["vpn"] = True
            if "tor" in signal:
                flags["tor"] = True
            if "mobile" in signal or "cellular" in signal:
                flags["mobile"] = True
            if "abuser" in signal or "abuse" in signal or "blocklist" in signal:
                flags["abuser"] = True

    if not checked:
        return None
    return {name: bool(flags.get(name, False)) for name in _IP_PROFILE_FLAG_KEYS}


def _profile_flag_tokens(isp: dict) -> dict | None:
    if not isinstance(isp, dict):
        return None
    raw_tokens = [isp.get("flag"), isp.get("type"), isp.get("warning")]
    if not any(str(token or "").strip() for token in raw_tokens):
        return None
    tokens = " ".join(str(token or "").lower() for token in raw_tokens)
    return {
        "proxy": "proxy" in tokens,
        "hosting": "hosting" in tokens or "datacenter" in tokens,
        "vpn": "vpn" in tokens,
        "tor": "tor" in tokens,
        "mobile": "mobile" in tokens or "cellular" in tokens,
        "abuser": "abuse" in tokens or "abuser" in tokens or "blocklist" in tokens,
    }


def _profile_from_payload(payload: dict | None, source: str, is_native: bool | None = None) -> dict | None:
    if not isinstance(payload, dict):
        return None
    geo = payload.get("geo") if isinstance(payload.get("geo"), dict) else {}
    isp = payload.get("isp") if isinstance(payload.get("isp"), dict) else {}
    profile = {}

    def first(*values):
        for value in values:
            if value is None or value == "":
                continue
            if isinstance(value, (dict, list, tuple, set)):
                continue
            return value
        return None

    asn = first(geo.get("asn"), payload.get("asn"), payload.get("asnNumber"))
    isp_name = first(geo.get("isp"), geo.get("ispName"), payload.get("isp"), isp.get("org"), isp.get("name"))
    org = first(
        geo.get("org"),
        geo.get("asName"),
        geo.get("asOrganization"),
        payload.get("asOrganization"),
        payload.get("org"),
        isp.get("org"),
    )
    country = first(geo.get("countryCode"), geo.get("country_code"), payload.get("countryCode"), payload.get("country_code"), payload.get("country"))
    region = first(geo.get("region"), geo.get("regionName"), payload.get("region"))
    city = first(geo.get("city"), payload.get("city"))
    timezone = first(geo.get("timezone"), payload.get("timezone"))
    reverse = first(geo.get("reverse"), geo.get("rdns"), payload.get("reverse"), isp.get("rdns"))
    if str(reverse or "").strip().lower() in {"none", "null"}:
        reverse = None
    usage_type = first(payload.get("usageType"), payload.get("usage_type"), geo.get("usageType"))
    ip_type = first(payload.get("ipType"), payload.get("ip_type"), geo.get("ipType"))
    native_type = first(payload.get("nativeType"), payload.get("native_type"), geo.get("nativeType"))
    if not native_type and isinstance(is_native, bool):
        native_type = "native" if is_native else "broadcast"
    shared_users_raw = payload.get("sharedUsers")
    if not isinstance(shared_users_raw, (dict, str, int, float)):
        shared_users_raw = geo.get("sharedUsers")
    if isinstance(shared_users_raw, dict):
        shared_users = first(shared_users_raw.get("range"), shared_users_raw.get("label"), shared_users_raw.get("value"))
    else:
        shared_users = shared_users_raw
    purity_band = payload.get("purityBand") if isinstance(payload.get("purityBand"), dict) else {}
    if not purity_band and isinstance(geo.get("purityBand"), dict):
        purity_band = geo["purityBand"]

    text_values = {
        "asn": asn,
        "isp": isp_name,
        "org": org,
        "region": region,
        "city": city,
        "timezone": timezone,
        "reverse": reverse,
        "usage_type": usage_type,
        "ip_type": ip_type,
        "native_type": native_type,
        "shared_users": shared_users,
        "purity_label": purity_band.get("label"),
        "purity_tone": purity_band.get("tone"),
    }
    for field, value in text_values.items():
        text = _profile_text(value, _IP_PROFILE_TEXT_LIMITS[field])
        if text:
            profile[field] = text
    country_code = _normalize_country_code(country)
    if country_code:
        profile["country_code"] = country_code
    drift_km = _normalize_drift_km(first(geo.get("drift_km"), payload.get("drift_km")))
    if drift_km is not None:
        profile["drift_km"] = drift_km
    signals = _normalize_profile_signals(payload.get("signals"))
    if signals:
        profile["signals"] = signals
    flags = _collect_profile_flags(payload)
    if flags:
        profile["flags"] = flags
    blocklist = _profile_blocklist(payload.get("blocklist") or geo.get("blocklist"))
    if blocklist:
        profile["blocklist"] = blocklist
    services = _profile_services(payload.get("services"))
    if services:
        profile["services"] = services
    media = _profile_services(payload.get("media"))
    if media:
        profile["media"] = media
    scenarios = _profile_scenarios(payload.get("scenarios"))
    if scenarios:
        profile["scenarios"] = scenarios
    risk_breakdown = payload.get("riskBreakdown")
    source_items = risk_breakdown.get("contributors") if isinstance(risk_breakdown, dict) else None
    if source_items is None:
        source_items = payload.get("sources")
    sources = _profile_sources(source_items)
    if sources:
        profile["sources"] = sources
    profile["checked_at"] = int(time.time() * 1000)
    profile["source"] = source
    return _normalize_ip_profile(profile)


def _profile_from_testisp(payload: dict | None) -> dict | None:
    if not isinstance(payload, dict):
        return None
    geo = payload.get("geo") if isinstance(payload.get("geo"), dict) else {}
    isp = payload.get("isp") if isinstance(payload.get("isp"), dict) else {}
    is_native = geo.get("is_native") if isinstance(geo.get("is_native"), bool) else None
    profile = _profile_from_payload(payload, "testisp", is_native=is_native) or {
        "checked_at": int(time.time() * 1000),
        "source": "testisp",
    }
    isp_type = _profile_text(isp.get("type"), 32)
    if isp_type:
        profile.setdefault("ip_type", isp_type)
        profile.setdefault("usage_type", isp_type)
    flags = _profile_flag_tokens(isp)
    if flags:
        existing_flags = profile.get("flags") if isinstance(profile.get("flags"), dict) else {}
        profile["flags"] = {
            key: bool(existing_flags.get(key)) or bool(flags.get(key))
            for key in _IP_PROFILE_FLAG_KEYS
        }
    return _normalize_ip_profile(profile)


def _normalize_profile_source(value) -> str:
    tokens = []
    for raw_token in str(value or "").lower().split("+"):
        token = re.sub(r"[^a-z0-9_.-]", "", raw_token)[:16]
        if token and token not in tokens:
            tokens.append(token)
    return "+".join(tokens)[:32]


def _normalize_ip_profile(profile: dict | None) -> dict | None:
    if not isinstance(profile, dict):
        return None
    normalized = {}
    for field, limit in _IP_PROFILE_TEXT_LIMITS.items():
        text = _profile_text(profile.get(field), limit)
        if text:
            normalized[field] = text
    country_code = _normalize_country_code(profile.get("country_code"))
    if country_code:
        normalized["country_code"] = country_code
    drift_km = _normalize_drift_km(profile.get("drift_km"))
    if drift_km is not None:
        normalized["drift_km"] = drift_km
    signals = _normalize_profile_signals(profile.get("signals"))
    if signals:
        normalized["signals"] = signals
    raw_flags = profile.get("flags")
    if isinstance(raw_flags, dict) and any(key in raw_flags for key in _IP_PROFILE_FLAG_KEYS):
        normalized["flags"] = {key: bool(raw_flags.get(key)) for key in _IP_PROFILE_FLAG_KEYS}
    blocklist = _profile_blocklist(profile.get("blocklist"))
    if blocklist:
        normalized["blocklist"] = blocklist
    services = _profile_services(profile.get("services"))
    if services:
        normalized["services"] = services
    media = _profile_services(profile.get("media"))
    if media:
        normalized["media"] = media
    scenarios = _profile_scenarios(profile.get("scenarios"))
    if scenarios:
        normalized["scenarios"] = scenarios
    sources = _profile_sources(profile.get("sources"))
    if sources:
        normalized["sources"] = sources
    checked_at = _safe_int(profile.get("checked_at"), 0)
    if checked_at <= 0:
        checked_at = int(time.time() * 1000)
    normalized["checked_at"] = checked_at
    source = _normalize_profile_source(profile.get("source"))
    if source:
        normalized["source"] = source
    substantive_keys = set(normalized) - {"checked_at", "source"}
    return normalized if substantive_keys else None


def _merge_keyed_profile_list(left, right, key_field: str, limit: int) -> list[dict]:
    merged = []
    seen = set()
    for item in list(left or []) + list(right or []):
        if not isinstance(item, dict):
            continue
        key = str(item.get(key_field) or "")
        if not key or key in seen:
            continue
        seen.add(key)
        merged.append(dict(item))
        if len(merged) >= limit:
            break
    return merged


def _merge_ip_profiles(*profiles) -> dict | None:
    normalized = [profile for profile in (_normalize_ip_profile(item) for item in profiles) if profile]
    if not normalized:
        return None
    merged = dict(normalized[0])
    for profile in normalized[1:]:
        for field in _IP_PROFILE_TEXT_LIMITS:
            if not merged.get(field) and profile.get(field):
                merged[field] = profile[field]
        if not merged.get("country_code") and profile.get("country_code"):
            merged["country_code"] = profile["country_code"]
        if merged.get("drift_km") is None and profile.get("drift_km") is not None:
            merged["drift_km"] = profile["drift_km"]
        signals = _normalize_profile_signals(list(merged.get("signals") or []) + list(profile.get("signals") or []))
        if signals:
            merged["signals"] = signals
        if isinstance(profile.get("flags"), dict):
            flags = dict(merged.get("flags") or {})
            for key in _IP_PROFILE_FLAG_KEYS:
                flags[key] = bool(flags.get(key)) or bool(profile["flags"].get(key))
            merged["flags"] = {key: bool(flags.get(key)) for key in _IP_PROFILE_FLAG_KEYS}
        candidate_blocklist = profile.get("blocklist")
        current_blocklist = merged.get("blocklist")
        if isinstance(candidate_blocklist, dict) and (
            not isinstance(current_blocklist, dict)
            or (
                int(candidate_blocklist.get("checked") or 0),
                int(candidate_blocklist.get("total") or 0),
                int(candidate_blocklist.get("listed") or 0),
            )
            > (
                int(current_blocklist.get("checked") or 0),
                int(current_blocklist.get("total") or 0),
                int(current_blocklist.get("listed") or 0),
            )
        ):
            merged["blocklist"] = dict(candidate_blocklist)
        merged["services"] = _merge_keyed_profile_list(merged.get("services"), profile.get("services"), "key", 6)
        if not merged["services"]:
            merged.pop("services", None)
        merged["media"] = _merge_keyed_profile_list(merged.get("media"), profile.get("media"), "key", 6)
        if not merged["media"]:
            merged.pop("media", None)
        merged["scenarios"] = _merge_keyed_profile_list(merged.get("scenarios"), profile.get("scenarios"), "key", 8)
        if not merged["scenarios"]:
            merged.pop("scenarios", None)
        merged["sources"] = _merge_keyed_profile_list(merged.get("sources"), profile.get("sources"), "source", 8)
        if not merged["sources"]:
            merged.pop("sources", None)
        merged["checked_at"] = max(int(merged.get("checked_at") or 0), int(profile.get("checked_at") or 0))
        merged["source"] = _normalize_profile_source(
            "+".join(filter(None, (merged.get("source"), profile.get("source"))))
        )
    return _normalize_ip_profile(merged)


def _cache_purity_entry(cache: OrderedDict, key: str, value: dict, max_entries: int, now: float | None = None) -> None:
    if not key or not isinstance(value, dict):
        return
    timestamp = time.time() if now is None else float(now)
    with purity_cache_lock:
        cache[key] = (timestamp, dict(value))
        cache.move_to_end(key)
        while len(cache) > max_entries:
            cache.popitem(last=False)


def _get_purity_entry(cache: OrderedDict, key: str, ttl: int, now: float | None = None) -> dict | None:
    if not key:
        return None
    timestamp = time.time() if now is None else float(now)
    with purity_cache_lock:
        cached = cache.get(key)
        if not cached:
            return None
        if timestamp - cached[0] < ttl:
            cache.move_to_end(key)
            return dict(cached[1])
        cache.pop(key, None)
        return None


def _get_ipok_batch(ip: str) -> dict | None:
    return _get_purity_entry(ipok_batch_cache, ip, IPOK_BATCH_CACHE_TTL)


def _get_egress_purity(ip: str) -> dict | None:
    return _get_purity_entry(egress_purity_cache, ip, EGRESS_PURITY_CACHE_TTL)


def _normalize_purity_record(record: dict | None) -> dict | None:
    if not isinstance(record, dict):
        return None
    normalized = {}
    if isinstance(record.get("is_residential"), bool):
        normalized["is_residential"] = record["is_residential"]
    if isinstance(record.get("is_native"), bool):
        normalized["is_native"] = record["is_native"]
    fraud_score = _normalize_risk_score(record.get("fraud_score"))
    if fraud_score is not None:
        normalized["fraud_score"] = fraud_score
    ipok_risk = _normalize_risk_score(record.get("ipok_risk"))
    if ipok_risk is not None:
        normalized["ipok_risk"] = ipok_risk
    purity_source = re.sub(r"[^a-z0-9_+.-]", "", str(record.get("purity_source") or "").lower())[:32]
    if purity_source:
        normalized["purity_source"] = purity_source
    asn_org = str(record.get("asn_org") or "").strip()[:64]
    if asn_org:
        normalized["asn_org"] = asn_org
    ip_profile = _normalize_ip_profile(record.get("ip_profile"))
    if ip_profile:
        normalized["ip_profile"] = ip_profile
    return normalized or None


def _record_egress_purity(node_ip: str, egress_ip: str, purity: dict | None, node: dict | None = None) -> None:
    normalized = _normalize_purity_record(purity)
    if not normalized:
        return
    now = time.time()
    for ip_key in {ip for ip in (node_ip, egress_ip) if ip}:
        _cache_purity_entry(egress_purity_cache, ip_key, normalized, EGRESS_PURITY_CACHE_MAX_ENTRIES, now=now)
    with reservoir_lock:
        if node_ip:
            stored_node = global_node_reservoir.get(node_ip)
            if stored_node is not None:
                stored_node["egress_purity"] = dict(normalized)
        if node is not None:
            node["egress_purity"] = dict(normalized)


def _tunnel_purity_record(tun: "Tunnel") -> dict | None:
    return _normalize_purity_record(
        {
            "is_residential": getattr(tun, "is_residential", None),
            "is_native": getattr(tun, "is_native", None),
            "fraud_score": getattr(tun, "fraud_score", None),
            "ipok_risk": getattr(tun, "ipok_risk", None),
            "purity_source": getattr(tun, "purity_source", ""),
            "asn_org": getattr(tun, "asn_org", ""),
        }
    )


def _apply_tunnel_purity(tun: "Tunnel", purity: dict | None) -> None:
    normalized = _normalize_purity_record(purity) or {}
    tun.is_residential = normalized.get("is_residential")
    tun.is_native = normalized.get("is_native")
    tun.fraud_score = normalized.get("fraud_score")
    tun.ipok_risk = normalized.get("ipok_risk")
    tun.purity_source = normalized.get("purity_source", "")
    tun.asn_org = normalized.get("asn_org", "")
    tun.ip_profile = normalized.get("ip_profile")


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
        self.is_residential: bool | None = None
        self.is_native: bool | None = None
        self.fraud_score: int | None = None
        self.ipok_risk: int | None = None
        self.purity_source = ""
        self.asn_org = ""
        self.ip_profile: dict | None = None
        self.latency_checked_at: int = 0
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


def _compute_ipok_batch_score(batch: dict | None) -> float:
    if not isinstance(batch, dict):
        return 0.0
    ip_type = str(batch.get("type") or "").strip().lower()
    is_hosting = bool(batch.get("hosting"))
    is_proxy = bool(batch.get("proxy"))
    is_vpn = bool(batch.get("vpn"))
    is_tor = bool(batch.get("tor"))
    is_abuse = bool(batch.get("abuse"))
    risk = _normalize_risk_score(batch.get("risk"))
    score = 0.0
    if ip_type in ("residential", "mobile") and not (is_proxy or is_vpn or is_hosting or is_tor or is_abuse):
        score += 150.0
    if is_proxy or is_vpn:
        score -= 180.0
    if is_hosting or is_tor or is_abuse:
        score -= 350.0
    if risk is not None:
        score -= min(250.0, risk * 2.5)
    return score


def _compute_egress_purity_score(purity: dict | None) -> float:
    normalized = _normalize_purity_record(purity)
    if not normalized:
        return 0.0
    score = 0.0
    is_residential = normalized.get("is_residential")
    if is_residential is True:
        score += 120.0
    elif is_residential is False:
        score -= 220.0
    is_native = normalized.get("is_native")
    if is_native is True:
        score += 80.0
    elif is_native is False:
        score -= 60.0
    fraud_score = normalized.get("fraud_score")
    if fraud_score is not None:
        score += (100.0 - fraud_score) * 1.2
    ipok_risk = normalized.get("ipok_risk")
    if ipok_risk is not None:
        score += (100.0 - ipok_risk) * 0.8
    return score


def compute_candidate_score(node: dict, include_measured: bool = True) -> float:
    """Rank a VPNGate candidate without performing any network I/O."""
    node = node or {}
    node_ip = str(node.get("ip") or "")
    speed_mbps = min(1000.0, max(0.0, _safe_float(node.get("speed")) / 1_000_000.0))
    speed_component = speed_mbps * 0.3

    raw_score = max(0.0, _safe_float(node.get("score")))
    score_component = math.log1p(raw_score) * 8.0

    entry_rtt = _safe_float(node.get("entry_rtt_ms"))
    rtt = entry_rtt if entry_rtt > 0 else _safe_float(node.get("ping"), 9999.0)
    rtt_component = 300.0 * (50.0 / max(50.0, rtt))

    sessions = max(0, _safe_int(node.get("sessions"), 20))
    session_component = -min(80.0, math.log1p(sessions) * 8.0)

    measured = _get_measured_quality(node_ip)
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

    ipok_batch = node.get("ipok_batch") if isinstance(node.get("ipok_batch"), dict) else _get_ipok_batch(node_ip)
    batch_purity_component = _compute_ipok_batch_score(ipok_batch)
    egress_purity = (
        node.get("egress_purity")
        if isinstance(node.get("egress_purity"), dict)
        else _get_egress_purity(node_ip)
    )
    measured_purity_component = _compute_egress_purity_score(egress_purity) if include_measured else 0.0

    penalty_component = -max(0.0, _safe_float(node.get("penalty")))
    return (
        speed_component
        + score_component
        + rtt_component
        + session_component
        + ttfb_component
        + measured_component
        + uptime_component
        + batch_purity_component
        + measured_purity_component
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
    tun.is_residential = None
    tun.is_native = None
    tun.fraud_score = None
    tun.ipok_risk = None
    tun.purity_source = ""
    tun.asn_org = ""
    tun.ip_profile = None
    tun.latency_checked_at = 0
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
    main_purity = _tunnel_purity_record(main_tun)
    backup_purity = _tunnel_purity_record(backup_tun)
    if main_purity and backup_purity:
        purity_gain = _compute_egress_purity_score(backup_purity) - _compute_egress_purity_score(main_purity)
        if purity_gain <= -60.0:
            return False
        if purity_gain >= 80.0:
            speed_acceptable = main_speed <= 0 or backup_speed <= 0 or backup_speed >= main_speed * 0.6
            ttfb_acceptable = main_ttfb <= 0 or backup_ttfb <= 0 or backup_ttfb <= main_ttfb + 250
            if speed_acceptable and ttfb_acceptable:
                return True
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


def prescreen_candidates_ipok(candidates: list[dict], max_ips: int = IPOK_BATCH_CHUNK_SIZE, timeout: int = 12) -> int:
    """Batch prescreen uncached VPNGate candidates via IPOK /api/batch."""
    global ipok_batch_cooldown_until
    if not candidates or max_ips <= 0:
        return 0
    now = time.time()
    uncached_ips: list[str] = []
    seen_ips: set[str] = set()
    nodes_by_ip: dict[str, list[dict]] = {}
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        raw_ip = str(candidate.get("ip") or "").strip()
        if not raw_ip:
            continue
        try:
            parsed_ip = ipaddress.ip_address(raw_ip)
        except ValueError:
            continue
        if parsed_ip.version != 4 or not parsed_ip.is_global:
            continue
        ip_text = str(parsed_ip)
        nodes_by_ip.setdefault(ip_text, []).append(candidate)
        cached = _get_ipok_batch(ip_text)
        if cached is not None:
            candidate["ipok_batch"] = cached
            continue
        if ip_text not in seen_ips and len(uncached_ips) < max_ips:
            seen_ips.add(ip_text)
            uncached_ips.append(ip_text)
    if not uncached_ips:
        return 0
    with purity_cache_lock:
        if now < ipok_batch_cooldown_until:
            return 0
    query_url = f"{IPOK_BATCH_URL}?q={urllib.parse.quote(','.join(uncached_ips))}"
    request = urllib.request.Request(
        query_url,
        headers={"User-Agent": "kui-workers-pro/1.0", "Accept": "application/json"},
        method="GET",
    )
    try:
        with _urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as error:
        with purity_cache_lock:
            ipok_batch_cooldown_until = time.time() + IPOK_BATCH_COOLDOWN_SECONDS
        print(f"[*] IPOK 批量预筛跳过（已降级）: {error}", flush=True)
        return 0
    results = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(results, list):
        return 0
    updated = 0
    checked_at = time.time()
    for item in results:
        if not isinstance(item, dict) or item.get("ok") is not True:
            continue
        item_ip = str(item.get("ip") or "").strip()
        if item_ip not in nodes_by_ip:
            continue
        entry = {
            "type": str(item.get("type") or "").strip().lower()[:32],
            "risk": _normalize_risk_score(item.get("risk")),
            "hosting": bool(item.get("hosting")),
            "proxy": bool(item.get("proxy")),
            "vpn": bool(item.get("vpn")),
            "tor": bool(item.get("tor")),
            "abuse": bool(item.get("abuse")),
            "asn": str(item.get("asn") or "").strip()[:32],
            "isp": str(item.get("isp") or "").strip()[:64],
        }
        _cache_purity_entry(ipok_batch_cache, item_ip, entry, IPOK_BATCH_CACHE_MAX_ENTRIES, now=checked_at)
        for candidate in nodes_by_ip[item_ip]:
            candidate["ipok_batch"] = dict(entry)
        with reservoir_lock:
            stored_node = global_node_reservoir.get(item_ip)
            if stored_node is not None:
                stored_node["ipok_batch"] = dict(entry)
        updated += 1
    if updated:
        print(f"[*] IPOK 批量预筛完成: {updated}/{len(uncached_ips)} 个候选节点", flush=True)
    return updated


def _parse_valid_ip(raw_value: str) -> str:
    text = str(raw_value or "").strip()
    if not text:
        return ""
    try:
        return str(ipaddress.ip_address(text))
    except ValueError:
        return ""


def _probe_tunnel_ippure(tun_name: str, timeout: int = 12) -> dict | None:
    try:
        result = subprocess.run(
            ["curl", "-sS", "-m", str(timeout), "--interface", tun_name, "-4", IPPURE_INFO_URL],
            capture_output=True,
            text=True,
        )
    except Exception:
        return None
    if getattr(result, "returncode", 1) != 0 or not str(getattr(result, "stdout", "") or "").strip():
        return None
    try:
        payload = json.loads(result.stdout)
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    resolved_ip = _parse_valid_ip(payload.get("ip"))
    if not resolved_ip:
        return None
    is_residential = payload.get("isResidential") if isinstance(payload.get("isResidential"), bool) else None
    is_native = (not payload.get("isBroadcast")) if isinstance(payload.get("isBroadcast"), bool) else None
    fraud_score = _normalize_risk_score(payload.get("fraudScore"))
    record = {
        "ip": resolved_ip,
        "country": str(payload.get("countryCode") or "").strip().upper()[:2],
        "asn_org": str(payload.get("asOrganization") or "").strip()[:64],
        "is_residential": is_residential,
        "is_native": is_native,
        "fraud_score": fraud_score,
        "purity_source": "ippure",
    }
    ip_profile = _profile_from_payload(payload, "ippure", is_native=is_native)
    if ip_profile:
        record["ip_profile"] = ip_profile
    _cache_purity_entry(ippure_cache, resolved_ip, record, IPPURE_CACHE_MAX_ENTRIES)
    return record


def _probe_tunnel_ipok(
    tun_name: str,
    egress_ip: str = "",
    timeout: int = 12,
    cache_unverified_ip: bool = True,
) -> dict | None:
    if egress_ip:
        cached = _get_purity_entry(ipok_detail_cache, egress_ip, IPOK_DETAIL_CACHE_TTL)
        if cached is not None:
            return cached
    try:
        result = subprocess.run(
            [
                "curl",
                "-sS",
                "-m",
                str(timeout),
                "--interface",
                tun_name,
                "-4",
                "-H",
                "Accept: application/json",
                "-H",
                "User-Agent: kui-workers-pro/1.0",
                IPOK_IP_URL,
            ],
            capture_output=True,
            text=True,
        )
    except Exception:
        return None
    if getattr(result, "returncode", 1) != 0 or not str(getattr(result, "stdout", "") or "").strip():
        return None
    try:
        payload = json.loads(result.stdout)
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    geo = payload.get("geo") if isinstance(payload.get("geo"), dict) else {}
    reported_ip = _parse_valid_ip(geo.get("ip"))
    expected_ip = _parse_valid_ip(egress_ip)
    if reported_ip and expected_ip and reported_ip != expected_ip:
        return None
    resolved_ip = reported_ip or expected_ip
    ip_type = str(payload.get("ipType") or "").strip().lower()
    if ip_type in ("residential", "mobile"):
        is_residential = True
    elif ip_type == "hosting":
        is_residential = False
    else:
        is_residential = None
    native_type = str(payload.get("nativeType") or "").strip().lower()
    if native_type == "native":
        is_native = True
    elif native_type == "broadcast":
        is_native = False
    else:
        is_native = None
    assessment = payload.get("riskAssessment") if isinstance(payload.get("riskAssessment"), dict) else {}
    score_available = assessment.get("scoreAvailable") is True
    ipok_risk = _normalize_risk_score(payload.get("risk")) if score_available else None
    raw_signals = payload.get("signals") if isinstance(payload.get("signals"), list) else []
    signals = [str(sig).strip().lower() for sig in raw_signals if str(sig).strip()]
    asn_org = str(geo.get("isp") or geo.get("asName") or "").strip()[:64]
    ip_profile = _profile_from_payload(payload, "ipok", is_native=is_native)
    if is_residential is None and is_native is None and ipok_risk is None and not signals and not ip_profile:
        return None
    record = {
        "ip": resolved_ip,
        "asn_org": asn_org,
        "is_residential": is_residential,
        "is_native": is_native,
        "ipok_risk": ipok_risk,
        "signals": signals,
        "purity_source": "ipok",
    }
    if ip_profile:
        record["ip_profile"] = ip_profile
    if reported_ip:
        _cache_purity_entry(ipok_detail_cache, reported_ip, record, IPOK_DETAIL_CACHE_MAX_ENTRIES)
    elif expected_ip and cache_unverified_ip:
        _cache_purity_entry(ipok_detail_cache, expected_ip, record, IPOK_DETAIL_CACHE_MAX_ENTRIES)
    return record


def _evaluate_egress_purity(
    tun_name: str,
    egress_ip: str,
    ippure_data: dict | None = None,
    cache_unverified_ipok: bool = True,
) -> tuple[dict | None, bool, str]:
    """Evaluate tunnel egress purity via IPPure -> IPOK -> testisp.info fallback."""
    ippure_record = ippure_data if isinstance(ippure_data, dict) else _get_purity_entry(ippure_cache, egress_ip, IPPURE_CACHE_TTL)
    sources: list[str] = []
    ip_profiles: list[dict] = []
    merged: dict = {}

    def finalize(accepted: bool, reason: str) -> tuple[dict | None, bool, str]:
        merged["purity_source"] = "+".join(sources)
        ip_profile = _merge_ip_profiles(*ip_profiles)
        if ip_profile:
            merged["ip_profile"] = ip_profile
        return _normalize_purity_record(merged), accepted, reason

    if ippure_record:
        sources.append("ippure")
        if isinstance(ippure_record.get("ip_profile"), dict):
            ip_profiles.append(ippure_record["ip_profile"])
        for key in ("is_residential", "is_native", "fraud_score", "asn_org"):
            if ippure_record.get(key) is not None and ippure_record.get(key) != "":
                merged[key] = ippure_record[key]
        fraud_score = merged.get("fraud_score")
        is_residential = merged.get("is_residential")
        is_native = merged.get("is_native")
        print(
            f"[*] {tun_name} IPPure 报告 {egress_ip}: residential={is_residential}, native={is_native}, fraudScore={fraud_score}, org={merged.get('asn_org', '')}",
            flush=True,
        )
        if fraud_score is not None and fraud_score >= IPPURE_HARD_REJECT_FRAUD_SCORE:
            return finalize(False, f"IPPure 高风险 fraudScore={fraud_score}")
        if is_residential is False and (
            (fraud_score is not None and fraud_score >= IPPURE_NON_RES_REJECT_FRAUD_SCORE)
            or is_native is False
        ):
            return finalize(False, f"IPPure 判定非住宅高危出口 (fraudScore={fraud_score}, native={is_native})")

    ipok_record = _probe_tunnel_ipok(
        tun_name,
        egress_ip=egress_ip,
        cache_unverified_ip=cache_unverified_ipok,
    )
    if ipok_record:
        sources.append("ipok")
        if isinstance(ipok_record.get("ip_profile"), dict):
            ip_profiles.append(ipok_record["ip_profile"])
        if "is_residential" not in merged and ipok_record.get("is_residential") is not None:
            merged["is_residential"] = ipok_record["is_residential"]
        if "is_native" not in merged and ipok_record.get("is_native") is not None:
            merged["is_native"] = ipok_record["is_native"]
        if ipok_record.get("ipok_risk") is not None:
            merged["ipok_risk"] = ipok_record["ipok_risk"]
        if not merged.get("asn_org") and ipok_record.get("asn_org"):
            merged["asn_org"] = ipok_record["asn_org"]
        signals = set(ipok_record.get("signals") or [])
        ipok_risk = ipok_record.get("ipok_risk")
        print(
            f"[*] {tun_name} IPOK 复核 {egress_ip}: risk={ipok_risk}, signals={sorted(signals)}, residential={ipok_record.get('is_residential')}",
            flush=True,
        )
        hit_signals = sorted(signals & IPOK_HARD_REJECT_SIGNALS)
        if hit_signals:
            return finalize(False, f"IPOK 命中高危信号 {','.join(hit_signals)}")
        if ipok_risk is not None and ipok_risk >= IPOK_HARD_REJECT_RISK:
            return finalize(False, f"IPOK 风险分过高 risk={ipok_risk}")

    if sources:
        return finalize(True, "")

    is_residential = True
    fallback_purity: dict = {"purity_source": "testisp"}
    testisp_profile = None
    try:
        data = _testisp_lookup(egress_ip)
        print(f"[*] {tun_name} testisp.info 报告 {egress_ip}: {data.get('isp',{})} / native={data.get('geo',{}).get('is_native','?')}", flush=True)
        testisp_profile = _profile_from_testisp(data)
        isp = data.get("isp", {}) if isinstance(data, dict) else {}
        geo = data.get("geo", {}) if isinstance(data, dict) else {}
        isp_flag = str(isp.get("flag", "")).lower()
        isp_type = str(isp.get("type", "")).lower()
        isp_warn = str(isp.get("warning", "")).lower()
        is_native = geo.get("is_native") if isinstance(geo.get("is_native"), bool) else None
        if is_native is not None:
            fallback_purity["is_native"] = is_native
        org_text = str(isp.get("org") or "").strip()[:64]
        if org_text:
            fallback_purity["asn_org"] = org_text
        if isp_flag == "hosting":
            residential_indicators = [
                "isp" in isp_type,
                "broadband" in isp_type,
                "dsl" in isp_type,
                "cable" in isp_type,
                is_native is True,
                "hosting" not in isp_warn and "datacenter" not in isp_warn,
            ]
            if not any(residential_indicators):
                is_residential = False
                fallback_purity["is_residential"] = False
        elif isp_flag in ("isp", "residential") or any(token in isp_type for token in ("residential", "broadband", "dsl", "cable")):
            fallback_purity["is_residential"] = True
    except Exception as error:
        print(f"[*] {tun_name} testisp.info 查询失败: {error}", flush=True)
        fallback_purity = {}
        testisp_profile = None
    if testisp_profile:
        fallback_purity["ip_profile"] = testisp_profile
    if not is_residential:
        return _normalize_purity_record(fallback_purity), False, "testisp.info 判定为机房 IP"
    return _normalize_purity_record(fallback_purity), True, ""


def _tunnel_context(tun_name: str) -> tuple[str, str]:
    with state_lock:
        for tun in (tun_main, tun_backup):
            if tun.name == tun_name:
                return tun.entry_ip, tun.country or target_country
    return "", target_country


def probe_tunnel_quality(tun_name: str, node_ip: str = "", country: str = "", record_timestamp: bool = True) -> TunnelQuality | None:
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
    if record_timestamp:
        with state_lock:
            for tun in (tun_main, tun_backup):
                if tun.name == tun_name:
                    tun.latency_checked_at = int(time.time() * 1000)
                    break
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


def _find_tunnel_by_name_unlocked(name: str) -> "Tunnel | None":
    for tun in (tun_main, tun_backup):
        if tun.name == name:
            return tun
    return None


def _find_tunnel_by_name(name: str) -> "Tunnel | None":
    with state_lock:
        return _find_tunnel_by_name_unlocked(name)


def _select_probe_tunnel(role: str) -> "Tunnel | None":
    with state_lock:
        active_name = proxy_server.ACTIVE_BIND or tun_main.name
        if tun_main.name == active_name:
            active_tun, other_tun = tun_main, tun_backup
        elif tun_backup.name == active_name:
            active_tun, other_tun = tun_backup, tun_main
        else:
            active_tun, other_tun = tun_main, tun_backup
        target = other_tun if role == "standby" else active_tun
        if not target.ready or not _process_is_alive(target.process):
            return None
        return target


def _clear_probe_caches(egress_ip: str) -> None:
    if not egress_ip:
        return
    with purity_cache_lock:
        ippure_cache.pop(egress_ip, None)
        ipok_detail_cache.pop(egress_ip, None)
    with testisp_cache_lock:
        testisp_cache.pop(egress_ip, None)


def _snapshot_probe_tunnel(tun: "Tunnel") -> tuple[str, str, str, int, object, str]:
    with state_lock:
        return (
            tun.name,
            tun.egress_ip or tun.entry_ip,
            tun.entry_ip,
            tun.dial_token,
            tun.proc,
            tun.country,
        )


def _probe_tunnel_still_matches(tun: "Tunnel", expected_name: str, expected_egress_ip: str, expected_dial_token: int, expected_proc: object) -> bool:
    current = _find_tunnel_by_name_unlocked(expected_name)
    if current is not tun or not tun.ready:
        return False
    if tun.dial_token != expected_dial_token or tun.proc is not expected_proc:
        return False
    return (tun.egress_ip or tun.entry_ip) == expected_egress_ip


def _handle_recheck_purity(tun: "Tunnel") -> bool:
    tun_name, egress_ip, entry_ip, expected_dial_token, expected_proc, _ = _snapshot_probe_tunnel(tun)
    if not egress_ip:
        print(f"[probe] {tun_name} 缺少出口 IP，跳过纯净度重测", flush=True)
        return False
    _clear_probe_caches(egress_ip)
    try:
        ippure_data = _probe_tunnel_ippure(tun_name, timeout=12)
        if isinstance(ippure_data, dict):
            ippure_ip = _parse_valid_ip(ippure_data.get("ip"))
            if ippure_ip and ippure_ip != _parse_valid_ip(egress_ip):
                print(f"[probe] {tun_name} 重测期间出口已变更 ({egress_ip} -> {ippure_ip})，丢弃本次纯净度结果", flush=True)
                return False
        purity, accepted, reason = _evaluate_egress_purity(
            tun_name,
            egress_ip,
            ippure_data=ippure_data,
            cache_unverified_ipok=False,
        )
        with state_lock:
            if not _probe_tunnel_still_matches(tun, tun_name, egress_ip, expected_dial_token, expected_proc):
                print(f"[probe] {tun_name} 重测期间通道已变更，丢弃本次纯净度结果", flush=True)
                return False
            if purity:
                _apply_tunnel_purity(tun, purity)
                is_residential = tun.is_residential
                is_native = tun.is_native
        if purity:
            _record_egress_purity(entry_ip, egress_ip, purity)
            print(
                f"[probe] {tun_name} 纯净度重测完成: accepted={accepted}, reason={reason or '-'}, "
                f"residential={is_residential}, native={is_native}",
                flush=True,
            )
        else:
            print(f"[probe] {tun_name} 纯净度重测无可用结果，保留现有状态", flush=True)
        return True
    except Exception as error:
        print(f"[probe] {tun_name} 纯净度重测失败，保留现有连通状态: {error}", flush=True)
        return False
    finally:
        heartbeat_wakeup.set()


def _handle_probe_latency(tun: "Tunnel") -> bool:
    tun_name, egress_ip, entry_ip, expected_dial_token, expected_proc, country = _snapshot_probe_tunnel(tun)
    try:
        quality = probe_tunnel_quality(
            tun_name,
            node_ip=entry_ip,
            country=country,
            record_timestamp=False,
        )
        if quality is None:
            print(f"[probe] {tun_name} 延迟重测未取得有效结果，保留现有状态", flush=True)
            return False
        with state_lock:
            if not _probe_tunnel_still_matches(tun, tun_name, egress_ip, expected_dial_token, expected_proc):
                print(f"[probe] {tun_name} 重测期间通道已变更，丢弃本次延迟结果", flush=True)
                return False
            tun.ttfb_ms = int(quality.ttfb_ms)
            tun.speed_kbps = int(quality.speed_kbps)
            tun.latency_checked_at = int(time.time() * 1000)
            ttfb_ms = tun.ttfb_ms
            speed_kbps = tun.speed_kbps
        print(
            f"[probe] {tun_name} 延迟重测完成: ttfb={ttfb_ms}ms, speed={speed_kbps}kbps",
            flush=True,
        )
        return True
    except Exception as error:
        print(f"[probe] {tun_name} 延迟重测失败，保留现有状态: {error}", flush=True)
        return False
    finally:
        heartbeat_wakeup.set()


def _handle_manual_probe(action: str, role: str = "active") -> bool:
    action = str(action or "").strip().lower()
    role = str(role or "active").strip().lower()
    if role not in {"active", "standby"}:
        role = "active"
    if action not in {"recheck_purity", "probe_latency"}:
        print(f"[probe] 忽略未知主动探针动作: {action or '-'}", flush=True)
        return False
    tun = _select_probe_tunnel(role)
    if tun is None:
        print(f"[probe] 未找到已就绪的 {role} 通道，跳过 {action}", flush=True)
        return False
    print(f"[probe] 执行主动探针: action={action}, role={role}, tunnel={tun.name}", flush=True)
    if action == "recheck_purity":
        return _handle_recheck_purity(tun)
    return _handle_probe_latency(tun)


def update_config_loop():
    global target_country, last_switch_trigger, last_probe_trigger, probe_trigger_initialized, PROXY_PORT, PROXY_PUBLIC_LISTENER, PROXY_LISTEN_HOST, tun_main, tun_backup, last_config_log, REALTIME_URL, realtime_channel, config_generation
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
            probe_trigger = max(0, _safe_int(data.get("probe_trigger"), 0))
            probe_action = str(data.get("probe_action") or "").strip().lower()
            probe_role = str(data.get("probe_role") or "active").strip().lower()
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
            if not probe_trigger_initialized:
                probe_trigger_initialized = True
                if probe_trigger > 0:
                    last_probe_trigger = probe_trigger
            elif probe_trigger > last_probe_trigger:
                last_probe_trigger = probe_trigger
                try:
                    _handle_manual_probe(probe_action, probe_role)
                except Exception as probe_error:
                    print(f"[probe] 主动探针执行异常: {probe_error}", flush=True)
            if realtime_channel and realtime_channel.connected:
                realtime_channel.send({"success": True, "country": desired_country, "switch_trigger": switch_trigger, "applied_at": int(time.time() * 1000)}, "config.result")
        except Exception as e:
            print(f"[cfg] 拉取配置失败: {e}", flush=True)
            if realtime_channel and realtime_channel.connected:
                realtime_channel.send({"success": False, "error": str(e)[:500], "applied_at": int(time.time() * 1000)}, "config.result")
        config_wakeup.wait(timeout=REALTIME_HTTP_INTERVAL if realtime_channel and realtime_channel.connected else 300)


def _proxy_load_metrics() -> dict:
    raw = {}
    if hasattr(proxy_server, "get_proxy_metrics"):
        try:
            raw = proxy_server.get_proxy_metrics()
        except Exception:
            raw = {}
    if not isinstance(raw, dict):
        raw = {}
    fallback_max = _safe_int(getattr(proxy_server, "MAX_CONNECTIONS", 0), 0)
    return {
        "active_conns": max(0, _safe_int(raw.get("active_conns"), 0)),
        "max_conns": max(0, _safe_int(raw.get("max_conns"), fallback_max)),
        "bytes_up": max(0, _safe_int(raw.get("bytes_up"), 0)),
        "bytes_down": max(0, _safe_int(raw.get("bytes_down"), 0)),
    }


def c2_heartbeat_loop():
    global public_ip, PROXY_PORT, tun_main, tun_backup
    while True:
        if not public_ip or public_ip == "Unknown_IP": get_public_ip()
        details = []
        proxy_metrics = _proxy_load_metrics()
        with state_lock:
            for tun in [tun_main, tun_backup]:
                if tun.ready and tun.process and tun.process.poll() is None:
                    uptime = time.time() - tun.connected_at
                    detail = {
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
                    }
                    detail.update(proxy_metrics)
                    purity = _tunnel_purity_record(tun)
                    if purity:
                        detail.update(purity)
                    if tun.latency_checked_at > 0:
                        detail["latency_checked_at"] = int(tun.latency_checked_at)
                    if isinstance(tun.ip_profile, dict) and tun.ip_profile:
                        detail["ip_profile"] = dict(tun.ip_profile)
                    details.append(detail)
        
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
                            "ipok_batch",
                            "egress_purity",
                        ):
                            if key in existing:
                                n[key] = existing[key]
                    global_node_reservoir[n["ip"]] = n
                reservoir_count = len(global_node_reservoir)
                prescreen_targets = [dict(node) for node in global_node_reservoir.values() if _matches_target_country(node)]
            if reservoir_count != last_reservoir_log_count:
                print(f"[*] ⚡ 节点库更新，当前囤积有效节点 -> {reservoir_count} 个", flush=True)
                last_reservoir_log_count = reservoir_count
            if prescreen_targets:
                prescreen_targets.sort(key=lambda item: compute_candidate_score(item, include_measured=False), reverse=True)
                prescreen_candidates_ipok(prescreen_targets[:IPOK_BATCH_CHUNK_SIZE])
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
        ippure_data = _probe_tunnel_ippure(tun.name, timeout=12)
        if ippure_data and ippure_data.get("ip"):
            true_ip = str(ippure_data["ip"])
        if not true_ip:
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

        egress_purity, purity_accepted, reject_reason = _evaluate_egress_purity(
            tun.name,
            egress_ip,
            ippure_data=ippure_data,
        )
        if not purity_accepted:
            print(f"[-] {tun.name} 节点出口 ({egress_ip}) 未通过纯净度验收 ({reject_reason})，抛弃！", flush=True)
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
                        _apply_tunnel_purity(tun, egress_purity)
                        tun.ready = True
                else:
                    tun.node = node
                    tun.egress_ip = egress_ip
                    egress_owned = True
                    tun.country = node["country"]
                    tun.connected_at = time.time()
                    tun.ttfb_ms = int(quality.ttfb_ms)
                    tun.speed_kbps = int(quality.speed_kbps)
                    _apply_tunnel_purity(tun, egress_purity)
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
        _record_egress_purity(node["ip"], egress_ip, egress_purity, node=node)
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

def run_proxy_server():
    while True:
        try:
            proxy_server.start_proxy_server(PROXY_LISTEN_HOST, PROXY_PORT)
        except Exception as error:
            print(f"[proxy] listener stopped: {error}; retrying in 5 seconds", flush=True)
        time.sleep(5)

def main():
    global PROXY_PORT, PROXY_PUBLIC_LISTENER, PROXY_LISTEN_HOST, tun_main, target_country, last_switch_trigger, last_probe_trigger, probe_trigger_initialized, REALTIME_URL, realtime_channel
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
            last_probe_trigger = max(0, _safe_int(initial.get("probe_trigger"), 0))
            probe_trigger_initialized = True
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
    threading.Thread(target=run_proxy_server, daemon=True).start()
    threading.Thread(target=health_check_loop, daemon=True).start()
    threading.Thread(target=c2_heartbeat_loop, daemon=True).start()
    marker = WORKSPACE / ".update-pending"
    if marker.exists():
        if not initial or not proxy_server.listener_ready.wait(UPDATE_READY_WAIT_SECONDS):
            print("[proxy] updated version failed controller readiness", flush=True)
            raise SystemExit(1)
        try: marker.unlink()
        except FileNotFoundError: pass
    maintain_pool()

if __name__ == "__main__":
    main()
