# -*- coding: utf-8 -*-
import urllib.request
import urllib.parse
import http.client
import json
import os
import time
import subprocess
import re
import sys
import base64
import socket
import platform
import tempfile
import shutil
import hashlib
import hmac
import threading
import configparser
import ipaddress
import random
import tarfile
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

# 强制系统编码锁
if sys.stdout.encoding != 'UTF-8':
    try: sys.stdout.reconfigure(encoding='utf-8')
    except Exception: pass

CONF_FILE = "/opt/kui/config.json"
SINGBOX_CONF_PATH = "/etc/sing-box/config.json"
WARP_CONF_PATH = "/opt/kui/warp.json"
WARP_BENCH_CONF_PATH = "/opt/kui/warp-benchmark.json"
WARP_OPT_STATE_PATH = "/opt/kui/warp-optimizer.json"
WARP_MANUAL_SCAN_COOLDOWN_MS = 60 * 1000
WARP_AUTO_SCAN_COOLDOWN_MS = 15 * 60 * 1000
EGRESS_STATE_PATH = "/opt/kui/egress-state.json"
TRAFFIC_STATE_PATH = "/opt/kui/traffic-state.json"
WGCF_VERSION = "2.2.31"
WGCF_ASSETS = {
    "x86_64": ("amd64", "69147e1a517c66129edd8ac8cb60484d6c9515178d7b4a2f95e3c925f225572a"),
    "aarch64": ("arm64", "b9bdbdeaa3f9f4ba741ba55b8bd94c24f7166c27668eb7e8192ccf9746961182"),
}
CLOUDFLARED_VERSION = "2026.7.1"
CLOUDFLARED_ASSETS = {
    "x86_64": ("amd64", "79a0ade7fc854f62c1aaef48424d9d979e8c2fcd039189d24db82b84cd146be1"),
    "aarch64": ("arm64", "18f2c9bfc7a67a971bd96f1a5a1935def3c1e52aa386626f1566f04e9b5478d6"),
}
MTG_VERSION = "2.2.8"
MTG_ASSETS = {
    "x86_64": ("amd64", "7ef19d079d85f4e00d4f8334ec1f3f3c8718e3d0ed1f3109ea9a8673138a2102"),
    "amd64": ("amd64", "7ef19d079d85f4e00d4f8334ec1f3f3c8718e3d0ed1f3109ea9a8673138a2102"),
    "aarch64": ("arm64", "562a94dd4cafcb8f179b76cfeafb76da12747c8e230bc76235bf8746cc189644"),
    "arm64": ("arm64", "562a94dd4cafcb8f179b76cfeafb76da12747c8e230bc76235bf8746cc189644"),
}
MTPROXY_ROOT = "/opt/kui/mtproxy"
MTPROXY_BIN = f"{MTPROXY_ROOT}/bin/mtg"
MTPROXY_NODE_DIR = f"{MTPROXY_ROOT}/nodes"

try:
    with open(CONF_FILE, 'r') as f:
        env = json.load(f)
except Exception:
    print("Failed to read config file.")
    exit(1)

API_URL = env["api_url"]
REPORT_URL = env["report_url"]
VPS_IP = env["ip"]
TOKEN = env["token"]
GITHUB_PROXY = str(env.get("github_proxy") or "").rstrip("/")

HEADERS = {'Content-Type': 'application/json', 'Authorization': TOKEN, 'User-Agent': 'KUI-Unified-Agent/2.0'}

# 🌟 住宅IP代理：凭证与端口统一取自环境变量（与 Pages 端 PROXY_USER/PROXY_PASS/PROXY_PORT 保持一致）
PROXY_USER = os.environ.get("PROXY_USER", "")
PROXY_PASS = os.environ.get("PROXY_PASS", "")
PROXY_PORT = int(os.environ.get("PROXY_PORT", "7920"))
BASE_URL = API_URL.rsplit('/api/', 1)[0] if '/api/' in API_URL else API_URL
# 住宅IP代理后端：默认与 KUI 同域；独立部署 Free-Residential-IP-Proxy-Controller 时，
# 通过环境变量 PROXY_API_URL 或 config.json 的 proxy_api 指向其地址。
PROXY_API = os.environ.get("PROXY_API_URL") or (env.get("proxy_api") if isinstance(env, dict) else None) or BASE_URL

# 住宅IP代理控制器认证：优先使用控制器专用 Basic Auth，回退为 Bearer Token
PROXY_CTRL_USER = os.environ.get("PROXY_CTRL_USER", env.get("proxy_ctrl_user", "") if isinstance(env, dict) else "")
PROXY_CTRL_PASS = os.environ.get("PROXY_CTRL_PASS", env.get("proxy_ctrl_pass", "") if isinstance(env, dict) else "")
REALTIME_URL = env.get("realtime_url", "") if isinstance(env, dict) else ""
SS2022_KEY_BYTES = {
    "2022-blake3-aes-128-gcm": 16,
    "2022-blake3-aes-256-gcm": 32,
}

def validate_ss2022_credentials(method, password):
    expected_bytes = SS2022_KEY_BYTES.get(method)
    if not expected_bytes:
        raise ValueError("invalid Shadowsocks 2022 method")
    try:
        decoded = base64.b64decode(password, validate=True)
    except (TypeError, ValueError, base64.binascii.Error):
        raise ValueError("invalid Shadowsocks 2022 key")
    if len(decoded) != expected_bytes or base64.b64encode(decoded).decode() != password:
        raise ValueError(f"Shadowsocks 2022 key must decode to {expected_bytes} bytes")

def _require_https_url(value, name):
    parsed = urllib.parse.urlsplit(value or "")
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise RuntimeError(f"{name} must be HTTPS without credentials or fragment")
    return value.rstrip("/")

API_URL = _require_https_url(API_URL, "api_url")
REPORT_URL = _require_https_url(REPORT_URL, "report_url")
BASE_URL = API_URL.rsplit('/api/', 1)[0] if '/api/' in API_URL else API_URL
if urllib.parse.urlsplit(REPORT_URL).netloc != urllib.parse.urlsplit(BASE_URL).netloc: raise RuntimeError("report_url must use the Pages API origin")
PROXY_API = _require_https_url(PROXY_API, "proxy_api")
if REALTIME_URL: REALTIME_URL = _require_https_url(REALTIME_URL, "realtime_url")

def _proxy_ctrl_headers():
    if PROXY_API.rstrip('/') != BASE_URL.rstrip('/') and PROXY_CTRL_USER and PROXY_CTRL_PASS:
        return { 'User-Agent': 'Mozilla/5.0', 'Authorization': 'Basic ' + base64.b64encode(f"{PROXY_CTRL_USER}:{PROXY_CTRL_PASS}".encode()).decode() }
    return HEADERS

CONTROL_REQUEST_TIMEOUT = 12
CONTROL_REQUEST_ATTEMPTS = 3

def _controller_json_request(url, *, data=None, headers=None, method=None):
    last_error = None
    for attempt in range(CONTROL_REQUEST_ATTEMPTS):
        try:
            request = urllib.request.Request(url, data=data, headers=headers or HEADERS, method=method)
            with _urlopen(request, timeout=CONTROL_REQUEST_TIMEOUT) as response:
                raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
        except Exception as error:
            last_error = error
            if attempt < CONTROL_REQUEST_ATTEMPTS - 1: time.sleep(2 ** attempt)
    raise last_error

last_reported_bytes = {}
last_reported_system_bytes = None
argo_tunnels = {}
prev_cpu_total = prev_cpu_idle = 0
prev_rx = prev_tx = 0
loop_counter = 0
last_update_check = 0

# 🌟 住宅IP代理配置缓存
current_proxy_config = {}
proxy_port_conflict = None

def persist_agent_token(token):
    global TOKEN, HEADERS
    if not token or token == TOKEN:
        return
    updated = dict(env)
    updated["token"] = token
    temp_config = CONF_FILE + ".tmp"
    with open(temp_config, "w", encoding="utf-8") as config_file:
        json.dump(updated, config_file)
        config_file.flush()
        os.fsync(config_file.fileno())
    os.chmod(temp_config, 0o600)
    os.replace(temp_config, CONF_FILE)
    TOKEN = token
    HEADERS["Authorization"] = token
    print("[agent] migrated to the server-specific agent token", flush=True)

