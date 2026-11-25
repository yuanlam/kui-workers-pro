#!/usr/bin/env bash
# ==========================================================
# KUI 住宅IP代理 Agent 安装脚本 (Residential Proxy Agent)
# 用法:
#   bash <(curl -sL https://<KUI_PAGES>/vps/residential-proxy.sh) \
#        --domain https://<KUI_PAGES> --controller https://<RESIDENTIAL_CTRL>
#   --domain      : 本仓库 (KUI Pages) 域名，用于下载 /vps/ 下的 agent 脚本
#   --controller  : 住宅IP代理控制器域名 (Free-Residential-IP-Proxy-Controller 部署地址)
#                   即 agent 心跳上报 (C2) 地址，对应面板 PROXY_CTRL_URL
# ==========================================================
set -euo pipefail

DOMAIN=""
CONTROLLER=""
AGENT_TOKEN=""
VPS_IP=""
PKG_MGR=""
INIT_SYS=""
SINGBOX_MIGRATED=0
MIGRATE_TEMP_PATH=""
LOCK_OWNED=0
INSTALLER_LOCK_DIR="${KUI_INSTALLER_LOCK_DIR:-/run/kui-installer.lock.d}"

is_stale_lock_dir() {
    [ -n "$(find "$1" -maxdepth 0 -mmin +1 2>/dev/null || true)" ]
}

is_single_line() {
    [[ "$1" != *$'\n'* && "$1" != *$'\r'* ]]
}

_write_installer_lock_pid() {
    local lock_dir="$1"
    local owner_pid="$2"
    if printf '%s\n' "$owner_pid" > "$lock_dir/pid.tmp" && mv -f "$lock_dir/pid.tmp" "$lock_dir/pid"; then
        return 0
    fi
    rm -rf "$lock_dir" 2>/dev/null || true
    echo "❌ 写入安装锁 PID 失败"
    return 1
}

_acquire_installer_lock_critical() {
    local lock_dir="$1"
    local owner_pid="$2"
    local reclaim_dir="${lock_dir}.reclaim"
    if mkdir "$lock_dir" 2>/dev/null; then
        _write_installer_lock_pid "$lock_dir" "$owner_pid" || return 1
        rm -rf "$reclaim_dir" 2>/dev/null || true
        return 0
    fi
    local lock_pid
    lock_pid=$(cat "$lock_dir/pid" 2>/dev/null || true)
    if { [ -n "$lock_pid" ] && ! kill -0 "$lock_pid" 2>/dev/null; } || { [ -z "$lock_pid" ] && is_stale_lock_dir "$lock_dir"; }; then
        rm -rf "$lock_dir" "$reclaim_dir"
        if mkdir "$lock_dir" 2>/dev/null; then
            _write_installer_lock_pid "$lock_dir" "$owner_pid" || return 1
            return 0
        fi
    fi
    echo "❌ 另一个安装进程正在运行 (PID: ${lock_pid:-unknown})"
    return 1
}

_release_installer_lock_critical() {
    local lock_dir="$1"
    local owner_pid="$2"
    if [ "$(cat "$lock_dir/pid" 2>/dev/null || true)" = "$owner_pid" ]; then
        rm -rf "$lock_dir"
    fi
}

_with_installer_lock_mutex() {
    local op="$1"
    local owner_pid="$2"
    local lock_mutex="${INSTALLER_LOCK_DIR}.mutex"
    if command -v flock >/dev/null 2>&1; then
        (
            local locked=0
            local i=0
            while [ "$i" -lt 100 ]; do
                if flock -xn 9 2>/dev/null; then
                    locked=1
                    break
                fi
                i=$((i + 1))
                sleep 0.1 2>/dev/null || sleep 1
            done
            if [ "$locked" -ne 1 ]; then
                echo "❌ 另一个安装进程正在运行"
                exit 1
            fi
            if [ "$op" = "acquire" ]; then
                _acquire_installer_lock_critical "$INSTALLER_LOCK_DIR" "$owner_pid"
            else
                _release_installer_lock_critical "$INSTALLER_LOCK_DIR" "$owner_pid"
            fi
        ) 9>>"$lock_mutex"
        return $?
    fi
    if command -v python3 >/dev/null 2>&1; then
        python3 - "$lock_mutex" "$INSTALLER_LOCK_DIR" "$owner_pid" "$op" <<'PY'
import errno, fcntl, os, shutil, sys, time

mutex_path, lock_dir, owner_pid, op = sys.argv[1:5]
reclaim_dir = lock_dir + ".reclaim"

def pid_alive(pid_text):
    try:
        pid = int(pid_text.strip())
    except Exception:
        return False
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError as exc:
        return exc.errno == errno.EPERM

def is_stale_dir(path):
    try:
        return (time.time() - os.stat(path).st_mtime) > 60
    except OSError:
        return False

def publish_lock_dir():
    os.mkdir(lock_dir)
    tmp_pid = os.path.join(lock_dir, "pid.tmp")
    try:
        with open(tmp_pid, "w", encoding="utf-8") as fh:
            fh.write(f"{owner_pid}\n")
        os.replace(tmp_pid, os.path.join(lock_dir, "pid"))
    except OSError:
        shutil.rmtree(lock_dir, ignore_errors=True)
        sys.stdout.write("❌ 写入安装锁 PID 失败\n")
        sys.exit(1)

fd = os.open(mutex_path, os.O_CREAT | os.O_RDWR, 0o600)
try:
    deadline = time.monotonic() + 10.0
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if time.monotonic() >= deadline:
                sys.stdout.write("❌ 另一个安装进程正在运行\n")
                sys.exit(1)
            time.sleep(0.05)
    if op == "release":
        try:
            current = open(os.path.join(lock_dir, "pid"), "r", encoding="utf-8").read().strip()
        except OSError:
            current = ""
        if current == owner_pid:
            shutil.rmtree(lock_dir, ignore_errors=True)
        sys.exit(0)
    try:
        publish_lock_dir()
        shutil.rmtree(reclaim_dir, ignore_errors=True)
        sys.exit(0)
    except FileExistsError:
        pass
    try:
        lock_pid = open(os.path.join(lock_dir, "pid"), "r", encoding="utf-8").read().strip()
    except OSError:
        lock_pid = ""
    if (lock_pid and not pid_alive(lock_pid)) or (not lock_pid and is_stale_dir(lock_dir)):
        shutil.rmtree(lock_dir, ignore_errors=True)
        shutil.rmtree(reclaim_dir, ignore_errors=True)
        publish_lock_dir()
        sys.exit(0)
    sys.stdout.write(f"❌ 另一个安装进程正在运行 (PID: {lock_pid or 'unknown'})\n")
    sys.exit(1)
finally:
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    except OSError:
        pass
    os.close(fd)
PY
        return $?
    fi
    if [ "$op" = "release" ]; then
        _release_installer_lock_critical "$INSTALLER_LOCK_DIR" "$owner_pid"
        return 0
    fi
    echo "❌ 缺少 flock 或 python3，无法安全获取安装锁"
    return 1
}

