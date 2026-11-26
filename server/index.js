import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

import worker, { DashboardHub, VpsPresence } from '../src/worker.js';
import { createSqliteD1 } from './d1-sqlite.js';
import { createStaticAssetsBinding } from './assets.js';
import {
    createDurableObjectNamespace,
    installRuntimeGlobals,
    openDoStorageDb,
} from './runtime-shims.js';

const INTERNAL_REALTIME_POST_PATHS = new Set([
    '/public-policy',
    '/frequency-policy',
    '/notify',
    '/egress-refresh',
    '/route-test',
    '/session-revoke',
    '/api/realtime_auth',
]);

function parseOrigin(rawValue) {
    if (!rawValue) return '';
    try {
        const parsed = new URL(String(rawValue).trim());
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
        return parsed.origin;
    } catch {
        return '';
    }
}

function normalizeClientIp(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

function resolveClientIp(req, trustProxy) {
    if (trustProxy) {
        const realIp = normalizeClientIp(req.headers['x-real-ip']);
        if (realIp) return realIp;
        const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0];
        const forwardedIp = normalizeClientIp(forwarded);
        if (forwardedIp) return forwardedIp;
        const cfIp = normalizeClientIp(req.headers['cf-connecting-ip']);
        if (cfIp) return cfIp;
    }
    return normalizeClientIp(req.socket?.remoteAddress) || '127.0.0.1';
}

function resolveRequestOrigin(req, publicOrigin, trustProxy) {
    if (publicOrigin) return publicOrigin;
    const forwardedProto = trustProxy
        ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
        : '';
    const proto = forwardedProto === 'https' || forwardedProto === 'http' ? forwardedProto : 'http';
    const forwardedHost = trustProxy
        ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim()
        : '';
    const host = forwardedHost || String(req.headers.host || '127.0.0.1');
    return `${proto}://${host}`;
}

function buildHeaders(nodeHeaders, clientIp) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(nodeHeaders || {})) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
            for (const item of value) headers.append(key, item);
        } else {
            headers.set(key, String(value));
        }
    }
    if (clientIp) {
        headers.set('CF-Connecting-IP', clientIp);
    }
    return headers;
}

async function readIncomingBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return chunks.length > 0 ? Buffer.concat(chunks) : null;
}

function writeNodeResponse(res, response, isHead) {
    res.statusCode = response.status;
    res.statusMessage = response.statusText || '';

    const setCookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [];
    for (const [key, value] of response.headers.entries()) {
        if (key.toLowerCase() === 'set-cookie') continue;
        res.setHeader(key, value);
    }
    if (setCookies.length > 0) {
        res.setHeader('Set-Cookie', setCookies);
    }

    if (isHead || !response.body || response.status === 204 || response.status === 205 || response.status === 304) {
        response.body?.cancel().catch(() => {});
        res.end();
        return Promise.resolve();
    }

    return response.arrayBuffer().then((buffer) => {
        res.end(Buffer.from(buffer));
    });
}

async function writeUpgradeError(socket, response) {
    const status = response?.status || 500;
    const statusText = response?.statusText || http.STATUS_CODES[status] || 'Error';
    const body = response ? Buffer.from(await response.arrayBuffer()) : Buffer.from('Upgrade failed');
    const headerLines = [`HTTP/1.1 ${status} ${statusText}`];
    if (response?.headers) {
        for (const [key, value] of response.headers.entries()) {
            if (key.toLowerCase() === 'transfer-encoding' || key.toLowerCase() === 'content-length') continue;
            headerLines.push(`${key}: ${value}`);
        }
    }
    headerLines.push(`Content-Length: ${body.length}`);
    headerLines.push('Connection: close');
    socket.write(`${headerLines.join('\r\n')}\r\n\r\n`);
    socket.end(body);
}

function loadEnvVars(overrides = {}) {
    const defaults = {
        ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
        ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
        PROXY_USER: process.env.PROXY_USER || '',
        PROXY_PASS: process.env.PROXY_PASS || '',
        PROXY_PUBLIC_LISTENER: process.env.PROXY_PUBLIC_LISTENER || 'false',
        TG_BOT_TOKEN: process.env.TG_BOT_TOKEN || '',
        TG_CHAT_ID: process.env.TG_CHAT_ID || '',
        TG_WEBHOOK_SECRET: process.env.TG_WEBHOOK_SECRET || '',
        CRON_SECRET: process.env.CRON_SECRET || '',
        REALTIME_AUTH_SECRET: process.env.REALTIME_AUTH_SECRET || '',
    };
    const merged = { ...defaults, ...overrides };
    for (const [key, value] of Object.entries(merged)) {
        if (value === '') delete merged[key];
    }
    return merged;
}

