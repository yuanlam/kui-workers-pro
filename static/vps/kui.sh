#!/bin/sh

set -eu

# ==========================================
# KUI Serverless 集群节点 - 智能跨系统安装脚本 (工业级加固版)
# 支持: Ubuntu 18-24 / Debian 10-13 / Alpine Linux
# ==========================================

API_URL=""; VPS_IP=""; TOKEN=""; PROXY_API_URL=""; BOOTSTRAP=""
SING_BOX_URL="${KUI_SING_BOX_URL:-}"
GITHUB_PROXY="${KUI_GITHUB_PROXY:-}"

while [ "$#" -gt 0 ]; do
    case $1 in
        --api) [ "$#" -ge 2 ] || { echo "--api 缺少参数"; exit 1; }; API_URL="$2"; shift ;;
        --ip) [ "$#" -ge 2 ] || { echo "--ip 缺少参数"; exit 1; }; VPS_IP="$2"; shift ;;
        --token) [ "$#" -ge 2 ] || { echo "--token 缺少参数"; exit 1; }; TOKEN="$2"; shift ;;
        --bootstrap) [ "$#" -ge 2 ] || { echo "--bootstrap 缺少参数"; exit 1; }; BOOTSTRAP="$2"; shift ;;
        --proxy-api) [ "$#" -ge 2 ] || { echo "--proxy-api 缺少参数"; exit 1; }; PROXY_API_URL="$2"; shift ;;
        --sing-box-url) [ "$#" -ge 2 ] || { echo "--sing-box-url 缺少参数"; exit 1; }; SING_BOX_URL="$2"; shift ;;
        --github-proxy) [ "$#" -ge 2 ] || { echo "--github-proxy 缺少参数"; exit 1; }; GITHUB_PROXY="$2"; shift ;;
        *) echo "未知参数: $1"; exit 1 ;;
    esac
    shift
done

if [ -z "$API_URL" ] || [ -z "$VPS_IP" ] || { [ -z "$TOKEN" ] && [ -z "$BOOTSTRAP" ]; }; then
    echo "❌ 错误: 缺少必要参数！"
    exit 1
fi

if [ -n "$BOOTSTRAP" ]; then
    BOOTSTRAP_HEADERS=$(mktemp /tmp/kui-bootstrap.XXXXXX)
    trap 'rm -f "$BOOTSTRAP_HEADERS"' EXIT INT TERM
    curl -fsSL --retry 3 -D "$BOOTSTRAP_HEADERS" -H "Authorization: Bootstrap ${BOOTSTRAP}" "${API_URL}/api/agent_update?ip=${VPS_IP}&component=full-installer&exchange=1" -o /dev/null
    TOKEN=$(tr -d '\r' < "$BOOTSTRAP_HEADERS" | awk '/^[Xx]-[Aa]gent-[Tt]oken:/ {print $2}' | tail -n 1)
    rm -f "$BOOTSTRAP_HEADERS"
    trap - EXIT INT TERM
    [ -n "$TOKEN" ] || { echo "❌ 一次性引导令牌无效或已过期"; exit 1; }
fi

case "$API_URL" in https://*) ;; *) echo "❌ --api 必须使用 https://"; exit 1 ;; esac
case "$API_URL" in *'@'*|*'#'*) echo "❌ --api 不能包含用户信息或 fragment"; exit 1 ;; esac
if [ -n "$PROXY_API_URL" ]; then
    case "$PROXY_API_URL" in https://*) ;; *) echo "❌ --proxy-api 必须使用 https://"; exit 1 ;; esac
fi
if [ -n "$SING_BOX_URL" ]; then
    case "$SING_BOX_URL" in https://*) ;; *) echo "❌ --sing-box-url 必须使用 https://"; exit 1 ;; esac
    case "$SING_BOX_URL" in *'@'*|*'#'*) echo "❌ --sing-box-url 不能包含用户信息或 fragment"; exit 1 ;; esac
fi
if [ -n "$GITHUB_PROXY" ]; then
    case "$GITHUB_PROXY" in https://*) ;; *) echo "❌ --github-proxy 必须使用 https://"; exit 1 ;; esac
    case "$GITHUB_PROXY" in *'@'*|*'#'*) echo "❌ --github-proxy 不能包含用户信息或 fragment"; exit 1 ;; esac
fi

if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS="${ID:-}"
else
    echo "❌ 无法识别操作系统，脚本退出。"
    exit 1
fi

