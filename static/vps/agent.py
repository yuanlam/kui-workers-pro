# -*- coding: utf-8 -*-
import urllib.request
import urllib.parse
import http.client
import errno
import json
import secrets
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
import struct
from routing_engine import build_routing_policy, normalize_egress_config, prepare_rule_sets
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
EGRESS_STATE_PATH = "/opt/kui/egress-state.json"
TRAFFIC_STATE_PATH = "/opt/kui/traffic-state.json"
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

def _load_egress_state():
    try:
        with open(EGRESS_STATE_PATH, "r", encoding="utf-8") as state_file:
            state = json.load(state_file)
        mode = state.get("applied_mode", "native")
        if mode not in {"native", "residential"}: mode = "native"
        applied_config = state.get("applied_config") if isinstance(state.get("applied_config"), dict) else {"mode": mode, "proxy_mode": "global", "proxy_categories": ""}
        applied_config["mode"] = mode
        return {"applied_mode": mode, "applied_revision": int(state.get("applied_revision", 0)), "applied_config": applied_config, "pending_result": state.get("pending_result"), "deployment_id": str(state.get("deployment_id", ""))}
    except Exception:
        return {"applied_mode": "native", "applied_revision": 0, "applied_config": {"mode": "native", "proxy_mode": "global", "proxy_categories": ""}, "pending_result": None, "deployment_id": ""}

egress_state_lock = threading.RLock()

def _save_egress_state(mode, revision, pending_result=None, deployment_id="", applied_config=None):
    config = dict(applied_config) if isinstance(applied_config, dict) else {"mode": mode, "proxy_mode": "global", "proxy_categories": ""}
    config["mode"] = mode
    with egress_state_lock:
        _write_json_state(EGRESS_STATE_PATH, {"applied_mode": mode, "applied_revision": int(revision), "applied_config": config, "pending_result": pending_result, "deployment_id": str(deployment_id or "")})

