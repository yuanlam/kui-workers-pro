import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { __test, onRequest } from '../functions/api/[[path]].js';

const ADMIN_TOKEN = 'a'.repeat(48);
const USER_TOKEN = 'b'.repeat(48);
const EMPTY_USER_TOKEN = 'c'.repeat(48);
const ADMIN_USER = 'admin';
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
        const statement = this.db.database.prepare(this.sql);
        return statement.get(...this.params) ?? null;
    }

    async all() {
        const statement = this.db.database.prepare(this.sql);
        return { results: statement.all(...this.params), success: true, meta: { changes: 0 } };
    }

    async run() {
        const statement = this.db.database.prepare(this.sql);
        const result = statement.run(...this.params);
        return {
            success: true,
            meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
        };
    }

    async execute() {
        const statement = this.db.database.prepare(this.sql);
        const results = statement.all(...this.params);
        return { results, success: true, meta: { changes: 0 } };
    }
}

class TestD1 {
    constructor(database = new DatabaseSync(':memory:')) {
        this.database = database;
        this.queries = [];
        this.prepared = [];
        this.batches = [];
    }

    prepare(sql) {
        const statement = new TestStatement(this, sql);
        this.queries.push(sql);
        this.prepared.push(statement);
        return statement;
    }

    async batch(statements) {
        this.batches.push(statements.map(statement => statement.sql));
        const results = [];
        for (const statement of statements) results.push(await statement.execute());
        return results;
    }

    resetQueries() {
        this.queries = [];
        this.prepared = [];
        this.batches = [];
    }

    countQueries(pattern) {
        return this.queries.filter(sql => pattern.test(sql)).length;
    }
}