case "$OS" in
    alpine|debian|ubuntu) ;;
    *) echo "不支持的发行版: $OS"; exit 1 ;;
esac

detect_init_system() {
    if [ -d /run/systemd/system ] && [ "$(cat /proc/1/comm 2>/dev/null || true)" = "systemd" ] && command -v systemctl >/dev/null 2>&1; then echo systemd
    elif [ -x /sbin/openrc-run ] && command -v rc-service >/dev/null 2>&1; then echo openrc
    else echo none; fi
}
INIT_SYS=$(detect_init_system)
[ "$INIT_SYS" != none ] || { echo "❌ 需要正在运行的 systemd 或 OpenRC"; exit 1; }

INSTALL_SUCCESS=0
ROLLBACK_DONE=0
LOCK_OWNED=0
INSTALLER_LOCK_DIR="${KUI_INSTALLER_LOCK_DIR:-/run/kui-installer.lock.d}"
is_stale_lock_dir() {
    [ -n "$(find "$1" -maxdepth 0 -mmin +1 2>/dev/null || true)" ]
}
_write_installer_lock_pid() {
    lock_dir="$1"
    owner_pid="$2"
    if printf '%s\n' "$owner_pid" > "$lock_dir/pid.tmp" && mv -f "$lock_dir/pid.tmp" "$lock_dir/pid"; then
        return 0
    fi
    rm -rf "$lock_dir" 2>/dev/null || true
    echo "❌ 写入安装锁 PID 失败"
    return 1
}
_acquire_installer_lock_critical() {
    lock_dir="$1"
    owner_pid="$2"
    reclaim_dir="${lock_dir}.reclaim"
    if mkdir "$lock_dir" 2>/dev/null; then
        _write_installer_lock_pid "$lock_dir" "$owner_pid" || return 1
        rm -rf "$reclaim_dir" 2>/dev/null || true
        return 0
    fi
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
    lock_dir="$1"
    owner_pid="$2"
    if [ "$(cat "$lock_dir/pid" 2>/dev/null || true)" = "$owner_pid" ]; then
        rm -rf "$lock_dir"
    fi
}
_with_installer_lock_mutex() {
    op="$1"
    owner_pid="$2"
    lock_mutex="${INSTALLER_LOCK_DIR}.mutex"
    if command -v flock >/dev/null 2>&1; then
        (
            locked=0
            i=0
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
    lock_parent=$(dirname "$INSTALLER_LOCK_DIR")
    if [ ! -d "$lock_parent" ] || [ ! -w "$lock_parent" ]; then
        INSTALLER_LOCK_DIR="/tmp/kui-installer.lock.d"
    fi
    if _with_installer_lock_mutex acquire "$$"; then
        LOCK_OWNED=1
        export KUI_INSTALLER_LOCK_HELD=1
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
acquire_installer_lock
trap release_installer_lock EXIT
ORIG_AGENT_ACTIVE=0
ORIG_SINGBOX_ACTIVE=0
ORIG_PROXY_ACTIVE=0
ORIG_AGENT_ENABLED=0
ORIG_SINGBOX_ENABLED=0
ORIG_PROXY_ENABLED=0
ORIG_MTPROXY_ACTIVE=""
ORIG_MTPROXY_ENABLED=""
if [ "$INIT_SYS" = "openrc" ]; then
    rc-service kui-agent --quiet status >/dev/null 2>&1 && ORIG_AGENT_ACTIVE=1 || true
    rc-service sing-box --quiet status >/dev/null 2>&1 && ORIG_SINGBOX_ACTIVE=1 || true
    rc-service proxy-lite --quiet status >/dev/null 2>&1 && ORIG_PROXY_ACTIVE=1 || true
    [ -e /etc/runlevels/default/kui-agent ] && ORIG_AGENT_ENABLED=1 || true
    [ -e /etc/runlevels/default/sing-box ] && ORIG_SINGBOX_ENABLED=1 || true
    [ -e /etc/runlevels/default/proxy-lite ] && ORIG_PROXY_ENABLED=1 || true
    for service in /etc/init.d/kui-mtproxy-*; do
        [ ! -e "$service" ] || {
            svc_name=$(basename "$service")
            rc-service "$svc_name" --quiet status >/dev/null 2>&1 && ORIG_MTPROXY_ACTIVE="$ORIG_MTPROXY_ACTIVE $svc_name" || true
            [ -e "/etc/runlevels/default/$svc_name" ] && ORIG_MTPROXY_ENABLED="$ORIG_MTPROXY_ENABLED $svc_name" || true
        }
    done
else
    systemctl is-active --quiet kui-agent >/dev/null 2>&1 && ORIG_AGENT_ACTIVE=1 || true
    systemctl is-active --quiet sing-box >/dev/null 2>&1 && ORIG_SINGBOX_ACTIVE=1 || true
    systemctl is-active --quiet proxy-lite >/dev/null 2>&1 && ORIG_PROXY_ACTIVE=1 || true
    systemctl is-enabled --quiet kui-agent >/dev/null 2>&1 && ORIG_AGENT_ENABLED=1 || true
    systemctl is-enabled --quiet sing-box >/dev/null 2>&1 && ORIG_SINGBOX_ENABLED=1 || true
    systemctl is-enabled --quiet proxy-lite >/dev/null 2>&1 && ORIG_PROXY_ENABLED=1 || true
    for service in /etc/systemd/system/kui-mtproxy-*.service; do
        [ ! -e "$service" ] || {
            svc_name=$(basename "$service")
            systemctl is-active --quiet "$svc_name" >/dev/null 2>&1 && ORIG_MTPROXY_ACTIVE="$ORIG_MTPROXY_ACTIVE $svc_name" || true
            systemctl is-enabled --quiet "$svc_name" >/dev/null 2>&1 && ORIG_MTPROXY_ENABLED="$ORIG_MTPROXY_ENABLED $svc_name" || true
        }
    done
fi
BACKUP_DIR=$(mktemp -d /tmp/kui-install-backup.XXXXXX)
SB_STAGED_PATH="/usr/bin/.sing-box.kui.$$"
chmod 700 "$BACKUP_DIR"
BACKUP_ITEMS=""
for item in opt/kui etc/sing-box usr/bin/sing-box etc/systemd/system/kui-agent.service etc/systemd/system/kui-agent.service.d/proxy-lite.conf etc/systemd/system/sing-box.service etc/init.d/kui-agent etc/init.d/sing-box opt/proxy_lite etc/proxy-lite etc/systemd/system/proxy-lite.service etc/init.d/proxy-lite etc/conf.d/proxy-lite; do
    [ ! -e "/$item" ] || BACKUP_ITEMS="$BACKUP_ITEMS $item"
done
for item in /etc/systemd/system/kui-mtproxy-*.service /etc/init.d/kui-mtproxy-*; do
    [ ! -e "$item" ] || BACKUP_ITEMS="$BACKUP_ITEMS ${item#/}"
done
[ -z "$BACKUP_ITEMS" ] || tar -C / -czf "$BACKUP_DIR/system.tgz" $BACKUP_ITEMS

rollback_install() {
    status=$?
    [ "$ROLLBACK_DONE" -eq 0 ] || exit "$status"
    ROLLBACK_DONE=1
    rm -f "$SB_STAGED_PATH"
    if [ "$INSTALL_SUCCESS" -ne 1 ]; then
        echo "❌ 安装未完成，正在恢复上一个可用版本..."
        for service in /etc/systemd/system/kui-mtproxy-*.service; do [ ! -e "$service" ] || systemctl disable --now "$(basename "$service")" >/dev/null 2>&1 || true; done
        for service in /etc/init.d/kui-mtproxy-*; do [ ! -e "$service" ] || { rc-service "$(basename "$service")" stop >/dev/null 2>&1 || true; rc-update del "$(basename "$service")" default >/dev/null 2>&1 || true; }; done
        if [ "$INIT_SYS" = "openrc" ]; then rc-service kui-agent stop >/dev/null 2>&1 || true; rc-service sing-box stop >/dev/null 2>&1 || true; rc-service proxy-lite stop >/dev/null 2>&1 || true
        else systemctl stop kui-agent sing-box proxy-lite >/dev/null 2>&1 || true; fi
        rm -rf /opt/kui /etc/sing-box /opt/proxy_lite /etc/proxy-lite
        rm -f /usr/bin/sing-box /etc/systemd/system/kui-agent.service /etc/systemd/system/kui-agent.service.d/proxy-lite.conf /etc/systemd/system/sing-box.service /etc/systemd/system/proxy-lite.service /etc/systemd/system/kui-mtproxy-*.service /etc/init.d/kui-agent /etc/init.d/sing-box /etc/init.d/proxy-lite /etc/init.d/kui-mtproxy-* /etc/conf.d/proxy-lite
        [ ! -f "$BACKUP_DIR/system.tgz" ] || tar -C / -xzf "$BACKUP_DIR/system.tgz"
        if [ "$INIT_SYS" = "openrc" ]; then
            if [ "$ORIG_PROXY_ENABLED" -eq 1 ]; then rc-update add proxy-lite default >/dev/null 2>&1 || true; else rc-update del proxy-lite default >/dev/null 2>&1 || true; fi
            if [ "$ORIG_SINGBOX_ENABLED" -eq 1 ]; then rc-update add sing-box default >/dev/null 2>&1 || true; else rc-update del sing-box default >/dev/null 2>&1 || true; fi
            if [ "$ORIG_AGENT_ENABLED" -eq 1 ]; then rc-update add kui-agent default >/dev/null 2>&1 || true; else rc-update del kui-agent default >/dev/null 2>&1 || true; fi
            [ "$ORIG_PROXY_ACTIVE" -ne 1 ] || rc-service proxy-lite start >/dev/null 2>&1 || true
            [ "$ORIG_SINGBOX_ACTIVE" -ne 1 ] || rc-service sing-box start >/dev/null 2>&1 || true
            [ "$ORIG_AGENT_ACTIVE" -ne 1 ] || rc-service kui-agent start >/dev/null 2>&1 || true
            [ "$ORIG_PROXY_ACTIVE" -eq 1 ] || rc-service proxy-lite stop >/dev/null 2>&1 || true
            for svc_name in $ORIG_MTPROXY_ENABLED; do rc-update add "$svc_name" default >/dev/null 2>&1 || true; done
            for svc_name in $ORIG_MTPROXY_ACTIVE; do rc-service "$svc_name" start >/dev/null 2>&1 || true; done
        else
            systemctl daemon-reload >/dev/null 2>&1 || true
            if [ "$ORIG_PROXY_ENABLED" -eq 1 ]; then systemctl enable proxy-lite >/dev/null 2>&1 || true; else systemctl disable proxy-lite >/dev/null 2>&1 || true; fi
            if [ "$ORIG_SINGBOX_ENABLED" -eq 1 ]; then systemctl enable sing-box >/dev/null 2>&1 || true; else systemctl disable sing-box >/dev/null 2>&1 || true; fi
            if [ "$ORIG_AGENT_ENABLED" -eq 1 ]; then systemctl enable kui-agent >/dev/null 2>&1 || true; else systemctl disable kui-agent >/dev/null 2>&1 || true; fi
            [ "$ORIG_PROXY_ACTIVE" -ne 1 ] || systemctl start proxy-lite >/dev/null 2>&1 || true
            [ "$ORIG_SINGBOX_ACTIVE" -ne 1 ] || systemctl start sing-box >/dev/null 2>&1 || true
            [ "$ORIG_AGENT_ACTIVE" -ne 1 ] || systemctl start kui-agent >/dev/null 2>&1 || true
            [ "$ORIG_PROXY_ACTIVE" -eq 1 ] || systemctl stop proxy-lite >/dev/null 2>&1 || true
            for svc_name in $ORIG_MTPROXY_ENABLED; do systemctl enable "$svc_name" >/dev/null 2>&1 || true; done
            for svc_name in $ORIG_MTPROXY_ACTIVE; do systemctl start "$svc_name" >/dev/null 2>&1 || true; done
        fi
    fi
    rm -rf "$BACKUP_DIR"
    release_installer_lock
    exit "$status"
}
trap 'exit 130' INT
trap 'exit 143' TERM
trap rollback_install EXIT

echo "=========================================="
echo " 🚀 KUI Agent 智能安装启动中..."
echo " 💻 目标系统: ${OS}"
echo "=========================================="

export CURL_USER_AGENT="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"

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

echo "[1/7] 🧹 正在清理历史残留..."
if [ "$INIT_SYS" = "openrc" ]; then
    for service in /etc/init.d/kui-mtproxy-*; do [ ! -e "$service" ] || { rc-service "$(basename "$service")" stop >/dev/null 2>&1 || true; rc-update del "$(basename "$service")" default >/dev/null 2>&1 || true; }; done
    rc-service kui-agent stop >/dev/null 2>&1 || true
    stop_stale_agent_processes
    rc-service sing-box stop >/dev/null 2>&1 || true
    rc-update del kui-agent default >/dev/null 2>&1 || true
    rc-update del sing-box default >/dev/null 2>&1 || true
    rm -f /etc/init.d/kui-agent /etc/init.d/sing-box /etc/init.d/kui-mtproxy-*
else
    for service in /etc/systemd/system/kui-mtproxy-*.service; do [ ! -e "$service" ] || systemctl disable --now "$(basename "$service")" >/dev/null 2>&1 || true; done
    systemctl stop kui-agent >/dev/null 2>&1 || true
    stop_stale_agent_processes
    systemctl stop sing-box >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/kui-agent.service /etc/systemd/system/kui-mtproxy-*.service
    systemctl daemon-reload >/dev/null 2>&1 || true
fi
rm -rf /opt/kui /etc/sing-box/config.json

echo "[2/7] ⚡ 保留系统现有软件源..."
if [ "$INIT_SYS" = "openrc" ]; then
    :
else
    :
fi

echo "[3/7] 📦 正在安装底层网络依赖..."
ALIYUN_OK=0
if [ "$INIT_SYS" = "openrc" ]; then
    apk update || echo "⚠️ apk update 失败，尝试使用现有缓存安装。"
    apk add python3 py3-websocket-client curl openssl iptables coreutils bash tar libc6-compat gcompat iproute2
else
    if apt-get update -y >/tmp/kui_apt_update.log 2>&1; then
        cat /tmp/kui_apt_update.log
        ALIYUN_OK=1
    else
        cat /tmp/kui_apt_update.log
        echo "⚠️  aliyun 源 apt-get update 失败，回滚到原 sources.list..."
        if [ -f /etc/apt/sources.list.bak ]; then
            mv /etc/apt/sources.list.bak /etc/apt/sources.list
            apt-get update -y || echo "❌ 原 sources.list 也无法更新，请手动检查网络/源配置。"
        else
            echo "❌ 无备份可回滚，请手动修复 /etc/apt/sources.list 或更换镜像源后重试。"
        fi
        exit 1
    fi
    apt-get install -y python3 python3-websocket curl openssl iptables coreutils bash tar iproute2 iputils-ping
fi

echo "[4/7] ⚙️ 部署 Sing-box 代理核心..."
SB_VER="1.13.14"
CURRENT_SB_VER=""
if [ -x /usr/bin/sing-box ]; then
    CURRENT_SB_VER=$(/usr/bin/sing-box version 2>/dev/null | awk 'NR == 1 && $1 == "sing-box" && $2 == "version" {print $3}')
fi

if [ "$CURRENT_SB_VER" = "$SB_VER" ]; then
    echo "✅ 已安装 sing-box ${SB_VER}，跳过下载。"
else
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64) SB_ARCH="amd64" ;;
        aarch64) SB_ARCH="arm64" ;;
        *) echo "不支持的 CPU 架构: $ARCH"; exit 1 ;;
    esac
    SB_SUFFIX="linux-${SB_ARCH}-glibc"
    [ "$OS" = "alpine" ] && SB_SUFFIX="linux-${SB_ARCH}-musl"
    case "$SB_SUFFIX" in
        linux-amd64-glibc) EXPECTED_SHA="aae9172317c61760aae3dafcde889b2e51b7ea590c40d2b3c7ccdeae14b361b6" ;;
        linux-amd64-musl) EXPECTED_SHA="d5b46de6498427bccfeb87dbafcde4dbefdfe35680020d07d286ad915f0bfb34" ;;
        linux-arm64-glibc) EXPECTED_SHA="08d37b2bf12145ec44307333490cecca4c917df054cd8e27a210f8d9cdbe0fd9" ;;
        linux-arm64-musl) EXPECTED_SHA="edec18488af35a93cf8b362063146fdd7b557ef9862710ee77a1f4adb5c70118" ;;
        *) echo "❌ 不支持的 sing-box 构建: $SB_SUFFIX"; exit 1 ;;
    esac

    SB_DOWNLOAD_DIR="$BACKUP_DIR/sing-box-download"
    SB_ARCHIVE="$SB_DOWNLOAD_DIR/sing-box.tar.gz"
    SB_OFFICIAL_URL="https://github.com/SagerNet/sing-box/releases/download/v${SB_VER}/sing-box-${SB_VER}-${SB_SUFFIX}.tar.gz"
    mkdir -p "$SB_DOWNLOAD_DIR"

    download_sing_box() {
        source_url="$1"
        source_name="$2"
        rm -f "$SB_ARCHIVE"
        echo "⏳ 尝试从${source_name}下载 sing-box..."
        if curl -fL --retry 3 --connect-timeout 15 --proto '=https' --proto-redir '=https' -o "$SB_ARCHIVE" -A "$CURL_USER_AGENT" "$source_url"; then
            ACTUAL_SHA=$(sha256sum "$SB_ARCHIVE" | awk '{print $1}')
            if [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ]; then
                echo "✅ ${source_name}下载及 SHA256 校验通过。"
                return 0
            fi
            echo "⚠️ ${source_name}文件 SHA256 不匹配，拒绝使用。"
        else
            echo "⚠️ 无法从${source_name}下载。"
        fi
        rm -f "$SB_ARCHIVE"
        return 1
    }

    DOWNLOAD_OK=0
    if [ -n "$SING_BOX_URL" ]; then
        download_sing_box "$SING_BOX_URL" "自定义镜像" && DOWNLOAD_OK=1 || true
    fi
    if [ "$DOWNLOAD_OK" -eq 0 ] && [ -n "$GITHUB_PROXY" ]; then
        download_sing_box "${GITHUB_PROXY%/}/${SB_OFFICIAL_URL}" "GitHub 代理" && DOWNLOAD_OK=1 || true
    fi
    if [ "$DOWNLOAD_OK" -eq 0 ]; then
        download_sing_box "$SB_OFFICIAL_URL" "GitHub 官方源" && DOWNLOAD_OK=1 || true
    fi
    [ "$DOWNLOAD_OK" -eq 1 ] || { echo "❌ 所有 sing-box 下载来源均失败，请配置私有镜像后重试。"; exit 1; }

    tar -xzf "$SB_ARCHIVE" -C "$SB_DOWNLOAD_DIR"
    SB_EXTRACTED="$SB_DOWNLOAD_DIR/sing-box-${SB_VER}-${SB_SUFFIX}/sing-box"
    test -x "$SB_EXTRACTED"
    cp "$SB_EXTRACTED" "$SB_STAGED_PATH"
    chmod 755 "$SB_STAGED_PATH"
    mv "$SB_STAGED_PATH" /usr/bin/sing-box
    echo "✅ sing-box ${SB_VER} 安装完成。"
