import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildNodeDetailRows } from '../frontend/src/utils/nodeDetails.js';

const serversPage = fs.readFileSync(new URL('../frontend/src/pages/ServersPage.vue', import.meta.url), 'utf8');
const appStyles = fs.readFileSync(new URL('../frontend/src/styles/app.css', import.meta.url), 'utf8');
const kuiState = fs.readFileSync(new URL('../frontend/src/composables/useKuiState.js', import.meta.url), 'utf8');
const apiWorker = fs.readFileSync(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');

const asObject = rows => Object.fromEntries(rows.map(row => [row.label, row.value]));

test('configured node cards are collapsed summaries with protocol, port, user and used traffic', () => {
    const start = serversPage.indexOf('<details v-for="node in getNodesByIp(vps.ip)"');
    const summary = serversPage.slice(serversPage.indexOf('<summary', start), serversPage.indexOf('</summary>', start));
    assert.ok(start >= 0);
    assert.doesNotMatch(serversPage.slice(start, serversPage.indexOf('>', start) + 1), /\sopen(?:\s|>)/);
    assert.match(summary, /node\.protocol/);
    assert.match(summary, /node\.port/);
    assert.match(summary, /node\.username/);
    assert.match(summary, /已用流量 \{\{ formatBytes\(node\.traffic_used\) \}\}/);
    assert.match(summary, /kui-node-quick-copy/);
    assert.doesNotMatch(summary, /node\.sni|private_key|public_key|short_id/);
    assert.match(appStyles, /\.kui-node-card\[open\]/);
});

test('Reality node details expose transport and key material', () => {
    const details = asObject(buildNodeDetailRows({
        id: 'node-1', protocol: 'gRPC-Reality', port: 443, uuid: 'uuid', sni: 'example.com',
        public_key: 'public', private_key: 'private', short_id: 'abcd',
    }));
    assert.equal(details['监听端口'], '443');
    assert.equal(details.UUID, 'uuid');
    assert.equal(details['传输方式'], 'gRPC + Reality');
    assert.equal(details['Reality 公钥'], 'public');
    assert.equal(details['Reality 私钥'], 'private');
    assert.equal(details['Reality 短 ID'], 'abcd');
});

test('credential protocols expose their protocol-specific fields', () => {
    const ss = asObject(buildNodeDetailRows({ protocol: 'Shadowsocks2022', port: 8388, uuid: '2022-blake3-aes-256-gcm', private_key: 'secret' }));
    assert.equal(ss['加密方式'], '2022-blake3-aes-256-gcm');
    assert.equal(ss['密码'], 'secret');

    const tuic = asObject(buildNodeDetailRows({ protocol: 'TUIC', port: 443, uuid: 'uuid', private_key: 'password', sni: 'tuic.example' }));
    assert.equal(tuic.UUID, 'uuid');
    assert.equal(tuic['密码'], 'password');
    assert.equal(tuic['SNI / 域名'], undefined);
    assert.match(tuic['传输方式'], /QUIC/);

    const naive = asObject(buildNodeDetailRows({ protocol: 'Naive', port: 443, uuid: 'user', private_key: 'pass', sni: 'naive.example' }));
    assert.equal(naive['用户名'], 'user');
    assert.equal(naive['密码'], 'pass');
});

test('MTProxy details expose FakeTLS connection parameters', () => {
    const rows = asObject(buildNodeDetailRows({ protocol: 'MTProxy', port: 443, sni: 'proxy.example.com', private_key: 'ee-secret' }));
    assert.equal(rows['监听端口'], '443');
    assert.equal(rows['TLS 伪装域名'], 'proxy.example.com');
    assert.equal(rows['FakeTLS 密钥'], 'ee-secret');
});

test('relay and Argo details expose targets instead of unrelated credentials', () => {
    const relay = asObject(buildNodeDetailRows({ protocol: 'dokodemo-door', port: 9000, relay_type: 'external', target_ip: '10.0.0.1', target_port: 443 }));
    assert.equal(relay['转发类型'], '外部地址');
    assert.equal(relay['转发目标'], '10.0.0.1:443');
    assert.equal(relay['密码'], undefined);

    const argo = asObject(buildNodeDetailRows({ protocol: 'VLESS-Argo', port: 10000, uuid: 'uuid', sni: 'tunnel.example.com' }));
    assert.equal(argo['本地监听端口'], '10000');
    assert.equal(argo['公网域名'], 'tunnel.example.com');
    assert.equal(argo['公网端口'], '443');
});

test('node subscription links carry a validated node scope through UI and API', () => {
    assert.match(kuiState, /generateSubLink = \(ip='', format='', nodeId=''\)/);
    assert.match(kuiState, /if \(nodeId\) link \+= `&node=\$\{encodeURIComponent\(nodeId\)\}`/);
    assert.match(kuiState, /generateSubLink\(ip, 'surge', nodeId\)/);
    assert.match(apiWorker, /const nodeId = urlObj\.searchParams\.get\("node"\)/);
    assert.match(apiWorker, /if \(nodeId && !\/\^\[A-Za-z0-9_-\]\{1,64\}\$\/\.test\(nodeId\)\) return json\(\{ error: "Not found" \}, 404\)/);
    assert.match(apiWorker, /query \+= " AND id = \?"; sqlParams\.push\(nodeId\)/);
    assert.match(apiWorker, /query \+= " AND n\.id = \?"; sqlParams\.push\(nodeId\)/);
    assert.match(kuiState, /copySurgeConfig[\s\S]*Authorization[^\n]*Bearer/);
    assert.match(apiWorker, /authenticatedSurgeAccess = format === 'surge'[\s\S]{0,100}authenticatedSurgeUser === reqUser/);
});

test('MTProxy nodes copy a direct Telegram link instead of unsupported client exports', () => {
    assert.match(kuiState, /generateMtproxyLink = node => `tg:\/\/proxy\?/);
    assert.match(serversPage, /node\.protocol === 'MTProxy'[\s\S]*?复制 Telegram 链接/);
    assert.match(serversPage, /<template v-else>[\s\S]*?复制 Clash 订阅[\s\S]*?复制 Surge 配置段/);
});

test('node-scoped subscriptions do not append unrelated external sources', () => {
    assert.match(apiWorker, /if \(!ip && !nodeId\) try \{\s*const \{ results: thNodes \}/);
    assert.match(apiWorker, /if \(!nodeId && reqUser === adminUser && env\.PROXY_USER && env\.PROXY_PASS\)/);
});