acquire_installer_lock() {
    if [ "${KUI_INSTALLER_LOCK_HELD:-0}" = "1" ]; then
        return 0
    fi
    local lock_parent
    lock_parent=$(dirname "$INSTALLER_LOCK_DIR")
    if [ ! -d "$lock_parent" ] || [ ! -w "$lock_parent" ]; then
        INSTALLER_LOCK_DIR="/tmp/kui-installer.lock.d"
    fi
    if _with_installer_lock_mutex acquire "$$"; then
        LOCK_OWNED=1
        return 0
    fi
    exit 1
}

release_installer_lock() {
    if [ "$LOCK_OWNED" -eq 1 ]; then
        _with_installer_lock_mutex release "$$" || true
        LOCK_OWNED=0
    fi
}

stop_stale_agent_processes() {
    pkill -TERM -f "/opt/kui/agent\.py" >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5; do
        if ! pgrep -f "/opt/kui/agent\.py" >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done
    pkill -KILL -f "/opt/kui/agent\.py" >/dev/null 2>&1 || true
}

detect_pkg_manager() {
    if command -v apt-get >/dev/null 2>&1; then
        echo "apt"
    elif command -v apk >/dev/null 2>&1; then
        echo "apk"
    elif command -v yum >/dev/null 2>&1; then
        echo "yum"
    elif command -v dnf >/dev/null 2>&1; then
        echo "dnf"
    else
        echo ""
    fi
}

detect_init_system() {
    if [ -d /run/systemd/system ] && [ "$(cat /proc/1/comm 2>/dev/null || true)" = "systemd" ] && command -v systemctl >/dev/null 2>&1; then
        echo "systemd"
    elif [ -x /sbin/openrc-run ] && command -v rc-service >/dev/null 2>&1; then
        echo "openrc"
    else
        echo ""
    fi
}

parse_args() {
    while [ "$#" -gt 0 ]; do
        case $1 in
            --domain) [ "$#" -ge 2 ] || { echo "❌ --domain 缺少参数"; exit 1; }; DOMAIN="$2"; shift 2 ;;
            --controller) [ "$#" -ge 2 ] || { echo "❌ --controller 缺少参数"; exit 1; }; CONTROLLER="$2"; shift 2 ;;
            --token) [ "$#" -ge 2 ] || { echo "❌ --token 缺少参数"; exit 1; }; AGENT_TOKEN="$2"; shift 2 ;;
            --ip) [ "$#" -ge 2 ] || { echo "❌ --ip 缺少参数"; exit 1; }; VPS_IP="$2"; shift 2 ;;
            *) echo "未知参数: $1"; exit 1 ;;
        esac
    done

    if [ -z "$DOMAIN" ]; then
        echo "❌ 错误: 缺少 --domain (本仓库域名，用于拉取 /vps/ 下的 agent 脚本)"
        exit 1
    fi
    if [ -z "$CONTROLLER" ]; then
        CONTROLLER="$DOMAIN"
    fi
    if [ -z "$AGENT_TOKEN" ]; then
        echo "❌ 错误: 缺少 --token (服务器专属 Agent Token)"
        exit 1
    fi
    if [ -z "$VPS_IP" ]; then
        echo "❌ 错误: 缺少 --ip (面板登记的服务器 IP)"
        exit 1
    fi
    if ! is_single_line "$AGENT_TOKEN" || ! printf '%s' "$AGENT_TOKEN" | grep -Eq '^[A-Za-z0-9._:-]+$'; then echo "❌ Agent Token 包含非法字符"; exit 1; fi
    if ! is_single_line "$DOMAIN" || ! printf '%s' "$DOMAIN" | grep -Eq '^https://[A-Za-z0-9._:/-]+$'; then echo "❌ 域名参数必须使用 HTTPS"; exit 1; fi
    if ! is_single_line "$CONTROLLER" || ! printf '%s' "$CONTROLLER" | grep -Eq '^https://[A-Za-z0-9._:/-]+$'; then echo "❌ 域名参数必须使用 HTTPS"; exit 1; fi
    if ! is_single_line "$VPS_IP" || ! printf '%s' "$VPS_IP" | grep -Eq '^[0-9A-Fa-f:.]+$'; then echo "❌ VPS IP 格式无效"; exit 1; fi
    if [ -n "${REALTIME_URL:-}" ] && { ! is_single_line "$REALTIME_URL" || ! printf '%s' "$REALTIME_URL" | grep -Eq '^https://[A-Za-z0-9._:/-]+$'; }; then
        echo "❌ REALTIME_URL 格式无效"
        exit 1
    fi

    export C2_URL="$CONTROLLER"
    export WEB_USER="${WEB_USER:-admin}"
    export WEB_PASS="${WEB_PASS:-}"
    export AGENT_TOKEN
    export VPS_IP

    echo "=========================================================="
    echo "     Proxy Controller (Active-Standby Multi-Tunnel)    "
    echo "=========================================================="
    echo "[*] 操作系统: $(uname -srm)"
    echo "[*] 包管理器检测中..."

    PKG_MGR=$(detect_pkg_manager)
    INIT_SYS=$(detect_init_system)

    echo "[*] 包管理器: ${PKG_MGR:-未识别}"
    echo "[*] 初始化系统: ${INIT_SYS:-未识别}"

    if [ -z "$PKG_MGR" ]; then
        echo "❌ 错误: 未识别包管理器，请手动安装 openvpn python3 curl iproute2 iptables"
        exit 1
    fi

    if [ -z "$INIT_SYS" ]; then echo "❌ 需要正在运行的 systemd 或 OpenRC"; exit 1; fi
}