fi

echo "[4.5/7] ⚙️ 正在应用网络内核调优（BBR / QUIC / conntrack）..."
if [ "$OS" = "alpine" ]; then
    modprobe -q xt_conntrack 2>/dev/null || true
    sysctl -w net.netfilter.nf_conntrack_max=1048576 >/dev/null 2>&1 || true
    sysctl -w net.core.somaxconn=4096 >/dev/null 2>&1 || true
    sysctl -w net.ipv4.tcp_max_syn_backlog=8192 >/dev/null 2>&1 || true
    sysctl -w net.ipv4.tcp_fastopen=3 >/dev/null 2>&1 || true
else
    cat > /etc/sysctl.d/99-kui-optimize.conf <<'SYSCTL'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.ipv4.tcp_rmem = 4096 87380 67108864
net.ipv4.tcp_wmem = 4096 65536 67108864
net.core.rmem_max = 67108864
net.core.wmem_max = 67108864
net.core.netdev_max_backlog = 5000
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 8192
net.ipv4.tcp_fastopen = 3
net.netfilter.nf_conntrack_max = 1048576
net.netfilter.nf_conntrack_udp_timeout = 60
net.netfilter.nf_conntrack_tcp_timeout_established = 7200
net.netfilter.nf_conntrack_tcp_timeout_time_wait = 30
SYSCTL
    sysctl --system >/dev/null 2>&1 || echo "⚠️ 部分内核参数无法应用，继续安装。"
