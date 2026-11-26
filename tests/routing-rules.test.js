import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
    normalizeRoutingRules,
    parseRoutingRule,
    routingRuleConflicts,
    routingRuleMatches,
    ROUTING_RULE_LIMITS,
} from '../src/routing-rules.js';
import { __test, onRequest } from '../functions/api/[[path]].js';

const ADMIN_TOKEN = 'd'.repeat(48);
const USER_TOKEN = 'e'.repeat(48);
const ADMIN_USER = 'admin';
const ADMIN_PASSWORD = 'test-admin-password';

const SCHEMA = `
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
CREATE TABLE servers (
    ip TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cpu INTEGER DEFAULT 0,
    mem REAL DEFAULT 0,
    last_report INTEGER DEFAULT 0,
    alert_sent INTEGER DEFAULT 0,
    disk INTEGER DEFAULT 0,
    load TEXT DEFAULT '',
    uptime TEXT DEFAULT '',
    net_in_speed INTEGER DEFAULT 0,
    net_out_speed INTEGER DEFAULT 0,
    tcp_conn INTEGER DEFAULT 0,
    udp_conn INTEGER DEFAULT 0,
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
    proxy_direct_rules TEXT NOT NULL DEFAULT '[]',
    proxy_custom_rules TEXT NOT NULL DEFAULT '[]',
    ip_stack TEXT NOT NULL DEFAULT 'dual',
    block_residential_quic INTEGER NOT NULL DEFAULT 1,
    capabilities TEXT NOT NULL DEFAULT '[]',
    has_ipv4 INTEGER,
    has_ipv6 INTEGER,
    egress_ip TEXT DEFAULT '',
    agent_token TEXT DEFAULT '',
    socks5_addr TEXT DEFAULT '',
    socks5_port INTEGER DEFAULT 0,
    socks5_user TEXT DEFAULT '',
    socks5_pass TEXT DEFAULT ''
);
CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    uuid TEXT NOT NULL,
    vps_ip TEXT NOT NULL,
    protocol TEXT NOT NULL,
    port INTEGER NOT NULL,
    sni TEXT,
    private_key TEXT,
    public_key TEXT,
    short_id TEXT,
    username TEXT DEFAULT 'admin',
    enable INTEGER DEFAULT 1,
    traffic_used INTEGER DEFAULT 0,
    traffic_limit INTEGER DEFAULT 0,
    expire_time INTEGER DEFAULT 0
);
CREATE TABLE user_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE user_group_members (group_id TEXT NOT NULL, username TEXT NOT NULL, PRIMARY KEY(group_id, username));
CREATE TABLE user_group_resources (
    group_id TEXT NOT NULL,
    resource_type TEXT NOT NULL CHECK(resource_type IN ('vps', 'node')),
    resource_id TEXT NOT NULL,
    PRIMARY KEY(group_id, resource_type, resource_id)
);
CREATE TABLE proxy_ctrl_servers (ip TEXT PRIMARY KEY, details TEXT, last_seen INTEGER);
CREATE TABLE probe_settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE sys_config (key TEXT PRIMARY KEY, val TEXT, ts INTEGER);
`;

class TestStatement {
    constructor(db, sql) {
        this.db = db;
        this.sql = sql;
        this.params = [];
    }

    bind(...params) {
        this.params = params.map(value => typeof value === 'boolean' ? Number(value) : value);
        return this;
    }

    async first() {
        return this.db.database.prepare(this.sql).get(...this.params) ?? null;
    }

    async all() {
        const statement = this.db.database.prepare(this.sql);
        return { results: statement.all(...this.params), success: true, meta: { changes: 0 } };
    }

    async run() {
        const statement = this.db.database.prepare(this.sql);
        const result = statement.run(...this.params);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    }

    async execute() {
        const statement = this.db.database.prepare(this.sql);
        return { results: statement.all(...this.params), success: true, meta: { changes: 0 } };
    }
}

class TestD1 {
    constructor(database = new DatabaseSync(':memory:')) {
        this.database = database;
        this.queries = [];
    }

    prepare(sql) {
        this.queries.push(sql);
        return new TestStatement(this, sql);
    }

    async batch(statements) {
        const results = [];
        for (const statement of statements) results.push(await statement.execute());
        return results;
    }
}

