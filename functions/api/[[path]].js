// ==========================================
// KUI Serverless 聚合网关后端 - 精简核心版
// (包含：自动建表升级 + 极速8合1协议生成 + 探针管理 + Clash订阅 + 动态云端测速/主题)
// ==========================================

async function sha256(text) {
    const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret, message) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
    return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
}

function bytesEqual(left, right) { if (left.length !== right.length) return false; let diff = 0; for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i]; return diff === 0; }
function base64Bytes(bytes) { let output = ''; for (const byte of bytes) output += String.fromCharCode(byte); return btoa(output); }
function decodeBase64Bytes(value) { const binary = atob(value); return Uint8Array.from(binary, char => char.charCodeAt(0)); }
async function passwordHash(password, salt = crypto.getRandomValues(new Uint8Array(16)), iterations = 100000) { const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']); const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256); return `pbkdf2$${iterations}$${base64Bytes(salt)}$${base64Bytes(new Uint8Array(bits))}`; }
async function passwordMatches(password, stored) { try { if (/^[0-9a-f]{64}$/i.test(stored || '')) return bytesEqual(new TextEncoder().encode(await sha256(password)), new TextEncoder().encode(stored.toLowerCase())); const [kind, rawIterations, rawSalt, rawHash] = String(stored || '').split('$'); if (kind !== 'pbkdf2') return false; const iterations = Number(rawIterations); if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000) return false; const salt = decodeBase64Bytes(rawSalt); const expected = decodeBase64Bytes(rawHash); const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']); const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, expected.byteLength * 8); return bytesEqual(new Uint8Array(bits), expected); } catch { return false; } }
async function sessionToken() { const bytes = crypto.getRandomValues(new Uint8Array(32)); return base64Bytes(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }

function updateManifest(component, sha, length) { return `v1\n${component}\n${sha}\n${length}\n`; }

const MAX_REPORT_BYTES = 256 * 1024;
const MAX_PROXY_REPORT_BYTES = 32 * 1024;
const MAX_SUBSCRIPTION_BYTES = 2 * 1024 * 1024;
const MAX_NODE_DELTA_BYTES = 1024 * 1024 * 1024 * 1024;
const MAX_REPORT_DELTA_BYTES = MAX_NODE_DELTA_BYTES * 10;

async function readJsonBody(request, maxBytes) {
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared && (!Number.isSafeInteger(declared) || declared > maxBytes)) throw new Error('Request body too large');
    const reader = request.body?.getReader();
    if (!reader) return {};
    const chunks = []; let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw new Error('Request body too large'); }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON object required');
    return parsed;
}

function validIp(value) {
    if (typeof value !== 'string' || value !== value.trim()) return false;
    if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) {
        return value.split('.').every(part => Number(part) <= 255);
    }
    if (!value.includes(':') || !/^[0-9A-Fa-f:.]{2,45}$/.test(value)) return false;
    try {
        const parsed = new URL(`http://[${value}]/`);
        return parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']') && parsed.port === '' && parsed.pathname === '/';
    } catch {
        return false;
    }
}

function normalizeWarpOptimizeRequest(value) {
    const ip = String(value?.ip || '').trim();
    const action = String(value?.action || '').trim();
    if (!validIp(ip)) throw new Error('Invalid VPS IP for WARP optimizer');
    if (!['scan', 'apply', 'cancel', 'restore', 'policy'].includes(action)) throw new Error('Invalid WARP optimizer action');
    let address = '', port = 0, policy = '';
    if (action === 'apply') {
        address = String(value?.address || '').trim().replace(/^\[|\]$/g, '');
        port = Number(value?.port);
        if (!validIp(address)) throw new Error('Invalid WARP Endpoint address');
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid WARP Endpoint port');
    }
    if (action === 'policy') {
        policy = String(value?.policy || '');
        if (!['manual', 'on_failure', 'first_enable'].includes(policy)) throw new Error('Invalid WARP optimizer policy');
    }
    return { ip, action, address, port, policy };
}
function safeProxyAddress(value) { const address = String(value || '').trim(); return validIp(address) ? address : ''; }

function normalizePingTarget(value) {
    const target = String(value || '').trim().toLowerCase();
    if (target === 'default') return target;
    try { return normalizeSocks5Address(target); }
    catch { throw new Error('Invalid ping target'); }
}

const EGRESS_MODES = new Set(['native', 'residential', 'warp_ipv4', 'warp_ipv6', 'warp_dual', 'socks5']);
const PROXY_CATEGORIES = new Set(['youtube', 'ai', 'google', 'streaming', 'custom']);