fi

echo "[5/7] 📂 初始化 KUI 工作目录与环境..."
mkdir -p /opt/kui /etc/sing-box
if [ -f "$BACKUP_DIR/system.tgz" ]; then
    for state_file in egress-state.json traffic-state.json; do
        tar -xOf "$BACKUP_DIR/system.tgz" "opt/kui/$state_file" > "/opt/kui/$state_file" 2>/dev/null || rm -f "/opt/kui/$state_file"
        [ ! -f "/opt/kui/$state_file" ] || chmod 600 "/opt/kui/$state_file"
    done
fi

API_URL="$API_URL" VPS_IP="$VPS_IP" TOKEN="$TOKEN" PROXY_API_URL="${PROXY_API_URL:-}" GITHUB_PROXY="$GITHUB_PROXY" python3 -c 'import json, os; json.dump({"api_url": os.environ["API_URL"] + "/api/config", "report_url": os.environ["API_URL"] + "/api/report", "ip": os.environ["VPS_IP"], "token": os.environ["TOKEN"], "proxy_api": os.environ["PROXY_API_URL"], "github_proxy": os.environ["GITHUB_PROXY"]}, open("/opt/kui/config.json", "w"))'
chmod 600 /opt/kui/config.json

verify_agent_manifest() {
    component="$1"; file="$2"; headers="$3"
    expected_sha=$(tr -d '\r' < "$headers" | awk '/^[Xx]-[Aa]gent-[Ss][Hh][Aa]256:/ {print tolower($2)}' | tail -n 1)
    version=$(tr -d '\r' < "$headers" | awk '/^[Xx]-[Aa]gent-[Mm]anifest-[Vv]ersion:/ {print $2}' | tail -n 1)
    expected_length=$(tr -d '\r' < "$headers" | awk '/^[Xx]-[Aa]gent-[Ll]ength:/ {print $2}' | tail -n 1)
    supplied_mac=$(tr -d '\r' < "$headers" | awk '/^[Xx]-[Aa]gent-[Mm][Aa][Cc]:/ {print tolower($2)}' | tail -n 1)
    actual_sha=$(sha256sum "$file" | awk '{print $1}')
    actual_length=$(wc -c < "$file" | tr -d ' ')
    expected_mac=$(printf 'v1\n%s\n%s\n%s\n' "$component" "$expected_sha" "$actual_length" | openssl dgst -sha256 -mac HMAC -macopt "key:${TOKEN}" | awk '{print tolower($NF)}')
    [ "$version" = "1" ] && [ "$expected_length" = "$actual_length" ] && [ -n "$expected_sha" ] && [ "$expected_sha" = "$actual_sha" ] && [ -n "$supplied_mac" ] && [ "$supplied_mac" = "$expected_mac" ]
}

