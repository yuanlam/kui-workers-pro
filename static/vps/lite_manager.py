#!/usr/bin/env python3
import base64, csv, os, subprocess, threading, time, urllib.request, urllib.parse, json, ipaddress, hashlib, hmac, sys, re, socket, http.client
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from pathlib import Path
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
            self.current = {"country": "", "detail_url": "", "text": []}
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
last_blacklist_clear = time.time()
public_ip = ""

global_node_reservoir = {} 
reservoir_lock = threading.Lock()
last_reservoir_log_count = None
last_empty_candidate_log = 0
html_fallback_cache = {}
last_vpngate_source_log = 0
VPNGATE_HTML_FALLBACK_INTERVAL = 1800
VPNGATE_HTML_FALLBACK_LIMIT = 8

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

# Use dedicated high-numbered tables. The old 101/102 tables and preferences
# overlap with policy routing installed by several cloud images and could
# remove the VPS public return route, immediately breaking SSH.
KUI_ROUTE_TABLES = {"tun_main": 20101, "tun_backup": 20102}
LEGACY_KUI_ROUTE_TABLES = {"tun_main": 101, "tun_backup": 102}
tun_main = Tunnel("tun_main", KUI_ROUTE_TABLES["tun_main"])
tun_backup = Tunnel("tun_backup", KUI_ROUTE_TABLES["tun_backup"])