function normalizeProxyCategories(value, required = false) {
    const raw = String(value || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
    const invalid = raw.filter(item => !PROXY_CATEGORIES.has(item));
    if (invalid.length) throw new Error(`Invalid proxy category: ${invalid[0]}`);
    const categories = [...new Set(raw)].sort((left, right) => [...PROXY_CATEGORIES].indexOf(left) - [...PROXY_CATEGORIES].indexOf(right));
    if (required && !categories.length) throw new Error('Selective proxy mode requires at least one category');
    return categories.join(',');
}

function normalizeProxyCustomDomains(value) {
    const source = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
    if (source.length > 200 || JSON.stringify(source).length > 32 * 1024) throw new Error('Custom proxy domains exceed the allowed limit');
    const domains = [];
    for (const rawValue of source) {
        let domain = String(rawValue || '').trim().toLowerCase();
        if (!domain) continue;
        if (domain.startsWith('*.')) domain = domain.slice(2);
        domain = domain.replace(/\.+$/, '');
        if (!domain || domain.length > 253 || /[\x00-\x20\x7f/:?#@]/.test(domain) || domain.includes('://')) throw new Error(`Invalid custom proxy domain: ${rawValue}`);
        let hostname;
        try { hostname = new URL(`http://${domain}/`).hostname.toLowerCase().replace(/\.+$/, ''); }
        catch { throw new Error(`Invalid custom proxy domain: ${rawValue}`); }
        const labels = hostname.split('.');
        if (labels.length < 2 || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || labels.some(label => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) throw new Error(`Invalid custom proxy domain: ${rawValue}`);
        if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) throw new Error(`IP addresses are not allowed in custom proxy domains: ${rawValue}`);
        if (!domains.includes(hostname)) domains.push(hostname);
    }
    return domains.sort();
}

function normalizeSocks5Address(value) {
    const address = String(value || '').trim();
    if (!address || address.length > 253 || /[\x00-\x20\x7f/?#@]/.test(address) || address.includes('://')) throw new Error('Invalid SOCKS5 address');
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) {
        if (!address.split('.').map(Number).every(part => part >= 0 && part <= 255)) throw new Error('Invalid SOCKS5 address');
        return address;
    }
    if (address.includes(':')) {
        const unwrapped = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
        try {
            const parsed = new URL(`http://[${unwrapped}]/`);
            if (!parsed.hostname.startsWith('[') || !parsed.hostname.endsWith(']')) throw new Error();
        } catch { throw new Error('Invalid SOCKS5 address'); }
        return unwrapped.toLowerCase();
    }
    if (!/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(address)) throw new Error('Invalid SOCKS5 address');
    return address.toLowerCase();
}

function normalizeCredential(value, label, maxLength) {
    const text = String(value || '');
    if (text.length > maxLength || /[\x00-\x1f\x7f]/.test(text)) throw new Error(`Invalid SOCKS5 ${label}`);
    return text;
}

function normalizeEgressRequest(data, current = {}) {
    const mode = String(data?.egress_mode || '');
    if (!EGRESS_MODES.has(mode)) throw new Error('Invalid egress mode');
    const supportsProxyRules = mode === 'residential' || mode === 'socks5';
    const proxyMode = supportsProxyRules && data.proxy_mode === 'selective' ? 'selective' : 'global';
    const proxyCategories = supportsProxyRules ? normalizeProxyCategories(data.proxy_categories, proxyMode === 'selective') : '';
    const proxyCustomDomains = normalizeProxyCustomDomains(data.proxy_custom_domains ?? current.proxy_custom_domains);
    if (proxyMode === 'selective' && proxyCategories.split(',').includes('custom') && !proxyCustomDomains.length) throw new Error('Custom proxy category requires at least one domain');
    const desiredConfig = { mode, proxy_mode: proxyMode, proxy_categories: proxyCategories, proxy_custom_domains: proxyCustomDomains };
    let socks5 = null;
    if (mode === 'socks5') {
        const port = Number(data.socks5_port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SOCKS5 port');
        const currentPassword = String(current.socks5_pass || '');
        const suppliedPassword = normalizeCredential(data.socks5_pass, 'password', 128);
        const password = data.socks5_clear_password === true ? '' : (suppliedPassword || currentPassword);
        socks5 = {
            addr: normalizeSocks5Address(data.socks5_addr),
            port,
            user: data.socks5_clear_password === true ? '' : normalizeCredential(data.socks5_user, 'username', 64),
            pass: password,
        };
        desiredConfig.socks5 = socks5;
    }
    return { mode, proxyMode, proxyCategories, proxyCustomDomains, socks5, desiredConfig };
}

function parseEgressConfig(value, fallback) {
    try {
        const parsed = JSON.parse(value || '');
        if (parsed && EGRESS_MODES.has(parsed.mode)) return parsed;
    } catch {}
    return fallback;
}

// Proxy listeners may be exposed to a private Docker bridge, but never accept
// arbitrary hostnames here (a hostname could resolve outside the VPS later).
function sanitizeProxyListenHost(value) {
    const host = String(value ?? '').trim();
    if (!host) return '';
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
    const octets = host.split('.').map(Number);
    return octets.every(octet => octet >= 0 && octet <= 255) ? host : null;
}

async function deleteVpsRecords(db, ip) {
    await db.batch([
        db.prepare("DELETE FROM user_group_resources WHERE resource_type = 'vps' AND resource_id = ?").bind(ip),
        db.prepare("DELETE FROM user_group_resources WHERE resource_type = 'node' AND resource_id IN (SELECT id FROM nodes WHERE vps_ip = ?)").bind(ip),
        db.prepare("DELETE FROM nodes WHERE vps_ip = ?").bind(ip),
        db.prepare("DELETE FROM traffic_stats WHERE ip = ?").bind(ip),
        db.prepare("DELETE FROM traffic_daily WHERE ip = ?").bind(ip),
        db.prepare("DELETE FROM servers WHERE ip = ?").bind(ip),
        db.prepare("DELETE FROM probe_servers WHERE id = ?").bind(ip),
        db.prepare("DELETE FROM proxy_ctrl_servers WHERE ip = ?").bind(ip),
        db.prepare("DELETE FROM server_logs WHERE ip = ?").bind(ip),
        db.prepare("DELETE FROM probe_settings WHERE key = ?").bind(`proxy_slot_map_${ip}`)
    ]);
}

const SS2022_KEY_BYTES = {
    '2022-blake3-aes-128-gcm': 16,
    '2022-blake3-aes-256-gcm': 32,
};

const NODE_PROTOCOLS = new Set(['VLESS', 'XTLS-Reality', 'Reality', 'Hysteria2', 'TUIC', 'Shadowsocks2022', 'Trojan', 'H2-Reality', 'gRPC-Reality', 'AnyTLS', 'Naive', 'Socks5', 'VLESS-Argo', 'dokodemo-door', 'MTProxy']);
const REALITY_PROTOCOLS = new Set(['XTLS-Reality', 'Reality', 'H2-Reality', 'gRPC-Reality']);
const TLS_NODE_PROTOCOLS = new Set([...REALITY_PROTOCOLS, 'Hysteria2', 'Trojan', 'AnyTLS', 'Naive', 'MTProxy']);
const PASSWORD_NODE_PROTOCOLS = new Set(['TUIC', 'Shadowsocks2022', 'Trojan', 'AnyTLS', 'Naive', 'Socks5', 'MTProxy']);
const INTERNAL_RELAY_PROTOCOLS = new Set(['VLESS', 'XTLS-Reality', 'Reality', 'Hysteria2', 'TUIC', 'Shadowsocks2022', 'Trojan', 'H2-Reality', 'gRPC-Reality', 'AnyTLS']);
const UUID_NODE_PROTOCOLS = new Set(['VLESS', 'XTLS-Reality', 'Reality', 'TUIC', 'H2-Reality', 'gRPC-Reality', 'VLESS-Argo']);

function nodeTransport(protocol) {
    return protocol === 'Hysteria2' || protocol === 'TUIC' ? 'udp' : 'tcp';
}

function nodeTransports(node = {}) {
    if (node.protocol === 'Shadowsocks2022') {
        const network = String(node.network || 'tcp,udp').toLowerCase();
        if (network === 'tcp,udp') return ['tcp', 'udp'];
        if (network === 'tcp' || network === 'udp') return [network];
    }
    return [nodeTransport(node.protocol)];
}

function normalizeNodeText(value, label, maxLength, required = true) {
    const text = String(value ?? '').trim();
    if ((required && !text) || text.length > maxLength || /[\x00-\x1f\x7f]/.test(text)) throw new Error(`Invalid node ${label}`);
    return text;
}

function normalizeNodeHost(value, label) {
    const host = normalizeNodeText(value, label, 253);
    if (/[/?#@]/.test(host) || host.includes('://')) throw new Error(`Invalid node ${label}`);
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
        if (!host.split('.').map(Number).every(part => part >= 0 && part <= 255)) throw new Error(`Invalid node ${label}`);
        return host;
    }
    if (host.includes(':')) {
        const unwrapped = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
        try {
            const parsed = new URL(`http://[${unwrapped}]/`);
            if (!parsed.hostname.startsWith('[') || !parsed.hostname.endsWith(']')) throw new Error();
        } catch { throw new Error(`Invalid node ${label}`); }
        return unwrapped.toLowerCase();
    }
    if (!/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(host)) throw new Error(`Invalid node ${label}`);
    return host.toLowerCase();
}

function validateMtproxySecret(secret, domain) {
    const normalized = String(secret || '').trim().toLowerCase();
    if (!/^ee[0-9a-f]{34,}$/.test(normalized) || normalized.length % 2 !== 0) throw new Error('Invalid MTProxy FakeTLS secret');
    const domainHex = [...new TextEncoder().encode(domain)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (normalized.slice(34) !== domainHex) throw new Error('Invalid MTProxy FakeTLS secret for SNI');
    return normalized;
}

function normalizeNodePayload(input) {
    const node = { ...input };
    node.id = normalizeNodeText(node.id, 'id', 64);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(node.id)) throw new Error('Invalid node id');
    node.protocol = String(node.protocol || '');
    if (!NODE_PROTOCOLS.has(node.protocol)) throw new Error('Invalid protocol');
    node.port = Number(node.port);
    if (!Number.isInteger(node.port) || node.port < 1 || node.port > 65535) throw new Error('Invalid port');
    node.vps_ip = normalizeNodeText(node.vps_ip, 'VPS IP', 64);
    if (node.protocol === 'Shadowsocks2022') {
        node.network = String(node.network || 'tcp,udp').toLowerCase();
        if (!['tcp', 'udp', 'tcp,udp'].includes(node.network)) throw new Error('Invalid Shadowsocks2022 network');
    } else {
        node.network = node.protocol === 'H2-Reality' ? 'http' : (node.protocol === 'gRPC-Reality' ? 'grpc' : 'tcp');
    }
    node.traffic_limit = Number(node.traffic_limit || 0);
    node.expire_time = Number(node.expire_time || 0);
    if (!Number.isSafeInteger(node.traffic_limit) || node.traffic_limit < 0) throw new Error('Invalid node traffic limit');
    if (!Number.isSafeInteger(node.expire_time) || node.expire_time < 0) throw new Error('Invalid node expiry');

    if (node.protocol !== 'dokodemo-door') node.uuid = normalizeNodeText(node.uuid, 'UUID/username', 128);
    if (UUID_NODE_PROTOCOLS.has(node.protocol) && !/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(node.uuid)) throw new Error('Invalid node UUID');
    if (node.protocol === 'TUIC') node.sni = '';
    else if (node.protocol === 'MTProxy') node.sni = normalizeNodeHost(node.sni, 'MTProxy TLS domain');
    else if (TLS_NODE_PROTOCOLS.has(node.protocol)) node.sni = normalizeNodeHost(node.sni || 'addons.mozilla.org', 'SNI');
    else node.sni = normalizeNodeText(node.sni, 'SNI', 253, false);

    if (REALITY_PROTOCOLS.has(node.protocol)) {
        node.private_key = normalizeNodeText(node.private_key, 'Reality private key', 64);
        node.public_key = normalizeNodeText(node.public_key, 'Reality public key', 64);
        node.short_id = normalizeNodeText(node.short_id, 'Reality short ID', 32);
        if (!/^[A-Za-z0-9_-]{43}$/.test(node.private_key) || !/^[A-Za-z0-9_-]{43}$/.test(node.public_key)) throw new Error('Invalid Reality key');
        if (!/^(?:[0-9A-Fa-f]{2}){1,16}$/.test(node.short_id)) throw new Error('Invalid Reality short ID');
    }
    if (node.protocol === 'MTProxy') node.private_key = normalizeNodeText(node.private_key, 'password', 1024);
    else if (PASSWORD_NODE_PROTOCOLS.has(node.protocol)) node.private_key = normalizeNodeText(node.private_key, 'password', 256);
    if (node.protocol === 'Shadowsocks2022') validateSs2022Credentials(node.uuid, node.private_key);
    if (node.protocol === 'MTProxy') node.private_key = validateMtproxySecret(node.private_key, node.sni);

    if (node.protocol === 'dokodemo-door') {
        if (!['internal', 'external'].includes(node.relay_type)) throw new Error('Invalid relay type');
        if (node.relay_type === 'external') {
            node.target_ip = normalizeNodeHost(node.target_ip, 'relay target');
            node.target_port = Number(node.target_port);
            if (!Number.isInteger(node.target_port) || node.target_port < 1 || node.target_port > 65535) throw new Error('Invalid relay target');
            node.target_id = null;
        } else {
            node.target_id = normalizeNodeText(node.target_id, 'relay target ID', 64);
            if (!/^[A-Za-z0-9_-]{1,64}$/.test(node.target_id)) throw new Error('Invalid relay target ID');
            node.target_ip = null;
            node.target_port = null;
        }
    }
    return node;
}

function nodeListenerConflicts(existing, candidate) {
    const candidateTransports = new Set(nodeTransports(candidate));
    return (existing || []).some(node => String(node.id) !== String(candidate.id) && Number(node.port) === Number(candidate.port) && nodeTransports(node).some(transport => candidateTransports.has(transport)));
}

function validateSs2022Credentials(method, password) {
    const expectedBytes = SS2022_KEY_BYTES[String(method || '')];
    if (!expectedBytes) throw new Error('Invalid Shadowsocks 2022 method');
    if (typeof password !== 'string' || password.length > 128 || !/^[A-Za-z0-9+/]+={0,2}$/.test(password)) throw new Error('Invalid Shadowsocks 2022 key');
    let decoded;
    try { decoded = decodeBase64Bytes(password); } catch { throw new Error('Invalid Shadowsocks 2022 key'); }
    if (decoded.byteLength !== expectedBytes || base64Bytes(decoded) !== password) throw new Error(`Shadowsocks 2022 key must decode to ${expectedBytes} bytes`);
}

function validateTrafficReport(data) {
    if (!validIp(data.ip) || typeof data.report_id !== 'string' || data.report_id.length > 160 || !data.report_id.startsWith(`${data.ip}:`)) throw new Error('Invalid report identity');
    const entries = data.node_traffic === undefined ? [] : data.node_traffic;
    if (!Array.isArray(entries) || entries.length > 200) throw new Error('Invalid traffic entries');
    const ids = new Set(); let total = 0;
    for (const entry of entries) {
        if (!entry || !/^[A-Za-z0-9_-]{1,64}$/.test(entry.id || '') || !Number.isSafeInteger(entry.delta_bytes) || entry.delta_bytes <= 0 || entry.delta_bytes > MAX_NODE_DELTA_BYTES || ids.has(entry.id)) throw new Error('Invalid traffic entry');
        ids.add(entry.id); total += entry.delta_bytes;
        if (!Number.isSafeInteger(total) || total > MAX_REPORT_DELTA_BYTES) throw new Error('Traffic report exceeds limit');
    }
    const rawSystemDelta = data.system_traffic_delta === undefined ? total : data.system_traffic_delta;
    if (!Number.isSafeInteger(rawSystemDelta) || rawSystemDelta < 0 || rawSystemDelta > MAX_REPORT_DELTA_BYTES) throw new Error('Invalid system traffic delta');
    return { ...data, node_traffic: entries, total_delta: total, system_traffic_delta: rawSystemDelta };
}

function buildSevenDayTrafficSeries(rows, nowMs = Date.now()) {
    const totals = new Map((rows || []).map(row => [String(row.day || ''), Math.max(0, Number(row.total_bytes) || 0)]));
    const shanghaiNow = nowMs + 8 * 60 * 60 * 1000;
    const series = [];
    for (let offset = 6; offset >= 0; offset -= 1) {
        const date = new Date(shanghaiNow - offset * 24 * 60 * 60 * 1000);
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        const key = `${year}-${month}-${day}`;
        series.push({ day: `${month}-${day}`, total_bytes: totals.get(key) || 0 });
    }
    return series;
}

function validateProxyReport(data) {
    if (!validIp(data.ip) || (data.socks_ip && data.socks_ip !== data.ip)) throw new Error('Invalid proxy IP');
    if (data.logs !== undefined && (typeof data.logs !== 'string' || data.logs.length > 16 * 1024)) throw new Error('Proxy logs too large');
    const details = data.details === undefined ? undefined : data.details;
    if (details !== undefined && (!Array.isArray(details) || details.length > 8)) throw new Error('Invalid proxy details');
    const normalized = details?.map(item => {
        if (!item || typeof item !== 'object') throw new Error('Invalid proxy detail');
        const port = Number(item.port || 0);
        if (port && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Invalid proxy port');
        return { tunnel: String(item.tunnel || '').slice(0, 32), active: item.active === true, country: String(item.country || '').toUpperCase().slice(0, 2), port, node_ip: safeProxyAddress(item.node_ip), exit_ip: safeProxyAddress(item.exit_ip), ready: item.ready === true, connected_time: Math.max(0, Math.min(Number(item.connected_time) || 0, 31536000)) };
    });
    return { ip: data.ip, details: normalized, logs: data.logs?.slice(0, 16 * 1024) || '' };
}

async function realtimeAdminHeader(env) {
    const secret = String(env.REALTIME_AUTH_SECRET || '');
    return secret.length >= 32 ? `Realtime ${secret}` : null;
}

async function notifyRealtimePublicPolicy(env, db, enabled, pagesOrigin = '') {
    const authorization = await realtimeAdminHeader(env);
    if (!authorization) return;
    const configured = env.REALTIME_URL || (await db.prepare("SELECT val FROM sys_config WHERE key = 'realtime_url'").first())?.val;
    if (!configured || !/^https:\/\//i.test(configured)) return;
    await fetch(`${configured.replace(/\/$/, '')}/public-policy`, {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json', 'X-KUI-Pages-Origin': pagesOrigin },
        body: JSON.stringify({ public: enabled }),
        signal: AbortSignal.timeout(10000),
    });
}

function realtimeFrequencyPolicy(settings = {}) {
    const admin = Number(settings.realtime_admin_interval || 5);
    const publicInterval = Number(settings.realtime_public_interval || 10);
    const idle = Number(settings.realtime_idle_interval || 30);
    if (!Number.isInteger(admin) || !Number.isInteger(publicInterval) || !Number.isInteger(idle) || admin < 5 || admin > 60 || publicInterval < 10 || publicInterval > 120 || idle < 30 || idle > 600 || publicInterval < admin || idle < publicInterval) return null;
    return { admin, public: publicInterval, idle };
}

async function notifyRealtimeFrequencyPolicy(env, db, settings, pagesOrigin = '') {
    const policy = realtimeFrequencyPolicy(settings);
    const authorization = await realtimeAdminHeader(env);
    const configured = env.REALTIME_URL || (await db.prepare("SELECT val FROM sys_config WHERE key = 'realtime_url'").first())?.val;
    if (!policy || !authorization || !configured || !/^https:\/\//i.test(configured)) return;
    await fetch(`${configured.replace(/\/$/, '')}/frequency-policy`, {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json', 'X-KUI-Pages-Origin': pagesOrigin },
        body: JSON.stringify(policy),
        signal: AbortSignal.timeout(10000),
    });
}

async function notifyRealtimeVps(env, db, ip, pagesOrigin = '') {
    if (env.VPS_PRESENCE && typeof env.VPS_PRESENCE.idFromName === 'function') {
        const server = await db.prepare('SELECT agent_token FROM servers WHERE ip = ?').bind(ip).first();
        if (!server?.agent_token) return;
        const tokenHash = await sha256(server.agent_token);
        const stub = env.VPS_PRESENCE.get(env.VPS_PRESENCE.idFromName(`v2:${ip}:${tokenHash}`));
        await stub.fetch(new Request('https://presence.internal/notify', { method: 'POST' }));
        return;
    }
    const authorization = await realtimeAdminHeader(env);
    const configured = env.REALTIME_URL || (await db.prepare("SELECT val FROM sys_config WHERE key = 'realtime_url'").first())?.val;
    if (!authorization || !configured || !/^https:\/\//i.test(configured)) return;
    await fetch(`${configured.replace(/\/$/, '')}/notify`, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json', 'X-KUI-Pages-Origin': pagesOrigin }, body: JSON.stringify({ ip }), signal: AbortSignal.timeout(10000) });
}

async function requestRealtimeEgressRefresh(env, db, ip, requestId, pagesOrigin = '') {
    const server = await db.prepare('SELECT agent_token, egress_applied_mode, egress_applied_revision FROM servers WHERE ip = ?').bind(ip).first();
    if (!server?.agent_token) return { status: 404, result: { error: 'VPS Agent Token 不存在' } };
    const expectedMode = String(server.egress_applied_mode || 'native');
    const expectedRevision = Number(server.egress_applied_revision || 0);
    if (env.VPS_PRESENCE && typeof env.VPS_PRESENCE.idFromName === 'function') {
        const tokenHash = await sha256(server.agent_token);
        const stub = env.VPS_PRESENCE.get(env.VPS_PRESENCE.idFromName(`v2:${ip}:${tokenHash}`));
        const response = await stub.fetch(new Request('https://presence.internal/egress-refresh', { method: 'POST', headers: { 'X-KUI-Request-ID': requestId, 'X-KUI-Expected-Mode': expectedMode, 'X-KUI-Expected-Revision': String(expectedRevision) } }));
        const result = await response.json().catch(() => ({ error: `出口检测指令失败（HTTP ${response.status}）` }));
        return { status: response.status, result };
    }
    const authorization = await realtimeAdminHeader(env);
    const configured = env.REALTIME_URL || (await db.prepare("SELECT val FROM sys_config WHERE key = 'realtime_url'").first())?.val;
    if (!authorization || !configured || !/^https:\/\//i.test(configured)) throw new Error('实时服务未配置');
    const response = await fetch(`${configured.replace(/\/$/, '')}/egress-refresh`, {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json', 'X-KUI-Pages-Origin': pagesOrigin },
        body: JSON.stringify({ ip, request_id: requestId, expected_mode: expectedMode, expected_revision: expectedRevision }),
        signal: AbortSignal.timeout(10000),
    });
    const result = await response.json().catch(() => ({ error: `实时服务返回非 JSON 响应（HTTP ${response.status}）` }));
    return { status: response.status, result };
}

async function requestRealtimeWarpOptimize(env, db, command, requestId, pagesOrigin = '') {
    if (env.VPS_PRESENCE && typeof env.VPS_PRESENCE.idFromName === 'function') {
        const server = await db.prepare('SELECT agent_token FROM servers WHERE ip = ?').bind(command.ip).first();
        if (!server?.agent_token) return { status: 404, result: { error: 'VPS Agent Token 不存在' } };
        const tokenHash = await sha256(server.agent_token);
        const stub = env.VPS_PRESENCE.get(env.VPS_PRESENCE.idFromName(`v2:${command.ip}:${tokenHash}`));
        const response = await stub.fetch(new Request('https://presence.internal/warp-optimize', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-KUI-Request-ID': requestId }, body: JSON.stringify(command) }));
        const result = await response.json().catch(() => ({ error: `WARP 优化指令失败（HTTP ${response.status}）` }));
        return { status: response.status, result };
    }
    const authorization = await realtimeAdminHeader(env);
    const configured = env.REALTIME_URL || (await db.prepare("SELECT val FROM sys_config WHERE key = 'realtime_url'").first())?.val;
    if (!authorization || !configured || !/^https:\/\//i.test(configured)) throw new Error('实时服务未配置');
    const response = await fetch(`${configured.replace(/\/$/, '')}/warp-optimize`, {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json', 'X-KUI-Pages-Origin': pagesOrigin },
        body: JSON.stringify({ ...command, request_id: requestId }),
        signal: AbortSignal.timeout(10000),
    });
    const result = await response.json().catch(() => ({ error: `实时服务返回非 JSON 响应（HTTP ${response.status}）` }));
    return { status: response.status, result };
}

async function chunkBatch(db, statements, size = 100) {
    for (let i = 0; i < statements.length; i += size) {
        await db.batch(statements.slice(i, i + size));
    }
}

function yamlString(value) {
    return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

function surgePolicyName(value) {
    return String(value || 'KUI').replace(/[=,\r\n]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'KUI';
}

function surgeValue(value) {
    return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;
}

function surgeTlsOptions(sni) {
    return `${sni ? `, sni=${surgeValue(sni)}` : ''}, skip-cert-verify=true`;
}

function buildSurgeProxyLine({ name, protocol, host, port, method, uuid, password, sni, network = 'tcp,udp' }) {
    const prefix = `${surgePolicyName(name)} = `;
    const ipVersion = String(host || '').includes(':') ? 'v6-only' : 'v4-only';
    if (protocol === 'Shadowsocks2022' || protocol === 'SS') return `${prefix}ss, ${host}, ${port}, encrypt-method=${method || uuid}, password=${surgeValue(password)}, tfo=true, ip-version=${ipVersion}, udp-relay=${network !== 'tcp'}, block-quic=on`;
    if (protocol === 'Hysteria2') return `${prefix}hysteria2, ${host}, ${port}, password=${surgeValue(password || uuid)}${surgeTlsOptions(sni)}`;
    if (protocol === 'TUIC') {
        if (!/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(String(uuid || ''))) return '';
        return `${prefix}tuic-v5, ${host}, ${port}, password=${surgeValue(password)}, uuid=${uuid}, alpn=h3, ip-version=${ipVersion}, block-quic=off, ecn=auto${surgeTlsOptions(sni)}`;
    }
    if (protocol === 'Trojan') return `${prefix}trojan, ${host}, ${port}, password=${surgeValue(password)}${surgeTlsOptions(sni)}`;
    if (protocol === 'AnyTLS') return `${prefix}anytls, ${host}, ${port}, password=${surgeValue(password)}${surgeTlsOptions(sni)}`;
    if (protocol === 'Socks5') return `${prefix}socks5, ${host}, ${port}, username=${surgeValue(uuid)}, password=${surgeValue(password)}, udp-relay=true`;
    return '';
}

function buildNodeSubscriptionUri(node = {}) {
    if (node.protocol !== 'MTProxy') return '';
    const host = String(node.vps_ip || node.host || '').replace(/^\[|\]$/g, '');
    const port = Number(node.port);
    const secret = String(node.private_key || '');
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !secret) return '';
    return `tg://proxy?${new URLSearchParams({ server: host, port: String(port), secret }).toString()}`;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function isPrivateSubscriptionHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
    if (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb') || host.startsWith('ff')) return true;
    const mappedIpv4 = host.match(/^(?:::ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedIpv4 && host.startsWith('::ffff:')) {
        const high = Number.parseInt(mappedIpv4[1], 16);
        const low = Number.parseInt(mappedIpv4[2], 16);
        return isPrivateSubscriptionHost(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    if (host.startsWith('::ffff:') && /^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return isPrivateSubscriptionHost(host.slice(7));
    const parts = host.split('.');
    if (parts.length !== 4 || parts.some(part => !/^\d+$/.test(part) || Number(part) > 255)) return false;
    const [a, b] = parts.map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function validateSubscriptionUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || isPrivateSubscriptionHost(url.hostname)) throw new Error('订阅地址不安全');
    return url;
}

async function assertPublicSubscriptionResolution(url) {
    if (url.hostname.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)) return;
    let publicAnswers = 0;
    for (const type of ['A', 'AAAA']) {
        const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(url.hostname)}&type=${type}`, {
            headers: { Accept: 'application/dns-json' },
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error('订阅域名解析验证失败');
        const data = await response.json();
        if (Number(data.Status) !== 0 && Number(data.Status) !== 3) throw new Error('订阅域名解析失败');
        for (const answer of Array.isArray(data.Answer) ? data.Answer : []) {
            if (answer.type !== 1 && answer.type !== 28) continue;
            if (isPrivateSubscriptionHost(answer.data)) throw new Error('订阅域名解析到私网地址');
            publicAnswers++;
        }
    }
    if (!publicAnswers) throw new Error('订阅域名没有可用的公网解析记录');
}

async function readBoundedText(response) {
    const declared = Number(response.headers.get('Content-Length') || 0);
    if (declared && declared > MAX_SUBSCRIPTION_BYTES) throw new Error('订阅文件过大');
    const reader = response.body?.getReader(); const chunks = []; let size = 0;
    while (reader) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_SUBSCRIPTION_BYTES) { await reader.cancel(); throw new Error('订阅文件过大'); } chunks.push(value); }
    const output = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(output);
}

async function fetchPublicSubscription(initialUrl) {
    let current = validateSubscriptionUrl(initialUrl);
    for (let redirects = 0; redirects <= 3; redirects++) {
        await assertPublicSubscriptionResolution(current);
        const response = await fetch(current.toString(), { redirect: 'manual', headers: { 'User-Agent': 'v2rayN/6.44', 'Accept': '*/*' }, signal: AbortSignal.timeout(15000) });
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('Location');
            if (!location || redirects === 3) throw new Error('订阅重定向无效或过多');
            current = validateSubscriptionUrl(new URL(location, current).toString()); continue;
        }
        if (!response.ok) throw new Error(`订阅请求失败: ${response.status}`);
        return response;
    }
    throw new Error('订阅重定向过多');
}

function formatIpForLink(ip) {
    if (!ip || typeof ip !== 'string') return ip;
    if (ip.startsWith('[') && ip.endsWith(']')) return ip;
    if (ip.includes(':')) return `[${ip}]`;
    return ip;
}

function base64Url(value) {
    return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function parseVLESSLink(raw) {
    try {
        const schemeSep = raw.indexOf('://');
        if (schemeSep < 0) return null;
        let rest = raw.slice(schemeSep + 3);
        const hashIdx = rest.indexOf('#');
        let remark = '', hash = '';
        if (hashIdx !== -1) { hash = rest.slice(hashIdx + 1); rest = rest.slice(0, hashIdx); }
        const qIdx = rest.indexOf('?');
        let queryPart = '';
        if (qIdx !== -1) { queryPart = rest.slice(qIdx + 1); rest = rest.slice(0, qIdx); }

        const findAt = (s) => {
            const idx = s.lastIndexOf('@');
            if (idx >= 0) return [idx, 1];
            const encIdx = s.lastIndexOf('%40');
            if (encIdx >= 0) return [encIdx, 3];
            return [-1, 0];
        };
        const [atIdx, sepLen] = findAt(rest);
        if (atIdx < 0) return null;
        const safeDecode = (s) => { try { return decodeURIComponent(s); } catch(e) { return s; } };
        const uuid = safeDecode(rest.slice(0, atIdx));
        let hostPart = rest.slice(atIdx + sepLen);
        let port = 443;
        if (hostPart.startsWith('[')) {
            const bracketEnd = hostPart.indexOf(']');
            if (bracketEnd < 0) return null;
            const ipv6Addr = hostPart.slice(0, bracketEnd + 1);
            const afterBracket = hostPart.slice(bracketEnd + 1);
            if (afterBracket.startsWith(':')) {
                const portMatch = afterBracket.slice(1).match(/^\d+/);
                if (portMatch) port = parseInt(portMatch[0], 10);
            }
            hostPart = ipv6Addr;
        } else {
            let hostWithoutPort = hostPart;
            const colonIdx = hostPart.lastIndexOf(':');
            if (colonIdx > 0 && !hostPart.slice(0, colonIdx).includes(':')) {
                const pStr = hostPart.slice(colonIdx + 1);
                if (/^\d+$/.test(safeDecode(pStr))) {
                    port = parseInt(pStr, 10);
                    hostWithoutPort = hostPart.slice(0, colonIdx);
                }
            }
            hostPart = safeDecode(hostWithoutPort);
        }
        const params = new URLSearchParams(queryPart);
        const pbk = params.get('pbk') || '';
        const sid = params.get('sid') || '';
        const sni = safeDecode(params.get('sni') || '') || hostPart;
        const flow = params.get('flow') || '';
        const network = params.get('type') || 'tcp';
        const host = safeDecode(params.get('host') || '') || '';
        const path = safeDecode(params.get('path') || '') || '';
        const name = hash ? (() => { try { return decodeURIComponent(hash); } catch(e) { return hash; } })() : '';
        const isReality = params.get('security') === 'reality' || !!pbk;
        const protocol = isReality ? 'Reality' : 'VLESS';
        if (!uuid || !hostPart) return null;
        return {
            protocol, name, address: hostPart, port, uuid, password: '', sni,
            public_key: pbk, short_id: sid, flow, network: network.toLowerCase(), host, path, extra: '', enable: 1
        };
    } catch (e) { return null; }
}

function parseHysteria2Link(raw) {
    try {
        let prefixLen = 11;
        if (raw.startsWith('hy2://')) prefixLen = 5;
        else if (raw.startsWith('hysteria2://')) prefixLen = 12;
        else if (raw.startsWith('hysteria://')) prefixLen = 10;
        let rest = raw.slice(prefixLen).replace(/^\/+/, '');
        const hashIdx = rest.indexOf('#');
        let remark = '';
        if (hashIdx !== -1) { remark = rest.slice(hashIdx + 1); rest = rest.slice(0, hashIdx); }
        const qIdx = rest.indexOf('?');
        let queryPart = '';
        if (qIdx !== -1) { queryPart = rest.slice(qIdx + 1); rest = rest.slice(0, qIdx); }
        const params = new URLSearchParams(queryPart);
        let password = '';
        let host = '';
        let port = 443;
        const safeDecode = (s) => { try { return decodeURIComponent(s); } catch(e) { return s; } };
        const findAt = (s) => {
            const idx = s.lastIndexOf('@');
            if (idx >= 0) return [idx, 1];
            const encIdx = s.lastIndexOf('%40');
            if (encIdx >= 0) return [encIdx, 3];
            return [-1, 0];
        };
        const [atIdx, sepLen] = findAt(rest);
        if (atIdx >= 0) {
            password = safeDecode(rest.slice(0, atIdx));
            host = safeDecode(rest.slice(atIdx + sepLen));
        } else {
            password = params.get('password') || '';
            host = safeDecode(rest);
        }
        const colonIdx = host.lastIndexOf(':');
        if (colonIdx !== -1) {
            const maybePort = host.slice(colonIdx + 1);
            if (/^\d+$/.test(maybePort)) {
                port = parseInt(maybePort, 10);
                host = host.slice(0, colonIdx);
            }
        }
        const sni = safeDecode(params.get('sni') || '') || host;
        const name = remark ? (() => { try { return decodeURIComponent(remark); } catch (e) { return remark; } })() : '';
        if (!host || isNaN(port)) return null;
        return {
            protocol: 'Hysteria2', name, address: host, port, uuid: password, password, sni,
            public_key: '', short_id: '', flow: '', network: 'udp', host: '', path: '', extra: '', enable: 1
        };
    } catch (e) {
        return null;
    }
}

function base64ToUtf8(str) {
    try {
        const s = str.replace(/-/g, '+').replace(/_/g, '/');
        const pad = s.length % 4;
        const padded = pad ? s + '='.repeat(4 - pad) : s;
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return atob(str);
    }
}

function safeHashDecode(url) {
    const raw = (url.hash && url.hash.slice(1)) || '';
    if (!raw) return '';
    try { return decodeURIComponent(raw); } catch (e) { return raw; }
}

function resolveUrlPortForHysteria2(url) {
    if (url.port && String(url.port) !== '') return parseInt(url.port);
    const insecure = (url.searchParams.get('insecure') || url.searchParams.get('allowinsecure') || '').toString();
    const mbs = (url.searchParams.get('downmbps') || url.searchParams.get('upmbps') || '0').toString();
    if (insecure === '1' || parseInt(mbs, 10) > 0) return 443;
    const path = (url.pathname && url.pathname.replace(/^\//, '')) || '';
    const p = parseInt(path, 10);
    return Number.isFinite(p) && p > 0 ? p : 443;
}

async function parseThirdPartySubscription(content) {
    let nodes = [];
    let decoded = content;
    const trimmed = content.trim();
    if (!trimmed.includes('://')) {
        try {
            decoded = base64ToUtf8(trimmed);
        } catch (e) {
            decoded = content;
        }
    }
    // Keep the legacy importer behavior: parse every line in a downloaded
    // subscription instead of silently truncating larger airport profiles.
    // Network size and timeout limits are still enforced before parsing.
    const lines = decoded.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const protocolCounts = {};
    const debug = { totalLines: lines.length, matched: 0, rejected: 0 };
    for (const raw of lines) {
        const rawLC = raw.toLowerCase();
        const sep = rawLC.indexOf('://');
        const pf = sep > 0 ? rawLC.substring(0, sep + 3) : rawLC.substring(0, Math.min(rawLC.length, 40));
        let node = null;
        try {
            if (rawLC.startsWith('vmess://')) {
                node = {
                    protocol: 'VMess', name: '', address: '', port: 443, uuid: '', password: '', sni: '',
                    public_key: '', short_id: '', flow: '', network: 'tcp', host: '', path: '', extra: raw, enable: 1
                };
                try {
                    const jsonStr = base64ToUtf8(raw.slice(8));
                    const obj = JSON.parse(jsonStr);
                    node.name = obj.ps || ''; node.address = obj.add || obj.host || ''; node.port = parseInt(obj.port) || 443;
                    node.uuid = obj.id || obj.uuid || ''; node.sni = obj.sni || obj.host || obj.add || '';
                    node.network = (obj.net || 'tcp').toLowerCase(); node.host = obj.host || ''; node.path = obj.path || '';
                } catch (e) {}
            } else if (rawLC.startsWith('vless://')) {
                const parsed = parseVLESSLink(raw);
                if (parsed) node = parsed;
            } else if (rawLC.startsWith('trojan://')) {
                const parsed = parseVLESSLink(raw);
                if (parsed) { parsed.protocol = 'Trojan'; parsed.password = parsed.uuid; parsed.uuid = ''; node = parsed; }
            } else if (rawLC.startsWith('hysteria2://') || rawLC.startsWith('hy2://') || rawLC.startsWith('hysteria://')) {
                const parsed = parseHysteria2Link(raw);
                if (parsed) node = parsed;
            } else if (rawLC.startsWith('tuic://')) {
                const url = new URL(raw);
                node = {
                    protocol: 'TUIC', name: safeHashDecode(url), address: url.hostname, port: parseInt(url.port) || 443,
                    uuid: url.username, password: url.password || '', sni: url.searchParams.get('sni') || url.hostname,
                    public_key: '', short_id: '', flow: '', network: 'udp', host: '', path: '', extra: '', enable: 1
                };
            } else if (rawLC.startsWith('naive+https://') || rawLC.startsWith('naive://')) {
                const url = new URL(raw);
                node = {
                    protocol: 'Naive', name: safeHashDecode(url), address: url.hostname, port: parseInt(url.port) || 443,
                    uuid: url.username, password: url.password || '', sni: url.searchParams.get('sni') || url.hostname,
                    public_key: '', short_id: '', flow: '', network: 'tcp', host: '', path: '', extra: '', enable: 1
                };
            } else if (rawLC.startsWith('ss://')) {
                const rest = raw.slice(5).replace(/#.*$/, '');
                let host = '', port = 8388, password = '', method = '';
                if (rest.includes('@')) {
                    const [uinfo, saddr] = rest.split('@');
                    const decodedUi = base64ToUtf8(uinfo);
                    const [m, p] = decodedUi.split(':');
                    method = m || 'aes-256-gcm';
                    password = p || '';
                    const [h, pStr] = saddr.split(':');
                    host = h;
                    port = parseInt(pStr) || 8388;
                } else {
                    const decodedRest = base64ToUtf8(rest);
                    const parts = decodedRest.split('@');
                    if (parts.length === 2) {
                        const [uinfo2, saddr2] = parts;
                        const [m, p] = uinfo2.split(':');
                        method = m || 'aes-256-gcm';
                        password = p || '';
                        const [h, pStr] = saddr2.split(':');
                        host = h;
                        port = parseInt(pStr) || 8388;
                    }
                }
                node = {
                    protocol: 'SS', name: '', address: host, port: port, uuid: method, password, sni: host,
                    public_key: '', short_id: '', flow: '', network: 'tcp', host: '', path: '', extra: JSON.stringify({method}), enable: 1
                };
            } else if (rawLC.startsWith('ssr://')) {
                const b64 = raw.slice(6).replace(/#.*$/, '');
                const decoded = base64ToUtf8(b64);
                const base = decoded.split('/?')[0];
                const bpms = base.split(':');
                if (bpms.length >= 5) {
                    const method = bpms[0], password = base64ToUtf8(bpms[1]), host = bpms[2], port = bpms[3];
                    node = {
                        protocol: 'SSR', name: '', address: host, port: parseInt(port) || 8388, uuid: method, password,
                        sni: host, public_key: '', short_id: '', flow: '', network: 'tcp', host: '', path: '',
                        extra: JSON.stringify({method, protocol: bpms[4], obfs: bpms[5]}), enable: 1
                    };
                }
            } else {
                const sep = raw.indexOf('://');
                const pf = sep > 0 ? rawLC.substring(0, sep + 3) : rawLC.substring(0, Math.min(rawLC.length, 30));
                debug.rejected++;
            }
        } catch (e) {
            node = null;
        }
        if (node && node.address && node.port) {
            node.id = crypto.randomUUID();
            nodes.push(node);
            protocolCounts[node.protocol] = (protocolCounts[node.protocol] || 0) + 1;
            debug.matched++;
        } else if (node) debug.rejected++;
    }
    return { nodes, protocolCounts, debug };
}

let schemaReadyPromise = null;
let authSchemaReadyPromise = null;
let lastReceiptCleanup = 0;
const statsResponseCache = new Map();
const STATS_CACHE_MS = 60_000;

function loginThrottleKey(request) { return request.headers.get('CF-Connecting-IP') || 'unknown'; }

async function loginAllowed(db, request) {
    const row = await db.prepare('SELECT failures, window_started_at, blocked_until FROM login_throttles WHERE key = ?').bind(loginThrottleKey(request)).first();
    return !row || Number(row.blocked_until || 0) <= Date.now();
}

async function recordLoginFailure(db, request) {
    const key = loginThrottleKey(request); const now = Date.now();
    const row = await db.prepare('SELECT failures, window_started_at FROM login_throttles WHERE key = ?').bind(key).first();
    const freshWindow = !row || now - Number(row.window_started_at || 0) > 15 * 60 * 1000;
    const failures = freshWindow ? 1 : Number(row.failures || 0) + 1;
    const blockedUntil = failures >= 8 ? now + 15 * 60 * 1000 : 0;
    await db.prepare('INSERT INTO login_throttles (key, failures, window_started_at, blocked_until) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, window_started_at = excluded.window_started_at, blocked_until = excluded.blocked_until').bind(key, failures, freshWindow ? now : row.window_started_at, blockedUntil).run();
}

async function ensureAuthSchema(db) {
    if (!authSchemaReadyPromise) {
        authSchemaReadyPromise = db.batch([
            db.prepare('CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT NOT NULL, traffic_limit INTEGER DEFAULT 0, traffic_used INTEGER DEFAULT 0, expire_time INTEGER DEFAULT 0, enable INTEGER DEFAULT 1, sub_token TEXT)'),
            db.prepare('CREATE TABLE IF NOT EXISTS login_throttles (key TEXT PRIMARY KEY, failures INTEGER NOT NULL, window_started_at INTEGER NOT NULL, blocked_until INTEGER NOT NULL DEFAULT 0)'),
            db.prepare('CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at INTEGER NOT NULL)'),
        ]).catch(error => {
            authSchemaReadyPromise = null;
            throw error;
        });
    }
    return authSchemaReadyPromise;
}

async function initializeDbSchema(db) {
    const initQueries = [
        `CREATE TABLE IF NOT EXISTS servers (ip TEXT PRIMARY KEY, name TEXT NOT NULL, cpu INTEGER DEFAULT 0, mem REAL DEFAULT 0, last_report INTEGER DEFAULT 0, alert_sent INTEGER DEFAULT 0, disk INTEGER DEFAULT 0, load TEXT DEFAULT "", uptime TEXT DEFAULT "", net_in_speed INTEGER DEFAULT 0, net_out_speed INTEGER DEFAULT 0, tcp_conn INTEGER DEFAULT 0, udp_conn INTEGER DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT NOT NULL, traffic_limit INTEGER DEFAULT 0, traffic_used INTEGER DEFAULT 0, expire_time INTEGER DEFAULT 0, enable INTEGER DEFAULT 1, sub_token TEXT)`,
        `CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, uuid TEXT NOT NULL, vps_ip TEXT NOT NULL, protocol TEXT NOT NULL, port INTEGER NOT NULL, sni TEXT, private_key TEXT, public_key TEXT, short_id TEXT, relay_type TEXT, target_ip TEXT, target_port INTEGER, target_id TEXT, enable INTEGER DEFAULT 1, traffic_used INTEGER DEFAULT 0, traffic_limit INTEGER DEFAULT 0, expire_time INTEGER DEFAULT 0, username TEXT DEFAULT 'admin', network TEXT DEFAULT 'tcp', FOREIGN KEY(vps_ip) REFERENCES servers(ip) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS traffic_stats (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, delta_bytes INTEGER DEFAULT 0, timestamp INTEGER NOT NULL, FOREIGN KEY(ip) REFERENCES servers(ip) ON DELETE CASCADE)`,
        `CREATE INDEX IF NOT EXISTS idx_traffic_ip_time ON traffic_stats(ip, timestamp)`,
        `CREATE INDEX IF NOT EXISTS idx_traffic_time_ip ON traffic_stats(timestamp, ip)`,
        `CREATE TABLE IF NOT EXISTS traffic_daily (ip TEXT NOT NULL, day TEXT NOT NULL, total_bytes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(ip, day), FOREIGN KEY(ip) REFERENCES servers(ip) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS sys_config (key TEXT PRIMARY KEY, val TEXT, ts INTEGER)`,
        `CREATE TABLE IF NOT EXISTS proxy_ctrl_servers (ip TEXT PRIMARY KEY, details TEXT, last_seen INTEGER)`,
        `CREATE TABLE IF NOT EXISTS server_logs (ip TEXT PRIMARY KEY, logs TEXT, updated_at INTEGER)`,
        `CREATE TABLE IF NOT EXISTS proxy_slot_map (key TEXT PRIMARY KEY, value TEXT)`,
        `CREATE TABLE IF NOT EXISTS report_receipts (report_id TEXT PRIMARY KEY, vps_ip TEXT NOT NULL, created_at INTEGER NOT NULL, applied INTEGER DEFAULT 1)`,
        `CREATE TABLE IF NOT EXISTS auth_replays (nonce TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS login_throttles (key TEXT PRIMARY KEY, failures INTEGER NOT NULL, window_started_at INTEGER NOT NULL, blocked_until INTEGER NOT NULL DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS agent_bootstrap_tokens (token_hash TEXT PRIMARY KEY, vps_ip TEXT NOT NULL, component TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER NOT NULL DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS user_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS user_group_members (group_id TEXT NOT NULL, username TEXT NOT NULL, PRIMARY KEY(group_id, username), FOREIGN KEY(group_id) REFERENCES user_groups(id) ON DELETE CASCADE, FOREIGN KEY(username) REFERENCES users(username) ON DELETE CASCADE)`,
        `CREATE TABLE IF NOT EXISTS user_group_resources (group_id TEXT NOT NULL, resource_type TEXT NOT NULL CHECK(resource_type IN ('vps', 'node')), resource_id TEXT NOT NULL, PRIMARY KEY(group_id, resource_type, resource_id), FOREIGN KEY(group_id) REFERENCES user_groups(id) ON DELETE CASCADE)`,
        `CREATE INDEX IF NOT EXISTS idx_group_members_user ON user_group_members(username)`,
        `CREATE INDEX IF NOT EXISTS idx_group_resources_resource ON user_group_resources(resource_type, resource_id)`
    ];
    await chunkBatch(db, initQueries.map(query => db.prepare(query)));
    const schemaColumns = new Map();
    const pendingColumnMigrations = [];
    const ensureColumn = async (table, name, definition) => {
        if (!schemaColumns.has(table)) {
            const { results = [] } = await db.prepare(`PRAGMA table_info(${table})`).all();
            schemaColumns.set(table, new Set(results.map(column => column.name)));
        }
        const knownColumns = schemaColumns.get(table);
        if (!knownColumns.has(name)) {
            pendingColumnMigrations.push(db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`));
            knownColumns.add(name);
        }
    };
    const applyPendingColumnMigrations = async () => {
        if (!pendingColumnMigrations.length) return;
        await chunkBatch(db, pendingColumnMigrations.splice(0));
    };
    const deployment = await db.prepare("SELECT val FROM sys_config WHERE key = 'deployment_id'").first();
    if (!deployment?.val) await db.prepare("INSERT OR IGNORE INTO sys_config (key, val, ts) VALUES ('deployment_id', ?, ?)").bind(crypto.randomUUID(), Date.now()).run();
    await ensureColumn('nodes', 'network', "TEXT DEFAULT 'tcp'");
    await applyPendingColumnMigrations();
    const dailySeed = await db.prepare("SELECT val FROM sys_config WHERE key = 'traffic_daily_backfilled'").first();
    if (!dailySeed) {
        await db.prepare(`INSERT OR IGNORE INTO traffic_daily (ip, day, total_bytes)
            SELECT ip, strftime('%Y-%m-%d', datetime(timestamp / 1000, 'unixepoch', '+8 hours')) AS day, SUM(delta_bytes)
            FROM traffic_stats GROUP BY ip, day`).run();
        await db.prepare("INSERT OR REPLACE INTO sys_config (key, val, ts) VALUES ('traffic_daily_backfilled', '1', ?)").bind(Date.now()).run();
    }
    await db.prepare("UPDATE nodes SET network = 'http' WHERE protocol = 'H2-Reality' AND (network IS NULL OR network = '' OR network = 'tcp')").run();
    await db.prepare("UPDATE nodes SET network = 'grpc' WHERE protocol = 'gRPC-Reality' AND (network IS NULL OR network = '' OR network = 'tcp')").run();

    const probeQueries = [
        `CREATE TABLE IF NOT EXISTS probe_settings (key TEXT PRIMARY KEY, value TEXT)`,
        `CREATE TABLE IF NOT EXISTS probe_servers (
            id TEXT PRIMARY KEY, name TEXT, cpu TEXT, ram TEXT, disk TEXT, load_avg TEXT, uptime TEXT, last_updated INTEGER,
            ram_total TEXT, net_rx TEXT, net_tx TEXT, net_in_speed TEXT, net_out_speed TEXT,
            os TEXT, cpu_info TEXT, arch TEXT, boot_time TEXT, ram_used TEXT, swap_total TEXT, 
            swap_used TEXT, disk_total TEXT, disk_used TEXT, processes TEXT, tcp_conn TEXT, udp_conn TEXT, 
            country TEXT, ip_v4 TEXT, ip_v6 TEXT, server_group TEXT DEFAULT '默认分组', price TEXT DEFAULT '', 
            expire_date TEXT DEFAULT '', bandwidth TEXT DEFAULT '', traffic_limit TEXT DEFAULT '', agent_os TEXT DEFAULT 'debian',
            ping_ct TEXT DEFAULT '0', ping_cu TEXT DEFAULT '0', ping_cm TEXT DEFAULT '0', ping_bd TEXT DEFAULT '0',
            monthly_rx TEXT DEFAULT '0', monthly_tx TEXT DEFAULT '0', last_rx TEXT DEFAULT '0', last_tx TEXT DEFAULT '0', 
            reset_month TEXT DEFAULT '', history TEXT DEFAULT '{}', is_hidden TEXT DEFAULT 'false', virt TEXT DEFAULT '',             reset_day TEXT DEFAULT '1'
        )`,
        `CREATE TABLE IF NOT EXISTS proxy_servers (ip TEXT PRIMARY KEY, socks_ip TEXT, port INTEGER, user TEXT, pass TEXT, country TEXT DEFAULT '', enabled INTEGER DEFAULT 1, last_seen INTEGER)`
    ];
    await chunkBatch(db, probeQueries.map(query => db.prepare(query)));

    const columns = [
        ['nodes', 'username', "TEXT DEFAULT 'admin'"],
        ['servers', 'disk', 'INTEGER DEFAULT 0'], ['servers', 'load', 'TEXT DEFAULT ""'], ['servers', 'uptime', 'TEXT DEFAULT ""'],
        ['servers', 'net_in_speed', 'INTEGER DEFAULT 0'], ['servers', 'net_out_speed', 'INTEGER DEFAULT 0'], ['servers', 'tcp_conn', 'INTEGER DEFAULT 0'], ['servers', 'udp_conn', 'INTEGER DEFAULT 0'],
        ['users', 'sub_token', 'TEXT'], ['probe_servers', 'reset_day', "TEXT DEFAULT '1'"],
        ['servers', 'socks5_addr', 'TEXT DEFAULT ""'], ['servers', 'socks5_port', 'INTEGER DEFAULT 0'], ['servers', 'socks5_user', 'TEXT DEFAULT ""'], ['servers', 'socks5_pass', 'TEXT DEFAULT ""'], ['servers', 'agent_token', 'TEXT'],
        ['servers', 'egress_mode', "TEXT NOT NULL DEFAULT 'native'"], ['servers', 'egress_applied_mode', "TEXT NOT NULL DEFAULT 'native'"], ['servers', 'egress_revision', 'INTEGER NOT NULL DEFAULT 0'], ['servers', 'egress_applied_revision', 'INTEGER NOT NULL DEFAULT 0'], ['servers', 'egress_status', "TEXT NOT NULL DEFAULT 'applied'"], ['servers', 'egress_error', "TEXT NOT NULL DEFAULT ''"], ['servers', 'egress_applied_at', 'INTEGER NOT NULL DEFAULT 0'],
        ['servers', 'egress_desired_config', "TEXT NOT NULL DEFAULT ''"], ['servers', 'egress_applied_config', "TEXT NOT NULL DEFAULT ''"],
        ['servers', 'proxy_mode', "TEXT DEFAULT 'global'"], ['servers', 'proxy_categories', "TEXT DEFAULT ''"], ['servers', 'proxy_custom_domains', "TEXT DEFAULT '[]'"], ['servers', 'egress_ip', "TEXT DEFAULT ''"],
        ['probe_servers', 'last_report_id', "TEXT DEFAULT ''"], ['report_receipts', 'applied', 'INTEGER DEFAULT 1'],
    ];
    for (const [table, name, definition] of columns) await ensureColumn(table, name, definition);
    await applyPendingColumnMigrations();
    await db.prepare(`UPDATE servers SET egress_desired_config = json_object(
        'mode', COALESCE(NULLIF(egress_mode, ''), 'native'),
        'proxy_mode', COALESCE(NULLIF(proxy_mode, ''), 'global'),
        'proxy_categories', COALESCE(proxy_categories, ''),
        'proxy_custom_domains', json(COALESCE(NULLIF(proxy_custom_domains, ''), '[]')),
        'socks5', CASE WHEN egress_mode = 'socks5' THEN json_object('addr', COALESCE(socks5_addr, ''), 'port', COALESCE(socks5_port, 0), 'user', COALESCE(socks5_user, ''), 'pass', COALESCE(socks5_pass, '')) ELSE NULL END
    ) WHERE egress_desired_config IS NULL OR egress_desired_config = ''`).run();
    await db.prepare(`UPDATE servers SET egress_applied_config = json_object(
        'mode', COALESCE(NULLIF(egress_applied_mode, ''), 'native'),
        'proxy_mode', CASE WHEN egress_applied_mode IN ('residential', 'socks5') THEN COALESCE(NULLIF(proxy_mode, ''), 'global') ELSE 'global' END,
        'proxy_categories', CASE WHEN egress_applied_mode IN ('residential', 'socks5') THEN COALESCE(proxy_categories, '') ELSE '' END,
        'proxy_custom_domains', json(COALESCE(NULLIF(proxy_custom_domains, ''), '[]')),
        'socks5', CASE WHEN egress_applied_mode = 'socks5' THEN json_object('addr', COALESCE(socks5_addr, ''), 'port', COALESCE(socks5_port, 0), 'user', COALESCE(socks5_user, ''), 'pass', COALESCE(socks5_pass, '')) ELSE NULL END
    ) WHERE egress_applied_config IS NULL OR egress_applied_config = ''`).run();
    const { results: usersWithoutToken = [] } = await db.prepare("SELECT username FROM users WHERE sub_token IS NULL OR sub_token = ''").all();
    await chunkBatch(db, usersWithoutToken.map(user => db.prepare("UPDATE users SET sub_token = ? WHERE username = ? AND (sub_token IS NULL OR sub_token = '')").bind(crypto.randomUUID(), user.username)));

    // 初始化云端测速数据
    const checkNodes = await db.prepare("SELECT value FROM probe_settings WHERE key = 'cached_nodes_data'").first();
    if (!checkNodes) {
        try {
            // This is optional seed data. A GitHub outage must never block
            // schema initialization (and therefore every API endpoint).
            const res = await fetch('https://raw.githubusercontent.com/a63414262/CF-Server-Monitor-Pro/refs/heads/main/nodes.json', { signal: AbortSignal.timeout(8000) });
            if (res.ok) {
                const dataText = await res.text();
                await db.prepare("INSERT INTO probe_settings (key, value) VALUES ('cached_nodes_data', ?)").bind(dataText).run();
            }
        } catch(e) {}
    }

    const tpsQueries = [
        `CREATE TABLE IF NOT EXISTS third_party_subscriptions (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, is_enable INTEGER DEFAULT 1, added_at INTEGER, last_fetched_at INTEGER)`,
        `CREATE TABLE IF NOT EXISTS third_party_nodes (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, name TEXT, protocol TEXT NOT NULL, address TEXT NOT NULL, port INTEGER NOT NULL, uuid TEXT, password TEXT, sni TEXT, public_key TEXT, short_id TEXT, flow TEXT, network TEXT, host TEXT, path TEXT, extra TEXT, enable INTEGER DEFAULT 1, created_at INTEGER, FOREIGN KEY(subscription_id) REFERENCES third_party_subscriptions(id) ON DELETE CASCADE)`
    ];
    await chunkBatch(db, tpsQueries.map(query => db.prepare(query)));
}

async function ensureDbSchema(db) {
    if (!schemaReadyPromise) {
        schemaReadyPromise = initializeDbSchema(db).catch(error => {
            schemaReadyPromise = null;
            throw error;
        });
    }
    return schemaReadyPromise;
}

async function getDeploymentId(db) {
    await ensureDbSchema(db);
    let row = await db.prepare("SELECT val FROM sys_config WHERE key = 'deployment_id'").first();
    if (!row?.val) {
        const generated = crypto.randomUUID();
        await db.prepare("INSERT OR IGNORE INTO sys_config (key, val, ts) VALUES ('deployment_id', ?, ?)").bind(generated, Date.now()).run();
        row = await db.prepare("SELECT val FROM sys_config WHERE key = 'deployment_id'").first();
    }
    return row?.val || '';
}

async function verifyAuth(authHeader, request, db, env, context) {
    try {
        if (!authHeader || !env.ADMIN_PASSWORD) return null;
        if (authHeader.startsWith('Bearer ')) {
            const token = authHeader.slice(7);
            if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;
            const tokenHash = await sha256(token);
            const session = await db.prepare('SELECT username FROM auth_sessions WHERE token_hash = ? AND expires_at > ?').bind(tokenHash, Date.now()).first();
            return session?.username || null;
        }
        const adminUser = env.ADMIN_USERNAME || "admin";
        const adminPass = env.ADMIN_PASSWORD;
        const parts = authHeader.split('.');
        if (parts.length !== 4) return null;
        const [b64User, timestamp, nonce, clientSig] = parts;
        const timestampNumber = Number(timestamp);
        if (!Number.isFinite(timestampNumber) || Math.abs(Date.now() - timestampNumber) > 120000 || !/^[0-9a-f-]{36}$/i.test(nonce)) return null;
        const username = atob(b64User);
        let baseKeyHex;
        if (username === adminUser) baseKeyHex = await sha256(adminPass);
        else return null;
        const keyBytes = new Uint8Array(baseKeyHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const url = new URL(request.url);
        const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${username}\n${timestamp}\n${nonce}\n${request.method}\n${url.pathname}`));
        const expectedSig = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
        if (clientSig !== expectedSig) return null;
        const receipt = await db.prepare('INSERT OR IGNORE INTO auth_replays (nonce, username, expires_at) VALUES (?, ?, ?)').bind(nonce, username, Date.now() + 180000).run();
        if (Number(receipt.meta?.changes || 0) !== 1) return null;
        context?.waitUntil(db.prepare('DELETE FROM auth_replays WHERE expires_at < ?').bind(Date.now()).run().catch(() => {}));
        return username;
    } catch (error) {
        return null;
    }
}

async function verifyAgent(authHeader, ip, db, env) {
    if (!authHeader) return false;
    if (ip) {
        const server = await db.prepare("SELECT agent_token FROM servers WHERE ip = ?").bind(ip).first();
        if (server && server.agent_token && authHeader === server.agent_token) return true;
    }
    return false;
}

async function invalidatePublicProbeCache(origin) {
    await Promise.all(['0', '1'].map(isAjax => caches.default.delete(new Request(`${origin}/api/probe/public?ajax=${isAjax}`))));
}

// ==============================================
// 探针纯净 API 子系统处理
// ==============================================
async function handleProbeAPI(request, env, context, pathArray) {
    const subPath = pathArray ? pathArray.join('/') : '';
    const url = new URL(request.url);
    const method = request.method;
    const db = env.DB;

    // Telegram Bot 交互回调控制
    if (method === 'POST' && subPath === 'tg_webhook') {
        try {
            const webhookSecret = env.TG_WEBHOOK_SECRET || '';
            if (!webhookSecret || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== webhookSecret) return new Response('Unauthorized', { status: 401 });
            const body = await request.json();
            const message = body.message; const callback_query = body.callback_query;
            let tgBotToken = ''; let tgChatId = '';
            try { const { results } = await db.prepare("SELECT key, value FROM probe_settings WHERE key IN ('tg_bot_token', 'tg_chat_id')").all(); results.forEach(r => { if(r.key === 'tg_bot_token') tgBotToken = r.value; if(r.key === 'tg_chat_id') tgChatId = r.value; }); } catch(e){}
            
            const tgSend = async (chatId, text, kb=null) => { const p = { chat_id: chatId, text, parse_mode: 'HTML' }; if (kb) p.reply_markup = kb; await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(p), signal: AbortSignal.timeout(10000)}); };
            const tgEdit = async (chatId, msgId, text, kb=null) => { const p = { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML' }; if (kb) p.reply_markup = kb; await fetch(`https://api.telegram.org/bot${tgBotToken}/editMessageText`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(p), signal: AbortSignal.timeout(10000)}); };

            let chatId, text, msgId;
            if (message) { chatId = message.chat.id.toString(); text = message.text || ''; msgId = message.message_id; } 
            else if (callback_query) { chatId = callback_query.message.chat.id.toString(); text = callback_query.data; msgId = callback_query.message.message_id; }
            if (chatId !== tgChatId) return new Response('OK', { status: 200 });

            const mainMenuText = `🖥 <b>Server Monitor Pro 探针管理</b>\n\n您可以使用命令快速设置系统：\n<code>/set_interval 10</code> - 上报间隔10秒\n<code>/set_sitetitle 新标题</code> - 更改大盘标题\n<code>/menu</code> - 调出本菜单`;
            const mainMenuKb = { inline_keyboard: [ [{text: '📋 探针节点列表', callback_data: 'cb_list_nodes'}], [{text: '⚙️ 系统设置快捷开关', callback_data: 'cb_settings'}] ] };
            
            if (callback_query) {
                if (text === 'cb_menu') await tgEdit(chatId, msgId, mainMenuText, mainMenuKb);
                else if (text === 'cb_list_nodes') {
                    const { results } = await db.prepare('SELECT id, name, last_updated FROM probe_servers WHERE is_hidden != "true"').all();
                    let kb = { inline_keyboard: [] };
                    for (const s of results) { kb.inline_keyboard.push([{text: `${s.name}`, callback_data: `cb_node_${s.id}`}]); }
                    kb.inline_keyboard.push([{text: '🔙 返回', callback_data: 'cb_menu'}]);
                    await tgEdit(chatId, msgId, '📋 <b>当前在线探针：</b>', kb);
                }
                else if (text.startsWith('cb_node_')) {
                    const id = text.split('_')[2]; const s = await db.prepare('SELECT * FROM probe_servers WHERE id = ?').bind(id).first();
                    if (s) await tgEdit(chatId, msgId, `🖥 <b>探针详情:</b> ${escapeHtml(s.name)}\n\n系统: ${escapeHtml(s.os||'-')}\nIP类型: IPv4:${escapeHtml(s.ip_v4)} / IPv6:${escapeHtml(s.ip_v6)}\n运行时长: ${escapeHtml(s.uptime)}\n分组: ${escapeHtml(s.server_group)}`, {inline_keyboard: [[{text: '🔙 返回列表', callback_data: 'cb_list_nodes'}]]});
                }
                else if (text === 'cb_settings') {
                    let set = { is_public: 'false', show_price: 'true' }; try { const { results } = await db.prepare("SELECT key, value FROM probe_settings").all(); results.forEach(r => set[r.key]=r.value); } catch(e){}
                    const kb = { inline_keyboard: [
                        [{text: `${set.is_public === 'true' ? '✅' : '❌'} 公开大盘`, callback_data: 'cb_tog_is_public'}, {text: `${set.show_price === 'true' ? '✅' : '❌'} 显示价格`, callback_data: 'cb_tog_show_price'}],
                        [{text: '🔙 返回主菜单', callback_data: 'cb_menu'}]
                    ]};
                    await tgEdit(chatId, msgId, '⚙️ <b>点击切换探针前台展示状态</b>', kb);
                }
                else if (text.startsWith('cb_tog_')) {
                    const key = text.replace('cb_tog_', '');
                    let cur = 'true'; try { const r = await db.prepare('SELECT value FROM probe_settings WHERE key=?').bind(key).first(); if(r) cur = r.value; } catch(e){}
                    const next = cur === 'true' ? 'false' : 'true';
                    await db.prepare('INSERT INTO probe_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, next).run();
                    context.waitUntil(invalidatePublicProbeCache(url.origin).catch(() => {}));
                    if (key === 'is_public') await notifyRealtimePublicPolicy(env, db, next === 'true', url.origin).catch(() => {});
                    await tgSend(chatId, `✅ 属性 ${key} 已成功切换！`);
                }
            }
            if (message) {
                const cmdParts = text.trim().split(/\s+/); const cmd = cmdParts[0].toLowerCase();
                if (cmd === '/start' || cmd === '/menu') await tgSend(chatId, mainMenuText, mainMenuKb);
                else if (cmd === '/set_interval' && cmdParts[1]) {
                    const interval = Number(cmdParts[1]);
                    if (Number.isInteger(interval) && interval >= 1 && interval <= 3600) { await db.prepare('INSERT INTO probe_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind('report_interval', String(interval)).run(); await tgSend(chatId, `✅ 上报间隔设为 ${interval} 秒`); }
                    else await tgSend(chatId, '❌ 上报间隔必须是 1–3600 的整数');
                }
                else if (cmd === '/set_sitetitle') {
                    const title = text.replace(cmdParts[0], '').trim();
                    if (title && title.length <= 100) { await db.prepare('INSERT INTO probe_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind('site_title', title).run(); await tgSend(chatId, '✅ 大盘标题已更新'); }
                    else await tgSend(chatId, '❌ 大盘标题必须为 1–100 个字符');
                }
            }
            return new Response('OK', { status: 200 });
        } catch(e) { return new Response('Webhook Error', {status:200}); }
    }

    if (method === 'GET' && subPath === 'public') {
        const isAjax = url.searchParams.get('ajax') === '1';
        const cacheKey = new Request(`${url.origin}/api/probe/public?ajax=${isAjax ? '1' : '0'}`);
        const publicSetting = await db.prepare("SELECT value FROM probe_settings WHERE key = 'is_public'").first();
        const isPublic = publicSetting?.value === 'true';
        const viewer = await verifyAuth(request.headers.get('Authorization'), request, db, env, context);
        const isAnonymous = !viewer;
        if (!isPublic && isAnonymous) return Response.json({ error: "Private Dashboard" }, { status: 401 });
        if (isPublic && isAnonymous) {
            const cached = await caches.default.match(cacheKey);
            if (cached) return cached;
        }
        const settings = { theme: 'theme1', is_public: 'false', site_title: '⚡ Server Monitor Pro', show_price: 'true', show_expire: 'true', show_bw: 'true', show_tf: 'true', custom_css: '', custom_bg: '', report_interval: '5', enable_popup: 'false', popup_content: '', cached_nodes_data: '' };
        try { const { results } = await db.prepare('SELECT * FROM probe_settings').all(); if (results) results.forEach(r => settings[r.key] = r.value); } catch(e){}
        const servers = (await db.prepare('SELECT p.id, p.name, p.cpu, p.ram, p.disk, p.load_avg, p.uptime, p.last_updated, p.net_in_speed, p.net_out_speed, p.os, p.arch, p.virt, p.tcp_conn, p.udp_conn, p.country, p.ip_v4, p.ip_v6, p.server_group, p.price, p.expire_date, p.bandwidth, p.traffic_limit, p.ping_ct, p.ping_cu, p.ping_cm, p.ping_bd, p.monthly_rx, p.monthly_tx, p.net_rx, p.net_tx, p.cpu_info, p.ram_used, p.ram_total, p.disk_used, p.disk_total FROM probe_servers p INNER JOIN servers s ON s.ip = p.id WHERE p.is_hidden != "true"').all()).results;
        const visibleServers = isAnonymous
            ? servers.map(({ id, ip_v4, ip_v6, ...server }, index) => ({
                ...Object.fromEntries(Object.entries(server).map(([key, value]) => [key, typeof value === 'string' ? value.split(id).join('[hidden]') : value])),
                id: `public-${index + 1}`,
                name: server.name && !String(server.name).includes(id) ? server.name : `Server ${index + 1}`,
                details_available: false,
            }))
            : servers.map(server => ({ ...server, details_available: true }));
        const publicKeys = new Set(['theme', 'is_public', 'site_title', 'show_price', 'show_expire', 'show_bw', 'show_tf', 'custom_css', 'custom_bg', 'report_interval', 'enable_popup', 'popup_content', 'cached_nodes_data', 'auto_reset_traffic', 'visits_total', 'visits_today', 'visits_date']);
        for (const key of Object.keys(settings)) if (!publicKeys.has(key)) delete settings[key];
        const realtime = env.REALTIME_URL ? null : await db.prepare("SELECT val FROM sys_config WHERE key = 'realtime_url'").first();
        const response = Response.json({ settings, servers: visibleServers, realtime_url: isAnonymous ? '' : (env.REALTIME_URL || realtime?.val || '') }, { headers: { 'Cache-Control': isAnonymous ? 'public, max-age=15, s-maxage=15' : 'private, no-store' } });
        if (isAnonymous && settings.is_public === 'true') context.waitUntil(caches.default.put(cacheKey, response.clone()));
        return response;
    }

    if (method === 'GET' && subPath === 'detail') {
        if (!(await verifyAuth(request.headers.get('Authorization'), request, db, env, context))) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const id = url.searchParams.get('id');
        const server = await db.prepare('SELECT * FROM probe_servers WHERE id = ?').bind(id).first();
        if (!server || server.is_hidden === 'true') return Response.json({ error: "Not found" }, { status: 404 });
        return Response.json(server);
    }

    const probeUser = await verifyAuth(request.headers.get("Authorization"), request, db, env, context);
    if (!probeUser) return Response.json({error: "Unauthorized"}, {status: 401});
    if (subPath.startsWith('admin/') && probeUser !== (env.ADMIN_USERNAME || 'admin')) return Response.json({error: "Forbidden"}, {status: 403});

    // 🌟 GitHub 云端拉取三网节点库
    if (method === 'POST' && subPath === 'admin/pull_github') {
        try {
            const res = await fetch('https://raw.githubusercontent.com/a63414262/CF-Server-Monitor-Pro/refs/heads/main/nodes.json', { signal: AbortSignal.timeout(8000) });
            if (res.ok) {
                const dataText = await res.text();
                await db.prepare("INSERT INTO probe_settings (key, value) VALUES ('cached_nodes_data', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(dataText).run();
                return Response.json({ success: true });
            }
            return Response.json({ error: 'Fetch failed' }, { status: 400 });
        } catch (e) { return Response.json({ error: e.message }, { status: 400 }); }
    }

    if (method === 'GET' && subPath === 'admin/data') {
        const settings = {};
        try { const { results } = await db.prepare('SELECT * FROM probe_settings').all(); if (results) results.forEach(r => settings[r.key] = r.value); } catch(e){}
        const servers = (await db.prepare('SELECT id, name, last_updated, server_group, price, expire_date, bandwidth, traffic_limit, agent_os, is_hidden, reset_day FROM probe_servers').all()).results;
        return Response.json({ settings, servers });
    }
    
    if (method === 'POST' && subPath === 'admin/settings') {
        const { settings } = await readJsonBody(request, 64 * 1024);
        if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).length > 80) return Response.json({ error: 'Invalid settings' }, { status: 400 });
        const allowedSettings = new Set(['theme', 'is_public', 'site_title', 'show_price', 'show_expire', 'show_bw', 'show_tf', 'custom_css', 'custom_bg', 'report_interval', 'enable_popup', 'popup_content', 'cached_nodes_data', 'auto_reset_traffic', 'ping_node_ct', 'ping_node_cu', 'ping_node_cm', 'tg_notify', 'tg_bot_token', 'tg_chat_id', 'subscription_protection', 'realtime_admin_interval', 'realtime_public_interval', 'realtime_idle_interval']);
        if (Object.keys(settings).some(key => !allowedSettings.has(key))) return Response.json({ error: 'Unsupported setting' }, { status: 400 });
        if (Object.prototype.hasOwnProperty.call(settings, 'site_title') && (typeof settings.site_title !== 'string' || !settings.site_title.trim() || settings.site_title.trim().length > 100)) return Response.json({ error: 'Invalid site title' }, { status: 400 });
        if (Object.prototype.hasOwnProperty.call(settings, 'report_interval')) {
            const reportInterval = Number(settings.report_interval);
            if (!Number.isInteger(reportInterval) || reportInterval < 1 || reportInterval > 3600) return Response.json({ error: 'Invalid report interval' }, { status: 400 });
        }
        for (const key of ['ping_node_ct', 'ping_node_cu', 'ping_node_cm']) {
            if (Object.prototype.hasOwnProperty.call(settings, key)) {
                try { settings[key] = normalizePingTarget(settings[key]); }
                catch { return Response.json({ error: 'Invalid ping target' }, { status: 400 }); }
            }
        }
        const frequencyKeys = ['realtime_admin_interval', 'realtime_public_interval', 'realtime_idle_interval'];
        let frequencySettings = settings;
        if (frequencyKeys.some(key => Object.prototype.hasOwnProperty.call(settings, key))) {
            const { results } = await db.prepare("SELECT key, value FROM probe_settings WHERE key IN ('realtime_admin_interval', 'realtime_public_interval', 'realtime_idle_interval')").all();
            frequencySettings = { ...Object.fromEntries((results || []).map(row => [row.key, row.value])), ...settings };
            if (!realtimeFrequencyPolicy(frequencySettings)) return Response.json({ error: 'Invalid realtime frequency policy' }, { status: 400 });
        }
        for (const [k, v] of Object.entries(settings)) { await db.prepare('INSERT INTO probe_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, v).run(); }
        context.waitUntil(invalidatePublicProbeCache(url.origin).catch(() => {}));
        if (Object.prototype.hasOwnProperty.call(settings, 'is_public')) await notifyRealtimePublicPolicy(env, db, settings.is_public === 'true', url.origin).catch(() => {});
        if (frequencyKeys.some(key => Object.prototype.hasOwnProperty.call(settings, key))) await notifyRealtimeFrequencyPolicy(env, db, frequencySettings, url.origin).catch(() => {});
        if (settings.tg_bot_token) {
            try {
               await fetch(`https://api.telegram.org/bot${settings.tg_bot_token}/setWebhook`, {
                  method: 'POST', headers: {'Content-Type': 'application/json'},
                  body: JSON.stringify({ url: `${url.origin}/api/probe/tg_webhook`, ...(env.TG_WEBHOOK_SECRET ? { secret_token: env.TG_WEBHOOK_SECRET } : {}) }),
                  signal: AbortSignal.timeout(10000)
               });
            } catch(e) {}
        }
        return Response.json({ success: true });
    }

    if (method === 'PUT' && subPath === 'admin/server') {
        const data = await readJsonBody(request, 16 * 1024);
        await db.prepare(`UPDATE probe_servers SET name=?, server_group=?, price=?, expire_date=?, bandwidth=?, traffic_limit=?, agent_os=?, is_hidden=?, reset_day=? WHERE id=?`).bind(data.name || 'Unnamed', data.server_group || '默认分组', data.price || '', data.expire_date || '', data.bandwidth || '', data.traffic_limit || '', data.agent_os || 'debian', data.is_hidden || 'false', data.reset_day || '1', data.id).run();
        return Response.json({ success: true });
    }
    
    if (method === 'DELETE' && subPath === 'admin/server') {
        const id = url.searchParams.get('id');
        if (!validIp(id)) return Response.json({ error: 'Invalid VPS IP' }, { status: 400 });
        await deleteVpsRecords(db, id);
        context.waitUntil(invalidatePublicProbeCache(url.origin).catch(() => {}));
        return Response.json({ success: true, removed: id });
    }

    return Response.json({error: "Not Found"}, {status: 404});
}

// ==============================================
// 住宅IP代理：优先桥接外部 Free-Residential-IP-Proxy-Controller；
// 若未配置 PROXY_CTRL_URL，则回落到本地 D1 控制器（与外部控制器接口对齐）。
// ==============================================
async function proxyBridge(method, subPath, request, env, body = null) {
    const ctrlUrl = env.PROXY_CTRL_URL;
    if (!ctrlUrl) return await proxyLocal(method, subPath, request, env, body);
    if (!/^https:\/\//i.test(ctrlUrl)) return Response.json({ error: 'PROXY_CTRL_URL must use HTTPS' }, { status: 503 });
    const currentOrigin = new URL(request.url).origin;
    const targetOrigin = new URL(ctrlUrl).origin;
    if (currentOrigin === targetOrigin) return await proxyLocal(method, subPath, request, env, body);
    const incomingUrl = new URL(request.url);
    const allowedQuery = new URLSearchParams();
    if (subPath === 'config' && incomingUrl.searchParams.get('ip')) allowedQuery.set('ip', incomingUrl.searchParams.get('ip'));
    const target = ctrlUrl.replace(/\/+$/, '') + '/api/' + subPath + (allowedQuery.size ? `?${allowedQuery}` : '');
    let authHeader = '';
    const ctrlUser = env.PROXY_CTRL_USER || '';
    const ctrlPass = env.PROXY_CTRL_PASS || '';
    if (ctrlUser && ctrlPass) {
      const encoded = btoa(`${ctrlUser}:${ctrlPass}`);
      authHeader = `Basic ${encoded}`;
    } else if (env.PROXY_CTRL_TOKEN) {
      authHeader = env.PROXY_CTRL_TOKEN;
    }
    const init = { method, headers: { 'Content-Type': 'application/json', 'Authorization': authHeader } };
    if (method === 'POST') init.body = JSON.stringify(body || {});
    console.log('[proxy-bridge] ->', method, target);
    try {
      // External controller outages must not hold the Worker request open
      // until the platform timeout. Return a normal 502 after a bounded wait.
      init.signal = AbortSignal.timeout(15000);
      const res = await fetch(target, init);
      const text = await res.text();
      console.log('[proxy-bridge] <-', method, target, 'status', res.status);
      const ct = res.headers.get('content-type') || '';
      const isJson = ct.includes('json');
      return new Response(text, { status: res.status, headers: { 'Content-Type': isJson ? 'application/json' : 'text/plain' } });
    } catch (e) {
      console.error('[proxy-bridge] fetch failed:', e);
      return new Response(JSON.stringify({ success: false, error: '代理控制器转发失败: ' + e.message }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
}

async function getProxySlotConfig(db, ip = '') {
    let row = ip ? await db.prepare("SELECT value FROM probe_settings WHERE key = ?").bind(`proxy_slot_map_${ip}`).first() : null;
    if (!row) row = await db.prepare("SELECT value FROM probe_settings WHERE key = 'proxy_slot_map'").first();
    if (!row?.value) return {};
    try {
        const parsed = JSON.parse(row.value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

function proxyPublicListenerEnabled(config, env) {
    return typeof config?.public_listener === 'boolean' ? config.public_listener : env.PROXY_PUBLIC_LISTENER === 'true';
}

async function proxyLocal(method, subPath, req, env, body = null) {
    const db = env.DB;
    await ensureDbSchema(db);
    const url = new URL(req.url);
    const proxyUser = env.PROXY_USER || '';
    const proxyPass = env.PROXY_PASS || '';
    const credentialsReady = !!(proxyUser && proxyPass);

    if (subPath === 'config') {
        if (method === 'GET') {
            try {
                const requestIp = url.searchParams.get('ip');
                const slotMap = { "0": "JP", "port": 7920, ...(await getProxySlotConfig(db, requestIp || '')) };
                const rawCountry = (slotMap["0"] || slotMap.country || "JP").toString().toUpperCase();
                const listenHost = sanitizeProxyListenHost(slotMap.listen_host);
                const publicListener = proxyPublicListenerEnabled(slotMap, env);
                const proxyCfg = { enabled: slotMap.enabled !== false, port: slotMap.port || 7920, user: proxyUser, pass: proxyPass, country: rawCountry, listen_host: listenHost || '', public_listener: publicListener };
                const realtime = await db.prepare("SELECT val FROM sys_config WHERE key = 'realtime_url'").first();
                return new Response(JSON.stringify({ ...slotMap, "0": rawCountry, "port": slotMap.port || 7920, "country": rawCountry, public_listener: publicListener, switch_trigger: slotMap.switch_trigger || 0, proxy: proxyCfg, realtime_url: env.REALTIME_URL || realtime && realtime.val || '' }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' } });
            } catch (e) { return new Response(JSON.stringify({ success: false, error: "GET config failed: " + e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
        }
        if (method === 'POST') {
            try {
                const data = await req.json();
                const configKey = data.ip ? `proxy_slot_map_${data.ip}` : 'proxy_slot_map';
                const existing = await getProxySlotConfig(db, data.ip || '');
                const rawCountry = (data["0"] || data.country || existing["0"] || existing.country || "JP").toString().toUpperCase().trim();
                const sanitized = { ...existing, "0": rawCountry, "country": rawCountry, "port": parseInt(data.port ?? existing.port) || 7920 };
                if (data.listen_host !== undefined) {
                    const listenHost = sanitizeProxyListenHost(data.listen_host);
                    if (listenHost === null) return Response.json({ success: false, error: 'listen_host must be an IPv4 address or empty' }, { status: 400 });
                    sanitized.listen_host = listenHost;
                }
                if (data.enabled !== undefined) sanitized.enabled = !!data.enabled;
                if (data.public_listener !== undefined) {
                    if (typeof data.public_listener !== 'boolean') return Response.json({ success: false, error: 'public_listener must be boolean' }, { status: 400 });
                    if (data.public_listener && !credentialsReady) return Response.json({ success: false, error: 'PROXY_USER and PROXY_PASS must be configured before enabling public listener' }, { status: 503 });
                    sanitized.public_listener = data.public_listener;
                }
                if (data.mesh && typeof data.mesh === 'object') sanitized.mesh = data.mesh;
                if (data.switch_trigger) sanitized.switch_trigger = data.switch_trigger;
                await db.prepare("INSERT INTO probe_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(configKey, JSON.stringify(sanitized)).run();
                const proxyCfg = { enabled: sanitized.enabled !== false, port: sanitized.port, user: proxyUser, pass: proxyPass, country: rawCountry, listen_host: sanitized.listen_host || '', public_listener: proxyPublicListenerEnabled(sanitized, env) };
                return new Response(JSON.stringify({ success: true, slot_map: sanitized, proxy: proxyCfg }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store, must-revalidate' } });
            } catch (e) { console.error('[proxy-config-save] FAILED:', e.message); return new Response(JSON.stringify({ success: false, error: "CONFIG_WRITE_ERR: " + e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } }); }
        }
    }

    if (!credentialsReady) return Response.json({ error: 'PROXY_USER and PROXY_PASS must be configured' }, { status: 503 });

    if (subPath === 'pool' && method === 'GET') {
        const cutoff = Date.now() - 1800000;
        const { results } = await db.prepare('SELECT ip, details, last_seen FROM proxy_ctrl_servers WHERE last_seen >= ? ORDER BY last_seen DESC').bind(cutoff).all();
        return Response.json(results || []);
    }

    if (subPath === 'switch' && method === 'POST') {
        const data = await req.json();
        if (!data.ip) return Response.json({ error: 'IP required' }, { status: 400 });
        const key = `proxy_slot_map_${data.ip}`;
        const row = await db.prepare("SELECT value FROM probe_settings WHERE key = ?").bind(key).first();
        let config = {};
        try { config = JSON.parse(row && row.value || '{}'); } catch (error) {}
        config.switch_trigger = Date.now();
        await db.prepare("INSERT INTO probe_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, JSON.stringify(config)).run();
        return Response.json({ success: true, switch_trigger: config.switch_trigger });
    }

    if (subPath === 'report' && method === 'POST') {
        try {
            const data = body || validateProxyReport(await readJsonBody(req, MAX_PROXY_REPORT_BYTES));
            const proxyIp = data.ip;
            if (data.details !== undefined) {
                await db.prepare(`INSERT INTO proxy_ctrl_servers (ip, details, last_seen) VALUES (?1, ?2, ?3) ON CONFLICT(ip) DO UPDATE SET details = excluded.details, last_seen = excluded.last_seen`).bind(proxyIp, JSON.stringify(data.details), Date.now()).run();
            } else {
                await db.prepare(`INSERT INTO proxy_ctrl_servers (ip, last_seen) VALUES (?1, ?2) ON CONFLICT(ip) DO UPDATE SET last_seen = excluded.last_seen`).bind(proxyIp, Date.now()).run();
            }
            if (data.logs) {
                const existingLog = await db.prepare('SELECT logs FROM server_logs WHERE ip = ?').bind(proxyIp).first();
                if (!existingLog || existingLog.logs !== data.logs) await db.prepare(`INSERT INTO server_logs (ip, logs, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(ip) DO UPDATE SET logs = excluded.logs, updated_at = excluded.updated_at`).bind(proxyIp, data.logs, Date.now()).run();
            }
            return new Response("OK", { status: 200 });
        } catch (e) { return new Response("Error", { status: 500 }); }
    }

    if (subPath === 'proxies' && method === 'GET') {
        const cutoff = Date.now() - 1800000;
        const { results } = await db.prepare('SELECT ip, details FROM proxy_ctrl_servers WHERE last_seen >= ?').bind(cutoff).all();
        const list = [];
        if (results) {
            for (const s of results) {
                const slotConfig = await getProxySlotConfig(db, s.ip);
                if (!proxyPublicListenerEnabled(slotConfig, env)) continue;
                const details = JSON.parse(s.details || '[]');
                const node = details.find(d => d.active) || details[0];
                if (node) list.push(`socks5://${proxyUser}:${proxyPass}@${s.ip}:${node.port}#${node.country}_ActiveNode_${node.node_ip || 'IP'}`);
                else list.push(`socks5://${proxyUser}:${proxyPass}@${s.ip}:7920#Connecting_${s.ip}`);
            }
        }
        return new Response(list.join('\n'), { headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
    }

    if (subPath === 'nodes' && method === 'GET') {
        const cutoff = Date.now() - 1800000;
        const { results } = await db.prepare(`SELECT s.ip, s.details, s.last_seen, l.logs FROM proxy_ctrl_servers s LEFT JOIN server_logs l ON s.ip = l.ip WHERE s.last_seen >= ? ORDER BY s.last_seen DESC`).bind(cutoff).all();
        return new Response(JSON.stringify(results || []), { headers: { 'Content-Type': 'application/json' } });
    }

    if (subPath === 'countries' && method === 'GET') {
        try {
            // Country discovery is supplemental; VPN Gate must not block the
            // proxy page when its public API is unavailable.
            const res = await fetch('https://www.vpngate.net/api/iphone/', { signal: AbortSignal.timeout(8000) });
            const text = await res.text();
            const lines = text.split('\n');
            const countries = new Map();
            for (let i = 2; i < lines.length; i++) {
                const parts = lines[i].split(',');
                if (parts.length > 6) {
                    const c = String(parts[6] || '').replace(/^"|"$/g, '').trim().toUpperCase();
                    const nodeIp = String(parts[1] || '').replace(/^"|"$/g, '').trim();
                    if (c && /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== '--' && nodeIp) {
                        countries.set(c, (countries.get(c) || 0) + 1);
                    }
                }
            }
            const preset = ["US","JP","KR","SG","HK","TW","GB","DE","FR","NL","CA","AU","IN","VN","BR","AE","MY","TH","PH","ID","TR","ZA","IT","ES","RU","CH","SE","PL","NO","DK","FI","IE","AT","NZ","BE","PT","CZ","GR","HU","RO","BG","HR","SK","SI","LT","LV","EE","UA","RS","BA","CY","MT","IS","LU"];
            const result = Array.from(new Set([...preset, ...countries.keys()])).sort().map(code => ({ code, nodes: countries.get(code) || 0 }));
            return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        } catch {
            return new Response(JSON.stringify(["US","JP","KR","SG","HK","TW"].map(code => ({ code, nodes: 0 }))), { headers: { 'Content-Type': 'application/json' } });
        }
    }

    if (subPath.startsWith('testisp-lookup/') && method === 'GET') {
        let targetIp;
        try { targetIp = decodeURIComponent(subPath.replace('testisp-lookup/', '')); }
        catch (error) { return new Response(JSON.stringify({ error: 'Invalid IP' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
        if (!/^[0-9a-fA-F:.]+$/.test(targetIp)) return new Response(JSON.stringify({ error: 'Invalid IP' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        try {
            const resp = await fetch(`https://testisp.info/api/check?ip=${encodeURIComponent(targetIp)}`, {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
                signal: AbortSignal.timeout(10000)
            });
            const text = await resp.text();
            return new Response(text, { status: resp.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        } catch (err) {
            return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
    }

    return new Response("Not Found", { status: 404 });
}

async function checkOfflineServers(env) {
    const db = env.DB; const nowMs = Date.now();
    await ensureDbSchema(db);
    const realtime = env.REALTIME_URL || (await db.prepare("SELECT val FROM sys_config WHERE key = 'realtime_url'").first())?.val;
    const offlineThreshold = realtime ? 1200000 : 360000;
    const { results } = await db.prepare(`SELECT ip, name, last_report FROM servers WHERE last_report < ? AND alert_sent = 0`).bind(nowMs - offlineThreshold).all();
    if (!results || !results.length) return 0;
    let tgBotToken = env.TG_BOT_TOKEN; let tgChatId = env.TG_CHAT_ID;
    try { const { results: settings } = await db.prepare("SELECT key, value FROM probe_settings WHERE key IN ('tg_bot_token', 'tg_chat_id')").all(); settings.forEach(r => { if(r.key === 'tg_bot_token') tgBotToken = r.value; if(r.key === 'tg_chat_id') tgChatId = r.value; }); } catch(e){}
    const updates = [];
    for (const vps of results) {
        let delivered = !tgBotToken || !tgChatId;
        if (tgBotToken && tgChatId) {
            const text = `⚠️ [KUI 节点失联告警]\n\n节点别名: ${vps.name}\n公网IP: ${vps.ip}\n最后在线: ${new Date(vps.last_report).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
            try { const response = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: tgChatId, text }), signal: AbortSignal.timeout(10000) }); const result = await response.json().catch(()=>({ok:false})); delivered = response.ok && result.ok === true; }
            catch (error) { console.error(`[cron] Telegram alert failed for ${vps.ip}:`, error); }
        }
        if (delivered) updates.push(db.prepare("UPDATE servers SET alert_sent = 1 WHERE ip = ?").bind(vps.ip));
    }
    if (updates.length) await chunkBatch(db, updates);
    return results.length;
}

// ==============================================
// KUI 主体接口路由
// ==============================================
export async function onRequest(context) {
    const { request, env, params } = context;
    const method = request.method;
    const action = params.path ? params.path[0] : ''; 
    const db = env.DB; 

    // 防御：未绑定 D1 数据库时直接返回清晰错误，避免 Cloudflare 1101 (Worker threw exception)
    if (!env || !env.DB) {
        return new Response(JSON.stringify({ error: "D1 binding 'DB' is not configured in Cloudflare Pages. Please bind a D1 database (variable name DB) and redeploy." }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    if (action === "probe") {
        await ensureDbSchema(db);
        return await handleProbeAPI(request, env, context, params.path.slice(1));
    }

    if (action === "ui_ping" && method === "POST") {
        if (!(await verifyAuth(request.headers.get("Authorization"), request, db, env, context))) return new Response("Unauthorized", { status: 401 });
        const now = Date.now();
        const current = await db.prepare("SELECT ts FROM sys_config WHERE key = 'ui_active'").first();
        if (!current || now - current.ts > 300000) await db.prepare("INSERT OR REPLACE INTO sys_config (key, val, ts) VALUES ('ui_active', '1', ?)").bind(now).run();
        return Response.json({ success: true });
    }

    if (action === "cron_check" && method === "POST") {
        if (!env.CRON_SECRET || request.headers.get('Authorization') !== `Bearer ${env.CRON_SECRET}`) return new Response('Unauthorized', { status: 401 });
        await ensureDbSchema(db);
        return Response.json({ success: true, alerted: await checkOfflineServers(env) });
    }

    if (action === "agent_egress_ip" && method === "GET") {
        await ensureDbSchema(db);
        const ip = new URL(request.url).searchParams.get('ip') || '';
        if (!validIp(ip) || !(await verifyAgent(request.headers.get('Authorization'), ip, db, env))) return new Response('Unauthorized', { status: 401 });
        const observedIp = request.headers.get('CF-Connecting-IP') || '';
        if (!validIp(observedIp)) return Response.json({ error: 'Client IP unavailable' }, { status: 503 });
        return Response.json({ ip: observedIp }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (action === "agent_update" && method === "GET") {
        await ensureDbSchema(db);
        const updateUrl = new URL(request.url);
        const ip = updateUrl.searchParams.get('ip');
        const component = updateUrl.searchParams.get('component') || 'agent';
        const exchangeBootstrap = updateUrl.searchParams.get('exchange') === '1';
        const authHeader = request.headers.get('Authorization') || '';
        const agentAuthenticated = await verifyAgent(authHeader, ip, db, env);
        let bootstrapToken = '';
        if (!agentAuthenticated) {
            const match = /^Bootstrap ([A-Za-z0-9_-]{32,128})$/.exec(authHeader);
            bootstrapToken = match?.[1] || '';
            const bootstrap = bootstrapToken ? await db.prepare('SELECT vps_ip FROM agent_bootstrap_tokens WHERE token_hash = ? AND vps_ip = ? AND component = ? AND expires_at > ? AND used_at = 0').bind(await sha256(bootstrapToken), ip, component, Date.now()).first() : null;
            if (!bootstrap) return new Response('Unauthorized', { status: 401 });
        }
        if (!env.ASSETS) return Response.json({ error: 'ASSETS binding is unavailable' }, { status: 503 });
        const assets = { agent: '/vps/agent.py', 'realtime-client': '/vps/realtime_client.py', 'proxy-manager': '/vps/lite_manager.py', 'proxy-server': '/vps/proxy_server.py', 'proxy-installer': '/vps/residential-proxy.sh', 'full-installer': '/vps/kui.sh', uninstaller: '/vps/uninstall-agent.sh' };
        if (!assets[component]) return Response.json({ error: 'Unknown agent component' }, { status: 400 });
        const assetUrl = new URL(assets[component], request.url);
        const asset = await env.ASSETS.fetch(assetUrl);
        if (!asset.ok) return new Response('Agent asset not found', { status: 404 });
        const source = await asset.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', source);
        const assetSha256 = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
        const server = await db.prepare('SELECT agent_token FROM servers WHERE ip = ?').bind(ip).first();
        if (!server?.agent_token) return new Response('Agent token unavailable', { status: 503 });
        const manifest = updateManifest(component, assetSha256, source.byteLength);
        const mac = await hmacHex(server.agent_token, manifest);
        const contentType = component.endsWith('installer') ? 'text/x-shellscript; charset=utf-8' : 'text/x-python; charset=utf-8';
        if (bootstrapToken && exchangeBootstrap) {
            const used = await db.prepare('UPDATE agent_bootstrap_tokens SET used_at = ? WHERE token_hash = ? AND used_at = 0').bind(Date.now(), await sha256(bootstrapToken)).run();
            if (Number(used.meta?.changes || 0) !== 1) return new Response('Bootstrap token already used', { status: 401 });
        }
        return new Response(source, { headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Agent-SHA256': assetSha256, 'X-Agent-Manifest-Version': '1', 'X-Agent-Length': String(source.byteLength), 'X-Agent-MAC': mac, ...(bootstrapToken && exchangeBootstrap ? { 'X-Agent-Token': server.agent_token } : {}), 'X-Proxy-Controller-Mode': env.PROXY_CTRL_URL ? 'external' : 'builtin' } });
    }

    // 🌟 Agent 统一探针与管理上报接口 (融入全新的 Reset Day 计算和动态云端测速节点)
    if (action === "report" && method === "POST") {
     try {
        await ensureDbSchema(db);
        const data = validateTrafficReport(await readJsonBody(request, MAX_REPORT_BYTES));
        const nowMs = Date.now();
        const vpsIp = data.ip;
        const authHeader = request.headers.get("Authorization");
        if (!(await verifyAgent(authHeader, vpsIp, db, env))) return new Response("Unauthorized", { status: 401 });
        if (!data.report_id) return Response.json({ error: "report_id is required" }, { status: 400 });
        const duplicateReport = !!(await db.prepare("SELECT report_id FROM report_receipts WHERE report_id = ? AND applied = 1").bind(data.report_id).first());

        const kuiServer = await db.prepare('SELECT name FROM servers WHERE ip = ?').bind(vpsIp).first();
        if (!kuiServer) {
            return Response.json({ error: "Server has been removed from KUI panel." }, { status: 403 });
        }
        const serverName = kuiServer.name;

        try { 
            await db.prepare("UPDATE servers SET cpu=?, mem=?, disk=?, load=?, uptime=?, net_in_speed=?, net_out_speed=?, tcp_conn=?, udp_conn=?, last_report=?, alert_sent=0 WHERE ip=?")
                    .bind(data.cpu||0, data.mem||0, data.disk||0, data.load||'', data.uptime||'', data.net_in_speed||0, data.net_out_speed||0, data.tcp_conn||0, data.udp_conn||0, nowMs, vpsIp).run(); 
        } catch (e) { 
            await ensureDbSchema(db); 
            await db.prepare("UPDATE servers SET cpu=?, mem=?, disk=?, load=?, uptime=?, net_in_speed=?, net_out_speed=?, tcp_conn=?, udp_conn=?, last_report=?, alert_sent=0 WHERE ip=?")
                    .bind(data.cpu||0, data.mem||0, data.disk||0, data.load||'', data.uptime||'', data.net_in_speed||0, data.net_out_speed||0, data.tcp_conn||0, data.udp_conn||0, nowMs, vpsIp).run(); 
        }

        try {
            let countryCode = request.cf && request.cf.country ? request.cf.country : 'XX'; 
            if (countryCode.toUpperCase() === 'TW') countryCode = 'CN';

            const probeServer = await db.prepare('SELECT * FROM probe_servers WHERE id = ?').bind(vpsIp).first();
            
            // --- 全新核心：基于动态 reset_day 的流量生命周期重置 ---
            const localNow = new Date(nowMs + 8 * 60 * 60000); 
            let y = localNow.getFullYear();
            let m = localNow.getMonth() + 1;
            let d = localNow.getDate();
            
            let resetDayVal = probeServer ? parseInt(probeServer.reset_day) || 1 : 1;
            if (resetDayVal < 1) resetDayVal = 1; if (resetDayVal > 31) resetDayVal = 31;
            
            let maxDaysThisMonth = new Date(y, m, 0).getDate();
            let actualResetDayThisMonth = Math.min(resetDayVal, maxDaysThisMonth);
            
            let currentCycleStr = '';
            if (d < actualResetDayThisMonth) {
                let pm = m - 1; let py = y;
                if (pm === 0) { pm = 12; py -= 1; }
                let maxDaysPrevMonth = new Date(py, pm, 0).getDate();
                let actualResetDayPrevMonth = Math.min(resetDayVal, maxDaysPrevMonth);
                currentCycleStr = `${py}-${pm}-${actualResetDayPrevMonth}`;
            } else {
                currentCycleStr = `${y}-${m}-${actualResetDayThisMonth}`;
            }

            let monthly_rx = 0, monthly_tx = 0, last_rx = 0, last_tx = 0;
            let reset_month = currentCycleStr;
            let history = {};

            if (!probeServer) {
                await db.prepare(`INSERT INTO probe_servers (id, name, cpu, ram, disk, load_avg, uptime, last_updated, ram_total, net_rx, net_tx, net_in_speed, net_out_speed, os, cpu_info, arch, boot_time, ram_used, swap_total, swap_used, disk_total, disk_used, processes, tcp_conn, udp_conn, country, ip_v4, ip_v6, server_group, price, expire_date, bandwidth, traffic_limit, ping_ct, ping_cu, ping_cm, ping_bd, monthly_rx, monthly_tx, last_rx, last_tx, reset_month, agent_os, history, is_hidden, virt, reset_day) VALUES (?, ?, '0', '0', '0', '0', '0', 0, '0', '0', '0', '0', '0', '', '', '', '', '0', '0', '0', '0', '0', '0', '0', '0', ?, '1', '0', '默认分组', '免费', '', '', '', '0', '0', '0', '0', '0', '0', '0', '0', ?, 'debian', '{}', 'false', '', '1')`).bind(vpsIp, serverName, countryCode, currentCycleStr).run();
            } else {
                monthly_rx = parseFloat(probeServer.monthly_rx || '0'); monthly_tx = parseFloat(probeServer.monthly_tx || '0');
                last_rx = parseFloat(probeServer.last_rx || '0'); last_tx = parseFloat(probeServer.last_tx || '0');
                reset_month = probeServer.reset_month || currentCycleStr;
                
                let autoReset = 'false';
                try { const r = await db.prepare("SELECT value FROM probe_settings WHERE key = 'auto_reset_traffic'").first(); if (r) autoReset = r.value; } catch(e){}
                // 周期变动立即清零结算
                if (autoReset === 'true' && currentCycleStr !== reset_month) { monthly_rx = 0; monthly_tx = 0; reset_month = currentCycleStr; }
                try { history = JSON.parse(probeServer.history || '{}'); } catch(e) {}
            }

            const current_rx = parseFloat(data.net_rx || '0'); const current_tx = parseFloat(data.net_tx || '0');
            const probeAlreadyApplied = probeServer && probeServer.last_report_id === data.report_id;
            if (!duplicateReport && !probeAlreadyApplied) {
                if (current_rx >= last_rx) monthly_rx += (current_rx - last_rx); else monthly_rx += current_rx;
                if (current_tx >= last_tx) monthly_tx += (current_tx - last_tx); else monthly_tx += current_tx;
                last_rx = current_rx; last_tx = current_tx;
            }

            const lastHistTime = history.last_time || 0;
            if (nowMs - lastHistTime >= 300000 || !history.time) {
                const maxPoints = 288; 
                const updateArr = (arr, val) => { if (!Array.isArray(arr)) arr = []; arr.push(val); if (arr.length > maxPoints) arr.shift(); return arr; };
                const updateLabels = (arr) => { if (!Array.isArray(arr)) arr = []; const d = new Date(nowMs + 8 * 60 * 60000); arr.push(d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0')); if (arr.length > maxPoints) arr.shift(); return arr; };
                history.cpu = updateArr(history.cpu, parseFloat(data.cpu) || 0); history.ram = updateArr(history.ram, parseFloat(data.mem) || 0); history.proc = updateArr(history.proc, parseInt(data.processes) || 0); 
                history.net_in = updateArr(history.net_in, parseFloat(data.net_in_speed) || 0); history.net_out = updateArr(history.net_out, parseFloat(data.net_out_speed) || 0); 
                history.tcp = updateArr(history.tcp, parseInt(data.tcp_conn) || 0); history.udp = updateArr(history.udp, parseInt(data.udp_conn) || 0); 
                history.ping_ct = updateArr(history.ping_ct, parseInt(data.ping_ct) || 0); history.ping_cu = updateArr(history.ping_cu, parseInt(data.ping_cu) || 0); history.ping_cm = updateArr(history.ping_cm, parseInt(data.ping_cm) || 0); history.ping_bd = updateArr(history.ping_bd, parseInt(data.ping_bd) || 0); 
                history.time = updateLabels(history.time); history.last_time = nowMs;
            }

            await db.prepare(`UPDATE probe_servers SET cpu=?, ram=?, disk=?, load_avg=?, uptime=?, last_updated=?, ram_total=?, net_rx=?, net_tx=?, net_in_speed=?, net_out_speed=?, os=?, cpu_info=?, arch=?, boot_time=?, ram_used=?, swap_total=?, swap_used=?, disk_total=?, disk_used=?, processes=?, tcp_conn=?, udp_conn=?, ping_ct=?, ping_cu=?, ping_cm=?, ping_bd=?, monthly_rx=CASE WHEN last_report_id=? THEN monthly_rx ELSE ? END, monthly_tx=CASE WHEN last_report_id=? THEN monthly_tx ELSE ? END, last_rx=CASE WHEN last_report_id=? THEN last_rx ELSE ? END, last_tx=CASE WHEN last_report_id=? THEN last_tx ELSE ? END, reset_month=?, history=?, virt=?, last_report_id=? WHERE id=?`)
                    .bind(data.cpu||0, data.mem||0, data.disk||0, data.load||'', data.uptime||'', nowMs, data.ram_total||'0', data.net_rx||'0', data.net_tx||'0', data.net_in_speed||0, data.net_out_speed||0, data.os||'', data.cpu_info||'', data.arch||'', data.boot_time||'', data.ram_used||'0', data.swap_total||'0', data.swap_used||'0', data.disk_total||'0', data.disk_used||'0', data.processes||'0', data.tcp_conn||0, data.udp_conn||0, data.ping_ct||'0', data.ping_cu||'0', data.ping_cm||'0', data.ping_bd||'0', data.report_id, monthly_rx.toString(), data.report_id, monthly_tx.toString(), data.report_id, last_rx.toString(), data.report_id, last_tx.toString(), reset_month, JSON.stringify(history), data.virt||'', data.report_id, vpsIp).run();

        } catch (e) { console.error("探针数据同步失败:", e); }

        const stmts = []; let totalDelta = 0;
        if (!duplicateReport) stmts.push(db.prepare("INSERT OR IGNORE INTO report_receipts (report_id, vps_ip, created_at, applied) VALUES (?, ?, ?, 0)").bind(data.report_id, vpsIp, nowMs));
        if (!duplicateReport && data.node_traffic.length > 0) {
            const traffic = data.node_traffic;
            if (traffic.length) {
                const trafficJson = JSON.stringify(traffic.map(nt => ({ id: nt.id, bytes: Number(nt.delta_bytes) })));
                const deltaCte = `WITH deltas(id, bytes) AS (SELECT json_extract(value, '$.id'), CAST(json_extract(value, '$.bytes') AS INTEGER) FROM json_each(?))`;
                stmts.push(db.prepare(`${deltaCte} UPDATE nodes SET traffic_used = traffic_used + COALESCE((SELECT SUM(bytes) FROM deltas WHERE deltas.id = nodes.id), 0) WHERE vps_ip = ? AND id IN (SELECT id FROM deltas) AND EXISTS (SELECT 1 FROM report_receipts WHERE report_id = ? AND applied = 0)`).bind(trafficJson, vpsIp, data.report_id));
                stmts.push(db.prepare(`${deltaCte}, user_deltas(username, bytes) AS (SELECT n.username, SUM(d.bytes) FROM deltas d JOIN nodes n ON n.id = d.id AND n.vps_ip = ? GROUP BY n.username) UPDATE users SET traffic_used = traffic_used + COALESCE((SELECT bytes FROM user_deltas WHERE user_deltas.username = users.username), 0) WHERE username IN (SELECT username FROM user_deltas) AND EXISTS (SELECT 1 FROM report_receipts WHERE report_id = ? AND applied = 0)`).bind(trafficJson, vpsIp, data.report_id));
                totalDelta = data.total_delta;
            }
        }
        if (data.argo_urls && data.argo_urls.length > 0) { for (let argo of data.argo_urls) { stmts.push(db.prepare("UPDATE nodes SET sni = ? WHERE id = ? AND vps_ip = ? AND protocol = 'VLESS-Argo' AND sni != ?").bind(argo.url, argo.id, vpsIp, argo.url)); } }
        if (!duplicateReport && data.system_traffic_delta > 0) {
            const day = new Date(nowMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
            stmts.push(db.prepare("INSERT INTO traffic_daily (ip, day, total_bytes) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM report_receipts WHERE report_id = ? AND applied = 0) ON CONFLICT(ip, day) DO UPDATE SET total_bytes = traffic_daily.total_bytes + excluded.total_bytes").bind(vpsIp, day, data.system_traffic_delta, data.report_id));
        }
        if (!duplicateReport) stmts.push(db.prepare("UPDATE report_receipts SET applied = 1 WHERE report_id = ? AND applied = 0").bind(data.report_id));
        if (stmts.length > 0) {
            await db.batch(stmts);
        }
        if (nowMs - lastReceiptCleanup > 3600000) {
            lastReceiptCleanup = nowMs;
            context.waitUntil(db.prepare("DELETE FROM report_receipts WHERE created_at < ?").bind(nowMs - 604800000).run().catch(() => {}));
        }
        
        let fastMode = false; try { const uiActive = await db.prepare("SELECT ts FROM sys_config WHERE key = 'ui_active'").first(); if (uiActive && (nowMs - uiActive.ts < 360000)) fastMode = true; } catch(e) {}
        
        let reportInterval = 5; let pingCt = 'default'; let pingCu = 'default'; let pingCm = 'default';
        try { 
            const { results } = await db.prepare("SELECT key, value FROM probe_settings WHERE key IN ('report_interval', 'ping_node_ct', 'ping_node_cu', 'ping_node_cm')").all(); 
            if (results) {
                results.forEach(r => {
                    if (r.key === 'report_interval') reportInterval = parseInt(r.value) || 5;
                    if (r.key === 'ping_node_ct') pingCt = r.value;
                    if (r.key === 'ping_node_cu') pingCu = r.value;
                    if (r.key === 'ping_node_cm') pingCm = r.value;
                });
            }
        } catch(e) {}
        
        const effectiveInterval = Math.min(300, fastMode ? Math.max(60, reportInterval) : Math.max(300, reportInterval));
        return Response.json({ success: true, fast_mode: fastMode, interval: effectiveInterval, ping_ct: pingCt, ping_cu: pingCu, ping_cm: pingCm });
     } catch (err) {
        return Response.json({ error: "REPORT_ERR: " + (err && err.message ? err.message : String(err)) }, { status: 500 });
     }
    }

    if (action === "config" && method === "GET") {
        await ensureDbSchema(db);
        const deploymentId = await getDeploymentId(db);
        const ip = new URL(request.url).searchParams.get("ip"); const now = Date.now(); const adminUser = env.ADMIN_USERNAME || "admin";
        const authHeader = request.headers.get("Authorization");
        const currentUser = await verifyAuth(authHeader, request, db, env, context);
        const agentAuthenticated = await verifyAgent(authHeader, ip, db, env);
        if (currentUser !== adminUser && !agentAuthenticated) return new Response("Unauthorized", { status: 401 });
        const query = `SELECT n.* FROM nodes n LEFT JOIN users u ON n.username = u.username WHERE n.vps_ip = ? AND n.enable = 1 AND (n.traffic_limit = 0 OR n.traffic_used < n.traffic_limit) AND (n.expire_time = 0 OR n.expire_time > ?) AND (n.username = ? OR n.username = 'admin' OR (u.username IS NOT NULL AND u.enable = 1 AND (u.traffic_limit = 0 OR u.traffic_used < u.traffic_limit) AND (u.expire_time = 0 OR u.expire_time > ?)))`;
        const { results } = await db.prepare(query).bind(ip, now, adminUser, now).all();
        const activeNodesById = new Map(results.map(node => [node.id, node]));
        const machineNodes = results.filter(node => {
            if (node.protocol !== 'dokodemo-door' || node.relay_type !== 'internal') return true;
            const targetNode = activeNodesById.get(node.target_id);
            if (!targetNode || !INTERNAL_RELAY_PROTOCOLS.has(targetNode.protocol)) return false;
            node.chain_target = { ip: '127.0.0.1', port: targetNode.port, protocol: targetNode.protocol, uuid: targetNode.uuid, password: targetNode.private_key, sni: targetNode.sni, public_key: targetNode.public_key, short_id: targetNode.short_id, network: targetNode.network };
            return true;
        });
        let proxyCfg = { global: {}, toggle: { enable: false } };
        try {
            const r = await db.prepare("SELECT value FROM probe_settings WHERE key='proxy_config'").first();
            if (r && r.value) { try { proxyCfg.global = JSON.parse(r.value); } catch (ex) {} }
            const t = await db.prepare("SELECT value FROM probe_settings WHERE key='proxy_toggle_' || ?").bind(ip).first();
            if (t && t.value) { try { proxyCfg.toggle = JSON.parse(t.value); } catch (ex) {} }
        } catch (ex) {}
        let egress = { desired_mode: 'native', applied_mode: 'native', revision: 0, applied_revision: 0, status: 'applied', error: '', applied_at: 0 };
        let residential_outbound = { available: false, ready: false, reason: '住宅代理尚未上报可用状态' };
        try {
            const s = await db.prepare("SELECT egress_mode, egress_applied_mode, egress_revision, egress_applied_revision, egress_status, egress_error, egress_applied_at, egress_desired_config, egress_applied_config, proxy_mode, proxy_categories, proxy_custom_domains, egress_ip, socks5_addr, socks5_port, socks5_user, socks5_pass FROM servers WHERE ip = ?").bind(ip).first();
            if (s) {
                let legacyCustomDomains = []; try { legacyCustomDomains = normalizeProxyCustomDomains(JSON.parse(s.proxy_custom_domains || '[]')); } catch {}
                const legacyDesired = { mode: s.egress_mode || 'native', proxy_mode: s.proxy_mode || 'global', proxy_categories: s.proxy_categories || '', proxy_custom_domains: legacyCustomDomains };
                if (legacyDesired.mode === 'socks5') legacyDesired.socks5 = { addr: s.socks5_addr || '', port: Number(s.socks5_port || 0), user: s.socks5_user || '', pass: s.socks5_pass || '' };
                const legacyApplied = { ...legacyDesired, mode: s.egress_applied_mode || 'native' };
                const desiredConfig = parseEgressConfig(s.egress_desired_config, legacyDesired);
                const appliedConfig = parseEgressConfig(s.egress_applied_config, legacyApplied);
                const desiredSocks5 = desiredConfig.mode === 'socks5' && desiredConfig.socks5 ? desiredConfig.socks5 : {};
                egress = {
                    desired_mode: desiredConfig.mode,
                    applied_mode: appliedConfig.mode,
                    revision: Number(s.egress_revision || 0),
                    applied_revision: Number(s.egress_applied_revision || 0),
                    status: s.egress_status || 'applied',
                    error: s.egress_error || '',
                    applied_at: Number(s.egress_applied_at || 0),
                    proxy_mode: desiredConfig.proxy_mode || 'global',
                    proxy_categories: desiredConfig.proxy_categories || '',
                    proxy_custom_domains: normalizeProxyCustomDomains(desiredConfig.proxy_custom_domains || []),
                    egress_ip: s.egress_ip || '',
                    socks5_addr: desiredSocks5.addr || '',
                    socks5_port: Number(desiredSocks5.port || 0),
                    socks5_user: desiredSocks5.user || '',
                    socks5_pass: agentAuthenticated ? desiredSocks5.pass || '' : '',
                    desired_config: agentAuthenticated ? desiredConfig : undefined,
                    applied_config: agentAuthenticated ? appliedConfig : undefined,
                };
            }
            const slot = await db.prepare("SELECT value FROM probe_settings WHERE key = ?").bind(`proxy_slot_map_${ip}`).first();
            const globalSlot = slot || await db.prepare("SELECT value FROM probe_settings WHERE key = 'proxy_slot_map'").first();
            let port = 7920; try { port = parseInt(JSON.parse(slot?.value || '{}').port) || 7920; } catch (_) {}
            try { port = parseInt(JSON.parse(globalSlot?.value || '{}').port) || 7920; } catch (_) {}
            let listenHost = '';
            try { listenHost = sanitizeProxyListenHost(JSON.parse(globalSlot?.value || '{}').listen_host) || ''; } catch (_) {}
            const localResidential = !env.PROXY_CTRL_URL;
            const proxyState = await db.prepare('SELECT details, last_seen FROM proxy_ctrl_servers WHERE ip = ?').bind(ip).first();
            let details = [];
            try { details = JSON.parse(proxyState?.details || '[]'); } catch (_) {}
            const active = Array.isArray(details) ? details.find(item => item?.active && Number(item.port || port) >= 1 && Number(item.port || port) <= 65535) : null;
            const fresh = Number(proxyState?.last_seen || 0) >= Date.now() - 5 * 60 * 1000;
            const credentialsReady = !!(env.PROXY_USER && env.PROXY_PASS);
            const ready = localResidential && credentialsReady && fresh && !!active;
            let reason = '';
            if (!localResidential) reason = '外部住宅控制器模式不支持本机住宅出口';
            else if (!credentialsReady) reason = 'Worker 未配置住宅代理凭据';
            else if (!proxyState) reason = 'proxy-lite 尚未上报状态';
            else if (!fresh) reason = 'proxy-lite 状态已过期';
            else if (!active) reason = '住宅 OpenVPN 主通道尚未就绪';
            const residentialAddr = listenHost || '127.0.0.1';
            residential_outbound = {
                available: ready,
                ready,
                reason,
                addr: residentialAddr,
                port: Number(active?.port || port),
                check_addr: residentialAddr,
                active_exit_ip: active?.node_ip || '',
                last_seen: Number(proxyState?.last_seen || 0),
                user: agentAuthenticated && localResidential ? env.PROXY_USER || '' : '',
                pass: agentAuthenticated && localResidential ? env.PROXY_PASS || '' : ''
            };
        } catch (ex) {}
        const serverAuth = await db.prepare("SELECT agent_token FROM servers WHERE ip = ?").bind(ip).first();
        const realtime = await db.prepare("SELECT val FROM sys_config WHERE key = 'realtime_url'").first();
        return Response.json({ success: true, deployment_id: deploymentId, configs: machineNodes, agent_token: serverAuth && serverAuth.agent_token || '', proxy: proxyCfg, residential_outbound, egress, realtime_url: env.REALTIME_URL || realtime && realtime.val || '' });
    }

        if (action === "egress_result" && method === "POST") {
            await ensureDbSchema(db);
            const body = await request.json();
            const ip = body.ip || request.headers.get('X-KUI-IP');
            if (!ip || !(await verifyAgent(request.headers.get('Authorization'), ip, db, env))) return new Response('Unauthorized', { status: 401 });
        const modes = [...EGRESS_MODES];
        const revision = Number(body.revision);
        if (!Number.isSafeInteger(revision) || revision < 0 || !modes.includes(body.applied_mode)) return Response.json({ error: 'Invalid egress result' }, { status: 400 });
        const deploymentId = await getDeploymentId(db);
        if (body.deployment_id && body.deployment_id !== deploymentId) return Response.json({ error: 'Stale deployment state', deployment_id: deploymentId }, { status: 409 });
        const success = body.success === true;
        const error = success ? '' : String(body.error || 'Egress apply failed').slice(0, 500);
        const egress_ip = body.egress_ip ? String(body.egress_ip).slice(0, 64) : '';
        let result;
        if (body.status === 'preparing') {
            const message = String(body.message || 'WARP environment is preparing').slice(0, 500);
            result = await db.prepare("UPDATE servers SET egress_status = 'preparing', egress_error = ? WHERE ip = ? AND egress_revision = ? AND egress_mode = ?").bind(message, ip, revision, body.desired_mode).run();
        } else if (success) {
            result = await db.prepare("UPDATE servers SET egress_applied_mode = ?, egress_applied_revision = ?, egress_applied_config = egress_desired_config, egress_status = 'applied', egress_error = '', egress_applied_at = ?, egress_ip = ? WHERE ip = ? AND egress_revision = ? AND egress_mode = ?").bind(body.applied_mode, revision, Date.now(), egress_ip, ip, revision, body.applied_mode).run();
        } else {
            result = await db.prepare("UPDATE servers SET egress_status = 'failed', egress_error = ?, egress_applied_at = ? WHERE ip = ? AND egress_revision = ? AND egress_applied_mode = ?").bind(error, Date.now(), ip, revision, body.applied_mode).run();
        }
        return Response.json({ success: true, accepted: Number(result.meta?.changes || 0) > 0 });
    }

    // 🌟 住宅IP代理：优先外部控制器 (PROXY_CTRL_URL)；未配置时回落到本地 D1 实现
    if (action === "proxy") {
        const sub = params.path && params.path.length > 1 ? params.path.slice(1).join('/') : '';
        const allowedProxyPaths = sub === 'config' || sub === 'report' || sub === 'proxies' || sub === 'nodes' || sub === 'countries' || sub === 'pool' || sub === 'switch' || sub.startsWith('testisp-lookup/');
        if (!allowedProxyPaths || sub.includes('..')) return new Response('Not Found', { status: 404 });
        if (sub === "mesh" || sub.startsWith("mesh/")) {
            return new Response(JSON.stringify({ error: "mesh is not supported" }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
        if (sub === 'report' && method === 'POST') {
            let body;
            try { body = validateProxyReport(await readJsonBody(request.clone(), MAX_PROXY_REPORT_BYTES)); }
            catch (error) { return Response.json({ error: error.message || 'Invalid proxy report' }, { status: 400 }); }
            if (!(await verifyAgent(request.headers.get('Authorization'), body.ip, db, env))) return new Response('Unauthorized', { status: 401 });
            return await proxyBridge(method, sub, request, env, body);
        } else if (sub === 'config' && method === 'GET') {
            const requestIp = new URL(request.url).searchParams.get('ip');
            const user = await verifyAuth(request.headers.get('Authorization'), request, db, env, context);
            if (user !== (env.ADMIN_USERNAME || 'admin') && !(await verifyAgent(request.headers.get('Authorization'), requestIp, db, env))) return new Response('Forbidden', { status: 403 });
        } else {
            const user = await verifyAuth(request.headers.get('Authorization'), request, db, env, context);
            if (user !== (env.ADMIN_USERNAME || 'admin')) return new Response('Forbidden', { status: 403 });
        }
        return await proxyBridge(method, sub, request, env);
    }

    // 🌟 核心拦截并拆分普通订阅与 Clash 订阅生成
    if (action === "sub" && method === "GET") {
        await ensureDbSchema(db);
        const urlObj = new URL(request.url);
        const ip = urlObj.searchParams.get("ip");
        const nodeId = urlObj.searchParams.get("node");
        const reqUser = urlObj.searchParams.get("user");
        const token = urlObj.searchParams.get("token");
        const format = urlObj.searchParams.get("format");
        const adminUser = env.ADMIN_USERNAME || "admin";
        const authenticatedSurgeUser = format === 'surge'
            ? await verifyAuth(request.headers.get('Authorization'), request, db, env, context)
            : '';
        const authenticatedSurgeAccess = format === 'surge'
            && !!authenticatedSurgeUser
            && authenticatedSurgeUser === reqUser;
        const subscriptionProtection = await db.prepare("SELECT value FROM probe_settings WHERE key = 'subscription_protection'").first();
        if (subscriptionProtection?.value !== 'false' && !authenticatedSurgeAccess) {
            return new Response('Not Found', {
                status: 404,
                headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
            });
        }

        if (nodeId && !/^[A-Za-z0-9_-]{1,64}$/.test(nodeId)) return json({ error: "Not found" }, 404);

        let isValid = authenticatedSurgeAccess;
        if (!isValid && reqUser === adminUser) {
            let adminSubToken = '';
            try { const r = await db.prepare("SELECT val FROM sys_config WHERE key='admin_sub_token'").first(); if(r && r.val) adminSubToken = r.val; } catch(e){} 
            isValid = !!adminSubToken && token === adminSubToken;
        } 
        else if (!isValid) {
            const u = await db.prepare("SELECT password, sub_token FROM users WHERE username = ? AND enable = 1").bind(reqUser).first();
            if (u) isValid = !!u.sub_token && token === u.sub_token;
        }
        
        // Invalid tokens deliberately look like absent endpoints. Protected
        // subscriptions return a harmless HTTP 200 profile before validation.
        if (!isValid) return json({ error: "Not found" }, 404);
        
        const now = Date.now(); 
        let query; 
        let sqlParams = [now];
        
        if (reqUser === adminUser) { 
            query = `SELECT * FROM nodes WHERE enable = 1 AND (traffic_limit = 0 OR traffic_used < traffic_limit) AND (expire_time = 0 OR expire_time > ?) AND (username = ? OR username = 'admin')`; 
            sqlParams.push(adminUser); 
            if (ip) { query += " AND vps_ip = ?"; sqlParams.push(ip); } 
            if (nodeId) { query += " AND id = ?"; sqlParams.push(nodeId); }
        } else { 
            query = `SELECT DISTINCT n.* FROM nodes n JOIN users u ON u.username = ? WHERE n.enable = 1 AND (n.traffic_limit = 0 OR n.traffic_used < n.traffic_limit) AND (n.expire_time = 0 OR n.expire_time > ?) AND u.enable = 1 AND (u.traffic_limit = 0 OR u.traffic_used < u.traffic_limit) AND (u.expire_time = 0 OR u.expire_time > ?) AND (n.username = u.username OR EXISTS (SELECT 1 FROM user_group_members gm JOIN user_group_resources gr ON gr.group_id = gm.group_id WHERE gm.username = u.username AND ((gr.resource_type = 'node' AND gr.resource_id = n.id) OR (gr.resource_type = 'vps' AND gr.resource_id = n.vps_ip))))`;
            sqlParams = [reqUser, now, now];
            if (ip) { query += " AND n.vps_ip = ?"; sqlParams.push(ip); } 
            if (nodeId) { query += " AND n.id = ?"; sqlParams.push(nodeId); }
        }
        
        const { results } = await db.prepare(query).bind(...sqlParams).all(); 
        
        let subLinks = [];
        let clashProxies = [];
        let proxyNames = [];
        let surgeProxies = [];
        let surgeUnsupported = new Set();

        for (let node of results) {
            const vpsInfo = await db.prepare("SELECT name FROM servers WHERE ip = ?").bind(node.vps_ip).first(); 
            const rawRemark = `${vpsInfo ? vpsInfo.name : 'KUI'} | ${node.protocol}_${node.port}`; 
            const remark = encodeURIComponent(rawRemark); 
            let link = "";
            let cProxy = "";
            const nodeIp = formatIpForLink(node.vps_ip);
            const nodeSni = node.sni || '';

            // --- 传统 Base64 URL 生成 ---
            switch (node.protocol) {
                case "VLESS": link = `vless://${node.uuid}@${nodeIp}:${node.port}?encryption=none&security=none&type=tcp#${remark}`; break;
                case "XTLS-Reality": case "Reality": link = `vless://${node.uuid}@${nodeIp}:${node.port}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=${encodeURIComponent(nodeSni)}&fp=chrome&pbk=${encodeURIComponent(node.public_key)}&sid=${encodeURIComponent(node.short_id || "")}&type=tcp&headerType=none#${remark}`; break;
                case "Hysteria2": link = `hysteria2://${encodeURIComponent(node.uuid || node.private_key)}@${nodeIp}:${node.port}/?insecure=1&sni=${encodeURIComponent(nodeSni)}&alpn=h3#${remark}`; break;
                case "TUIC": link = `tuic://${encodeURIComponent(node.uuid)}:${encodeURIComponent(node.private_key)}@${nodeIp}:${node.port}?congestion_control=bbr&udp_relay_mode=native&alpn=h3&allow_insecure=1#${remark}`; break;
                case "Shadowsocks2022": link = `ss://${base64Url(`${node.uuid}:${node.private_key}`)}@${nodeIp}:${node.port}#${remark}`; break;
                case "Trojan": link = `trojan://${encodeURIComponent(node.private_key)}@${nodeIp}:${node.port}?security=tls&sni=${encodeURIComponent(nodeSni)}&allowInsecure=1&type=tcp#${remark}`; break;
                case "H2-Reality": link = `vless://${node.uuid}@${nodeIp}:${node.port}?encryption=none&security=reality&sni=${encodeURIComponent(nodeSni)}&fp=chrome&pbk=${encodeURIComponent(node.public_key)}&sid=${encodeURIComponent(node.short_id || "")}&type=http&host=${encodeURIComponent(nodeSni)}&path=%2F#${remark}`; break;
                case "gRPC-Reality": link = `vless://${node.uuid}@${nodeIp}:${node.port}?encryption=none&security=reality&sni=${encodeURIComponent(nodeSni)}&fp=chrome&pbk=${encodeURIComponent(node.public_key)}&sid=${encodeURIComponent(node.short_id || "")}&type=grpc&serviceName=grpc#${remark}`; break;
                case "AnyTLS": link = `anytls://${encodeURIComponent(node.private_key)}@${nodeIp}:${node.port}?security=tls&sni=${encodeURIComponent(nodeSni)}&insecure=1#${remark}`; break;
                case "Naive": link = `naive+https://${encodeURIComponent(node.uuid)}:${encodeURIComponent(node.private_key)}@${nodeIp}:${node.port}?security=tls&sni=${encodeURIComponent(nodeSni)}#${remark}`; break;
                case "Socks5": link = `socks5://${encodeURIComponent(node.uuid)}:${encodeURIComponent(node.private_key)}@${nodeIp}:${node.port}#${remark}`; break;
                case "VLESS-Argo": if (!(node.sni || '').includes('等待')) link = `vless://${node.uuid}@${node.sni}:443?encryption=none&security=tls&type=ws&host=${node.sni}&path=%2F#${remark}-Argo`; break;
                case "MTProxy": link = buildNodeSubscriptionUri(node); break;
            }
            if (link) subLinks.push(link);

            if (format === 'surge') {
                const surgeLine = buildSurgeProxyLine({ name: rawRemark, protocol: node.protocol, host: nodeIp, port: node.port, method: node.uuid, uuid: node.uuid, password: node.private_key, sni: node.protocol === 'TUIC' ? '' : nodeSni, network: node.network });
                if (surgeLine) surgeProxies.push(surgeLine);
                else surgeUnsupported.add(node.protocol);
            }

            // --- 动态拼装 Clash YAML 代理字典 (支持 Clash Meta / Mihomo) ---
            if (format === 'clash') {
                if (node.protocol.includes("VLESS") || node.protocol.includes("Reality")) {
                    const serverIpOrSni = (node.protocol === 'VLESS-Argo' && !(node.sni || '').includes('等待')) ? node.sni : nodeIp;
                    const serverPort = node.protocol === 'VLESS-Argo' ? 443 : node.port;
                    cProxy = `  - name: ${yamlString(rawRemark)}\n    type: vless\n    server: ${yamlString(serverIpOrSni)}\n    port: ${serverPort}\n    uuid: ${yamlString(node.uuid)}\n    udp: true`;
                    
                    if (node.protocol === "XTLS-Reality" || node.protocol === "Reality") {
                        cProxy += `\n    tls: true\n    flow: xtls-rprx-vision\n    servername: ${yamlString(nodeSni)}\n    client-fingerprint: chrome\n    reality-opts:\n      public-key: ${yamlString(node.public_key)}\n      short-id: ${yamlString(node.short_id || "")}`;
                     } else if (node.protocol === "gRPC-Reality") {
                         cProxy += `\n    tls: true\n    alpn:\n      - h2\n    servername: ${yamlString(nodeSni)}\n    client-fingerprint: chrome\n    network: grpc\n    grpc-opts:\n      grpc-service-name: grpc\n    reality-opts:\n      public-key: ${yamlString(node.public_key)}\n      short-id: ${yamlString(node.short_id || "")}`;
                     } else if (node.protocol === "H2-Reality") {
                         cProxy += `\n    tls: true\n    alpn:\n      - h2\n    servername: ${yamlString(nodeSni)}\n    client-fingerprint: chrome\n    reality-opts:\n      public-key: ${yamlString(node.public_key || '')}\n      short-id: ${yamlString(node.short_id || "")}\n    network: h2\n    h2-opts:\n      host:\n        - ${yamlString(nodeSni || nodeIp)}\n      path: "/"`;
                    } else if (node.protocol === 'VLESS-Argo' && !(node.sni || '').includes('等待')) {
                        cProxy += `\n    tls: true\n    servername: ${yamlString(nodeSni)}\n    network: ws\n    ws-opts:\n      path: "/"\n      headers:\n        Host: ${yamlString(nodeSni)}`;
                    }
                } else if (node.protocol === "Trojan") {
                    cProxy = `  - name: ${yamlString(rawRemark)}\n    type: trojan\n    server: ${yamlString(nodeIp)}\n    port: ${node.port}\n    password: ${yamlString(node.private_key)}\n    udp: true\n    sni: ${yamlString(nodeSni)}\n    skip-cert-verify: true`;
                } else if (node.protocol === "AnyTLS") {
                    cProxy = `  - name: ${yamlString(rawRemark)}\n    type: anytls\n    server: ${yamlString(nodeIp)}\n    port: ${node.port}\n    password: ${yamlString(node.private_key)}\n    client-fingerprint: chrome\n    udp: true\n    sni: ${yamlString(nodeSni)}\n    skip-cert-verify: true`;
                } else if (node.protocol === "Hysteria2") {
                    cProxy = `  - name: ${yamlString(rawRemark)}\n    type: hysteria2\n    server: ${yamlString(nodeIp)}\n    port: ${node.port}\n    password: ${yamlString(node.uuid || node.private_key)}\n    sni: ${yamlString(nodeSni)}\n    skip-cert-verify: true`;
                } else if (node.protocol === "TUIC") {
                    cProxy = `  - name: ${yamlString(rawRemark)}\n    type: tuic\n    server: ${yamlString(nodeIp)}\n    port: ${node.port}\n    uuid: ${yamlString(node.uuid)}\n    password: ${yamlString(node.private_key)}\n    alpn:\n      - h3\n    udp-relay-mode: native\n    congestion-controller: bbr\n    skip-cert-verify: true`;
                } else if (node.protocol === "Shadowsocks2022") {
                    cProxy = `  - name: ${yamlString(rawRemark)}\n    type: ss\n    server: ${yamlString(nodeIp)}\n    port: ${node.port}\n    cipher: ${yamlString(node.uuid)}\n    password: ${yamlString(node.private_key)}\n    udp: ${node.network !== 'tcp'}`;
                } else if (node.protocol === "Socks5") {
                    cProxy = `  - name: ${yamlString(rawRemark)}\n    type: socks5\n    server: ${yamlString(nodeIp)}\n    port: ${node.port}\n    username: ${yamlString(node.uuid)}\n    password: ${yamlString(node.private_key)}\n    udp: true`;
                }
                
                if (cProxy) {
                    clashProxies.push(cProxy);
                    proxyNames.push(yamlString(rawRemark));
                }
            }
        }

        // --- 第三方订阅节点整合进订阅 ---
        if (!ip && !nodeId) try {
            const { results: thNodes } = await db.prepare("SELECT * FROM third_party_nodes WHERE enable = 1").all();
            for (const node of thNodes) {
                try {
                const remark = encodeURIComponent(node.name || `TP_${node.protocol}_${node.port}`);
                let link = "";
                const thirdIp = formatIpForLink(node.address);
                const thirdSni = node.sni || '';
                switch (node.protocol) {
                    case "VMess": link = (node.extra && node.extra.startsWith('vmess://')) ? node.extra : ''; break;
                    case "VLESS": {
                        if (node.flow && (node.public_key || node.flow.includes('rprx'))) {
                            link = `vless://${node.uuid}@${thirdIp}:${node.port}?encryption=none&flow=${node.flow}&security=reality&sni=${thirdSni}&fp=chrome&pbk=${node.public_key||''}&sid=${node.short_id||''}&type=${node.network||'tcp'}${node.path ? '&path=' + encodeURIComponent(node.path) : ''}#${remark}`;
                        } else {
                            link = `vless://${node.uuid}@${thirdIp}:${node.port}?encryption=none&security=none&type=${node.network||'tcp'}${node.path ? '&path=' + encodeURIComponent(node.path) : ''}${node.host ? '&host=' + encodeURIComponent(node.host) : ''}#${remark}`;
                        }
                        break;
                    }
                    case "XTLS-Reality": case "Reality": link = `vless://${node.uuid}@${thirdIp}:${node.port}?encryption=none&flow=${node.flow||'xtls-rprx-vision'}&security=reality&sni=${thirdSni}&fp=chrome&pbk=${node.public_key}&sid=${node.short_id||""}&type=${node.network||'tcp'}${node.path?'&path='+encodeURIComponent(node.path):''}${node.host?'&host='+encodeURIComponent(node.host):''}#${remark}`; break;
                    case "Hysteria2": link = `hysteria2://${encodeURIComponent(node.uuid || node.password)}@${thirdIp}:${node.port}/?insecure=1&sni=${encodeURIComponent(thirdSni)}&alpn=h3#${remark}`; break;
                    case "TUIC": link = `tuic://${node.uuid}:${node.password}@${thirdIp}:${node.port}?sni=${thirdSni}&congestion_control=bbr&alpn=h3&allow_insecure=1#${remark}`; break;
                    case "Trojan": link = `trojan://${node.password}@${thirdIp}:${node.port}?security=tls&sni=${thirdSni}&allowInsecure=1&type=tcp#${remark}`; break;
                    case "H2-Reality": link = `vless://${node.uuid}@${thirdIp}:${node.port}?encryption=none&security=reality&sni=${thirdSni}&fp=chrome&pbk=${node.public_key}&sid=${node.short_id || ""}&type=http#${remark}`; break;
                    case "gRPC-Reality": link = `vless://${node.uuid}@${thirdIp}:${node.port}?encryption=none&security=reality&sni=${thirdSni}&fp=chrome&pbk=${node.public_key}&sid=${node.short_id || ""}&type=grpc&serviceName=grpc#${remark}`; break;
                    case "AnyTLS": link = `anytls://${node.password}@${thirdIp}:${node.port}?security=tls&sni=${thirdSni}&insecure=1#${remark}`; break;
                    case "Naive": link = `naive+https://${node.uuid}:${node.password}@${thirdIp}:${node.port}?security=tls&sni=${thirdSni}#${remark}`; break;
                    case "Socks5": link = `socks5://${btoa(unescape(encodeURIComponent(`${node.uuid}:${node.password}`)))}@${thirdIp}:${node.port}#${remark}`; break;
                    case "SS": {
                        const method = node.uuid || (() => { try { return JSON.parse(node.extra || '{}').method; } catch(e) { return ''; } })();
                        link = `ss://${btoa(unescape(encodeURIComponent(`${method}:${node.password}`)))}@${thirdIp}:${node.port}#${remark}`;
                        break;
                    }
                    case "SSR": link = `ssr://${btoa(unescape(encodeURIComponent(`${thirdIp}:${node.port}:origin:${node.uuid}:plain:${btoa(node.password || '')}/?remarks=${btoa(unescape(encodeURIComponent(node.name || 'SSR')))}`)))}`; break;
                }
                if (link) subLinks.push(link);

                if (format === 'surge') {
                    let surgeMethod = node.uuid;
                    if (node.protocol === 'SS' && !surgeMethod) {
                        try { surgeMethod = JSON.parse(node.extra || '{}').method || ''; } catch {}
                    }
                    const surgeLine = buildSurgeProxyLine({ name: node.name || `TP_${node.protocol}_${node.port}`, protocol: node.protocol, host: thirdIp, port: node.port, method: surgeMethod, uuid: node.uuid, password: node.password, sni: thirdSni, network: node.network });
                    if (surgeLine) surgeProxies.push(surgeLine);
                    else surgeUnsupported.add(node.protocol);
                }

                if (format === 'clash') {
                    let cProxy = "";
                    if (node.protocol === "VMess") {
                        cProxy = `  - name: ${yamlString(node.name || 'TP')}\n    type: vmess\n    server: ${yamlString(thirdIp)}\n    port: ${node.port}\n    uuid: ${yamlString(node.uuid)}\n    alterId: 0\n    cipher: auto\n    udp: true${node.network && node.network !== 'tcp' ? `\n    network: ${yamlString(node.network)}${node.host ? `\n    ws-headers:\n      Host: ${yamlString(node.host)}` : ''}${node.path ? `\n    ws-path: ${yamlString(node.path)}` : ''}` : ''}`;
                    } else if (node.protocol.includes("VLESS") || node.protocol.includes("Reality")) {
                        const isReality = (node.flow && node.flow.includes('rprx')) || ["XTLS-Reality", "Reality", "H2-Reality", "gRPC-Reality"].includes(node.protocol);
                        cProxy = `  - name: ${yamlString(node.name || 'TP')}\n    type: vless\n    server: ${yamlString(thirdIp)}\n    port: ${node.port}\n    uuid: ${yamlString(node.uuid)}\n    udp: true`;
                        if (isReality) {
                             cProxy += `\n    tls: true${['http', 'grpc'].includes((node.network || '').toLowerCase()) || ['H2-Reality', 'gRPC-Reality'].includes(node.protocol) ? '\n    alpn:\n      - h2' : ''}\n    servername: ${yamlString(thirdSni)}\n    client-fingerprint: chrome\n    reality-opts:\n      public-key: ${yamlString(node.public_key || '')}\n      short-id: ${yamlString(node.short_id || "")}`;
                            if (((node.protocol === "Reality" || node.protocol === "XTLS-Reality") && node.flow && node.flow.includes('rprx')) || node.protocol === "VLESS") {
                                cProxy += `\n    flow: ${node.flow || 'xtls-rprx-vision'}`;
                            }
                            const net = node.network || 'tcp';
                            if (net === 'grpc') {
                                cProxy += `\n    network: grpc\n    grpc-opts:\n      grpc-service-name: ${node.extra?.serviceName || 'grpc'}`;
                            } else if (net === 'http') {
                                const path = node.path || '/';
                                const hostHeader = node.host || thirdSni || thirdIp;
                                cProxy += `\n    network: h2\n    h2-opts:\n      host:\n        - ${yamlString(hostHeader)}\n      path: ${yamlString(path)}`;
                            } else if (net === 'ws') {
                                const path = node.path || '/';
                                const hostHeader = node.host || thirdSni || thirdIp;
                                cProxy += `\n    network: ws\n    ws-opts:\n      path: ${yamlString(path)}\n      headers:\n        Host: ${yamlString(hostHeader)}`;
                            }
                        } else if (node.protocol === "gRPC-Reality") {
                            cProxy += `\n    tls: true\n    servername: ${yamlString(thirdSni)}\n    client-fingerprint: chrome\n    network: grpc\n    grpc-opts:\n      grpc-service-name: grpc\n    reality-opts:\n      public-key: ${yamlString(node.public_key)}\n      short-id: ${yamlString(node.short_id || "")}`;
                         } else if (node.protocol === "H2-Reality") {
                             cProxy += `\n    tls: true\n    servername: ${yamlString(thirdSni)}\n    client-fingerprint: chrome\n    network: h2\n    h2-opts:\n      host:\n        - ${yamlString(thirdSni || thirdIp)}\n      path: "/"`;
                        }
                    } else if (node.protocol === "Trojan") {
                        cProxy = `  - name: ${yamlString(node.name || 'TP')}\n    type: trojan\n    server: ${yamlString(thirdIp)}\n    port: ${node.port}\n    password: ${yamlString(node.password)}\n    udp: true\n    sni: ${yamlString(thirdSni)}\n    skip-cert-verify: true`;
                    } else if (node.protocol === "AnyTLS") {
                        cProxy = `  - name: ${yamlString(node.name || 'TP')}\n    type: anytls\n    server: ${yamlString(thirdIp)}\n    port: ${node.port}\n    password: ${yamlString(node.password)}\n    client-fingerprint: chrome\n    udp: true\n    sni: ${yamlString(thirdSni)}\n    skip-cert-verify: true`;
                    } else if (node.protocol === "Hysteria2") {
                        cProxy = `  - name: ${yamlString(node.name || 'TP')}\n    type: hysteria2\n    server: ${yamlString(thirdIp)}\n    port: ${node.port}\n    password: ${yamlString(node.uuid || node.password)}\n    sni: ${yamlString(thirdSni)}\n    skip-cert-verify: true`;
                    } else if (node.protocol === "TUIC") {
                        cProxy = `  - name: ${yamlString(node.name || 'TP')}\n    type: tuic\n    server: ${yamlString(thirdIp)}\n    port: ${node.port}\n    uuid: ${yamlString(node.uuid)}\n    password: ${yamlString(node.password)}\n    sni: ${yamlString(thirdSni)}\n    skip-cert-verify: true`;
                    } else if (node.protocol === "SS") {
                        cProxy = `  - name: ${yamlString(node.name || 'TP')}\n    type: ss\n    server: ${yamlString(thirdIp)}\n    port: ${node.port}\n    cipher: ${yamlString(node.uuid)}\n    password: ${yamlString(node.password)}`;
                    }
                    if (cProxy) {
                        clashProxies.push(cProxy);
                        proxyNames.push(yamlString(node.name || 'TP'));
                    }
                }
                } catch(e) {}
            }
        } catch (e) {}

        // Residential SOCKS5 endpoints are runtime proxy records rather than
        // regular protocol nodes, so append them explicitly for the admin.
        // They include shared proxy credentials and must never be exposed to
        // ordinary user subscriptions.
        if (!nodeId && reqUser === adminUser && env.PROXY_USER && env.PROXY_PASS) {
            try {
                const cutoff = Date.now() - 1800000;
                const { results: proxyServers } = await db.prepare('SELECT ip, details FROM proxy_ctrl_servers WHERE last_seen >= ?').bind(cutoff).all();
                for (const server of proxyServers || []) {
                    if (ip && server.ip !== ip) continue;
                    const slotConfig = await getProxySlotConfig(db, server.ip);
                    if (!proxyPublicListenerEnabled(slotConfig, env)) continue;
                    let details = [];
                    try { details = JSON.parse(server.details || '[]'); } catch {}
                    const active = details.find(detail => detail?.active && Number.isInteger(Number(detail.port)) && Number(detail.port) >= 1 && Number(detail.port) <= 65535);
                    if (!active) continue;
                    const port = Number(active.port);
                    const serverIp = formatIpForLink(server.ip);
                    const name = `住宅 SOCKS5 | ${active.country || 'AUTO'} | ${server.ip}:${port}`;
                    const encodedCredentials = btoa(unescape(encodeURIComponent(`${env.PROXY_USER}:${env.PROXY_PASS}`)));
                    subLinks.push(`socks5://${encodedCredentials}@${serverIp}:${port}#${encodeURIComponent(name)}`);
                    if (format === 'surge') surgeProxies.push(buildSurgeProxyLine({ name, protocol: 'Socks5', host: serverIp, port, uuid: env.PROXY_USER, password: env.PROXY_PASS }));
                    if (format === 'clash') {
                        clashProxies.push(`  - name: ${yamlString(name)}\n    type: socks5\n    server: ${yamlString(serverIp)}\n    port: ${port}\n    username: ${yamlString(env.PROXY_USER)}\n    password: ${yamlString(env.PROXY_PASS)}\n    udp: true`);
                        proxyNames.push(yamlString(name));
                    }
                }
            } catch (error) {
                console.error('Failed to append residential SOCKS5 subscriptions:', error);
            }
        }

        // --- 若为 Clash 格式，渲染 YAML 返回 ---
        if (format === 'clash') {
            const proxyGroupList = proxyNames.length > 0 ? proxyNames.map(n => `      - ${n}`).join('\n') : '      - DIRECT';
            const hasIPv6 = results.some(n => /:/.test(n.vps_ip)) || clashProxies.some(p => /server:\s*["']?\[/.test(p));
            const clashYaml = `port: 7890
socks-port: 7891
allow-lan: true
mode: rule
log-level: info
ipv6: ${hasIPv6 ? 'true' : 'false'}
external-controller: 127.0.0.1:9090

proxies:
${clashProxies.join('\n')}

proxy-groups:
  - name: "PROXY"
    type: select
    proxies:
      - "AUTO"
${proxyGroupList}
  - name: "AUTO"
    type: url-test
    url: http://www.gstatic.com/generate_204
    interval: 300
    proxies:
${proxyGroupList}

rules:
  - MATCH,PROXY
`;
            return new Response(clashYaml, { 
                headers: { 
                    "Content-Type": "text/yaml; charset=utf-8", 
                    "Content-Disposition": "attachment; filename=kui-clash.yaml" 
                }
            });
        }

        if (format === 'surge') {
            const unsupportedComments = [...surgeUnsupported].sort().map(protocol => `# 已跳过 Surge 不原生支持的协议：${protocol}`);
            const surgeConfig = ['[Proxy]', ...surgeProxies, ...(unsupportedComments.length ? ['', ...unsupportedComments] : [])].join('\n') + '\n';
            return new Response(surgeConfig, {
                headers: {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Content-Disposition': 'attachment; filename=kui-surge.conf',
                    'Cache-Control': 'no-store',
                }
            });
        }

        // --- 否则走默认的 Base64 普通订阅格式 ---
        return new Response(btoa(unescape(encodeURIComponent(subLinks.join('\n')))), { headers: { "Content-Type": "text/plain; charset=utf-8" }});
    }

    if (action === "login" && method === "POST") {
        await ensureAuthSchema(db);
        if (!env.ADMIN_PASSWORD) return Response.json({ error: "ADMIN_PASSWORD is not configured" }, { status: 503 });
        if (!(await loginAllowed(db, request))) return Response.json({ error: "Too many attempts" }, { status: 429, headers: { 'Retry-After': '900' } });
        let credentials;
        try { credentials = await readJsonBody(request, 8 * 1024); } catch { credentials = {}; }
        const username = String(credentials.username || '').trim(); const password = String(credentials.password || '');
        let valid = false;
        if (username === (env.ADMIN_USERNAME || 'admin')) valid = password.length > 0 && password === env.ADMIN_PASSWORD;
        else { const user = await db.prepare('SELECT password FROM users WHERE username = ? AND enable = 1').bind(username).first(); valid = !!user && await passwordMatches(password, user.password); if (valid && /^[0-9a-f]{64}$/i.test(user.password || '')) await db.prepare('UPDATE users SET password = ? WHERE username = ?').bind(await passwordHash(password), username).run(); }
        if (valid) { const token = await sessionToken(); await db.prepare('INSERT INTO auth_sessions (token_hash, username, expires_at) VALUES (?, ?, ?)').bind(await sha256(token), username, Date.now() + 12 * 60 * 60 * 1000).run(); context.waitUntil(db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').bind(Date.now()).run().catch(() => {})); await db.prepare('DELETE FROM login_throttles WHERE key = ?').bind(loginThrottleKey(request)).run(); return Response.json({ success: true, token, role: username === (env.ADMIN_USERNAME || "admin") ? 'admin' : 'user' }); }
        await recordLoginFailure(db, request);
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (action === "logout" && method === "POST") {
        await ensureDbSchema(db);
        const header = request.headers.get('Authorization') || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : '';
        if (/^[A-Za-z0-9_-]{32,128}$/.test(token)) await db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(await sha256(token)).run();
        return Response.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (action === "realtime_auth" && method === "POST") {
        await ensureDbSchema(db);
        const username = await verifyAuth(request.headers.get("Authorization"), request, db, env, context);
        const isAdminUser = username === (env.ADMIN_USERNAME || "admin");
        return Response.json({ success: isAdminUser, admin: isAdminUser }, { status: isAdminUser ? 200 : 403, headers: { "Cache-Control": "no-store" } });
    }

    // Full VPS purge is intentionally authenticated by the VPS Agent Token,
    // because the Agent invokes it after local component cleanup.
    if (action === "vps_purge" && method === "POST") {
        await ensureDbSchema(db);
        let body;
        try { body = await readJsonBody(request, 8 * 1024); }
        catch (error) { return Response.json({ error: error.message || 'Invalid request' }, { status: 400 }); }
        const ip = String(body.ip || request.headers.get('X-KUI-IP') || '');
        if (!validIp(ip) || !(await verifyAgent(request.headers.get('Authorization'), ip, db, env))) return new Response('Unauthorized', { status: 401 });
        const existing = await db.prepare('SELECT ip FROM servers WHERE ip = ?').bind(ip).first();
        if (!existing) return Response.json({ success: true, already_removed: true });
        await deleteVpsRecords(db, ip);
        return Response.json({ success: true, removed: ip });
    }

    const currentUser = await verifyAuth(request.headers.get("Authorization"), request, db, env, context);
    const isAdmin = currentUser === (env.ADMIN_USERNAME || "admin");
    if (!currentUser) return Response.json({ error: "Unauthorized" }, { status: 401 });

    try {
        if (action === "agent_bootstrap" && method === "POST" && isAdmin) {
            await ensureDbSchema(db);
            const { ip, component } = await readJsonBody(request, 4 * 1024);
            if (!validIp(ip) || !(await db.prepare('SELECT ip FROM servers WHERE ip = ?').bind(ip).first())) return Response.json({ error: 'VPS not found' }, { status: 404 });
            if (!['full-installer', 'uninstaller'].includes(component)) return Response.json({ error: 'Invalid bootstrap component' }, { status: 400 });
            const existingToken = await db.prepare('SELECT agent_token FROM servers WHERE ip = ?').bind(ip).first();
            if (!existingToken?.agent_token) await db.prepare('UPDATE servers SET agent_token = ? WHERE ip = ? AND (agent_token IS NULL OR agent_token = ?)').bind(crypto.randomUUID(), ip, '').run();
            const token = await sessionToken();
            const expiresAt = Date.now() + 5 * 60 * 1000;
            await db.prepare('INSERT INTO agent_bootstrap_tokens (token_hash, vps_ip, component, expires_at, used_at) VALUES (?, ?, ?, ?, 0)').bind(await sha256(token), ip, component, expiresAt).run();
            context.waitUntil(db.prepare('DELETE FROM agent_bootstrap_tokens WHERE expires_at < ? OR used_at > 0').bind(Date.now()).run().catch(() => {}));
            return Response.json({ token, expires_at: expiresAt }, { headers: { 'Cache-Control': 'no-store' } });
        }
        if (action === "data") {
            const servers = isAdmin
                ? (await db.prepare(`SELECT ip, name, cpu, mem, last_report, alert_sent, disk, load, uptime,
                    net_in_speed, net_out_speed, tcp_conn, udp_conn,
                    egress_mode, egress_applied_mode, egress_revision, egress_applied_revision,
                    egress_status, egress_error, egress_applied_at, proxy_mode, proxy_categories, proxy_custom_domains, egress_ip,
                    socks5_addr, socks5_port, socks5_user,
                    CASE WHEN COALESCE(socks5_pass, '') <> '' THEN 1 ELSE 0 END AS socks5_password_set
                    FROM servers`).all()).results
                : (await db.prepare("SELECT ip, name, cpu, mem, last_report, disk, load, uptime, net_in_speed, net_out_speed, tcp_conn, udp_conn FROM servers").all()).results;
            if (isAdmin) {
                const cutoff = Date.now() - 300000;
                const { results: proxyStates } = await db.prepare('SELECT ip, details, last_seen FROM proxy_ctrl_servers').all();
                const proxyStateByIp = new Map((proxyStates || []).map(row => [row.ip, row]));
                for (const server of servers) {
                    const state = proxyStateByIp.get(server.ip);
                    const slotConfig = await getProxySlotConfig(db, server.ip);
                    server.proxy_public_listener = proxyPublicListenerEnabled(slotConfig, env);
                    server.proxy_public_port = Math.min(65535, Math.max(1, Number(slotConfig.port) || 7920));
                    let details = [];
                    try { details = JSON.parse(state?.details || '[]'); } catch {}
                    const active = Array.isArray(details) ? details.find(item => item?.active && Number(item.port || 0) >= 1 && Number(item.port || 0) <= 65535 && (item.exit_ip || item.node_ip)) : null;
                    const standby = Array.isArray(details) ? details.find(item => !item?.active && Number(item.port || 0) >= 1 && Number(item.port || 0) <= 65535 && (item.exit_ip || item.node_ip)) : null;
                    const activeExitIp = active?.exit_ip || active?.node_ip || '';
                    const standbyExitIp = standby?.exit_ip || standby?.node_ip || '';
                    const localResidential = !env.PROXY_CTRL_URL;
                    const credentialsReady = !!(env.PROXY_USER && env.PROXY_PASS);
                    server.residential_ready = !!(localResidential && credentialsReady && state && Number(state.last_seen || 0) >= cutoff && active);
                    server.residential_active_exit_ip = activeExitIp;
                    server.residential_standby_exit_ip = standbyExitIp;
                    server.residential_last_seen = Number(state?.last_seen || 0);
                    if (!localResidential) server.residential_reason = '外部住宅控制器模式不支持本机住宅出口';
                    else if (!credentialsReady) server.residential_reason = 'Worker 未配置住宅代理凭据';
                    else if (!state) server.residential_reason = '住宅代理控制器尚未上报';
                    else if (Number(state.last_seen || 0) < cutoff) server.residential_reason = '住宅代理控制器心跳已过期';
                    else if (!active) server.residential_reason = '住宅 OpenVPN 主通道尚未就绪';
                    else server.residential_reason = '';
                }
            }
            const nodes = isAdmin ? (await db.prepare("SELECT * FROM nodes").all()).results : (await db.prepare("SELECT DISTINCT n.* FROM nodes n WHERE n.username = ? OR EXISTS (SELECT 1 FROM user_group_members gm JOIN user_group_resources gr ON gr.group_id = gm.group_id WHERE gm.username = ? AND ((gr.resource_type = 'node' AND gr.resource_id = n.id) OR (gr.resource_type = 'vps' AND gr.resource_id = n.vps_ip)))").bind(currentUser, currentUser).all()).results;
            const userFields = 'username, traffic_limit, traffic_used, expire_time, enable';
            const users = isAdmin ? (await db.prepare(`SELECT ${userFields} FROM users`).all()).results : (await db.prepare(`SELECT ${userFields} FROM users WHERE username = ?`).bind(currentUser).all()).results;
            const groups = isAdmin ? (await db.prepare("SELECT g.*, COALESCE((SELECT json_group_array(username) FROM user_group_members WHERE group_id = g.id), '[]') AS members, COALESCE((SELECT json_group_array(json_object('type', resource_type, 'id', resource_id)) FROM user_group_resources WHERE group_id = g.id), '[]') AS resources FROM user_groups g ORDER BY g.name").all()).results : [];
            let siteTitle = "Cluster Gateway"; try { const r = await db.prepare("SELECT val FROM sys_config WHERE key='site_title'").first(); if(r && r.val) siteTitle = r.val; } catch(e){}
            let mySubToken = "";
            if (isAdmin) {
                try {
                    const r = await db.prepare("SELECT val FROM sys_config WHERE key='admin_sub_token'").first();
                    if (r && r.val) mySubToken = r.val;
                    else { mySubToken = crypto.randomUUID(); await db.prepare("INSERT OR REPLACE INTO sys_config (key, val, ts) VALUES ('admin_sub_token', ?, ?)").bind(mySubToken, Date.now()).run(); }
                } catch(e){}
            }
            else { const u = await db.prepare("SELECT sub_token FROM users WHERE username = ?").bind(currentUser).first(); if(u && u.sub_token) mySubToken = u.sub_token; }
            const realtime = await db.prepare("SELECT val FROM sys_config WHERE key = 'realtime_url'").first();
            const publicListenerCount = isAdmin ? servers.filter(server => server.proxy_public_listener).length : 0;
            const securityWarnings = isAdmin ? [
                !env.ADMIN_PASSWORD ? '尚未配置 ADMIN_PASSWORD Secret。' : (env.ADMIN_PASSWORD === 'admin' ? '管理员仍在使用默认密码，请立即在 Cloudflare 中轮换 ADMIN_PASSWORD。' : ''),
                !env.PROXY_USER || !env.PROXY_PASS ? '尚未完整配置住宅代理 PROXY_USER / PROXY_PASS Secret。' : (env.PROXY_USER === 'kui' && env.PROXY_PASS === 'kui' ? '住宅代理仍在使用默认凭据，请立即轮换 PROXY_USER / PROXY_PASS。' : ''),
                publicListenerCount ? `${publicListenerCount} 台 VPS 的住宅 SOCKS 服务已开放公网监听，请确认防火墙、安全组和代理凭据足够安全。` : '',
            ].filter(Boolean) : [];
            return Response.json({ servers, nodes, users, groups, siteTitle, mySubToken, securityWarnings, proxyCredentialsReady: !!(env.PROXY_USER && env.PROXY_PASS), proxyPublicListenerManageable: !env.PROXY_CTRL_URL, realtimeUrl: env.REALTIME_URL || realtime && realtime.val || '' });
        }
        
        if (action === "settings" && method === "POST" && isAdmin) {
            const { site_title, realtime_url } = await request.json();
            const statements = [];
            if (typeof site_title === 'string' && site_title.trim().length > 100) return Response.json({ error: 'site_title must not exceed 100 characters' }, { status: 400 });
            if (typeof site_title === 'string' && site_title.trim()) statements.push(db.prepare("INSERT OR REPLACE INTO sys_config (key, val, ts) VALUES ('site_title', ?, ?)").bind(site_title.trim(), Date.now()));
            if (typeof realtime_url === 'string') {
                const normalized = realtime_url.trim().replace(/\/$/, '');
                if (normalized && !/^https:\/\//i.test(normalized)) return Response.json({ error: 'realtime_url must use https' }, { status: 400 });
                statements.push(db.prepare("INSERT OR REPLACE INTO sys_config (key, val, ts) VALUES ('realtime_url', ?, ?)").bind(normalized, Date.now()));
            }
            if (!statements.length) return Response.json({ error: 'No supported settings supplied' }, { status: 400 });
            await db.batch(statements);
            return Response.json({ success: true });
        }
        if (action === "user" && params.path[1] === "password" && method === "PUT") { const { password } = await readJsonBody(request, 8 * 1024); if (isAdmin) return Response.json({error: "管理员密码受绝对安全保护，仅可通过 Cloudflare Pages 环境变量修改！"}, {status: 400}); if (String(password || '').length < 12) return Response.json({ error: 'Password must be at least 12 characters' }, { status: 400 }); await db.batch([db.prepare("UPDATE users SET password = ? WHERE username = ?").bind(await passwordHash(password), currentUser), db.prepare("DELETE FROM auth_sessions WHERE username = ?").bind(currentUser)]); return Response.json({ success: true }); }
        if (action === "user" && params.path[1] === "sub_token" && method === "PUT") { const newToken = crypto.randomUUID(); if (isAdmin) await db.prepare("INSERT OR REPLACE INTO sys_config (key, val, ts) VALUES ('admin_sub_token', ?, ?)").bind(newToken, Date.now()).run(); else await db.prepare("UPDATE users SET sub_token = ? WHERE username = ?").bind(newToken, currentUser).run(); return Response.json({ success: true, token: newToken }); }
        if (action === "stats" && method === "GET" && isAdmin) {
            const url = new URL(request.url);
            const requestedIp = url.searchParams.get("ip");
            const cacheKey = requestedIp || '*';
            const cached = statsResponseCache.get(cacheKey);
            if (cached && Date.now() - cached.createdAt < STATS_CACHE_MS) return Response.json(cached.data);
            const nowMs = Date.now();
            const shanghaiNow = new Date(nowMs + 8 * 60 * 60 * 1000);
            const shanghaiTodayStart = Date.UTC(shanghaiNow.getUTCFullYear(), shanghaiNow.getUTCMonth(), shanghaiNow.getUTCDate()) - 8 * 60 * 60 * 1000;
            const cutoff = shanghaiTodayStart - 6 * 24 * 60 * 60 * 1000;
            if (requestedIp) {
                if (!validIp(requestedIp)) return Response.json({ error: 'Invalid VPS IP' }, { status: 400 });
                const cutoffDay = new Date(cutoff + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
                const { results } = await db.prepare("SELECT day, total_bytes FROM traffic_daily WHERE ip = ? AND day >= ? ORDER BY day ASC").bind(requestedIp, cutoffDay).all();
                const data = buildSevenDayTrafficSeries(results);
                statsResponseCache.set(cacheKey, { createdAt: Date.now(), data });
                return Response.json(data);
            }
            const [totalsResult, dailyResult] = await db.batch([
                db.prepare('SELECT s.ip, COALESCE(d.total_bytes, 0) AS total_bytes FROM servers s LEFT JOIN (SELECT ip, SUM(total_bytes) AS total_bytes FROM traffic_daily GROUP BY ip) d ON d.ip = s.ip'),
                db.prepare("SELECT ip, day, total_bytes FROM traffic_daily WHERE day >= ? ORDER BY day ASC").bind(new Date(cutoff + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)),
            ]);
            const dailyByIp = new Map();
            for (const row of dailyResult.results || []) {
                if (!dailyByIp.has(row.ip)) dailyByIp.set(row.ip, []);
                dailyByIp.get(row.ip).push(row);
            }
            const ips = new Set((totalsResult.results || []).map(row => row.ip));
            const data = {
                totals: Object.fromEntries((totalsResult.results || []).map(row => [row.ip, Math.max(0, Number(row.total_bytes) || 0)])),
                series: Object.fromEntries([...ips].map(ip => [ip, buildSevenDayTrafficSeries(dailyByIp.get(ip) || [])])),
            };
            statsResponseCache.set(cacheKey, { createdAt: Date.now(), data });
            return Response.json(data);
        }
        
        if (action === "users" && isAdmin) {
            if (method === "POST") { const { username, password, traffic_limit, expire_time } = await readJsonBody(request, 16 * 1024); const safeUser = String(username || '').trim(); if (!/^[A-Za-z0-9_.-]{1,64}$/.test(safeUser) || safeUser === (env.ADMIN_USERNAME || 'admin')) return Response.json({ error: 'Invalid or reserved username' }, { status: 400 }); if (String(password || '').length < 12) return Response.json({ error: 'Password must be at least 12 characters' }, { status: 400 }); if (await db.prepare("SELECT username FROM users WHERE username = ?").bind(safeUser).first()) return Response.json({ error: "User already exists" }, { status: 409 }); const hash = await passwordHash(password); const subToken = crypto.randomUUID(); await db.prepare("INSERT INTO users (username, password, traffic_limit, expire_time, sub_token) VALUES (?, ?, ?, ?, ?)").bind(safeUser, hash, Math.max(0, Number(traffic_limit)||0), Math.max(0, Number(expire_time)||0), subToken).run(); return Response.json({ success: true }); }
            if (method === "PUT") { const { username, enable, reset_traffic } = await request.json(); const statements = []; if (reset_traffic) statements.push(db.prepare("UPDATE users SET traffic_used = 0 WHERE username = ?").bind(username)); if (enable !== undefined) statements.push(db.prepare("UPDATE users SET enable = ? WHERE username = ?").bind(enable, username)); if (statements.length) await db.batch(statements); return Response.json({ success: true }); }
            if (method === "DELETE") { const target = new URL(request.url).searchParams.get("username"); await db.batch([db.prepare("DELETE FROM user_group_members WHERE username = ?").bind(target), db.prepare("DELETE FROM users WHERE username = ?").bind(target), db.prepare("UPDATE nodes SET username = ? WHERE username = ?").bind(currentUser, target)]); return Response.json({ success: true }); }
        }

        if (action === "groups" && isAdmin) {
            if (method === "POST") {
                const data = await readJsonBody(request, 32 * 1024);
                const name = String(data.name || '').trim();
                if (!name || name.length > 64) return Response.json({ error: 'Group name must be 1-64 characters' }, { status: 400 });
                if (await db.prepare("SELECT id FROM user_groups WHERE name = ?").bind(name).first()) return Response.json({ error: 'Group already exists' }, { status: 409 });
                await db.prepare("INSERT INTO user_groups (id, name, created_at) VALUES (?, ?, ?)").bind(crypto.randomUUID(), name, Date.now()).run();
                return Response.json({ success: true });
            }
            if (method === "PUT") {
                const data = await readJsonBody(request, 64 * 1024);
                const groupId = String(data.id || '');
                const group = await db.prepare("SELECT id FROM user_groups WHERE id = ?").bind(groupId).first();
                if (!group) return Response.json({ error: 'Group not found' }, { status: 404 });
                const members = Array.isArray(data.members) ? [...new Set(data.members.map(value => String(value)))].slice(0, 200) : null;
                const resources = Array.isArray(data.resources) ? data.resources.slice(0, 300) : null;
                const statements = [];
                if (members) {
                    for (const username of members) if (!await db.prepare("SELECT username FROM users WHERE username = ?").bind(username).first()) return Response.json({ error: `User not found: ${username}` }, { status: 400 });
                    statements.push(db.prepare("DELETE FROM user_group_members WHERE group_id = ?").bind(groupId));
                    statements.push(...members.map(username => db.prepare("INSERT INTO user_group_members (group_id, username) VALUES (?, ?)").bind(groupId, username)));
                }
                if (resources) {
                    const normalized = [];
                    for (const item of resources) {
                        const type = item?.type === 'vps' ? 'vps' : item?.type === 'node' ? 'node' : '';
                        const id = String(item?.id || '');
                        if (!type || !id) return Response.json({ error: 'Invalid group resource' }, { status: 400 });
                        const exists = type === 'vps' ? await db.prepare("SELECT ip FROM servers WHERE ip = ?").bind(id).first() : await db.prepare("SELECT id FROM nodes WHERE id = ?").bind(id).first();
                        if (!exists) return Response.json({ error: `${type} resource not found` }, { status: 400 });
                        if (!normalized.some(resource => resource.type === type && resource.id === id)) normalized.push({ type, id });
                    }
                    statements.push(db.prepare("DELETE FROM user_group_resources WHERE group_id = ?").bind(groupId));
                    statements.push(...normalized.map(resource => db.prepare("INSERT INTO user_group_resources (group_id, resource_type, resource_id) VALUES (?, ?, ?)").bind(groupId, resource.type, resource.id)));
                }
                if (!statements.length) return Response.json({ error: 'No group changes supplied' }, { status: 400 });
                await db.batch(statements);
                return Response.json({ success: true });
            }
            if (method === "DELETE") { const id = new URL(request.url).searchParams.get("id"); await db.batch([db.prepare("DELETE FROM user_group_members WHERE group_id = ?").bind(id), db.prepare("DELETE FROM user_group_resources WHERE group_id = ?").bind(id), db.prepare("DELETE FROM user_groups WHERE id = ?").bind(id)]); return Response.json({ success: true }); }
        }
        
        if (action === "vps" && isAdmin) {
            await ensureDbSchema(db);
            if (params.path[1] === "warp-optimize" && method === "POST") {
                let command;
                try { command = normalizeWarpOptimizeRequest(await readJsonBody(request, 4 * 1024)); }
                catch (error) { return Response.json({ error: error.message || 'Invalid WARP optimizer request' }, { status: 400 }); }
                if (!(await db.prepare('SELECT ip FROM servers WHERE ip = ?').bind(command.ip).first())) return Response.json({ error: 'VPS not found' }, { status: 404 });
                const requestId = crypto.randomUUID();
                try {
                    const { status, result } = await requestRealtimeWarpOptimize(env, db, command, requestId, new URL(request.url).origin);
                    return Response.json(result, { status });
                } catch (error) {
                    return Response.json({ error: error.message || 'WARP 优化指令发送失败' }, { status: 503 });
                }
            }
            if (params.path[1] === "egress-refresh" && method === "POST") {
                const data = await readJsonBody(request, 4 * 1024);
                const ip = String(data.ip || '');
                const requestId = /^[0-9a-f-]{36}$/i.test(String(data.request_id || '')) ? String(data.request_id) : crypto.randomUUID();
                if (!ip || !(await db.prepare('SELECT ip FROM servers WHERE ip = ?').bind(ip).first())) return Response.json({ error: 'VPS not found' }, { status: 404 });
                try {
                    const { status, result } = await requestRealtimeEgressRefresh(env, db, ip, requestId, new URL(request.url).origin);
                    return Response.json(result, { status });
                } catch (error) {
                    return Response.json({ error: error.message || '出口检测指令发送失败' }, { status: 503 });
                }
            }
            if (method === "POST") { const { ip, name } = await request.json(); if (!validIp(ip)) return Response.json({ error: 'Invalid VPS IP' }, { status: 400 }); const agentToken = crypto.randomUUID(); const inserted = await db.prepare("INSERT INTO servers (ip, name, alert_sent, agent_token) SELECT ?, ?, 0, ? WHERE (SELECT COUNT(*) FROM servers) < 100 ON CONFLICT(ip) DO NOTHING RETURNING ip").bind(ip, String(name || ip).slice(0, 100), agentToken).first(); if (!inserted) { if (await db.prepare('SELECT ip FROM servers WHERE ip = ?').bind(ip).first()) return Response.json({ error: 'VPS already exists' }, { status: 409 }); return Response.json({ error: "当前版本最多管理 100 台 VPS" }, { status: 409 }); } return Response.json({ success: true }); }
            if (method === "PUT") {
                const data = await readJsonBody(request, 40 * 1024);
                const ip = String(data.ip || '');
                if (!ip) return Response.json({ error: 'IP required' }, { status: 400 });
                if (data.egress_mode === undefined) return Response.json({ error: 'Use egress_mode to configure node egress' }, { status: 400 });
                if (data.egress_mode === 'residential' && env.PROXY_CTRL_URL) return Response.json({ error: '外部住宅控制器模式不支持本机住宅节点出口' }, { status: 409 });
                if (data.egress_mode === 'residential' && (!env.PROXY_USER || !env.PROXY_PASS)) return Response.json({ error: 'Pages 未配置住宅代理凭据' }, { status: 503 });
                const current = await db.prepare('SELECT socks5_pass, proxy_custom_domains FROM servers WHERE ip = ?').bind(ip).first();
                if (!current) return Response.json({ error: 'VPS not found' }, { status: 404 });
                try { current.proxy_custom_domains = JSON.parse(current.proxy_custom_domains || '[]'); } catch { current.proxy_custom_domains = []; }
                let normalized;
                try { normalized = normalizeEgressRequest(data, current); }
                catch (error) { return Response.json({ error: error.message || 'Invalid egress configuration' }, { status: 400 }); }
                const { mode, proxyMode, proxyCategories, proxyCustomDomains, socks5, desiredConfig } = normalized;
                const customDomainsJson = JSON.stringify(proxyCustomDomains);
                let changed;
                if (socks5) {
                    changed = await db.prepare("UPDATE servers SET egress_mode = ?, egress_revision = egress_revision + 1, egress_status = 'pending', egress_error = '', egress_desired_config = ?, proxy_mode = ?, proxy_categories = ?, proxy_custom_domains = ?, socks5_addr = ?, socks5_port = ?, socks5_user = ?, socks5_pass = ? WHERE ip = ? RETURNING egress_revision").bind(mode, JSON.stringify(desiredConfig), proxyMode, proxyCategories, customDomainsJson, socks5.addr, socks5.port, socks5.user, socks5.pass, ip).first();
                } else {
                    changed = await db.prepare("UPDATE servers SET egress_mode = ?, egress_revision = egress_revision + 1, egress_status = 'pending', egress_error = '', egress_desired_config = ?, proxy_mode = ?, proxy_categories = ?, proxy_custom_domains = ? WHERE ip = ? RETURNING egress_revision").bind(mode, JSON.stringify(desiredConfig), proxyMode, proxyCategories, customDomainsJson, ip).first();
                }
                context.waitUntil(notifyRealtimeVps(env, db, ip).catch(() => {}));
                return Response.json({ success: true, ip, egress_mode: mode, egress_revision: Number(changed.egress_revision), egress_status: 'pending', proxy_mode: proxyMode, proxy_categories: proxyCategories, proxy_custom_domains: proxyCustomDomains, socks5_addr: socks5?.addr || '', socks5_port: socks5?.port || 0, socks5_user: socks5?.user || '', socks5_password_set: !!socks5?.pass });
            }
            if (method === "DELETE") { 
                const ip = new URL(request.url).searchParams.get("ip"); 
                await deleteVpsRecords(db, ip);
                return Response.json({ success: true }); 
            }
        }

        if (action === "nodes" && isAdmin) {
            if (method === "POST") {
                let n;
                try { n = normalizeNodePayload(await readJsonBody(request, 16 * 1024)); }
                catch (error) { return Response.json({ error: error.message || 'Invalid node configuration' }, { status: 400 }); }
                if (!(await db.prepare('SELECT ip FROM servers WHERE ip = ?').bind(n.vps_ip).first())) return Response.json({ error: 'VPS not found' }, { status: 404 });
                if (await db.prepare('SELECT id FROM nodes WHERE id = ?').bind(n.id).first()) return Response.json({ error: 'Node already exists' }, { status: 409 });
                const { results: listeners } = await db.prepare('SELECT id, protocol, port, network FROM nodes WHERE vps_ip = ? AND port = ? AND enable = 1').bind(n.vps_ip, n.port).all();
                if (nodeListenerConflicts(listeners, n)) return Response.json({ error: `${nodeTransports(n).join('/').toUpperCase()} port ${n.port} is already in use on this VPS` }, { status: 409 });
                let nodeUser = normalizeNodeText(n.username || currentUser, 'username', 64);
                if (nodeUser === 'admin') nodeUser = currentUser;
                if (n.expire_time && n.expire_time <= Date.now()) return Response.json({ error: 'Node expiry must be in the future' }, { status: 400 });
                if (nodeUser !== currentUser && !(await db.prepare('SELECT username FROM users WHERE username = ? AND enable = 1 AND (traffic_limit = 0 OR traffic_used < traffic_limit) AND (expire_time = 0 OR expire_time > ?)').bind(nodeUser, Date.now()).first())) return Response.json({ error: 'Node user is unavailable' }, { status: 400 });
                if (n.protocol === 'dokodemo-door' && n.relay_type === 'internal') {
                    const target = await db.prepare('SELECT id, protocol, enable FROM nodes WHERE id = ? AND vps_ip = ?').bind(n.target_id, n.vps_ip).first();
                    if (!target || target.enable !== 1 || !INTERNAL_RELAY_PROTOCOLS.has(target.protocol)) return Response.json({ error: 'Internal relay target is unavailable or unsupported' }, { status: 400 });
                }
                await db.prepare(`INSERT INTO nodes (id, uuid, vps_ip, protocol, port, sni, private_key, public_key, short_id, relay_type, target_ip, target_port, target_id, enable, traffic_used, traffic_limit, expire_time, username, network) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(n.id, n.uuid || '', n.vps_ip, n.protocol, n.port, n.sni || null, n.private_key || null, n.public_key || null, n.short_id || null, n.relay_type || null, n.target_ip || null, n.target_port || null, n.target_id || null, 1, 0, n.traffic_limit, n.expire_time, nodeUser, n.network).run();
                context.waitUntil(notifyRealtimeVps(env, db, n.vps_ip).catch(() => {}));
                return Response.json({ success: true });
            }
            if (method === "PUT") {
                const body = await readJsonBody(request, 16 * 1024);
                const { id, enable, reset_traffic } = body;
                const node = await db.prepare('SELECT id, vps_ip, protocol, port, network, relay_type, target_id FROM nodes WHERE id = ?').bind(id).first();
                if (!node) return Response.json({ error: 'Node not found' }, { status: 404 });
                if (body.protocol !== undefined) {
                    let updated;
                    try { updated = normalizeNodePayload({ ...body, id: node.id, vps_ip: node.vps_ip }); }
                    catch (error) { return Response.json({ error: error.message || 'Invalid node configuration' }, { status: 400 }); }
                    const existing = await db.prepare('SELECT enable FROM nodes WHERE id = ?').bind(id).first();
                    if (existing.enable === 1) {
                        const { results: listeners } = await db.prepare('SELECT id, protocol, port, network FROM nodes WHERE vps_ip = ? AND port = ? AND enable = 1').bind(node.vps_ip, updated.port).all();
                        if (nodeListenerConflicts(listeners, updated)) return Response.json({ error: `${nodeTransports(updated).join('/').toUpperCase()} port ${updated.port} is already in use on this VPS` }, { status: 409 });
                    }
                    let nodeUser = normalizeNodeText(updated.username || currentUser, 'username', 64);
                    if (nodeUser === 'admin') nodeUser = currentUser;
                    if (updated.expire_time && updated.expire_time <= Date.now()) return Response.json({ error: 'Node expiry must be in the future' }, { status: 400 });
                    if (nodeUser !== currentUser && !(await db.prepare('SELECT username FROM users WHERE username = ? AND enable = 1 AND (traffic_limit = 0 OR traffic_used < traffic_limit) AND (expire_time = 0 OR expire_time > ?)').bind(nodeUser, Date.now()).first())) return Response.json({ error: 'Node user is unavailable' }, { status: 400 });
                    const referenced = await db.prepare("SELECT id FROM nodes WHERE protocol = 'dokodemo-door' AND relay_type = 'internal' AND target_id = ? AND id != ?").bind(id, id).first();
                    if (referenced && !INTERNAL_RELAY_PROTOCOLS.has(updated.protocol)) return Response.json({ error: 'Node is used by an internal relay and must keep a supported target protocol' }, { status: 409 });
                    if (updated.protocol === 'dokodemo-door' && updated.relay_type === 'internal') {
                        if (updated.target_id === id) return Response.json({ error: 'Internal relay cannot target itself' }, { status: 400 });
                        const target = await db.prepare('SELECT protocol, enable FROM nodes WHERE id = ? AND vps_ip = ?').bind(updated.target_id, node.vps_ip).first();
                        if (!target || target.enable !== 1 || !INTERNAL_RELAY_PROTOCOLS.has(target.protocol)) return Response.json({ error: 'Internal relay target is unavailable or unsupported' }, { status: 400 });
                    }
                    await db.prepare(`UPDATE nodes SET uuid = ?, protocol = ?, port = ?, sni = ?, private_key = ?, public_key = ?, short_id = ?, relay_type = ?, target_ip = ?, target_port = ?, target_id = ?, traffic_limit = ?, expire_time = ?, username = ?, network = ? WHERE id = ?`).bind(updated.uuid || '', updated.protocol, updated.port, updated.sni || null, updated.private_key || null, updated.public_key || null, updated.short_id || null, updated.relay_type || null, updated.target_ip || null, updated.target_port || null, updated.target_id || null, updated.traffic_limit, updated.expire_time, nodeUser, updated.network, id).run();
                    context.waitUntil(notifyRealtimeVps(env, db, node.vps_ip).catch(() => {}));
                    return Response.json({ success: true });
                }
                if (enable === false && await db.prepare("SELECT id FROM nodes WHERE protocol = 'dokodemo-door' AND relay_type = 'internal' AND target_id = ? AND enable = 1").bind(id).first()) return Response.json({ error: 'Node is used by an enabled internal relay' }, { status: 409 });
                if (enable === true) {
                    const { results: listeners } = await db.prepare('SELECT id, protocol, port, network FROM nodes WHERE vps_ip = ? AND port = ? AND enable = 1').bind(node.vps_ip, node.port).all();
                    if (nodeListenerConflicts(listeners, node)) return Response.json({ error: `${nodeTransports(node).join('/').toUpperCase()} port ${node.port} is already in use on this VPS` }, { status: 409 });
                    if (node.protocol === 'dokodemo-door' && node.relay_type === 'internal') {
                        const target = await db.prepare('SELECT protocol, enable FROM nodes WHERE id = ? AND vps_ip = ?').bind(node.target_id, node.vps_ip).first();
                        if (!target || target.enable !== 1 || !INTERNAL_RELAY_PROTOCOLS.has(target.protocol)) return Response.json({ error: 'Internal relay target is unavailable or unsupported' }, { status: 409 });
                    }
                }
                const statements = [];
                if (reset_traffic) statements.push(db.prepare('UPDATE nodes SET traffic_used = 0 WHERE id = ?').bind(id));
                if (enable !== undefined) statements.push(db.prepare('UPDATE nodes SET enable = ? WHERE id = ?').bind(enable ? 1 : 0, id));
                if (statements.length) await db.batch(statements);
                context.waitUntil(notifyRealtimeVps(env, db, node.vps_ip).catch(() => {}));
                return Response.json({ success: true });
            }
            if (method === "DELETE") {
                const id = new URL(request.url).searchParams.get('id');
                const node = await db.prepare('SELECT vps_ip FROM nodes WHERE id = ?').bind(id).first();
                if (!node) return Response.json({ error: 'Node not found' }, { status: 404 });
                if (await db.prepare("SELECT id FROM nodes WHERE protocol = 'dokodemo-door' AND relay_type = 'internal' AND target_id = ?").bind(id).first()) return Response.json({ error: 'Node is used by an internal relay; delete the relay first' }, { status: 409 });
                await db.batch([db.prepare("DELETE FROM user_group_resources WHERE resource_type = 'node' AND resource_id = ?").bind(id), db.prepare('DELETE FROM nodes WHERE id = ?').bind(id)]);
                context.waitUntil(notifyRealtimeVps(env, db, node.vps_ip).catch(() => {}));
                return Response.json({ success: true });
            }
        }

    if (action === "thirdparty" && isAdmin) {
            await ensureDbSchema(db);
            if (method === "POST") {
                const { name, url } = await readJsonBody(request, 16 * 1024);
                if (!url) return Response.json({ error: "请填写订阅链接" }, { status: 400 });
                let subscriptionUrl;
                try { subscriptionUrl = validateSubscriptionUrl(url); } catch (error) { return Response.json({ error: error.message || "订阅链接格式无效" }, { status: 400 }); }
                const id = crypto.randomUUID();
                const now = Date.now();
                let parsedCount = 0; let parseDebug = {};
                try {
                    const res = await fetchPublicSubscription(subscriptionUrl.toString());
                    const text = await readBoundedText(res);
                    const result = await parseThirdPartySubscription(text);
                    const { nodes, protocolCounts, debug } = result;
                    parseDebug = { protocolCounts, debug };
                    await db.prepare("INSERT INTO third_party_subscriptions (id, name, url, added_at, last_fetched_at) VALUES (?, ?, ?, ?, ?)" ).bind(id, String(name || '第三方订阅').slice(0, 100), subscriptionUrl.toString(), now, now).run();
                    if (nodes.length > 0) {
                        const stmts = nodes.map(n => db.prepare("INSERT INTO third_party_nodes (id, subscription_id, name, protocol, address, port, uuid, password, sni, public_key, short_id, flow, network, host, path, extra, enable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(n.id, id, n.name, n.protocol, n.address, n.port, n.uuid || '', n.password || '', n.sni || '', n.public_key || '', n.short_id || '', n.flow || '', n.network || '', n.host || '', n.path || '', n.extra || '', 1, now));
                        await chunkBatch(db, stmts);
                        parsedCount = nodes.length;
                    }
                } catch (e) { console.error("解析第三方订阅失败:", e); return Response.json({ error: (e && e.message) || '订阅导入失败' }, { status: 400 }); }
                await db.prepare("UPDATE third_party_subscriptions SET last_fetched_at = ? WHERE id = ?").bind(Date.now(), id).run();
                return Response.json({ success: true, id, parsedCount, debug: parseDebug });
            }
            if (method === "GET") {
                const { results } = await db.prepare("SELECT s.*, COUNT(n.id) as node_count FROM third_party_subscriptions s LEFT JOIN third_party_nodes n ON s.id = n.subscription_id GROUP BY s.id ORDER BY s.added_at DESC").all();
                return Response.json(results || []);
            }
            if (method === "PUT") {
                const { id, enable } = await request.json();
                if (id) await db.prepare("UPDATE third_party_subscriptions SET is_enable = ? WHERE id = ?").bind(enable ? 1 : 0, id).run();
                if (id) await db.prepare("UPDATE third_party_nodes SET enable = ? WHERE subscription_id = ?").bind(enable ? 1 : 0, id).run();
                return Response.json({ success: true });
            }
            if (method === "DELETE") {
                const subId = new URL(request.url).searchParams.get("id");
                if (!subId) return Response.json({ error: "缺少订阅ID" }, { status: 400 });
                await db.prepare("DELETE FROM third_party_subscriptions WHERE id = ?").bind(subId).run();
                await db.prepare("DELETE FROM third_party_nodes WHERE subscription_id = ?").bind(subId).run();
                return Response.json({ success: true });
            }
        }

        return new Response("Not Found", { status: 404 });
    } catch (err) {
        const msg = (err && err.message) ? err.message : String(err);
        // 兜底捕获，杜绝未处理异常导致的 Cloudflare 1101
        return new Response(JSON.stringify({ error: "SERVER_ERR: " + msg }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
}

export async function onRequestScheduled(context) {
    try { await checkOfflineServers(context.env); } catch (error) { console.error('[cron] offline check failed:', error); throw error; }
}

export const __test = {
    buildNodeSubscriptionUri,
    buildSevenDayTrafficSeries,
    buildSurgeProxyLine,
    validateSs2022Credentials,
    validateMtproxySecret,
    sanitizeProxyListenHost,
    validateProxyReport,
    validateTrafficReport,
    proxyPublicListenerEnabled,
    normalizeEgressRequest,
    normalizeProxyCustomDomains,
    normalizeWarpOptimizeRequest,
    requestRealtimeEgressRefresh,
    requestRealtimeWarpOptimize,
    normalizeNodePayload,
    nodeListenerConflicts,
    notifyRealtimeVps,
    normalizePingTarget,
};