echo "正在拉取最新版 Agent 执行器..."
AGENT_URL="${API_URL}/api/agent_update?ip=${VPS_IP}&component=agent"
AGENT_TEMP="/opt/kui/agent.py.download"; AGENT_HEADERS="/opt/kui/agent.py.headers"
curl -fsSL --retry 3 --retry-delay 2 -A "$CURL_USER_AGENT" -D "$AGENT_HEADERS" -H "Authorization: ${TOKEN}" "$AGENT_URL" -o "$AGENT_TEMP"
verify_agent_manifest agent "$AGENT_TEMP" "$AGENT_HEADERS" || { echo "❌ agent.py 更新清单校验失败"; exit 1; }
python3 -m py_compile "$AGENT_TEMP"
mv "$AGENT_TEMP" /opt/kui/agent.py
rm -f "$AGENT_HEADERS"
chmod 700 /opt/kui/agent.py

REALTIME_CLIENT_URL="${API_URL}/api/agent_update?ip=${VPS_IP}&component=realtime-client"
REALTIME_CLIENT_TEMP="/opt/kui/realtime_client.py.download"; REALTIME_CLIENT_HEADERS="/opt/kui/realtime_client.py.headers"
curl -fsSL --retry 3 --retry-delay 2 -A "$CURL_USER_AGENT" -D "$REALTIME_CLIENT_HEADERS" -H "Authorization: ${TOKEN}" "$REALTIME_CLIENT_URL" -o "$REALTIME_CLIENT_TEMP"
verify_agent_manifest realtime-client "$REALTIME_CLIENT_TEMP" "$REALTIME_CLIENT_HEADERS" || { echo "❌ realtime_client.py 更新清单校验失败"; exit 1; }
python3 -m py_compile "$REALTIME_CLIENT_TEMP"
mv "$REALTIME_CLIENT_TEMP" /opt/kui/realtime_client.py
rm -f "$REALTIME_CLIENT_HEADERS"
chmod 700 /opt/kui/realtime_client.py