def _singbox_service_healthy():
    if os.path.exists("/etc/alpine-release"):
        return subprocess.run(["rc-service", "sing-box", "status"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15).returncode == 0
    return subprocess.run(["systemctl", "is-active", "--quiet", "sing-box"], timeout=15).returncode == 0

def _restart_singbox():
    command = ["rc-service", "sing-box", "restart"] if os.path.exists("/etc/alpine-release") else ["systemctl", "restart", "sing-box"]
    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    return result.returncode == 0 and _singbox_service_healthy()

def _write_private_text(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(path, 0o600)

def _config_has_residential_loop(config_text):
    if not config_text:
        return False
    try:
        config = json.loads(config_text)
        res_ports = {
            int(inbound.get("listen_port") or 0)
            for inbound in config.get("inbounds", [])
            if isinstance(inbound, dict) and inbound.get("type") == "socks" and inbound.get("tag") == "residential-socks5"
        }
        if not res_ports:
            return False
        for outbound in config.get("outbounds", []):
            if not isinstance(outbound, dict) or outbound.get("type") != "socks" or outbound.get("tag") != "socks5-outbound":
                continue
            host = str(outbound.get("server") or "").strip().lower()
            port = int(outbound.get("server_port") or 0)
            if host in {"127.0.0.1", "::1", "localhost"} and port in res_ports:
                return True
    except (ValueError, TypeError, AttributeError):
        pass
    return False

def _strip_stale_residential_inbound(proxy_lite_installed):
    if not proxy_lite_installed or not os.path.exists(SINGBOX_CONF_PATH):
        return False
    temp_path = SINGBOX_CONF_PATH + ".strip-res"
    pending_path = SINGBOX_CONF_PATH + ".strip-res-pending"
    try:
        with open(SINGBOX_CONF_PATH, "r", encoding="utf-8") as source:
            current_text = source.read()
        cleaned_text = _safe_residential_rollback(current_text, True)
        if cleaned_text == current_text:
            if os.path.exists(pending_path):
                if _restart_singbox():
                    try: os.remove(pending_path)
                    except OSError: pass
                    print("[agent] retried sing-box restart after stripping stale residential-socks5 inbound", flush=True)
                    return True
                print("[agent] retry restart sing-box failed after stripping stale residential inbound", flush=True)
            return False
        _write_private_text(temp_path, cleaned_text)
        checked = subprocess.run(["sing-box", "check", "-c", temp_path], capture_output=True, text=True, timeout=15)
        if checked.returncode != 0:
            os.remove(temp_path)
            return False
        _write_private_text(pending_path, "1")
        os.replace(temp_path, SINGBOX_CONF_PATH)
        if not _restart_singbox():
            print("[agent] failed to restart sing-box after stripping stale residential inbound; will retry", flush=True)
            return False
        try: os.remove(pending_path)
        except OSError: pass
        print("[agent] stripped stale residential-socks5 inbound before residential availability check", flush=True)
        return True
    except Exception as error:
        print(f"[agent] failed to strip stale residential inbound: {error}", flush=True)
        if os.path.exists(temp_path):
            try: os.remove(temp_path)
            except OSError: pass
        return False

def _restore_singbox_config(config_text, proxy_lite_installed=None):
    if not config_text:
        return False
    try:
        should_strip = proxy_lite_installed if proxy_lite_installed is not None else (
            os.path.exists("/etc/proxy-lite/env") or _config_has_residential_loop(config_text)
        )
        config_text = _safe_residential_rollback(config_text, should_strip)
        restore_path = SINGBOX_CONF_PATH + ".restore"
        _write_private_text(restore_path, config_text)
        os.replace(restore_path, SINGBOX_CONF_PATH)
        if os.path.exists("/etc/alpine-release"):
            restarted = subprocess.run(["rc-service", "sing-box", "restart"], capture_output=True, text=True, timeout=30)
        else:
            restarted = subprocess.run(["systemctl", "restart", "sing-box"], capture_output=True, text=True, timeout=30)
        return restarted.returncode == 0 and _singbox_service_healthy()
    except Exception as error:
        print(f"[agent] failed to restore previous sing-box config: {error}", flush=True)
        return False


def _rollback_singbox_apply(previous, replaced):
    """Restore the previous deployment, or stop a failed first deployment."""
    if not replaced:
        if previous is not None:
            try:
                return bool(_singbox_service_healthy())
            except Exception:
                return False
        return False
    if previous is not None:
        return bool(_restore_singbox_config(previous))
    try:
        command = ["rc-service", "sing-box", "stop"] if os.path.exists("/etc/alpine-release") else ["systemctl", "stop", "sing-box"]
        stopped = subprocess.run(command, capture_output=True, timeout=30)
        healthy = False
        try:
            healthy = bool(_singbox_service_healthy())
        except Exception:
            healthy = False
        if stopped.returncode != 0 or healthy:
            print("[agent] failed to stop sing-box after unsuccessful initial deployment", flush=True)
    except (OSError, subprocess.TimeoutExpired) as error:
        print(f"[agent] failed to stop sing-box after unsuccessful initial deployment: {error}", flush=True)
    finally:
        try:
            os.remove(SINGBOX_CONF_PATH)
        except OSError:
            pass
    return False


def normalize_check_host(value):
    """Keep the local egress-check listener on loopback unless given IPv4."""
    try:
        parsed = ipaddress.ip_address(str(value or "").strip())
        if parsed.version == 4 and (parsed.is_loopback or any(parsed in ipaddress.ip_network(block) for block in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))):
            return str(parsed)
    except ValueError:
        pass
    return "127.0.0.1"

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

def _verify_native_exit(ip_stack="dual"):
    try:
        if ip_stack == "ipv6_only":
            raise ValueError("IPv6 requires a direct family probe")
        echo_url = f"{BASE_URL}/api/agent_egress_ip?ip={urllib.parse.quote(VPS_IP, safe='')}"
        request = urllib.request.Request(echo_url, headers=HEADERS)
        with _urlopen(request, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
        ip = _verified_public_ip(str(payload.get("ip") or ""))
        if ip:
            return ip
    except Exception as error:
        print(f"[agent] Worker native egress probe failed, trying fallback: {error}", flush=True)
    family = "-6" if ip_stack == "ipv6_only" else "-4"
    url = "https://api6.ipify.org" if family == "-6" else "https://api.ipify.org"
    result = subprocess.run(["curl", family, "-fsSL", "--connect-timeout", "5", "--max-time", "20", "--noproxy", "*", url], capture_output=True, text=True)
    ip = _verified_public_ip(result.stdout)
    if result.returncode != 0 or not ip:
        raise RuntimeError("native data-plane verification failed")
    return ip

def _doh_wire_query(name="example.com"):
    labels = name.rstrip(".").split(".")
    question = b"".join(bytes((len(label),)) + label.encode("ascii") for label in labels)
    return struct.pack(">HHHHHH", 0xABCD, 0x0100, 1, 0, 0, 0) + question + b"\0" + struct.pack(">HH", 1, 1)


def _valid_doh_response(payload):
    payload = bytes(payload) if isinstance(payload, bytearray) else payload
    if not isinstance(payload, bytes) or not 12 <= len(payload) <= 65535:
        return False
    identifier, flags, questions, answers, authority, additional = struct.unpack(">HHHHHH", payload[:12])
    if identifier != 0xABCD or not flags & 0x8000 or flags & 0x7800 or (flags & 0x000F) != 0 or flags & 0x0200 or questions != 1 or answers < 1:
        return False

    def skip_name(offset):
        while True:
            if offset >= len(payload):
                raise ValueError("truncated DNS name")
            length = payload[offset]
            if length & 0xC0 == 0xC0:
                if offset + 1 >= len(payload) or not 12 <= ((length & 0x3F) << 8 | payload[offset + 1]) < offset:
                    raise ValueError("invalid DNS compression pointer")
                return offset + 2
            if length & 0xC0:
                raise ValueError("invalid DNS label type")
            offset += 1
            if length == 0:
                return offset
            if length > 63 or offset + length > len(payload):
                raise ValueError("invalid DNS label")
            offset += length

    question = _doh_wire_query()[12:]
    if not payload.startswith(question, 12):
        return False
    offset = 12 + len(question)
    has_address = False
    try:
        for index in range(answers + authority + additional):
            offset = skip_name(offset)
            record_type, record_class, _, rdlength = struct.unpack_from(">HHIH", payload, offset)
            offset += 10 + rdlength
            if offset > len(payload):
                return False
            if index < answers and (record_type, record_class, rdlength) == (1, 1, 4):
                has_address = True
    except (ValueError, struct.error):
        return False
    return has_address and offset == len(payload)


def _probe_residential_doh(address, server_name):
    check_host = "127.0.0.1"
    try:
        result = subprocess.run([
            "curl", "-4", "-fsS", "--connect-timeout", "5", "--max-time", "12",
            "--noproxy", "", "--proxy", f"socks5h://{check_host}:39482",
            "--connect-to", f"{server_name}:443:{address}:443",
            "-H", "Accept: application/dns-message",
            f"https://{server_name}/dns-query?dns=" + base64.urlsafe_b64encode(_doh_wire_query()).decode().rstrip("="),
        ], capture_output=True, timeout=15)
        return result.returncode == 0 and _valid_doh_response(result.stdout)
    except (OSError, subprocess.TimeoutExpired):
        return False

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
    if mode == "native": return mode, revision, _verify_native_exit(state.get("applied_config", {}).get("ip_stack", "dual"))
    if mode == "residential": return mode, revision, _verify_socks5_exit(check_host, require_distinct_exit=True)
    raise RuntimeError(f"unsupported applied egress mode: {mode}")

def _post_egress_result(payload):
    parsed = urllib.parse.urlsplit(API_URL)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    return _controller_json_request(f"{origin}/api/egress_result", data=json.dumps({"ip": VPS_IP, **payload}).encode(), headers={**HEADERS, "Content-Type": "application/json"}, method="POST")

def _deliver_egress_result(payload):
    if realtime_channel and realtime_channel.connected and realtime_channel.send(payload, "config.result"):
        return {"accepted": False, "transport": "realtime"}
    return _post_egress_result(payload)

_normalize_egress_config = normalize_egress_config

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

def _parse_iptables_chain_bytes(output, direction):
    import ipaddress

    port_pattern = re.compile(rf'^{direction}:(\d+)$')

    def _is_ip_spec(token):
        raw = token[1:] if token.startswith("!") else token
        try:
            ipaddress.ip_network(raw, strict=False)
            return True
        except ValueError:
            return False

    totals = {}
    for line in str(output or "").splitlines():
        cleaned_line = re.sub(r'/\*.*?\*/', ' ', str(line))
        parts = cleaned_line.split()
        if len(parts) < 4 or parts[2] != "ACCEPT":
            continue
        try:
            bytes_val = int(parts[1])
        except (TypeError, ValueError):
            continue
        if bytes_val < 0:
            continue
        if (
            len(parts) >= 9
            and _is_ip_spec(parts[7])
            and _is_ip_spec(parts[8])
        ):
            ext_start = 9
        elif (
            len(parts) >= 8
            and _is_ip_spec(parts[6])
            and _is_ip_spec(parts[7])
        ):
            ext_start = 8
        else:
            continue
        ext_tokens = [token.lower() for token in parts[ext_start:]]
        protocol = parts[3].lower()
        if protocol in {"tcp", "6"}:
            normalized_protocol = "tcp"
        elif protocol in {"udp", "17"}:
            normalized_protocol = "udp"
        else:
            has_tcp = "tcp" in ext_tokens
            has_udp = "udp" in ext_tokens
            if has_tcp == has_udp:
                continue
            normalized_protocol = "tcp" if has_tcp else "udp"
        for index, token in enumerate(ext_tokens):
            port_match = port_pattern.match(token)
            if (
                not port_match
                or (index > 0 and ext_tokens[index - 1] == "!")
            ):
                continue
            port_num = int(port_match.group(1))
            if not (1 <= port_num <= 65535):
                continue
            key = (normalized_protocol, str(port_num))
            totals[key] = totals.get(key, 0) + bytes_val
            break
    return totals


def _collect_iptables_port_bytes_snapshot():
    class _IptablesPortSnapshot(dict):
        pass

    snapshot = _IptablesPortSnapshot()
    chain_status = {}
    for tool, chain, direction in (
        ("iptables", "INPUT", "dpt"),
        ("iptables", "OUTPUT", "spt"),
        ("ip6tables", "INPUT", "dpt"),
        ("ip6tables", "OUTPUT", "spt"),
    ):
        try:
            proc = subprocess.run(
                [tool, "-nvxL", chain],
                capture_output=True,
                text=True,
                timeout=3,
            )
        except FileNotFoundError:
            chain_status[(tool, chain)] = "unavailable"
            continue
        except Exception:
            chain_status[(tool, chain)] = "transient_failure"
            continue
        if getattr(proc, "returncode", 0) != 0:
            stderr = str(getattr(proc, "stderr", "") or "").lower()
            transient_markers = (
                "permission denied",
                "operation not permitted",
                "must be root",
                "xtables lock",
                "xtables.lock",
                "lock file",
                "resource temporarily unavailable",
                "another app is currently holding",
            )
            unavailable_markers = (
                "table does not exist",
                "protocol not supported",
                "address family not supported",
                "module is not loaded",
                "ip6tables: command not found",
            )
            if (
                tool == "ip6tables"
                and not any(marker in stderr for marker in transient_markers)
                and any(marker in stderr for marker in unavailable_markers)
            ):
                chain_status[(tool, chain)] = "unavailable"
            else:
                chain_status[(tool, chain)] = "transient_failure"
            continue
        chain_status[(tool, chain)] = "success"
        for key, value in _parse_iptables_chain_bytes(
            getattr(proc, "stdout", ""), direction
        ).items():
            snapshot[key] = snapshot.get(key, 0) + value
    iptables_healthy = all(
        chain_status.get(("iptables", chain)) == "success"
        for chain in ("INPUT", "OUTPUT")
    )
    ipv6_statuses = [
        chain_status.get(("ip6tables", chain)) for chain in ("INPUT", "OUTPUT")
    ]
    ipv6_healthy = (
        all(status == "success" for status in ipv6_statuses)
        or all(status == "unavailable" for status in ipv6_statuses)
    )
    snapshot.failed_chains = frozenset(
        key for key, status in chain_status.items() if status != "success"
    )
    snapshot.is_degraded = not (iptables_healthy and ipv6_healthy)
    return snapshot


def get_port_traffic(port, protocol="tcp", node_id=None, snapshot=None):
    # Official sing-box release binaries do not include the optional V2Ray
    # statistics API. Every managed node owns a unique port/transport pair,
    # so the persistent firewall counters are the reliable cumulative source.
    normalized_protocol = str(protocol or "tcp").lower()
    transports = ["tcp", "udp"] if normalized_protocol in {"both", "tcp,udp"} else [normalized_protocol]
    if snapshot is not None:
        totals = [snapshot.get((item, str(port))) for item in transports]
    else:
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

def build_node_inbounds(nodes, singbox_config):
    node_listen = node_listen_address(VPS_IP)
    active_certs = []
    valid_nodes = []
    listener_keys = set()
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
    return valid_nodes, active_certs


def _proxy_lite_owns_listener(proxy_port, residential):
    if os.path.exists("/etc/proxy-lite/env"):
        return True
    if not residential:
        return False
    managed = residential.get("available") is True or (residential.get("enabled") and residential.get("source") == "residential")
    return bool(managed and str(residential.get("port")) == str(proxy_port))


def _residential_listener(proxy_cfg, residential):
    if not isinstance(proxy_cfg, dict) or not proxy_cfg:
        return None
    options = proxy_cfg
    if "toggle" in options or "global" in options:
        defaults = options.get("global") or {}
        toggle = options.get("toggle") or {}
        if not isinstance(toggle, dict) or not isinstance(defaults, dict) or toggle.get("enable", toggle.get("enabled")) is not True or defaults.get("enabled") is False:
            return None
        options = {**defaults, **toggle}
    elif options.get("enabled", True) is not True:
        return None
    port = int(options.get("port", PROXY_PORT))
    if not 1 <= port <= 65535:
        raise ValueError("invalid residential listener port")
    if _proxy_lite_owns_listener(port, residential):
        return None
    user, password = options.get("user", PROXY_USER), options.get("pass", PROXY_PASS)
    if not user or not password:
        return None
    return {"type": "socks", "tag": "residential-socks5", "listen": node_listen_address(VPS_IP), "listen_port": port, "users": [{"username": str(user), "password": str(password)}]}

def _safe_residential_rollback(config_text, proxy_lite_installed):
    if not config_text or not proxy_lite_installed:
        return config_text
    try:
        config = json.loads(config_text)
        inbounds = config.get("inbounds", [])
        filtered = [inbound for inbound in inbounds if not (inbound.get("type") == "socks" and inbound.get("tag") == "residential-socks5")]
        if len(filtered) != len(inbounds):
            config["inbounds"] = filtered
            return json.dumps(config, indent=2)
    except (ValueError, TypeError, AttributeError):
        pass
    return config_text


def build_singbox_config(nodes, egress_config, *, residential=None, proxy_cfg=None, ruleset_dir="/opt/kui/rulesets", mirror_prefix="", proxy_inbounds=None):
    runtime = _normalize_egress_config(egress_config)
    residential = residential if isinstance(residential, dict) else {}
    config = {"log": {"level": "info", "timestamp": True}, "inbounds": [], "outbounds": [{"type": "direct", "tag": "direct-out"}], "route": {"rules": []}}
    valid_nodes, active_certs = build_node_inbounds(nodes, config)
    for node in valid_nodes:
        inbound = next((entry for entry in config["inbounds"] if entry.get("tag") == "in-" + str(node["id"])), None)
        transports = node_transports(node)
        if inbound is not None:
            tune_inbound(inbound, transports)
        for transport in transports:
            ensure_firewall_open(int(node["port"]), transport)
    leading_rules = list(config["route"]["rules"])
    actual_inbounds = ["in-" + str(node["id"]) for node in valid_nodes if node.get("protocol") != "dokodemo-door"]
    if proxy_inbounds is not None:
        actual_inbounds = list(proxy_inbounds)
    sniff_inbounds = ["in-" + str(node["id"]) for node in valid_nodes if node.get("protocol") not in {"dokodemo-door", "TUIC"} and "in-" + str(node["id"]) in actual_inbounds]
    listener = _residential_listener(proxy_cfg, residential)
    if listener:
        config["inbounds"].append(listener)
    if runtime["mode"] == "residential":
        if not residential.get("available"):
            raise RuntimeError("residential proxy is unavailable")
        host = str(residential.get("addr") or residential.get("host") or "").strip()
        try:
            port = int(residential.get("port") or 0)
        except (TypeError, ValueError):
            port = 0
        if not host or not 1 <= port <= 65535 or any(character.isspace() for character in host):
            raise ValueError("invalid residential SOCKS5 address or port")
        outbound = {"type": "socks", "tag": "socks5-outbound", "server": host, "server_port": port}
        if residential.get("user"):
            outbound["username"] = str(residential["user"])
        if residential.get("pass"):
            outbound["password"] = str(residential["pass"])
        config["outbounds"].append(outbound)
        check_host = "127.0.0.1"
        config["inbounds"].append({"type": "socks", "tag": "egress-check-in", "listen": "127.0.0.1", "listen_port": 39482})
        leading_rules.insert(0, {"inbound": ["egress-check-in"], "action": "route", "outbound": "socks5-outbound"})
    policy = build_routing_policy(runtime, proxy_inbounds=actual_inbounds, sniff_inbounds=sniff_inbounds, mirror_prefix=mirror_prefix, leading_route_rules=leading_rules)
    tags = {item["tag"] for item in policy["rulesets"]}
    policy["rule_set_paths"] = prepare_rule_sets(ruleset_dir, mirror_prefix=mirror_prefix, tags=tags)
    for ruleset in policy["rulesets"]:
        ruleset["path"] = policy["rule_set_paths"][ruleset["tag"]]
    strategy = {"dual": "prefer_ipv4", "ipv4_only": "ipv4_only", "ipv6_only": "ipv6_only"}[runtime["ip_stack"]]
    config["outbounds"][0]["domain_resolver"] = {"server": "local-dns", "strategy": strategy}
    if runtime["mode"] == "residential":
        outbound["domain_resolver"] = {"server": "local-dns", "strategy": strategy}
    config["route"] = policy["route"]
    config["dns"] = policy["dns"]
    if runtime["mode"] == "residential":
        previous_dns = None
        try:
            with open(SINGBOX_CONF_PATH, encoding="utf-8") as handle:
                previous_dns = next(server for server in json.load(handle).get("dns", {}).get("servers", []) if server.get("tag") == "proxy-dns")
        except (OSError, ValueError, StopIteration, TypeError):
            previous_dns = None
        if previous_dns and (previous_dns.get("server"), previous_dns.get("tls", {}).get("server_name")) in (("1.1.1.1", "cloudflare-dns.com"), ("8.8.8.8", "dns.google")):
            primary = next(server for server in config["dns"]["servers"] if server["tag"] == "proxy-dns")
            primary["server"] = previous_dns["server"]
            primary["tls"]["server_name"] = previous_dns["tls"]["server_name"]
    config["experimental"] = {"cache_file": {"enabled": True, "path": "/etc/sing-box/cache.db"}, "clash_api": {"external_controller": "127.0.0.1:39483", "secret": policy["clash_api_secret"]}}
    os.makedirs(os.path.dirname(SINGBOX_CONF_PATH), exist_ok=True)
    temp_path = SINGBOX_CONF_PATH + ".pending"
    previous = None
    if os.path.exists(SINGBOX_CONF_PATH):
        with open(SINGBOX_CONF_PATH, encoding="utf-8") as handle:
            previous = handle.read()
    equivalent = False
    if previous is not None:
        try:
            old_config = json.loads(previous)
            old_secret = old_config.get("experimental", {}).get("clash_api", {}).get("secret")
            if old_secret:
                config["experimental"]["clash_api"]["secret"] = old_secret
                equivalent = old_config == config
            if equivalent:
                policy["clash_api_secret"] = old_secret
            else:
                config["experimental"]["clash_api"]["secret"] = policy["clash_api_secret"]
        except (ValueError, TypeError, AttributeError):
            pass
    replaced = False
    try:
        if not equivalent:
            _write_private_text(temp_path, json.dumps(config, indent=2))
            checked = subprocess.run(["sing-box", "check", "-c", temp_path], capture_output=True, text=True, timeout=30)
            if checked.returncode:
                raise RuntimeError("sing-box config check failed: " + checked.stderr.strip()[-500:])
            if previous is not None:
                _write_private_text(SINGBOX_CONF_PATH + ".last-good", previous)
            os.replace(temp_path, SINGBOX_CONF_PATH)
            replaced = True
            if not _restart_singbox():
                raise RuntimeError("sing-box restart failed")
        elif not _singbox_service_healthy() and not _restart_singbox():
            raise RuntimeError("sing-box service is unhealthy and could not be restarted")
        egress_ip = _verify_socks5_exit(check_host, require_distinct_exit=True) if runtime["mode"] == "residential" else _verify_native_exit(runtime["ip_stack"])
        if runtime["mode"] == "residential":
            dns_options = (("1.1.1.1", "cloudflare-dns.com"), ("8.8.8.8", "dns.google"))
            selected = next((option for option in dns_options if _probe_residential_doh(*option)), None)
            if not selected:
                raise RuntimeError("residential DNS probes failed")
            dns_server = next(server for server in config["dns"]["servers"] if server["tag"] == "proxy-dns")
            if (dns_server["server"], dns_server["tls"]["server_name"]) != selected:
                dns_server["server"], dns_server["tls"]["server_name"] = selected
                policy["clash_api_secret"] = secrets.token_urlsafe(24)
                config["experimental"]["clash_api"]["secret"] = policy["clash_api_secret"]
                _write_private_text(temp_path, json.dumps(config, indent=2))
                checked = subprocess.run(["sing-box", "check", "-c", temp_path], capture_output=True, text=True, timeout=30)
                if checked.returncode:
                    raise RuntimeError("sing-box fallback DNS config check failed")
                if not replaced and previous is not None:
                    _write_private_text(SINGBOX_CONF_PATH + ".last-good", previous)
                os.replace(temp_path, SINGBOX_CONF_PATH)
                replaced = True
                if not _restart_singbox():
                    raise RuntimeError("sing-box fallback DNS restart failed")
                egress_ip = _verify_socks5_exit(check_host, require_distinct_exit=True)
    except Exception as error:
        error.rollback_healthy = _rollback_singbox_apply(previous, replaced)
        raise
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)
    return {"config": config, "previous_config": previous, "replaced": replaced, "egress_ip": egress_ip, "index": policy["index"], "rule_set_paths": policy["rule_set_paths"], "groups": policy["groups"], "proxy_inbounds": actual_inbounds, "active_certs": active_certs, "valid_nodes": valid_nodes, "clash_api_secret": policy["clash_api_secret"]}

def _clean_unused_certificates(active_certs):
    try:
        names = os.listdir("/opt/kui")
    except OSError:
        return
    for name in names:
        if (name.startswith("cert_") and name.endswith((".pem", ".sni")) or name.startswith("key_") and name.endswith(".pem")) and name not in active_certs:
            try:
                os.remove(os.path.join("/opt/kui", name))
            except OSError:
                pass


def _archive_legacy_profiles(base_dir="/opt/kui"):
    """Archive legacy WARP state after a successful apply, without overwriting backups."""
    if os.path.exists(os.path.join(base_dir, ".update-pending")):
        return []
    archive_dir = os.path.join(base_dir, "archive", "legacy-warp")
    archived = []
    for name in ("warp.json", "warp-benchmark.json", "warp-optimizer.json"):
        source = os.path.join(base_dir, name)
        if not os.path.isfile(source):
            continue
        try:
            os.makedirs(archive_dir, mode=0o700, exist_ok=True)
            os.chmod(archive_dir, 0o700)
            with open(source, "rb") as handle:
                content = handle.read(1024 * 1024 + 1)
            if len(content) > 1024 * 1024:
                raise ValueError("legacy profile is too large")
            digest = hashlib.sha256(content).hexdigest()
            target = os.path.join(archive_dir, name)
            if os.path.exists(target):
                with open(target, "rb") as handle:
                    if handle.read(1024 * 1024 + 1) != content:
                        target = os.path.join(archive_dir, f"{name}.{digest}")
            if os.path.exists(target):
                with open(target, "rb") as handle:
                    if handle.read(1024 * 1024 + 1) != content:
                        raise ValueError("legacy profile archive digest collision")
            else:
                descriptor, temp_path = tempfile.mkstemp(prefix=name + ".", suffix=".tmp", dir=archive_dir)
                try:
                    with os.fdopen(descriptor, "wb") as handle:
                        handle.write(content)
                        handle.flush()
                        os.fsync(handle.fileno())
                    os.chmod(temp_path, 0o600)
                    os.replace(temp_path, target)
                    directory_fd = os.open(archive_dir, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                finally:
                    if os.path.exists(temp_path):
                        os.remove(temp_path)
            os.remove(source)
            archived.append(name)
        except (OSError, ValueError) as error:
            print(f"[agent] legacy profile archive deferred for {name}: {error}", flush=True)
    return archived


_stack_probe_cache = {}
_stack_probe_until = 0.0


def _probe_stack_route(family, addresses):
    all_unreachable = True
    for address in addresses:
        try:
            with socket.socket(family, socket.SOCK_STREAM) as connection:
                connection.settimeout(1.0)
                connection.connect((address, 443))
                return True
        except OSError as error:
            if error.errno in {errno.EAFNOSUPPORT, errno.EPROTONOSUPPORT}:
                return False
            if error.errno not in {errno.ENETUNREACH, errno.EHOSTUNREACH, errno.EADDRNOTAVAIL}:
                all_unreachable = False
    return False if all_unreachable else None


def _stack_reachability():
    global _stack_probe_until, _stack_probe_cache
    if time.monotonic() >= _stack_probe_until:
        _stack_probe_cache = {
            'has_ipv4': _probe_stack_route(socket.AF_INET, ('1.1.1.1', '8.8.8.8')),
            'has_ipv6': _probe_stack_route(socket.AF_INET6, ('2606:4700:4700::1111', '2001:4860:4860::8888')),
        }
        _stack_probe_until = time.monotonic() + 300
    return _stack_probe_cache


def report_status(current_nodes, argo_urls, force_http=False, allow_http=True):
    global last_reported_bytes, last_reported_system_bytes, global_interval, fast_mode, dynamic_ping, pending_report_id, pending_report_bytes, pending_node_traffic, pending_system_bytes, pending_report_payload, last_http_report
    status = get_system_status(global_interval)
    status["ip"] = VPS_IP
    status["argo_urls"] = argo_urls
    status.update(_stack_reachability())
    status["capabilities"] = ["route_log"]

    deltas = []
    pending_bytes = dict(last_reported_bytes)
    current_ids = set()
    traffic_snapshot = _collect_iptables_port_bytes_snapshot() if current_nodes else {}
    traffic_degraded = getattr(traffic_snapshot, "is_degraded", False)
    for node in current_nodes:
        nid, port = node["id"], node["port"]
        current_ids.add(nid)
        if traffic_degraded:
            continue
        proto = "both" if node.get("protocol") == "Shadowsocks2022" and node.get("network", "tcp,udp") == "tcp,udp" else (node.get("network") if node.get("protocol") == "Shadowsocks2022" else ("udp" if node["protocol"] in ["Hysteria2", "TUIC"] else "tcp"))
        current_bytes = get_port_traffic(port, proto, nid, snapshot=traffic_snapshot)
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
            egress = data.get("egress", {})
            desired_config = _normalize_egress_config(egress.get("desired_config"), egress.get("desired_mode", "native"), egress)
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
            config_hash = hashlib.sha256(json.dumps({"nodes": nodes, "egress": runtime_config}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            built = None
            previous_monitor = None
            try:
                _strip_stale_residential_inbound(os.path.exists("/etc/proxy-lite/env") or runtime_egress == "residential")
                if runtime_egress == "residential" and not residential.get("available"):
                    reason = residential.get("reason") or "controller did not report a ready residential tunnel"
                    raise RuntimeError(f"residential proxy is unavailable: {reason}")
                prepare_mtproxy_nodes(nodes)
                sync_mtproxy_nodes(nodes)
                built = build_singbox_config(nodes, runtime_config, residential=residential, proxy_cfg=current_proxy_config,
                    mirror_prefix=data.get("ruleset_mirror_prefix", ""))
                previous_monitor = route_monitor.update(index=built["index"], revision=revision if apply_egress_change else applied_revision,
                    proxy_inbounds=built["proxy_inbounds"], rule_set_paths=built["rule_set_paths"], secret=built["clash_api_secret"])
                if apply_egress_change:
                    result = {"success": True, "component": "egress", "revision": revision, "deployment_id": deployment_id, "desired_mode": desired_egress, "applied_mode": desired_egress, "rolled_back": False, "rollback_healthy": True, "applied_at": int(time.time() * 1000), "egress_ip": built["egress_ip"]}
                    _save_egress_state(desired_egress, revision, result, deployment_id, desired_config)
                    try:
                        ack = _deliver_egress_result(result)
                        if ack.get("accepted"): _save_egress_state(desired_egress, revision, deployment_id=deployment_id, applied_config=desired_config)
                    except Exception: pass
                else:
                    if local_state["applied_revision"] != applied_revision or local_state["applied_config"] != applied_config:
                        _save_egress_state(applied_egress, applied_revision, deployment_id=deployment_id, applied_config=applied_config)
                    if realtime_channel and realtime_channel.connected:
                        realtime_channel.send({"success": True, "component": "config", "config_hash": config_hash, "old_config_active": False, "rollback_healthy": True, "applied_at": int(time.time() * 1000)}, "config.result")
            except Exception as error:
                rollback_healthy = getattr(error, "rollback_healthy", None)
                if rollback_healthy is None:
                    rollback_healthy = _rollback_singbox_apply(built["previous_config"], built["replaced"]) if built is not None else _singbox_service_healthy()
                if not rollback_healthy:
                    route_monitor.update(index=[], revision=0, proxy_inbounds=[], rule_set_paths={}, secret="")
                elif previous_monitor is not None:
                    route_monitor.update(**previous_monitor)
                if apply_egress_change:
                    retries = int(pending_failure.get("retries", 0)) + 1
                    retry_delay = min(300, 30 * (2 ** min(retries - 1, 4)))
                    result = {"success": False, "component": "egress", "revision": revision, "deployment_id": deployment_id, "desired_mode": desired_egress, "applied_mode": applied_egress, "rolled_back": rollback_healthy, "rollback_healthy": rollback_healthy, "error": str(error)[:500], "retries": retries, "retry_after": int(time.time() + retry_delay), "applied_at": int(time.time() * 1000)}
                    try:
                        _save_egress_state(applied_egress, applied_revision, result, deployment_id, applied_config)
                    except OSError as state_error:
                        print(f"[agent] failed to persist egress failure: {state_error}", flush=True)
                    _schedule_egress_retry(retry_delay)
                    try:
                        _deliver_egress_result(result)
                    except Exception: pass
                elif realtime_channel and realtime_channel.connected:
                    realtime_channel.send({"success": False, "component": "config", "config_hash": config_hash, "error": str(error)[:500], "old_config_active": rollback_healthy, "rollback_healthy": rollback_healthy, "applied_at": int(time.time() * 1000)}, "config.result")
                raise
            try:
                _clean_unused_certificates(built["active_certs"])
                _archive_legacy_profiles()
            except Exception as cleanup_error:
                print(f"[agent] post-apply cleanup deferred: {cleanup_error}", flush=True)
            return nodes
    except Exception as error:
        print(f"[agent] config fetch/apply failed: {error}", flush=True)
    return None

if __name__ == "__main__":
    import atexit
    from route_monitor import RouteMonitor

    heartbeat_state = {"nodes": [], "argo_urls": []}
    route_monitor = RouteMonitor(lambda data, kind: realtime_channel and realtime_channel.send(data, kind))
    atexit.register(route_monitor.close)

    def on_realtime_message(message):
        global realtime_status_interval
        if route_monitor.handle_command(message): return
        if message.get("type") == "transport.disconnected": route_monitor.stop()
        if message.get("type") == "status.interval":
            requested_interval = int(message.get("seconds", REALTIME_STATUS_IDLE_INTERVAL))
            realtime_status_interval = max(REALTIME_STATUS_ACTIVE_INTERVAL, min(REALTIME_STATUS_IDLE_INTERVAL, requested_interval))
            heartbeat_wakeup.set()
        if message.get("type") in {"config.refresh", "transport.connected", "transport.disconnected"}: config_wakeup.set()
        if message.get("type") in {"transport.connected", "transport.disconnected"}: heartbeat_wakeup.set()
        if message.get("type") == "config.result.ack" and message.get("accepted") is True and message.get("success") is True:
            with egress_state_lock:
                state = _load_egress_state()
                pending = state.get("pending_result") or {}
                same_deployment = not message.get("deployment_id") or message["deployment_id"] == state.get("deployment_id")
                if same_deployment and pending.get("success") is True and pending.get("revision") == message.get("revision"):
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
    def create_realtime_channel():
        options = {"capabilities": ["route_log"]} if hasattr(RealtimeChannel, "_hello_capabilities") else {}
        return RealtimeChannel(REALTIME_URL, VPS_IP, TOKEN, "core", on_realtime_message, **options)

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