def _write_json_state(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    descriptor, temp_path = tempfile.mkstemp(prefix=os.path.basename(path) + ".", suffix=".tmp", dir=os.path.dirname(path))
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as state_file:
            json.dump(value, state_file, separators=(",", ":")); state_file.flush(); os.fsync(state_file.fileno())
        os.chmod(temp_path, 0o600); os.replace(temp_path, path)
    finally:
        if os.path.exists(temp_path): os.remove(temp_path)

def _load_traffic_state():
    try:
        with open(TRAFFIC_STATE_PATH, "r", encoding="utf-8") as state_file: state = json.load(state_file)
        return state if isinstance(state, dict) else {}
    except Exception:
        return {}

def _ensure_wgcf():
    machine = platform.machine().lower()
    asset = WGCF_ASSETS.get(machine)
    if not asset:
        raise RuntimeError(f"WARP registration is unsupported on {machine}")
    arch, expected = asset
    target = "/opt/kui/wgcf"
    if os.path.exists(target):
        with open(target, "rb") as binary:
            if hashlib.sha256(binary.read()).hexdigest() == expected: return target
    url = f"https://github.com/ViRb3/wgcf/releases/download/v{WGCF_VERSION}/wgcf_{WGCF_VERSION}_linux_{arch}"
    temp_path = target + ".tmp"
    request = urllib.request.Request(url, headers={"User-Agent": "KUI-WARP/1.0"})
    with _urlopen(request, timeout=60) as response:
        source = response.read(20 * 1024 * 1024)
    if hashlib.sha256(source).hexdigest() != expected:
        raise RuntimeError("wgcf checksum mismatch")
    with open(temp_path, "wb") as binary: binary.write(source)
    os.chmod(temp_path, 0o700)
    os.replace(temp_path, target)
    return target

def _validate_warp_profile(profile):
    required = {"private_key", "ipv4_address", "ipv6_address", "peer_address", "peer_port", "peer_public_key"}
    if not isinstance(profile, dict) or not required.issubset(profile):
        raise ValueError("incomplete WARP profile")
    ipv4 = ipaddress.ip_interface(profile["ipv4_address"])
    ipv6 = ipaddress.ip_interface(profile["ipv6_address"])
    ipaddress.ip_address(profile["peer_address"])
    if ipv4.version != 4 or ipv6.version != 6:
        raise ValueError("invalid WARP address families")
    peer_port = int(profile["peer_port"])
    mtu = int(profile.get("mtu", 1280))
    if not 1 <= peer_port <= 65535 or not 1280 <= mtu <= 1420:
        raise ValueError("invalid WARP port or MTU")
    if len(base64.b64decode(profile["private_key"], validate=True)) != 32 or len(base64.b64decode(profile["peer_public_key"], validate=True)) != 32:
        raise ValueError("invalid WARP key")
    profile["peer_host"] = str(profile.get("peer_host") or "engage.cloudflareclient.com").strip("[]")
    return profile

def _load_warp_profile_path(path):
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as profile_file:
                profile = _validate_warp_profile(json.load(profile_file))
            os.chmod(path, 0o600)
            return profile
        except Exception:
            return None
    return None

def _load_warp_profile():
    return _load_warp_profile_path(WARP_CONF_PATH)

def _generate_warp_profile(registration_attempts=5):
    wgcf = _ensure_wgcf()
    workdir = tempfile.mkdtemp(prefix="kui-warp-", dir="/opt/kui")
    try:
        registered = None
        for attempt in range(registration_attempts):
            registered = subprocess.run([wgcf, "register", "--accept-tos"], cwd=workdir, capture_output=True, text=True, timeout=60)
            if registered.returncode == 0:
                break
            err_msg = (registered.stderr or registered.stdout).strip()
            if "429" in err_msg and attempt < registration_attempts - 1:
                delay = 15 * (2 ** attempt)
                print(f"[agent] WARP registration rate-limited, retrying in {delay}s ({attempt+1}/{registration_attempts})", flush=True)
                time.sleep(delay)
                continue
            raise RuntimeError(f"WARP registration failed: {err_msg[-300:]}")
        if registered is None or registered.returncode != 0:
            raise RuntimeError(f"WARP registration failed after {registration_attempts} attempts")
        generated = subprocess.run([wgcf, "generate"], cwd=workdir, capture_output=True, text=True, timeout=30)
        if generated.returncode != 0:
            raise RuntimeError(f"WARP profile generation failed: {(generated.stderr or generated.stdout).strip()[-300:]}")
        parser = configparser.ConfigParser(strict=False)
        parser.read(os.path.join(workdir, "wgcf-profile.conf"))
        addresses = [value.strip() for value in parser.get("Interface", "Address").split(",")]
        ipv4_address = next((value for value in addresses if ":" not in value), "")
        ipv6_address = next((value for value in addresses if ":" in value), "")
        endpoint = parser.get("Peer", "Endpoint")
        endpoint_host, endpoint_port = endpoint.rsplit(":", 1)
        endpoint_ips = socket.getaddrinfo(endpoint_host.strip("[]"), int(endpoint_port), socket.AF_UNSPEC, socket.SOCK_DGRAM)
        if not endpoint_ips:
            raise RuntimeError("WARP endpoint DNS resolution failed")
        profile = {
            "private_key": parser.get("Interface", "PrivateKey"),
            "ipv4_address": ipv4_address,
            "ipv6_address": ipv6_address,
            "peer_address": endpoint_ips[0][4][0],
            "peer_host": endpoint_host.strip("[]"),
            "peer_port": int(endpoint_port),
            "peer_public_key": parser.get("Peer", "PublicKey"),
            "mtu": int(parser.get("Interface", "MTU", fallback="1280")),
        }
        if not ipv4_address or not ipv6_address:
            raise RuntimeError("WARP registration did not return dual-stack addresses")
        return _validate_warp_profile(profile)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

def _create_warp_profile():
    profile = _generate_warp_profile()
    _write_json_state(WARP_CONF_PATH, profile)
    return profile

_warp_prepare_lock = threading.Lock()
_warp_prepare_thread = None
_warp_prepare_error = ""
_warp_prepare_failed_at = 0

class EgressPreparing(RuntimeError):
    pass

def _prepare_warp_profile_async():
    global _warp_prepare_thread, _warp_prepare_error, _warp_prepare_failed_at
    if _load_warp_profile():
        return True
    with _warp_prepare_lock:
        if _warp_prepare_thread and _warp_prepare_thread.is_alive():
            return False
        if _warp_prepare_error and time.time() - _warp_prepare_failed_at < 300:
            raise RuntimeError(f"WARP profile preparation failed: {_warp_prepare_error}")
        _warp_prepare_error = ""

        def prepare():
            global _warp_prepare_error, _warp_prepare_failed_at
            try:
                _create_warp_profile()
                print("[agent] WARP profile is ready", flush=True)
            except Exception as error:
                _warp_prepare_error = str(error)[:500]
                _warp_prepare_failed_at = time.time()
                print(f"[agent] WARP profile preparation failed: {_warp_prepare_error}", flush=True)
            finally:
                config_wakeup.set()

        _warp_prepare_thread = threading.Thread(target=prepare, name="kui-warp-profile", daemon=True)
        _warp_prepare_thread.start()
        return False

def _require_warp_profile():
    profile = _load_warp_profile()
    if profile:
        return profile
    if not _prepare_warp_profile_async():
        raise EgressPreparing("WARP profile is preparing in the background")
    profile = _load_warp_profile()
    if not profile:
        raise RuntimeError("WARP profile is unavailable")
    return profile

def _refresh_warp_endpoint():
    profile = _load_warp_profile()
    if not profile:
        return False
    host = str(profile.get("peer_host") or "engage.cloudflareclient.com").strip("[]")
    addresses = socket.getaddrinfo(host, int(profile["peer_port"]), socket.AF_UNSPEC, socket.SOCK_DGRAM)
    candidates = list(dict.fromkeys(item[4][0] for item in addresses if item[4]))
    if not candidates:
        return False
    current = profile.get("peer_address")
    try:
        current_family = ipaddress.ip_address(current).version
        candidates.sort(key=lambda address: (ipaddress.ip_address(address).version != current_family, ipaddress.ip_address(address).version != 4))
    except ValueError:
        candidates.sort(key=lambda address: ipaddress.ip_address(address).version != 4)
    profile["peer_address"] = next((address for address in candidates if address != current), candidates[0])
    profile["peer_host"] = host
    _write_json_state(WARP_CONF_PATH, profile)
    print(f"[agent] refreshed WARP endpoint: {host} -> {profile['peer_address']}", flush=True)
    return True

def _normalize_warp_optimizer_policy(value):
    return value if value in {"manual", "on_failure", "first_enable"} else "manual"

def _warp_candidate_endpoints(profile, resolved=None, seed=None, limit=24):
    """Build a small, deterministic and diverse WARP endpoint sample."""
    limit = max(1, min(int(limit or 24), 48))
    current_address = str(profile.get("peer_address") or "")
    current_port = int(profile.get("peer_port") or 2408)
    candidates = []
    seen = set()

    def add(address, port, current=False):
        try:
            address = str(ipaddress.ip_address(str(address).strip("[]")))
            port = int(port)
        except (ValueError, TypeError):
            return
        if not 1 <= port <= 65535 or (address, port) in seen or len(candidates) >= limit:
            return
        seen.add((address, port))
        candidates.append({"address": address, "port": port, "current": bool(current)})

    add(current_address, current_port, True)
    rng = random.Random(seed if seed is not None else int(time.time() // 86400))
    resolved_addresses = list(resolved or [])
    for address in resolved_addresses:
        add(address, current_port, address == current_address)

    prefixes = [
        "162.159.192.0/24", "162.159.193.0/24", "162.159.195.0/24", "162.159.204.0/24",
        "188.114.96.0/24", "188.114.97.0/24", "188.114.98.0/24", "188.114.99.0/24",
    ]
    sampled = []
    for prefix in prefixes:
        network = ipaddress.ip_network(prefix)
        sampled.append(str(network.network_address + rng.randint(1, 254)))
    rng.shuffle(sampled)
    ports = list(dict.fromkeys([current_port, 2408, 500, 1701, 4500]))
    # Cover every sampled address before trying additional ports on the same IP.
    for address in sampled:
        add(address, current_port, address == current_address)
    for port in ports:
        for address in sampled:
            add(address, port, address == current_address and port == current_port)
            if len(candidates) >= limit:
                break
        if len(candidates) >= limit:
            break
    return candidates

def _rank_warp_candidates(results):
    def number(item, key, fallback):
        try: return float(item[key]) if item.get(key) is not None else fallback
        except (TypeError, ValueError): return fallback
    return sorted(results, key=lambda item: (
        not bool(item.get("success")),
        max(0, min(number(item, "loss_pct", 100), 100)),
        number(item, "latency_ms", 999999) if number(item, "latency_ms", 999999) > 0 else 999999,
        str(item.get("address", "")),
        int(item.get("port", 0) or 0),
    ))

def _default_warp_optimizer_state():
    return {"status": "idle", "stage": "", "policy": "manual", "progress": 0, "candidates": [], "recommended": None, "previous": None, "history": [], "error": "", "last_scan_at": 0, "last_scan_started_at": 0, "first_enable_attempted": False, "consecutive_failures": 0, "updated_at": 0}

def _load_warp_optimizer_state():
    state = _default_warp_optimizer_state()
    try:
        with open(WARP_OPT_STATE_PATH, "r", encoding="utf-8") as state_file:
            saved = json.load(state_file)
        if isinstance(saved, dict): state.update(saved)
    except Exception:
        pass
    state["policy"] = _normalize_warp_optimizer_policy(state.get("policy"))
    state["candidates"] = state.get("candidates", [])[:48] if isinstance(state.get("candidates"), list) else []
    state["history"] = state.get("history", [])[:12] if isinstance(state.get("history"), list) else []
    return state

def _save_warp_optimizer_state(state):
    value = dict(state)
    value["policy"] = _normalize_warp_optimizer_policy(value.get("policy"))
    value["candidates"] = value.get("candidates", [])[:48]
    value["history"] = value.get("history", [])[:12]
    value["updated_at"] = int(time.time() * 1000)
    _write_json_state(WARP_OPT_STATE_PATH, value)
    return value

def _public_warp_optimizer_state():
    profile = _load_warp_profile()
    optimizer = _load_warp_optimizer_state()
    mode = _load_egress_state().get("applied_mode", "native") if "_load_egress_state" in globals() else "native"
    return {
        "configured": bool(profile),
        "active_mode": mode,
        "peer_address": str(profile.get("peer_address", "")) if profile else "",
        "peer_port": int(profile.get("peer_port", 0)) if profile else 0,
        "peer_family": f"IPv{ipaddress.ip_address(profile['peer_address']).version}" if profile else "",
        "tunnel_ipv4": str(profile.get("ipv4_address", "")) if profile else "",
        "tunnel_ipv6": str(profile.get("ipv6_address", "")) if profile else "",
        "optimizer": optimizer,
    }

def _free_loopback_port():
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])
    finally:
        listener.close()

def _warp_benchmark_config(profile, address, port, listen_port, mode="ipv4"):
    mode = mode if mode in {"ipv4", "ipv6", "dual"} else "ipv4"
    addresses, allowed_ips = [], []
    if mode in {"ipv4", "dual"}:
        addresses.append(profile["ipv4_address"]); allowed_ips.append("0.0.0.0/0")
    if mode in {"ipv6", "dual"}:
        addresses.append(profile["ipv6_address"]); allowed_ips.append("::/0")
    return {
        "log": {"level": "error"},
        "inbounds": [{"type": "socks", "tag": "warp-bench-in", "listen": "127.0.0.1", "listen_port": listen_port}],
        "endpoints": [{
            "type": "wireguard", "tag": "warp-bench-out", "system": False,
            "mtu": min(max(int(profile.get("mtu", 1280)), 1280), 1420),
            "address": addresses, "private_key": profile["private_key"],
            "peers": [{"address": address, "port": int(port), "public_key": profile["peer_public_key"], "allowed_ips": allowed_ips, "persistent_keepalive_interval": 25}],
        }],
        "route": {"rules": [{"inbound": ["warp-bench-in"], "action": "route", "outbound": "warp-bench-out"}]},
    }

def _test_warp_candidate(profile, candidate, attempts=1, mode="ipv4", timeout=4, refined=False, cancel_event=None):
    address, port = str(candidate["address"]), int(candidate["port"])
    result = {"address": address, "port": port, "family": f"IPv{ipaddress.ip_address(address).version}", "current": bool(candidate.get("current")), "refined": bool(refined), "success": False, "latency_ms": 0, "loss_pct": 100, "colo": "", "exit_ipv4": "", "exit_ipv6": "", "error": ""}
    sing_box = shutil.which("sing-box")
    if not sing_box:
        result["error"] = "sing-box binary not found"
        return result
    listen_port = _free_loopback_port()
    descriptor, config_path = tempfile.mkstemp(prefix="warp-bench-", suffix=".json", dir="/opt/kui")
    process = None
    latencies, completed = [], 0
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as config_file:
            json.dump(_warp_benchmark_config(profile, address, port, listen_port, mode), config_file)
        os.chmod(config_path, 0o600)
        checked = subprocess.run([sing_box, "check", "-c", config_path], capture_output=True, text=True, timeout=20)
        if checked.returncode != 0:
            raise RuntimeError(f"sing-box rejected candidate: {checked.stderr.strip()[-200:]}")
        process = subprocess.Popen([sing_box, "run", "-c", config_path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ready = False
        for _ in range(20):
            if process.poll() is not None: break
            try:
                with socket.create_connection(("127.0.0.1", listen_port), timeout=0.1): ready = True; break
            except OSError: time.sleep(0.1)
        if not ready: raise RuntimeError("candidate SOCKS listener did not start")
        checks = []
        if mode in {"ipv4", "dual"}: checks.append(("ipv4", "https://1.1.1.1/cdn-cgi/trace", ["-4", "-k"]))
        if mode in {"ipv6", "dual"}: checks.append(("ipv6", "https://[2606:4700:4700::1111]/cdn-cgi/trace", ["-k"]))
        total = max(1, int(attempts)) * len(checks)
        for family, url, extra in checks:
            for _ in range(max(1, int(attempts))):
                if cancel_event and cancel_event.is_set():
                    result["error"] = "WARP endpoint scan cancelled"
                    return result
                response = subprocess.run(["curl", "-fsSL", "--connect-timeout", str(timeout), "--max-time", str(timeout + 2), "--write-out", "\n__KUI_TIME_TOTAL__=%{time_total}", "--proxy", f"socks5h://127.0.0.1:{listen_port}", *extra, url], capture_output=True, text=True)
                trace_output, marker, timing = response.stdout.rpartition("__KUI_TIME_TOTAL__=")
                if response.returncode != 0 or not marker or "warp=on" not in trace_output.lower(): continue
                try: elapsed = float(timing.strip().splitlines()[0]) * 1000
                except (ValueError, IndexError): continue
                trace = dict(line.split("=", 1) for line in trace_output.splitlines() if "=" in line)
                completed += 1; latencies.append(elapsed)
                result[f"exit_{family}"] = trace.get("ip", "")
                if trace.get("colo"): result["colo"] = trace["colo"]
        result["loss_pct"] = round((total - completed) * 100 / total)
        result["success"] = completed == total
        if latencies:
            ordered = sorted(latencies); result["latency_ms"] = round(ordered[len(ordered) // 2], 1)
        if not result["success"]: result["error"] = "WARP data-plane verification failed"
    except Exception as error:
        result["error"] = str(error)[:240]
    finally:
        if process:
            stop_process(process)
        try: os.remove(config_path)
        except OSError: pass
    return result

_warp_optimizer_lock = threading.Lock()
_warp_optimizer_start_lock = threading.Lock()
_warp_optimizer_thread = None
_warp_optimizer_cancel = threading.Event()

def _emit_warp_optimizer_state(state=None, request_id="", egress_ip=""):
    public = _public_warp_optimizer_state()
    egress_state = _load_egress_state() if "_load_egress_state" in globals() else {"applied_mode": "native", "applied_revision": 0}
    try: heartbeat_wakeup.set()
    except Exception: pass
    if realtime_channel and realtime_channel.connected:
        realtime_channel.send({"request_id": request_id, "egress_ip": egress_ip, "applied_mode": egress_state.get("applied_mode", "native"), "applied_revision": int(egress_state.get("applied_revision", 0)), **public}, "warp.optimize.result")
    return public

def _load_or_create_warp_benchmark_profile():
    profile = _load_warp_profile_path(WARP_BENCH_CONF_PATH)
    if profile: return profile
    profile = _generate_warp_profile(registration_attempts=3)
    _write_json_state(WARP_BENCH_CONF_PATH, profile)
    return profile

def _restart_singbox():
    if os.path.exists("/etc/alpine-release"):
        restarted = subprocess.run(["rc-service", "sing-box", "restart"], capture_output=True, text=True, timeout=30)
    else:
        restarted = subprocess.run(["systemctl", "restart", "sing-box"], capture_output=True, text=True, timeout=30)
    return restarted.returncode == 0 and _singbox_service_healthy()

def _apply_warp_endpoint(address, port, request_id="", allow_previous=False, reason="manual"):
    address = str(ipaddress.ip_address(str(address).strip("[]"))); port = int(port)
    if not 1 <= port <= 65535: raise ValueError("invalid WARP Endpoint port")
    state = _load_warp_optimizer_state()
    allowed = any(item.get("success") and item.get("refined") and item.get("address") == address and int(item.get("port", 0)) == port for item in state.get("candidates", []))
    previous = state.get("previous") or {}
    if allow_previous and previous.get("address") == address and int(previous.get("port", 0)) == port: allowed = True
    if not allowed: raise ValueError("WARP Endpoint is not a verified candidate")
    if not _warp_optimizer_lock.acquire(blocking=False): raise RuntimeError("WARP optimizer is busy")
    profile = _require_warp_profile()
    old_profile = dict(profile)
    old_config = ""
    temp_path = ""
    try:
        state.update({"status": "applying", "stage": "正在验证并切换", "progress": 95, "error": ""}); _save_warp_optimizer_state(state); _emit_warp_optimizer_state(request_id=request_id)
        profile["peer_address"] = address; profile["peer_port"] = port
        applied_mode = _load_egress_state().get("applied_mode", "native")
        verified_egress_ip = ""
        if applied_mode.startswith("warp_"):
            with open(SINGBOX_CONF_PATH, "r", encoding="utf-8") as config_file: config = json.load(config_file)
            old_config = json.dumps(config, indent=2)
            endpoint = next((item for item in config.get("endpoints", []) if item.get("tag") == "warp-out"), None)
            if not endpoint or not endpoint.get("peers"): raise RuntimeError("active WARP endpoint is missing from sing-box config")
            endpoint["peers"][0]["address"] = address; endpoint["peers"][0]["port"] = port
            candidate_config = json.dumps(config, indent=2)
            temp_path = SINGBOX_CONF_PATH + ".warp-optimize"
            with open(temp_path, "w", encoding="utf-8") as config_file: config_file.write(candidate_config)
            os.chmod(temp_path, 0o600)
            checked = subprocess.run([shutil.which("sing-box") or "/usr/bin/sing-box", "check", "-c", temp_path], capture_output=True, text=True, timeout=30)
            if checked.returncode != 0: raise RuntimeError(f"sing-box rejected optimized Endpoint: {checked.stderr.strip()[-300:]}")
            _write_json_state(WARP_CONF_PATH, profile)
            os.replace(temp_path, SINGBOX_CONF_PATH)
            if not _restart_singbox(): raise RuntimeError("sing-box failed to restart with optimized Endpoint")
            verified_egress_ip = _verify_warp_exit(applied_mode[5:], _current_egress_check_host())
        else:
            verified = _test_warp_candidate(profile, {"address": address, "port": port}, attempts=1, mode="dual", timeout=6)
            if not verified.get("success"): raise RuntimeError(verified.get("error") or "optimized WARP Endpoint verification failed")
            _write_json_state(WARP_CONF_PATH, profile)
        now = int(time.time() * 1000)
        history = [{"at": now, "from_address": old_profile["peer_address"], "from_port": int(old_profile["peer_port"]), "to_address": address, "to_port": port, "reason": "restore" if allow_previous else str(reason or "manual")[:32], "success": True}] + state.get("history", [])
        candidates = [dict(item, current=item.get("address") == address and int(item.get("port", 0)) == port) for item in state.get("candidates", [])]
        state.update({"status": "success", "stage": "端点已应用", "progress": 100, "previous": {"address": old_profile["peer_address"], "port": int(old_profile["peer_port"])}, "recommended": None, "candidates": candidates, "history": history[:12], "consecutive_failures": 0, "error": ""})
        _save_warp_optimizer_state(state); _emit_warp_optimizer_state(request_id=request_id, egress_ip=verified_egress_ip)
        return state
    except Exception as error:
        _write_json_state(WARP_CONF_PATH, old_profile)
        if old_config:
            restore_path = SINGBOX_CONF_PATH + ".warp-rollback"
            with open(restore_path, "w", encoding="utf-8") as config_file: config_file.write(old_config)
            os.chmod(restore_path, 0o600); os.replace(restore_path, SINGBOX_CONF_PATH); _restart_singbox()
        state.update({"status": "failed", "stage": "应用失败，已回滚", "progress": 100, "error": str(error)[:500]})
        _save_warp_optimizer_state(state); _emit_warp_optimizer_state(request_id=request_id)
        raise
    finally:
        if temp_path and os.path.exists(temp_path):
            try: os.remove(temp_path)
            except OSError: pass
        _warp_optimizer_lock.release()

def _run_warp_endpoint_scan(request_id="", auto_apply=False):
    if not _warp_optimizer_lock.acquire(blocking=False):
        raise RuntimeError("WARP optimizer is busy")
    try:
        _warp_optimizer_cancel.clear()
        state = _load_warp_optimizer_state()
        state.update({"status": "scanning", "stage": "准备独立测速身份", "progress": 2, "candidates": [], "recommended": None, "error": ""})
        _save_warp_optimizer_state(state); _emit_warp_optimizer_state(request_id=request_id)
        real_profile = _require_warp_profile()
        benchmark_profile = _load_or_create_warp_benchmark_profile()
        resolved = []
        try:
            resolved = [item[4][0] for item in socket.getaddrinfo(real_profile.get("peer_host") or "engage.cloudflareclient.com", int(real_profile["peer_port"]), socket.AF_UNSPEC, socket.SOCK_DGRAM) if item[4]]
        except OSError: pass
        candidates = _warp_candidate_endpoints(real_profile, list(dict.fromkeys(resolved)), limit=24)
        results = []
        for index, candidate in enumerate(candidates):
            if _warp_optimizer_cancel.is_set():
                state.update({"status": "idle", "stage": "检测已取消", "progress": 0, "candidates": results, "recommended": None}); _save_warp_optimizer_state(state); _emit_warp_optimizer_state(request_id=request_id); return
            result = _test_warp_candidate(benchmark_profile, candidate, attempts=1, mode="ipv4", cancel_event=_warp_optimizer_cancel)
            results.append(result)
            state.update({"stage": f"检测候选 {index + 1}/{len(candidates)}", "progress": 5 + round((index + 1) * 65 / max(1, len(candidates))), "candidates": _rank_warp_candidates(results)})
            _save_warp_optimizer_state(state)
            try: heartbeat_wakeup.set()
            except Exception: pass
        successful = _rank_warp_candidates([item for item in results if item.get("success")])[:5]
        if not successful: raise RuntimeError("没有候选 Endpoint 通过 WARP 数据面验证")
        applied_mode = _load_egress_state().get("applied_mode", "warp_dual")
        verify_mode = applied_mode[5:] if applied_mode.startswith("warp_") else "dual"
        refined = []
        for index, candidate in enumerate(successful):
            if _warp_optimizer_cancel.is_set(): break
            refined.append(_test_warp_candidate(benchmark_profile, candidate, attempts=3, mode=verify_mode, timeout=5, refined=True, cancel_event=_warp_optimizer_cancel))
            state.update({"stage": f"复测最优候选 {index + 1}/{len(successful)}", "progress": 75 + round((index + 1) * 20 / len(successful))}); _save_warp_optimizer_state(state)
        if _warp_optimizer_cancel.is_set():
            state.update({"status": "idle", "stage": "检测已取消", "progress": 0, "recommended": None}); _save_warp_optimizer_state(state); _emit_warp_optimizer_state(request_id=request_id); return
        refined_by_key = {(item["address"], item["port"]): item for item in refined}
        final_results = [refined_by_key.get((item["address"], item["port"]), item) for item in results]
        ranked = _rank_warp_candidates(final_results)
        recommended = next((item for item in ranked if item.get("success") and item.get("refined")), None)
        if not recommended: raise RuntimeError("复测后没有可用的 WARP Endpoint")
        state.update({"status": "ready", "stage": "检测完成，等待应用", "progress": 100, "candidates": ranked, "recommended": recommended, "last_scan_at": int(time.time() * 1000), "error": ""})
        _save_warp_optimizer_state(state); _emit_warp_optimizer_state(request_id=request_id)
    except Exception as error:
        state = _load_warp_optimizer_state(); state.update({"status": "failed", "stage": "检测失败", "progress": 100, "error": str(error)[:500]}); _save_warp_optimizer_state(state); _emit_warp_optimizer_state(request_id=request_id)
        return
    finally:
        _warp_optimizer_lock.release()
    if auto_apply and recommended:
        try: _apply_warp_endpoint(recommended["address"], recommended["port"], request_id, False, "failure")
        except Exception: pass

def _start_warp_endpoint_scan(request_id="", auto_apply=False):
    global _warp_optimizer_thread
    with _warp_optimizer_start_lock:
        if _warp_optimizer_thread and _warp_optimizer_thread.is_alive(): return False
        if _warp_optimizer_lock.locked(): return False
        state = _load_warp_optimizer_state()
        now = int(time.time() * 1000)
        cooldown = WARP_AUTO_SCAN_COOLDOWN_MS if auto_apply else WARP_MANUAL_SCAN_COOLDOWN_MS
        if now - int(state.get("last_scan_started_at", 0) or 0) < cooldown: return False
        state["last_scan_started_at"] = now
        _save_warp_optimizer_state(state)
        _warp_optimizer_thread = threading.Thread(target=_run_warp_endpoint_scan, args=(request_id, auto_apply), name="kui-warp-optimizer", daemon=True)
        _warp_optimizer_thread.start()
        return True

def _load_egress_state():
    try:
        with open(EGRESS_STATE_PATH, "r", encoding="utf-8") as state_file:
            state = json.load(state_file)
        mode = state.get("applied_mode", "native")
        if mode in {"off", "ipv4", "ipv6", "dual"}: mode = "native" if mode == "off" else f"warp_{mode}"
        applied_config = state.get("applied_config") if isinstance(state.get("applied_config"), dict) else {"mode": mode, "proxy_mode": "global", "proxy_categories": ""}
        applied_config["mode"] = mode
        return {"applied_mode": mode, "applied_revision": int(state.get("applied_revision", 0)), "applied_config": applied_config, "pending_result": state.get("pending_result"), "deployment_id": str(state.get("deployment_id", ""))}
    except Exception:
        return {"applied_mode": "native", "applied_revision": 0, "applied_config": {"mode": "native", "proxy_mode": "global", "proxy_categories": ""}, "pending_result": None, "deployment_id": ""}

def _save_egress_state(mode, revision, pending_result=None, deployment_id="", applied_config=None):
    config = dict(applied_config) if isinstance(applied_config, dict) else {"mode": mode, "proxy_mode": "global", "proxy_categories": ""}
    config["mode"] = mode
    _write_json_state(EGRESS_STATE_PATH, {"applied_mode": mode, "applied_revision": int(revision), "applied_config": config, "pending_result": pending_result, "deployment_id": str(deployment_id or "")})

def _singbox_service_healthy():
    if os.path.exists("/etc/alpine-release"):
        return subprocess.run(["rc-service", "sing-box", "status"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15).returncode == 0
    return subprocess.run(["systemctl", "is-active", "--quiet", "sing-box"], timeout=15).returncode == 0

def _restore_singbox_config(config_text):
    if not config_text:
        return False
    try:
        restore_path = SINGBOX_CONF_PATH + ".restore"
        with open(restore_path, "w", encoding="utf-8") as restore_file:
            restore_file.write(config_text)
            restore_file.flush()
            os.fsync(restore_file.fileno())
        os.chmod(restore_path, 0o600)
        os.replace(restore_path, SINGBOX_CONF_PATH)
        if os.path.exists("/etc/alpine-release"):
            restarted = subprocess.run(["rc-service", "sing-box", "restart"], capture_output=True, text=True, timeout=30)
        else:
            restarted = subprocess.run(["systemctl", "restart", "sing-box"], capture_output=True, text=True, timeout=30)
        return restarted.returncode == 0 and _singbox_service_healthy()
    except Exception as error:
        print(f"[agent] failed to restore previous sing-box config: {error}", flush=True)
        return False

def _restore_last_good_singbox():
    backup_path = SINGBOX_CONF_PATH + ".last-good"
    if not os.path.exists(backup_path):
        return False
    try:
        with open(backup_path, "r", encoding="utf-8") as backup_file:
            previous_config = backup_file.read()
        return _restore_singbox_config(previous_config)
    except Exception as error:
        print(f"[agent] failed to restore last-good sing-box config: {error}", flush=True)
        return False

_warp_exit_ip = ""

def normalize_check_host(value):
    """Keep the local egress-check listener on loopback unless given IPv4."""
    try:
        parsed = ipaddress.ip_address(str(value or "").strip())
        if parsed.version == 4 and not parsed.is_unspecified:
            return str(parsed)
    except ValueError:
        pass
    return "127.0.0.1"

def _select_warp_exit_ip(mode, exits):
    """Return the address family that normal traffic prefers for this mode."""
    if mode == "ipv6":
        return str(exits.get("ipv6") or "")
    if mode in {"ipv4", "dual"}:
        return str(exits.get("ipv4") or "")
    return ""

def _verify_warp_exit(mode, check_host="127.0.0.1"):
    global _warp_exit_ip
    _warp_exit_ip = ""
    if mode == "off": return ""
    check_host = normalize_check_host(check_host)
    checks = []
    if mode in {"ipv4", "dual"}:
        checks.append(("IPv4", "https://1.1.1.1/cdn-cgi/trace", ["-4", "-k"]))
    if mode in {"ipv6", "dual"}:
        # The local check inbound only listens on IPv4. Do not pass curl -6:
        # it would try to reach 127.0.0.1 through IPv6 before SOCKS can route
        # the literal IPv6 destination through WARP.
        checks.append(("IPv6", "https://[2606:4700:4700::1111]/cdn-cgi/trace", ["-k"]))
    verified_ips = {}
    for family, url, extra_args in checks:
        verified = False
        for _ in range(4):
            result = subprocess.run(["curl", "-fsSL", "--connect-timeout", "5", "--max-time", "20", "--noproxy", "", "--proxy", f"socks5h://{check_host}:39482", *extra_args, url], capture_output=True, text=True)
            if result.returncode == 0 and "warp=on" in result.stdout.lower():
                trace = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
                ip = _verified_public_ip(trace.get("ip", ""))
                if ip: verified_ips[family.lower()] = ip
                verified = True; break
            time.sleep(2)
        if not verified: raise RuntimeError(f"WARP {family} data-plane verification failed")
    _warp_exit_ip = _select_warp_exit_ip(mode, verified_ips)
    if not _warp_exit_ip: raise RuntimeError(f"WARP {mode} verification returned no preferred-family exit IP")
    return _warp_exit_ip

def _verified_public_ip(value):
    try:
        parsed = ipaddress.ip_address(value.strip())
        return str(parsed) if parsed.is_global else ""
    except ValueError:
        return ""

def _verify_socks5_exit(check_host="127.0.0.1", require_distinct_exit=False):
    check_host = normalize_check_host(check_host)
    for _ in range(4):
        result = subprocess.run(["curl", "-4", "-fsSL", "--connect-timeout", "5", "--max-time", "20", "--noproxy", "", "--proxy", f"socks5h://{check_host}:39482", "https://api.ipify.org"], capture_output=True, text=True)
        ip = _verified_public_ip(result.stdout)
        if result.returncode == 0 and ip and (not require_distinct_exit or ip != VPS_IP):
            return ip
        time.sleep(2)
    reason = " (VPS native IP detected)" if require_distinct_exit and ip == VPS_IP else ""
    raise RuntimeError(f"SOCKS5 data-plane verification failed{reason}")

def _verify_native_exit():
    try:
        echo_url = f"{BASE_URL}/api/agent_egress_ip?ip={urllib.parse.quote(VPS_IP, safe='')}"
        request = urllib.request.Request(echo_url, headers=HEADERS)
        with _urlopen(request, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
        ip = _verified_public_ip(str(payload.get("ip") or ""))
        if ip:
            return ip
    except Exception as error:
        print(f"[agent] Worker native egress probe failed, trying fallback: {error}", flush=True)
    result = subprocess.run(["curl", "-4", "-fsSL", "--connect-timeout", "5", "--max-time", "20", "--noproxy", "*", "https://api.ipify.org"], capture_output=True, text=True)
    ip = _verified_public_ip(result.stdout)
    if result.returncode != 0 or not ip:
        raise RuntimeError("native data-plane verification failed")
    return ip

def _current_egress_check_host():
    try:
        with open(SINGBOX_CONF_PATH, "r", encoding="utf-8") as config_file:
            config = json.load(config_file)
        inbound = next((item for item in config.get("inbounds", []) if item.get("tag") == "egress-check-in"), None)
        return normalize_check_host(inbound.get("listen")) if inbound else "127.0.0.1"
    except Exception:
        return "127.0.0.1"

def _verify_current_egress_exit(expected_mode="", expected_revision=None):
    state = _load_egress_state()
    mode = state.get("applied_mode", "native")
    revision = int(state.get("applied_revision", 0))
    if expected_mode and mode != expected_mode:
        raise RuntimeError(f"出口配置已变化：期望 {expected_mode}，当前 {mode}")
    if expected_revision is not None and int(expected_revision) != revision:
        raise RuntimeError(f"出口配置版本已变化：期望 {int(expected_revision)}，当前 {revision}")
    check_host = _current_egress_check_host()
    if mode == "native": return mode, revision, _verify_native_exit()
    if mode.startswith("warp_"): return mode, revision, _verify_warp_exit(mode[5:], check_host)
    if mode in {"residential", "socks5"}: return mode, revision, _verify_socks5_exit(check_host)
    raise RuntimeError(f"unsupported applied egress mode: {mode}")

def _post_warp_result(payload):
    parsed = urllib.parse.urlsplit(API_URL)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    return _controller_json_request(f"{origin}/api/egress_result", data=json.dumps({"ip": VPS_IP, **payload}).encode(), headers={**HEADERS, "Content-Type": "application/json"}, method="POST")

def _deliver_egress_result(payload):
    if realtime_channel and realtime_channel.connected and realtime_channel.send(payload, "config.result"):
        return {"accepted": False, "transport": "realtime"}
    return _post_warp_result(payload)

EGRESS_MODES = {"native", "residential", "socks5", "warp_ipv4", "warp_ipv6", "warp_dual"}
PROXY_CATEGORIES = {"youtube", "ai", "google", "streaming", "custom"}
SELECTIVE_PROXY_RULE_SETS = {
    "youtube": (
        {
            "tag": "kui-youtube",
            "format": "binary",
            "url": "https://raw.githubusercontent.com/senshinya/singbox_ruleset/41de0cb37f35b83a2b934774c6501c5451f242c4/rule/YouTube/YouTube.srs",
            "use": "both",
        },
    ),
    "ai": (
        {
            "tag": "kui-ai-domain",
            "format": "source",
            "url": "https://raw.githubusercontent.com/SukkaLab/ruleset.skk.moe/e667f45fdf3fa308a3e0e9dcb5528428712efb52/sing-box/non_ip/ai.json",
            "use": "both",
        },
        {
            "tag": "kui-ai-ip",
            "format": "source",
            "url": "https://raw.githubusercontent.com/SukkaLab/ruleset.skk.moe/e667f45fdf3fa308a3e0e9dcb5528428712efb52/sing-box/ip/ai.json",
            "use": "route",
        },
    ),
    "google": (
        {
            "tag": "kui-google",
            "format": "binary",
            "url": "https://raw.githubusercontent.com/senshinya/singbox_ruleset/41de0cb37f35b83a2b934774c6501c5451f242c4/rule/Google/Google.srs",
            "use": "both",
        },
    ),
    "streaming": (
        {
            "tag": "kui-stream-domain",
            "format": "source",
            "url": "https://raw.githubusercontent.com/SukkaLab/ruleset.skk.moe/e667f45fdf3fa308a3e0e9dcb5528428712efb52/sing-box/non_ip/stream.json",
            "use": "both",
        },
        {
            "tag": "kui-stream-ip",
            "format": "source",
            "url": "https://raw.githubusercontent.com/SukkaLab/ruleset.skk.moe/e667f45fdf3fa308a3e0e9dcb5528428712efb52/sing-box/ip/stream.json",
            "use": "route",
        },
    ),
}

# Specific services take precedence over broad collections. When a broad
# category is selected without one of these specific categories, the specific
# rule set is loaded as an explicit direct-route exclusion.
SELECTIVE_PROXY_EXCLUSIONS = {
    "google": ("youtube", "ai"),
    "streaming": ("youtube",),
}

def normalize_proxy_custom_domains(value):
    source = value if isinstance(value, list) else []
    domains = []
    if len(source) > 200:
        raise ValueError("too many custom proxy domains")
    for raw_value in source:
        domain = str(raw_value or "").strip().lower().rstrip(".")
        if domain.startswith("*."):
            domain = domain[2:]
        try:
            domain = domain.encode("idna").decode("ascii")
        except UnicodeError:
            raise ValueError("invalid custom proxy domain")
        labels = domain.split(".")
        if len(domain) > 253 or len(labels) < 2 or domain.endswith(".local") or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", label or "") or len(label) > 63 for label in labels):
            raise ValueError("invalid custom proxy domain")
        try:
            ipaddress.ip_address(domain)
        except ValueError:
            pass
        else:
            raise ValueError("IP addresses are not custom proxy domains")
        if domain not in domains:
            domains.append(domain)
    return sorted(domains)

def build_selective_proxy_rules(categories, proxy_inbounds, outbound_tag, custom_domains=None):
    selected = {category for category in categories or [] if category in SELECTIVE_PROXY_RULE_SETS}
    custom_selected = "custom" in set(categories or [])
    normalized_custom_domains = normalize_proxy_custom_domains(custom_domains or []) if custom_selected else []
    if custom_selected and not normalized_custom_domains:
        raise RuntimeError("custom proxy category requires at least one domain")
    if not selected and not custom_selected:
        raise RuntimeError("selective SOCKS5 mode requires at least one valid category")
    excluded = {
        specific
        for broad in selected
        for specific in SELECTIVE_PROXY_EXCLUSIONS.get(broad, ())
        if specific not in selected
    }
    rule_sets = []
    route_tags = []
    dns_tags = []
    direct_route_tags = []
    direct_dns_tags = []
    for category, definitions in SELECTIVE_PROXY_RULE_SETS.items():
        if category not in selected and category not in excluded:
            continue
        for definition in definitions:
            rule_sets.append({
                "type": "remote",
                "tag": definition["tag"],
                "format": definition["format"],
                "url": definition["url"],
                "download_detour": "direct-out",
                "update_interval": "1d",
            })
            use = definition.get("use", "both")
            if category in selected:
                if use in {"route", "both"}:
                    route_tags.append(definition["tag"])
                if use in {"dns", "both"}:
                    dns_tags.append(definition["tag"])
            else:
                if use in {"route", "both"}:
                    direct_route_tags.append(definition["tag"])
                if use in {"dns", "both"}:
                    direct_dns_tags.append(definition["tag"])

    inbounds = sorted(set(proxy_inbounds or []))
    if not inbounds:
        return rule_sets, [], dns_tags, direct_dns_tags
    rules = []
    if normalized_custom_domains:
        rules.append({
            "inbound": inbounds,
            "domain_suffix": normalized_custom_domains,
            "action": "route",
            "outbound": outbound_tag,
        })
    if direct_route_tags:
        rules.append({
            "inbound": inbounds,
            "rule_set": direct_route_tags,
            "action": "route",
            "outbound": "direct-out",
        })
    if route_tags:
        rules.append({
            "inbound": inbounds,
            "rule_set": route_tags,
            "action": "route",
            "outbound": outbound_tag,
        })
    rules.append({"inbound": inbounds, "ip_version": 6, "action": "reject"})
    return rule_sets, rules, dns_tags, direct_dns_tags


def build_global_proxy_rule(nodes, outbound_tag, check_inbound="egress-check-in"):
    inbounds = {
        f"in-{node['id']}"
        for node in nodes or []
        if node.get("protocol") not in {"dokodemo-door", "MTProxy"}
    }
    if check_inbound:
        inbounds.add(check_inbound)
    return {
        "inbound": sorted(inbounds),
        "action": "route",
        "outbound": outbound_tag,
    }


def apply_global_proxy_route(route, nodes, outbound_tag, check_inbound="egress-check-in"):
    route["rules"].append(build_global_proxy_rule(nodes, outbound_tag, check_inbound))
    # Some multiplexed/UDP flows may not retain their original inbound match.
    # Global mode must never fall back to the first (direct) outbound.
    route["final"] = outbound_tag


def build_egress_dns_policy(proxy_inbounds, mode, outbound_tag="", dns_rule_tags=None, dns_direct_rule_tags=None, custom_domains=None, strategy="prefer_ipv4", detoured_dns=None, sniff_inbounds=None):
    inbounds = sorted(set(proxy_inbounds or []))
    inbound_set = set(inbounds)
    sniff_targets = inbounds if sniff_inbounds is None else [
        inbound for inbound in sorted(set(sniff_inbounds or [])) if inbound in inbound_set
    ]
    local_dns = {"type": "local", "tag": "local-dns"}
    servers = [local_dns]
    dns_rules = []
    prefix_rules = []
    fallback_rules = []

    if mode == "native":
        dns_tag = "local-dns"
        final_tag = dns_tag
    elif mode in {"proxy-global", "proxy-selective", "warp"}:
        if not outbound_tag:
            raise RuntimeError(f"{mode} DNS requires an outbound")
        dns_tag = "warp-dns" if mode == "warp" else "proxy-dns"
        final_tag = "local-dns" if mode == "proxy-selective" else dns_tag
        dns_address = "2606:4700:4700::1111" if strategy == "ipv6_only" else "1.1.1.1"
        servers.append({
            "type": "https",
            "tag": dns_tag,
            "server": dns_address,
            "server_port": 443,
            "path": "/dns-query",
            "tls": {"enabled": True, "server_name": "cloudflare-dns.com"},
            "detour": outbound_tag,
        })
        if mode == "proxy-selective":
            selected_dns_tags = list(dict.fromkeys(dns_rule_tags or []))
            normalized_custom_domains = normalize_proxy_custom_domains(custom_domains or [])
            if not selected_dns_tags and not normalized_custom_domains:
                raise RuntimeError("selective proxy DNS requires domain rule sets")
            if normalized_custom_domains:
                dns_rules.append({
                    "domain_suffix": normalized_custom_domains,
                    "action": "route",
                    "server": dns_tag,
                    "strategy": strategy,
                })
            direct_dns_tags = list(dict.fromkeys(dns_direct_rule_tags or []))
            if direct_dns_tags:
                dns_rules.append({
                    "rule_set": direct_dns_tags,
                    "action": "route",
                    "server": "local-dns",
                    "strategy": strategy,
                })
            if selected_dns_tags:
                dns_rules.append({
                    "rule_set": selected_dns_tags,
                    "action": "route",
                    "server": dns_tag,
                    "strategy": strategy,
                })
    else:
        raise RuntimeError(f"unsupported DNS policy mode: {mode}")

    for index, (inbound, detour) in enumerate(sorted(set(detoured_dns or []))):
        if not inbound or not detour:
            continue
        landing_dns_tag = f"landing-dns-{index}"
        servers.append({
            "type": "https",
            "tag": landing_dns_tag,
            "server": "1.1.1.1",
            "server_port": 443,
            "path": "/dns-query",
            "tls": {"enabled": True, "server_name": "cloudflare-dns.com"},
            "detour": detour,
        })
        dns_rules.append({
            "inbound": [inbound],
            "action": "route",
            "server": landing_dns_tag,
            "strategy": strategy,
        })

    if sniff_targets:
        prefix_rules.append({"inbound": sniff_targets, "action": "sniff", "timeout": "1s"})
    if inbounds:
        prefix_rules.append({"inbound": inbounds, "protocol": "dns", "action": "hijack-dns"})
        # SOCKS5 receives the original domain and resolves it on the landing
        # server. WARP is an IP tunnel, so its destinations are resolved here
        # with DNS traffic forced through the WARP endpoint.
        if mode == "warp":
            prefix_rules.append({"inbound": inbounds, "action": "resolve", "server": dns_tag, "strategy": strategy})

    return {
        "servers": servers,
        "rules": dns_rules,
        "final": final_tag,
        "strategy": strategy,
        "independent_cache": True,
        "cache_capacity": 4096,
        "reverse_mapping": True,
    }, prefix_rules, fallback_rules

def _normalize_egress_config(value, fallback_mode="native", fallback=None):
    source = value if isinstance(value, dict) else (fallback if isinstance(fallback, dict) else {})
    mode = str(source.get("mode") or fallback_mode)
    if mode not in EGRESS_MODES:
        mode = fallback_mode if fallback_mode in EGRESS_MODES else "native"
    proxy_mode = "selective" if source.get("proxy_mode") == "selective" and mode in {"residential", "socks5"} else "global"
    raw_categories = source.get("proxy_categories", "")
    if isinstance(raw_categories, str):
        categories = [item.strip().lower() for item in raw_categories.split(",") if item.strip().lower() in PROXY_CATEGORIES]
    elif isinstance(raw_categories, list):
        categories = [str(item).strip().lower() for item in raw_categories if str(item).strip().lower() in PROXY_CATEGORIES]
    else:
        categories = []
    custom_domains = normalize_proxy_custom_domains(source.get("proxy_custom_domains") or [])
    config = {"mode": mode, "proxy_mode": proxy_mode, "proxy_categories": ",".join(dict.fromkeys(categories)), "proxy_custom_domains": custom_domains}
    if mode == "socks5":
        socks = source.get("socks5") if isinstance(source.get("socks5"), dict) else {}
        config["socks5"] = {"addr": str(socks.get("addr") or ""), "port": int(socks.get("port") or 0), "user": str(socks.get("user") or ""), "pass": str(socks.get("pass") or "")}
    return config

def _runtime_egress_args(config, residential, egress_check_host):
    mode = config["mode"]
    proxy_mode = config.get("proxy_mode", "global")
    categories = [item for item in config.get("proxy_categories", "").split(",") if item]
    custom_domains = normalize_proxy_custom_domains(config.get("proxy_custom_domains") or [])
    proxy_domains = json.dumps({"categories": categories, "custom_domains": custom_domains}) if proxy_mode == "selective" and categories else ""
    if mode == "residential":
        residential_addr = normalize_check_host(residential.get("addr", "127.0.0.1"))
        if residential_addr == "127.0.0.1" and egress_check_host != "127.0.0.1":
            residential_addr = egress_check_host
        socks = {"enabled": True, "source": "residential", "addr": residential_addr, "check_addr": egress_check_host, "port": residential.get("port", 7920), "user": residential.get("user", ""), "pass": residential.get("pass", ""), "mode": proxy_mode, "domains": proxy_domains}
    elif mode == "socks5":
        manual = config.get("socks5") or {}
        socks = {"enabled": True, "source": "manual", "addr": manual.get("addr", ""), "port": int(manual.get("port", 0)), "user": manual.get("user", ""), "pass": manual.get("pass", ""), "mode": proxy_mode, "domains": proxy_domains}
    else:
        socks = {}
    warp = mode[5:] if mode.startswith("warp_") else "off"
    return socks, warp

def check_for_update():
    global last_update_check
    if os.environ.get("KUI_DISABLE_AUTO_UPDATE") == "1":
        return False
    now = time.time()
    if now - last_update_check < 3600:
        return False
    last_update_check = now
    targets = (("realtime-client", os.path.join(os.path.dirname(os.path.abspath(__file__)), "realtime_client.py")), ("agent", os.path.abspath(__file__)))
    temporary_files = []
    changed = []
    try:
        for component, target in targets:
            temp_path = target + ".update.py"
            temporary_files.append(temp_path)
            update_url = f"{BASE_URL}/api/agent_update?ip={urllib.parse.quote(VPS_IP, safe='')}&component={component}"
            request = urllib.request.Request(update_url, headers=HEADERS)
            with _urlopen(request, timeout=20) as response:
                source = response.read(2 * 1024 * 1024 + 1)
                expected_hash = response.headers.get("X-Agent-SHA256", "").lower()
                version = response.headers.get("X-Agent-Manifest-Version", "")
                length = response.headers.get("X-Agent-Length", "")
                supplied_mac = response.headers.get("X-Agent-MAC", "").lower()
            manifest = f"v1\n{component}\n{expected_hash}\n{len(source)}\n".encode()
            expected_mac = hmac.new(TOKEN.encode(), manifest, hashlib.sha256).hexdigest()
            if not source or len(source) > 2 * 1024 * 1024 or version != "1" or length != str(len(source)) or not re.fullmatch(r"[0-9a-f]{64}", expected_hash) or not hmac.compare_digest(supplied_mac, expected_mac) or hashlib.sha256(source).hexdigest() != expected_hash:
                raise ValueError(f"{component} update checksum mismatch")
            current_hash = hashlib.sha256(open(target, "rb").read()).hexdigest() if os.path.exists(target) else ""
            if current_hash == expected_hash:
                continue
            with open(temp_path, "wb") as update_file: update_file.write(source)
            os.chmod(temp_path, 0o700)
            checked = subprocess.run([sys.executable, "-m", "py_compile", temp_path], capture_output=True, text=True, timeout=30)
            if checked.returncode != 0: raise ValueError(f"{component} update compile failed: {checked.stderr.strip()}")
            changed.append((temp_path, target))
        if not changed: return False
        replaced = []
        try:
            for temp_path, target in changed:
                backup = target + ".last-good"
                if os.path.exists(target): shutil.copy2(target, backup)
                os.replace(temp_path, target); replaced.append((target, backup))
        except Exception:
            for target, backup in reversed(replaced):
                if os.path.exists(backup): shutil.copy2(backup, target)
            raise
        _write_json_state("/opt/kui/.update-pending", {"updated_at": int(time.time()), "deadline_at": int(time.time()) + 120, "files": [target for _, target in changed]})
        print("[agent] components updated, restarting", flush=True)
        os.execv(sys.executable, [sys.executable, os.path.abspath(__file__)])
    except Exception as error:
        print(f"[agent] update check failed: {error}", flush=True)
        try:
            for temp_path in temporary_files:
                if os.path.exists(temp_path): os.remove(temp_path)
        except Exception:
            pass
    return False

# Dashboard viewers receive five-second updates. While nobody is connected,
# Durable Objects switch routine metric snapshots to a lower rate.
REALTIME_STATUS_ACTIVE_INTERVAL = 5
REALTIME_STATUS_IDLE_INTERVAL = 30
realtime_status_interval = REALTIME_STATUS_ACTIVE_INTERVAL
global_interval = REALTIME_STATUS_ACTIVE_INTERVAL
fast_mode = False
config_wakeup = threading.Event()
heartbeat_wakeup = threading.Event()
realtime_channel = None
last_http_report = 0
# Keep D1's fallback snapshot fresh for dashboard reloads and reconnects.
# WebSocket remains the primary five-second live channel.
# WebSocket carries live telemetry. HTTP is only for durable traffic/accounting
# acknowledgements and configuration, so keep it out of the D1 hot path.
REALTIME_HTTP_INTERVAL = 300

# 🌟 增加全局 Ping 状态缓存锁，防止在非测速轮次上传 '0' 导致前端图表归零
last_pings = {"ct": "0", "cu": "0", "cm": "0", "bd": "0"}
dynamic_ping = {"ct": None, "cu": None, "cm": None}
pending_report_id = None
pending_report_bytes = None
pending_node_traffic = None
pending_system_bytes = None
pending_report_payload = None
_traffic_state = _load_traffic_state()
last_reported_bytes = {str(k): int(v) for k, v in (_traffic_state.get("last_reported_bytes") or {}).items()}
try:
    last_reported_system_bytes = max(0, int(_traffic_state["last_reported_system_bytes"])) if _traffic_state.get("last_reported_system_bytes") is not None else None
except (TypeError, ValueError):
    last_reported_system_bytes = None
_pending = _traffic_state.get("pending") or {}
pending_report_id = _pending.get("report_id")
pending_report_bytes = _pending.get("report_bytes")
pending_node_traffic = _pending.get("node_traffic")
try:
    pending_system_bytes = max(0, int(_pending["system_bytes"])) if _pending.get("system_bytes") is not None else None
except (TypeError, ValueError):
    pending_system_bytes = None
pending_report_payload = _pending.get("payload")
egress_retry_timer = None
egress_retry_lock = threading.Lock()
egress_probe_lock = threading.Lock()

def _schedule_egress_retry(delay):
    global egress_retry_timer
    with egress_retry_lock:
        if egress_retry_timer: egress_retry_timer.cancel()
        egress_retry_timer = threading.Timer(max(1, delay), config_wakeup.set)
        egress_retry_timer.daemon = True
        egress_retry_timer.start()

# --- 缓存静态信息 ---
cached_os = cached_arch = cached_cpu_info = cached_virt = None

def run_text(command, timeout=5):
    try:
        result = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=timeout)
        return result.stdout.strip()
    except Exception:
        return ""

def get_static_sysinfo():
    global cached_os, cached_arch, cached_cpu_info, cached_virt
    if not cached_os:
        try:
            with open('/etc/os-release') as f:
                for line in f:
                    if line.startswith('PRETTY_NAME='):
                        cached_os = line.split('=')[1].strip().strip('"')
                        break
        except: cached_os = run_text('uname -srm') or "Unknown OS"
    if not cached_arch: cached_arch = run_text('uname -m') or platform.machine() or "unknown"
    if not cached_cpu_info:
        try:
            with open('/proc/cpuinfo') as f:
                for line in f:
                    if 'model name' in line:
                        cached_cpu_info = line.split(':')[1].strip()
                        break
        except: cached_cpu_info = "Unknown CPU"
    if not cached_virt:
        virt = run_text('systemd-detect-virt 2>/dev/null')
        if not virt or virt == 'none':
            try:
                with open('/proc/1/environ', 'r', errors='ignore') as f: init_env = f.read()
                with open('/proc/cpuinfo', 'r', errors='ignore') as f: cpu_info = f.read().lower()
                if 'lxc' in init_env: virt = 'lxc'
                elif 'docker' in init_env: virt = 'docker'
                elif os.path.exists('/proc/user_beancounters'): virt = 'openvz'
                elif 'kvm' in cpu_info: virt = 'kvm'
                elif 'qemu' in cpu_info: virt = 'qemu'
                else: virt = "KVM/Physical"
            except Exception:
                virt = "Unknown"
        cached_virt = virt.upper()
    return cached_os, cached_arch, cached_cpu_info, cached_virt

def get_http_ping(url):
    try:
        target = normalize_ping_target(url)
        host = f"[{target}]" if ":" in target else target
        result = subprocess.run(
            ["curl", "-o", "/dev/null", "-s", "-m", "2", "-w", "%{time_total}", f"http://{host}"],
            capture_output=True, text=True, timeout=4, check=True,
        )
        return str(int(float(result.stdout.strip()) * 1000))
    except: return "0"

def normalize_ping_target(value):
    target = str(value or "").strip().lower()
    if not target or len(target) > 253 or re.search(r"[\x00-\x20\x7f/?#@]", target) or "://" in target:
        raise ValueError("invalid ping target")
    try:
        ipaddress.ip_address(target)
        return target
    except ValueError:
        pass
    if not re.fullmatch(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", target):
        raise ValueError("invalid ping target")
    return target

def get_net_dev_bytes():
    try:
        # Count only the default-route interface. Summing every non-loopback
        # device double-counts forwarded packets on tunnels, bridges and veths.
        route = subprocess.run(
            ["ip", "-o", "route", "show", "default"],
            capture_output=True, text=True, timeout=3, check=True
        ).stdout
        match = re.search(r'\bdev\s+(\S+)', route)
        if not match:
            return 0, 0
        interface = match.group(1)
        with open(f'/sys/class/net/{interface}/statistics/rx_bytes') as f:
            rx = int(f.read().strip())
        with open(f'/sys/class/net/{interface}/statistics/tx_bytes') as f:
            tx = int(f.read().strip())
        return rx, tx
    except: pass
    return 0, 0

def ensure_firewall_open(port, transport=None):
    # 验证端口参数
    try:
        port_int = int(port)
        if not (1 <= port_int <= 65535):
            raise ValueError(f"端口 {port} 超出有效范围 (1-65535)")
    except (ValueError, TypeError):
        raise ValueError(f"无效的端口参数: {port}")
    
    port = str(port_int)
    for protocol in ([transport] if transport in {"tcp", "udp"} else ["tcp", "udp"]):
        cmds = [
            f"iptables -C INPUT -p {protocol} --dport {port} -j ACCEPT 2>/dev/null || iptables -I INPUT -p {protocol} --dport {port} -j ACCEPT",
            f"iptables -C OUTPUT -p {protocol} --sport {port} -j ACCEPT 2>/dev/null || iptables -I OUTPUT -p {protocol} --sport {port} -j ACCEPT",
            f"ip6tables -C INPUT -p {protocol} --dport {port} -j ACCEPT 2>/dev/null || ip6tables -I INPUT -p {protocol} --dport {port} -j ACCEPT",
            f"ip6tables -C OUTPUT -p {protocol} --sport {port} -j ACCEPT 2>/dev/null || ip6tables -I OUTPUT -p {protocol} --sport {port} -j ACCEPT"
        ]
        for cmd in cmds:
            try: subprocess.run(cmd, shell=True, stderr=subprocess.DEVNULL, timeout=5)
            except Exception: pass
        try:
            has_ufw = subprocess.run("command -v ufw", shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3).returncode == 0
            if has_ufw: subprocess.run(f"ufw allow {port}/{protocol} >/dev/null 2>&1", shell=True, timeout=5)
        except Exception: pass

def _read_iptables_port_bytes(port, protocol):
    """基于 ensure_firewall_open 插入的 dport(INPUT)/sport(OUTPUT) ACCEPT 规则，
    读取该端口的进出累计字节，实现真正的单节点精确计量。
    返回 None 表示未找到规则或读取失败（上层据此返回 0，避免误计）。"""
    port_s = str(port)
    total = 0
    found = False
    for tool, chain, key in (
        ("iptables", "INPUT", f"dpt:{port_s}"), ("iptables", "OUTPUT", f"spt:{port_s}"),
        ("ip6tables", "INPUT", f"dpt:{port_s}"), ("ip6tables", "OUTPUT", f"spt:{port_s}"),
    ):
        try:
            out = subprocess.run([tool, "-nvxL", chain], capture_output=True, text=True, timeout=3).stdout
        except Exception:
            continue
        key_pattern = re.compile(rf'(?<!\d){re.escape(key)}(?!\d)')
        for line in out.splitlines():
            if "ACCEPT" not in line or not key_pattern.search(line) or protocol not in line.lower().split():
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            try:
                # iptables -nvx 列序: pkts bytes target ...
                total += int(parts[1])
                found = True
            except Exception:
                pass
    return total if found else None

def get_port_traffic(port, protocol="tcp", node_id=None):
    # Official sing-box release binaries do not include the optional V2Ray
    # statistics API. Every managed node owns a unique port/transport pair,
    # so the persistent firewall counters are the reliable cumulative source.
    transports = ["tcp", "udp"] if protocol in {"both", "tcp,udp"} else [protocol]
    totals = [_read_iptables_port_bytes(port, item) for item in transports]
    available = [value for value in totals if value is not None]
    return sum(available) if available else None


def normalize_ss2022_network(value):
    network = str(value or "tcp,udp").lower()
    if network == "tcp": return ["tcp"]
    if network == "udp": return ["udp"]
    if network == "tcp,udp": return ["tcp", "udp"]
    raise ValueError("invalid Shadowsocks2022 network")


def node_transports(node):
    if node.get("protocol") == "Shadowsocks2022":
        return normalize_ss2022_network(node.get("network"))
    return ["udp"] if node.get("protocol") in {"Hysteria2", "TUIC"} else ["tcp"]


def node_listen_address(vps_ip):
    try:
        return "::" if ipaddress.ip_address(str(vps_ip)).version == 6 else "0.0.0.0"
    except ValueError:
        return "0.0.0.0"


def tune_inbound(inbound, transports):
    # UDP listeners must stay exclusive so a stray process cannot split flows.
    if "udp" not in transports:
        inbound["reuse_addr"] = True
    if "tcp" in transports:
        inbound.update({"tcp_fast_open": True, "tcp_keep_alive": "2m", "tcp_keep_alive_interval": "30s"})
    if "udp" in transports:
        inbound["udp_timeout"] = "5m"
    return inbound


def tune_outbound(outbound):
    outbound.update({"connect_timeout": "10s", "tcp_fast_open": True, "tcp_keep_alive": "2m", "tcp_keep_alive_interval": "30s"})
    return outbound

def get_system_status(current_interval):
    global prev_cpu_total, prev_cpu_idle, prev_rx, prev_tx, loop_counter, last_pings
    stats = {"cpu": 0, "mem": 0, "disk": 0, "uptime": "Unknown", "load": "0.00", "net_in_speed": 0, "net_out_speed": 0}
    
    try:
        with open('/proc/stat', 'r') as f:
            for line in f:
                if line.startswith('cpu '):
                    p = [float(x) for x in line.split()[1:]]
                    idle, total = p[3] + p[4], sum(p)
                    if prev_cpu_total > 0 and (total - prev_cpu_total) > 0:
                        stats["cpu"] = int(100.0 * (1.0 - (idle - prev_cpu_idle) / (total - prev_cpu_total)))
                    prev_cpu_total, prev_cpu_idle = total, idle
                    break
    except Exception: pass

    try:
        with open('/proc/meminfo', 'r') as f: mem = f.read()
        t = re.search(r'MemTotal:\s+(\d+)', mem); a = re.search(r'MemAvailable:\s+(\d+)', mem)
        u = re.search(r'SwapTotal:\s+(\d+)', mem); v = re.search(r'SwapFree:\s+(\d+)', mem)
        total_ram = int(t.group(1)) // 1024 if t else 0
        avail_ram = int(a.group(1)) // 1024 if a else 0
        used_ram = total_ram - avail_ram
        if total_ram > 0: stats["mem"] = int((used_ram / total_ram) * 100)
        
        stats["ram_total"] = str(total_ram)
        stats["ram_used"] = str(used_ram)
        stats["swap_total"] = str(int(u.group(1)) // 1024) if u else "0"
        stats["swap_used"] = str((int(u.group(1)) - int(v.group(1))) // 1024) if u and v else "0"
    except Exception: pass

    try:
        df_output = subprocess.run(["df", "-m", "/"], capture_output=True, text=True, timeout=3, check=True).stdout
        df = df_output.split('\n')[1].split()
        stats["disk_total"] = df[1]
        stats["disk_used"] = df[2]
        stats["disk"] = int(df[4].replace('%', ''))
    except: pass

    try:
        with open('/proc/loadavg') as f: stats["load"] = " ".join(f.read().split()[:3])
        with open('/proc/uptime') as f:
            up_sec = float(f.read().split()[0])
            d, h, m = int(up_sec//86400), int((up_sec%86400)//3600), int((up_sec%3600)//60)
            stats["uptime"] = f"{d} days, {h:02d}:{m:02d}" if d > 0 else f"{h:02d}:{m:02d}"
        
        stats["boot_time"] = run_text("uptime -s 2>/dev/null || stat -c %y / 2>/dev/null | cut -d'.' -f1", timeout=3)
        process_count = run_text("ps -e | wc -l", timeout=3)
        stats["processes"] = str(max(0, int(process_count or '1') - 1))
        stats["tcp_conn"] = run_text("ss -ant 2>/dev/null | grep -v 'State' | wc -l", timeout=3) or "0"
        stats["udp_conn"] = run_text("ss -anu 2>/dev/null | grep -v 'State' | wc -l", timeout=3) or "0"
    except: pass

    rx_now, tx_now = get_net_dev_bytes()
    stats["net_rx"] = str(rx_now); stats["net_tx"] = str(tx_now)
    # Measure elapsed wall time instead of the requested heartbeat interval.
    # The latter changes with dashboard activity and was leaving stale zero
    # speeds after reconfiguration or a failed HTTP fallback report.
    now = time.monotonic()
    previous_sample_at = getattr(get_system_status, "previous_sample_at", 0.0)
    elapsed = now - previous_sample_at if previous_sample_at else 0.0
    if elapsed > 0:
        stats["net_in_speed"] = max(0, rx_now - prev_rx) / elapsed
        stats["net_out_speed"] = max(0, tx_now - prev_tx) / elapsed
    get_system_status.previous_sample_at = now
    prev_rx, prev_tx = rx_now, tx_now

    # 🌟 每间隔几次循环更新一次真实的 Ping 值缓存
    if loop_counter % 4 == 0:
        idx = (loop_counter // 4) % 3
        if idx == 0: ct, cu, cm = "bj-ct-dualstack.ip.zstaticcdn.com", "bj-cu-dualstack.ip.zstaticcdn.com", "bj-cm-dualstack.ip.zstaticcdn.com"
        elif idx == 1: ct, cu, cm = "sh-ct-dualstack.ip.zstaticcdn.com", "sh-cu-dualstack.ip.zstaticcdn.com", "sh-cm-dualstack.ip.zstaticcdn.com"
        else: ct, cu, cm = "gd-ct-dualstack.ip.zstaticcdn.com", "gd-cu-dualstack.ip.zstaticcdn.com", "gd-cm-dualstack.ip.zstaticcdn.com"
        last_pings["ct"] = get_http_ping(dynamic_ping["ct"] or ct)
        last_pings["cu"] = get_http_ping(dynamic_ping["cu"] or cu)
        last_pings["cm"] = get_http_ping(dynamic_ping["cm"] or cm)
        last_pings["bd"] = get_http_ping("lf3-ips.zstaticcdn.com")

    # 把最近一次成功的 Ping 值塞入状态发给后端，避免前端由于读到0产生断崖
    stats["ping_ct"] = last_pings["ct"]
    stats["ping_cu"] = last_pings["cu"]
    stats["ping_cm"] = last_pings["cm"]
    stats["ping_bd"] = last_pings["bd"]

    os_info, arch, cpu_info, virt = get_static_sysinfo()
    stats.update({"os": os_info, "arch": arch, "cpu_info": cpu_info, "virt": virt})

    loop_counter += 1
    return stats

def ensure_cloudflared():
    target = "/usr/local/bin/cloudflared"
    asset = CLOUDFLARED_ASSETS.get(platform.machine().lower())
    if not asset:
        return False
    arch, expected = asset
    if os.path.isfile(target):
        with open(target, "rb") as binary:
            if hashlib.sha256(binary.read()).hexdigest() == expected: return True
    fd, tmp_path = tempfile.mkstemp(prefix="cloudflared-", dir="/usr/local/bin")
    os.close(fd)
    try:
        result = subprocess.run(["curl", "-fL", "--retry", "3", "--max-filesize", "60000000", "-o", tmp_path, f"https://github.com/cloudflare/cloudflared/releases/download/{CLOUDFLARED_VERSION}/cloudflared-linux-{arch}"], timeout=120)
        if result.returncode != 0 or os.path.getsize(tmp_path) == 0:
            return False
        with open(tmp_path, "rb") as binary:
            if hashlib.sha256(binary.read()).hexdigest() != expected: return False
        os.chmod(tmp_path, 0o755)
        os.replace(tmp_path, target)
        return True
    except Exception:
        return False
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

def stop_process(process):
    if not process:
        return
    try:
        process.terminate()
        process.wait(timeout=3)
    except Exception:
        try: process.kill(); process.wait(timeout=3)
        except Exception: pass

def process_argo_nodes(configs):
    argo_urls = []
    expected_ports = [str(n['port']) for n in configs if n.get('protocol') == 'VLESS-Argo']
    for port in list(argo_tunnels.keys()):
        if argo_tunnels[port]["proc"].poll() is not None:
            stop_process(argo_tunnels[port]["proc"])
            argo_tunnels[port].get("log_file") and argo_tunnels[port]["log_file"].close()
            del argo_tunnels[port]
    for port in expected_ports:
        if port not in argo_tunnels:
            if not ensure_cloudflared():
                continue
            cmd = ["/usr/local/bin/cloudflared", "tunnel", "--edge-ip-version", "auto", "--no-autoupdate", "--url", f"http://[::1]:{port}"]
            log_path = f"/opt/kui/argo_{port}.log"
            log_file = open(log_path, "w+")
            p = subprocess.Popen(cmd, stderr=log_file, stdout=subprocess.DEVNULL, text=True)
            url = None; start_t = time.time()
            while time.time() - start_t < 15:
                if p.poll() is not None: break
                log_file.flush(); log_file.seek(0)
                match = re.search(r'https://([a-zA-Z0-9-]+\.trycloudflare\.com)', log_file.read())
                if match: url = match.group(1); break
                time.sleep(0.5)
            if url: argo_tunnels[port] = {"proc": p, "url": url, "log_file": log_file}
            else: stop_process(p); log_file.close()
        if port in argo_tunnels: argo_urls.append({"id": [n['id'] for n in configs if str(n['port'])==port][0], "url": argo_tunnels[port]["url"]})
    for port in list(argo_tunnels.keys()):
        if port not in expected_ports:
            stop_process(argo_tunnels[port]["proc"])
            argo_tunnels[port].get("log_file") and argo_tunnels[port]["log_file"].close()
            del argo_tunnels[port]
    return argo_urls

def build_chain_outbound(target, tag):
    proto = target.get("protocol", "")
    outbound = {"tag": tag, "server": target["ip"], "server_port": int(target["port"])}
    if proto in ["VLESS", "XTLS-Reality", "Reality", "H2-Reality", "gRPC-Reality"]:
        outbound.update({"type": "vless", "uuid": target["uuid"]})
        if "Reality" in proto:
            outbound["tls"] = {"enabled": True, "server_name": target.get("sni") or "addons.mozilla.org", "reality": {"enabled": True, "public_key": target.get("public_key", ""), "short_id": target.get("short_id", "")}}
        if proto in ["XTLS-Reality", "Reality"]: outbound["flow"] = "xtls-rprx-vision"
        if proto == "H2-Reality":
            server_name = target.get("sni") or "addons.mozilla.org"
            outbound["transport"] = {"type": "http", "host": [server_name], "path": "/"}
        if proto == "gRPC-Reality": outbound["transport"] = {"type": "grpc", "service_name": "grpc"}
    elif proto == "Trojan":
        outbound.update({"type": "trojan", "password": target.get("password", ""), "tls": {"enabled": True, "server_name": target.get("sni") or "addons.mozilla.org", "insecure": True}})
    elif proto == "Hysteria2":
        outbound.update({"type": "hysteria2", "password": target.get("uuid") or target.get("password", ""), "tls": {"enabled": True, "server_name": target.get("sni") or "addons.mozilla.org", "insecure": True}})
    elif proto == "TUIC":
        outbound.update({"type": "tuic", "uuid": target["uuid"], "password": target.get("password", ""), "congestion_control": "bbr", "udp_relay_mode": "native", "tls": {"enabled": True, "alpn": ["h3"], "insecure": True}})
    elif proto == "Shadowsocks2022":
        validate_ss2022_credentials(target.get("uuid", ""), target.get("password", ""))
        outbound.update({"type": "shadowsocks", "method": target["uuid"], "password": target["password"], "network": normalize_ss2022_network(target.get("network"))})
    elif proto == "AnyTLS":
        outbound.update({"type": "anytls", "password": target.get("password", ""), "tls": {"enabled": True, "server_name": target.get("sni") or "addons.mozilla.org", "insecure": True}})
    else:
        return None
    return tune_outbound(outbound)

def validate_mtproxy_secret(secret, domain):
    normalized = str(secret or "").strip().lower()
    domain = str(domain or "").strip().lower()
    if not domain or not re.fullmatch(r"ee[0-9a-f]{34,}", normalized) or len(normalized) % 2:
        raise ValueError("invalid MTProxy FakeTLS secret")
    if normalized[34:] != domain.encode("utf-8").hex():
        raise ValueError("MTProxy FakeTLS secret does not match domain")
    return normalized

def build_mtproxy_config(node, listen_address):
    port = int(node["port"])
    if not 1 <= port <= 65535:
        raise ValueError("invalid MTProxy port")
    secret = validate_mtproxy_secret(node.get("private_key"), node.get("sni"))
    bind_host = f"[{listen_address}]" if ":" in listen_address and not listen_address.startswith("[") else listen_address
    return f'secret = "{secret}"\nbind-to = "{bind_host}:{port}"\n'

def mtg_asset(machine=None):
    asset = MTG_ASSETS.get((machine or platform.machine()).lower())
    if not asset:
        raise RuntimeError(f"unsupported mtg architecture: {machine or platform.machine()}")
    return asset

def _write_text_if_changed(path, content, mode):
    try:
        with open(path, "r", encoding="utf-8") as current:
            if current.read() == content:
                os.chmod(path, mode)
                return False
    except OSError:
        pass
    os.makedirs(os.path.dirname(path), exist_ok=True)
    staged = f"{path}.tmp.{os.getpid()}"
    with open(staged, "w", encoding="utf-8") as output:
        output.write(content)
        output.flush()
        os.fsync(output.fileno())
    os.chmod(staged, mode)
    os.replace(staged, path)
    return True

def ensure_mtg_binary():
    version_marker = f"{MTPROXY_BIN}.version"
    try:
        with open(version_marker, "r", encoding="utf-8") as marker:
            if marker.read().strip() == MTG_VERSION and os.path.isfile(MTPROXY_BIN) and os.access(MTPROXY_BIN, os.X_OK):
                return False
    except OSError:
        pass

    arch, expected_sha = mtg_asset()
    os.makedirs(os.path.dirname(MTPROXY_BIN), mode=0o700, exist_ok=True)
    work_dir = tempfile.mkdtemp(prefix="mtg-install-", dir=MTPROXY_ROOT)
    archive_path = os.path.join(work_dir, "mtg.tar.gz")
    staged_binary = os.path.join(work_dir, "mtg")
    release_url = f"https://github.com/9seconds/mtg/releases/download/v{MTG_VERSION}/mtg-{MTG_VERSION}-linux-{arch}.tar.gz"
    try:
        download_urls = [f"{GITHUB_PROXY}/{release_url}", release_url] if GITHUB_PROXY else [release_url]
        failures = []
        archive_verified = False
        for download_url in dict.fromkeys(download_urls):
            result = subprocess.run([
                "curl", "-fL", "--retry", "3", "--connect-timeout", "10", "--max-time", "180",
                "--max-filesize", "30000000", "-o", archive_path, download_url,
            ], capture_output=True, text=True, timeout=210)
            if result.returncode != 0:
                failures.append(result.stderr.strip()[-200:] or f"curl exit {result.returncode}")
                continue
            digest = hashlib.sha256()
            with open(archive_path, "rb") as archive_file:
                for chunk in iter(lambda: archive_file.read(1024 * 1024), b""):
                    digest.update(chunk)
            if hmac.compare_digest(digest.hexdigest(), expected_sha):
                archive_verified = True
                break
            failures.append("mtg archive checksum mismatch")
        if not archive_verified:
            raise RuntimeError(f"mtg download failed: {'; '.join(failures)[-500:]}")
        with tarfile.open(archive_path, "r:gz") as archive:
            matches = [member for member in archive.getmembers() if member.isfile() and os.path.basename(member.name) == "mtg"]
            if len(matches) != 1 or matches[0].size <= 0 or matches[0].size > 100 * 1024 * 1024:
                raise RuntimeError("mtg archive has an invalid binary member")
            source = archive.extractfile(matches[0])
            if source is None:
                raise RuntimeError("mtg binary could not be extracted")
            with source, open(staged_binary, "wb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)
                output.flush()
                os.fsync(output.fileno())
        os.chmod(staged_binary, 0o700)
        checked = subprocess.run([staged_binary, "--version"], capture_output=True, text=True, timeout=15)
        if checked.returncode != 0 or MTG_VERSION not in (checked.stdout + checked.stderr):
            raise RuntimeError("mtg binary version check failed")
        os.replace(staged_binary, MTPROXY_BIN)
        _write_text_if_changed(version_marker, MTG_VERSION + "\n", 0o600)
        return True
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

def _mtproxy_service_name(node_id):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", str(node_id)):
        raise ValueError("invalid MTProxy node id")
    return f"kui-mtproxy-{node_id}"

def _mtproxy_systemd_unit(node_id, config_path):
    return f"""[Unit]
Description=KUI MTProxy ({node_id})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart={MTPROXY_BIN} run {config_path}
Restart=always
RestartSec=3
User=root
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
"""

def _mtproxy_openrc_service(node_id, config_path):
    return f'''#!/sbin/openrc-run
description="KUI MTProxy ({node_id})"
command="{MTPROXY_BIN}"
command_args="run {config_path}"
command_background="yes"
pidfile="/run/kui-mtproxy-{node_id}.pid"
output_log="/var/log/kui-mtproxy-{node_id}.log"
error_log="/var/log/kui-mtproxy-{node_id}.log"
rc_ulimit="-n 1048576"
depend() {{ need net; }}
'''

def _desired_mtproxy_nodes(nodes):
    desired = []
    seen_ids = set()
    seen_ports = set()
    for node in nodes or []:
        if node.get("protocol") != "MTProxy":
            continue
        node_id = str(node.get("id") or "")
        _mtproxy_service_name(node_id)
        port = int(node.get("port"))
        if not 1 <= port <= 65535 or node_id in seen_ids or port in seen_ports:
            raise ValueError("invalid or duplicate MTProxy listener")
        validate_mtproxy_secret(node.get("private_key"), node.get("sni"))
        seen_ids.add(node_id)
        seen_ports.add(port)
        desired.append(node)
    mtproxy_ports = {int(node["port"]) for node in desired}
    for node in nodes or []:
        if node.get("protocol") == "MTProxy":
            continue
        try:
            port = int(node.get("port"))
            transports = node_transports(node)
        except (TypeError, ValueError):
            continue
        if port in mtproxy_ports and "tcp" in transports:
            raise ValueError(f"MTProxy TCP port {port} conflicts with another node")
    return desired

def _installed_mtproxy_ids():
    ids = set()
    for directory, prefix, suffix in (
        (MTPROXY_NODE_DIR, "", ".toml"),
        ("/etc/systemd/system", "kui-mtproxy-", ".service"),
        ("/etc/init.d", "kui-mtproxy-", ""),
    ):
        try:
            names = os.listdir(directory)
        except OSError:
            continue
        for name in names:
            if name.startswith(prefix) and name.endswith(suffix):
                node_id = name[len(prefix):len(name) - len(suffix) if suffix else None]
                if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", node_id):
                    ids.add(node_id)
    return ids

def prepare_mtproxy_nodes(nodes):
    desired_ids = {str(node["id"]) for node in _desired_mtproxy_nodes(nodes)}
    stale_ids = sorted(_installed_mtproxy_ids() - desired_ids)
    if not stale_ids:
        return
    openrc = os.path.exists("/etc/alpine-release") or os.path.exists("/sbin/openrc-run")
    for node_id in stale_ids:
        service = _mtproxy_service_name(node_id)
        if openrc:
            subprocess.run(["rc-service", service, "stop"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
            subprocess.run(["rc-update", "del", service, "default"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
            service_path = f"/etc/init.d/{service}"
        else:
            subprocess.run(["systemctl", "disable", "--now", f"{service}.service"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
            service_path = f"/etc/systemd/system/{service}.service"
        for path in (service_path, f"/etc/systemd/system/{service}.service", f"/etc/init.d/{service}", f"{MTPROXY_NODE_DIR}/{node_id}.toml"):
            try: os.remove(path)
            except FileNotFoundError: pass
    if not openrc:
        subprocess.run(["systemctl", "daemon-reload"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)

def sync_mtproxy_nodes(nodes):
    desired = _desired_mtproxy_nodes(nodes)
    if not desired:
        return
    binary_changed = ensure_mtg_binary()
    os.makedirs(MTPROXY_NODE_DIR, mode=0o700, exist_ok=True)
    openrc = os.path.exists("/etc/alpine-release") or os.path.exists("/sbin/openrc-run")
    pending = []
    units_changed = False
    listen_address = node_listen_address(VPS_IP)
    for node in desired:
        node_id = str(node["id"])
        service = _mtproxy_service_name(node_id)
        config_path = f"{MTPROXY_NODE_DIR}/{node_id}.toml"
        config_changed = _write_text_if_changed(config_path, build_mtproxy_config(node, listen_address), 0o600)
        if openrc:
            service_path = f"/etc/init.d/{service}"
            unit_changed = _write_text_if_changed(service_path, _mtproxy_openrc_service(node_id, config_path), 0o700)
        else:
            service_path = f"/etc/systemd/system/{service}.service"
            unit_changed = _write_text_if_changed(service_path, _mtproxy_systemd_unit(node_id, config_path), 0o644)
        units_changed = units_changed or unit_changed
        pending.append((node, service, binary_changed or config_changed or unit_changed))
    if units_changed and not openrc:
        subprocess.run(["systemctl", "daemon-reload"], check=True, timeout=20)
    for node, service, changed in pending:
        if openrc:
            subprocess.run(["rc-update", "add", service, "default"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
            action = "restart" if changed else "start"
            started = subprocess.run(["rc-service", service, action], capture_output=True, text=True, timeout=30)
            healthy = started.returncode == 0 and subprocess.run(["rc-service", service, "status"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15).returncode == 0
        else:
            subprocess.run(["systemctl", "enable", f"{service}.service"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
            action = "restart" if changed else "start"
            started = subprocess.run(["systemctl", action, f"{service}.service"], capture_output=True, text=True, timeout=30)
            healthy = started.returncode == 0 and subprocess.run(["systemctl", "is-active", "--quiet", f"{service}.service"], timeout=15).returncode == 0
        if not healthy:
            raise RuntimeError(f"MTProxy service {service} failed: {(started.stderr or started.stdout).strip()[-300:]}")
        ensure_firewall_open(node["port"], "tcp")

def build_singbox_config(nodes, proxy_cfg=None, peers=None, mesh=None, socks5_outbound=None, warp_mode="off", egress_check_host="127.0.0.1"):
    global proxy_port_conflict
    node_listen = node_listen_address(VPS_IP)
    singbox_config = {
        "log": {"level": "warn"},
        "inbounds": [],
        "outbounds": [tune_outbound({"type": "direct", "tag": "direct-out"})],
        "route": {"rules": []}
    }
    egress_check_host = normalize_check_host(egress_check_host)
    active_certs = []
    valid_nodes = []
    listener_keys = set()
    dns_policy_mode = "native"
    dns_outbound_tag = ""
    dns_rule_tags = []
    dns_direct_rule_tags = []
    custom_proxy_domains = []
    dns_strategy = "prefer_ipv4"
    dns_final_rules = []
    landing_dns_detours = []
    if warp_mode not in {"off", "ipv4", "ipv6", "dual"}:
        raise ValueError("invalid WARP mode")

    for node in nodes:
        try:
            node_id = str(node["id"])
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", node_id): raise ValueError("invalid node id")
            in_tag, proto, port = f"in-{node_id}", node["protocol"], int(node["port"])
            if not 1 <= port <= 65535: raise ValueError("invalid port")
            transports = node_transports(node)
            listener_keys_for_node = {(transport, port) for transport in transports}
            conflict = next((transport for transport, key_port in listener_keys_for_node if (transport, key_port) in listener_keys), None)
            if conflict: raise ValueError(f"duplicate {conflict} listener port {port}")
            supported = {"VLESS", "XTLS-Reality", "Reality", "Hysteria2", "TUIC", "Shadowsocks2022", "Trojan", "H2-Reality", "gRPC-Reality", "AnyTLS", "Naive", "Socks5", "VLESS-Argo", "dokodemo-door", "MTProxy"}
            if proto not in supported:
                raise ValueError(f"unsupported protocol {proto}")
            if proto != "dokodemo-door" and not isinstance(node.get("uuid"), str):
                raise ValueError("uuid is required")
            if proto in {"XTLS-Reality", "Reality", "H2-Reality", "gRPC-Reality"} and (not node.get("private_key") or not node.get("short_id")):
                raise ValueError("Reality private_key and short_id are required")
            if proto in {"TUIC", "Shadowsocks2022", "Trojan", "AnyTLS", "Naive", "Socks5", "MTProxy"} and not node.get("private_key"):
                raise ValueError(f"{proto} password is required")
            if proto == "Shadowsocks2022":
                validate_ss2022_credentials(node.get("uuid", ""), node.get("private_key", ""))
            if proto == "dokodemo-door":
                if node.get("relay_type") == "internal" and not node.get("chain_target"):
                    raise ValueError("dokodemo internal target is unavailable")
                if node.get("relay_type") != "internal" and (not node.get("target_ip") or not node.get("target_port")):
                    raise ValueError("dokodemo target_ip and target_port are required")
            if proto == "MTProxy":
                validate_mtproxy_secret(node.get("private_key"), node.get("sni"))
        except (KeyError, TypeError, ValueError) as error:
            print(f"[agent] skipping invalid node {node.get('id', '<unknown>')}: {error}", flush=True)
            continue
        if proto == "MTProxy":
            listener_keys.update(listener_keys_for_node)
            ensure_firewall_open(port, "tcp")
            continue
        sni = node.get("sni") or "addons.mozilla.org"
        certificate_name = "kui-tuic.local" if proto == "TUIC" else sni
        if proto in ["Hysteria2", "TUIC", "Trojan", "VLESS-WS-TLS", "AnyTLS", "Naive"]:
            cert_path, key_path, sni_path = f"/opt/kui/cert_{node['id']}.pem", f"/opt/kui/key_{node['id']}.pem", f"/opt/kui/cert_{node['id']}.sni"
            active_certs.extend([f"cert_{node['id']}.pem", f"key_{node['id']}.pem", f"cert_{node['id']}.sni"])
            previous_sni = ""
            try:
                with open(sni_path, "r") as marker: previous_sni = marker.read().strip()
            except OSError: pass
            if previous_sni != certificate_name:
                for stale_path in (cert_path, key_path):
                    try: os.remove(stale_path)
                    except OSError: pass
            if not os.path.exists(cert_path):
                parts = certificate_name.split('.'); cn = f"{parts[-2]}.{parts[-1]}" if len(parts) >= 2 else certificate_name
                conf_path = f"/opt/kui/cert_{node['id']}.conf"
                with open(conf_path, "w") as f: f.write(f"[req]\ndistinguished_name = req_distinguished_name\nx509_extensions = v3_req\nprompt = no\n[req_distinguished_name]\nCN = {cn}\n[v3_req]\nsubjectAltName = @alt_names\n[alt_names]\nDNS = {certificate_name}\n")
                subprocess.run(["openssl", "ecparam", "-genkey", "-name", "prime256v1", "-out", key_path], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                subprocess.run(["openssl", "req", "-new", "-x509", "-days", "36500", "-key", key_path, "-out", cert_path, "-config", conf_path, "-extensions", "v3_req"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                os.chmod(cert_path, 0o644)
                os.chmod(key_path, 0o600)
                with open(sni_path, "w") as marker: marker.write(certificate_name)
                os.chmod(sni_path, 0o600)
                try: os.remove(conf_path)
                except: pass
        
        if proto == "VLESS": singbox_config["inbounds"].append({"type": "vless", "tag": in_tag, "listen": node_listen, "listen_port": port, "users": [{"uuid": node["uuid"]}]})
        elif proto in ["XTLS-Reality", "Reality"]: singbox_config["inbounds"].append({"type": "vless", "tag": in_tag, "listen": node_listen, "listen_port": port, "users": [{"uuid": node["uuid"], "flow": "xtls-rprx-vision"}], "tls": {"enabled": True, "server_name": sni, "reality": {"enabled": True, "handshake": {"server": sni, "server_port": 443}, "private_key": node["private_key"], "short_id": [node["short_id"]]}}})
        elif proto == "Hysteria2": singbox_config["inbounds"].append({"type": "hysteria2", "tag": in_tag, "listen": node_listen, "listen_port": port, "users": [{"password": node["uuid"]}], "tls": {"enabled": True, "alpn": ["h3"], "certificate_path": cert_path, "key_path": key_path}})
        elif proto == "TUIC": singbox_config["inbounds"].append({"type": "tuic", "tag": in_tag, "listen": node_listen, "listen_port": port, "users": [{"uuid": node["uuid"], "password": node["private_key"]}], "congestion_control": "bbr", "tls": {"enabled": True, "alpn": ["h3"], "certificate_path": cert_path, "key_path": key_path}})
        elif proto == "Shadowsocks2022":
            ss_networks = normalize_ss2022_network(node.get("network"))
            singbox_config["inbounds"].append({"type": "shadowsocks", "tag": in_tag, "listen": node_listen, "listen_port": port, "network": ss_networks, "method": node["uuid"], "password": node["private_key"]})
        elif proto == "Trojan": singbox_config["inbounds"].append({"type": "trojan", "tag": in_tag, "listen": node_listen, "listen_port": port, "users": [{"password": node["private_key"]}], "tls": {"enabled": True, "server_name": sni, "certificate_path": cert_path, "key_path": key_path}})
        elif proto == "H2-Reality": singbox_config["inbounds"].append({"type": "vless", "tag": in_tag, "listen": node_listen, "listen_port": port, "users": [{"uuid": node["uuid"]}], "tls": {"enabled": True, "server_name": sni, "alpn": ["h2", "http/1.1"], "reality": {"enabled": True, "handshake": {"server": sni, "server_port": 443}, "private_key": node["private_key"], "short_id": [node["short_id"]]}}, "transport": {"type": "http", "host": [sni], "path": "/"}})
        elif proto == "gRPC-Reality": singbox_config["inbounds"].append({"type": "vless", "tag": in_tag, "listen": node_listen, "listen_port": port, "users": [{"uuid": node["uuid"]}], "tls": {"enabled": True, "server_name": sni, "alpn": ["h2"], "reality": {"enabled": True, "handshake": {"server": sni, "server_port": 443}, "private_key": node["private_key"], "short_id": [node["short_id"]]}}, "transport": {"type": "grpc", "service_name": "grpc"}})
        elif proto == "AnyTLS": singbox_config["inbounds"].append({"type": "anytls", "tag": in_tag, "listen": node_listen, "listen_port": port, "users": [{"password": node["private_key"]}], "tls": {"enabled": True, "certificate_path": cert_path, "key_path": key_path}})
        elif proto == "Naive": singbox_config["inbounds"].append({"type": "naive", "tag": in_tag, "listen": node_listen, "listen_port": port, "users": [{"username": node["uuid"], "password": node["private_key"]}], "tls": {"enabled": True, "certificate_path": cert_path, "key_path": key_path}})
        elif proto == "Socks5": singbox_config["inbounds"].append({"type": "socks", "tag": in_tag, "listen": node_listen, "listen_port": port, "users": [{"username": node["uuid"], "password": node["private_key"]}]})
        elif proto == "VLESS-Argo": singbox_config["inbounds"].append({"type": "vless", "tag": in_tag, "listen": node_listen, "listen_port": port, "users": [{"uuid": node["uuid"]}], "transport": {"type": "ws", "path": "/"}})
        elif proto == "dokodemo-door":
            singbox_config["inbounds"].append({ "type": "direct", "tag": in_tag, "listen": node_listen, "listen_port": port })
            out_tag = f"out-{node['id']}"
            if node.get("relay_type") == "internal" and node.get("chain_target"):
                t = node["chain_target"]
                outbound = build_chain_outbound(t, out_tag)
                if outbound:
                    singbox_config["outbounds"].append(outbound)
                else:
                    continue
            else:
                singbox_config["outbounds"].append(tune_outbound({ "type": "direct", "tag": out_tag, "override_address": node["target_ip"], "override_port": int(node["target_port"]) }))
            singbox_config["route"]["rules"].append({"inbound": [in_tag], "action": "route", "outbound": out_tag})
        listener_keys.update(listener_keys_for_node)
        valid_nodes.append(node)

    # --- 住宅IP代理出口 / SOCKS5 服务注入（如端口已被 proxy_server.py 占用则跳过，避免双进程抢端口炸 sing-box）---
    if proxy_cfg:
        if isinstance(proxy_cfg, dict):
            proxy_enabled = proxy_cfg.get("enabled", True)
            proxy_port = int(proxy_cfg.get("port", PROXY_PORT))
            proxy_user = proxy_cfg.get("user", PROXY_USER)
            proxy_pass = proxy_cfg.get("pass", PROXY_PASS)
        else:
            proxy_enabled = bool(proxy_cfg)
            proxy_port, proxy_user, proxy_pass = PROXY_PORT, PROXY_USER, PROXY_PASS
        if proxy_enabled:
            # proxy-lite owns the residential listener. During simultaneous
            # service restarts its socket may not be open yet; detecting only
            # an already-bound port lets sing-box steal the port in that gap.
            proxy_lite_installed = os.path.exists("/etc/proxy-lite/env") and os.path.exists("/opt/proxy_lite/proxy_server.py")
            if not proxy_lite_installed:
                if proxy_port_conflict is not False:
                    print(f"[agent] 端口 {proxy_port} 可用，由 sing-box 提供 SOCKS5 入站", flush=True)
                proxy_port_conflict = False
                try:
                    singbox_config["inbounds"].append({
                        "type": "socks",
                        "tag": "residential-socks5",
                        "listen": node_listen,
                        "listen_port": int(proxy_port),
                        "users": [
                            {"username": str(proxy_user), "password": str(proxy_pass)}
                        ]
                    })
                except Exception:
                    pass
            else:
                if proxy_port_conflict is not True:
                    print(f"[agent] 端口 {proxy_port} 预留给 proxy-lite，跳过 sing-box SOCKS5 入站", flush=True)
                proxy_port_conflict = True

    # --- 住宅IP跨VPS互联（mesh）：把本机节点出口链式转发到其它 VPS 的 SOCKS5，实现出口IP共享/轮换 ---
    mesh_enabled = bool(peers and mesh and mesh.get("enabled"))
    if mesh_enabled and socks5_outbound and socks5_outbound.get("enabled"):
        print("[agent] server SOCKS5 outbound takes priority; mesh routing skipped", flush=True)
        mesh_enabled = False
    if mesh_enabled:
        try:
            chain_mode = mesh.get("mode", "all")
            chain_nodes = set(str(x) for x in (mesh.get("nodes") or []))
            rr = [0]
            for node in valid_nodes:
                if node.get("protocol") == "dokodemo-door":
                    continue
                nid = str(node["id"])
                if chain_mode == "select" and nid not in chain_nodes:
                    continue
                if not peers:
                    break
                peer = peers[rr[0] % len(peers)]
                rr[0] += 1
                out_tag = f"mesh-out-{nid}"
                srv = peer.get("socks_ip") or peer.get("ip") or ""
                singbox_config["outbounds"].append(tune_outbound({
                    "type": "socks",
                    "tag": out_tag,
                    "server": srv,
                    "server_port": int(peer.get("port") or PROXY_PORT),
                    "username": str(peer.get("user") or PROXY_USER),
                    "password": str(peer.get("pass") or PROXY_PASS)
                }))
                in_tag = f"in-{nid}"
                singbox_config["route"]["rules"].append({"inbound": [in_tag], "outbound": out_tag})
                landing_dns_detours.append((in_tag, out_tag))
        except Exception:
            pass

    # --- SOCKS5 出站代理：全局出站 / 按分类选择性出站（YouTube / AI / 谷歌 / 流媒体）---
    if socks5_outbound and socks5_outbound.get("enabled"):
        s5_addr = str(socks5_outbound.get("addr", "")).strip()
        s5_port = int(socks5_outbound.get("port", 0))
        if not s5_addr or not 1 <= s5_port <= 65535:
            raise RuntimeError("invalid SOCKS5 outbound address or port")
        s5_tag = "socks5-outbound"
        s5_outbound = tune_outbound({"type": "socks", "tag": s5_tag, "server": s5_addr, "server_port": s5_port})
        s5_user = socks5_outbound.get("user", "")
        s5_pass = socks5_outbound.get("pass", "")
        if s5_user:
            s5_outbound["username"] = str(s5_user)
        if s5_pass:
            s5_outbound["password"] = str(s5_pass)
        singbox_config["outbounds"].append(s5_outbound)
        singbox_config["inbounds"].append({"type": "socks", "tag": "egress-check-in", "listen": egress_check_host, "listen_port": 39482})
        s5_mode = socks5_outbound.get("mode", "global")
        dns_policy_mode = "proxy-selective" if s5_mode == "selective" else "proxy-global"
        dns_outbound_tag = s5_tag
        if s5_mode == "selective":
            singbox_config["route"]["rules"].append({"inbound": ["egress-check-in"], "action": "route", "outbound": s5_tag})
            try:
                selective_config = json.loads(socks5_outbound.get("domains", "{}") or "{}")
                selected = selective_config.get("categories", [])
                custom_proxy_domains = selective_config.get("custom_domains", [])
            except Exception:
                selected = []
                custom_proxy_domains = []
            proxy_inbounds = sorted(f"in-{node['id']}" for node in valid_nodes if node.get("protocol") != "dokodemo-door")
            rule_sets, selective_rules, dns_rule_tags, dns_direct_rule_tags = build_selective_proxy_rules(selected, proxy_inbounds, s5_tag, custom_proxy_domains)
            if rule_sets:
                singbox_config["route"]["rule_set"] = rule_sets
            singbox_config["route"]["rules"].extend(rule for rule in selective_rules if rule.get("action") != "reject")
            dns_final_rules.extend(rule for rule in selective_rules if rule.get("action") == "reject")
            singbox_config["experimental"] = {
                "cache_file": {
                    "enabled": True,
                    "path": "/etc/sing-box/cache.db",
                    "cache_id": "kui-selective-rules",
                }
            }
        else:
            # 全局出站：所有非转发节点流量走 SOCKS5
            apply_global_proxy_route(singbox_config["route"], valid_nodes, s5_tag)

    if warp_mode != "off":
        if mesh_enabled:
            raise RuntimeError("WARP cannot be combined with residential mesh routing")
        if socks5_outbound and socks5_outbound.get("enabled"):
            raise RuntimeError("SOCKS5 outbound and WARP outbound cannot be enabled together")
        profile = _require_warp_profile()
        addresses = []
        allowed_ips = []
        if warp_mode in {"ipv4", "dual"}:
            addresses.append(profile["ipv4_address"])
            allowed_ips.append("0.0.0.0/0")
        if warp_mode in {"ipv6", "dual"}:
            addresses.append(profile["ipv6_address"])
            allowed_ips.append("::/0")
        singbox_config["endpoints"] = [{
            "type": "wireguard", "tag": "warp-out", "system": False,
            "mtu": min(max(int(profile.get("mtu", 1280)), 1280), 1420),
            "address": addresses, "private_key": profile["private_key"],
            "peers": [{
                "address": profile["peer_address"], "port": int(profile["peer_port"]),
                "public_key": profile["peer_public_key"], "allowed_ips": allowed_ips,
                "persistent_keepalive_interval": 25,
            }],
        }]
        strategy = "prefer_ipv4" if warp_mode != "ipv6" else "prefer_ipv6"
        dns_policy_mode = "warp"
        dns_outbound_tag = "warp-out"
        dns_strategy = "ipv6_only" if warp_mode == "ipv6" else ("ipv4_only" if warp_mode == "ipv4" else strategy)
        warp_inbounds = [f"in-{node['id']}" for node in valid_nodes if node.get("protocol") != "dokodemo-door"]
        if warp_inbounds:
            if warp_mode == "ipv4": singbox_config["route"]["rules"].append({"inbound": warp_inbounds, "ip_version": 6, "action": "reject"})
            elif warp_mode == "ipv6": singbox_config["route"]["rules"].append({"inbound": warp_inbounds, "ip_version": 4, "action": "reject"})
            singbox_config["route"]["rules"].append({"inbound": warp_inbounds, "action": "route", "outbound": "warp-out"})
        singbox_config["inbounds"].append({"type": "socks", "tag": "egress-check-in", "listen": egress_check_host, "listen_port": 39482})
        check_rule = {"inbound": ["egress-check-in"], "action": "route", "outbound": "warp-out"}
        singbox_config["route"]["rules"].append(check_rule)

    proxy_inbounds = sorted(f"in-{node['id']}" for node in valid_nodes if node.get("protocol") != "dokodemo-door")
    # Surge cancels TUIC streams when sing-box sniffs them; DNS hijacking remains enabled.
    sniff_inbounds = sorted(f"in-{node['id']}" for node in valid_nodes if node.get("protocol") not in {"dokodemo-door", "TUIC"})
    dns_config, dns_prefix_rules, dns_fallback_rules = build_egress_dns_policy(
        proxy_inbounds,
        dns_policy_mode,
        outbound_tag=dns_outbound_tag,
        dns_rule_tags=dns_rule_tags,
        dns_direct_rule_tags=dns_direct_rule_tags,
        custom_domains=custom_proxy_domains,
        strategy=dns_strategy,
        detoured_dns=landing_dns_detours,
        sniff_inbounds=sniff_inbounds,
    )
    singbox_config["dns"] = dns_config
    singbox_config["route"]["default_domain_resolver"] = "local-dns"
    singbox_config["route"]["rules"] = dns_prefix_rules + singbox_config["route"]["rules"] + dns_fallback_rules + dns_final_rules

    for inbound in singbox_config["inbounds"]:
        node = next((item for item in valid_nodes if f"in-{item['id']}" == inbound.get("tag")), None)
        if node:
            transports = node_transports(node)
        elif inbound.get("type") in {"hysteria2", "tuic"}:
            transports = ["udp"]
        else:
            inbound_network = inbound.get("network")
            if inbound_network is None or inbound_network == "tcp,udp" or inbound_network == ["tcp", "udp"]:
                transports = ["tcp", "udp"]
            elif isinstance(inbound_network, list):
                transports = inbound_network
            else:
                transports = [inbound_network]
        tune_inbound(inbound, transports)

    for node in valid_nodes:
        for node_transport in node_transports(node):
            ensure_firewall_open(node["port"], node_transport)
    os.makedirs(os.path.dirname(SINGBOX_CONF_PATH), exist_ok=True)
    new_config_str = json.dumps(singbox_config, indent=2)
    old_config_str = ""
    if os.path.exists(SINGBOX_CONF_PATH):
        with open(SINGBOX_CONF_PATH, "r") as f: old_config_str = f.read()
        os.chmod(SINGBOX_CONF_PATH, 0o600)

    if new_config_str != old_config_str:
        temp_config = SINGBOX_CONF_PATH + ".tmp"
        with open(temp_config, "w") as f: f.write(new_config_str)
        os.chmod(temp_config, 0o600)
        sing_box = shutil.which("sing-box")
        if not sing_box:
            os.remove(temp_config)
            raise RuntimeError("sing-box binary not found")
        checked = subprocess.run([sing_box, "check", "-c", temp_config], capture_output=True, text=True, timeout=30)
        if checked.returncode != 0:
            os.remove(temp_config)
            raise RuntimeError(f"sing-box config rejected: {checked.stderr.strip()[-500:]}")
        backup_config = SINGBOX_CONF_PATH + ".last-good"
        if old_config_str:
            with open(backup_config + ".tmp", "w") as backup: backup.write(old_config_str)
            os.chmod(backup_config + ".tmp", 0o600)
            os.replace(backup_config + ".tmp", backup_config)
        os.replace(temp_config, SINGBOX_CONF_PATH)
        if os.path.exists("/sbin/openrc-run") or os.path.exists("/etc/alpine-release"):
            restarted = subprocess.run(["rc-service", "sing-box", "restart"], capture_output=True, text=True, timeout=30)
            healthy = restarted.returncode == 0 and subprocess.run(["rc-service", "sing-box", "status"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15).returncode == 0
        else:
            restarted = subprocess.run(["systemctl", "restart", "sing-box"], capture_output=True, text=True, timeout=30)
            healthy = restarted.returncode == 0 and subprocess.run(["systemctl", "is-active", "--quiet", "sing-box"], timeout=15).returncode == 0
        if not healthy:
            rollback_healthy = False
            if old_config_str:
                with open(SINGBOX_CONF_PATH + ".rollback", "w") as rollback: rollback.write(old_config_str)
                os.chmod(SINGBOX_CONF_PATH + ".rollback", 0o600)
                os.replace(SINGBOX_CONF_PATH + ".rollback", SINGBOX_CONF_PATH)
                if os.path.exists("/etc/alpine-release"): subprocess.run(["rc-service", "sing-box", "restart"], timeout=30)
                else: subprocess.run(["systemctl", "restart", "sing-box"], timeout=30)
                rollback_healthy = _singbox_service_healthy()
            raise RuntimeError(f"sing-box restart failed; rollback_healthy={str(rollback_healthy).lower()}")
    elif os.path.exists("/sbin/openrc-run") or os.path.exists("/etc/alpine-release"):
        subprocess.run(["rc-service", "sing-box", "start"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        if not _singbox_service_healthy(): raise RuntimeError("sing-box is not healthy after start")
    else:
        subprocess.run(["systemctl", "start", "sing-box"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        if not _singbox_service_healthy(): raise RuntimeError("sing-box is not healthy after start")
    try:
        if socks5_outbound and socks5_outbound.get("source") == "residential": verified_egress_ip = _verify_socks5_exit(egress_check_host, require_distinct_exit=True)
        elif socks5_outbound and socks5_outbound.get("source") == "manual": verified_egress_ip = _verify_socks5_exit(egress_check_host)
        elif warp_mode != "off": verified_egress_ip = _verify_warp_exit(warp_mode, egress_check_host)
        else: verified_egress_ip = _verify_native_exit()
    except Exception as verification_error:
        rollback_healthy = new_config_str == old_config_str or _restore_singbox_config(old_config_str)
        raise RuntimeError(f"{verification_error}; previous_config_restored={str(rollback_healthy).lower()}") from verification_error
    for filename in os.listdir("/opt/kui/"):
        if (filename.startswith("cert_") or filename.startswith("key_")) and (filename.endswith(".pem") or filename.endswith(".sni")) and filename not in active_certs:
            try: os.remove(os.path.join("/opt/kui/", filename))
            except OSError: pass
    return verified_egress_ip

def report_status(current_nodes, argo_urls, force_http=False, allow_http=True):
    global last_reported_bytes, last_reported_system_bytes, global_interval, fast_mode, dynamic_ping, pending_report_id, pending_report_bytes, pending_node_traffic, pending_system_bytes, pending_report_payload, last_http_report
    status = get_system_status(global_interval)
    status["ip"] = VPS_IP
    status["argo_urls"] = argo_urls
    status["warp"] = _public_warp_optimizer_state()
    
    deltas = []
    pending_bytes = dict(last_reported_bytes)
    current_ids = set()
    for node in current_nodes:
        nid, port = node["id"], node["port"]
        current_ids.add(nid)
        proto = "both" if node.get("protocol") == "Shadowsocks2022" and node.get("network", "tcp,udp") == "tcp,udp" else (node.get("network") if node.get("protocol") == "Shadowsocks2022" else ("udp" if node["protocol"] in ["Hysteria2", "TUIC"] else "tcp"))
        current_bytes = get_port_traffic(port, proto, nid)
        if current_bytes is None:
            continue
        baseline = pending_bytes.get(nid, current_bytes)
        delta = current_bytes - baseline if current_bytes >= baseline else current_bytes
        if delta > 0: deltas.append({ "id": nid, "delta_bytes": delta })
        pending_bytes[nid] = current_bytes

    if not pending_report_id:
        pending_report_id = f"{VPS_IP}:{time.time_ns()}"
    # Keep accumulating against the last successful HTTP baseline. WebSocket
    # updates are display-only and must not advance billable traffic counters.
    if pending_report_payload is None:
        pending_report_bytes = {k: v for k, v in pending_bytes.items() if k in current_ids}
        pending_node_traffic = deltas
        current_system_bytes = max(0, int(status.get("net_rx") or 0)) + max(0, int(status.get("net_tx") or 0))
        if last_reported_system_bytes is None:
            system_traffic_delta = 0
            # Zero may mean the default-route lookup failed. Wait for a real
            # counter before establishing the initial baseline.
            pending_system_bytes = current_system_bytes if current_system_bytes > 0 else None
        elif current_system_bytes == 0 and last_reported_system_bytes > 0:
            # A transient default-route lookup failure returns zero. Keep the
            # acknowledged baseline so the next healthy sample cannot double count.
            system_traffic_delta = 0
            pending_system_bytes = last_reported_system_bytes
        else:
            system_traffic_delta = current_system_bytes - last_reported_system_bytes if current_system_bytes >= last_reported_system_bytes else current_system_bytes
            pending_system_bytes = current_system_bytes
    else:
        system_traffic_delta = max(0, int(pending_report_payload.get("system_traffic_delta") or 0))
    status["node_traffic"] = pending_node_traffic
    status["system_traffic_delta"] = system_traffic_delta
    status["report_id"] = pending_report_id
    _write_json_state(TRAFFIC_STATE_PATH, {"last_reported_bytes": last_reported_bytes, "last_reported_system_bytes": last_reported_system_bytes, "pending": {"report_id": pending_report_id, "report_bytes": pending_report_bytes, "node_traffic": pending_node_traffic, "system_bytes": pending_system_bytes, "payload": pending_report_payload}})

    websocket_sent = realtime_channel.send(status) if realtime_channel and realtime_channel.connected else False
    if websocket_sent and not force_http and time.time() - last_http_report < REALTIME_HTTP_INTERVAL:
        return True
    if realtime_channel and realtime_channel.enabled and not websocket_sent and time.time() - realtime_channel.last_disconnected < 30:
        return False
    if not websocket_sent and not allow_http:
        return False

    try: 
        if pending_report_payload is None:
            pending_report_payload = dict(status)
            pending_report_payload["node_traffic"] = list(pending_node_traffic or [])
            _write_json_state(TRAFFIC_STATE_PATH, {"last_reported_bytes": last_reported_bytes, "last_reported_system_bytes": last_reported_system_bytes, "pending": {"report_id": pending_report_id, "report_bytes": pending_report_bytes, "node_traffic": pending_node_traffic, "system_bytes": pending_system_bytes, "payload": pending_report_payload}})
        req = urllib.request.Request(REPORT_URL, data=json.dumps(pending_report_payload).encode(), headers=HEADERS)
        with _urlopen(req, timeout=20) as response:
            resp_data = json.loads(response.read().decode('utf-8'))
        last_reported_bytes = pending_report_bytes
        if pending_system_bytes is not None:
            last_reported_system_bytes = pending_system_bytes
        pending_report_id = None
        pending_report_bytes = None
        pending_node_traffic = None
        pending_system_bytes = None
        pending_report_payload = None
        last_http_report = time.time()
        _write_json_state(TRAFFIC_STATE_PATH, {"last_reported_bytes": last_reported_bytes, "last_reported_system_bytes": last_reported_system_bytes, "pending": None})
        if resp_data and "interval" in resp_data:
            global_interval = min(max(1, int(resp_data["interval"])), 3600)
        new_fast_mode = bool(resp_data.get("fast_mode"))
        if new_fast_mode and not fast_mode:
            config_wakeup.set()
        fast_mode = new_fast_mode
        for key in ("ct", "cu", "cm"):
            value = resp_data.get(f"ping_{key}")
            dynamic_ping[key] = None if not value or value == "default" else value
        return True
    except Exception as error:
        print(f"[agent] status report failed: {error}", flush=True)
        return False

def fetch_proxy_config():
    try:
        req = urllib.request.Request(f"{PROXY_API}/api/proxy/config?ip={VPS_IP}", headers=_proxy_ctrl_headers())
        with _urlopen(req, timeout=10) as response:
            return json.loads(response.read().decode('utf-8'))
    except Exception as error:
        print(f"[agent] proxy config fetch failed: {error}", flush=True)
        return None

def _extract_mesh(proxy_cfg):
    # 解析 mesh 配置：优先 per-VPS toggle.mesh，其次全局 global.mesh，再退回扁平 mesh
    if not isinstance(proxy_cfg, dict):
        return {}
    toggle = proxy_cfg.get("toggle")
    if isinstance(toggle, dict) and isinstance(toggle.get("mesh"), dict):
        return toggle["mesh"]
    g = proxy_cfg.get("global")
    if isinstance(g, dict) and isinstance(g.get("mesh"), dict):
        return g["mesh"]
    m = proxy_cfg.get("mesh")
    if isinstance(m, dict):
        return m
    return {}

def fetch_proxy_mesh(country="ANY"):
    # 拉取可供本机链式转发的对端 SOCKS5 出口（mesh 互联）
    # 外部控制器对等节点列表：优先走 /api/proxies（返回 socks5:// 纯文本），本地按国家过滤
    try:
        c = (country or "ANY").upper()
        proxy_path = "/api/proxy/proxies" if PROXY_API.rstrip('/') == BASE_URL.rstrip('/') else "/api/proxies"
        url = f"{PROXY_API}{proxy_path}?ip={VPS_IP}"
        req = urllib.request.Request(url, headers=_proxy_ctrl_headers())
        with _urlopen(req, timeout=10) as response:
            raw = response.read().decode('utf-8')
        peers = []
        for line in raw.splitlines():
            line = line.strip()
            if not line or not line.startswith('socks5://'):
                continue
            try:
                parsed = urllib.parse.urlparse(line)
                peer_country = ''
                if parsed.fragment:
                    peer_country = parsed.fragment.split('_')[0].upper()
                if c and c != "ANY" and peer_country and peer_country != c:
                    continue
                host = parsed.hostname or ''
                port = parsed.port or PROXY_PORT
                user = parsed.username or PROXY_USER
                pwd = parsed.password or PROXY_PASS
                if host:
                    peers.append({"ip": host, "socks_ip": host, "port": port, "user": user, "pass": pwd, "country": peer_country})
            except Exception:
                continue
        return peers
    except Exception as error:
        print(f"[agent] proxy mesh fetch failed: {error}", flush=True)
        return []

def report_proxy_status():
    try:
        pc = current_proxy_config
        def _g(key, default):
            if isinstance(pc, dict):
                if key in pc: return pc[key]
                g = pc.get("global")
                if isinstance(g, dict) and key in g: return g[key]
            return default
        enabled = _g("enabled", True)
        port = int(_g("port", PROXY_PORT))
        user = _g("user", PROXY_USER)
        pwd = _g("pass", PROXY_PASS)
        country = _g("country", "")
        payload = {
            "ip": VPS_IP,
            "socks_ip": VPS_IP,
            "port": int(port),
            "user": str(user),
            "pass": str(pwd),
            "country": str(country),
            "enabled": bool(enabled),
            "last_seen": int(time.time())
        }
        req = urllib.request.Request(f"{PROXY_API}/api/proxy/report", data=json.dumps(payload).encode(), headers=_proxy_ctrl_headers())
        with _urlopen(req, timeout=10) as response:
            response.read(1)
    except Exception as error:
        print(f"[agent] proxy status report failed: {error}", flush=True)

def fetch_and_apply_configs():
    global REALTIME_URL, realtime_channel
    try:
        data = _controller_json_request(f"{API_URL}?ip={VPS_IP}")
        if data.get("success"):
            persist_agent_token(data.get("agent_token"))
            new_realtime_url = data.get("realtime_url") or ""
            if new_realtime_url: new_realtime_url = _require_https_url(new_realtime_url, "realtime_url")
            if new_realtime_url and new_realtime_url != REALTIME_URL:
                REALTIME_URL = new_realtime_url
                env["realtime_url"] = new_realtime_url
                try:
                    temp_config = CONF_FILE + ".tmp"
                    with open(temp_config, "w", encoding="utf-8") as config_file: json.dump(env, config_file)
                    os.chmod(temp_config, 0o600); os.replace(temp_config, CONF_FILE)
                except Exception: pass
                if realtime_channel: realtime_channel.stop()
                realtime_channel = create_realtime_channel()
                realtime_channel.start()
            nodes = data.get("configs", [])
            global current_proxy_config
            current_proxy_config = data.get("proxy") if isinstance(data.get("proxy"), dict) else {}
            mesh = _extract_mesh(current_proxy_config)
            peers = []
            if mesh.get("enabled"):
                peers = fetch_proxy_mesh(mesh.get("country", "ANY"))
                exit_ip = mesh.get("exit")
                if exit_ip and exit_ip != "ANY":
                    peers = [p for p in peers if p.get("country") == exit_ip or p.get("socks_ip") == exit_ip or p.get("ip") == exit_ip]
            egress = data.get("egress", {})
            legacy_desired = {"mode": egress.get("desired_mode", "native"), "proxy_mode": egress.get("proxy_mode", "global"), "proxy_categories": egress.get("proxy_categories", "")}
            if legacy_desired["mode"] == "socks5":
                legacy_desired["socks5"] = {"addr": egress.get("socks5_addr", ""), "port": int(egress.get("socks5_port", 0)), "user": egress.get("socks5_user", ""), "pass": egress.get("socks5_pass", "")}
            desired_config = _normalize_egress_config(egress.get("desired_config"), legacy_desired["mode"], legacy_desired)
            desired_egress = desired_config["mode"]
            revision = int(egress.get("revision", 0))
            deployment_id = str(data.get("deployment_id") or "")
            local_state = _load_egress_state()
            local_deployment_id = str(local_state.get("deployment_id") or "")
            deployment_changed = bool(deployment_id and local_deployment_id != deployment_id)
            if deployment_changed:
                if local_deployment_id:
                    print(f"[agent] deployment changed ({local_deployment_id} -> {deployment_id}); resetting local egress revision", flush=True)
                else:
                    print("[agent] binding legacy egress state to current deployment; resetting local revision", flush=True)
                local_state = {"applied_mode": "native", "applied_revision": 0, "applied_config": {"mode": "native", "proxy_mode": "global", "proxy_categories": ""}, "pending_result": None, "deployment_id": deployment_id}
                _save_egress_state(local_state["applied_mode"], local_state["applied_revision"], deployment_id=deployment_id, applied_config=local_state["applied_config"])
            elif not deployment_id and local_state["applied_revision"] > revision and local_state["applied_mode"] != desired_egress:
                print("[agent] remote desired egress conflicts with a newer legacy local revision; trusting remote state", flush=True)
                local_state = {"applied_mode": "native", "applied_revision": 0, "applied_config": {"mode": "native", "proxy_mode": "global", "proxy_categories": ""}, "pending_result": None, "deployment_id": ""}
            if local_state.get("pending_result"):
                try:
                    ack = _deliver_egress_result(local_state["pending_result"])
                    if (local_state["pending_result"].get("success") is True and ack.get("accepted")) or revision != int(local_state["pending_result"].get("revision", -1)):
                        _save_egress_state(local_state["applied_mode"], local_state["applied_revision"], deployment_id=deployment_id, applied_config=local_state["applied_config"])
                except Exception:
                    pass
                retry_after = int(local_state["pending_result"].get("retry_after", 0))
                if local_state["pending_result"].get("success") is False and retry_after > time.time():
                    _schedule_egress_retry(retry_after - time.time())
            remote_applied_revision = int(egress.get("applied_revision", 0))
            remote_applied_mode = egress.get("applied_mode", "native")
            remote_applied_config = _normalize_egress_config(egress.get("applied_config"), remote_applied_mode, {"mode": remote_applied_mode, "proxy_mode": "global", "proxy_categories": ""})
            if local_state["applied_revision"] > remote_applied_revision:
                applied_revision = local_state["applied_revision"]
                applied_config = _normalize_egress_config(local_state.get("applied_config"), local_state["applied_mode"])
            else:
                applied_revision = remote_applied_revision
                applied_config = remote_applied_config
            applied_egress = applied_config["mode"]
            apply_egress_change = revision > applied_revision
            pending_failure = local_state.get("pending_result") or {}
            if apply_egress_change and pending_failure.get("success") is False and int(pending_failure.get("revision", -1)) == revision:
                retry_after = int(pending_failure.get("retry_after", 0))
                if time.time() < retry_after: apply_egress_change = False
            runtime_config = desired_config if apply_egress_change else applied_config
            runtime_egress = runtime_config["mode"]
            residential = data.get("residential_outbound", {})
            egress_check_host = normalize_check_host(residential.get("check_addr", "127.0.0.1")) if isinstance(residential, dict) else "127.0.0.1"
            runtime_socks, runtime_warp = _runtime_egress_args(runtime_config, residential, egress_check_host)
            config_hash = hashlib.sha256(json.dumps({"nodes": nodes, "egress": runtime_config}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            try:
                if runtime_egress == "residential" and not residential.get("available"):
                    reason = residential.get("reason") or "controller did not report a ready residential tunnel"
                    raise RuntimeError(f"residential proxy is unavailable: {reason}")
                prepare_mtproxy_nodes(nodes)
                try:
                    verified_egress_ip = build_singbox_config(nodes, current_proxy_config, peers, mesh, runtime_socks, runtime_warp, egress_check_host)
                except RuntimeError as verify_error:
                    if runtime_warp != "off" and str(verify_error).startswith("WARP ") and _refresh_warp_endpoint():
                        verified_egress_ip = build_singbox_config(nodes, current_proxy_config, peers, mesh, runtime_socks, runtime_warp, egress_check_host)
                    else:
                        raise
                sync_mtproxy_nodes(nodes)
                if runtime_warp != "off":
                    optimizer_health = _load_warp_optimizer_state()
                    if optimizer_health.get("consecutive_failures"):
                        optimizer_health["consecutive_failures"] = 0; _save_warp_optimizer_state(optimizer_health)
                if apply_egress_change:
                    result = {"success": True, "component": "egress", "revision": revision, "deployment_id": deployment_id, "desired_mode": desired_egress, "applied_mode": desired_egress, "rolled_back": False, "rollback_healthy": True, "applied_at": int(time.time() * 1000), "egress_ip": verified_egress_ip}
                    _save_egress_state(desired_egress, revision, result, deployment_id, desired_config)
                    try:
                        ack = _deliver_egress_result(result)
                        if ack.get("accepted"): _save_egress_state(desired_egress, revision, deployment_id=deployment_id, applied_config=desired_config)
                    except Exception: pass
                    optimizer = _load_warp_optimizer_state()
                    if desired_egress.startswith("warp_") and optimizer.get("policy") == "first_enable" and not optimizer.get("first_enable_attempted"):
                        optimizer["first_enable_attempted"] = True; _save_warp_optimizer_state(optimizer)
                        _start_warp_endpoint_scan(auto_apply=False)
                elif realtime_channel and realtime_channel.connected:
                    realtime_channel.send({"success": True, "component": "config", "config_hash": config_hash, "old_config_active": False, "rollback_healthy": True, "applied_at": int(time.time() * 1000)}, "config.result")
            except EgressPreparing as preparing:
                _schedule_egress_retry(5)
                progress = {"success": False, "status": "preparing", "component": "egress", "revision": revision, "deployment_id": deployment_id, "desired_mode": desired_egress, "applied_mode": applied_egress, "message": str(preparing)[:500], "applied_at": int(time.time() * 1000)}
                try: _deliver_egress_result(progress)
                except Exception: pass
                print(f"[agent] {preparing}", flush=True)
                return nodes
            except Exception as error:
                if apply_egress_change:
                    rollback_healthy = False
                    try:
                        rollback_config = _normalize_egress_config(applied_config, applied_egress)
                        rollback_socks, rollback_warp = _runtime_egress_args(rollback_config, residential, egress_check_host)
                        build_singbox_config(nodes, current_proxy_config, peers, mesh, rollback_socks, rollback_warp, egress_check_host)
                        rollback_healthy = _singbox_service_healthy()
                    except Exception:
                        rollback_healthy = _restore_last_good_singbox()
                    retries = int(pending_failure.get("retries", 0)) + 1
                    retry_delay = min(300, 30 * (2 ** min(retries - 1, 4)))
                    result = {"success": False, "component": "egress", "revision": revision, "deployment_id": deployment_id, "desired_mode": desired_egress, "applied_mode": applied_egress, "rolled_back": rollback_healthy, "rollback_healthy": rollback_healthy, "error": str(error)[:500], "retries": retries, "retry_after": int(time.time() + retry_delay), "applied_at": int(time.time() * 1000)}
                    _save_egress_state(applied_egress, applied_revision, result, deployment_id, applied_config)
                    _schedule_egress_retry(retry_delay)
                    try:
                        ack = _deliver_egress_result(result)
                        if not ack.get("accepted"): pass
                    except Exception: pass
                elif realtime_channel and realtime_channel.connected:
                    realtime_channel.send({"success": False, "component": "config", "config_hash": config_hash, "error": str(error)[:500], "old_config_active": _singbox_service_healthy(), "rollback_healthy": _singbox_service_healthy(), "applied_at": int(time.time() * 1000)}, "config.result")
                if runtime_warp != "off":
                    optimizer_health = _load_warp_optimizer_state()
                    optimizer_health["consecutive_failures"] = int(optimizer_health.get("consecutive_failures", 0)) + 1
                    _save_warp_optimizer_state(optimizer_health)
                    if optimizer_health.get("policy") == "on_failure" and optimizer_health["consecutive_failures"] >= 2:
                        _start_warp_endpoint_scan(auto_apply=True)
                raise
            return nodes
    except Exception as error:
        print(f"[agent] config fetch/apply failed: {error}", flush=True)
    return None

if __name__ == "__main__":
    heartbeat_state = {"nodes": [], "argo_urls": []}

    def on_realtime_message(message):
        global realtime_status_interval
        if message.get("type") == "status.interval":
            requested_interval = int(message.get("seconds", REALTIME_STATUS_IDLE_INTERVAL))
            realtime_status_interval = max(REALTIME_STATUS_ACTIVE_INTERVAL, min(REALTIME_STATUS_IDLE_INTERVAL, requested_interval))
            heartbeat_wakeup.set()
        if message.get("type") in {"config.refresh", "transport.connected", "transport.disconnected"}: config_wakeup.set()
        if message.get("type") in {"transport.connected", "transport.disconnected"}: heartbeat_wakeup.set()
        if message.get("type") == "config.result.ack" and message.get("accepted") is True and message.get("success") is True:
            state = _load_egress_state()
            pending = state.get("pending_result") or {}
            if int(pending.get("revision", -1)) == int(message.get("revision", -2)):
                _save_egress_state(state["applied_mode"], state["applied_revision"], deployment_id=state.get("deployment_id", ""), applied_config=state.get("applied_config"))
        if message.get("type") == "egress.refresh":
            request_id = str(message.get("request_id", ""))[:64]
            expected_mode = str(message.get("expected_mode", ""))[:32]
            expected_revision = message.get("expected_revision")
            def probe():
                if not egress_probe_lock.acquire(blocking=False):
                    realtime_channel.send({"success": False, "request_id": request_id, "error": "出口检测正在进行中", "measured_at": int(time.time() * 1000)}, "egress.probe.result")
                    return
                try:
                    mode, revision, egress_ip = _verify_current_egress_exit(expected_mode, expected_revision)
                    realtime_channel.send({"success": True, "request_id": request_id, "applied_mode": mode, "applied_revision": revision, "egress_ip": egress_ip, "measured_at": int(time.time() * 1000)}, "egress.probe.result")
                except Exception as error:
                    realtime_channel.send({"success": False, "request_id": request_id, "error": str(error)[:500], "measured_at": int(time.time() * 1000)}, "egress.probe.result")
                finally:
                    egress_probe_lock.release()
            threading.Thread(target=probe, name="kui-egress-probe", daemon=True).start()
        if message.get("type") == "warp.optimize":
            request_id = str(message.get("request_id", ""))[:64]
            action = str(message.get("action", ""))
            try:
                if action == "scan":
                    if not _start_warp_endpoint_scan(request_id): raise RuntimeError("WARP 端点检测正在进行中或处于冷却期")
                elif action == "apply":
                    threading.Thread(target=_apply_warp_endpoint, args=(message.get("address", ""), message.get("port", 0), request_id), name="kui-warp-apply", daemon=True).start()
                elif action == "restore":
                    previous = _load_warp_optimizer_state().get("previous") or {}
                    if not previous: raise RuntimeError("没有可恢复的 WARP 端点")
                    threading.Thread(target=_apply_warp_endpoint, args=(previous.get("address", ""), previous.get("port", 0), request_id, True), name="kui-warp-restore", daemon=True).start()
                elif action == "cancel":
                    _warp_optimizer_cancel.set()
                    state = _load_warp_optimizer_state()
                    if state.get("status") != "scanning":
                        state.update({"status": "idle", "stage": "", "progress": 0, "candidates": [], "recommended": None, "error": ""}); _save_warp_optimizer_state(state); _emit_warp_optimizer_state(request_id=request_id)
                elif action == "policy":
                    state = _load_warp_optimizer_state(); policy = _normalize_warp_optimizer_policy(message.get("policy"))
                    if policy == "first_enable" and state.get("policy") != policy: state["first_enable_attempted"] = False
                    state["policy"] = policy
                    should_scan = policy == "first_enable" and _load_egress_state().get("applied_mode", "native").startswith("warp_") and not state.get("first_enable_attempted")
                    if should_scan: state["first_enable_attempted"] = True
                    _save_warp_optimizer_state(state); _emit_warp_optimizer_state(request_id=request_id)
                    if should_scan: _start_warp_endpoint_scan(request_id, auto_apply=False)
                else: raise ValueError("不支持的 WARP 优化操作")
            except Exception as error:
                if realtime_channel and realtime_channel.connected:
                    realtime_channel.send({"request_id": request_id, "error": str(error)[:500], **_public_warp_optimizer_state()}, "warp.optimize.result")

    def create_realtime_channel():
        return RealtimeChannel(REALTIME_URL, VPS_IP, TOKEN, "core", on_realtime_message)

    realtime_channel = create_realtime_channel()
    realtime_channel.start()

    def heartbeat_loop():
        while True:
            started = time.monotonic()
            try:
                websocket_online = bool(realtime_channel and realtime_channel.connected)
                fallback_ready = not realtime_channel or not realtime_channel.enabled or time.time() - (realtime_channel.last_disconnected or realtime_channel.started_at) >= 30
                report_status(list(heartbeat_state["nodes"]), list(heartbeat_state["argo_urls"]), force_http=not websocket_online, allow_http=websocket_online or fallback_ready)
            except Exception as error:
                print(f"[agent] heartbeat loop error: {error}", flush=True)
            elapsed = time.monotonic() - started
            if realtime_channel and realtime_channel.connected:
                heartbeat_interval = realtime_status_interval
            elif realtime_channel and realtime_channel.enabled and not realtime_channel.ever_connected and time.time() - realtime_channel.started_at < 30:
                heartbeat_interval = max(1, 30 - (time.time() - realtime_channel.started_at))
            elif realtime_channel and realtime_channel.ever_connected and time.time() - realtime_channel.last_disconnected < 30:
                heartbeat_interval = max(1, 30 - (time.time() - realtime_channel.last_disconnected))
            else:
                heartbeat_interval = min(max(90, global_interval), 300)
            heartbeat_wakeup.wait(timeout=max(1, heartbeat_interval - min(heartbeat_interval - 1, elapsed)))
            heartbeat_wakeup.clear()

    time.sleep(2)
    initial_nodes = fetch_and_apply_configs()
    if os.path.exists("/opt/kui/.update-pending"):
        if initial_nodes is None or not _singbox_service_healthy() or not report_status(list(initial_nodes), [], force_http=True):
            print("[agent] updated version failed readiness checks", flush=True)
            raise SystemExit(1)
        try: os.remove("/opt/kui/.update-pending")
        except FileNotFoundError: pass
    if initial_nodes is not None: heartbeat_state["nodes"] = initial_nodes
    threading.Thread(target=heartbeat_loop, name="kui-heartbeat", daemon=True).start()
    while True:
        config_wakeup.clear()
        while realtime_channel and realtime_channel.enabled and not realtime_channel.connected:
            grace_remaining = 30 - (time.time() - (realtime_channel.last_disconnected or realtime_channel.started_at))
            if grace_remaining <= 0:
                break
            config_wakeup.wait(timeout=grace_remaining)
            config_wakeup.clear()
        loop_started = time.monotonic()
        try:
            check_for_update()
            fetched_nodes = fetch_and_apply_configs()
            if fetched_nodes is not None: heartbeat_state["nodes"] = fetched_nodes
            heartbeat_state["argo_urls"] = process_argo_nodes(heartbeat_state["nodes"])
        except Exception as error:
            print(f"[agent] main loop error: {error}", flush=True)
        elapsed = time.monotonic() - loop_started
        if elapsed > 20:
            print(f"[agent] slow loop completed in {elapsed:.1f}s", flush=True)
        config_interval = REALTIME_HTTP_INTERVAL if realtime_channel and realtime_channel.connected else (30 if fast_mode else 300)
        config_wakeup.wait(timeout=max(1, config_interval - min(config_interval - 1, elapsed)))