install_dependencies() {
    echo "[0/4] 安装系统依赖..."
    case "$PKG_MGR" in
        apt)
            apt-get update -q || { echo "❌ apt-get update 失败"; exit 1; }
            apt-get install -y --no-install-recommends \
                openvpn python3 python3-websocket curl openssl iproute2 iptables cron psmisc \
                || { echo "❌ 依赖安装失败"; exit 1; }
            ;;
        apk)
            apk update || true
            apk add --no-cache \
                openvpn python3 py3-websocket-client curl openssl iproute2 iptables dcron psmisc \
                || { echo "❌ apk 依赖安装失败"; exit 1; }
            ;;
        yum|dnf)
            $PKG_MGR install -y \
                openvpn python3 curl openssl iproute2 iptables cron psmisc \
                || { echo "❌ $PKG_MGR 依赖安装失败"; exit 1; }
            $PKG_MGR install -y python3-websocket-client >/dev/null 2>&1 || echo "⚠️ 未找到 python3-websocket-client，将使用 HTTP 备份模式。"
            ;;
    esac
    echo "[+] 依赖安装完成"
}

setup_sysctl() {
    echo "[1/4] 配置内核网络参数..."
    cat > /etc/sysctl.d/99-proxy-lite.conf << 'SYSCTL'
net.ipv4.conf.all.rp_filter=2
net.ipv4.conf.default.rp_filter=2
SYSCTL
    if command -v sysctl >/dev/null 2>&1; then
        sysctl --system >/dev/null 2>&1 || {
            echo "⚠️  sysctl --system 部分失败，尝试单独应用..."
            sysctl -w net.ipv4.conf.all.rp_filter=2 >/dev/null 2>&1 || true
            sysctl -w net.ipv4.conf.default.rp_filter=2 >/dev/null 2>&1 || true
        }
    fi
    echo "[+] 内核参数配置完成"
}

setup_tun() {
    echo "[1.5/4] 检查 TUN/TAP 设备..."
    if [ -e /dev/net/tun ]; then
        echo "[+] /dev/net/tun 已存在"
        return
    fi
    echo "[*] /dev/net/tun 不存在，尝试创建..."
    mkdir -p /dev/net
    modprobe tun 2>/dev/null || true
    if grep -Eq '(^|[[:space:]])tun$' /proc/misc 2>/dev/null; then
        [ -e /dev/net/tun ] || mknod /dev/net/tun c 10 200
        chmod 600 /dev/net/tun
        if [ -f /etc/alpine-release ]; then
            grep -qxF tun /etc/modules 2>/dev/null || echo tun >> /etc/modules
        fi
    fi
    if [ ! -e /dev/net/tun ]; then
        echo "❌ 错误: /dev/net/tun 不存在，无法创建 TUN 设备。"
        echo "    可能原因："
        echo "    1. 内核未编译 tun 模块"
        echo "    2. 容器/虚拟化环境未开放 /dev/net/tun"
        echo "    3. 需要宿主机开启 TUN 设备"
        echo "    请先在宿主机或控制台开启 TUN/TAP 支持后重试。"
        exit 1
    fi
    echo "[+] TUN/TAP 设备已就绪"
}