cat > /opt/kui/run-agent.sh <<'EOF'
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
    /usr/bin/python3 /opt/kui/agent.py &
    child_pid=$!
    wait "$child_pid"
    status=$?
    child_pid=""
    if [ "$stopping" -eq 1 ]; then
        exit 0
    fi
    if [ -f /opt/kui/.update-pending ]; then
        echo "[launcher] 新版本启动失败，恢复 last-good 组件" >&2
        [ ! -f /opt/kui/agent.py.last-good ] || cp -f /opt/kui/agent.py.last-good /opt/kui/agent.py
        [ ! -f /opt/kui/realtime_client.py.last-good ] || cp -f /opt/kui/realtime_client.py.last-good /opt/kui/realtime_client.py
        rm -f /opt/kui/.update-pending
        continue
    fi
    exit "$status"
done
EOF
chmod 700 /opt/kui/run-agent.sh

echo "[6/7] 🛡️ 智能注册底层守护进程..."
if [ "$OS" = "alpine" ]; then
    cat > /etc/init.d/kui-agent <<EOF
#!/sbin/openrc-run
description="KUI Serverless Agent"
command="/opt/kui/run-agent.sh"
command_args=""
command_background="yes"
pidfile="/run/kui-agent.pid"
output_log="/var/log/kui-agent.log"
error_log="/var/log/kui-agent.log"
depend() { need net; after proxy-lite; }
EOF
    cat > /etc/init.d/sing-box <<EOF
