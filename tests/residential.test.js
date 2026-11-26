import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createSqliteD1 } from '../server/d1-sqlite.js';
import { __test, onRequest } from '../functions/api/[[path]].js';

const manager = fs.readFileSync(new URL('../static/vps/lite_manager.py', import.meta.url), 'utf8');
const agent = fs.readFileSync(new URL('../static/vps/agent.py', import.meta.url), 'utf8');
const proxyServer = fs.readFileSync(new URL('../static/vps/proxy_server.py', import.meta.url), 'utf8');
const installer = fs.readFileSync(new URL('../static/vps/residential-proxy.sh', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');
const realtime = fs.readFileSync(new URL('../realtime/src/index.js', import.meta.url), 'utf8');
const frontendState = fs.readFileSync(new URL('../frontend/src/composables/useKuiState.js', import.meta.url), 'utf8');
const { proxyPublicListenerEnabled, sanitizeProxyListenHost, validateProxyReport } = __test;
const { SCHEMA_VERSION } = __test;
const ADMIN_USER = 'admin';
const ADMIN_TOKEN = 'a'.repeat(48);
const ADMIN_PASSWORD = 'test-admin-password';

const ROUTE_SCHEMA = `
CREATE TABLE users (
    username TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    traffic_limit INTEGER DEFAULT 0,
    traffic_used INTEGER DEFAULT 0,
    expire_time INTEGER DEFAULT 0,
    enable INTEGER DEFAULT 1,
    sub_token TEXT
);
CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE sys_config (key TEXT PRIMARY KEY, val TEXT, ts INTEGER);
CREATE TABLE probe_settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE proxy_ctrl_servers (ip TEXT PRIMARY KEY, details TEXT, last_seen INTEGER);
CREATE TABLE servers (
    ip TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    agent_token TEXT,
    egress_mode TEXT NOT NULL DEFAULT 'native',
    egress_applied_mode TEXT NOT NULL DEFAULT 'native',
    egress_revision INTEGER NOT NULL DEFAULT 0,
    egress_applied_revision INTEGER NOT NULL DEFAULT 0,
    egress_status TEXT NOT NULL DEFAULT 'applied',
    egress_error TEXT NOT NULL DEFAULT '',
    egress_applied_at INTEGER NOT NULL DEFAULT 0,
    egress_desired_config TEXT NOT NULL DEFAULT '',
    egress_applied_config TEXT NOT NULL DEFAULT '',
    proxy_mode TEXT DEFAULT 'global',
    proxy_categories TEXT DEFAULT '',
    proxy_custom_domains TEXT DEFAULT '[]',
    egress_ip TEXT DEFAULT '',
    socks5_addr TEXT DEFAULT '',
    socks5_port INTEGER DEFAULT 0,
    socks5_user TEXT DEFAULT '',
    socks5_pass TEXT DEFAULT ''
);
CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    vps_ip TEXT NOT NULL,
    protocol TEXT NOT NULL,
    relay_type TEXT,
    target_id TEXT,
    enable INTEGER DEFAULT 1,
    traffic_used INTEGER DEFAULT 0,
    traffic_limit INTEGER DEFAULT 0,
    expire_time INTEGER DEFAULT 0,
    username TEXT DEFAULT 'admin'
);
`;

async function sha256(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function createProxyDb() {
    const db = createSqliteD1(':memory:');
    await db.exec(ROUTE_SCHEMA);
    await db.prepare("INSERT OR REPLACE INTO sys_config (key, val, ts) VALUES ('schema_version', ?, ?)")
        .bind(String(SCHEMA_VERSION), Date.now())
        .run();
    return db;
}

async function seedSession(db, username, token, enable = 1) {
    await db.prepare('INSERT OR REPLACE INTO users (username, password, enable) VALUES (?, ?, ?)')
        .bind(username, 'unused-password-hash', enable)
        .run();
    await db.prepare('INSERT OR REPLACE INTO auth_sessions (token_hash, username, expires_at) VALUES (?, ?, ?)')
        .bind(await sha256(token), username, Date.now() + 60 * 60 * 1000)
        .run();
}

async function seedServer(db, ip, agentToken = '') {
    await db.prepare('INSERT OR REPLACE INTO servers (ip, name, agent_token) VALUES (?, ?, ?)')
        .bind(ip, `server-${ip}`, agentToken)
        .run();
}

async function seedProxyState(db, ip, details, lastSeen = Date.now()) {
    await db.prepare('INSERT OR REPLACE INTO proxy_ctrl_servers (ip, details, last_seen) VALUES (?, ?, ?)')
        .bind(ip, JSON.stringify(details), lastSeen)
        .run();
}

async function readProxySlot(db, ip) {
    const key = ip ? `proxy_slot_map_${ip}` : 'proxy_slot_map';
    const row = await db.prepare('SELECT value FROM probe_settings WHERE key = ?').bind(key).first();
    return row ? JSON.parse(row.value) : null;
}

async function callApi(db, path, { method = 'GET', token, authorization, body } = {}, envOverrides = {}) {
    const headers = {};
    if (authorization) headers.Authorization = authorization;
    else if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const tasks = [];
    const request = new Request(`https://panel.example${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const response = await onRequest({
        request,
        env: {
            DB: db,
            ADMIN_USERNAME: ADMIN_USER,
            ADMIN_PASSWORD,
            PROXY_USER: 'proxy-user',
            PROXY_PASS: 'proxy-pass',
            ...envOverrides,
        },
        params: { path: path.replace(/^\/api\//, '').split('?')[0].split('/').filter(Boolean) },
        waitUntil: promise => tasks.push(promise),
    });
    const payload = await response.clone().json().catch(() => null);
    await Promise.allSettled(tasks);
    return { response, payload };
}

function vpngateCsv(entries) {
    const rows = entries.map(([ip, country]) => `host-${ip},${ip},10,10,1000,Country,${country},1,1,1,1,1,1,1`);
    return ['*vpn_servers', '#HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64', ...rows].join('\n');
}

test('proxy-lite reports the active tunnel exit IP', () => {
    assert.match(manager, /"node_ip": tun\.egress_ip if tun\.egress_ip else tun\.entry_ip,\s*"exit_ip": tun\.egress_ip if tun\.egress_ip else tun\.entry_ip/);
});

test('Worker accepts legacy residential reports using node_ip as exit fallback', () => {
    assert.match(api, /item\.exit_ip \|\| item\.node_ip/);
    assert.match(api, /const activeExitIp = active\?\.exit_ip \|\| active\?\.node_ip \|\| ''/);
});

test('server cards expose distinct realtime active and standby residential exits', () => {
    const frontend = fs.readFileSync(new URL('../frontend/src/pages/ServersPage.vue', import.meta.url), 'utf8');
    assert.match(api, /const standby = Array\.isArray\(details\) \? details\.find\(item => !item\?\.active/);
    assert.match(api, /server\.residential_standby_exit_ip = standbyExitIp/);
    assert.match(frontend, /当前实时住宅出口/);
    assert.match(frontend, /主 \{\{ vps\.residential_active_exit_ip/);
    assert.match(frontend, /备 \{\{ vps\.residential_standby_exit_ip/);
    assert.match(frontend, /最近验证/);
    assert.match(frontendState, /residential_active_exit_ip: active\?\.exit_ip \|\| active\?\.node_ip/);
    assert.match(frontendState, /residential_standby_exit_ip: standby\?\.exit_ip \|\| standby\?\.node_ip/);
});

test('validates private Docker bridge listener addresses', async () => {
    assert.equal(sanitizeProxyListenHost('172.17.0.1'), '172.17.0.1');
    assert.equal(sanitizeProxyListenHost(''), '');
    assert.equal(sanitizeProxyListenHost('172.999.0.1'), null);
    assert.equal(sanitizeProxyListenHost('host.docker.internal'), null);
});

test('per-VPS public listener setting overrides the deployment default', () => {
    assert.equal(proxyPublicListenerEnabled({}, { PROXY_PUBLIC_LISTENER: 'true' }), true);
    assert.equal(proxyPublicListenerEnabled({}, { PROXY_PUBLIC_LISTENER: 'false' }), false);
    assert.equal(proxyPublicListenerEnabled({ public_listener: false }, { PROXY_PUBLIC_LISTENER: 'true' }), false);
    assert.equal(proxyPublicListenerEnabled({ public_listener: true }, { PROXY_PUBLIC_LISTENER: 'false' }), true);
    assert.match(api, /server\.proxy_public_listener = proxyPublicListenerEnabled\(slotConfig, env\)/);
    assert.match(api, /server\.proxy_public_port =/);
    assert.match(api, /if \(!proxyPublicListenerEnabled\(slotConfig, env\)\) continue/);
    assert.match(api, /public_listener must be boolean/);
    assert.match(api, /PROXY_USER and PROXY_PASS must be configured before enabling public listener/);
});

test('rejects markup in proxy report IP fields', () => {
    const report = validateProxyReport({
        ip: '203.0.113.8',
        details: [{ tunnel: 'tun_main', active: true, country: 'JP', port: 7920, node_ip: '</pre><script>alert(1)</script>' }],
    });
    assert.equal(report.details[0].node_ip, '');
    assert.equal(report.details[0].exit_ip, '');
});

test('proxy-lite keeps realtime heartbeats responsive during HTTP mirror stalls', () => {
    assert.match(manager, /submit_http_report\(status, background=True\)/);
    assert.match(manager, /last_http_report_attempt = time\.time\(\)/);
    assert.match(manager, /time\.time\(\) - last_http_report_attempt >= REALTIME_HTTP_INTERVAL/);
    assert.match(manager, /C2_REQUEST_TIMEOUT = 12/);
});

test('proxy-lite rate limits repeated control-plane and reservoir log noise', () => {
    assert.match(manager, /record_control_failure\("report", error, realtime_ok=realtime_ok\)/);
    assert.match(manager, /if reservoir_count != last_reservoir_log_count:/);
});

test('realtime proxy status refreshes the residential availability record', () => {
    assert.match(realtime, /persistProxyStatus\(attachment\.ip, nextRoleState, attachment\.lastSeen, criticalChange\)/);
    assert.match(realtime, /INSERT INTO proxy_ctrl_servers/);
    assert.match(realtime, /INSERT INTO server_logs/);
});

test('residential apply failures include the controller readiness reason', () => {
    assert.match(agent, /residential\.get\("reason"\)/);
});

test('residential data-plane verification follows the sing-box business route', () => {
    assert.match(api, /const residentialAddr = listenHost \|\| '127\.0\.0\.1'/);
    assert.match(api, /addr: residentialAddr[\s\S]{0,120}check_addr: residentialAddr/);
    assert.match(agent, /residential_addr == "127\.0\.0\.1" and egress_check_host != "127\.0\.0\.1"/);
    assert.match(agent, /"addr": residential_addr, "check_addr": egress_check_host/);
    assert.match(agent, /apply_global_proxy_route\(singbox_config\["route"\], valid_nodes, s5_tag\)/);
    assert.match(agent, /route\["final"\] = outbound_tag/);
    assert.match(agent, /_verify_socks5_exit\(egress_check_host, require_distinct_exit=True\)/);
    assert.match(agent, /not require_distinct_exit or ip != VPS_IP/);
    assert.doesNotMatch(agent, /def _verify_residential_exit/);
});

test('residential landing server resolves domains through its active tunnel', () => {
    assert.match(proxyServer, /def resolve_on_landing\(host: str, port: int, interface: str\)/);
    assert.match(proxyServer, /dns_socket\.setsockopt\(socket\.SOL_SOCKET, SO_BINDTODEVICE, interface\.encode\("utf-8"\)\)/);
    assert.match(proxyServer, /addrinfos = resolve_on_landing\(host, port, bind_interface\)/);
    assert.doesNotMatch(proxyServer, /socket\.getaddrinfo\(host, port/);
    assert.match(proxyServer, /flags & 0x0200/);
    assert.match(proxyServer, /socket\.SOCK_STREAM/);
    assert.match(proxyServer, /recv_exact\(dns_socket, 2\)/);
});

test('residential SOCKS5 server supports UDP ASSOCIATE through the active tunnel', () => {
    assert.match(proxyServer, /command == 3/);
    assert.match(proxyServer, /def relay_socks5_udp/);
    assert.match(proxyServer, /SO_BINDTODEVICE/);
    assert.match(proxyServer, /if fragment != 0/);
    assert.doesNotMatch(proxyServer, /if command != 1:[\s\S]{0,100}x05\\x07/);
});

test('residential tunnel routing cannot delete or flush cloud policy routes', () => {
    assert.match(manager, /KUI_ROUTE_TABLES\s*=\s*\{"tun_main": 20101, "tun_backup": 20102\}/);
    assert.doesNotMatch(manager, /\["ip", "rule", "del", "pref", str\(table_id\)\]/);
    assert.doesNotMatch(manager, /\["ip", "route", "flush", "table", str\(table_id\)\]/);
    assert.match(manager, /_cleanup_tunnel_routing\(tun_name, legacy_table/);
    assert.match(manager, /"route", "replace", "default", "dev", tun_name/);
});

test('residential OpenVPN cannot alter host routes or forwarding used by SSH', () => {
    assert.match(manager, /"--route-nopull", "--route-noexec"/);
    assert.match(manager, /"--pull-filter", "ignore", "redirect-gateway"/);
    assert.doesNotMatch(manager, /net\.ipv4\.ip_forward=1|net\.ipv6\.conf\.all\.forwarding=1/);
    assert.doesNotMatch(installer, /net\.ipv4\.ip_forward=1|net\.ipv6\.conf\.all\.forwarding=1/);
});

test('realtime egress results are persisted and acknowledged without HTTP', () => {
    assert.match(realtime, /persistEgressResult\(attachment\.ip, result\)/);
    assert.match(realtime, /UPDATE servers SET egress_applied_mode/);
    assert.match(realtime, /type: "config\.result\.ack"/);
    assert.match(agent, /message\.get\("type"\) == "config\.result\.ack"/);
    assert.match(agent, /def _deliver_egress_result\(payload\):[\s\S]*realtime_channel\.send\(payload, "config\.result"\)[\s\S]*return _post_warp_result\(payload\)/);
});

test('agent control requests bypass environment proxies and retry transient stalls', () => {
    assert.match(agent, /ProxyHandler\(\{\}\)/);
    assert.match(agent, /for attempt in range\(CONTROL_REQUEST_ATTEMPTS\)/);
    assert.match(agent, /_controller_json_request\(f"\{API_URL\}\?ip=\{VPS_IP\}"/);
    assert.match(manager, /ProxyHandler\(\{\}\)/);
    assert.doesNotMatch(agent, /urllib\.request\.urlopen/);
    assert.doesNotMatch(manager, /urllib\.request\.urlopen/);
});

test('VPNGate CSV failures use a bounded official HTTPS fallback', () => {
    assert.match(manager, /VPNGATE_HTML_FALLBACK_INTERVAL = 1800/);
    assert.match(manager, /VPNGATE_HTML_FALLBACK_LIMIT = 8/);
    assert.match(manager, /parsed\.scheme != "https" or parsed\.hostname != "www\.vpngate\.net"/);
    assert.match(manager, /ThreadPoolExecutor\(max_workers=2\)/);
    assert.match(manager, /official HTTPS fallback loaded/);
});

test('proxy report forwards bounded speed telemetry and omits invalid values', () => {
    const valid = validateProxyReport({
        ip: '203.0.113.8',
        details: [{
            tunnel: 'tun_main',
            active: true,
            country: 'JP',
            port: 7920,
            node_ip: '198.51.100.8',
            exit_ip: '203.0.113.9',
            ttfb_ms: 0,
            speed_kbps: 10_000_000,
            ready: true,
        }],
    });
    assert.equal(valid.details[0].ttfb_ms, 0);
    assert.equal(valid.details[0].speed_kbps, 10_000_000);
    assert.equal(valid.details[0].ready, true);
    assert.equal(Object.hasOwn(valid.details[0], 'ready_omitted'), false);

    const legacy = validateProxyReport({
        ip: '203.0.113.8',
        details: [{ tunnel: 'tun_main', active: true, country: 'JP', port: 7920 }],
    });
    assert.equal(legacy.details[0].ttfb_ms, null);
    assert.equal(legacy.details[0].speed_kbps, null);
    assert.equal(legacy.details[0].ready, false);
    assert.equal(legacy.details[0].ready_omitted, true);

    const invalid = validateProxyReport({
        ip: '203.0.113.8',
        details: [{
            tunnel: 'tun_main',
            active: true,
            ttfb_ms: 60_001,
            speed_kbps: -1,
            ready: 'yes',
        }],
    });
    assert.equal(invalid.details[0].ttfb_ms, null);
    assert.equal(invalid.details[0].speed_kbps, null);
    assert.equal(invalid.details[0].ready, false);
    assert.equal(Object.hasOwn(invalid.details[0], 'ready_omitted'), false);

    const upperBound = validateProxyReport({
        ip: '203.0.113.8',
        details: [{ tunnel: 'tun_main', active: true, ttfb_ms: 60_000, speed_kbps: 1, ready: false }],
    });
    assert.equal(upperBound.details[0].ttfb_ms, 60_000);
    assert.equal(upperBound.details[0].speed_kbps, 1);
    assert.equal(upperBound.details[0].ready, false);
    assert.equal(Object.hasOwn(upperBound.details[0], 'ready_omitted'), false);
});

test('omitted ready on legacy residential reports is inferred and marked for reserialization', () => {
    const report = validateProxyReport({
        ip: '203.0.113.8',
        details: [
            { tunnel: 'tun_main', active: true, country: 'JP', port: 7920, node_ip: '198.51.100.8' },
            { tunnel: 'tun_backup', active: false, country: 'US', port: 7920, exit_ip: '203.0.113.9' },
            { tunnel: 'tun_unknown', active: 'yes', country: 'JP', port: 7920, node_ip: '198.51.100.9' },
            { tunnel: 'tun_invalid', active: true, country: 'JP', port: 7920, node_ip: '198.51.100.10', ready: 'yes' },
            { tunnel: 'tun_explicit_false', active: true, country: 'JP', port: 7920, node_ip: '198.51.100.11', ready: false },
        ],
    });
    assert.equal(report.details[0].ready, true);
    assert.equal(report.details[0].ready_omitted, true);
    assert.equal(report.details[1].ready, true);
    assert.equal(report.details[1].ready_omitted, true);
    assert.equal(report.details[2].active, false);
    assert.equal(report.details[2].ready, false);
    assert.equal(report.details[2].ready_omitted, true);
    assert.equal(report.details[3].ready, false);
    assert.equal(Object.hasOwn(report.details[3], 'ready_omitted'), false);
    assert.equal(report.details[4].ready, false);
    assert.equal(Object.hasOwn(report.details[4], 'ready_omitted'), false);

    const reserialized = validateProxyReport(report);
    assert.equal(reserialized.details[0].ready, true);
    assert.equal(reserialized.details[0].ready_omitted, true);
    assert.equal(reserialized.details[2].ready, false);
    assert.equal(reserialized.details[2].ready_omitted, true);
});

test('GET /api/config falls back to node_ip when the active exit_ip is blank', async () => {
    const db = await createProxyDb();
    const ip = '203.0.113.8';
    await seedServer(db, ip, 'agent-token');
    await seedProxyState(db, ip, [{
        tunnel: 'tun_main',
        active: true,
        country: 'JP',
        port: 7920,
        node_ip: '198.51.100.99',
        exit_ip: '',
    }]);

    const fallback = await callApi(db, `/api/config?ip=${ip}`, { authorization: 'agent-token' });
    assert.equal(fallback.response.status, 200);
    assert.equal(fallback.payload.residential_outbound.active_exit_ip, '198.51.100.99');

    await seedProxyState(db, ip, [{
        tunnel: 'tun_main',
        active: true,
        country: 'JP',
        port: 7920,
        node_ip: '198.51.100.99',
        exit_ip: '203.0.113.50',
    }]);
    const explicit = await callApi(db, `/api/config?ip=${ip}`, { authorization: 'agent-token' });
    assert.equal(explicit.response.status, 200);
    assert.equal(explicit.payload.residential_outbound.active_exit_ip, '203.0.113.50');
});

test('proxy config accepts ANY and persists switch_mode for lite_manager', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.8';

    const saved = await callApi(db, '/api/proxy/config', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip, country: 'any', switch_mode: 'FULL' },
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.payload.slot_map.country, 'ANY');
    assert.equal(saved.payload.slot_map.switch_mode, 'full');
    assert.equal(saved.payload.proxy.country, 'ANY');
    assert.equal(saved.payload.proxy.switch_mode, 'full');

    const row = await db.prepare('SELECT value FROM probe_settings WHERE key = ?').bind(`proxy_slot_map_${ip}`).first();
    const persisted = JSON.parse(row.value);
    assert.equal(persisted['0'], 'ANY');
    assert.equal(persisted.country, 'ANY');
    assert.equal(persisted.switch_mode, 'full');

    const loaded = await callApi(db, `/api/proxy/config?ip=${ip}`, { token: ADMIN_TOKEN });
    assert.equal(loaded.response.status, 200);
    assert.equal(loaded.payload.country, 'ANY');
    assert.equal(loaded.payload.switch_mode, 'full');
    assert.equal(loaded.payload.proxy.switch_mode, 'full');

    const switched = await callApi(db, '/api/proxy/switch', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip, switch_mode: 'full' },
    });
    assert.equal(switched.response.status, 200);
    assert.equal(switched.payload.switch_mode, 'full');
    assert.ok(switched.payload.switch_trigger > 0);

    const switchedRow = await db.prepare('SELECT value FROM probe_settings WHERE key = ?').bind(`proxy_slot_map_${ip}`).first();
    const switchedConfig = JSON.parse(switchedRow.value);
    assert.equal(switchedConfig.switch_mode, 'full');
    assert.equal(switchedConfig.switch_trigger, switched.payload.switch_trigger);

    const defaulted = await callApi(db, '/api/proxy/switch', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip },
    });
    assert.equal(defaulted.response.status, 200);
    assert.equal(defaulted.payload.switch_mode, 'hot');

    const invalidMode = await callApi(db, '/api/proxy/switch', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip, switch_mode: 'instant' },
    });
    assert.equal(invalidMode.response.status, 400);

    const invalidCountry = await callApi(db, '/api/proxy/config', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip, country: 'JPN' },
    });
    assert.equal(invalidCountry.response.status, 400);
});

test('proxy config keeps public listener and loopback listener mutually consistent', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.9';

    const savedPublic = await callApi(db, '/api/proxy/config', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip, public_listener: true, listen_host: '' },
    });
    assert.equal(savedPublic.response.status, 200);
    assert.equal(savedPublic.payload.slot_map.public_listener, true);
    assert.equal(savedPublic.payload.slot_map.listen_host, '');

    const publicConfig = await callApi(db, `/api/proxy/config?ip=${ip}`, { token: ADMIN_TOKEN });
    assert.equal(publicConfig.response.status, 200);
    assert.equal(publicConfig.payload.public_listener, true);
    assert.equal(publicConfig.payload.listen_host, '');

    const savedLoopback = await callApi(db, '/api/proxy/config', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip, public_listener: false, listen_host: '127.0.0.1' },
    });
    assert.equal(savedLoopback.response.status, 200);
    assert.equal(savedLoopback.payload.slot_map.public_listener, false);
    assert.equal(savedLoopback.payload.slot_map.listen_host, '127.0.0.1');

    const loopbackConfig = await callApi(db, `/api/proxy/config?ip=${ip}`, { token: ADMIN_TOKEN });
    assert.equal(loopbackConfig.response.status, 200);
    assert.equal(loopbackConfig.payload.public_listener, false);
    assert.equal(loopbackConfig.payload.listen_host, '127.0.0.1');

    const reenabled = await callApi(db, '/api/proxy/config', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip, public_listener: true, listen_host: '127.0.0.1' },
    });
    assert.equal(reenabled.response.status, 200);
    assert.equal(reenabled.payload.slot_map.public_listener, true);
    assert.equal(reenabled.payload.slot_map.listen_host, '127.0.0.1');

    const loopbackOnly = await callApi(db, '/api/proxy/config', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip, listen_host: '127.0.0.1' },
    });
    assert.equal(loopbackOnly.response.status, 200);
    assert.equal(loopbackOnly.payload.slot_map.public_listener, false);
    assert.equal(loopbackOnly.payload.slot_map.listen_host, '127.0.0.1');

    const loopbackOnlyConfig = await callApi(db, `/api/proxy/config?ip=${ip}`, { token: ADMIN_TOKEN });
    assert.equal(loopbackOnlyConfig.response.status, 200);
    assert.equal(loopbackOnlyConfig.payload.public_listener, false);
    assert.equal(loopbackOnlyConfig.payload.listen_host, '127.0.0.1');

    const missingCredentials = await callApi(db, '/api/proxy/config', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip, public_listener: true },
    }, { PROXY_USER: '', PROXY_PASS: '' });
    assert.equal(missingCredentials.response.status, 503);

    const invalidListener = await callApi(db, '/api/proxy/config', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip, listen_host: 'host.docker.internal' },
    });
    assert.equal(invalidListener.response.status, 400);
});

test('public listener toggles preserve the configured Docker bridge address', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.16';

    const bridge = await callApi(db, '/api/proxy/config', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip, listen_host: '172.17.0.1' },
    });
    assert.equal(bridge.response.status, 200);
    assert.equal(bridge.payload.slot_map.listen_host, '172.17.0.1');
    assert.equal(bridge.payload.slot_map.public_listener, false);

    const enabled = await callApi(db, '/api/proxy/config', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip, public_listener: true },
    });
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.payload.slot_map.public_listener, true);
    assert.equal(enabled.payload.slot_map.listen_host, '172.17.0.1');

    const disabled = await callApi(db, '/api/proxy/config', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip, public_listener: false },
    });
    assert.equal(disabled.response.status, 200);
    assert.equal(disabled.payload.slot_map.public_listener, false);
    assert.equal(disabled.payload.slot_map.listen_host, '172.17.0.1');

    const updated = await callApi(db, '/api/proxy/config', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip, listen_host: '172.18.0.1' },
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.slot_map.listen_host, '172.18.0.1');

    const loaded = await callApi(db, `/api/proxy/config?ip=${ip}`, { token: ADMIN_TOKEN });
    assert.equal(loaded.response.status, 200);
    assert.equal(loaded.payload.public_listener, false);
    assert.equal(loaded.payload.listen_host, '172.18.0.1');
});

test('proxy switch inherits effective config and emits strictly increasing triggers', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '1.2.3.4';

    const globalConfig = await callApi(db, '/api/proxy/config', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { country: 'US', port: 8888, public_listener: true, listen_host: '' },
    });
    assert.equal(globalConfig.response.status, 200);

    const inherited = await callApi(db, '/api/proxy/switch', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip, switch_mode: 'full' },
    });
    assert.equal(inherited.response.status, 200);
    assert.equal(inherited.payload.switch_mode, 'full');

    const inheritedConfig = await callApi(db, `/api/proxy/config?ip=${ip}`, { token: ADMIN_TOKEN });
    assert.equal(inheritedConfig.response.status, 200);
    assert.equal(inheritedConfig.payload.country, 'US');
    assert.equal(inheritedConfig.payload.port, 8888);
    assert.equal(inheritedConfig.payload.public_listener, true);
    assert.equal(inheritedConfig.payload.switch_mode, 'full');

    const realNow = Date.now;
    const fixedNow = realNow() + 60_000;
    Date.now = () => fixedNow;
    try {
        const first = await callApi(db, '/api/proxy/switch', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { target_ip: ip, switch_mode: 'hot', switch_trigger: 1 },
        });
        assert.equal(first.response.status, 200);
        assert.equal(first.payload.switch_trigger, fixedNow);

        const second = await callApi(db, '/api/proxy/switch', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, switch_mode: 'full', switch_trigger: 1 },
        });
        assert.equal(second.response.status, 200);
        assert.equal(second.payload.switch_trigger, fixedNow + 1);

        const configTrigger = await callApi(db, '/api/proxy/config', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, switch_trigger: 1 },
        });
        assert.equal(configTrigger.response.status, 200);
        assert.equal(configTrigger.payload.slot_map.switch_trigger, fixedNow + 2);
    } finally {
        Date.now = realNow;
    }

    const missingIp = await callApi(db, '/api/proxy/switch', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { switch_mode: 'hot' },
    });
    assert.equal(missingIp.response.status, 400);
    assert.equal(missingIp.payload.error, 'IP required');

    const invalidIp = await callApi(db, '/api/proxy/switch', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip: 'not-an-ip', switch_mode: 'hot' },
    });
    assert.equal(invalidIp.response.status, 400);
});

test('proxy switch atomically applies optional country, port, listener fields with one trigger', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.20';
    await db.prepare("INSERT INTO probe_settings (key, value) VALUES (?, ?)")
        .bind(`proxy_slot_map_${ip}`, JSON.stringify({
            '0': 'JP',
            country: 'JP',
            port: 7000,
            listen_host: '172.17.0.1',
            public_listener: false,
            switch_mode: 'hot',
            switch_trigger: 100,
        }))
        .run();

    const realNow = Date.now;
    const fixedNow = realNow() + 60_000;
    Date.now = () => fixedNow;
    try {
        const switched = await callApi(db, '/api/proxy/switch', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: {
                ip,
                switch_mode: 'full',
                country: 'us',
                port: 8888,
                listen_host: '172.18.0.1',
                public_listener: true,
            },
        });
        assert.equal(switched.response.status, 200);
        assert.equal(switched.payload.switch_mode, 'full');
        assert.equal(switched.payload.switch_trigger, fixedNow);

        const saved = await readProxySlot(db, ip);
        assert.equal(saved['0'], 'US');
        assert.equal(saved.country, 'US');
        assert.equal(saved.port, 8888);
        assert.equal(saved.listen_host, '172.18.0.1');
        assert.equal(saved.public_listener, true);
        assert.equal(saved.switch_mode, 'full');
        assert.equal(saved.switch_trigger, fixedNow);
    } finally {
        Date.now = realNow;
    }
});

test('proxy switch accepts country zero alias and preserves fields that are not supplied', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.21';
    await db.prepare("INSERT INTO probe_settings (key, value) VALUES (?, ?)")
        .bind(`proxy_slot_map_${ip}`, JSON.stringify({
            '0': 'JP',
            country: 'JP',
            port: 7921,
            listen_host: '172.17.0.1',
            public_listener: true,
            enabled: false,
            switch_mode: 'hot',
            switch_trigger: 100,
        }))
        .run();

    const switched = await callApi(db, '/api/proxy/switch', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { target_ip: ip, '0': 'any' },
    });
    assert.equal(switched.response.status, 200);
    assert.equal(switched.payload.switch_mode, 'hot');

    const saved = await readProxySlot(db, ip);
    assert.equal(saved['0'], 'ANY');
    assert.equal(saved.country, 'ANY');
    assert.equal(saved.port, 7921);
    assert.equal(saved.listen_host, '172.17.0.1');
    assert.equal(saved.public_listener, true);
    assert.equal(saved.enabled, false);
});

test('proxy switch rejects invalid form fields without changing config or trigger', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.22';
    const original = JSON.stringify({
        '0': 'JP',
        country: 'JP',
        port: 7000,
        listen_host: '172.17.0.1',
        public_listener: false,
        switch_mode: 'hot',
        switch_trigger: 100,
    });
    await db.prepare("INSERT INTO probe_settings (key, value) VALUES (?, ?)")
        .bind(`proxy_slot_map_${ip}`, original)
        .run();

    for (const body of [
        { country: 'JPN' },
        { port: 0 },
        { port: 65536 },
        { port: 'abc' },
        { listen_host: 'host.docker.internal' },
        { public_listener: 'true' },
        { switch_mode: 'instant' },
    ]) {
        const rejected = await callApi(db, '/api/proxy/switch', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, ...body },
        });
        assert.equal(rejected.response.status, 400, JSON.stringify(body));
        assert.equal(rejected.payload.success, false);
    }
    assert.equal(await readProxySlot(db, ip).then(value => JSON.stringify(value)), original);
});

test('proxy switch requires credentials before enabling the public listener and writes nothing', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.23';
    const original = JSON.stringify({
        '0': 'JP',
        country: 'JP',
        port: 7000,
        listen_host: '172.17.0.1',
        public_listener: false,
        switch_mode: 'hot',
        switch_trigger: 100,
    });
    await db.prepare("INSERT INTO probe_settings (key, value) VALUES (?, ?)")
        .bind(`proxy_slot_map_${ip}`, original)
        .run();

    const rejected = await callApi(db, '/api/proxy/switch', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip, switch_mode: 'full', public_listener: true },
    }, { PROXY_USER: '', PROXY_PASS: '' });
    assert.equal(rejected.response.status, 503);
    assert.match(rejected.payload.error, /PROXY_USER and PROXY_PASS/);
    assert.equal(await readProxySlot(db, ip).then(value => JSON.stringify(value)), original);
});

test('proxy switch commits form changes and trigger in a single CAS write', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.24';
    const key = `proxy_slot_map_${ip}`;
    await db.prepare("INSERT INTO probe_settings (key, value) VALUES (?, ?)")
        .bind(key, JSON.stringify({
            '0': 'JP',
            country: 'JP',
            port: 7000,
            listen_host: '172.17.0.1',
            public_listener: false,
            switch_mode: 'hot',
            switch_trigger: 100,
        }))
        .run();

    let writes = 0;
    const countingDb = {
        ...db,
        prepare(sql) {
            const statement = db.prepare(sql);
            if (!/^UPDATE probe_settings SET value = \? WHERE key = \? AND value IS \?$/.test(sql)) return statement;
            return {
                bind(...args) {
                    const bound = statement.bind(...args);
                    return {
                        async run() {
                            writes += 1;
                            return bound.run();
                        },
                    };
                },
            };
        },
    };

    const switched = await callApi(countingDb, '/api/proxy/switch', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip, country: 'US', port: 8888, switch_mode: 'full' },
    });
    assert.equal(switched.response.status, 200);
    assert.equal(writes, 1);

    const saved = await readProxySlot(db, ip);
    assert.equal(saved.country, 'US');
    assert.equal(saved.port, 8888);
    assert.equal(saved.switch_mode, 'full');
    assert.equal(saved.switch_trigger, switched.payload.switch_trigger);
});

test('invalid proxy switch forms never attempt a CAS write', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.25';
    await db.prepare("INSERT INTO probe_settings (key, value) VALUES (?, ?)")
        .bind(`proxy_slot_map_${ip}`, JSON.stringify({ '0': 'JP', country: 'JP', switch_trigger: 100 }))
        .run();

    let writes = 0;
    const countingDb = {
        ...db,
        prepare(sql) {
            const statement = db.prepare(sql);
            if (!/^(UPDATE|INSERT INTO) probe_settings/.test(sql)) return statement;
            return {
                bind(...args) {
                    const bound = statement.bind(...args);
                    return {
                        async run() {
                            writes += 1;
                            return bound.run();
                        },
                    };
                },
            };
        },
    };

    for (const body of [
        { country: 'JPN' },
        { port: 0 },
        { listen_host: 'host.docker.internal' },
        { public_listener: 'yes' },
        { switch_mode: 'instant' },
    ]) {
        const rejected = await callApi(countingDb, '/api/proxy/switch', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, ...body },
        });
        assert.equal(rejected.response.status, 400, JSON.stringify(body));
    }
    assert.equal(writes, 0);
});

test('proxy config and switch reject non-JSON-typed form fields without changing state', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.26';
    const original = {
        '0': 'JP',
        country: 'JP',
        port: 7000,
        listen_host: '172.17.0.1',
        public_listener: false,
        enabled: true,
        switch_mode: 'hot',
        switch_trigger: 100,
    };
    await db.prepare("INSERT INTO probe_settings (key, value) VALUES (?, ?)")
        .bind(`proxy_slot_map_${ip}`, JSON.stringify(original))
        .run();

    const invalidForms = [
        ['port boolean', { port: true }],
        ['port array', { port: [8888] }],
        ['port fractional number', { port: 1.5 }],
        ['port fractional string', { port: '1.5' }],
        ['port null', { port: null }],
        ['listen_host array', { listen_host: [] }],
        ['listen_host boolean', { listen_host: true }],
        ['listen_host number', { listen_host: 123 }],
        ['enabled string', { enabled: 'false' }],
        ['enabled number', { enabled: 0 }],
        ['enabled null', { enabled: null }],
        ['public_listener array', { public_listener: [] }],
        ['public_listener string', { public_listener: 'false' }],
        ['country array', { country: ['US'] }],
        ['country zero alias array', { '0': ['US'] }],
        ['switch_mode array', { switch_mode: ['full'] }],
        ['switch_mode boolean', { switch_mode: true }],
    ];

    for (const endpoint of ['/api/proxy/config', '/api/proxy/switch']) {
        for (const [label, form] of invalidForms) {
            const rejected = await callApi(db, endpoint, {
                method: 'POST',
                token: ADMIN_TOKEN,
                body: { ip, ...form },
            });
            assert.equal(rejected.response.status, 400, `${endpoint} ${label}`);
            assert.equal(rejected.payload.success, false, `${endpoint} ${label}`);
            assert.deepEqual(await readProxySlot(db, ip), original, `${endpoint} ${label}`);
        }
    }
});

test('proxy config and switch accept decimal-string ports and strict booleans', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.27';

    const configured = await callApi(db, '/api/proxy/config', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: {
            ip,
            country: 'any',
            port: '8888',
            listen_host: '172.17.0.1',
            public_listener: true,
            enabled: false,
            switch_mode: 'FULL',
        },
    });
    assert.equal(configured.response.status, 200);
    assert.deepEqual(await readProxySlot(db, ip), {
        '0': 'ANY',
        country: 'ANY',
        port: 8888,
        listen_host: '172.17.0.1',
        public_listener: true,
        enabled: false,
        switch_mode: 'full',
    });

    const switched = await callApi(db, '/api/proxy/switch', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: {
            ip,
            country: 'jp',
            port: '8889',
            listen_host: '',
            public_listener: false,
            enabled: true,
            switch_mode: 'hot',
        },
    });
    assert.equal(switched.response.status, 200);
    const saved = await readProxySlot(db, ip);
    assert.equal(saved['0'], 'JP');
    assert.equal(saved.country, 'JP');
    assert.equal(saved.port, 8889);
    assert.equal(saved.listen_host, '');
    assert.equal(saved.public_listener, false);
    assert.equal(saved.enabled, true);
    assert.equal(saved.switch_mode, 'hot');
    assert.ok(saved.switch_trigger > 0);
});

test('repeated global proxy config writes update the existing row without conflict', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);

    const first = await callApi(db, '/api/proxy/config', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { country: 'US', port: 8888, switch_mode: 'hot' },
    });
    assert.equal(first.response.status, 200);
    assert.equal(first.payload.slot_map.country, 'US');

    const second = await callApi(db, '/api/proxy/config', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { country: 'JP', port: 9999, switch_mode: 'full' },
    });
    assert.equal(second.response.status, 200);
    assert.equal(second.payload.slot_map.country, 'JP');
    assert.equal(second.payload.slot_map.port, 9999);

    const loaded = await callApi(db, '/api/proxy/config', { token: ADMIN_TOKEN });
    assert.equal(loaded.response.status, 200);
    assert.equal(loaded.payload.country, 'JP');
    assert.equal(loaded.payload.port, 9999);
    assert.equal(loaded.payload.switch_mode, 'full');
});

test('oversized client switch markers do not become server trigger values', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.17';
    await db.prepare("INSERT INTO probe_settings (key, value) VALUES (?, ?)")
        .bind(`proxy_slot_map_${ip}`, JSON.stringify({ '0': 'US', country: 'US', port: 8888, switch_trigger: 100 }))
        .run();

    const realNow = Date.now;
    const fixedNow = realNow() + 60_000;
    Date.now = () => fixedNow;
    try {
        const configured = await callApi(db, '/api/proxy/config', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, switch_trigger: 1e20 },
        });
        assert.equal(configured.response.status, 200);
        assert.equal(configured.payload.slot_map.switch_trigger, fixedNow);
        assert.ok(Number.isSafeInteger(configured.payload.slot_map.switch_trigger));

        const switched = await callApi(db, '/api/proxy/switch', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, switch_trigger: 1e20 },
        });
        assert.equal(switched.response.status, 200);
        assert.equal(switched.payload.switch_trigger, fixedNow + 1);
        assert.ok(Number.isSafeInteger(switched.payload.switch_trigger));
    } finally {
        Date.now = realNow;
    }
});

test('unsafe stored switch triggers are replaced with safe increasing values', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.18';
    await db.prepare("INSERT INTO probe_settings (key, value) VALUES (?, ?)")
        .bind(`proxy_slot_map_${ip}`, JSON.stringify({
            '0': 'US',
            country: 'US',
            port: 8888,
            switch_mode: 'hot',
            switch_trigger: 1e20,
        }))
        .run();

    const realNow = Date.now;
    const fixedNow = realNow() + 120_000;
    Date.now = () => fixedNow;
    try {
        const first = await callApi(db, '/api/proxy/switch', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, switch_mode: 'full' },
        });
        assert.equal(first.response.status, 200);
        assert.equal(first.payload.switch_trigger, fixedNow);
        assert.ok(Number.isSafeInteger(first.payload.switch_trigger));

        const second = await callApi(db, '/api/proxy/switch', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, switch_mode: 'hot' },
        });
        assert.equal(second.response.status, 200);
        assert.equal(second.payload.switch_trigger, fixedNow + 1);
        assert.ok(Number.isSafeInteger(second.payload.switch_trigger));

        const loaded = await callApi(db, `/api/proxy/config?ip=${ip}`, { token: ADMIN_TOKEN });
        assert.equal(loaded.payload.switch_trigger, fixedNow + 1);
    } finally {
        Date.now = realNow;
    }
});

test('invalid stored switch triggers are normalized to safe positive integers', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.19';
    await db.prepare("INSERT INTO probe_settings (key, value) VALUES (?, ?)")
        .bind(`proxy_slot_map_${ip}`, JSON.stringify({
            '0': 'US',
            country: 'US',
            port: 8888,
            switch_mode: 'hot',
            switch_trigger: -1,
        }))
        .run();

    const realNow = Date.now;
    const fixedNow = Math.floor(realNow() / 1000) * 1000 + 120_000;
    Date.now = () => fixedNow;
    try {
        const fromNegative = await callApi(db, '/api/proxy/switch', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, switch_mode: 'full' },
        });
        assert.equal(fromNegative.response.status, 200);
        assert.equal(fromNegative.payload.switch_trigger, fixedNow);

        await db.prepare("UPDATE probe_settings SET value = ? WHERE key = ?")
            .bind(JSON.stringify({ '0': 'US', country: 'US', port: 8888, switch_trigger: 42.5 }), `proxy_slot_map_${ip}`)
            .run();
        const fromFraction = await callApi(db, '/api/proxy/switch', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, switch_mode: 'full' },
        });
        assert.equal(fromFraction.response.status, 200);
        assert.equal(fromFraction.payload.switch_trigger, fixedNow);

        await db.prepare("UPDATE probe_settings SET value = ? WHERE key = ?")
            .bind(JSON.stringify({ '0': 'US', country: 'US', port: 8888, switch_trigger: Number.MAX_SAFE_INTEGER }), `proxy_slot_map_${ip}`)
            .run();
        const fromMax = await callApi(db, '/api/proxy/switch', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, switch_mode: 'full' },
        });
        assert.equal(fromMax.response.status, 200);
        assert.ok(Number.isSafeInteger(fromMax.payload.switch_trigger));
        assert.ok(fromMax.payload.switch_trigger > 0);

        const loaded = await callApi(db, `/api/proxy/config?ip=${ip}`, { token: ADMIN_TOKEN });
        assert.equal(loaded.payload.switch_trigger, fromMax.payload.switch_trigger);
    } finally {
        Date.now = realNow;
    }
});

test('concurrent proxy config and switch writes preserve both snapshots', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.10';
    await db.prepare("INSERT INTO probe_settings (key, value) VALUES (?, ?)")
        .bind(`proxy_slot_map_${ip}`, JSON.stringify({
            '0': 'US',
            country: 'US',
            port: 8888,
            listen_host: '',
            public_listener: true,
            switch_mode: 'hot',
            switch_trigger: 100,
        }))
        .run();

    let proxyReads = 0;
    let releaseReads;
    const bothReads = new Promise(resolve => { releaseReads = resolve; });
    const slowProxyRead = async () => {
        proxyReads += 1;
        if (proxyReads >= 2) releaseReads();
        await Promise.race([
            bothReads,
            new Promise(resolve => setTimeout(resolve, 40)),
        ]);
    };
    const originalPrepare = db.prepare.bind(db);
    const slowDb = {
        ...db,
        prepare(sql) {
            const statement = originalPrepare(sql);
            return new Proxy(statement, {
                get(target, property) {
                    if (property === 'bind') {
                        return (...params) => {
                            const bound = target.bind(...params);
                            if (!/SELECT value FROM probe_settings WHERE key = \?/.test(sql) || !String(params[0] || '').startsWith('proxy_slot_map')) return bound;
                            return new Proxy(bound, {
                                get(boundTarget, boundProperty) {
                                    if (boundProperty === 'first') {
                                        return async (...args) => {
                                            await slowProxyRead();
                                            return boundTarget.first(...args);
                                        };
                                    }
                                    const value = boundTarget[boundProperty];
                                    return typeof value === 'function' ? value.bind(boundTarget) : value;
                                },
                            });
                        };
                    }
                    const value = target[property];
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        },
    };

    const [configured, switched] = await Promise.all([
        callApi(slowDb, '/api/proxy/config', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, port: 9999 },
        }),
        callApi(slowDb, '/api/proxy/switch', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, switch_mode: 'full' },
        }),
    ]);
    assert.equal(configured.response.status, 200);
    assert.equal(switched.response.status, 200);

    const finalConfig = await callApi(db, `/api/proxy/config?ip=${ip}`, { token: ADMIN_TOKEN });
    assert.equal(finalConfig.response.status, 200);
    assert.equal(finalConfig.payload.country, 'US');
    assert.equal(finalConfig.payload.port, 9999);
    assert.equal(finalConfig.payload.public_listener, true);
    assert.equal(finalConfig.payload.switch_mode, 'full');
    assert.ok(finalConfig.payload.switch_trigger > 100);
});

test('interleaved D1 writes retry on a stale snapshot without an isolate-local lock', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.11';
    await db.prepare("INSERT INTO probe_settings (key, value) VALUES (?, ?)")
        .bind(`proxy_slot_map_${ip}`, JSON.stringify({
            '0': 'US',
            country: 'US',
            port: 8888,
            listen_host: '',
            public_listener: true,
            switch_mode: 'hot',
            switch_trigger: 100,
        }))
        .run();

    let injected = false;
    const interleavedDb = {
        ...db,
        prepare(sql) {
            const statement = db.prepare(sql);
            if (!/^UPDATE probe_settings SET value = \? WHERE key = \? AND value IS \?$/.test(sql)) return statement;
            return {
                bind(...args) {
                    const bound = statement.bind(...args);
                    return {
                        async run() {
                            if (!injected && args[1] === `proxy_slot_map_${ip}`) {
                                injected = true;
                                await db.prepare("UPDATE probe_settings SET value = ? WHERE key = ?")
                                    .bind(JSON.stringify({ '0': 'JP', country: 'JP', port: 7777, switch_mode: 'hot', switch_trigger: 500 }), `proxy_slot_map_${ip}`)
                                    .run();
                            }
                            return bound.run();
                        },
                    };
                },
            };
        },
    };

    const configured = await callApi(interleavedDb, '/api/proxy/config', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip, switch_mode: 'full', listen_host: '127.0.0.1' },
    });
    assert.equal(configured.response.status, 200);
    assert.equal(injected, true);
    assert.equal(configured.payload.slot_map.country, 'JP');
    assert.equal(configured.payload.slot_map.port, 7777);
    assert.equal(configured.payload.slot_map.public_listener, false);
    assert.equal(configured.payload.slot_map.listen_host, '127.0.0.1');
    assert.equal(configured.payload.slot_map.switch_trigger, 500);

    const finalConfig = await callApi(db, `/api/proxy/config?ip=${ip}`, { token: ADMIN_TOKEN });
    assert.equal(finalConfig.payload.country, 'JP');
    assert.equal(finalConfig.payload.port, 7777);
    assert.equal(finalConfig.payload.switch_mode, 'full');
    assert.equal(finalConfig.payload.public_listener, false);
    assert.equal(finalConfig.payload.listen_host, '127.0.0.1');
    assert.equal(finalConfig.payload.switch_trigger, configured.payload.slot_map.switch_trigger);
});

test('proxy config retries against a concurrent global update before creating an override', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.13';
    const globalKey = 'proxy_slot_map';
    await db.prepare("INSERT INTO probe_settings (key, value) VALUES (?, ?)")
        .bind(globalKey, JSON.stringify({
            '0': 'US',
            country: 'US',
            port: 8888,
            listen_host: '',
            public_listener: true,
            switch_mode: 'hot',
            switch_trigger: 100,
        }))
        .run();

    let injected = false;
    const interleavedDb = {
        ...db,
        prepare(sql) {
            const statement = db.prepare(sql);
            if (!/^INSERT INTO probe_settings \(key, value\) SELECT /.test(sql)) return statement;
            return {
                bind(...args) {
                    const bound = statement.bind(...args);
                    return {
                        async run() {
                            if (!injected) {
                                injected = true;
                                await db.prepare("UPDATE probe_settings SET value = ? WHERE key = ?")
                                    .bind(JSON.stringify({
                                        '0': 'JP',
                                        country: 'JP',
                                        port: 7777,
                                        listen_host: '',
                                        public_listener: true,
                                        switch_mode: 'hot',
                                        switch_trigger: 500,
                                    }), globalKey)
                                    .run();
                            }
                            return bound.run();
                        },
                    };
                },
            };
        },
    };

    const configured = await callApi(interleavedDb, '/api/proxy/config', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip, switch_mode: 'full', listen_host: '127.0.0.1' },
    });
    assert.equal(configured.response.status, 200);
    assert.equal(injected, true);
    assert.equal(configured.payload.slot_map.country, 'JP');
    assert.equal(configured.payload.slot_map.port, 7777);
    assert.equal(configured.payload.slot_map.switch_trigger, 500);

    const finalConfig = await callApi(db, `/api/proxy/config?ip=${ip}`, { token: ADMIN_TOKEN });
    assert.equal(finalConfig.payload.country, 'JP');
    assert.equal(finalConfig.payload.port, 7777);
    assert.equal(finalConfig.payload.switch_mode, 'full');
    assert.equal(finalConfig.payload.public_listener, false);
    assert.equal(finalConfig.payload.listen_host, '127.0.0.1');
    assert.equal(finalConfig.payload.switch_trigger, 500);
});

test('proxy switch retries a same-millisecond conflict with a strictly higher trigger', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.14';
    const key = `proxy_slot_map_${ip}`;
    await db.prepare("INSERT INTO probe_settings (key, value) VALUES (?, ?)")
        .bind(key, JSON.stringify({
            '0': 'US',
            country: 'US',
            port: 8888,
            listen_host: '',
            public_listener: true,
            switch_mode: 'hot',
            switch_trigger: 100,
        }))
        .run();

    const realNow = Date.now;
    const fixedNow = realNow() + 60_000;
    let writeAttempts = 0;
    const interleavedDb = {
        ...db,
        prepare(sql) {
            const statement = db.prepare(sql);
            if (!/^UPDATE probe_settings SET value = \? WHERE key = \? AND value IS \?$/.test(sql)) return statement;
            return {
                bind(...args) {
                    const bound = statement.bind(...args);
                    return {
                        async run() {
                            writeAttempts += 1;
                            if (writeAttempts === 1) {
                                await db.prepare("UPDATE probe_settings SET value = ? WHERE key = ?")
                                    .bind(args[0], key)
                                    .run();
                            }
                            return bound.run();
                        },
                    };
                },
            };
        },
    };

    Date.now = () => fixedNow;
    try {
        const switched = await callApi(interleavedDb, '/api/proxy/switch', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { target_ip: ip, switch_mode: 'full' },
        });
        assert.equal(switched.response.status, 200);
        assert.equal(writeAttempts, 2);
        assert.equal(switched.payload.switch_trigger, fixedNow + 1);

        const finalConfig = await callApi(db, `/api/proxy/config?ip=${ip}`, { token: ADMIN_TOKEN });
        assert.equal(finalConfig.payload.switch_mode, 'full');
        assert.equal(finalConfig.payload.switch_trigger, fixedNow + 1);
    } finally {
        Date.now = realNow;
    }
});

test('concurrent first switches inherit the global config with distinct triggers', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.15';
    await db.prepare("INSERT INTO probe_settings (key, value) VALUES (?, ?)")
        .bind('proxy_slot_map', JSON.stringify({
            '0': 'US',
            country: 'US',
            port: 8888,
            listen_host: '',
            public_listener: true,
            switch_mode: 'hot',
            switch_trigger: 100,
        }))
        .run();

    let reads = 0;
    let releaseReads;
    const bothReads = new Promise(resolve => { releaseReads = resolve; });
    const slowDb = {
        ...db,
        prepare(sql) {
            const statement = db.prepare(sql);
            if (!/SELECT value FROM probe_settings WHERE key = \?/.test(sql)) return statement;
            return {
                bind(...args) {
                    const bound = statement.bind(...args);
                    if (!String(args[0] || '').startsWith('proxy_slot_map')) return bound;
                    return {
                        async first() {
                            reads += 1;
                            if (reads >= 2) releaseReads();
                            await Promise.race([
                                bothReads,
                                new Promise(resolve => setTimeout(resolve, 40)),
                            ]);
                            return bound.first();
                        },
                    };
                },
            };
        },
    };

    const [first, second] = await Promise.all([
        callApi(slowDb, '/api/proxy/switch', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, switch_mode: 'hot' },
        }),
        callApi(slowDb, '/api/proxy/switch', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, switch_mode: 'full' },
        }),
    ]);
    assert.equal(first.response.status, 200);
    assert.equal(second.response.status, 200);
    assert.notEqual(first.payload.switch_trigger, second.payload.switch_trigger);

    const finalConfig = await callApi(db, `/api/proxy/config?ip=${ip}`, { token: ADMIN_TOKEN });
    assert.equal(finalConfig.payload.country, 'US');
    assert.equal(finalConfig.payload.port, 8888);
    assert.equal(finalConfig.payload.public_listener, true);
    assert.ok(finalConfig.payload.switch_trigger > 100);
    assert.ok(Math.max(first.payload.switch_trigger, second.payload.switch_trigger) <= finalConfig.payload.switch_trigger);
});

test('proxy writes fail clearly after bounded optimistic concurrency retries', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.12';
    await db.prepare("INSERT INTO probe_settings (key, value) VALUES (?, ?)")
        .bind(`proxy_slot_map_${ip}`, JSON.stringify({ '0': 'US', country: 'US', port: 8888, switch_trigger: 100 }))
        .run();

    let writeAttempts = 0;
    const contendedDb = {
        ...db,
        prepare(sql) {
            const statement = db.prepare(sql);
            if (!/^UPDATE probe_settings SET value = \? WHERE key = \? AND value IS \?$/.test(sql)) return statement;
            return {
                bind(...args) {
                    const bound = statement.bind(...args);
                    return {
                        async run() {
                            writeAttempts += 1;
                            await bound.run();
                            await db.prepare("UPDATE probe_settings SET value = ? WHERE key = ?")
                                .bind(JSON.stringify({ '0': 'US', country: 'US', port: 9999, switch_trigger: 100 + writeAttempts }), `proxy_slot_map_${ip}`)
                                .run();
                            return { success: true, meta: { changes: 0 } };
                        },
                    };
                },
            };
        },
    };

    const switched = await callApi(contendedDb, '/api/proxy/switch', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip, switch_mode: 'full' },
    });
    assert.equal(switched.response.status, 409);
    assert.match(switched.payload.error, /concurrent writes/i);
    assert.equal(writeAttempts, 5);
});

test('realtime notify is bounded, best-effort, and silently degrades', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response('{}', { status: 200 });
    };
    try {
        const env = { REALTIME_URL: 'https://realtime.example', REALTIME_AUTH_SECRET: 's'.repeat(32) };
        const db = { prepare: () => { throw new Error('configured realtime must not query D1'); } };
        assert.equal(await __test.notifyRealtimeVps(env, db, '203.0.113.8'), true);
        assert.equal(calls.length, 1);
        assert.equal(new URL(calls[0].url).pathname, '/notify');
        assert.ok(calls[0].init.signal instanceof AbortSignal);

        globalThis.fetch = async () => { throw new Error('realtime offline'); };
        assert.equal(await __test.notifyRealtimeVps(env, db, '203.0.113.8'), false);

        globalThis.fetch = async () => new Response('unavailable', { status: 503 });
        assert.equal(await __test.notifyRealtimeVps(env, db, '203.0.113.8'), false);

        const presenceDb = {
            prepare: () => ({
                bind: () => ({ first: async () => ({ agent_token: 'agent-token' }) }),
            }),
        };
        const presenceEnv = {
            VPS_PRESENCE: {
                idFromName: name => name,
                get: () => ({ fetch: async () => new Response('unavailable', { status: 503 }) }),
            },
        };
        assert.equal(await __test.notifyRealtimeVps(presenceEnv, presenceDb, '203.0.113.8'), false);

        globalThis.fetch = async () => { throw new Error('must not be called'); };
        assert.equal(await __test.notifyRealtimeVps({}, db, '203.0.113.8'), false);
        assert.equal(calls.length, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('proxy config and switch schedule realtime notify without failing the API', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.8';
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response('{}', { status: 200 });
    };
    try {
        const env = { REALTIME_URL: 'https://realtime.example', REALTIME_AUTH_SECRET: 's'.repeat(32) };
        const configured = await callApi(db, '/api/proxy/config', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, country: 'JP', switch_mode: 'hot' },
        }, env);
        assert.equal(configured.response.status, 200);
        assert.equal(calls.filter(call => new URL(call.url).pathname === '/notify').length, 1);

        const switched = await callApi(db, '/api/proxy/switch', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, switch_mode: 'full' },
        }, env);
        assert.equal(switched.response.status, 200);
        assert.equal(calls.filter(call => new URL(call.url).pathname === '/notify').length, 2);

        globalThis.fetch = async () => { throw new Error('realtime offline'); };
        const degraded = await callApi(db, '/api/proxy/config', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, country: 'JP' },
        }, env);
        assert.equal(degraded.response.status, 200);
        assert.equal(degraded.payload.success, true);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('proxy countries cache uses a five-minute TTL, refresh bypass, and stale fallback', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    __test.clearProxyCaches();
    const originalFetch = globalThis.fetch;
    const realNow = Date.now;
    let now = realNow();
    let calls = 0;
    let csv = vpngateCsv([['198.51.100.1', 'JP'], ['198.51.100.2', 'US']]);
    globalThis.fetch = async () => {
        calls += 1;
        return new Response(csv, { status: 200, headers: { 'Content-Type': 'text/csv' } });
    };
    Date.now = () => now;
    try {
        const first = await callApi(db, '/api/proxy/countries', { token: ADMIN_TOKEN });
        assert.equal(first.response.status, 200);
        assert.equal(calls, 1);
        assert.equal(first.payload.find(item => item.code === 'JP').nodes, 1);
        assert.equal(first.payload.find(item => item.code === 'US').nodes, 1);

        const cached = await callApi(db, '/api/proxy/countries', { token: ADMIN_TOKEN });
        assert.equal(cached.response.status, 200);
        assert.equal(calls, 1);

        csv = vpngateCsv([['198.51.100.3', 'KR']]);
        const refreshed = await callApi(db, '/api/proxy/countries?refresh=1', { token: ADMIN_TOKEN });
        assert.equal(refreshed.response.status, 200);
        assert.equal(calls, 2);
        assert.equal(refreshed.payload.find(item => item.code === 'KR').nodes, 1);
        assert.equal(refreshed.payload.find(item => item.code === 'JP').nodes, 0);

        now += 5 * 60 * 1000 + 1;
        globalThis.fetch = async () => { throw new Error('VPNGate unavailable'); };
        const stale = await callApi(db, '/api/proxy/countries', { token: ADMIN_TOKEN });
        assert.equal(stale.response.status, 200);
        assert.equal(calls, 2);
        assert.equal(stale.payload.find(item => item.code === 'KR').nodes, 1);

        __test.clearProxyCaches();
        const fallback = await callApi(db, '/api/proxy/countries', { token: ADMIN_TOKEN });
        assert.equal(fallback.response.status, 200);
        assert.ok(fallback.payload.some(item => item.code === 'JP' && item.nodes === null));
    } finally {
        Date.now = realNow;
        globalThis.fetch = originalFetch;
        __test.clearProxyCaches();
    }
});

test('validateProxyReport normalizes optional purity fields and preserves legacy compatibility', () => {
    const valid = validateProxyReport({
        ip: '198.51.100.20',
        details: [
            {
                tunnel: 'tun_main',
                active: true,
                node_ip: '203.0.113.10',
                exit_ip: '203.0.113.10',
                country: 'JP',
                port: 7920,
                is_residential: true,
                is_native: true,
                fraud_score: 14.6,
                ipok_risk: 8.2,
                purity_source: 'IPPure+IPOK',
                asn_org: 'NTT Communications <script>alert(1)</script>',
            },
            {
                tunnel: 'tun_backup',
                active: false,
                node_ip: '203.0.113.11',
                exit_ip: '203.0.113.11',
                country: 'JP',
                port: 7920,
                is_residential: 'yes',
                is_native: 1,
                fraud_score: 120,
                ipok_risk: -5,
                purity_source: 'bad!!source',
                asn_org: '\u0000\u0007',
            },
            {
                tunnel: 'tun_legacy',
                active: false,
                node_ip: '203.0.113.12',
                country: 'US',
                port: 7920,
            },
        ],
    });

    assert.equal(valid.details[0].is_residential, true);
    assert.equal(valid.details[0].is_native, true);
    assert.equal(valid.details[0].fraud_score, 15);
    assert.equal(valid.details[0].ipok_risk, 8);
    assert.equal(valid.details[0].purity_source, 'ippure+ipok');
    assert.equal(valid.details[0].asn_org, 'NTT Communications scriptalert(1)/script');
    assert.doesNotMatch(valid.details[0].asn_org, /[<>]/);

    assert.equal(Object.hasOwn(valid.details[1], 'is_residential'), false);
    assert.equal(Object.hasOwn(valid.details[1], 'is_native'), false);
    assert.equal(Object.hasOwn(valid.details[1], 'fraud_score'), false);
    assert.equal(Object.hasOwn(valid.details[1], 'ipok_risk'), false);
    assert.equal(valid.details[1].purity_source, 'badsource');
    assert.equal(Object.hasOwn(valid.details[1], 'asn_org'), false);

    assert.equal(Object.hasOwn(valid.details[2], 'is_residential'), false);
    assert.equal(Object.hasOwn(valid.details[2], 'fraud_score'), false);
    assert.equal(Object.hasOwn(valid.details[2], 'ipok_risk'), false);
});

test('/api/data exposes active and standby exit purity metadata and UI renders IPOK attribution', async () => {
    const db = createSqliteD1(':memory:');
    await __test.ensureDbSchema(db);
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    await seedServer(db, '198.51.100.30', 'agent-secret');
    await seedProxyState(db, '198.51.100.30', [
        {
            tunnel: 'tun_main',
            active: true,
            node_ip: '203.0.113.21',
            exit_ip: '203.0.113.21',
            country: 'JP',
            port: 7920,
            is_residential: true,
            is_native: true,
            fraud_score: 12,
            ipok_risk: 8,
            purity_source: 'ippure+ipok',
            asn_org: 'KDDI Corporation',
        },
        {
            tunnel: 'tun_backup',
            active: false,
            node_ip: '203.0.113.22',
            exit_ip: '203.0.113.22',
            country: 'JP',
            port: 7920,
            is_residential: true,
            is_native: false,
            fraud_score: 36,
            purity_source: 'ippure',
        },
    ]);

    const { response, payload } = await callApi(db, '/api/data', { token: ADMIN_TOKEN });
    assert.equal(response.status, 200);
    const server = payload.servers.find(item => item.ip === '198.51.100.30');
    assert.deepEqual(server.residential_active_purity, {
        is_residential: true,
        is_native: true,
        fraud_score: 12,
        ipok_risk: 8,
        purity_source: 'ippure+ipok',
        asn_org: 'KDDI Corporation',
    });
    assert.deepEqual(server.residential_standby_purity, {
        is_residential: true,
        is_native: false,
        fraud_score: 36,
        purity_source: 'ippure',
    });

    const serversPage = fs.readFileSync(new URL('../frontend/src/pages/ServersPage.vue', import.meta.url), 'utf8');
    const proxyPage = fs.readFileSync(new URL('../frontend/src/pages/ResidentialProxyPage.vue', import.meta.url), 'utf8');
    assert.match(serversPage, /formatExitPurityMeta\(vps\.residential_active_purity\)/);
    assert.match(serversPage, /formatExitPurityMeta\(vps\.residential_standby_purity\)/);
    assert.match(serversPage, /https:\/\/ipok\.io/);
    assert.match(proxyPage, /id="pc-ip-score-link"/);
    assert.match(proxyPage, /https:\/\/ipok\.io/);
});

test('proxy countries falls back to official VPN Gate index when CSV is unavailable', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    __test.clearProxyCaches();
    const originalFetch = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async url => {
        urls.push(url);
        if (url.includes('/api/iphone/')) return new Response('unavailable', { status: 503 });
        return new Response('<table><tr><td><img src="../images/flags/JP.png"></td><td><a href="do_openvpn.aspx?ip=1">OpenVPN</a></td></tr><tr><td><img src="../images/flags/US.png"></td><td><a href="do_openvpn.aspx?ip=2">OpenVPN</a></td></tr><tr><td><img src="../images/flags/JP.png"></td><td><a href="do_openvpn.aspx?ip=3">OpenVPN</a></td></tr></table>');
    };
    try {
        const result = await callApi(db, '/api/proxy/countries', { token: ADMIN_TOKEN });
        assert.equal(result.payload.find(item => item.code === 'JP').nodes, 2);
        assert.equal(result.payload.find(item => item.code === 'US').nodes, 1);
        assert.equal(urls.length, 2);
    } finally {
        globalThis.fetch = originalFetch;
        __test.clearProxyCaches();
    }
});

test('testisp lookup caches only successful JSON for fifteen minutes and stays bounded', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    __test.clearProxyCaches();
    const originalFetch = globalThis.fetch;
    const realNow = Date.now;
    let now = realNow();
    let calls = 0;
    let response = () => new Response(JSON.stringify({ geo: { country: 'US' }, isp: { org: 'Example' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
    globalThis.fetch = async () => {
        calls += 1;
        return response();
    };
    Date.now = () => now;
    try {
        const first = await callApi(db, '/api/proxy/testisp-lookup/198.51.100.1', { token: ADMIN_TOKEN });
        assert.equal(first.response.status, 200);
        assert.equal(first.payload.geo.country, 'US');
        assert.equal(calls, 1);

        const cached = await callApi(db, '/api/proxy/testisp-lookup/198.51.100.1', { token: ADMIN_TOKEN });
        assert.equal(cached.response.status, 200);
        assert.equal(calls, 1);

        await callApi(db, '/api/proxy/testisp-lookup/198.51.100.2', { token: ADMIN_TOKEN });
        assert.equal(calls, 2);

        response = () => new Response(JSON.stringify({ error: 'rate limited' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
        });
        await callApi(db, '/api/proxy/testisp-lookup/198.51.100.3', { token: ADMIN_TOKEN });
        await callApi(db, '/api/proxy/testisp-lookup/198.51.100.3', { token: ADMIN_TOKEN });
        assert.equal(calls, 4);

        response = () => new Response('<html>upstream error</html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
        });
        await callApi(db, '/api/proxy/testisp-lookup/198.51.100.4', { token: ADMIN_TOKEN });
        await callApi(db, '/api/proxy/testisp-lookup/198.51.100.4', { token: ADMIN_TOKEN });
        assert.equal(calls, 6);

        response = () => new Response(JSON.stringify({ geo: { country: 'US' }, isp: { org: 'Example' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
        now += 15 * 60 * 1000 + 1;
        await callApi(db, '/api/proxy/testisp-lookup/198.51.100.1', { token: ADMIN_TOKEN });
        assert.equal(calls, 7);

        for (let index = 0; index < 260; index += 1) {
            const ip = `10.0.${Math.floor(index / 250)}.${(index % 250) + 1}`;
            const result = await __test.lookupTestIsp(ip);
            assert.equal(result.status, 200);
        }
        assert.ok(__test.proxyTestIspCacheSize() <= 256);
    } finally {
        Date.now = realNow;
        globalThis.fetch = originalFetch;
        __test.clearProxyCaches();
    }
});

function ipokPayload(overrides = {}) {
    return {
        geo: {
            ip: '198.51.100.20',
            asn: 'AS64500',
            isp: 'Example Residential ISP',
            org: 'Example Residential Network',
            countryCode: 'US',
            region: 'California',
            city: 'Los Angeles',
            timezone: 'America/Los_Angeles',
            reverse: 'host.example.test',
        },
        ipType: 'residential',
        nativeType: 'native',
        usageType: 'residential',
        sharedUsers: '2-5',
        risk: 18,
        riskAssessment: { scoreAvailable: true },
        signals: ['clean', 'residential'],
        flags: { proxy: false, hosting: false, vpn: false, tor: false, mobile: false, abuser: false },
        blocklist: { listed: 0, checked: 12, total: 12 },
        services: [{ key: 'netflix', name: 'Netflix', status: 'ok' }],
        media: ['netflix'],
        scenarios: [{ key: 'ai', stars: 4.5, verdict: 'ok' }],
        sources: [{ source: 'ipok', risk: 18 }],
        ...overrides,
    };
}

test('ip-profile requires admin auth and only accepts public IP addresses', async () => {
    const db = await createProxyDb();
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls += 1;
        return Response.json(ipokPayload());
    };
    try {
        const anonymous = await callApi(db, '/api/proxy/ip-profile/198.51.100.20');
        assert.equal(anonymous.response.status, 403);

        await seedSession(db, 'viewer', 'v'.repeat(48));
        const viewer = await callApi(db, '/api/proxy/ip-profile/198.51.100.20', { token: 'v'.repeat(48) });
        assert.equal(viewer.response.status, 403);

        await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
        for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1', '192.168.1.1', '203.0.113.8', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', '2001:db8::1', '::ffff:10.0.0.1', 'not-an-ip']) {
            const rejected = await callApi(db, `/api/proxy/ip-profile/${encodeURIComponent(ip)}`, { token: ADMIN_TOKEN });
            assert.equal(rejected.response.status, 400, ip);
        }
        assert.equal(__test.isPublicIp('8.8.8.8'), true);
        assert.equal(__test.isPublicIp('2606:4700:4700::1111'), true);
        assert.equal(__test.isPublicIp('::ffff:8.8.8.8'), true);
        assert.equal(calls, 0);
    } finally {
        globalThis.fetch = originalFetch;
        __test.clearProxyCaches();
    }
});

test('ip-profile normalizes ipok data, serves LRU cache hits, and honors refresh cooldown', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    __test.clearProxyCaches();
    const originalFetch = globalThis.fetch;
    const realNow = Date.now;
    let now = realNow();
    const calls = [];
    globalThis.fetch = async url => {
        calls.push(String(url));
        return Response.json(ipokPayload());
    };
    Date.now = () => now;
    try {
        const first = await callApi(db, '/api/proxy/ip-profile/8.8.8.8', { token: ADMIN_TOKEN });
        assert.equal(first.response.status, 200);
        assert.equal(calls.length, 1);
        assert.match(calls[0], /^https:\/\/ipok\.io\/api\/ip\?ip=8\.8\.8\.8$/);
        assert.equal(first.payload.ip, '8.8.8.8');
        assert.equal(first.payload.source, 'ipok');
        assert.equal(first.payload.cached, false);
        assert.equal(first.payload.ipok_risk, 18);
        assert.equal(first.payload.fraud_score, null);
        assert.equal(first.payload.is_residential, true);
        assert.equal(first.payload.is_native, true);
        assert.equal(first.payload.isp, 'Example Residential ISP');
        assert.equal(first.payload.asn_org, 'Example Residential Network');
        assert.equal(first.payload.country, 'US');
        assert.equal(first.payload.ip_profile.asn, 'AS64500');
        assert.equal(first.payload.ip_profile.country_code, 'US');
        assert.deepEqual(first.payload.ip_profile.blocklist, { listed: 0, checked: 12, total: 12 });
        assert.equal(first.payload.ip_profile.services[0].key, 'netflix');
        assert.equal(first.payload.ip_profile.scenarios[0].stars, 4.5);
        assert.deepEqual(first.payload.ip_profile.sources, [{ source: 'ipok', risk: 18 }]);
        assert.ok(first.payload.ip_profile.checked_at > 0);

        const cached = await callApi(db, '/api/proxy/ip-profile/8.8.8.8', { token: ADMIN_TOKEN });
        assert.equal(cached.response.status, 200);
        assert.equal(calls.length, 1);
        assert.equal(cached.payload.cached, true);

        now += 30 * 1000;
        const cooling = await callApi(db, '/api/proxy/ip-profile/8.8.8.8?refresh=1', { token: ADMIN_TOKEN });
        assert.equal(cooling.response.status, 200);
        assert.equal(calls.length, 1);
        assert.equal(cooling.payload.cached, true);
        assert.equal(cooling.payload.cooldown, true);

        now += 31 * 1000;
        const refreshed = await callApi(db, '/api/proxy/ip-profile/8.8.8.8?refresh=1', { token: ADMIN_TOKEN });
        assert.equal(refreshed.response.status, 200);
        assert.equal(calls.length, 2);
        assert.equal(refreshed.payload.cached, false);

        for (let index = 0; index < 260; index += 1) {
            await __test.lookupIpProfile(`8.8.${Math.floor(index / 250)}.${(index % 250) + 1}`);
        }
        assert.ok(__test.ipProfileCacheSize() <= 256);
    } finally {
        Date.now = realNow;
        globalThis.fetch = originalFetch;
        __test.clearProxyCaches();
    }
});

test('ip-profile falls back to testisp when ipok fails and returns bounded upstream errors', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    __test.clearProxyCaches();
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async url => {
        const target = String(url);
        calls.push(target);
        if (target.startsWith('https://ipok.io/')) return new Response('upstream down', { status: 503 });
        return Response.json({
            geo: { countryCode: 'JP', is_native: true },
            isp: { org: 'Fallback ISP', type: 'residential' },
            ipType: 'residential',
            signals: ['clean'],
        });
    };
    try {
        const result = await callApi(db, '/api/proxy/ip-profile/8.8.4.4', { token: ADMIN_TOKEN });
        assert.equal(result.response.status, 200);
        assert.equal(result.payload.source, 'testisp');
        assert.equal(result.payload.isp, 'Fallback ISP');
        assert.equal(result.payload.country, 'JP');
        assert.equal(result.payload.ip_profile.ip_type, 'residential');
        assert.equal(result.payload.ip_profile.flags.proxy, false);
        assert.match(calls[1], /^https:\/\/testisp\.info\/api\/check\?ip=8\.8\.4\.4$/);

        __test.clearProxyCaches();
        globalThis.fetch = async () => new Response('<html>bad gateway</html>', { status: 200 });
        const failed = await callApi(db, '/api/proxy/ip-profile/1.1.1.1', { token: ADMIN_TOKEN });
        assert.equal(failed.response.status, 502);
        assert.equal(failed.payload.code, 'IP_PROFILE_UPSTREAM_FAILED');
        assert.equal(Object.hasOwn(failed.payload, 'stack'), false);

        __test.clearProxyCaches();
        globalThis.fetch = async url => {
            const target = String(url);
            calls.push(target);
            if (target.startsWith('https://ipok.io/')) return Response.json({});
            return Response.json({ error: 'no profile data' });
        };
        const empty = await callApi(db, '/api/proxy/ip-profile/9.9.9.9', { token: ADMIN_TOKEN });
        assert.equal(empty.response.status, 502);
        assert.equal(empty.payload.code, 'IP_PROFILE_UPSTREAM_FAILED');
    } finally {
        globalThis.fetch = originalFetch;
        __test.clearProxyCaches();
    }
});

test('proxy probe validates admin input and persists a monotonic trigger without clobbering config', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.31';
    const originalFetch = globalThis.fetch;
    const notifyCalls = [];
    globalThis.fetch = async URLValue => {
        notifyCalls.push(String(URLValue));
        return new Response('{}', { status: 200 });
    };
    try {
        const anonymous = await callApi(db, '/api/proxy/probe', {
            method: 'POST',
            body: { ip, action: 'recheck_purity' },
        });
        assert.equal(anonymous.response.status, 403);
        assert.equal(notifyCalls.length, 0);

        for (const body of [
            { ip: '*', action: 'recheck_purity' },
            { ip: '', action: 'recheck_purity' },
            { ip: '203.0.113.31,203.0.113.32', action: 'recheck_purity' },
            { ip, action: 'unknown' },
            { ip, action: 'recheck_purity', role: 'primary' },
        ]) {
            const rejected = await callApi(db, '/api/proxy/probe', {
                method: 'POST',
                token: ADMIN_TOKEN,
                body,
            });
            assert.equal(rejected.response.status, 400, JSON.stringify(body));
        }

        const env = { REALTIME_URL: 'https://realtime.example', REALTIME_AUTH_SECRET: 's'.repeat(32) };
        const configured = await callApi(db, '/api/proxy/config', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, country: 'US', port: 8899, switch_mode: 'full' },
        }, env);
        assert.equal(configured.response.status, 200);
        assert.equal(configured.payload.slot_map.probe_trigger, undefined);

        notifyCalls.length = 0;
        const first = await callApi(db, '/api/proxy/probe', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, action: 'recheck_purity', role: 'active' },
        }, env);
        assert.equal(first.response.status, 200);
        assert.equal(first.payload.ok, true);
        assert.equal(first.payload.ip, ip);
        assert.equal(first.payload.action, 'recheck_purity');
        assert.equal(first.payload.role, 'active');
        assert.ok(Number.isSafeInteger(first.payload.probe_trigger));
        assert.equal(notifyCalls.filter(value => new URL(value).pathname === '/notify').length, 1);

        const second = await callApi(db, '/api/proxy/probe', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, action: 'probe_latency', role: 'standby' },
        }, env);
        assert.equal(second.response.status, 200);
        assert.ok(second.payload.probe_trigger > first.payload.probe_trigger);
        assert.equal(second.payload.role, 'standby');
        assert.equal(notifyCalls.filter(value => new URL(value).pathname === '/notify').length, 2);

        const saved = await db.prepare('SELECT value FROM probe_settings WHERE key = ?').bind(`proxy_slot_map_${ip}`).first();
        const savedConfig = JSON.parse(saved.value);
        assert.equal(savedConfig.country, 'US');
        assert.equal(savedConfig.port, 8899);
        assert.equal(savedConfig.switch_mode, 'full');
        assert.equal(savedConfig.probe_trigger, undefined);

        const savedProbe = await db.prepare('SELECT value FROM probe_settings WHERE key = ?').bind(`proxy_probe_${ip}`).first();
        const savedProbeState = JSON.parse(savedProbe.value);
        assert.equal(savedProbeState.probe_trigger, second.payload.probe_trigger);
        assert.equal(savedProbeState.probe_action, 'probe_latency');
        assert.equal(savedProbeState.probe_role, 'standby');

        const configSaved = await callApi(db, '/api/proxy/config', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, country: 'JP' },
        }, env);
        assert.equal(configSaved.response.status, 200);

        const switched = await callApi(db, '/api/proxy/switch', {
            method: 'POST',
            token: ADMIN_TOKEN,
            body: { ip, switch_mode: 'hot' },
        }, env);
        assert.equal(switched.response.status, 200);

        const loadedForAgent = await callApi(db, `/api/proxy/config?ip=${ip}`, { token: ADMIN_TOKEN });
        assert.equal(loadedForAgent.response.status, 200);
        assert.equal(loadedForAgent.payload.probe_trigger, second.payload.probe_trigger);
        assert.equal(loadedForAgent.payload.probe_action, 'probe_latency');
        assert.equal(loadedForAgent.payload.probe_role, 'standby');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('proxy probe preserves global config inheritance and rejects external controller mode', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.44';
    const probe = await callApi(db, '/api/proxy/probe', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip, action: 'recheck_purity', role: 'active' },
    });
    assert.equal(probe.response.status, 200);
    const overrideRow = await db.prepare('SELECT value FROM probe_settings WHERE key = ?').bind(`proxy_slot_map_${ip}`).first();
    assert.equal(overrideRow, null);

    const globalUpdate = await callApi(db, '/api/proxy/config', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { country: 'SG', port: 7931 },
    });
    assert.equal(globalUpdate.response.status, 200);

    const agentCfg = await callApi(db, `/api/proxy/config?ip=${ip}`, { token: ADMIN_TOKEN });
    assert.equal(agentCfg.response.status, 200);
    assert.equal(agentCfg.payload.country, 'SG');
    assert.equal(agentCfg.payload.port, 7931);
    assert.equal(agentCfg.payload.probe_trigger, probe.payload.probe_trigger);
    assert.equal(agentCfg.payload.probe_action, 'recheck_purity');

    const externalProbe = await callApi(db, '/api/proxy/probe', {
        method: 'POST',
        token: ADMIN_TOKEN,
        body: { ip, action: 'recheck_purity', role: 'active' },
    }, { PROXY_CTRL_URL: 'https://controller.example.com' });
    assert.equal(externalProbe.response.status, 501);
    assert.equal(externalProbe.payload.code, 'PROXY_PROBE_UNSUPPORTED');
});

test('HTTP proxy report preserves bounded Scheme B load metrics and ip_profile round-trip', async () => {
    const db = await createProxyDb();
    await db.exec('CREATE TABLE IF NOT EXISTS server_logs (ip TEXT PRIMARY KEY, logs TEXT, updated_at INTEGER);');
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ip = '203.0.113.55';
    const agentToken = 'agent-secret-token-for-report-roundtrip';
    await db.prepare('INSERT INTO servers (ip, name, agent_token) VALUES (?, ?, ?)').bind(ip, 'jp-edge', agentToken).run();
    const report = await callApi(db, '/api/proxy/report', {
        method: 'POST',
        authorization: agentToken,
        body: {
            ip,
            details: [{
                tunnel: 'tun_main',
                active: true,
                ready: true,
                country: 'JP',
                port: 7920,
                node_ip: '198.51.100.1',
                exit_ip: '198.51.100.2',
                ttfb_ms: 145,
                speed_kbps: 2400,
                connected_time: 1200,
                is_residential: true,
                is_native: true,
                fraud_score: 5,
                ipok_risk: 8,
                active_conns: 4,
                max_conns: 256,
                bytes_up: 10240,
                bytes_down: 987654,
                latency_checked_at: 1700000000100,
                purity_checked_at: 1700000000200,
                ipok_checked_at: 1700000000300,
                ip_profile: {
                    asn: 'AS2516',
                    isp: 'KDDI CORPORATION',
                    country_code: 'jp',
                    city: 'Tokyo',
                    ip_type: 'residential',
                    native_type: 'native',
                    checked_at: 1700000000400,
                    source: 'ippure+ipok',
                    flags: { proxy: false, hosting: false, vpn: false, tor: false, mobile: false, abuser: false },
                    blocklist: { listed: 0, checked: 5, total: 5 },
                    services: [{ key: 'chatgpt', name: 'ChatGPT', status: '可用' }],
                    extra_untrusted_blob: 'drop-me',
                },
            }],
        },
    });
    assert.equal(report.response.status, 200);

    const nodes = await callApi(db, '/api/proxy/nodes', { token: ADMIN_TOKEN });
    assert.equal(nodes.response.status, 200);
    const target = nodes.payload.find(item => item.ip === ip);
    assert.ok(target);
    const details = typeof target.details === 'string' ? JSON.parse(target.details) : target.details;
    const detail = details[0];
    assert.equal(detail.active_conns, 4);
    assert.equal(detail.max_conns, 256);
    assert.equal(detail.bytes_up, 10240);
    assert.equal(detail.bytes_down, 987654);
    assert.equal(detail.latency_checked_at, 1700000000100);
    assert.equal(detail.ip_profile.asn, 'AS2516');
    assert.equal(detail.ip_profile.country_code, 'JP');
    assert.equal(detail.ip_profile.extra_untrusted_blob, undefined);
});

test('ip-profile canonicalizes IPv6 keys, coalesces in-flight misses, limits stream size, and cools down failures', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    __test.clearProxyCaches();
    const originalFetch = globalThis.fetch;
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
        let ipv6Calls = 0;
        let releaseFirst;
        const gate = new Promise(resolve => { releaseFirst = resolve; });
        globalThis.fetch = async () => {
            ipv6Calls += 1;
            await gate;
            return Response.json(ipokPayload());
        };
        const pendingA = callApi(db, `/api/proxy/ip-profile/${encodeURIComponent('2606:4700:4700::1111')}`, { token: ADMIN_TOKEN });
        const pendingB = callApi(db, `/api/proxy/ip-profile/${encodeURIComponent('2606:4700:4700:0000:0000:0000:0000:1111')}`, { token: ADMIN_TOKEN });
        releaseFirst();
        const [resA, resB] = await Promise.all([pendingA, pendingB]);
        assert.equal(resA.response.status, 200);
        assert.equal(resB.response.status, 200);
        assert.equal(ipv6Calls, 1);

        const hitExpanded = await callApi(db, `/api/proxy/ip-profile/${encodeURIComponent('2606:4700:4700:0:0:0:0:1111')}`, { token: ADMIN_TOKEN });
        assert.equal(hitExpanded.response.status, 200);
        assert.equal(hitExpanded.payload.cached, true);
        assert.equal(ipv6Calls, 1);

        let oversizeCalls = 0;
        globalThis.fetch = async () => {
            oversizeCalls += 1;
            return new Response('x'.repeat(600 * 1024), { status: 200 });
        };
        const firstFail = await callApi(db, '/api/proxy/ip-profile/8.8.1.1', { token: ADMIN_TOKEN });
        assert.equal(firstFail.response.status, 502);
        assert.equal(oversizeCalls, 2);

        const cooledFail = await callApi(db, '/api/proxy/ip-profile/8.8.1.1', { token: ADMIN_TOKEN });
        assert.equal(cooledFail.response.status, 502);
        assert.equal(oversizeCalls, 2);
    } finally {
        Date.now = realNow;
        globalThis.fetch = originalFetch;
        __test.clearProxyCaches();
    }
});

test('ip-profile TestISP fallback bypasses legacy raw-body cache on forced refresh after cooldown', async () => {
    const db = await createProxyDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    __test.clearProxyCaches();
    const originalFetch = globalThis.fetch;
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
        let ipokCalls = 0;
        let testIspCalls = 0;
        globalThis.fetch = async (url) => {
            const target = String(url);
            if (target.includes('ipok.io')) {
                ipokCalls += 1;
                return new Response('unavailable', { status: 503 });
            }
            testIspCalls += 1;
            return Response.json({
                ip: '1.1.1.2',
                isp: {
                    org: testIspCalls === 1 ? 'First ISP' : 'Refreshed ISP',
                    flag: 'isp',
                    type: 'residential',
                },
                geo: {
                    country_code: 'JP',
                    region: 'Tokyo',
                    city: 'Chiyoda',
                    is_native: true,
                },
                score: {
                    overall: testIspCalls === 1 ? 82 : 95,
                },
            });
        };

        const first = await callApi(db, '/api/proxy/ip-profile/1.1.1.2', { token: ADMIN_TOKEN });
        assert.equal(first.response.status, 200);
        assert.equal(first.payload.source, 'testisp');
        assert.equal(first.payload.cached, false);
        assert.equal(first.payload.isp, 'First ISP');
        assert.equal(ipokCalls, 1);
        assert.equal(testIspCalls, 1);

        now += 61 * 1000;
        const refreshed = await callApi(db, '/api/proxy/ip-profile/1.1.1.2?refresh=1', { token: ADMIN_TOKEN });
        assert.equal(refreshed.response.status, 200);
        assert.equal(refreshed.payload.source, 'testisp');
        assert.equal(refreshed.payload.cached, false);
        assert.equal(refreshed.payload.isp, 'Refreshed ISP');
        assert.equal(ipokCalls, 2);
        assert.equal(testIspCalls, 2);
    } finally {
        Date.now = realNow;
        globalThis.fetch = originalFetch;
        __test.clearProxyCaches();
    }
});