download_agents() {
    echo "[2/4] 从安全中心拉取双活极速引擎..."
    mkdir -p /opt/proxy_lite/configs
    cd /opt/proxy_lite

    verify_agent_manifest() {
        COMPONENT="$1"; FILE="$2"; HEADERS="$3"
        EXPECTED_SHA=$(tr -d '\r' < "$HEADERS" | awk '/^[Xx]-[Aa]gent-[Ss][Hh][Aa]256:/ {print tolower($2)}' | tail -n 1)
        VERSION=$(tr -d '\r' < "$HEADERS" | awk '/^[Xx]-[Aa]gent-[Mm]anifest-[Vv]ersion:/ {print $2}' | tail -n 1)
        EXPECTED_LENGTH=$(tr -d '\r' < "$HEADERS" | awk '/^[Xx]-[Aa]gent-[Ll]ength:/ {print $2}' | tail -n 1)
        SUPPLIED_MAC=$(tr -d '\r' < "$HEADERS" | awk '/^[Xx]-[Aa]gent-[Mm][Aa][Cc]:/ {print tolower($2)}' | tail -n 1)
        ACTUAL_SHA=$(sha256sum "$FILE" | awk '{print $1}')
        ACTUAL_LENGTH=$(wc -c < "$FILE" | tr -d ' ')
        EXPECTED_MAC=$(printf 'v1\n%s\n%s\n%s\n' "$COMPONENT" "$EXPECTED_SHA" "$ACTUAL_LENGTH" | openssl dgst -sha256 -mac HMAC -macopt "key:${AGENT_TOKEN}" | awk '{print tolower($NF)}')
        [ "$VERSION" = "1" ] && [ "$EXPECTED_LENGTH" = "$ACTUAL_LENGTH" ] && [ "$EXPECTED_SHA" = "$ACTUAL_SHA" ] && [ -n "$SUPPLIED_MAC" ] && [ "$SUPPLIED_MAC" = "$EXPECTED_MAC" ]
    }

    download_component() {
        COMPONENT="$1"; TARGET="$2"; TEMP_FILE="${TARGET}.download"; STAGED_FILE="${TARGET}.staged"; HEADER_FILE="${TARGET}.headers"
        curl -fSL --retry 3 --retry-delay 2 -D "$HEADER_FILE" -H "Authorization: ${AGENT_TOKEN}" -o "$TEMP_FILE" "${DOMAIN}/api/agent_update?ip=${VPS_IP}&component=${COMPONENT}" || return 1
        verify_agent_manifest "$COMPONENT" "$TEMP_FILE" "$HEADER_FILE" || { echo "❌ ${COMPONENT} 更新清单校验失败"; return 1; }
        mv -f "$TEMP_FILE" "$STAGED_FILE"
        rm -f "$HEADER_FILE"
    }
    download_component proxy-manager lite_manager.py || { echo "❌ 下载 lite_manager.py 失败"; exit 1; }
    download_component proxy-server proxy_server.py || { echo "❌ 下载 proxy_server.py 失败"; exit 1; }
    download_component realtime-client realtime_client.py || { echo "❌ 下载 realtime_client.py 失败"; exit 1; }
    python3 -m py_compile lite_manager.py.staged proxy_server.py.staged realtime_client.py.staged || {
        echo "❌ 下载的代理引擎不是有效 Python 文件"
        exit 1
    }
    chmod 700 /opt/proxy_lite/lite_manager.py.staged /opt/proxy_lite/proxy_server.py.staged /opt/proxy_lite/realtime_client.py.staged
    mv -f /opt/proxy_lite/lite_manager.py.staged /opt/proxy_lite/lite_manager.py
    mv -f /opt/proxy_lite/proxy_server.py.staged /opt/proxy_lite/proxy_server.py
    mv -f /opt/proxy_lite/realtime_client.py.staged /opt/proxy_lite/realtime_client.py
    echo "[+] 引擎文件下载完成"
}