def penalize_node(ip: str, penalty: int):
    """
    节点信誉动态降级机制：
    给不可用或低质的节点加上高额的虚拟 ping 值惩罚，
    确保下一次调度排序时，该节点被永久压入蓄水池底部，从而避免"死循环假性枯竭"。
    """
    with reservoir_lock:
        if ip in global_node_reservoir:
            global_node_reservoir[ip]["ping"] += penalty

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
            
            with state_lock:
                force_switch = (switch_trigger > last_switch_trigger)
                if target_country != desired_country or force_switch:
                    config_generation += 1
                    target_country = desired_country
                    if force_switch: print("[*] 收到强制更换指令，正在清退通道并拉黑当前 IP...", flush=True)
                    else: print(f"[*] 策略热切换: 目标重定向到 {desired_country}...", flush=True)
                    
                    if tun_main.entry_ip: dead_ips.add(tun_main.entry_ip)
                    if tun_main.process:
                        try: tun_main.process.terminate(); tun_main.process.wait(2)
                        except: tun_main.process.kill()
                    tun_main.ready = False; tun_main.process = None; tun_main.entry_ip = ""; tun_main.egress_ip = ""
                    
                    if tun_backup.process:
                        try: tun_backup.process.terminate(); tun_backup.process.wait(2)
                        except: tun_backup.process.kill()
                    tun_backup.ready = False; tun_backup.process = None; tun_backup.entry_ip = ""; tun_backup.egress_ip = ""
                    
                    last_switch_trigger = switch_trigger
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
                        "node_ip": tun.egress_ip if tun.egress_ip else tun.entry_ip,
                        "exit_ip": tun.egress_ip if tun.egress_ip else tun.entry_ip,
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
            nodes.append({
                "ip": node_ip,
                "ping": int(raw_ping) if raw_ping.isdigit() else 9999,
                "country": row.get("CountryShort", "").upper(),
                "config": sanitize_openvpn_config(base64.b64decode(encoded_config, validate=True).decode("utf-8", errors="replace"), node_ip),
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
        return {
            "ip": candidate["ip"],
            "ping": candidate["ping"],
            "country": candidate["country"],
            "config": sanitize_openvpn_config(raw_config, candidate["ip"]),
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
        candidates = sorted(candidates, key=lambda candidate: candidate["ping"])[:VPNGATE_HTML_FALLBACK_LIMIT]
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
    global global_node_reservoir, dead_ips, last_reservoir_log_count
    while True:
        snapshot = harvest_snapshot_nodes()
        if snapshot:
            with reservoir_lock:
                for n in snapshot:
                    # 保留原有的惩罚性 ping 值，防止坏节点被新抓取的快照刷新后又跑到前列去
                    if n["ip"] in global_node_reservoir:
                        n["ping"] = max(n["ping"], global_node_reservoir[n["ip"]]["ping"])
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

def connect_node(tun: Tunnel, node: dict, generation: int):
    global dead_ips
    try:
        print(f"[*] {tun.name} 开始拨号: {node['country']} {node['ip']} (ping={node['ping']})", flush=True)
        cfg_path = CONFIG_DIR / f"{tun.name}.ovpn"
        log_file = WORKSPACE / f"{tun.name}_err.log"
        cfg_path.write_text(node["config"], encoding="utf-8")
        
        ovpn_version = subprocess.run(["openvpn", "--version"], capture_output=True, text=True).stdout
        cipher_args = ["--ncp-ciphers", "AES-128-CBC:AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305"] if "2.4" in ovpn_version else ["--data-ciphers", "AES-128-CBC:AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305", "--data-ciphers-fallback", "AES-128-CBC"]
        
        # route-noexec is the hard boundary: OpenVPN may configure only its
        # TUN address; all routing remains owned by setup_routing() below.
        cmd = ["openvpn", "--config", str(cfg_path), "--dev", tun.name, "--dev-type", "tun", 
               "--nobind", "--route-nopull", "--route-noexec",
               "--pull-filter", "ignore", "redirect-gateway",
               "--pull-filter", "ignore", "route-ipv6", "--pull-filter", "ignore", "ifconfig-ipv6", 
               "--auth-user-pass", str(AUTH_FILE),
               "--connect-timeout", "5", "--connect-retry-max", "1", "--verb", "3"] + cipher_args
               
        with open(log_file, "w") as f: process = subprocess.Popen(cmd, stdout=f, stderr=subprocess.STDOUT)
        with state_lock:
            if generation != config_generation:
                process.terminate(); return
            tun.process = process
        
        success = False
        for _ in range(15):
            time.sleep(1)
            if process.poll() is not None: break
            try:
                if "Initialization Sequence Completed" in log_file.read_text():
                    success = True; break
            except: pass
                
        if success and process.poll() is None:
            with state_lock:
                if generation != config_generation or (target_country != "ANY" and node.get("country") != target_country):
                    process.terminate(); return
            setup_routing(tun.name, tun.table_id)
            time.sleep(1) 
            
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

            is_residential = True
            try:
                req_url = f"https://testisp.info/api/check?ip={egress_ip}"
                check_req = urllib.request.Request(req_url, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"}, method="GET")
                with _urlopen(check_req, timeout=10) as check_res:
                    data = json.loads(check_res.read().decode("utf-8"))
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
                dead_ips.add(node["ip"])
                try: process.terminate(); process.wait(2)
                except: process.kill()
                return

            print(f"[*] {tun.name} 流媒体连通性检测 (多端点)...", flush=True)
            stream_ok = False
            for stream_url in [
                "https://www.youtube.com",
                "https://www.gstatic.com/generate_204",
                "https://cp.cloudflare.com/generate_204",
                "https://www.google.com/robots.txt",
            ]:
                r = subprocess.run(["curl", "-o", "/dev/null", "-s", "-w", "%{http_code}", "-A", "Mozilla/5.0", "-m", "10", "--interface", tun.name, stream_url], capture_output=True, text=True)
                code = r.stdout.strip()
                if code and code != "000" and r.returncode == 0:
                    print(f"[+] {tun.name} 端点可达 {stream_url} HTTP {code}", flush=True)
                    stream_ok = True
                    break
                print(f"[*] {tun.name} 端点不可达 {stream_url} (code={code})", flush=True)
            if not stream_ok:
                print(f"[-] {tun.name} 所有流媒体端点均不可达，轻惩罚保留备用: {node['ip']}", flush=True)
                penalize_node(node["ip"], 3000)
                try: process.terminate(); process.wait(2)
                except: process.kill()
                return

            with state_lock:
                if generation != config_generation or (target_country != "ANY" and node.get("country") != target_country):
                    process.terminate(); return
                tun.process = process
                tun.node = node
                # 此时不再需要赋 entry_ip，因为在 maintain_pool 里已提前锁住坑位
                tun.egress_ip = egress_ip
                tun.country = node["country"]
                tun.connected_at = time.time()
                tun.ready = True
            role = "主网卡" if proxy_server.ACTIVE_BIND == tun.name else "备用网卡"
            print(f"[+] {tun.name} ({role}) 完全就绪: 入口 {node['ip']} -> 出口 {egress_ip}", flush=True)
        else:
            try:
                error_tail = "\n".join(log_file.read_text(errors="replace").splitlines()[-12:])
            except Exception:
                error_tail = "无法读取 OpenVPN 日志"
            print(f"[-] {tun.name} 建连失败: {node['ip']}\n{error_tail}", flush=True)
            penalize_node(node["ip"], 5000)  # 建连超时中度惩罚
            try: process.terminate(); process.wait(2)
            except: process.kill()
            dead_ips.add(node["ip"])
    finally:
        with state_lock:
            tun.is_connecting = False
            # 连接未成功时，释放在 maintain_pool 中预占的坑位（entry_ip），
            # 否则该 IP 会被 get_best_candidate 的 active_ips 永久剔除，
            # 在可用节点稀少时会导致备用通道永远填不上（负载率长期卡在 1/2）。
            if not tun.ready:
                tun.entry_ip = ""

def health_check_loop():
    global tun_main, tun_backup, dead_ips
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
                dead_ips.add(target_entry_ip)
                try: proc_ref.terminate(); proc_ref.wait(timeout=2)
                except: proc_ref.kill()
                with state_lock:
                    if tunnel.process == proc_ref:
                        tunnel.ready = False
                fail_counts.pop(process_key, None)
            else:
                print(f"[*] {target_tun} 探针无响应，快速复核 ({fail_counts[process_key]}/3)...", flush=True)

def get_best_candidate():
    global global_node_reservoir, dead_ips, target_country, tun_main, tun_backup, last_empty_candidate_log
    with reservoir_lock:
        all_pool_nodes = sorted(list(global_node_reservoir.values()), key=lambda x: x["ping"])
        candidates = [n for n in all_pool_nodes if (target_country == "ANY" or n["country"] == target_country) and n["ip"] not in dead_ips]
        
        with state_lock:
            active_ips = [ip for ip in (tun_main.entry_ip, tun_backup.entry_ip) if ip]
        candidates = [n for n in candidates if n["ip"] not in active_ips]

        if not candidates:
            has_blacklisted = any(target_country == "ANY" or n["country"] == target_country for n in all_pool_nodes)
            if has_blacklisted:
                dead_ips.clear()
                print(f"[!] ⚡ 紧急熔断：[{target_country}] 节点黑名单释放救场（由于动态信誉系统存在，历史坏节点将被沉底）", flush=True)
                candidates = [n for n in all_pool_nodes if (target_country == "ANY" or n["country"] == target_country) and n["ip"] not in active_ips]

        if candidates: return candidates.pop(0)
        country_counts = {}
        for node in all_pool_nodes:
            country_counts[node["country"]] = country_counts.get(node["country"], 0) + 1
        now = time.time()
        if now - last_empty_candidate_log >= 30:
            print(f"[!] 无可用 {target_country} 候选；节点分布={country_counts}，黑名单={len(dead_ips)}", flush=True)
            last_empty_candidate_log = now
    return None

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
    global dead_ips, last_blacklist_clear, tun_main, tun_backup
    while True:
        if time.time() - last_blacklist_clear > 600:
            dead_ips.clear()
            last_blacklist_clear = time.time()

        with reservoir_lock:
            now = time.time()
            stale_ips = [ip for ip, node in global_node_reservoir.items() if now - node["harvested_at"] > 10800]
            for ip in stale_ips: global_node_reservoir.pop(ip, None)

        with state_lock:
            # FIX 2: 严格检测通道是否正在连接，防止由于尚未就绪导致的错误判死和秒切混乱
            main_dead = False
            if not tun_main.is_connecting:
                if tun_main.process is None or tun_main.process.poll() is not None or not tun_main.ready:
                    main_dead = True

            if main_dead:
                if tun_backup.ready and tun_backup.process and tun_backup.process.poll() is None and not tun_backup.is_connecting:
                    print(f"[*] ⚡ 主通道暴毙，软开关秒切！无缝接管业务至备用通道: 出口 {tun_backup.egress_ip or tun_backup.entry_ip}", flush=True)
                    # 状态互换 (身份对调)
                    tun_main, tun_backup = tun_backup, tun_main
                    proxy_server.ACTIVE_BIND = tun_main.name
                    
                    # 异步清理死掉的旧主卡 (现在的 tun_backup)
                    if tun_backup.process:
                        try: tun_backup.process.terminate(); tun_backup.process.wait(2)
                        except: tun_backup.process.kill()
                    tun_backup.process = None; tun_backup.node = None; tun_backup.entry_ip = ""; tun_backup.egress_ip = ""
                    tun_backup.ready = False; tun_backup.is_connecting = False
                else:
                    if tun_main.process:
                        try: tun_main.process.terminate(); tun_main.process.wait(2)
                        except: tun_main.process.kill()
                    tun_main.process = None; tun_main.ready = False; tun_main.is_connecting = False
                    tun_main.entry_ip = ""; tun_main.egress_ip = ""

        with state_lock:
            needs_main = not tun_main.ready and not tun_main.is_connecting
            needs_backup = not tun_backup.ready and not tun_backup.is_connecting

        if needs_main:
            node = get_best_candidate()
            if node:
                with state_lock: 
                    tun_main.is_connecting = True
                    tun_main.entry_ip = node["ip"] # FIX 1: 提前占住坑位，防止备用通道刚好获取到同样的 IP 导致死锁冲突
                threading.Thread(target=connect_node, args=(tun_main, node, config_generation), daemon=True).start()
                time.sleep(1)
        elif needs_backup:
            node = get_best_candidate()
            if node:
                with state_lock: 
                    tun_backup.is_connecting = True
                    tun_backup.entry_ip = node["ip"] # FIX 1: 提前占住坑位
                threading.Thread(target=connect_node, args=(tun_backup, node, config_generation), daemon=True).start()

        time.sleep(2)

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
