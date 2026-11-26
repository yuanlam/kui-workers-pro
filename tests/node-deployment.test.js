import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { __test } from '../functions/api/[[path]].js';

const frontend = fs.readFileSync(new URL('../frontend/src/composables/useKuiState.js', import.meta.url), 'utf8');
const serversPage = fs.readFileSync(new URL('../frontend/src/pages/ServersPage.vue', import.meta.url), 'utf8');
const appStyles = fs.readFileSync(new URL('../frontend/src/styles/app.css', import.meta.url), 'utf8');
const agent = fs.readFileSync(new URL('../static/vps/agent.py', import.meta.url), 'utf8');
const routing = fs.readFileSync(new URL('../static/vps/routing_engine.py', import.meta.url), 'utf8');
const installer = fs.readFileSync(new URL('../static/vps/kui.sh', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');

const UUID = '11111111-1111-4111-8111-111111111111';
const REALITY_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const MTPROXY_DOMAIN = 'proxy.example.com';
const MTPROXY_SECRET = `ee${'11'.repeat(16)}${Buffer.from(MTPROXY_DOMAIN).toString('hex')}`;

function baseNode(protocol, overrides = {}) {
    return { id: 'node_1', vps_ip: '203.0.113.8', protocol, port: 443, uuid: UUID, ...overrides };
}

test('single-node payloads normalize fields needed by sing-box', () => {
    const { normalizeNodePayload } = __test;
    const reality = normalizeNodePayload(baseNode('XTLS-Reality', {
        sni: '', private_key: REALITY_KEY, public_key: REALITY_KEY, short_id: 'aabbccdd',
    }));
    assert.equal(reality.sni, 'addons.mozilla.org');
    assert.equal(reality.network, 'tcp');
    assert.equal(normalizeNodePayload(baseNode('H2-Reality', { private_key: REALITY_KEY, public_key: REALITY_KEY, short_id: 'aabbccdd' })).network, 'http');
    assert.equal(normalizeNodePayload(baseNode('gRPC-Reality', { private_key: REALITY_KEY, public_key: REALITY_KEY, short_id: 'aabbccdd' })).network, 'grpc');
    const ssKey = Buffer.alloc(32, 7).toString('base64');
    assert.equal(normalizeNodePayload(baseNode('Shadowsocks2022', { uuid: '2022-blake3-aes-256-gcm', private_key: ssKey, network: 'tcp,udp' })).network, 'tcp,udp');
    assert.equal(normalizeNodePayload(baseNode('Shadowsocks2022', { uuid: '2022-blake3-aes-256-gcm', private_key: ssKey })).network, 'tcp,udp');
    assert.equal(normalizeNodePayload(baseNode('Trojan', { uuid: 'credential', private_key: 'secret' })).sni, 'addons.mozilla.org');
    assert.equal(normalizeNodePayload(baseNode('TUIC', { private_key: 'secret', sni: 'legacy.example.com' })).sni, '');
    assert.equal(normalizeNodePayload(baseNode('MTProxy', { private_key: MTPROXY_SECRET, sni: MTPROXY_DOMAIN })).private_key, MTPROXY_SECRET);
    assert.equal(normalizeNodePayload(baseNode('dokodemo-door', { uuid: '', relay_type: 'external', target_ip: 'relay.example.com', target_port: 8443 })).target_ip, 'relay.example.com');
});

test('every protocol offered by the single-node form reaches a valid normalized payload', () => {
    const { normalizeNodePayload } = __test;
    const ssKey = Buffer.alloc(32, 7).toString('base64');
    const cases = [
        baseNode('VLESS'),
        baseNode('XTLS-Reality', { private_key: REALITY_KEY, public_key: REALITY_KEY, short_id: 'aabbccdd' }),
        baseNode('Hysteria2', { uuid: 'custom-hysteria-password' }),
        baseNode('TUIC', { private_key: 'custom-tuic-password' }),
        baseNode('Shadowsocks2022', { uuid: '2022-blake3-aes-256-gcm', private_key: ssKey }),
        baseNode('Trojan', { uuid: 'metadata', private_key: 'custom-trojan-password' }),
        baseNode('H2-Reality', { private_key: REALITY_KEY, public_key: REALITY_KEY, short_id: 'aabbccdd' }),
        baseNode('gRPC-Reality', { private_key: REALITY_KEY, public_key: REALITY_KEY, short_id: 'aabbccdd' }),
        baseNode('AnyTLS', { uuid: 'metadata', private_key: 'custom-anytls-password' }),
        baseNode('Naive', { uuid: 'custom-user', private_key: 'custom-naive-password' }),
        baseNode('Socks5', { uuid: 'custom-user', private_key: 'custom-socks-password' }),
        baseNode('VLESS-Argo'),
        baseNode('dokodemo-door', { uuid: '', relay_type: 'external', target_ip: 'relay.example.com', target_port: 8443 }),
        baseNode('MTProxy', { private_key: MTPROXY_SECRET, sni: MTPROXY_DOMAIN }),
    ];
    for (const payload of cases) assert.equal(normalizeNodePayload(payload).protocol, payload.protocol);
});

test('invalid credentials and incomplete relay records are rejected before storage', () => {
    const { normalizeNodePayload } = __test;
    assert.throws(() => normalizeNodePayload(baseNode('XTLS-Reality', { private_key: '', public_key: REALITY_KEY, short_id: 'aabbccdd' })), /private key/i);
    assert.throws(() => normalizeNodePayload(baseNode('TUIC', { uuid: 'not-a-uuid', private_key: 'secret' })), /UUID/i);
    assert.throws(() => normalizeNodePayload(baseNode('Socks5', { uuid: 'user', private_key: '' })), /password/i);
    assert.throws(() => normalizeNodePayload(baseNode('dokodemo-door', { uuid: '', relay_type: 'internal', target_id: '' })), /target ID/i);
    assert.throws(() => normalizeNodePayload(baseNode('Trojan', { uuid: 'credential', private_key: 'secret', traffic_limit: -1 })), /traffic limit/i);
    assert.throws(() => normalizeNodePayload(baseNode('Shadowsocks2022', { uuid: '2022-blake3-aes-256-gcm', private_key: Buffer.alloc(32).toString('base64'), network: 'icmp' })), /network/i);
    assert.throws(() => normalizeNodePayload(baseNode('MTProxy', { private_key: MTPROXY_SECRET, sni: 'other.example.com' })), /MTProxy.*secret/i);
    assert.throws(() => normalizeNodePayload(baseNode('MTProxy', { private_key: 'ee1234', sni: MTPROXY_DOMAIN })), /MTProxy.*secret/i);
});

test('listener conflicts are scoped by VPS transport', () => {
    const { nodeListenerConflicts } = __test;
    const existing = [{ id: 'old', protocol: 'Trojan', port: 443 }];
    assert.equal(nodeListenerConflicts(existing, { id: 'new', protocol: 'XTLS-Reality', port: 443 }), true);
    assert.equal(nodeListenerConflicts(existing, { id: 'new', protocol: 'Hysteria2', port: 443 }), false);
    assert.equal(nodeListenerConflicts(existing, { id: 'old', protocol: 'Trojan', port: 443 }), false);
    assert.equal(nodeListenerConflicts(existing, { id: 'ss', protocol: 'Shadowsocks2022', port: 443, network: 'tcp,udp' }), true);
    assert.equal(nodeListenerConflicts([{ id: 'hy2', protocol: 'Hysteria2', port: 8443 }], { id: 'ss', protocol: 'Shadowsocks2022', port: 8443, network: 'tcp' }), false);
    assert.equal(nodeListenerConflicts([{ id: 'hy2', protocol: 'Hysteria2', port: 8443 }], { id: 'ss', protocol: 'Shadowsocks2022', port: 8443, network: 'tcp,udp' }), true);
});

test('the UI only offers enabled internal relay targets on the same VPS', () => {
    assert.match(serversPage, /n\.vps_ip === vps\.ip && n\.enable/);
    assert.match(serversPage, /选择本 VPS 的目标节点/);
    assert.match(frontend, /startPort \+ 8 > 65535/);
    assert.match(frontend, /sni: 'addons\.mozilla\.org'/);
    assert.match(serversPage, /最近节点配置已在 VPS 生效/);
    assert.match(serversPage, /最近节点配置应用失败/);
});

test('node forms stay compact and mark required fields explicitly', () => {
    const requiredLabels = serversPage.match(/<b class="kui-required">\*<\/b>/g) || [];
    assert.ok(requiredLabels.length >= 10);
    assert.match(serversPage, /归属用户 <b class="kui-required">\*<\/b>/);
    assert.match(serversPage, /端口 <b class="kui-required">\*<\/b>/);
    assert.match(serversPage, /Reality 伪装域名 <em>留空使用默认<\/em>/);
    assert.match(serversPage, /目标节点 <b class="kui-required">\*<\/b>/);
    assert.match(serversPage, /class="kui-node-form-grid kui-node-form-primary"/);
    assert.match(appStyles, /min-height: 36px !important/);
    assert.match(appStyles, /--kui-control-height:\s*36px/);
    assert.doesNotMatch(appStyles, /min-height: 44px !important/);
});

test('single-node form exposes every credential used by supported protocols', () => {
    for (const protocol of ['VLESS', 'XTLS-Reality', 'Hysteria2', 'TUIC', 'Shadowsocks2022', 'Trojan', 'H2-Reality', 'gRPC-Reality', 'AnyTLS', 'Naive', 'Socks5', 'VLESS-Argo', 'dokodemo-door', 'MTProxy']) {
        assert.match(serversPage, new RegExp(`value="${protocol}"`));
    }
    for (const model of ['node_uuid', 'node_username', 'node_password', 'reality_private_key', 'reality_public_key', 'reality_short_id', 'ss_method', 'ss_password', 'ss_network']) {
        assert.match(serversPage, new RegExp(`newNodeParams\\[vps\\.ip\\]\\.${model}`));
    }
    assert.match(serversPage, /Reality 私钥/);
    assert.match(serversPage, /Reality 公钥/);
    assert.match(serversPage, /留空随机生成/);
    assert.match(serversPage, /公网域名由 VPS 建立 Argo 隧道后自动回传/);
});

test('single-node protocols are alphabetized before fixed special entries', () => {
    const formStart = serversPage.indexOf('v-model="newNodeParams[vps.ip].protocol"');
    const formEnd = serversPage.indexOf('</select>', formStart);
    const options = serversPage.slice(formStart, formEnd);
    const labels = ['AnyTLS', 'gRPC + Reality', 'H2 + Reality', 'Hysteria2', 'Naive', 'Shadowsocks 2022', 'SOCKS5', 'Trojan', 'TUIC v5', 'VLESS', 'XTLS + Reality', '──────────', 'VLESS Argo', 'Dokodemo', 'MTProxy'];
    let previous = -1;
    for (const label of labels) {
        const current = options.indexOf(`>${label}<`);
        assert.ok(current > previous, `${label} should follow the previous protocol`);
        previous = current;
    }
});

test('blank optional credentials receive protocol-safe random defaults', () => {
    const addNodeSource = frontend.slice(frontend.indexOf('const buildNodePayload'), frontend.indexOf('const deployAllProtocols'));
    assert.match(addNodeSource, /optionalText\(p\.node_uuid\) \|\| crypto\.randomUUID\(\)/);
    assert.match(addNodeSource, /optionalText\(p\.node_password\) \|\| randomSecret\(\)/);
    assert.match(addNodeSource, /optionalText\(p\.node_username\) \|\| `user_/);
    assert.match(addNodeSource, /optionalText\(p\.ss_password\) \|\| generateSs2022Password\(method\)/);
    assert.match(addNodeSource, /privateKey \? \{ privateKey, publicKey/);
    assert.match(addNodeSource, /: generateRealityKeys\(\)/);
    assert.match(addNodeSource, /replace\(\/\\\+\/g, '-'\).*replace\(\/\\\//s);
    assert.match(addNodeSource, /generateMtproxySecret\(payload\.sni\)/);
});

test('configured nodes expose an inline editor with full protocol fields', () => {
    assert.match(serversPage, /@click="startEditNode\(node\)">修改<\/button>/);
    assert.match(serversPage, /v-if="nodeEditDrafts\[node\.id\]" class="kui-node-edit-form"/);
    assert.match(serversPage, /@click="saveNodeEdit\(node\)">保存并应用<\/button>/);
    assert.match(serversPage, /@click="cancelEditNode\(node\.id\)">取消/);
    for (const field of ['protocol', 'port', 'username', 'node_uuid', 'node_username', 'node_password', 'reality_private_key', 'reality_public_key', 'reality_short_id', 'ss_method', 'ss_password', 'mtproxy_domain', 'mtproxy_secret', 'relay_type', 'target_ip', 'target_port', 'target_id', 'traffic_limit_gb', 'expire_date']) {
        assert.match(serversPage, new RegExp(`nodeEditDrafts\\[node\\.id\\]\\.${field}`));
    }
    assert.match(appStyles, /\.kui-node-edit-form/);
});

test('node edit drafts preserve existing credentials and save through the validated PUT route', () => {
    const editSource = frontend.slice(frontend.indexOf('const editDraftFromNode'), frontend.indexOf('const deployAllProtocols'));
    assert.match(editSource, /username: node\.username === currentUser\.value \? 'admin' : node\.username/);
    assert.match(editSource, /reality_private_key: \['XTLS-Reality', 'H2-Reality', 'gRPC-Reality'\]\.includes\(node\.protocol\) \? node\.private_key/);
    assert.match(editSource, /node_password: node\.protocol === 'Hysteria2' \? node\.uuid/);
    assert.match(editSource, /ss_password: node\.protocol === 'Shadowsocks2022' \? node\.private_key/);
    assert.match(editSource, /mtproxy_secret: node\.protocol === 'MTProxy' \? node\.private_key/);
    assert.match(editSource, /traffic_limit_gb: node\.traffic_limit > 0/);
    assert.match(editSource, /buildNodePayload\(node\.vps_ip, nodeEditDrafts\[node\.id\], node\.id\)/);
    assert.match(editSource, /method: 'PUT'/);
});

test('node update route normalizes the full payload and protects immutable identity and relay dependencies', () => {
    const api = fs.readFileSync(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');
    const putStart = api.indexOf('if (method === "PUT")', api.indexOf('if (action === "nodes"'));
    const putRoute = api.slice(putStart, api.indexOf('if (method === "DELETE")', putStart));
    assert.match(putRoute, /normalizeNodePayload\(\{ \.\.\.body, id: node\.id, vps_ip: node\.vps_ip \}\)/);
    assert.match(putRoute, /nodeListenerConflicts\(listeners, updated\)/);
    assert.match(putRoute, /Node is used by an internal relay and must keep a supported target protocol/);
    assert.match(putRoute, /Internal relay cannot target itself/);
    assert.match(putRoute, /UPDATE nodes SET uuid = \?, protocol = \?, port = \?/);
    assert.doesNotMatch(putRoute, /SET id =|SET vps_ip =/);
    assert.doesNotMatch(putRoute, /SELECT id, protocol, port FROM nodes/);
    assert.match(putRoute, /SELECT id, protocol, port, network FROM nodes/);
});

test('node creation is serialized and refreshes after the API succeeds', () => {
    const addSource = frontend.slice(frontend.indexOf('const addNode ='), frontend.indexOf('const editDraftFromNode'));
    assert.match(addSource, /addingNode\[ip\]/);
    assert.match(addSource, /crypto\.randomUUID\(\)/);
    assert.match(addSource, /await refreshData\(\)/);
    assert.match(serversPage, /:disabled="addingNode\[vps\.ip\]"/);
});

test('internal H2 and TUIC relay outbounds preserve transport options', () => {
    assert.match(agent, /if proto == "H2-Reality":[\s\S]*?"transport"\] = \{"type": "http", "host": \[server_name\], "path": "\/"\}/);
    assert.match(agent, /proto == "TUIC":[\s\S]*?"congestion_control": "bbr"/);
    assert.match(agent, /proto == "TUIC":[\s\S]*?"udp_relay_mode": "native"/);
    assert.match(agent, /elif proto == "TUIC": singbox_config\["inbounds"\].*"congestion_control": "bbr"/);
    assert.match(api, /node\.chain_target = \{ ip: '127\.0\.0\.1'/);
});

test('subscription exports include supported SOCKS5 and TUIC client options', () => {
    const internalSubscriptionSource = api.slice(api.indexOf('// --- 传统 Base64 URL 生成 ---'), api.indexOf('// --- 第三方订阅节点整合进订阅 ---'));
    assert.match(api, /node\.protocol === "Socks5"[\s\S]*?type: socks5[\s\S]*?username:/);
    assert.match(api, /node\.protocol === "TUIC"[\s\S]*?udp-relay-mode: native[\s\S]*?congestion-controller: bbr/);
    assert.match(api, /tuic:\/\/\$\{encodeURIComponent\(node\.uuid\)\}:\$\{encodeURIComponent\(node\.private_key\)\}/);
    assert.match(internalSubscriptionSource, /case "TUIC": link = `tuic:[^`]+\?congestion_control=bbr/);
    assert.doesNotMatch(internalSubscriptionSource, /case "TUIC": link = `tuic:[^`]+\?sni=/);
});

test('TUIC uses a stable internal certificate identity while other TLS nodes follow SNI', () => {
    assert.match(agent, /certificate_name = "kui-tuic\.local" if proto == "TUIC" else sni/);
    assert.match(agent, /f"\/opt\/kui\/cert_\{node\['id'\]\}\.sni"/);
    assert.match(agent, /if previous_sni != certificate_name:/);
    assert.match(agent, /for stale_path in \(cert_path, key_path\):/);
    assert.match(agent, /with open\(sni_path, "w"\) as marker: marker\.write\(certificate_name\)/);
    assert.doesNotMatch(agent, /proto == "TUIC"[\s\S]{0,300}"server_name"/);
});

test('TUIC bypasses sing-box sniffing while retaining shared DNS handling', () => {
    assert.match(agent, /sniff_inbounds = [^\n]*node\.get\("protocol"\) not in \{"dokodemo-door", "TUIC"\}/);
    assert.match(agent, /build_routing_policy\([^)]*sniff_inbounds=sniff_inbounds/);
    assert.match(routing, /"inbound": list\(proxy_inbounds\), "protocol": "dns", "action": "hijack-dns"/);
});

test('MTProxy is managed by mtg and excluded from sing-box inbounds', () => {
    assert.match(agent, /MTG_VERSION = "2\.2\.8"/);
    assert.match(agent, /def sync_mtproxy_nodes\(/);
    assert.match(agent, /if proto == "MTProxy":[\s\S]*?continue/);
    assert.match(agent, /sync_mtproxy_nodes\(nodes\)/);
    assert.doesNotMatch(agent, /"type": "mtproxy"/);
    assert.match(agent, /archive checksum mismatch/);
    assert.match(agent, /ProtectSystem=strict/);
    assert.match(agent, /f"\/etc\/init\.d\/\{service\}"/);
});

test('sing-box node traffic and connection tuning are generated safely', () => {
    assert.doesNotMatch(agent, /http:\/\/127\.0\.0\.1:9090\/stats\/inbound/);
    assert.match(agent, /totals = \[_read_iptables_port_bytes\(port, item\) for item in transports\]/);
    assert.match(agent, /"tcp_fast_open": True/);
    assert.match(agent, /"tcp_keep_alive": "2m"/);
    assert.match(agent, /"tcp_keep_alive_interval": "30s"/);
    assert.match(agent, /if "udp" not in transports:[\s\S]{0,80}inbound\["reuse_addr"\] = True/);
    assert.match(agent, /"udp_timeout"\] = "5m"/);
    assert.match(agent, /ss_networks = normalize_ss2022_network/);
    assert.match(agent, /"network": ss_networks/);
    assert.match(agent, /transports = node_transports\(node\)[\s\S]{0,130}for transport in transports:\s+ensure_firewall_open\(int\(node\["port"\]\), transport\)/);
    assert.match(agent, /"-days", "36500"/);
    assert.match(agent, /"insecure": True/);
    assert.match(installer, /net\.ipv4\.tcp_fastopen = 3/);
    assert.match(installer, /net\.core\.somaxconn = 4096/);
    assert.match(installer, /LimitNOFILE=1048576/);
    assert.match(installer, /rc_ulimit="-n 1048576"/);
});

test('integrated Worker notifies the connected VPS agent directly', async () => {
    const requests = [];
    const db = { prepare: () => ({ bind: () => ({ first: async () => ({ agent_token: 'agent-secret' }) }) }) };
    const env = { VPS_PRESENCE: {
        idFromName: name => name,
        get: name => ({ fetch: async request => { requests.push({ name, request }); return Response.json({ success: true }); } }),
    } };
    await __test.notifyRealtimeVps(env, db, '203.0.113.8');
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].request.url).pathname, '/notify');
    assert.match(requests[0].name, /^v2:203\.0\.113\.8:[0-9a-f]{64}$/);
});
