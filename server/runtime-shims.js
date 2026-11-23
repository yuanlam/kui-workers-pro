import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const MAX_ATTACHMENT_BYTES = 2048;
const NativeResponse = globalThis.Response;

export class LocalWebSocket {
    constructor() {
        this.readyState = 1;
        this._attachment = null;
        this._realSocket = null;
        this._pendingOutgoing = [];
        this._peer = null;
        this._onCloseHook = null;
        this._closed = false;
    }

    serializeAttachment(value) {
        if (value === undefined || value === null) {
            this._attachment = null;
            return;
        }
        const encoded = JSON.stringify(value);
        if (Buffer.byteLength(encoded, 'utf8') > MAX_ATTACHMENT_BYTES) {
            throw new Error(`WebSocket attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
        }
        this._attachment = encoded;
    }

    deserializeAttachment() {
        if (this._attachment === null) return null;
        return JSON.parse(this._attachment);
    }

    send(data) {
        if (this._closed || this.readyState !== 1) return;
        if (this._realSocket) {
            if (this._realSocket.readyState === 1) {
                this._realSocket.send(data);
            }
            return;
        }
        this._pendingOutgoing.push(data);
    }

    close(code = 1000, reason = '') {
        if (this._closed) return;
        this._closed = true;
        this.readyState = 3;
        this._pendingOutgoing.length = 0;
        const hook = this._onCloseHook;
        this._onCloseHook = null;
        if (hook) hook(this);
        if (this._realSocket) {
            const socket = this._realSocket;
            this._realSocket = null;
            try {
                if (socket.readyState === 0 || socket.readyState === 1) {
                    socket.close(code, reason);
                }
            } catch {}
        }
    }

    _attachRealSocket(realSocket, handlers) {
        if (this._closed) {
            try { realSocket.close(1000, 'closed'); } catch {}
            return;
        }
        this._realSocket = realSocket;

        while (this._pendingOutgoing.length > 0) {
            const message = this._pendingOutgoing.shift();
            if (realSocket.readyState === 1) {
                realSocket.send(message);
            }
        }

        realSocket.on('message', (data, isBinary) => {
            if (this._closed) return;
            const payload = isBinary
                ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
                : data.toString('utf8');
            const autoResponse = handlers.getAutoResponse();
            if (!isBinary && autoResponse && payload === autoResponse.request) {
                if (realSocket.readyState === 1) realSocket.send(autoResponse.response);
                return;
            }
            handlers.onMessage(this, payload);
        });

        realSocket.on('close', (code, reasonBuffer) => {
            if (this._closed) return;
            this._closed = true;
            this.readyState = 3;
            this._realSocket = null;
            const hook = this._onCloseHook;
            this._onCloseHook = null;
            if (hook) hook(this);
            const reason = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString('utf8') : String(reasonBuffer || '');
            handlers.onClose(this, code, reason, code === 1000);
        });

        realSocket.on('error', (error) => {
            handlers.onError(this, error);
        });
    }
}

export class LocalWebSocketPair {
    constructor() {
        const client = new LocalWebSocket();
        const server = new LocalWebSocket();
        client._peer = server;
        server._peer = client;
        this[0] = client;
        this[1] = server;
    }
}

export class LocalWebSocketRequestResponsePair {
    constructor(request, response) {
        this.request = String(request);
        this.response = String(response);
    }
}

export class WebSocketUpgradeResponse {
    constructor(init = {}) {
        this.status = 101;
        this.statusText = 'Switching Protocols';
        this.ok = false;
        this.headers = new Headers(init.headers || {});
        this.webSocket = init.webSocket || null;
        this.body = null;
    }
}

function parseCacheMaxAgeSeconds(headers) {
    const cacheControl = headers.get('Cache-Control') || '';
    if (/\b(?:no-store|no-cache|private)\b/i.test(cacheControl)) return 0;
    const sharedMatch = /\bs-maxage=(\d+)/i.exec(cacheControl);
    if (sharedMatch) return Number(sharedMatch[1]);
    const maxAgeMatch = /\bmax-age=(\d+)/i.exec(cacheControl);
    if (maxAgeMatch) return Number(maxAgeMatch[1]);
    return 60;
}

export function createMemoryCache() {
    const store = new Map();

    function cacheKey(requestOrUrl) {
        return requestOrUrl instanceof Request ? requestOrUrl.url : String(requestOrUrl);
    }

    return {
        async match(requestOrUrl) {
            const key = cacheKey(requestOrUrl);
            const entry = store.get(key);
            if (!entry) return undefined;
            if (entry.expiresAt <= Date.now()) {
                store.delete(key);
                return undefined;
            }
            return new NativeResponse(entry.body, {
                status: entry.status,
                statusText: entry.statusText,
                headers: new Headers(entry.headers),
            });
        },

        async put(requestOrUrl, response) {
            const key = cacheKey(requestOrUrl);
            const ttlSeconds = parseCacheMaxAgeSeconds(response.headers);
            if (ttlSeconds <= 0) return;
            const body = Buffer.from(await response.arrayBuffer());
            store.set(key, {
                status: response.status,
                statusText: response.statusText,
                headers: Array.from(response.headers.entries()),
                body,
                expiresAt: Date.now() + ttlSeconds * 1000,
            });
            if (store.size > 256) {
                const oldestKey = store.keys().next().value;
                if (oldestKey !== undefined) store.delete(oldestKey);
            }
        },

        async delete(requestOrUrl) {
            return store.delete(cacheKey(requestOrUrl));
        },
    };
}

let shimsInstalled = false;

export function installRuntimeGlobals() {
    if (!globalThis.WebSocketPair) {
        globalThis.WebSocketPair = LocalWebSocketPair;
    }
    if (!globalThis.WebSocketRequestResponsePair) {
        globalThis.WebSocketRequestResponsePair = LocalWebSocketRequestResponsePair;
    }
    if (!globalThis.caches) {
        globalThis.caches = { default: createMemoryCache() };
    }
    if (!shimsInstalled) {
        shimsInstalled = true;
        globalThis.Response = new Proxy(NativeResponse, {
            construct(target, args, newTarget) {
                const init = args[1];
                if (init && init.status === 101 && init.webSocket) {
                    return new WebSocketUpgradeResponse(init);
                }
                return Reflect.construct(target, args, newTarget === globalThis.Response ? target : newTarget);
            },
        });
    }
}

export function openDoStorageDb(dbPath) {
    if (dbPath !== ':memory:') {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    const db = new DatabaseSync(dbPath);
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS do_kv (
            object_key TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (object_key, key)
        );
        CREATE TABLE IF NOT EXISTS do_alarms (
            object_key TEXT PRIMARY KEY,
            scheduled_at INTEGER NOT NULL
        );
    `);
    return db;
}

export function createDurableObjectNamespace(ClassCtor, { name, getEnv, storageDb }) {
    const instances = new Map();

    function getOrCreateEntry(objectKey) {
        let entry = instances.get(objectKey);
        if (entry) return entry;

        const activeSockets = new Map();
        let autoResponsePair = null;
        let alarmTimer = null;
        let concurrencyGate = Promise.resolve();
        let closed = false;

        const scheduleAlarmTimer = (timestampMs) => {
            if (alarmTimer) {
                clearTimeout(alarmTimer);
                alarmTimer = null;
            }
            if (closed || !Number.isFinite(timestampMs)) return;
            const delay = Math.max(0, Math.min(timestampMs - Date.now(), 2147483647));
            alarmTimer = setTimeout(async () => {
                alarmTimer = null;
                if (closed) return;
                try {
                    storageDb.prepare('DELETE FROM do_alarms WHERE object_key = ?').run(objectKey);
                } catch {}
                if (typeof entry.instance?.alarm === 'function') {
                    try {
                        await concurrencyGate;
                        await entry.instance.alarm();
                    } catch (error) {
                        console.error(`[selfhost] DO alarm error (${objectKey}):`, error?.stack || error);
                    }
                }
            }, delay);
            alarmTimer.unref?.();
        };

        const storage = {
            async get(keyOrKeys) {
                if (Array.isArray(keyOrKeys)) {
                    const map = new Map();
                    const stmt = storageDb.prepare('SELECT value FROM do_kv WHERE object_key = ? AND key = ?');
                    for (const key of keyOrKeys) {
                        const row = stmt.get(objectKey, String(key));
                        if (row) map.set(key, JSON.parse(row.value));
                    }
                    return map;
                }
                const row = storageDb.prepare('SELECT value FROM do_kv WHERE object_key = ? AND key = ?')
                    .get(objectKey, String(keyOrKeys));
                return row ? JSON.parse(row.value) : undefined;
            },

            async put(keyOrEntries, value) {
                const stmt = storageDb.prepare(
                    'INSERT INTO do_kv (object_key, key, value) VALUES (?, ?, ?) ON CONFLICT(object_key, key) DO UPDATE SET value = excluded.value'
                );
                if (keyOrEntries && typeof keyOrEntries === 'object' && !Array.isArray(keyOrEntries)) {
                    storageDb.exec('BEGIN IMMEDIATE');
                    try {
                        for (const [k, v] of Object.entries(keyOrEntries)) {
                            stmt.run(objectKey, String(k), JSON.stringify(v));
                        }
                        storageDb.exec('COMMIT');
                    } catch (error) {
                        try { storageDb.exec('ROLLBACK'); } catch {}
                        throw error;
                    }
                    return;
                }
                stmt.run(objectKey, String(keyOrEntries), JSON.stringify(value));
            },

            async delete(keyOrKeys) {
                const stmt = storageDb.prepare('DELETE FROM do_kv WHERE object_key = ? AND key = ?');
                if (Array.isArray(keyOrKeys)) {
                    let deleted = 0;
                    storageDb.exec('BEGIN IMMEDIATE');
                    try {
                        for (const key of keyOrKeys) {
                            deleted += Number(stmt.run(objectKey, String(key)).changes || 0);
                        }
                        storageDb.exec('COMMIT');
                    } catch (error) {
                        try { storageDb.exec('ROLLBACK'); } catch {}
                        throw error;
                    }
                    return deleted;
                }
                return Number(stmt.run(objectKey, String(keyOrKeys)).changes || 0) > 0;
            },

            async list(options = {}) {
                const prefix = options?.prefix ? String(options.prefix) : '';
                const limit = Number.isInteger(options?.limit) && options.limit > 0 ? options.limit : null;
                let rows;
                if (prefix) {
                    const sql = limit
                        ? 'SELECT key, value FROM do_kv WHERE object_key = ? AND key >= ? AND key < ? ORDER BY key ASC LIMIT ?'
                        : 'SELECT key, value FROM do_kv WHERE object_key = ? AND key >= ? AND key < ? ORDER BY key ASC';
                    const endPrefix = `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`;
                    rows = limit
                        ? storageDb.prepare(sql).all(objectKey, prefix, endPrefix, limit)
                        : storageDb.prepare(sql).all(objectKey, prefix, endPrefix);
                } else {
                    const sql = limit
                        ? 'SELECT key, value FROM do_kv WHERE object_key = ? ORDER BY key ASC LIMIT ?'
                        : 'SELECT key, value FROM do_kv WHERE object_key = ? ORDER BY key ASC';
                    rows = limit
                        ? storageDb.prepare(sql).all(objectKey, limit)
                        : storageDb.prepare(sql).all(objectKey);
                }
                const result = new Map();
                for (const row of rows) {
                    result.set(row.key, JSON.parse(row.value));
                }
                return result;
            },

            async setAlarm(scheduledTime) {
                const timestampMs = scheduledTime instanceof Date ? scheduledTime.getTime() : Number(scheduledTime);
                storageDb.prepare(
                    'INSERT INTO do_alarms (object_key, scheduled_at) VALUES (?, ?) ON CONFLICT(object_key) DO UPDATE SET scheduled_at = excluded.scheduled_at'
                ).run(objectKey, timestampMs);
                scheduleAlarmTimer(timestampMs);
            },

            async getAlarm() {
                const row = storageDb.prepare('SELECT scheduled_at FROM do_alarms WHERE object_key = ?').get(objectKey);
                return row ? Number(row.scheduled_at) : null;
            },

            async deleteAlarm() {
                if (alarmTimer) {
                    clearTimeout(alarmTimer);
                    alarmTimer = null;
                }
                storageDb.prepare('DELETE FROM do_alarms WHERE object_key = ?').run(objectKey);
            },
        };

        const ctx = {
            id: { toString: () => objectKey, name: objectKey },
            storage,
            blockConcurrencyWhile(callback) {
                const next = concurrencyGate.then(() => callback());
                concurrencyGate = next.catch(() => {});
                return next;
            },
            setWebSocketAutoResponse(pair) {
                autoResponsePair = pair || null;
            },
            acceptWebSocket(socket, tags = []) {
                const tagSet = new Set(Array.isArray(tags) ? tags : []);
                activeSockets.set(socket, tagSet);
                socket._onCloseHook = (closedSocket) => {
                    activeSockets.delete(closedSocket);
                };
                socket._doHandlers = {
                    getAutoResponse: () => autoResponsePair,
                    onMessage: async (ws, message) => {
                        if (typeof entry.instance?.webSocketMessage === 'function') {
                            try {
                                await concurrencyGate;
                                await entry.instance.webSocketMessage(ws, message);
                            } catch (error) {
                                console.error(`[selfhost] DO webSocketMessage error (${objectKey}):`, error?.stack || error);
                            }
                        }
                    },
                    onClose: async (ws, code, reason, wasClean) => {
                        if (typeof entry.instance?.webSocketClose === 'function') {
                            try {
                                await concurrencyGate;
                                await entry.instance.webSocketClose(ws, code, reason, wasClean);
                            } catch (error) {
                                console.error(`[selfhost] DO webSocketClose error (${objectKey}):`, error?.stack || error);
                            }
                        }
                    },
                    onError: async (ws, error) => {
                        if (typeof entry.instance?.webSocketError === 'function') {
                            try {
                                await concurrencyGate;
                                await entry.instance.webSocketError(ws, error);
                            } catch (err) {
                                console.error(`[selfhost] DO webSocketError error (${objectKey}):`, err?.stack || err);
                            }
                        }
                    },
                };
            },
            getWebSockets(tag) {
                const list = [];
                for (const [socket, tags] of activeSockets.entries()) {
                    if (socket.readyState !== 1) continue;
                    if (tag === undefined || tags.has(tag)) {
                        list.push(socket);
                    }
                }
                return list;
            },
            waitUntil(promise) {
                Promise.resolve(promise).catch(() => {});
            },
        };

        entry = {
            ctx,
            instance: null,
            async fetch(request) {
                await concurrencyGate;
                return entry.instance.fetch(request);
            },
            close() {
                closed = true;
                if (alarmTimer) {
                    clearTimeout(alarmTimer);
                    alarmTimer = null;
                }
                for (const socket of Array.from(activeSockets.keys())) {
                    socket.close(1001, 'server shutdown');
                }
                activeSockets.clear();
            },
        };

        entry.instance = new ClassCtor(ctx, getEnv());
        instances.set(objectKey, entry);

        const pendingAlarm = storageDb.prepare('SELECT scheduled_at FROM do_alarms WHERE object_key = ?').get(objectKey);
        if (pendingAlarm) {
            scheduleAlarmTimer(Number(pendingAlarm.scheduled_at));
        }

        return entry;
    }

    return {
        idFromName(idName) {
            const key = `${name}:${String(idName)}`;
            return { name: String(idName), toString: () => key };
        },
        newUniqueId() {
            const key = `${name}:${crypto.randomUUID()}`;
            return { toString: () => key };
        },
        get(id) {
            const objectKey = typeof id === 'string' ? id : id.toString();
            return {
                fetch(input, init) {
                    const request = input instanceof Request ? input : new Request(input, init);
                    return getOrCreateEntry(objectKey).fetch(request);
                },
            };
        },
        closeAll() {
            for (const entry of instances.values()) {
                entry.close();
            }
            instances.clear();
        },
    };
}