#!/sbin/openrc-run
description="Sing-box Proxy Service"
command="/usr/bin/sing-box"
command_args="run -c /etc/sing-box/config.json"
command_background="yes"
pidfile="/run/sing-box.pid"
output_log="/var/log/sing-box.log"
error_log="/var/log/sing-box.log"
rc_ulimit="-n 1048576"
depend() { need net; after kui-agent; }
EOF
    chmod +x /etc/init.d/kui-agent /etc/init.d/sing-box
    rc-update add kui-agent default
    rc-update add sing-box default
else
    cat > /etc/systemd/system/kui-agent.service <<EOF
[Unit]
Description=KUI Serverless Agent
After=network.target

[Service]
Type=simple
ExecStart=/opt/kui/run-agent.sh
Restart=always
RestartSec=5
User=root
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable kui-agent
    if command -v sing-box >/dev/null 2>&1; then
        if [ ! -f /etc/systemd/system/sing-box.service ]; then
            cat > /etc/systemd/system/sing-box.service <<EOF
[Unit]
Description=Sing-box Proxy Service
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/sing-box run -c /etc/sing-box/config.json
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF
            systemctl daemon-reload
        fi
        systemctl enable sing-box
    fi
fi

echo "[7/7] 🌐 部署住宅 IP 主备双隧道代理..."
PROXY_INSTALLER_URL="${API_URL}/api/agent_update?ip=${VPS_IP}&component=proxy-installer"
PROXY_INSTALLER_TEMP="/opt/kui/residential-proxy.sh.download"; PROXY_INSTALLER_HEADERS="/opt/kui/residential-proxy.sh.headers"
cleanup_proxy_installer() { rm -f "$PROXY_INSTALLER_TEMP" "$PROXY_INSTALLER_HEADERS"; }
curl -fsSL --retry 3 --retry-delay 2 -A "$CURL_USER_AGENT" -D "$PROXY_INSTALLER_HEADERS" -H "Authorization: ${TOKEN}" "$PROXY_INSTALLER_URL" -o "$PROXY_INSTALLER_TEMP"
EXPECTED_INSTALLER_SHA=$(tr -d '\r' < "$PROXY_INSTALLER_HEADERS" | awk '/^[Xx]-[Aa]gent-[Ss][Hh][Aa]256:/ {print tolower($2)}' | tail -n 1)
verify_agent_manifest proxy-installer "$PROXY_INSTALLER_TEMP" "$PROXY_INSTALLER_HEADERS" || { echo "❌ residential-proxy.sh 更新清单校验失败"; exit 1; }
bash -n "$PROXY_INSTALLER_TEMP"
chmod 700 "$PROXY_INSTALLER_TEMP"
bash "$PROXY_INSTALLER_TEMP" --domain "$API_URL" --controller "${PROXY_API_URL:-$API_URL}" --ip "$VPS_IP" --token "$TOKEN"
cleanup_proxy_installer
if [ "$INIT_SYS" = "openrc" ]; then
    rc-service kui-agent start
else
    systemctl start kui-agent
fi
INSTALL_SUCCESS=1
rm -rf "$BACKUP_DIR"
release_installer_lock
trap - EXIT INT TERM

echo "=========================================="
echo " 🎉 KUI + 住宅 IP 双隧道代理部署成功！"
echo " 节点 IP: ${VPS_IP}"
echo " 系统架构: ${OS}"
echo "=========================================="