migrate_singbox_residential_inbound() {
    SINGBOX_MIGRATED=0
    local config_path="${KUI_SINGBOX_CONF_PATH:-/etc/sing-box/config.json}"
    [ -f "$config_path" ] || return 0

    local temp_path="${config_path}.migrate.$$"
    MIGRATE_TEMP_PATH="$temp_path"
    local status_text
    status_text=$(python3 - "$config_path" "$temp_path" <<'PY'
import json
import os
import sys

config_path, temp_path = sys.argv[1], sys.argv[2]
with open(config_path, "r", encoding="utf-8") as source:
    config = json.load(source)
inbounds = config.get("inbounds")
if not isinstance(inbounds, list):
    print("UNCHANGED")
    sys.exit(0)
filtered = [
    item for item in inbounds
    if not (isinstance(item, dict) and item.get("type") == "socks" and item.get("tag") == "residential-socks5")
]
if len(filtered) == len(inbounds):
    print("UNCHANGED")
    sys.exit(0)
config["inbounds"] = filtered
fd = os.open(temp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as output:
    json.dump(config, output, indent=2)
    output.flush()
    os.fsync(output.fileno())
os.chmod(temp_path, 0o600)
print("STAGED")
PY
    ) || { rm -f "$temp_path"; MIGRATE_TEMP_PATH=""; return 1; }

    if [ "$status_text" != "STAGED" ]; then
        rm -f "$temp_path"
        MIGRATE_TEMP_PATH=""
        return 0
    fi

    if command -v sing-box >/dev/null 2>&1; then
        if ! sing-box check -c "$temp_path" >/dev/null 2>&1; then
            rm -f "$temp_path"
            MIGRATE_TEMP_PATH=""
            echo "❌ sing-box 配置校验失败，已中止迁移" >&2
            return 1
        fi
    fi

    if [ -n "${BACKUP_DIR:-}" ] && [ -d "${BACKUP_DIR:-}" ]; then
        install -m 600 "$config_path" "$BACKUP_DIR/singbox-config.json"
    fi
    chmod 600 "$temp_path"
    mv -f "$temp_path" "$config_path"
    MIGRATE_TEMP_PATH=""
    SINGBOX_MIGRATED=1
    return 0
}

proxy_listener_ready() {
    local service_pid="${KUI_PROXY_SERVICE_PID:-}"
    local require_service_pid="${KUI_REQUIRE_SERVICE_PID:-0}"
    if [ -z "$service_pid" ]; then
        if [ "$INIT_SYS" = "systemd" ]; then
            require_service_pid=1
            service_pid=$(systemctl show -p MainPID --value proxy-lite 2>/dev/null || true)
        elif [ "$INIT_SYS" = "openrc" ]; then
            require_service_pid=1
            if [ -f "${KUI_PROXY_PIDFILE:-/run/proxy-lite.pid}" ]; then
                service_pid=$(cat "${KUI_PROXY_PIDFILE:-/run/proxy-lite.pid}" 2>/dev/null || true)
            fi
        fi
    fi
    KUI_RESOLVED_SERVICE_PID="$service_pid" \
    KUI_REQUIRE_SERVICE_PID="$require_service_pid" \
    python3 - <<'PY'
import ipaddress
import json
import os
import sys

proc_root = os.environ.get("KUI_PROC_DIR") or "/proc"
if not os.path.isdir(proc_root):
    sys.exit(1)

def parse_positive_int(raw):
    try:
        val = int(str(raw or "").strip())
        return val if val > 0 else None
    except ValueError:
        return None

service_pid = parse_positive_int(os.environ.get("KUI_RESOLVED_SERVICE_PID"))
if os.environ.get("KUI_REQUIRE_SERVICE_PID") == "1" and service_pid is None:
    sys.exit(1)
expected_port = parse_positive_int(os.environ.get("KUI_PROXY_PORT"))
expected_host = (os.environ.get("KUI_PROXY_HOST") or "").strip()
state_path = os.environ.get("KUI_PROXY_LISTENER_STATE") or "/opt/proxy_lite/.listener-state.json"
state_data = None
if state_path and os.path.isfile(state_path):
    try:
        with open(state_path, "r", encoding="utf-8") as state_file:
            loaded = json.load(state_file)
        if isinstance(loaded, dict):
            state_data = loaded
    except (OSError, ValueError):
        state_data = None

if state_data is not None:
    if state_data.get("ipv4_bound") is not True:
        sys.exit(1)
    if expected_port is None:
        expected_port = parse_positive_int(state_data.get("port"))
    if not expected_host:
        expected_host = str(state_data.get("host") or "").strip()

def host_matches_ipv4(local_hex, target_host):
    if not target_host or target_host in {"0.0.0.0", "::", "*"}:
        return local_hex == "00000000" if target_host in {"0.0.0.0", "::", "*"} else True
    if target_host.lower() == "localhost":
        target_host = "127.0.0.1"
    try:
        addr = ipaddress.IPv4Address(target_host)
        packed = addr.packed
        expected_hex = "".join(f"{octet:02X}" for octet in reversed(packed))
        return local_hex in {expected_hex, "00000000"}
    except ValueError:
        return False

def belongs_to_service(pid_int, target_pid):
    if target_pid is None:
        return True
    seen = set()
    current = pid_int
    while current and current not in seen:
        if current == target_pid:
            return True
        seen.add(current)
        status_path = os.path.join(proc_root, str(current), "status")
        parent = None
        try:
            with open(status_path, "r", encoding="utf-8", errors="ignore") as status_file:
                for line in status_file:
                    if line.startswith("PPid:"):
                        parent = parse_positive_int(line.split(":", 1)[1])
                        break
        except OSError:
            break
        current = parent
    return False

state_pid = parse_positive_int(state_data.get("pid")) if state_data is not None else None

for entry in os.listdir(proc_root):
    if not entry.isdigit():
        continue
    pid_int = int(entry)
    if state_pid is not None and pid_int != state_pid:
        continue
    if not belongs_to_service(pid_int, service_pid):
        continue
    pid_dir = os.path.join(proc_root, entry)
    try:
        with open(os.path.join(pid_dir, "cmdline"), "rb") as cmd_file:
            cmdline = cmd_file.read().replace(b"\x00", b" ").decode("utf-8", "ignore")
    except OSError:
        continue
    if "/opt/proxy_lite/lite_manager.py" not in cmdline:
        continue
    inodes = set()
    fd_dir = os.path.join(pid_dir, "fd")
    try:
        for fd_name in os.listdir(fd_dir):
            try:
                target = os.readlink(os.path.join(fd_dir, fd_name))
            except OSError:
                continue
            if target.startswith("socket:[") and target.endswith("]"):
                inodes.add(target[8:-1])
    except OSError:
        continue
    if not inodes:
        continue
    net_path = os.path.join(pid_dir, "net", "tcp")
    if not os.path.exists(net_path):
        continue
    try:
        with open(net_path, "r", encoding="utf-8", errors="ignore") as net_file:
            next(net_file, None)
            for line in net_file:
                parts = line.split()
                if len(parts) < 10 or parts[3] != "0A" or parts[9] not in inodes:
                    continue
                local_addr_parts = parts[1].split(":")
                if len(local_addr_parts) != 2:
                    continue
                local_ip_hex = local_addr_parts[0].upper()
                local_port = int(local_addr_parts[1], 16)
                if expected_port is not None and local_port != expected_port:
                    continue
                if not host_matches_ipv4(local_ip_hex, expected_host):
                    continue
                sys.exit(0)
    except (OSError, ValueError):
        continue
sys.exit(1)
PY
}

wait_for_proxy_listener() {
    local timeout_sec="${1:-${KUI_LISTENER_WAIT_SECONDS:-90}}"
    local attempt
    for attempt in $(seq 1 "$timeout_sec"); do
        if [ "$INIT_SYS" = "systemd" ]; then
            systemctl is-active --quiet proxy-lite || { sleep 1; continue; }
        elif [ "$INIT_SYS" = "openrc" ]; then
            rc-service proxy-lite --quiet status || { sleep 1; continue; }
        fi
        if proxy_listener_ready; then
            echo "[+] 住宅代理监听端口已由 proxy-lite 接管。"
            return 0
        fi
        sleep 1
    done
    echo "❌ 住宅代理监听端口在 ${timeout_sec} 秒内未就绪" >&2
    return 1
}

install_service() {
    echo "[3/4] 配置系统守护服务..."
    install -d -m 700 /etc/proxy-lite
    umask 077
    WEB_USER_B64=$(printf '%s' "${WEB_USER:-admin}" | base64 | tr -d '\n')
    WEB_PASS_B64=$(printf '%s' "${WEB_PASS:-}" | base64 | tr -d '\n')
    PROXY_USER_B64=$(printf '%s' "${PROXY_USER:-}" | base64 | tr -d '\n')
    PROXY_PASS_B64=$(printf '%s' "${PROXY_PASS:-}" | base64 | tr -d '\n')
    if [ "$CONTROLLER" = "$DOMAIN" ]; then C2_API_PREFIX="/api/proxy"; else C2_API_PREFIX="/api"; fi
    cat > /etc/proxy-lite/env << EOF
C2_URL="${CONTROLLER}"
UPDATE_ORIGIN="${DOMAIN}"
C2_API_PREFIX="${C2_API_PREFIX}"
WEB_USER_B64="${WEB_USER_B64}"
WEB_PASS_B64="${WEB_PASS_B64}"
PROXY_USER_B64="${PROXY_USER_B64}"
PROXY_PASS_B64="${PROXY_PASS_B64}"
AGENT_TOKEN="${AGENT_TOKEN}"
VPS_IP="${VPS_IP}"
REALTIME_URL="${REALTIME_URL:-}"
PYTHONIOENCODING="utf-8"
LANG="C.UTF-8"
EOF
    chmod 600 /etc/proxy-lite/env
    umask 022
    cat > /opt/proxy_lite/run-proxy.sh <<'EOF'
#!/bin/sh
set -u
child_pid=""
stopping=0
forward_stop() {
    stopping=1
    if [ -n "$child_pid" ]; then
        kill -TERM "$child_pid" 2>/dev/null || true
        wait "$child_pid" 2>/dev/null || true
    fi
    exit 0
}
trap forward_stop TERM INT
while true; do
    /usr/bin/python3 -u /opt/proxy_lite/lite_manager.py &
    child_pid=$!
    wait "$child_pid"
    status=$?
    child_pid=""
    if [ "$stopping" -eq 1 ]; then
        exit 0
    fi
    if [ -f /opt/proxy_lite/.update-pending ]; then
        echo "[launcher] residential update failed; restoring last-good" >&2
        for file in lite_manager.py proxy_server.py realtime_client.py; do [ ! -f "/opt/proxy_lite/$file.last-good" ] || cp -f "/opt/proxy_lite/$file.last-good" "/opt/proxy_lite/$file"; done
        rm -f /opt/proxy_lite/.update-pending
        continue
    fi
    exit "$status"
done
EOF
    chmod 700 /opt/proxy_lite/run-proxy.sh

    stop_stale_proxy_processes() {
        pkill -TERM -f "/opt/proxy_lite/lite_manager\.py" >/dev/null 2>&1 || true
        pkill -TERM -f "python3 -u lite_manager\.py" >/dev/null 2>&1 || true
        for _ in $(seq 1 5); do
            if ! pgrep -f "lite_manager\.py" >/dev/null 2>&1; then
                break
            fi
            sleep 1
        done
        pkill -KILL -f "/opt/proxy_lite/lite_manager\.py" >/dev/null 2>&1 || true
        pkill -KILL -f "python3 -u lite_manager\.py" >/dev/null 2>&1 || true
        pkill -f "openvpn.*tun_main" >/dev/null 2>&1 || true
        pkill -f "openvpn.*tun_backup" >/dev/null 2>&1 || true
        rm -f /opt/proxy_lite/.listener-state.json /opt/proxy_lite/run.sh
    }

    if [ "$INIT_SYS" = "systemd" ]; then
        SERVICE_FILE="/etc/systemd/system/proxy-lite.service"
        cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Proxy Core Engine (Active-Standby)
After=network.target

[Service]
Type=simple
EnvironmentFile=/etc/proxy-lite/env
WorkingDirectory=/opt/proxy_lite
ExecStart=/opt/proxy_lite/run-proxy.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
        install -d -m 755 /etc/systemd/system/kui-agent.service.d
        cat > /etc/systemd/system/kui-agent.service.d/proxy-lite.conf << 'EOF'
[Unit]
After=proxy-lite.service
EOF
        systemctl daemon-reload
        systemctl enable proxy-lite.service
        systemctl stop proxy-lite.service 2>/dev/null || true
        stop_stale_proxy_processes
        systemctl restart proxy-lite.service
        echo "[+] 引擎更新成功！主备双活通道、异步刷IP逻辑已全量加载。"
    elif [ "$INIT_SYS" = "openrc" ]; then
        rc-service proxy-lite stop 2>/dev/null || true
        stop_stale_proxy_processes

        cp /etc/proxy-lite/env /etc/conf.d/proxy-lite
        chmod 600 /etc/conf.d/proxy-lite
        : > /var/log/proxy-lite.log
        chmod 600 /var/log/proxy-lite.log
        cat > /etc/init.d/proxy-lite << 'EOF'
#!/sbin/openrc-run
name="proxy-lite"
description="Proxy Core Engine (Active-Standby)"
supervisor="supervise-daemon"
pidfile="/run/proxy-lite.pid"
        command="/opt/proxy_lite/run-proxy.sh"
        command_args=""
respawn_delay=3
respawn_max=0
output_log="/var/log/proxy-lite.log"
error_log="/var/log/proxy-lite.log"
directory="/opt/proxy_lite"
start_pre() {
    set -a
    . /etc/proxy-lite/env
    set +a
}
depend() {
    need net
    after firewall
}
EOF
        chmod +x /etc/init.d/proxy-lite
        rc-update add proxy-lite default >/dev/null 2>&1 || true
        rc-service proxy-lite restart
        echo "[+] OpenRC 服务安装完成。"
        echo "    手动管理: rc-service proxy-lite start|stop|restart"
        echo "    查看日志: tail -f /var/log/proxy-lite.log"
    else
        cat > /opt/proxy_lite/run.sh << 'EOF'
#!/bin/sh
set -a
. /etc/proxy-lite/env
set +a
cd /opt/proxy_lite
exec python3 -u lite_manager.py
EOF
        chmod 700 /opt/proxy_lite/run.sh
        echo "[+] 未检测到标准初始化系统，启动脚本已创建: /opt/proxy_lite/run.sh"
        echo "    请运行: /opt/proxy_lite/run.sh"
    fi
}

main() {
    parse_args "$@"
    acquire_installer_lock
    trap release_installer_lock EXIT
    INSTALL_SUCCESS=0
    ROLLBACK_DONE=0
    SINGBOX_MIGRATED=0
    ORIG_PROXY_ACTIVE=0
    ORIG_AGENT_ACTIVE=0
    ORIG_SINGBOX_ACTIVE=0
    ORIG_PROXY_ENABLED=0
    if [ "$INIT_SYS" = "systemd" ]; then
        systemctl is-active --quiet proxy-lite >/dev/null 2>&1 && ORIG_PROXY_ACTIVE=1 || true
        systemctl is-active --quiet kui-agent >/dev/null 2>&1 && ORIG_AGENT_ACTIVE=1 || true
        systemctl is-active --quiet sing-box >/dev/null 2>&1 && ORIG_SINGBOX_ACTIVE=1 || true
        systemctl is-enabled --quiet proxy-lite >/dev/null 2>&1 && ORIG_PROXY_ENABLED=1 || true
    elif [ "$INIT_SYS" = "openrc" ]; then
        rc-service proxy-lite --quiet status >/dev/null 2>&1 && ORIG_PROXY_ACTIVE=1 || true
        rc-service kui-agent --quiet status >/dev/null 2>&1 && ORIG_AGENT_ACTIVE=1 || true
        rc-service sing-box --quiet status >/dev/null 2>&1 && ORIG_SINGBOX_ACTIVE=1 || true
        [ -e /etc/runlevels/default/proxy-lite ] && ORIG_PROXY_ENABLED=1 || true
    fi
    BACKUP_DIR=$(mktemp -d /tmp/kui-proxy-backup.XXXXXX)
    chmod 700 "$BACKUP_DIR"
    BACKUP_ITEMS=""
    for item in opt/proxy_lite etc/proxy-lite etc/systemd/system/proxy-lite.service etc/systemd/system/kui-agent.service.d/proxy-lite.conf etc/init.d/proxy-lite etc/conf.d/proxy-lite; do
        [ ! -e "/$item" ] || BACKUP_ITEMS="$BACKUP_ITEMS $item"
    done
    [ -z "$BACKUP_ITEMS" ] || tar -C / -czf "$BACKUP_DIR/proxy.tgz" $BACKUP_ITEMS
    rollback_proxy_install() {
        status=$?
        [ "$ROLLBACK_DONE" -eq 0 ] || exit "$status"
        ROLLBACK_DONE=1
        [ -z "${MIGRATE_TEMP_PATH:-}" ] || rm -f "$MIGRATE_TEMP_PATH" 2>/dev/null || true
        rm -f /opt/proxy_lite/*.staged /opt/proxy_lite/*.download /opt/proxy_lite/*.headers 2>/dev/null || true
        if [ "$INSTALL_SUCCESS" -ne 1 ]; then
            echo "❌ 住宅组件安装失败，正在恢复上一个可用版本..."
            if [ "$INIT_SYS" = "systemd" ]; then systemctl stop proxy-lite >/dev/null 2>&1 || true
            elif [ "$INIT_SYS" = "openrc" ]; then rc-service proxy-lite stop >/dev/null 2>&1 || true; fi
            rm -rf /opt/proxy_lite /etc/proxy-lite
            rm -f /etc/systemd/system/proxy-lite.service /etc/systemd/system/kui-agent.service.d/proxy-lite.conf /etc/init.d/proxy-lite /etc/conf.d/proxy-lite
            [ ! -f "$BACKUP_DIR/proxy.tgz" ] || tar -C / -xzf "$BACKUP_DIR/proxy.tgz"
            if [ -f "$BACKUP_DIR/singbox-config.json" ]; then
                install -m 600 "$BACKUP_DIR/singbox-config.json" "${KUI_SINGBOX_CONF_PATH:-/etc/sing-box/config.json}" 2>/dev/null || true
                chmod 600 "${KUI_SINGBOX_CONF_PATH:-/etc/sing-box/config.json}" 2>/dev/null || true
                if [ "$ORIG_SINGBOX_ACTIVE" -eq 1 ]; then
                    if [ "$INIT_SYS" = "systemd" ]; then systemctl restart sing-box >/dev/null 2>&1 || true
                    elif [ "$INIT_SYS" = "openrc" ]; then rc-service sing-box restart >/dev/null 2>&1 || true; fi
                fi
            fi
            if [ "$INIT_SYS" = "systemd" ]; then
                systemctl daemon-reload >/dev/null 2>&1 || true
                if [ "$ORIG_PROXY_ENABLED" -eq 1 ]; then systemctl enable proxy-lite >/dev/null 2>&1 || true; else systemctl disable proxy-lite >/dev/null 2>&1 || true; fi
                [ "$ORIG_PROXY_ACTIVE" -ne 1 ] || systemctl start proxy-lite >/dev/null 2>&1 || true
                [ "$ORIG_AGENT_ACTIVE" -ne 1 ] || systemctl start kui-agent >/dev/null 2>&1 || true
                [ "$ORIG_PROXY_ACTIVE" -eq 1 ] || systemctl stop proxy-lite >/dev/null 2>&1 || true
            elif [ "$INIT_SYS" = "openrc" ]; then
                if [ "$ORIG_PROXY_ENABLED" -eq 1 ]; then rc-update add proxy-lite default >/dev/null 2>&1 || true; else rc-update del proxy-lite default >/dev/null 2>&1 || true; fi
                [ "$ORIG_PROXY_ACTIVE" -ne 1 ] || rc-service proxy-lite start >/dev/null 2>&1 || true
                [ "$ORIG_AGENT_ACTIVE" -ne 1 ] || rc-service kui-agent start >/dev/null 2>&1 || true
                [ "$ORIG_PROXY_ACTIVE" -eq 1 ] || rc-service proxy-lite stop >/dev/null 2>&1 || true
            fi
        fi
        rm -rf "$BACKUP_DIR"
        release_installer_lock
        exit "$status"
    }
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap rollback_proxy_install EXIT

    install_dependencies
    setup_sysctl
    setup_tun
    download_agents
    if [ "$ORIG_AGENT_ACTIVE" -eq 1 ]; then
        if [ "$INIT_SYS" = "systemd" ]; then
            systemctl stop kui-agent >/dev/null 2>&1 || true
        elif [ "$INIT_SYS" = "openrc" ]; then
            rc-service kui-agent stop >/dev/null 2>&1 || true
        fi
    fi
    stop_stale_agent_processes
    migrate_singbox_residential_inbound
    if [ "$SINGBOX_MIGRATED" -eq 1 ] && [ "$ORIG_SINGBOX_ACTIVE" -eq 1 ]; then
        if [ "$INIT_SYS" = "systemd" ]; then
            systemctl restart sing-box
        elif [ "$INIT_SYS" = "openrc" ]; then
            rc-service sing-box restart
        fi
    fi
    install_service
    wait_for_proxy_listener "${KUI_LISTENER_WAIT_SECONDS:-90}"
    echo "[*] 等待住宅代理主通道就绪..."
    PROXY_READY=0
    for _ in $(seq 1 90); do
        if { [ "$INIT_SYS" = "systemd" ] && systemctl is-active --quiet proxy-lite; } || { [ "$INIT_SYS" = "openrc" ] && rc-service proxy-lite --quiet status; }; then
            if ip link show tun_main >/dev/null 2>&1 || ip link show tun_backup >/dev/null 2>&1; then
                PROXY_READY=1
                break
            fi
        fi
        sleep 1
    done
    if [ "$PROXY_READY" -eq 1 ]; then
        echo "[+] 住宅代理隧道已就绪，继续启动 Agent。"
    else
        echo "⚠️ 住宅代理在 90 秒内未就绪；Agent 将继续启动并等待后续自动重试。"
    fi
    if [ "$ORIG_AGENT_ACTIVE" -eq 1 ]; then
        if [ "$INIT_SYS" = "systemd" ]; then
            systemctl start kui-agent 2>/dev/null || true
        elif [ "$INIT_SYS" = "openrc" ]; then
            rc-service kui-agent start 2>/dev/null || true
        fi
    fi
    if [ "$ORIG_SINGBOX_ACTIVE" -eq 1 ]; then
        for _ in $(seq 1 30); do
            if [ "$INIT_SYS" = "systemd" ] && systemctl is-active --quiet sing-box; then break; fi
            if [ "$INIT_SYS" = "openrc" ] && rc-service sing-box --quiet status; then break; fi
            sleep 1
        done
    fi
    INSTALL_SUCCESS=1
    rm -rf "$BACKUP_DIR"
    release_installer_lock
    trap - EXIT INT TERM

    echo ""
    echo "=========================================================="
    echo "[+] 住宅IP代理引擎部署完成！"
    echo "=========================================================="
    if [ "$INIT_SYS" = "systemd" ]; then
        echo "    检查状态: systemctl status proxy-lite"
        echo "    查看日志: journalctl -u proxy-lite -f"
    elif [ "$INIT_SYS" = "openrc" ]; then
        echo "    检查状态: rc-service proxy-lite status"
        echo "    查看日志: tail -f /var/log/proxy-lite.log"
    else
        echo "    检查进程: ps | grep lite_manager.py"
        echo "    启动脚本: /opt/proxy_lite/run.sh"
    fi
    echo "=========================================================="
}

if [ "${KUI_PROXY_INSTALLER_LIB_ONLY:-0}" != "1" ]; then
    main "$@"
fi