async function sha256(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function createRouteDb() {
    const db = new TestD1();
    db.database.exec(ROUTE_SCHEMA);
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

async function seedServer(db, ip) {
    await db.prepare(`INSERT INTO servers (
        ip, name, cpu, mem, last_report, alert_sent, disk, load, uptime,
        net_in_speed, net_out_speed, tcp_conn, udp_conn
    ) VALUES (?, ?, 10, 20, ?, 0, 30, '0.1', '1d', 100, 200, 3, 4)`)
        .bind(ip, `server-${ip}`, Date.now())
        .run();
}

async function seedNode(db, node) {
    await db.prepare(`INSERT INTO nodes (
        id, uuid, vps_ip, protocol, port, sni, private_key, public_key, short_id, username
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
            node.id,
            node.uuid,
            node.vps_ip,
            node.protocol,
            node.port,
            node.sni || '',
            node.private_key || '',
            node.public_key || '',
            node.short_id || '',
            node.username || 'admin',
        )
        .run();
}

function requestFor(path, { method = 'GET', token, body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return new Request(`https://panel.example${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

async function callApi(db, path, options = {}, envOverrides = {}) {
    const tasks = [];
    const response = await onRequest({
        request: requestFor(path, options),
        env: {
            DB: db,
            ADMIN_USERNAME: ADMIN_USER,
            ADMIN_PASSWORD,
            ...envOverrides,
        },
        params: { path: path.replace(/^\/api\//, '').split('?')[0].split('/').filter(Boolean) },
        waitUntil: promise => tasks.push(promise),
    });
    const payload = await response.clone().json().catch(() => null);
    await Promise.allSettled(tasks);
    return { response, payload };
}

test('residential freshness accepts 305s and 590s only and rejects 12 minutes', async () => {
    const db = await createRouteDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    await seedServer(db, '198.51.100.10');
    const env = { PROXY_USER: 'proxy-user', PROXY_PASS: 'proxy-pass' };

    for (const [age, ready] of [[305_000, true], [590_000, true], [12 * 60 * 1000, false]]) {
        await db.prepare('INSERT OR REPLACE INTO proxy_ctrl_servers (ip, details, last_seen) VALUES (?, ?, ?)')
            .bind(
                '198.51.100.10',
                JSON.stringify([{ active: true, port: 7920, exit_ip: '203.0.113.20' }]),
                Date.now() - age,
            )
            .run();
        const { response, payload } = await callApi(db, '/api/data', { token: ADMIN_TOKEN }, env);
        assert.equal(response.status, 200);
        assert.equal(payload.servers[0].residential_ready, ready);
        if (!ready) assert.match(payload.servers[0].residential_reason, /过期/);
    }
});

test('disabling a user revokes existing sessions in the same batch and rejects the old token', async () => {
    const db = await createRouteDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    await seedSession(db, 'alice', USER_TOKEN);
    db.resetQueries();

    const updated = await callApi(db, '/api/users', {
        method: 'PUT',
        token: ADMIN_TOKEN,
        body: { username: 'alice', enable: 0 },
    });
    assert.equal(updated.response.status, 200);

    const disableBatch = db.batches.find(batch => batch.some(sql => /UPDATE users SET enable/.test(sql)));
    assert.ok(disableBatch?.some(sql => /DELETE FROM auth_sessions WHERE username/.test(sql)));
    const user = await db.prepare('SELECT enable FROM users WHERE username = ?').bind('alice').first();
    assert.equal(Number(user.enable), 0);
    const sessionCount = await db.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE username = ?').bind('alice').first();
    assert.equal(Number(sessionCount.count), 0);

    const denied = await callApi(db, '/api/data', { token: USER_TOKEN });
    assert.equal(denied.response.status, 401);
});

test('deleting a user revokes existing sessions and rejects the old token', async () => {
    const db = await createRouteDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    await seedSession(db, 'alice', USER_TOKEN);
    db.resetQueries();

    const removed = await callApi(db, '/api/users?username=alice', { method: 'DELETE', token: ADMIN_TOKEN });
    assert.equal(removed.response.status, 200);

    const deleteBatch = db.batches.find(batch => batch.some(sql => /DELETE FROM users WHERE username/.test(sql)));
    assert.ok(deleteBatch?.some(sql => /DELETE FROM auth_sessions WHERE username/.test(sql)));
    const sessionCount = await db.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE username = ?').bind('alice').first();
    assert.equal(Number(sessionCount.count), 0);

    const denied = await callApi(db, '/api/data', { token: USER_TOKEN });
    assert.equal(denied.response.status, 401);
});

test('PUT users rejects invalid enable values without writing', async () => {
    const db = await createRouteDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    await seedSession(db, 'alice', USER_TOKEN);
    db.resetQueries();

    const { response } = await callApi(db, '/api/users', {
        method: 'PUT',
        token: ADMIN_TOKEN,
        body: { username: 'alice', enable: 'invalid' },
    });

    assert.equal(response.status, 400);
    assert.equal(db.countQueries(/UPDATE users SET enable|DELETE FROM auth_sessions/), 0);
    const user = await db.prepare('SELECT enable FROM users WHERE username = ?').bind('alice').first();
    assert.equal(Number(user.enable), 1);
    const session = await db.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE username = ?').bind('alice').first();
    assert.equal(Number(session.count), 1);
});

test('PUT users accepts string zero to disable and revoke sessions', async () => {
    const db = await createRouteDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    await seedSession(db, 'alice', USER_TOKEN);
    db.resetQueries();

    const { response } = await callApi(db, '/api/users', {
        method: 'PUT',
        token: ADMIN_TOKEN,
        body: { username: 'alice', enable: '0' },
    });

    assert.equal(response.status, 200);
    const batch = db.batches.find(statements => statements.some(sql => /UPDATE users SET enable/.test(sql)));
    assert.ok(batch?.some(sql => /DELETE FROM auth_sessions WHERE username/.test(sql)));
    const user = await db.prepare('SELECT enable FROM users WHERE username = ?').bind('alice').first();
    assert.equal(Number(user.enable), 0);
    const session = await db.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE username = ?').bind('alice').first();
    assert.equal(Number(session.count), 0);
});

test('PUT users rejects oversized request bodies', async () => {
    const db = await createRouteDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const body = { username: 'alice', enable: false, padding: 'x'.repeat(17 * 1024) };

    const { response } = await callApi(db, '/api/users', {
        method: 'PUT',
        token: ADMIN_TOKEN,
        body,
    });

    assert.equal(response.status, 400);
});

test('DELETE users rejects empty and administrator usernames', async () => {
    const db = await createRouteDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    db.resetQueries();

    const empty = await callApi(db, '/api/users', { method: 'DELETE', token: ADMIN_TOKEN });
    assert.equal(empty.response.status, 400);
    const admin = await callApi(db, '/api/users?username=admin', { method: 'DELETE', token: ADMIN_TOKEN });
    assert.equal(admin.response.status, 400);
    assert.equal(db.countQueries(/DELETE FROM user_group_members|DELETE FROM users WHERE|UPDATE nodes SET username|DELETE FROM auth_sessions/), 0);
    const adminCount = await db.prepare('SELECT COUNT(*) AS count FROM users WHERE username = ?').bind(ADMIN_USER).first();
    assert.equal(Number(adminCount.count), 1);
});

test('verifyAuth rejects residual sessions for disabled users, cleans them, and still accepts admin', async () => {
    const db = await createRouteDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    await seedSession(db, 'alice', USER_TOKEN, 0);

    const denied = await callApi(db, '/api/data', { token: USER_TOKEN });
    assert.equal(denied.response.status, 401);
    const residual = await db.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE username = ?').bind('alice').first();
    assert.equal(Number(residual.count), 0);

    const admin = await callApi(db, '/api/data', { token: ADMIN_TOKEN });
    assert.equal(admin.response.status, 200);
});

test('verifyAuth rejects residual sessions for deleted users and clears them', async () => {
    const { verifyAuth } = __test;
    const db = await createRouteDb();
    await seedSession(db, 'alice', USER_TOKEN);
    await db.prepare("DELETE FROM users WHERE username = 'alice'").run();
    const env = { ADMIN_USERNAME: ADMIN_USER, ADMIN_PASSWORD };
    const request = requestFor('/api/data', { token: USER_TOKEN });

    assert.equal(await verifyAuth(request.headers.get('Authorization'), request, db, env), null);
    const residual = await db.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE username = ?').bind('alice').first();
    assert.equal(Number(residual.count), 0);
});

test('verifyAuth returns null and logs when session cleanup fails', async () => {
    const { verifyAuth } = __test;
    const db = await createRouteDb();
    await seedSession(db, 'alice', USER_TOKEN, 0);
    const env = { ADMIN_USERNAME: ADMIN_USER, ADMIN_PASSWORD };
    const request = requestFor('/api/data', { token: USER_TOKEN });
    const failures = [];
    const originalConsoleError = console.error;
    const prepare = db.prepare.bind(db);
    db.prepare = sql => {
        if (/^DELETE FROM auth_sessions WHERE username = \?$/.test(sql)) {
            return { bind: () => ({ run: async () => { throw new Error('D1 cleanup unavailable'); } }) };
        }
        return prepare(sql);
    };
    console.error = (...args) => failures.push(args);
    try {
        const result = await verifyAuth(request.headers.get('Authorization'), request, db, env);
        assert.equal(result, null);
    } finally {
        console.error = originalConsoleError;
    }
    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0], ['[auth] failed to revoke sessions', 'alice', new Error('D1 cleanup unavailable')]);
});

test('verifyAuth ordinary-user hot path performs a single SELECT', async () => {
    const { verifyAuth } = __test;
    const db = await createRouteDb();
    await seedSession(db, 'alice', USER_TOKEN);
    const env = { ADMIN_USERNAME: ADMIN_USER, ADMIN_PASSWORD };
    const request = requestFor('/api/data', { token: USER_TOKEN });
    db.resetQueries();

    const username = await verifyAuth(request.headers.get('Authorization'), request, db, env);

    assert.equal(username, 'alice');
    assert.equal(db.countQueries(/^SELECT\b/i), 1);
    assert.match(db.queries.find(sql => /^SELECT\b/i.test(sql)), /LEFT JOIN users\b/);
});

test('verifyAuth ensures the auth schema before querying a cold database', async () => {
    const { verifyAuth } = __test;
    const db = new TestD1();
    const env = { ADMIN_USERNAME: ADMIN_USER, ADMIN_PASSWORD };
    const request = requestFor('/api/data', { token: USER_TOKEN });

    const username = await verifyAuth(request.headers.get('Authorization'), request, db, env);

    assert.equal(username, null);
    assert.ok(db.countQueries(/CREATE TABLE IF NOT EXISTS auth_sessions/) > 0);
});

test('migrated database cold start authenticates Bearer data without DDL', async () => {
    const { ensureDbSchema } = __test;
    const raw = new DatabaseSync(':memory:');
    const setupDb = new TestD1(raw);
    await ensureDbSchema(setupDb);
    await seedSession(setupDb, ADMIN_USER, ADMIN_TOKEN);
    const coldDb = new TestD1(raw);

    const { response } = await callApi(coldDb, '/api/data', { token: ADMIN_TOKEN });

    assert.equal(response.status, 200);
    assert.equal(coldDb.countQueries(/CREATE TABLE|ALTER TABLE/i), 0);
});

test('ordinary-user data only returns VPS authorized by visible nodes or direct group grants', async () => {
    const db = await createRouteDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    await seedSession(db, 'alice', USER_TOKEN);
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) await seedServer(db, ip);
    await db.prepare('INSERT INTO nodes (id, uuid, vps_ip, protocol, port, username) VALUES (?, ?, ?, ?, ?, ?)')
        .bind('node-visible', 'uuid-visible', '198.51.100.1', 'VLESS', 443, 'alice')
        .run();
    await db.prepare('INSERT INTO user_groups (id, name, created_at) VALUES (?, ?, ?)')
        .bind('group-alice', 'Alice Group', Date.now())
        .run();
    await db.prepare('INSERT INTO user_group_members (group_id, username) VALUES (?, ?)')
        .bind('group-alice', 'alice')
        .run();
    await db.prepare("INSERT INTO user_group_resources (group_id, resource_type, resource_id) VALUES (?, 'vps', ?)")
        .bind('group-alice', '198.51.100.2')
        .run();

    const userData = await callApi(db, '/api/data', { token: USER_TOKEN });
    assert.equal(userData.response.status, 200);
    assert.deepEqual(userData.payload.servers.map(server => server.ip).sort(), ['198.51.100.1', '198.51.100.2']);
    assert.doesNotMatch(JSON.stringify(userData.payload), /198\.51\.100\.3/);

    const adminData = await callApi(db, '/api/data', { token: ADMIN_TOKEN });
    assert.equal(adminData.response.status, 200);
    assert.deepEqual(adminData.payload.servers.map(server => server.ip).sort(), ['198.51.100.1', '198.51.100.2', '198.51.100.3']);
});

test('ordinary-user data with no node or VPS grants returns an empty list from a bounded EXISTS query', async () => {
    const db = await createRouteDb();
    await seedSession(db, 'empty-user', EMPTY_USER_TOKEN);
    for (const ip of ['198.51.100.4', '198.51.100.5']) await seedServer(db, ip);
    db.resetQueries();

    const { response, payload } = await callApi(db, '/api/data', { token: EMPTY_USER_TOKEN });
    assert.equal(response.status, 200);
    assert.deepEqual(payload.servers, []);
    const serverQueries = db.prepared.filter(statement => /FROM servers\b/.test(statement.sql));
    assert.equal(serverQueries.length, 1);
    assert.equal(serverQueries[0].params.length, 3);
    assert.doesNotMatch(serverQueries[0].sql, /\bIN\s*\(/i);
});

test('ordinary-user data returns 105 authorized VPS with bounded SQL parameters', async () => {
    const db = await createRouteDb();
    await seedSession(db, 'alice', USER_TOKEN);
    const ips = Array.from({ length: 105 }, (_, index) => `10.20.${Math.floor(index / 250)}.${index % 250 + 1}`);
    for (const ip of ips) await seedServer(db, ip);
    await db.prepare('INSERT INTO user_groups (id, name, created_at) VALUES (?, ?, ?)')
        .bind('group-alice', 'Alice Group', Date.now())
        .run();
    await db.prepare('INSERT INTO user_group_members (group_id, username) VALUES (?, ?)')
        .bind('group-alice', 'alice')
        .run();
    for (const ip of ips) {
        await db.prepare("INSERT INTO user_group_resources (group_id, resource_type, resource_id) VALUES (?, 'vps', ?)")
            .bind('group-alice', ip)
            .run();
    }
    db.resetQueries();

    const { response, payload } = await callApi(db, '/api/data', { token: USER_TOKEN });
    assert.equal(response.status, 200);
    assert.equal(payload.servers.length, 105);
    assert.deepEqual(payload.servers.map(server => server.ip).sort(), [...ips].sort());

    const serverQueries = db.prepared.filter(statement => /FROM servers\b/.test(statement.sql));
    assert.equal(serverQueries.length, 1);
    assert.ok(serverQueries.every(statement => statement.params.length < 100));
    assert.doesNotMatch(serverQueries[0].sql, /\bIN\s*\(/i);
});

test('ordinary-user data masks only Reality server private keys', async () => {
    const db = await createRouteDb();
    await seedSession(db, 'alice', USER_TOKEN);
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    await seedServer(db, '198.51.100.60');
    const nodes = [
        { id: 'reality-vless', uuid: 'reality-uuid', vps_ip: '198.51.100.60', protocol: 'XTLS-Reality', port: 443, private_key: 'reality-private', public_key: 'reality-public', short_id: 'abcd1234', username: 'alice' },
        { id: 'reality', uuid: 'reality-plain-uuid', vps_ip: '198.51.100.60', protocol: 'Reality', port: 8443, private_key: 'plain-private', public_key: 'plain-public', short_id: '1234abcd', username: 'alice' },
        { id: 'reality-h2', uuid: 'h2-uuid', vps_ip: '198.51.100.60', protocol: 'H2-Reality', port: 8443, private_key: 'h2-private', public_key: 'h2-public', short_id: 'ef567890', username: 'alice' },
        { id: 'reality-grpc', uuid: 'grpc-uuid', vps_ip: '198.51.100.60', protocol: 'gRPC-Reality', port: 8444, private_key: 'grpc-private', public_key: 'grpc-public', short_id: '9876fedc', username: 'alice' },
        { id: 'shadowsocks', uuid: 'ss-uuid', vps_ip: '198.51.100.60', protocol: 'Shadowsocks2022', port: 9001, private_key: 'ss-password', username: 'alice' },
        { id: 'trojan', uuid: 'trojan-uuid', vps_ip: '198.51.100.60', protocol: 'Trojan', port: 9002, private_key: 'trojan-password', username: 'alice' },
    ];
    for (const node of nodes) await seedNode(db, node);

    const userData = await callApi(db, '/api/data', { token: USER_TOKEN });
    assert.equal(userData.response.status, 200);
    const byId = new Map(userData.payload.nodes.map(node => [node.id, node]));
    assert.equal(byId.get('reality-vless').private_key, '');
    assert.equal(byId.get('reality-vless').uuid, 'reality-uuid');
    assert.equal(byId.get('reality-vless').public_key, 'reality-public');
    assert.equal(byId.get('reality-vless').short_id, 'abcd1234');
    assert.equal(byId.get('reality').private_key, '');
    assert.equal(byId.get('reality-h2').private_key, '');
    assert.equal(byId.get('reality-grpc').private_key, '');
    assert.equal(byId.get('shadowsocks').private_key, 'ss-password');
    assert.equal(byId.get('trojan').private_key, 'trojan-password');

    const adminData = await callApi(db, '/api/data', { token: ADMIN_TOKEN });
    assert.equal(adminData.response.status, 200);
    assert.equal(adminData.payload.nodes.find(node => node.id === 'reality-vless').private_key, 'reality-private');
});

test('data loads every proxy slot configuration with one probe_settings query', async () => {
    const db = await createRouteDb();
    await seedSession(db, ADMIN_USER, ADMIN_TOKEN);
    const ips = Array.from({ length: 5 }, (_, index) => `203.0.113.${index + 1}`);
    for (const ip of ips) await seedServer(db, ip);
    await db.prepare("INSERT INTO probe_settings (key, value) VALUES ('proxy_slot_map', ?)")
        .bind(JSON.stringify({ port: 8000, public_listener: true }))
        .run();
    await db.prepare("INSERT INTO probe_settings (key, value) VALUES (?, ?)")
        .bind(`proxy_slot_map_${ips[0]}`, JSON.stringify({ port: 8101, public_listener: false }))
        .run();
    db.resetQueries();

    const { response, payload } = await callApi(db, '/api/data', { token: ADMIN_TOKEN });
    assert.equal(response.status, 200);
    assert.equal(payload.servers.length, 5);
    assert.equal(db.countQueries(/FROM probe_settings\b/), 1);
    const first = payload.servers.find(server => server.ip === ips[0]);
    const second = payload.servers.find(server => server.ip === ips[1]);
    assert.equal(first.proxy_public_port, 8101);
    assert.equal(first.proxy_public_listener, false);
    assert.equal(second.proxy_public_port, 8000);
    assert.equal(second.proxy_public_listener, true);
});

test('schema initialization writes the version without fetching GitHub seed data', async () => {
    const { ensureDbSchema, SCHEMA_VERSION } = __test;
    assert.equal(typeof ensureDbSchema, 'function');
    assert.ok(SCHEMA_VERSION);
    const db = new TestD1();
    const fetched = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
        fetched.push(args[0]);
        throw new Error('unexpected external fetch');
    };
    try {
        await ensureDbSchema(db);
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.equal(fetched.length, 0);
    assert.ok(db.countQueries(/CREATE TABLE|ALTER TABLE/) > 0);
    const version = db.database.prepare("SELECT val FROM sys_config WHERE key = 'schema_version'").get();
    assert.equal(version.val, String(SCHEMA_VERSION));
});

test('cached nodes seed runs on demand and never overwrites existing data', async () => {
    const { scheduleCachedNodesSeed } = __test;
    const db = await createRouteDb();
    const tasks = [];
    const fetched = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async url => {
        fetched.push(url);
        return new Response('{"seeded":true}', { status: 200 });
    };
    try {
        await scheduleCachedNodesSeed(db, { waitUntil: promise => tasks.push(promise) });
        await Promise.all(tasks);
        assert.equal(fetched.length, 1);
        const row = db.database.prepare("SELECT value FROM probe_settings WHERE key = 'cached_nodes_data'").get();
        assert.equal(row.value, '{"seeded":true}');

        await scheduleCachedNodesSeed(db, { waitUntil: promise => tasks.push(promise) });
        await Promise.all(tasks);
        assert.equal(fetched.length, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('cached nodes seed fills an existing empty row once and preserves non-empty data', async () => {
    const { scheduleCachedNodesSeed } = __test;
    const db = await createRouteDb();
    await db.prepare("INSERT INTO probe_settings (key, value) VALUES ('cached_nodes_data', '')").run();
    const tasks = [];
    const fetched = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async url => {
        fetched.push(url);
        return new Response('{"seeded":true}', { status: 200 });
    };
    try {
        await scheduleCachedNodesSeed(db, { waitUntil: promise => tasks.push(promise) });
        await Promise.all(tasks);
        assert.equal(fetched.length, 1);
        const seeded = db.database.prepare("SELECT value FROM probe_settings WHERE key = 'cached_nodes_data'").get();
        assert.equal(seeded.value, '{"seeded":true}');

        await scheduleCachedNodesSeed(db, { waitUntil: promise => tasks.push(promise) });
        await Promise.all(tasks);
        assert.equal(fetched.length, 1);

        await db.prepare("UPDATE probe_settings SET value = ? WHERE key = 'cached_nodes_data'")
            .bind('{"existing":true}')
            .run();
        await scheduleCachedNodesSeed(db, { waitUntil: promise => tasks.push(promise) });
        await Promise.all(tasks);
        assert.equal(fetched.length, 1);
        const preserved = db.database.prepare("SELECT value FROM probe_settings WHERE key = 'cached_nodes_data'").get();
        assert.equal(preserved.value, '{"existing":true}');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('a matching schema version performs one version read and no DDL on cold start', async () => {
    const { ensureDbSchema, SCHEMA_VERSION } = __test;
    const raw = new DatabaseSync(':memory:');
    const firstBoot = new TestD1(raw);
    await ensureDbSchema(firstBoot);
    raw.prepare("INSERT OR REPLACE INTO sys_config (key, val, ts) VALUES ('schema_version', ?, ?)")
        .run(String(SCHEMA_VERSION), Date.now());
    const coldBoot = new TestD1(raw);

    await ensureDbSchema(coldBoot);

    assert.equal(coldBoot.queries.length, 1);
    assert.match(coldBoot.queries[0], /SELECT val FROM sys_config WHERE key = 'schema_version'/);
    assert.equal(coldBoot.countQueries(/CREATE TABLE|ALTER TABLE/), 0);
});

test('an outdated schema version runs migrations and records the current version', async () => {
    const { ensureDbSchema, SCHEMA_VERSION } = __test;
    const raw = new DatabaseSync(':memory:');
    const firstBoot = new TestD1(raw);
    await ensureDbSchema(firstBoot);
    raw.prepare("UPDATE sys_config SET val = 'outdated' WHERE key = 'schema_version'").run();
    const upgradeBoot = new TestD1(raw);

    await ensureDbSchema(upgradeBoot);

    assert.ok(upgradeBoot.countQueries(/CREATE TABLE|ALTER TABLE/) > 0);
    const version = raw.prepare("SELECT val FROM sys_config WHERE key = 'schema_version'").get();
    assert.equal(version.val, String(SCHEMA_VERSION));
});

test('ensureDbSchema does not migrate when the version read fails for a non-missing-table error', async () => {
    const { ensureDbSchema } = __test;
    const raw = new DatabaseSync(':memory:');
    const db = new TestD1(raw);
    let failVersionRead = true;
    const prepare = db.prepare.bind(db);
    db.prepare = sql => {
        const statement = prepare(sql);
        if (/SELECT val FROM sys_config WHERE key = 'schema_version'/.test(sql) && failVersionRead) {
            return { first: async () => { throw new Error('network unavailable'); } };
        }
        return statement;
    };

    await assert.rejects(ensureDbSchema(db), /network unavailable/);
    assert.equal(db.countQueries(/CREATE TABLE|ALTER TABLE/), 0);

    failVersionRead = false;
    await ensureDbSchema(db);
    assert.ok(db.countQueries(/CREATE TABLE|ALTER TABLE/) > 0);
});

test('ensureDbSchema initializes the schema when the version table is missing', async () => {
    const { ensureDbSchema, SCHEMA_VERSION } = __test;
    const db = new TestD1();

    await ensureDbSchema(db);

    const version = db.database.prepare("SELECT val FROM sys_config WHERE key = 'schema_version'").get();
    assert.equal(version.val, String(SCHEMA_VERSION));
});

test('proxy slot map query uses a primary-key range and keeps empty overrides authoritative', async () => {
    const { getProxySlotConfigMap, resolveProxySlotConfig } = __test;
    const db = await createRouteDb();
    await db.prepare("INSERT INTO probe_settings (key, value) VALUES ('proxy_slot_map', ?)")
        .bind(JSON.stringify({ port: 8000 }))
        .run();
    await db.prepare("INSERT INTO probe_settings (key, value) VALUES (?, ?)")
        .bind('proxy_slot_map_198.51.100.20', '')
        .run();
    await db.prepare("INSERT INTO probe_settings (key, value) VALUES (?, ?)")
        .bind('proxy_slot_map_not-an-ip', JSON.stringify({ port: 8101 }))
        .run();
    db.resetQueries();

    const map = await getProxySlotConfigMap(db);

    assert.match(db.queries[0], /key >= 'proxy_slot_map_' AND key < 'proxy_slot_map`'/);
    assert.equal(map.overrides.has('198.51.100.20'), true);
    assert.equal(map.overrides.has('not-an-ip'), false);
    assert.deepEqual(resolveProxySlotConfig(map, '198.51.100.20'), {});
    assert.deepEqual(resolveProxySlotConfig(map, '198.51.100.21'), { port: 8000 });
});