export async function createSelfHostServer(options = {}) {
    installRuntimeGlobals();

    const host = options.host ?? process.env.HOST ?? '0.0.0.0';
    const port = options.port ?? Number(process.env.PORT || 8787);
    const dataDir = path.resolve(options.dataDir ?? process.env.DATA_DIR ?? './data');
    const staticDir = path.resolve(options.staticDir ?? process.env.STATIC_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../static'));
    const publicOrigin = parseOrigin(options.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? '');
    const trustProxy = options.trustProxy ?? (String(process.env.TRUST_PROXY ?? 'true').toLowerCase() !== 'false');
    const cronIntervalMs = options.cronIntervalMs ?? Number(process.env.CRON_INTERVAL_MS ?? 300000);

    const db = createSqliteD1(path.join(dataDir, 'kui.db'));
    const doStorageDb = openDoStorageDb(path.join(dataDir, 'do-state.db'));
    const assets = createStaticAssetsBinding(staticDir);

    const env = {
        ...loadEnvVars(options.envVars),
        DB: db,
        ASSETS: assets,
        VPS_PRESENCE: null,
        DASHBOARD_HUB: null,
    };
    env.VPS_PRESENCE = createDurableObjectNamespace(VpsPresence, {
        name: 'VpsPresence',
        getEnv: () => env,
        storageDb: doStorageDb,
    });
    env.DASHBOARD_HUB = createDurableObjectNamespace(DashboardHub, {
        name: 'DashboardHub',
        getEnv: () => env,
        storageDb: doStorageDb,
    });

    const pendingTasks = new Set();
    const createExecCtx = () => ({
        waitUntil(promise) {
            const tracked = Promise.resolve(promise)
                .catch(error => console.error('[selfhost] waitUntil error:', error?.stack || error))
                .finally(() => pendingTasks.delete(tracked));
            pendingTasks.add(tracked);
        },
        passThroughOnException() {},
    });

    const originalFetch = globalThis.fetch;
    if (publicOrigin) {
        globalThis.fetch = function selfHostFetch(input, init) {
            try {
                const targetUrl = new URL(input instanceof Request ? input.url : String(input));
                if (targetUrl.origin === publicOrigin && INTERNAL_REALTIME_POST_PATHS.has(targetUrl.pathname)) {
                    const internalReq = input instanceof Request ? input : new Request(input, init);
                    return worker.fetch(internalReq, env, createExecCtx());
                }
            } catch {}
            return originalFetch.call(this, input, init);
        };
    }

    const wss = new WebSocketServer({ noServer: true });
    const httpServer = http.createServer(async (req, res) => {
        try {
            const origin = resolveRequestOrigin(req, publicOrigin, trustProxy);
            const requestUrl = new URL(req.url || '/', origin);
            const method = (req.method || 'GET').toUpperCase();
            const clientIp = resolveClientIp(req, trustProxy);
            const headers = buildHeaders(req.headers, clientIp);
            const body = method === 'GET' || method === 'HEAD' ? null : await readIncomingBody(req);
            const request = new Request(requestUrl.toString(), {
                method,
                headers,
                body: body && body.length > 0 ? body : undefined,
            });
            const response = await worker.fetch(request, env, createExecCtx());
            await writeNodeResponse(res, response, method === 'HEAD');
        } catch (error) {
            console.error('[selfhost] HTTP handler error:', error?.stack || error);
            if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.end('Internal Server Error');
            } else {
                res.end();
            }
        }
    });

    httpServer.on('upgrade', async (req, socket, head) => {
        const abortUpgrade = () => socket.destroy();
        socket.once('error', abortUpgrade);
        try {
            const origin = resolveRequestOrigin(req, publicOrigin, trustProxy);
            const requestUrl = new URL(req.url || '/', origin);
            const clientIp = resolveClientIp(req, trustProxy);
            const headers = buildHeaders(req.headers, clientIp);
            const request = new Request(requestUrl.toString(), { method: 'GET', headers });
            const response = await worker.fetch(request, env, createExecCtx());

            if (response?.status === 101 && response.webSocket?._peer) {
                const serverSideSocket = response.webSocket._peer;
                if (socket.destroyed) {
                    serverSideSocket.close();
                    return;
                }
                wss.handleUpgrade(req, socket, head, (realWs) => {
                    socket.off('error', abortUpgrade);
                    serverSideSocket._attachRealSocket(realWs, serverSideSocket._doHandlers || {
                        getAutoResponse: () => null,
                        onMessage: () => {},
                        onClose: () => {},
                        onError: () => {},
                    });
                });
                return;
            }
            await writeUpgradeError(socket, response);
        } catch (error) {
            console.error('[selfhost] WebSocket upgrade error:', error?.stack || error);
            try { socket.destroy(); } catch {}
        }
    });

    const runScheduled = async () => {
        await worker.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *' }, env, createExecCtx());
    };

    let cronTimer = null;
    if (cronIntervalMs > 0) {
        cronTimer = setInterval(() => {
            runScheduled().catch(error => console.error('[selfhost] scheduled check error:', error?.stack || error));
        }, cronIntervalMs);
        cronTimer.unref?.();
    }

    await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => {
            httpServer.off('error', reject);
            resolve();
        });
    });

    const address = httpServer.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;

    let closed = false;
    const close = async () => {
        if (closed) return;
        closed = true;
        if (cronTimer) clearInterval(cronTimer);
        if (publicOrigin) globalThis.fetch = originalFetch;
        env.VPS_PRESENCE.closeAll();
        env.DASHBOARD_HUB.closeAll();
        for (const client of wss.clients) {
            try { client.terminate(); } catch {}
        }
        await new Promise(resolve => wss.close(resolve));
        await new Promise(resolve => httpServer.close(resolve));
        await Promise.allSettled(Array.from(pendingTasks));
        doStorageDb.close();
        db.close();
    };

    return {
        host,
        port: boundPort,
        env,
        runScheduled,
        close,
    };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
    const instance = await createSelfHostServer();
    console.log(`[kui-selfhost] listening on http://${instance.host}:${instance.port}`);
    const shutdown = async (signal) => {
        console.log(`[kui-selfhost] received ${signal}, shutting down...`);
        await instance.close();
        process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}