async function sha256(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function createDb() {
    const db = new TestD1();
    db.database.exec(SCHEMA);
    await db.prepare('INSERT OR REPLACE INTO users (username, password, enable) VALUES (?, ?, 1)')
        .bind(ADMIN_USER, 'unused-password-hash')
        .run();
    await db.prepare('INSERT OR REPLACE INTO auth_sessions (token_hash, username, expires_at) VALUES (?, ?, ?)')
        .bind(await sha256(ADMIN_TOKEN), ADMIN_USER, Date.now() + 3600 * 1000)
        .run();
    await db.prepare('INSERT OR REPLACE INTO users (username, password, enable) VALUES (?, ?, 1)')
        .bind('alice', 'unused-password-hash')
        .run();
    await db.prepare('INSERT OR REPLACE INTO auth_sessions (token_hash, username, expires_at) VALUES (?, ?, ?)')
        .bind(await sha256(USER_TOKEN), 'alice', Date.now() + 3600 * 1000)
        .run();
    return db;
}

async function seedServer(db, ip, overrides = {}) {
    const values = {
        ip,
        name: `server-${ip}`,
        egress_mode: 'native',
        egress_applied_mode: 'native',
        egress_revision: 3,
        egress_applied_revision: 3,
        egress_status: 'applied',
        egress_desired_config: '',
        egress_applied_config: '',
        agent_token: 'agent-token-fixture',
        ...overrides,
    };
    await db.prepare(`INSERT OR REPLACE INTO servers (
        ip, name, egress_mode, egress_applied_mode, egress_revision, egress_applied_revision,
        egress_status, egress_desired_config, egress_applied_config, agent_token,
        proxy_mode, proxy_categories, proxy_direct_rules, proxy_custom_rules, ip_stack, block_residential_quic
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
            values.ip,
            values.name,
            values.egress_mode,
            values.egress_applied_mode,
            values.egress_revision,
            values.egress_applied_revision,
            values.egress_status,
            values.egress_desired_config,
            values.egress_applied_config,
            values.agent_token,
            values.proxy_mode ?? 'global',
            values.proxy_categories ?? '',
            values.proxy_direct_rules ?? '[]',
            values.proxy_custom_rules ?? '[]',
            values.ip_stack ?? 'dual',
            values.block_residential_quic ?? 1,
        )
        .run();
}

async function callApi(db, path, { method = 'GET', token, body } = {}, envOverrides = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const request = new Request(`https://panel.example${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const tasks = [];
    const response = await onRequest({
        request,
        env: { DB: db, ADMIN_USERNAME: ADMIN_USER, ADMIN_PASSWORD, ...envOverrides },
        params: { path: path.replace(/^\/api\//, '').split('?')[0].split('/').filter(Boolean) },
        waitUntil: promise => tasks.push(promise),
    });
    const payload = await response.clone().json().catch(() => null);
    await Promise.allSettled(tasks);
    return { response, payload };
}

test('shared routing rules parse every documented syntax', () => {
    assert.deepEqual(normalizeRoutingRules('openai.com\n*.example.org\nfull:api.openai.com\nkeyword:chatgpt\n1.1.1.1\n104.18.0.0/16\n2606:4700::/32'), [
        'openai.com',
        'example.org',
        'full:api.openai.com',
        'keyword:chatgpt',
        '1.1.1.1/32',
        '104.18.0.0/16',
        '2606:4700::/32',
    ]);
    assert.equal(parseRoutingRule('1.1.1.1').type, 'ip_cidr');
    assert.equal(parseRoutingRule('2606:4700::1').value, '2606:4700::1/128');
    assert.equal(parseRoutingRule('*.example.com').value, 'example.com');
    assert.deepEqual(normalizeRoutingRules(['1.1.1.42/24','1.1.1.0/24','2606:4700::123/64']), ['1.1.1.0/24','2606:4700::/64']);
    assert.equal(parseRoutingRule('::ffff:1.1.1.1').value, '::ffff:101:101/128');
    for (const target of ['1.1.1.1::', '::1.1.1.1:1.1.1.1', '0x7f000001', 'host.example\\hidden', 'host%2eexample', '1.1.1.1/']) {
        assert.throws(() => parseRoutingRule(target));
    }
});

test('agent reports retain stack capabilities and legacy results cannot acknowledge a migration', async () => {
    const db = await createDb();
    const ip = '198.51.100.63';
    await seedServer(db, ip, {egress_mode:'warp_dual', egress_applied_mode:'warp_dual'});
    const send = (action, body) => onRequest({env:{DB:db}, params:{path:[action]}, waitUntil:() => {}, request:new Request(`https://panel.example/api/${action}`, {method:'POST', headers:{Authorization:'agent-token-fixture', 'Content-Type':'application/json'}, body:JSON.stringify({ip, ...body})})});
    const report = await send('report', {report_id:`${ip}:abc1234`, has_ipv4:true, has_ipv6:false, capabilities:['route_log','route_log',{}, 'invalid value']});
    assert.equal(report.status, 200, await report.text());
    const stack = await db.prepare('SELECT has_ipv4, has_ipv6, capabilities FROM servers WHERE ip = ?').bind(ip).first();
    assert.deepEqual([stack.has_ipv4, stack.has_ipv6, JSON.parse(stack.capabilities)], [1,0,['route_log']]);
    const result = {revision:3, desired_mode:'native', success:true};
    assert.equal((await send('egress_result', {...result, applied_mode:'warp_dual'})).status, 400);
    const stale = await send('egress_result', {...result, applied_mode:'native', revision:2});
    assert.equal((await stale.json()).accepted, false);
    const current = await send('egress_result', {...result, applied_mode:'native'});
    assert.equal((await current.json()).accepted, true);
    const stored = await db.prepare('SELECT egress_applied_mode FROM servers WHERE ip = ?').bind(ip).first();
    assert.equal(stored.egress_applied_mode, 'native');
});

test('the agent update signs one runnable bundle and refuses missing dependencies', async () => {
    const db = await createDb();
    const ip = '198.51.100.62';
    await seedServer(db, ip);
    const files = new Map([
        ['/vps/routing_engine.py', 'LABEL = "规则"'],
        ['/vps/route_monitor.py', 'from routing_engine import LABEL\ndef check(): return LABEL'],
        ['/vps/agent.py', 'from route_monitor import check\nassert check() == "规则"'],
    ]);
    const assets = { fetch: async url => files.has(url.pathname) ? new Response(files.get(url.pathname)) : new Response('', {status:404}) };
    const request = () => onRequest({env: {DB:db, ASSETS:assets}, params:{path:['agent_update']}, request:new Request(`https://panel.example/api/agent_update?ip=${ip}`, {headers:{Authorization:'agent-token-fixture'}})});
    const response = await request();
    assert.equal(response.status, 200);
    const bundle = Buffer.from(await response.arrayBuffer());
    const digest = createHash('sha256').update(bundle).digest('hex');
    assert.equal(response.headers.get('X-Agent-SHA256'), digest);
    assert.equal(response.headers.get('X-Agent-Length'), String(bundle.length));
    assert.equal(response.headers.get('X-Agent-MAC'), createHmac('sha256', 'agent-token-fixture').update(`v1\nagent\n${digest}\n${bundle.length}\n`).digest('hex'));
    const python = spawnSync('python3', ['-I', '-'], {input:bundle});
    assert.equal(python.status, 0, python.stderr.toString());
    for (const name of files.keys()) {
        files.set(name, readFileSync(new URL(`../static${name}`, import.meta.url)));
    }
    const realBundle = Buffer.from(await (await request()).arrayBuffer());
    const startup = `
import builtins, io, json, sys, time
source = sys.stdin.buffer.read()
config = dict(api_url='https://panel.example/api/agent_config', report_url='https://panel.example/api/report', ip='192.0.2.21', token='fixture')
original_open = builtins.open
def open_config(path, *args, **kwargs):
    if path == '/opt/kui/config.json':
        return io.StringIO(json.dumps(config))
    if str(path).startswith('/opt/kui/'):
        raise FileNotFoundError(path)
    return original_open(path, *args, **kwargs)
builtins.open = open_config
scope = dict(__name__='__main__', __file__='agent.py')
def before_first_poll(seconds):
    assert isinstance(scope['route_monitor'], sys.modules['route_monitor'].RouteMonitor)
    assert scope['build_routing_policy'] is sys.modules['routing_engine'].build_routing_policy
    assert scope['realtime_channel'] is not None
    print('agent initialized')
    raise SystemExit(0)
time.sleep = before_first_poll
exec(compile(source, 'agent.py', 'exec'), scope)
`;
    const started = spawnSync('python3', ['-I', '-c', startup], {input:realBundle, timeout:10000});
    assert.equal(started.status, 0, started.stderr.toString());
    assert.match(started.stdout.toString(), /agent initialized/);
    files.delete('/vps/routing_engine.py');
    assert.equal((await request()).status, 503);
});

test('agent config returns stack capabilities and normalized routing fields', async () => {
    const db = await createDb();
    const ip = '198.51.100.61';
    await seedServer(db, ip, {
        egress_mode: 'residential',
        egress_applied_mode: 'residential',
        egress_revision: 2,
        egress_applied_revision: 2,
        proxy_mode: 'selective',
        proxy_categories: 'ai,google',
        proxy_direct_rules: JSON.stringify(['direct.example.com']),
        proxy_custom_rules: JSON.stringify(['custom.example.com']),
        ip_stack: 'ipv4_only',
        block_residential_quic: 0,
    });
    await db.prepare("UPDATE servers SET capabilities = ?, has_ipv4 = 1, has_ipv6 = 0 WHERE ip = ?").bind(JSON.stringify(['route_log', 'config-refresh']), ip).run();
    for (const key of ['proxy_config', `proxy_toggle_${ip}`]) {
        await db.prepare('INSERT INTO probe_settings (key, value) VALUES (?, ?)').bind(key, JSON.stringify({enabled: true, mesh: {enabled: true}})).run();
    }
    const { response, payload } = await callApi(db, `/api/config?ip=${ip}`, { token: ADMIN_TOKEN });
    assert.equal(response.status, 200);
    assert.deepEqual(payload.proxy, {global: {enabled: true}, toggle: {enabled: true}});
    assert.deepEqual(payload.capabilities, ['config-refresh', 'route_log']);
    assert.equal(payload.has_ipv4, true);
    assert.equal(payload.has_ipv6, false);
    assert.equal(payload.egress.ip_stack, 'ipv4_only');
    assert.equal(payload.egress.block_residential_quic, false);
    assert.deepEqual(payload.egress.proxy_direct_rules, ['direct.example.com']);
    assert.deepEqual(payload.egress.proxy_custom_rules, ['custom.example.com']);
    assert.deepEqual(payload.egress.proxy_custom_domains, ['custom.example.com']);
    assert.equal(payload.egress.proxy_categories, 'ai,google');
});

test('shared routing rules drop comments and blank lines and deduplicate', () => {
    assert.deepEqual(normalizeRoutingRules('# comment\n\nExample.COM\nexample.com\n  \n'), ['example.com']);
});

test('shared routing rules reject private targets in the residential list only', () => {
    assert.throws(() => normalizeRoutingRules('10.0.0.0/8', { residential: true }), /Private or reserved IP/);
    assert.throws(() => normalizeRoutingRules('127.0.0.1', { residential: true }), /Private or reserved IP/);
    assert.throws(() => normalizeRoutingRules('fd00::/8', { residential: true }), /Private or reserved IP/);
    assert.throws(() => normalizeRoutingRules('gateway.local', { residential: true }), /Invalid routing domain/);
    assert.throws(() => normalizeRoutingRules('keyword:ab'), /Invalid routing keyword/);
    assert.throws(() => normalizeRoutingRules('keyword:Bad_Keyword'), /Invalid routing keyword/);
    assert.doesNotThrow(() => normalizeRoutingRules('10.0.0.0/8'));
});

test('shared routing rules enforce the entry and byte caps', () => {
    const many = Array.from({ length: ROUTING_RULE_LIMITS.maxRules + 1 }, (_, index) => `host-${index}.example.com`);
    assert.throws(() => normalizeRoutingRules(many), /exceeds 200 entries/);
    const fat = Array.from({ length: 600 }, () => 'x'.repeat(60)).join('\n');
    assert.throws(() => normalizeRoutingRules(fat), /exceeds 32768 bytes/);
    assert.equal(ROUTING_RULE_LIMITS.maxRules, 200);
    assert.equal(ROUTING_RULE_LIMITS.maxBytes, 32 * 1024);
});

test('shared routing rules report cross-list conflicts', () => {
    assert.deepEqual(routingRuleConflicts(['openai.com', 'direct.example.com'], ['openai.com']), ['openai.com']);
    assert.deepEqual(routingRuleConflicts(['openai.com'], ['other.com']), []);
});

test('shared routing rules match domains, keywords, full names and CIDR targets', () => {
    assert.equal(routingRuleMatches('openai.com', 'chat.openai.com'), true);
    assert.equal(routingRuleMatches('openai.com', 'openai.com.evil.net'), false);
    assert.equal(routingRuleMatches('full:api.openai.com', 'api.openai.com'), true);
    assert.equal(routingRuleMatches('full:api.openai.com', 'v1.api.openai.com'), false);
    assert.equal(routingRuleMatches('keyword:chatgpt', 'chatgpt.example.com'), true);
    assert.equal(routingRuleMatches('keyword:104', '104.18.2.3'), false);
    assert.equal(routingRuleMatches('keyword:4700', '2606:4700::1111'), false);
    assert.equal(routingRuleMatches('104.18.0.0/16', '104.18.2.3'), true);
    assert.equal(routingRuleMatches('104.18.0.0/16', '104.19.2.3'), false);
    assert.equal(routingRuleMatches('2606:4700::/32', '2606:4700::1111'), true);
});

test('offline tests decide local rules and defer built-in rule sets to the Agent', () => {
    const { localRouteDecision } = __test;
    const config = {
        mode: 'residential',
        proxy_mode: 'selective',
        proxy_categories: 'ai,youtube,custom',
        ip_stack: 'dual',
        proxy_direct_rules: ['direct.example.com'],
        proxy_custom_rules: ['custom.example.com'],
    };
    assert.equal(localRouteDecision(config, '192.168.1.10').rule_group, 'lan');
    assert.equal(localRouteDecision({ ...config, ip_stack: 'ipv6_only' }, '192.168.1.10').rule_group, 'stack_reject');
    assert.equal(localRouteDecision({ ...config, ip_stack: 'ipv4_only' }, 'fe80::1').rule_group, 'stack_reject');
    assert.equal(localRouteDecision(config, 'router.local').rule_group, 'lan');
    assert.equal(localRouteDecision(config, 'direct.example.com').rule_group, 'custom_direct');
    assert.equal(localRouteDecision({ ...config, proxy_mode: 'global' }, 'direct.example.com').outbound, 'residential');
    assert.equal(localRouteDecision(config, 'custom.example.com').rule_group, 'custom_proxy');
    assert.equal(localRouteDecision(config, 'chatgpt.com').scope, 'partial');
    assert.equal(localRouteDecision(config, 'youtube.com').rule_group, 'unknown');
    assert.equal(localRouteDecision(config, 'unknown-site.net').outbound, 'unknown');
    assert.equal(localRouteDecision({ ...config, ip_stack: 'ipv4_only' }, '2606:4700::1').rule_group, 'stack_reject');
    assert.equal(localRouteDecision({ ...config, ip_stack: 'ipv4_only' }, '2606:4700::1').action, 'reject');
    assert.equal(localRouteDecision({ ...config, ip_stack: 'ipv6_only', proxy_direct_rules: ['1.1.1.1/32'] }, '1.1.1.1').rule_group, 'stack_reject');
    assert.equal(localRouteDecision({ ...config, ip_stack: 'ipv6_only', proxy_custom_rules: ['1.1.1.1/32'] }, '1.1.1.1').outbound, 'residential');
    assert.equal(localRouteDecision({ ...config, ip_stack: 'dual' }, '2606:4700::1').rule_group, 'unknown');
    const native = localRouteDecision({ ...config, mode: 'native' }, 'custom.example.com');
    assert.equal(native.rule_group, 'final');
    assert.equal(native.scope, 'local');
});

test('realtime route test prefers the presence stub and forwards target with revision', async () => {
    const { requestRealtimeRouteTest } = __test;
    const db = await createDb();
    await seedServer(db, '198.51.100.40');
    const requests = [];
    const env = {
        VPS_PRESENCE: {
            idFromName: name => name,
            get: () => ({
                fetch: async request => {
                    requests.push({ url: request.url, body: await request.json() });
                    return Response.json({ rule_group: 'ai', outbound: 'residential', action: 'route', scope: 'agent', revision: 3 });
                },
            }),
        },
    };
    const result = await requestRealtimeRouteTest(env, db, '198.51.100.40', 'chatgpt.com', 3, 'https://panel.example');
    assert.equal(result.status, 200);
    assert.equal(result.result.scope, 'agent');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://presence.internal/route-test');
    assert.deepEqual(requests[0].body, { target: 'chatgpt.com', revision: 3 });
});

test('realtime route test falls back to the realtime url with the full body', async () => {
    const { requestRealtimeRouteTest } = __test;
    const db = await createDb();
    await seedServer(db, '198.51.100.41');
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json({ rule_group: 'final', outbound: 'direct', action: 'route', scope: 'agent', revision: 3 });
    };
    try {
        const env = { REALTIME_URL: 'https://realtime.example/', REALTIME_AUTH_SECRET: 's'.repeat(48) };
        const result = await requestRealtimeRouteTest(env, db, '198.51.100.41', 'example.com', 3, 'https://panel.example');
        assert.equal(result.status, 200);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://realtime.example/route-test');
        assert.deepEqual(JSON.parse(calls[0].init.body), { ip: '198.51.100.41', target: 'example.com', revision: 3 });
        assert.equal(calls[0].init.headers.Authorization.startsWith('Realtime '), true);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('route-test requires admin, validates input and falls back locally', async () => {
    const db = await createDb();
    await seedServer(db, '198.51.100.50', {
        egress_mode: 'residential',
        egress_applied_mode: 'residential',
        egress_revision: 4,
        egress_applied_revision: 4,
        proxy_mode: 'selective',
        proxy_categories: 'ai',
        proxy_direct_rules: JSON.stringify(['direct.example.com']),
        proxy_custom_rules: JSON.stringify(['custom.example.com']),
        egress_desired_config: JSON.stringify({ mode: 'residential', proxy_mode: 'selective', proxy_categories: 'ai' }),
        egress_applied_config: JSON.stringify({ mode: 'residential', proxy_mode: 'selective', proxy_categories: 'ai', proxy_direct_rules: ['direct.example.com'] }),
    });

    const unauthorized = await callApi(db, '/api/vps/route-test', { method: 'POST', body: { ip: '198.51.100.50', target: 'chatgpt.com' } });
    assert.equal(unauthorized.response.status, 401);

    const forbidden = await callApi(db, '/api/vps/route-test', { method: 'POST', token: USER_TOKEN, body: { ip: '198.51.100.50', target: 'chatgpt.com' } });
    assert.equal(forbidden.response.status, 403);

    const invalidIp = await callApi(db, '/api/vps/route-test', { method: 'POST', token: ADMIN_TOKEN, body: { ip: 'not-an-ip', target: 'chatgpt.com' } });
    assert.equal(invalidIp.response.status, 400);
    assert.match(invalidIp.payload.error, /Invalid VPS IP/);

    const invalidTarget = await callApi(db, '/api/vps/route-test', { method: 'POST', token: ADMIN_TOKEN, body: { ip: '198.51.100.50', target: 'bad target' } });
    assert.equal(invalidTarget.response.status, 400);
    assert.match(invalidTarget.payload.error, /Invalid route test target/);

    const missing = await callApi(db, '/api/vps/route-test', { method: 'POST', token: ADMIN_TOKEN, body: { ip: '198.51.100.99', target: 'chatgpt.com' } });
    assert.equal(missing.response.status, 404);

    const fallback = await callApi(db, '/api/vps/route-test', { method: 'POST', token: ADMIN_TOKEN, body: { ip: '198.51.100.50', target: 'direct.example.com' } });
    assert.equal(fallback.response.status, 200);
    assert.equal(fallback.payload.rule_group, 'custom_direct');
    assert.equal(fallback.payload.outbound, 'direct');
    assert.equal(fallback.payload.action, 'route');
    assert.equal(fallback.payload.scope, 'local');
    assert.equal(fallback.payload.ip, '198.51.100.50');
    assert.equal(fallback.payload.target, 'direct.example.com');
    assert.ok(Array.isArray(fallback.payload.notes) && fallback.payload.notes.length);
});

test('route-test prefers the agent scope when the realtime service answers with the applied revision', async () => {
    const db = await createDb();
    await seedServer(db, '198.51.100.51', {
        egress_mode: 'residential',
        egress_applied_mode: 'residential',
        egress_revision: 6,
        egress_applied_revision: 6,
        proxy_mode: 'selective',
        proxy_categories: 'ai',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({
        rule_group: 'ai',
        outbound: 'residential',
        action: 'route',
        scope: 'agent',
        revision: 6,
    });
    try {
        const result = await callApi(db, '/api/vps/route-test', { method: 'POST', token: ADMIN_TOKEN, body: { ip: '198.51.100.51', target: 'chatgpt.com' } }, {
            REALTIME_URL: 'https://realtime.example',
            REALTIME_AUTH_SECRET: 's'.repeat(48),
        });
        assert.equal(result.response.status, 200);
        assert.equal(result.payload.scope, 'agent');
        assert.equal(result.payload.rule_group, 'ai');
        assert.equal(result.payload.revision, 6);
        assert.equal(result.payload.notes, undefined);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('route-test rejects an agent answer that does not match the applied revision', async () => {
    const db = await createDb();
    await seedServer(db, '198.51.100.52', {
        egress_mode: 'residential',
        egress_applied_mode: 'residential',
        egress_revision: 7,
        egress_applied_revision: 7,
        proxy_mode: 'selective',
        proxy_categories: 'ai',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({
        rule_group: 'ai',
        outbound: 'residential',
        action: 'route',
        scope: 'agent',
        revision: 3,
    });
    try {
        const result = await callApi(db, '/api/vps/route-test', { method: 'POST', token: ADMIN_TOKEN, body: { ip: '198.51.100.52', target: 'chatgpt.com' } }, {
            REALTIME_URL: 'https://realtime.example',
            REALTIME_AUTH_SECRET: 's'.repeat(48),
        });
        assert.equal(result.response.status, 200);
        assert.equal(result.payload.scope, 'partial');
        assert.equal(result.payload.rule_group, 'unknown');
        assert.ok(result.payload.notes.length);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('route-test keeps a local answer when the agent scope is unknown', async () => {
    const db = await createDb();
    await seedServer(db, '198.51.100.53', {
        egress_mode: 'residential',
        egress_applied_mode: 'residential',
        egress_revision: 8,
        egress_applied_revision: 8,
        proxy_mode: 'selective',
        proxy_categories: 'ai',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({
        rule_group: 'unknown',
        outbound: 'unknown',
        action: 'unknown',
        scope: 'agent',
        revision: 8,
    });
    try {
        const result = await callApi(db, '/api/vps/route-test', { method: 'POST', token: ADMIN_TOKEN, body: { ip: '198.51.100.53', target: 'chatgpt.com' } }, {
            REALTIME_URL: 'https://realtime.example',
            REALTIME_AUTH_SECRET: 's'.repeat(48),
        });
        assert.equal(result.response.status, 200);
        assert.equal(result.payload.scope, 'partial');
        assert.equal(result.payload.rule_group, 'unknown');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('vps config update accepts two 32 KiB routing lists', async () => {
    const db = await createDb();
    await seedServer(db, '198.51.100.60');
    const filler = ['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(22)].join('.');
    const direct = Array.from({ length: 200 }, (_, index) => `d${index}.${filler}.example.com`).join('\n');
    const custom = Array.from({ length: 200 }, (_, index) => `c${index}.${filler}.example.com`).join('\n');
    assert.ok(direct.length < 32 * 1024 && direct.length > 31 * 1024);
    const result = await callApi(db, '/api/vps', {
        method: 'PUT',
        token: ADMIN_TOKEN,
        body: {
            ip: '198.51.100.60',
            egress_mode: 'residential',
            proxy_mode: 'selective',
            proxy_categories: 'custom',
            proxy_direct_rules: direct.split('\n'),
            proxy_custom_rules: custom.split('\n'),
        },
    }, { PROXY_USER: 'proxy-user', PROXY_PASS: 'proxy-pass' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.success, true);
    assert.equal(result.payload.ip_stack, 'dual');
    assert.equal(result.payload.block_residential_quic, true);
    assert.equal(result.payload.proxy_direct_rules.length, 200);
    assert.equal(result.payload.proxy_custom_rules.length, 200);
    const stale = await callApi(db, '/api/vps', {method:'PUT', token:ADMIN_TOKEN, body:{ip:'198.51.100.60', egress_mode:'native', expected_revision:3}});
    assert.equal(stale.response.status, 409);
    const stored = await db.prepare('SELECT egress_revision, egress_mode FROM servers WHERE ip = ?').bind('198.51.100.60').first();
    assert.equal(stored.egress_revision, result.payload.egress_revision);
    assert.equal(stored.egress_mode, 'residential');
});

test('vps config update rejects conflicting routing lists and unknown stacks', async () => {
    const db = await createDb();
    await seedServer(db, '198.51.100.61');
    const conflict = await callApi(db, '/api/vps', {
        method: 'PUT',
        token: ADMIN_TOKEN,
        body: {
            ip: '198.51.100.61',
            egress_mode: 'residential',
            proxy_mode: 'selective',
            proxy_categories: 'custom',
            proxy_direct_rules: ['openai.com'],
            proxy_custom_rules: ['openai.com'],
        },
    }, { PROXY_USER: 'proxy-user', PROXY_PASS: 'proxy-pass' });
    assert.equal(conflict.response.status, 400);
    assert.match(conflict.payload.error, /Routing list conflict/);

    const badStack = await callApi(db, '/api/vps', {
        method: 'PUT',
        token: ADMIN_TOKEN,
        body: { ip: '198.51.100.61', egress_mode: 'native', ip_stack: 'ipv7' },
    });
    assert.equal(badStack.response.status, 400);
    assert.match(badStack.payload.error, /Invalid ip_stack/);

    const legacy = await callApi(db, '/api/vps', {
        method: 'PUT',
        token: ADMIN_TOKEN,
        body: { ip: '198.51.100.61', egress_mode: 'warp_dual' },
    });
    assert.equal(legacy.response.status, 400);
    assert.match(legacy.payload.error, /Legacy egress mode/);
});

test('first pending edit keeps the previous active stack until the Agent acknowledges it', async () => {
    const db = await createDb();
    const ip = '198.51.100.69';
    await seedServer(db, ip, {egress_applied_config: '', ip_stack: 'dual'});
    const update = await callApi(db, '/api/vps', {method:'PUT', token:ADMIN_TOKEN, body:{ip, egress_mode:'native', ip_stack:'ipv4_only'}});
    assert.equal(update.response.status, 200);
    const row = await db.prepare('SELECT egress_applied_config, egress_desired_config FROM servers WHERE ip = ?').bind(ip).first();
    assert.equal(JSON.parse(row.egress_applied_config).ip_stack, 'dual');
    assert.equal(JSON.parse(row.egress_desired_config).ip_stack, 'ipv4_only');
});

test('server list flags legacy egress rows as migrated', async () => {
    const db = await createDb();
    await seedServer(db, '198.51.100.70', { egress_mode: 'warp_dual', egress_applied_mode: 'socks5' });
    await seedServer(db, '198.51.100.71', { egress_mode: 'native', egress_applied_mode: 'native' });
    const result = await callApi(db, '/api/data', { token: ADMIN_TOKEN });
    assert.equal(result.response.status, 200);
    const legacy = result.payload.servers.find(server => server.ip === '198.51.100.70');
    const modern = result.payload.servers.find(server => server.ip === '198.51.100.71');
    assert.equal(legacy.egress_mode, 'native');
    assert.equal(legacy.egress_applied_mode, 'native');
    assert.equal(legacy.egress_legacy_migrated, true);
    assert.equal(modern.egress_legacy_migrated, false);
    assert.deepEqual(legacy.proxy_direct_rules, []);
    assert.deepEqual(legacy.proxy_custom_rules, []);
    assert.equal(legacy.ip_stack, 'dual');
    assert.equal(legacy.block_residential_quic, true);
    assert.deepEqual(legacy.capabilities, []);
    assert.equal(legacy.has_ipv4, null);
    assert.equal(legacy.has_ipv6, null);
});

test('global mirror prefix is written and read back through the settings api', async () => {
    const db = await createDb();
    const invalid = await callApi(db, '/api/settings', { method: 'PUT', token: ADMIN_TOKEN, body: { ruleset_mirror_prefix: 'http://mirror.example.com' } });
    assert.equal(invalid.response.status, 400);
    assert.match(invalid.payload.error, /https/);

    const written = await callApi(db, '/api/settings', { method: 'PUT', token: ADMIN_TOKEN, body: { ruleset_mirror_prefix: 'https://Mirror.Example.com/base/' } });
    assert.equal(written.response.status, 200);
    assert.equal(written.payload.ruleset_mirror_prefix, 'https://mirror.example.com/base');

    const data = await callApi(db, '/api/data', { token: ADMIN_TOKEN });
    assert.equal(data.payload.ruleset_mirror_prefix, 'https://mirror.example.com/base');
});
