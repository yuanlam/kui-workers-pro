import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

import { createSqliteD1 } from '../server/d1-sqlite.js';
import { createStaticAssetsBinding } from '../server/assets.js';
import { createSelfHostServer } from '../server/index.js';

function makeTempDir(prefix) {
    const base = os.tmpdir();
    fs.mkdirSync(base, { recursive: true });
    return fs.mkdtempSync(path.join(base, `${prefix}-`));
}

function nextWsMessage(ws, predicate = () => true, label = 'message', timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Timed out waiting for WebSocket ${label}`));
        }, timeoutMs);
        const onMessage = (raw) => {
            const text = raw.toString('utf8');
            if (predicate(text)) {
                cleanup();
                resolve(text);
            }
        };
        const onError = (err) => {
            cleanup();
            reject(err);
        };
        const cleanup = () => {
            clearTimeout(timer);
            ws.off('message', onMessage);
            ws.off('error', onError);
        };
        ws.on('message', onMessage);
        ws.on('error', onError);
    });
}

test('SqliteD1 supports bind, positional params, meta.changes, batch rollback, and ON DELETE CASCADE', async () => {
    const dir = makeTempDir('d1');
    const db = createSqliteD1(path.join(dir, 'test.db'));
    try {
        await db.batch([
            db.prepare('CREATE TABLE parents (id TEXT PRIMARY KEY, active INTEGER, note TEXT)'),
            db.prepare('CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, FOREIGN KEY(parent_id) REFERENCES parents(id) ON DELETE CASCADE)'),
        ]);

        const inserted = await db.prepare('INSERT INTO parents (id, active, note) VALUES (?1, ?2, ?3)')
            .bind('p1', true, undefined)
            .run();
        assert.equal(inserted.success, true);
        assert.equal(inserted.meta.changes, 1);

        const row = await db.prepare('SELECT id, active, note FROM parents WHERE id = ?').bind('p1').first();
        assert.deepEqual(row, { id: 'p1', active: 1, note: null });
        assert.equal(await db.prepare('SELECT active FROM parents WHERE id = ?').bind('p1').first('active'), 1);
        assert.equal(await db.prepare('SELECT id FROM parents WHERE id = ?').bind('missing').first(), null);

        await db.prepare('INSERT INTO children (id, parent_id) VALUES (?, ?)').bind('c1', 'p1').run();

        await assert.rejects(
            db.batch([
                db.prepare('INSERT INTO parents (id, active, note) VALUES (?, ?, ?)').bind('p2', 1, 'ok'),
                db.prepare('INSERT INTO parents (id, active, note) VALUES (?, ?, ?)').bind('p1', 1, 'dup'),
            ])
        );
        assert.equal(await db.prepare('SELECT id FROM parents WHERE id = ?').bind('p2').first(), null);

        const deleted = await db.prepare('DELETE FROM parents WHERE id = ?').bind('p1').run();
        assert.equal(deleted.meta.changes, 1);
        const remainingChildren = await db.prepare('SELECT id FROM children').all();
        assert.deepEqual(remainingChildren.results, []);
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('StaticAssetsBinding serves files with ETag/304/HEAD, accepts URL objects, and blocks traversal', async () => {
    const staticDir = path.resolve(process.cwd(), 'static');
    const assets = createStaticAssetsBinding(staticDir);

    const indexRes = await assets.fetch(new Request('https://kui.example.com/'));
    assert.equal(indexRes.status, 200);
    assert.match(indexRes.headers.get('Content-Type') || '', /text\/html/);
    const etag = indexRes.headers.get('ETag');
    assert.ok(etag);

    const notModified = await assets.fetch(new Request('https://kui.example.com/', {
        headers: { 'If-None-Match': etag },
    }));
    assert.equal(notModified.status, 304);

    const headRes = await assets.fetch(new Request('https://kui.example.com/', { method: 'HEAD' }));
    assert.equal(headRes.status, 200);
    assert.equal(await headRes.text(), '');

    const vpsAsset = await assets.fetch(new URL('/vps/agent.py', 'https://kui.example.com'));
    assert.equal(vpsAsset.status, 200);
    assert.ok((await vpsAsset.text()).length > 100);

    const traversal = await assets.fetch(new Request('https://kui.example.com/../../package.json'));
    assert.equal(traversal.status, 404);
});

test('SelfHostServer serves HTTP, persists SQLite data across restarts, and bridges realtime WebSockets', async () => {
    const dataDir = makeTempDir('selfhost');
    const adminPassword = 'StrongTestPassword!2026';
    const publicOrigin = 'https://kui.example.com';

    let server = await createSelfHostServer({
        host: '127.0.0.1',
        port: 0,
        dataDir,
        staticDir: path.resolve(process.cwd(), 'static'),
        publicOrigin,
        cronIntervalMs: 0,
        envVars: {
            ADMIN_USERNAME: 'admin',
            ADMIN_PASSWORD: adminPassword,
            PROXY_PUBLIC_LISTENER: 'false',
        },
    });

    let dashboardWs = null;
    let agentWs = null;
    try {
        const baseUrl = `http://127.0.0.1:${server.port}`;
        const wsBaseUrl = `ws://127.0.0.1:${server.port}`;

        const healthRes = await fetch(`${baseUrl}/health`);
        assert.equal(healthRes.status, 200);
        assert.deepEqual(await healthRes.json(), { ok: true, service: 'kui-realtime', version: 1 });

        const homeRes = await fetch(`${baseUrl}/`);
        assert.equal(homeRes.status, 200);
        assert.equal(homeRes.headers.get('X-Frame-Options'), 'DENY');
        assert.equal(homeRes.headers.get('Cache-Control'), 'no-cache, must-revalidate');

        const blockedVps = await fetch(`${baseUrl}/vps/agent.py`);
        assert.equal(blockedVps.status, 404);

        const loginRes = await fetch(`${baseUrl}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Real-IP': '203.0.113.10' },
            body: JSON.stringify({ username: 'admin', password: adminPassword }),
        });
        assert.equal(loginRes.status, 200);
        const loginBody = await loginRes.json();
        assert.equal(loginBody.success, true);
        assert.ok(loginBody.token);
        const authHeader = { Authorization: `Bearer ${loginBody.token}` };

        const addVpsRes = await fetch(`${baseUrl}/api/vps`, {
            method: 'POST',
            headers: { ...authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'SG-Test', ip: '198.51.100.25' }),
        });
        assert.equal(addVpsRes.status, 200);

        const dataRes = await fetch(`${baseUrl}/api/data`, { headers: authHeader });
        assert.equal(dataRes.status, 200);
        const dataBody = await dataRes.json();
        assert.equal(dataBody.servers.length, 1);
        assert.equal(dataBody.servers[0].ip, '198.51.100.25');
        assert.equal(dataBody.realtimeUrl, publicOrigin);

        const agentTokenRow = await server.env.DB.prepare('SELECT agent_token FROM servers WHERE ip = ?')
            .bind('198.51.100.25')
            .first();
        assert.ok(agentTokenRow?.agent_token);

        const ticketRes = await fetch(`${baseUrl}/dashboard/ticket`, {
            method: 'POST',
            headers: { ...authHeader, Origin: publicOrigin },
        });
        assert.equal(ticketRes.status, 200);
        const { ticket } = await ticketRes.json();
        assert.ok(ticket);

        dashboardWs = new WebSocket(`${wsBaseUrl}/dashboard/ws?ticket=${encodeURIComponent(ticket)}`, {
            headers: { Origin: publicOrigin },
        });
        const snapshotRaw = await nextWsMessage(dashboardWs, text => text.includes('"type":"snapshot"'), 'dashboard snapshot');
        const snapshotMsg = JSON.parse(snapshotRaw);
        assert.equal(snapshotMsg.type, 'snapshot');

        const pongPromise = nextWsMessage(dashboardWs, text => text === 'pong', 'dashboard pong');
        dashboardWs.send('ping');
        assert.equal(await pongPromise, 'pong');

        agentWs = new WebSocket(`${wsBaseUrl}/agent/ws?ip=198.51.100.25&role=core`, {
            headers: { Authorization: agentTokenRow.agent_token },
        });
        const helloRaw = await nextWsMessage(agentWs, text => text.includes('"type":"hello.ok"'), 'agent hello.ok');
        assert.equal(JSON.parse(helloRaw).role, 'core');

        const liveUpdatePromise = nextWsMessage(dashboardWs, text => text.includes('198.51.100.25') && text.includes('"cpu":12.5'), 'dashboard live patch');
        agentWs.send(JSON.stringify({
            type: 'status',
            ip: '198.51.100.25',
            role: 'core',
            seq: 1,
            boot_id: 'boot-test-1',
            ts: Date.now(),
            data: { cpu: 12.5, mem: 33.0, disk: 20.0, load: '0.10', uptime: '1d', net_in_speed: 100, net_out_speed: 200, tcp_conn: 5, udp_conn: 1 },
        }));
        const liveUpdate = JSON.parse(await liveUpdatePromise);
        assert.equal(liveUpdate.type, 'patch');
        assert.equal(liveUpdate.data.ip, '198.51.100.25');
        assert.equal(liveUpdate.data.core.cpu, 12.5);

        await server.runScheduled();

        dashboardWs.close();
        agentWs.close();
        dashboardWs = null;
        agentWs = null;
        await server.close();
        server = null;

        server = await createSelfHostServer({
            host: '127.0.0.1',
            port: 0,
            dataDir,
            staticDir: path.resolve(process.cwd(), 'static'),
            publicOrigin,
            cronIntervalMs: 0,
            envVars: {
                ADMIN_USERNAME: 'admin',
                ADMIN_PASSWORD: adminPassword,
                PROXY_PUBLIC_LISTENER: 'false',
            },
        });
        const restartedDataRes = await fetch(`http://127.0.0.1:${server.port}/api/data`, { headers: authHeader });
        assert.equal(restartedDataRes.status, 200);
        const restartedData = await restartedDataRes.json();
        assert.equal(restartedData.servers.length, 1);
        assert.equal(restartedData.servers[0].name, 'SG-Test');
    } finally {
        if (dashboardWs) try { dashboardWs.close(); } catch {}
        if (agentWs) try { agentWs.close(); } catch {}
        if (server) await server.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});
