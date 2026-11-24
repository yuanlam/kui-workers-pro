import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import test from 'node:test';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const frontendSource = read('../frontend/src/composables/useKuiState.js');

const hook = module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') {
      return {
        url: 'data:text/javascript,export class DurableObject%20{%20constructor(ctx,state)%20{%20this.ctx=ctx;this.env=state;%20}%20}',
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const realtime = await import('../realtime/src/index.js');
hook.deregister();

const utf8Size = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

globalThis.document = globalThis.document || {
  createElement: () => ({ content: {}, set innerHTML(value) { this.content = { textContent: value }; } }),
  createElementNS: () => ({}),
  createTextNode: () => ({}),
  querySelector: () => null,
};

class StorageMock {
  constructor(entries = []) { this.map = new Map(entries); this.puts = 0; }
  async get(key) { return this.map.get(key); }
  async put(key, value) { this.puts += 1; this.map.set(key, structuredClone(value)); }
  async delete(key) { this.map.delete(key); }
  async list() { return new Map(this.map); }
  async setAlarm() {}
}

class WebSocketMock {
  constructor(attachment = null) { this.attachment = attachment; this.sent = []; }
  serializeAttachment(value) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return this.attachment ? structuredClone(this.attachment) : null; }
  send(value) { this.sent.push(value); }
  close() {}
}

function dbMock() {
  return {
    prepare: () => ({ bind: () => ({ first: async () => null }) }),
    batch: async () => [],
  };
}

function context({ sockets = {}, storage = new StorageMock() } = {}) {
  const ctx = {
    storage,
    sockets,
    getWebSockets(tag) {
      if (!tag) return Object.values(sockets).flat();
      return sockets[tag] || [];
    },
    acceptWebSocket() {},
    setWebSocketAutoResponse() {},
    blockConcurrencyWhile(fn) {
      const result = fn();
      ctx.ready = Promise.resolve(result);
      return result;
    },
  };
  return ctx;
}

function presence({ sockets = {}, storage = new StorageMock(), hubActive = false, interval = 30000 } = {}) {
  const hub = {
    idFromName: name => name,
    get: () => ({
      fetch: async request => {
        if (new URL(request.url).pathname === '/active') return Response.json({ active: hubActive, interval_seconds: interval / 1000, until: Date.now() + 90000 });
        return Response.json({ success: true });
      },
    }),
  };
  const ctx = context({ sockets, storage });
  const object = new realtime.VpsPresence(ctx, { DASHBOARD_HUB: hub, DB: dbMock() });
  object.ready = ctx.ready || Promise.resolve();
  return object;
}

function livePresence(requests = []) {
  const hub = {
    idFromName: name => name,
    get: () => ({
      fetch: async request => {
        requests.push(request.url);
        const url = new URL(request.url);
        if (url.pathname === '/active') return Response.json({ active: false, interval_seconds: 30, until: 0 });
        return Response.json({ success: true });
      },
    }),
  };
  const ctx = context();
  return { ctx, requests, hub, object: new realtime.VpsPresence(ctx, { DASHBOARD_HUB: hub, DB: dbMock() }) };
}

function proxyState() {
  return {
    details: [{ tunnel: 'residential', active: true, node_ip: '198.51.100.8', exit_ip: '203.0.113.9', country: 'US', port: 7920, ready: true, connected_time: 60 }],
    logs: 'proxy-log-line '.repeat(1200).slice(0, 16 * 1024),
  };
}

function coreState() {
  return {
    cpu: 12.5, mem: 33.3, disk: 44.4, load: 0.5, uptime: 3600,
    net_in_speed: 123, net_out_speed: 456, tcp_conn: 7, udp_conn: 8, os: 'Debian', arch: 'x86_64',
    warp: {
      configured: true, active_mode: 'warp_dual', peer_address: '162.159.192.1', peer_port: 2408, peer_family: 'ipv4', tunnel_ipv4: '172.16.0.2', tunnel_ipv6: '2606:4700::2',
      optimizer: {
        status: 'idle', stage: 'complete', policy: 'manual', progress: 100,
        candidates: Array.from({ length: 48 }, (_, index) => ({
          address: `162.159.192.${index + 1}`, port: 2408, family: 'ipv4', current: index === 0, refined: true, success: true, latency_ms: index + 10, loss_pct: 0, colo: 'HKG', exit_ipv4: '203.0.113.10', exit_ipv6: '', error: '',
        })),
        recommended: { address: '162.159.192.1', port: 2408, refined: true, success: true },
        previous: { address: '162.159.193.1', port: 2408 },
        history: Array.from({ length: 12 }, (_, index) => ({ at: 1700000000000 + index, from_address: '162.159.193.1', from_port: 2408, to_address: '162.159.192.1', to_port: 2408, reason: 'manual', success: true })),
        error: '', last_scan_at: 1700000000000, updated_at: 1700000000000,
      },
    },
  };
}

async function sendStatus(object, role, data, { seq = 1, bootId = `${role}-boot`, ip = '203.0.113.8' } = {}) {
  const ws = new WebSocketMock({ ip, role, connected_at: Date.now(), bootId: '', lastSeq: -1, lastSeen: 0 });
  object.ctx.sockets[role] = [ws];
  object.ctx.getWebSockets = tag => {
    if (!tag) return Object.values(object.ctx.sockets).flat();
    return object.ctx.sockets[tag] || [];
  };
  await object.webSocketMessage(ws, JSON.stringify({ role, ip, seq, boot_id: bootId, type: 'status', data }));
  return ws;
}

test('attachments stay lightweight and DO storage restores full role state', async () => {
  const storage = new StorageMock();
  const object = presence({ storage });
  const proxyWs = await sendStatus(object, 'proxy', proxyState(), { seq: 1 });
  const coreWs = await sendStatus(object, 'core', coreState(), { seq: 1 });
  for (const ws of [proxyWs, coreWs]) {
    const attachment = ws.deserializeAttachment();
    assert.ok(!Object.hasOwn(attachment, 'state'), 'attachment must not carry full role state');
    assert.ok(utf8Size(attachment) < 512, `attachment is ${utf8Size(attachment)} bytes`);
    assert.deepEqual(Object.keys(attachment).sort(), ['bootId', 'connected_at', 'ip', 'lastSeen', 'lastSeq', 'role'].sort());
  }
  const persisted = await storage.get('state');
  assert.equal(persisted.snapshot.proxy.logs.length, 16 * 1024);
  assert.equal(persisted.snapshot.core.warp.optimizer.candidates.length, 48);

  const restoredStorage = new StorageMock();
  for (const [key, value] of storage.map) restoredStorage.map.set(key, value);
  const sockets = {
    proxy: [new WebSocketMock(proxyWs.deserializeAttachment())],
    core: [new WebSocketMock(coreWs.deserializeAttachment())],
  };
  const restored = presence({ storage: restoredStorage, sockets });
  await restored.ready;
  const snapshot = await restored.publicSnapshot();
  assert.equal(snapshot.proxy.logs.length, 16 * 1024);
  assert.equal(snapshot.core.warp.optimizer.candidates.length, 48);
  assert.deepEqual(snapshot.core.warp.optimizer.history.length, 12);
  assert.equal(snapshot.ip, '203.0.113.8');
});

test('proxy speed telemetry survives compaction and hibernation without inflating attachments', async () => {
  const storage = new StorageMock();
  const object = presence({ storage });
  await object.ready;
  const state = proxyState();
  Object.assign(state.details[0], { ttfb_ms: 245, speed_kbps: 8_123.5, ready: true });

  const proxyWs = await sendStatus(object, 'proxy', state, { seq: 1 });
  const detail = object.snapshot.proxy.details[0];
  assert.equal(detail.ttfb_ms, 245);
  assert.equal(detail.speed_kbps, 8_123.5);
  assert.equal(detail.ready, true);

  const attachment = proxyWs.deserializeAttachment();
  assert.ok(!Object.hasOwn(attachment, 'state'));
  assert.ok(!Object.hasOwn(attachment, 'details'));
  assert.ok(utf8Size(attachment) < 512, `attachment is ${utf8Size(attachment)} bytes`);
  assert.deepEqual(Object.keys(attachment).sort(), ['bootId', 'connected_at', 'ip', 'lastSeen', 'lastSeq', 'role'].sort());

  const persisted = await storage.get('state');
  assert.equal(persisted.snapshot.proxy.details[0].ttfb_ms, 245);
  assert.equal(persisted.snapshot.proxy.details[0].speed_kbps, 8_123.5);

  const restored = presence({
    storage: new StorageMock([...storage.map]),
    sockets: { proxy: [new WebSocketMock(attachment)] },
  });
  await restored.ready;
  const snapshot = await restored.publicSnapshot();
  assert.equal(snapshot.proxy.details[0].ttfb_ms, 245);
  assert.equal(snapshot.proxy.details[0].speed_kbps, 8_123.5);
  assert.equal(snapshot.proxy.details[0].ready, true);
});

test('proxy telemetry rejects out-of-range values and keeps legacy agents compatible', async () => {
  const object = presence();
  await object.ready;
  const state = proxyState();
  state.details[0] = {
    tunnel: 'residential',
    active: true,
    node_ip: '198.51.100.8',
    exit_ip: '203.0.113.9',
    country: 'US',
    port: 7920,
    ttfb_ms: 60_001,
    speed_kbps: -1,
    ready: 'yes',
  };
  await sendStatus(object, 'proxy', state, { seq: 1 });
  assert.equal(object.snapshot.proxy.details[0].ttfb_ms, null);
  assert.equal(object.snapshot.proxy.details[0].speed_kbps, null);
  assert.equal(object.snapshot.proxy.details[0].ready, false);

  state.details[0] = {
    tunnel: 'residential',
    active: true,
    node_ip: '198.51.100.8',
    exit_ip: '203.0.113.9',
    country: 'US',
    port: 7920,
  };
  await sendStatus(object, 'proxy', state, { seq: 2 });
  assert.equal(object.snapshot.proxy.details[0].ttfb_ms, null);
  assert.equal(object.snapshot.proxy.details[0].speed_kbps, null);
  assert.equal(object.snapshot.proxy.details[0].ready, false);

  state.details[0].ttfb_ms = 60_000;
  state.details[0].speed_kbps = 10_000_000;
  state.details[0].ready = true;
  await sendStatus(object, 'proxy', state, { seq: 3 });
  assert.equal(object.snapshot.proxy.details[0].ttfb_ms, 60_000);
  assert.equal(object.snapshot.proxy.details[0].speed_kbps, 10_000_000);
  assert.equal(object.snapshot.proxy.details[0].ready, true);
});

test('routine status messages persist at most twice per minute without losing large state', async () => {
  const storage = new StorageMock();
  const object = presence({ storage });
  await sendStatus(object, 'proxy', proxyState(), { seq: 1 });
  await sendStatus(object, 'core', coreState(), { seq: 1 });
  const before = storage.puts;
  object.lastPersisted = Date.now();
  for (let seq = 2; seq <= 24; seq += 1) {
    await sendStatus(object, 'proxy', proxyState(), { seq });
    await sendStatus(object, 'core', coreState(), { seq });
  }
  assert.ok(storage.puts - before <= 2, `routine status storage.put calls: ${storage.puts - before}`);
  const persisted = await storage.get('state');
  assert.equal(persisted.snapshot.proxy.logs.length, 16 * 1024);
  assert.equal(persisted.snapshot.core.warp.optimizer.candidates.length, 48);

  const restoredStorage = new StorageMock(storage.map);
  const restored = presence({ storage: restoredStorage });
  await restored.ready;
  const snapshot = await restored.publicSnapshot();
  assert.equal(snapshot.proxy.logs.length, 16 * 1024);
  assert.equal(snapshot.core.warp.optimizer.candidates.length, 48);
});

test('cold-start status persists immediately and critical proxy changes bypass the throttle', async () => {
  const storage = new StorageMock();
  const object = presence({ storage });
  await object.ready;
  await sendStatus(object, 'core', coreState(), { seq: 1 });
  assert.equal(storage.puts, 1);
  assert.ok(object.lastPersisted > 0);
  object.lastPersisted = Date.now();
  const changed = proxyState();
  changed.details[0].active = false;
  changed.details[0].tunnel = 'residential';
  changed.details[0].node_ip = '198.51.100.9';
  await sendStatus(object, 'proxy', changed, { seq: 1 });
  assert.equal(storage.puts, 2);
});

test('attachments clamp boot ids and keep hello capabilities in the snapshot', async () => {
  const object = presence();
  const longBootId = `boot-${'x'.repeat(512)}`;
  const helloWs = new WebSocketMock({ ip: '203.0.113.8', role: 'core', connected_at: Date.now(), bootId: '', lastSeq: -1, lastSeen: 0 });
  object.ctx.sockets.core = [helloWs];
  const hello = { role: 'core', ip: '203.0.113.8', seq: 1, boot_id: longBootId, type: 'hello', data: { capabilities: Array.from({ length: 24 }, (_, index) => `cap-${index}-${'y'.repeat(100)}`) } };
  await object.webSocketMessage(helloWs, JSON.stringify(hello));
  const helloAttachment = helloWs.deserializeAttachment();
  assert.equal(helloAttachment.bootId.length, 64);
  assert.ok(utf8Size(helloAttachment) < 512);
  assert.ok(!Object.hasOwn(helloAttachment, 'capabilities'));
  assert.equal(object.snapshot.core_capabilities.length, 20);
  assert.ok(object.snapshot.core_capabilities.every(value => value.length === 64));

  const statusWs = await sendStatus(object, 'core', coreState(), { seq: 2, bootId: longBootId });
  const statusAttachment = statusWs.deserializeAttachment();
  assert.equal(statusAttachment.bootId, helloAttachment.bootId);
  assert.ok(utf8Size(statusAttachment) < 512);
  assert.equal(object.bootId.core, longBootId.slice(0, 64));
  const persisted = await object.ctx.storage.get('state');
  const restored = presence({ storage: new StorageMock([...object.ctx.storage.map]), sockets: { core: [new WebSocketMock(statusAttachment)] } });
  await restored.ready;
  const restoredSnapshot = await restored.publicSnapshot();
  assert.equal(restoredSnapshot.boot_id.core, persisted.bootId.core);
  assert.equal(restoredSnapshot.boot_id.core, longBootId.slice(0, 64));
});

test('new boot hello and status survive hibernation without restoring old metrics', async () => {
  const storage = new StorageMock();
  const object = presence({ storage });
  await object.ready;
  await sendStatus(object, 'core', { ...coreState(), cpu: 10 }, { seq: 1, bootId: 'boot-1' });

  object.lastPersisted = Date.now() - 5_000;
  const capabilities = ['status', 'egress', 'warp', 'config.result'];
  const helloWs = new WebSocketMock({ ip: '203.0.113.8', role: 'core', connected_at: Date.now(), bootId: '', lastSeq: -1, lastSeen: 0 });
  object.ctx.sockets.core = [helloWs];
  await object.webSocketMessage(helloWs, JSON.stringify({
    role: 'core',
    ip: '203.0.113.8',
    seq: 1,
    boot_id: 'boot-2',
    type: 'hello',
    data: { capabilities },
  }));

  object.lastPersisted = Date.now() - 5_000;
  const statusWs = await sendStatus(object, 'core', { ...coreState(), cpu: 80 }, { seq: 2, bootId: 'boot-2' });
  const restored = presence({
    storage: new StorageMock([...storage.map]),
    sockets: { core: [new WebSocketMock(statusWs.deserializeAttachment())] },
  });
  await restored.ready;
  const snapshot = await restored.publicSnapshot();
  assert.equal(snapshot.core.cpu, 80);
  assert.equal(snapshot.boot_id.core, 'boot-2');
  assert.equal(snapshot.sequence.core, 2);
  assert.deepEqual(snapshot.core_capabilities, capabilities);
});

test('hibernation keeps the persisted sample while exposing the latest socket heartbeat', async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const storage = new StorageMock();
    const object = presence({ storage });
    await object.ready;
    now = 1_800_000_000_000;
    await sendStatus(object, 'core', { ...coreState(), cpu: 81 }, { seq: 3, bootId: 'boot-stable' });
    const sampleLastSeen = now;
    const putsAfterSample = storage.puts;
    object.lastPersisted = now;

    now += 5_000;
    const heartbeatWs = await sendStatus(object, 'core', { ...coreState(), cpu: 92 }, { seq: 4, bootId: 'boot-stable' });
    const heartbeatAt = now;
    assert.equal(storage.puts, putsAfterSample, 'status inside the persist window must not create a new sample');

    const persisted = await storage.get('state');
    assert.equal(persisted.snapshot.core.cpu, 81);
    assert.equal(persisted.snapshot.core_last_seen, sampleLastSeen);
    assert.equal(persisted.lastSeq.core, 3);

    const restored = presence({
      storage: new StorageMock([...storage.map]),
      sockets: { core: [new WebSocketMock(heartbeatWs.deserializeAttachment())] },
    });
    await restored.ready;
    now += 100;
    const snapshot = await restored.publicSnapshot();
    assert.equal(snapshot.core.cpu, 81);
    assert.equal(snapshot.sequence.core, 3);
    assert.equal(snapshot.core_last_seen, sampleLastSeen);
    assert.equal(snapshot.core_heartbeat_at, heartbeatAt);
    assert.equal(snapshot.core_state, 'online');
    assert.equal(snapshot.core_age, 100);
  } finally {
    Date.now = realNow;
  }
});

test('stale timeout follows the active reporting interval', () => {
  assert.equal(realtime.staleAfterMs(5000), 20000);
  assert.equal(realtime.staleAfterMs(30000), 65000);
  assert.equal(realtime.staleAfterMs(60000), 125000);
  assert.equal(realtime.staleAfterMs(10000), 25000);
  assert.equal(realtime.staleAfterMs(60000), 125000);
  assert.equal(realtime.staleAfterMs(120000), 245000);
});

test('idle snapshots fall back to the idle interval without a valid policy interval', async () => {
  const now = Date.now();
  const object = presence();
  object.dashboardActive = false;
  object.dashboardInterval = 0;
  object.snapshot = { ip: '203.0.113.8', core: coreState(), proxy: proxyState(), core_connected: true, proxy_connected: true, core_last_seen: now - 40000, proxy_last_seen: now - 40000, updated_at: now };
  object.ctx.sockets.core = [new WebSocketMock({ ip: '203.0.113.8', role: 'core', connected_at: now, bootId: 'core-boot', lastSeq: 1, lastSeen: now - 40000 })];
  object.ctx.sockets.proxy = [new WebSocketMock({ ip: '203.0.113.8', role: 'proxy', connected_at: now, bootId: 'proxy-boot', lastSeq: 1, lastSeen: now - 40000 })];
  const snapshot = await object.publicSnapshot();
  assert.equal(snapshot.interval_ms, 30000);
  assert.equal(snapshot.stale_after_ms, 65000);
  assert.equal(snapshot.core_state, 'online');
  assert.equal(snapshot.proxy_state, 'online');
});

test('idle policy intervals above thirty seconds remain authoritative', async () => {
  const now = Date.now();
  const object = presence();
  object.dashboardActive = false;
  object.dashboardInterval = 120_000;
  object.snapshot = {
    ip: '203.0.113.8',
    core: coreState(),
    proxy: proxyState(),
    core_connected: true,
    proxy_connected: true,
    core_last_seen: now - 80_000,
    proxy_last_seen: now - 80_000,
    updated_at: now - 80_000,
  };
  object.ctx.sockets.core = [new WebSocketMock({ ip: '203.0.113.8', role: 'core', connected_at: now, bootId: 'core-boot', lastSeq: 1, lastSeen: now - 80_000 })];
  object.ctx.sockets.proxy = [new WebSocketMock({ ip: '203.0.113.8', role: 'proxy', connected_at: now, bootId: 'proxy-boot', lastSeq: 1, lastSeen: now - 80_000 })];
  const snapshot = await object.publicSnapshot();
  assert.equal(snapshot.interval_ms, 120_000);
  assert.equal(snapshot.stale_after_ms, 245_000);
  assert.equal(snapshot.core_state, 'online');
});

test('public snapshots sample each agent role exactly once', async () => {
  const now = Date.now();
  const object = presence();
  object.ctx.sockets.core = [new WebSocketMock({ ip: '203.0.113.8', role: 'core', connected_at: now, bootId: 'core-boot', lastSeq: 1, lastSeen: now })];
  object.ctx.sockets.proxy = [new WebSocketMock({ ip: '203.0.113.8', role: 'proxy', connected_at: now, bootId: 'proxy-boot', lastSeq: 1, lastSeen: now })];
  const calls = [];
  const getWebSockets = object.ctx.getWebSockets.bind(object.ctx);
  object.ctx.getWebSockets = tag => {
    calls.push(tag);
    return getWebSockets(tag);
  };
  await object.publicSnapshot();
  assert.equal(calls.length, 2);
  assert.equal(calls.filter(tag => tag === 'core').length, 1);
  assert.equal(calls.filter(tag => tag === 'proxy').length, 1);
});

test('public snapshot reports dynamic stale boundaries for core and proxy', async () => {
  const scenarios = [
    { interval: 5000, state: 'online' },
    { interval: 30000, state: 'online' },
    { interval: 60000, state: 'online' },
    { interval: 10000, state: 'online' },
    { interval: 60000, state: 'stale' },
    { interval: 120000, state: 'online' },
  ];
  for (const scenario of scenarios) {
    const now = Date.now();
    const object = presence({ hubActive: true, interval: scenario.interval });
    object.dashboardActive = true;
    object.dashboardInterval = scenario.interval;
    object.dashboardActiveUntil = now + 900000;
    object.snapshot = { ip: '203.0.113.8', core: coreState(), proxy: proxyState(), core_connected: true, proxy_connected: true, core_last_seen: now, proxy_last_seen: now, updated_at: now };
    object.ctx.sockets.core = [new WebSocketMock({ ip: '203.0.113.8', role: 'core', connected_at: now, bootId: 'core-boot', lastSeq: 1, lastSeen: now })];
    object.ctx.sockets.proxy = [new WebSocketMock({ ip: '203.0.113.8', role: 'proxy', connected_at: now, bootId: 'proxy-boot', lastSeq: 1, lastSeen: now })];
    const staleAfter = realtime.staleAfterMs(scenario.interval);
    const age = scenario.state === 'stale' ? staleAfter + 1_000 : staleAfter - 1_000;
    const lastSeen = now - age;
    object.snapshot.core_last_seen = lastSeen;
    object.snapshot.proxy_last_seen = lastSeen;
    object.ctx.sockets.core[0].attachment.lastSeen = lastSeen;
    object.ctx.sockets.proxy[0].attachment.lastSeen = lastSeen;
    const snapshot = await object.publicSnapshot();
    assert.equal(snapshot.stale_after_ms, staleAfter);
    assert.equal(snapshot.interval_ms, scenario.interval);
    assert.equal(snapshot.core_state, scenario.state === 'stale' ? 'stale' : 'online');
    assert.equal(snapshot.proxy_state, scenario.state === 'stale' ? 'stale' : 'online');
  }
});

test('stale states recover to online on a fresh heartbeat', async () => {
  const now = Date.now();
  const object = presence();
  object.dashboardActive = false;
  object.dashboardActiveUntil = now + 90000;
  object.ctx.sockets.core = [new WebSocketMock({ ip: '203.0.113.8', role: 'core', connected_at: now, bootId: 'core-boot', lastSeq: 1, lastSeen: now })];
  object.ctx.sockets.proxy = [new WebSocketMock({ ip: '203.0.113.8', role: 'proxy', connected_at: now, bootId: 'proxy-boot', lastSeq: 1, lastSeen: now })];
  object.snapshot = { ip: '203.0.113.8', core: coreState(), proxy: proxyState(), core_connected: true, proxy_connected: true, core_last_seen: now - 70000, proxy_last_seen: now - 70000, updated_at: now - 70000 };
  object.snapshot.core_state = 'stale';
  object.snapshot.proxy_state = 'stale';
  const snapshot = await object.publicSnapshot();
  assert.equal(snapshot.core_state, 'online');
  assert.equal(snapshot.proxy_state, 'online');
});

test('bundled frontend snapshots are re-evaluated against the server threshold', async () => {
  const now = Date.now();
  const config = {
    ip: '203.0.113.8',
    core: coreState(),
    proxy: proxyState(),
    core_last_seen: now - 60000,
    proxy_last_seen: now - 60000,
    core_state: 'stale',
    proxy_state: 'stale',
    stale_after_ms: 125000,
    interval_ms: 60000,
  };
  const object = presence();
  object.dashboardActive = true;
  object.dashboardInterval = 60000;
  object.dashboardActiveUntil = now + 900000;
  object.snapshot = { ...config };
  object.ctx.sockets.core = [new WebSocketMock({ ip: config.ip, role: 'core', connected_at: now, bootId: 'core-boot', lastSeq: 1, lastSeen: now - 60000 })];
  object.ctx.sockets.proxy = [new WebSocketMock({ ip: config.ip, role: 'proxy', connected_at: now, bootId: 'proxy-boot', lastSeq: 1, lastSeen: now - 60000 })];
  const snapshot = await object.publicSnapshot();
  assert.equal(snapshot.core_state, 'online');
  assert.equal(snapshot.proxy_state, 'online');
  assert.equal(snapshot.stale_after_ms, 125000);
});

test('dashboard fallback snapshots keep the idle interval and HTTP stale threshold', async () => {
  const now = Date.now();
  const serverRows = [{ ip: '203.0.113.8', cpu: 1, mem: 2, disk: 3, load: 0.1, uptime: 10, net_in_speed: 1, net_out_speed: 2, tcp_conn: 3, udp_conn: 4, last_report: now }];
  const proxyRows = [{ ip: '203.0.113.8', details: '[]', last_seen: now }];
  const db = {
    prepare: sql => ({
      bind: () => ({ first: async () => ({ agent_token: 'agent-secret' }) }),
      all: async () => ({ results: sql.includes('proxy_ctrl_servers') ? proxyRows : sql.includes('SELECT ip, cpu') ? serverRows : [] }),
    }),
  };
  const ctx = context();
  const hub = new realtime.DashboardHub(ctx, {
    DB: db,
    VPS_PRESENCE: {
      idFromName: name => name,
      get: () => ({ fetch: async () => jsonResponse({ ip: '', core: null, proxy: null }) }),
    },
  });
  await ctx.ready;
  const snapshots = await hub.snapshot();
  assert.equal(snapshots[0].stale_after_ms, 360000);
  assert.equal(snapshots[0].interval_ms, 30000);
});

test('dashboard fallback keeps HTTP thresholds under a slower active frequency policy', async () => {
  const now = Date.now();
  const ctx = context({ sockets: { dashboard: [{ attachment: { user: 'admin' } }] } });
  const hub = new realtime.DashboardHub(ctx, {
    DB: {
      prepare: sql => ({
        all: async () => ({ results: sql.includes('proxy_ctrl_servers') ? [{ ip: '203.0.113.8', details: '[]', last_seen: now - 90000 }] : [{ ip: '203.0.113.8', cpu: 1, mem: 2, disk: 3, load: 0.1, uptime: 10, net_in_speed: 1, net_out_speed: 2, tcp_conn: 3, udp_conn: 4, last_report: now - 90000 }] }),
      }),
    },
    VPS_PRESENCE: {
      idFromName: name => name,
      get: () => ({ fetch: async () => jsonResponse({ ip: '', core: null, proxy: null }) }),
    },
  });
  await ctx.ready;
  hub.frequencyPolicy = { admin: 60000, public: 120000, idle: 300000 };
  hub.activityInterval = 60000;
  const snapshots = await hub.snapshot();
  assert.equal(snapshots[0].interval_ms, 60000);
  assert.equal(snapshots[0].stale_after_ms, 360000);
  assert.equal(snapshots[0].core_state, 'online');
});

test('dashboard fallback keeps HTTP freshness thresholds independent of the active interval', async () => {
  const now = Date.now();
  const cases = [
    { age: 120_000, coreState: 'online', proxyState: 'online' },
    { age: 400_000, coreState: 'stale', proxyState: 'stale' },
    { age: 1_300_000, coreState: 'offline', proxyState: 'offline' },
  ];
  for (const scenario of cases) {
    const ctx = context({ sockets: { dashboard: [{ attachment: { user: 'admin' } }] } });
    const hub = new realtime.DashboardHub(ctx, {
      DB: {
        prepare: sql => ({
          all: async () => ({ results: sql.includes('proxy_ctrl_servers')
            ? [{ ip: '203.0.113.8', details: '[]', last_seen: now - scenario.age }]
            : [{ ip: '203.0.113.8', cpu: 1, mem: 2, disk: 3, load: 0.1, uptime: 10, net_in_speed: 1, net_out_speed: 2, tcp_conn: 3, udp_conn: 4, last_report: now - scenario.age }] }),
        }),
      },
      VPS_PRESENCE: {
        idFromName: name => name,
        get: () => ({ fetch: async () => jsonResponse({ ip: '', core: null, proxy: null }) }),
      },
    });
    await ctx.ready;
    hub.frequencyPolicy = { admin: 5000, public: 10000, idle: 30000 };
    hub.activityInterval = 5000;
    const [snapshot] = await hub.snapshot();
    assert.equal(snapshot.transport, 'http');
    assert.equal(snapshot.core_state, scenario.coreState, `core age ${scenario.age}`);
    assert.equal(snapshot.proxy_state, scenario.proxyState, `proxy age ${scenario.age}`);
    assert.equal(snapshot.interval_ms, 5000);
    assert.equal(snapshot.stale_after_ms, 360000);
  }
});

test('dashboard fanout supplies activity to presence without a reverse hub call', async () => {
  const requests = [];
  let presenceUrl = '';
  const ctx = context({ sockets: { dashboard: [{ attachment: { user: 'admin' } }] } });
  const hub = new realtime.DashboardHub(ctx, {
    DB: {
      prepare: sql => ({
        all: async () => ({ results: sql.includes('proxy_ctrl_servers') ? [] : [{ ip: '203.0.113.8', cpu: 1, mem: 2, disk: 3, load: 0.1, uptime: 10, net_in_speed: 1, net_out_speed: 2, tcp_conn: 3, udp_conn: 4, last_report: Date.now() }] }),
      }),
    },
    VPS_PRESENCE: {
      idFromName: name => name,
      get: () => ({ fetch: async request => {
        presenceUrl = request.url;
        return jsonResponse({ ip: '', core: null, proxy: null });
      } }),
    },
  });
  await ctx.ready;
  hub.frequencyPolicy = { admin: 5000, public: 10000, idle: 30000 };
  await hub.snapshot();
  const url = new URL(presenceUrl);
  assert.equal(url.pathname, '/snapshot');
  assert.equal(url.searchParams.get('active'), '1');
  assert.equal(url.searchParams.get('interval'), '5000');

  const live = livePresence(requests);
  await live.object.ready;
  const response = await live.object.fetch(new Request(`${presenceUrl}&ip=203.0.113.8&role=core`));
  assert.equal(response.status, 200);
  assert.equal(live.object.dashboardActive, true);
  assert.equal(live.object.dashboardInterval, 5000);
  assert.ok(live.object.dashboardActiveUntil > Date.now() + 80_000);
  assert.ok(!requests.some(value => new URL(value).pathname === '/active'), 'snapshot must not call hub /active');
});

test('the first dashboard snapshot after hibernation uses the live admin policy', async () => {
  const now = Date.now();
  let presenceUrl = '';
  const ctx = context({ sockets: { dashboard: [{ attachment: { user: 'admin' } }] } });
  const hub = new realtime.DashboardHub(ctx, {
    DB: {
      prepare: sql => ({
        bind: () => ({ first: async () => ({ agent_token: 'agent-secret' }) }),
        all: async () => ({ results: sql.includes('proxy_ctrl_servers') ? [] : [{ ip: '203.0.113.8', cpu: 1, mem: 2, disk: 3, load: 0.1, uptime: 10, net_in_speed: 1, net_out_speed: 2, tcp_conn: 3, udp_conn: 4, last_report: now }] }),
      }),
    },
    VPS_PRESENCE: {
      idFromName: name => name,
      get: () => ({ fetch: async request => {
        presenceUrl = request.url;
        return jsonResponse({ ip: '203.0.113.8', core: coreState(), core_last_seen: now, core_state: 'online' });
      } }),
    },
  });
  await ctx.ready;
  hub.frequencyPolicy = { admin: 60000, public: 120000, idle: 300000 };
  await hub.snapshot();
  const url = new URL(presenceUrl);
  assert.equal(url.searchParams.get('active'), '1');
  assert.equal(url.searchParams.get('interval'), '60000');
  assert.equal(hub.activityInterval, 60000);
  assert.ok(hub.activityUntil > Date.now());
});

test('initial dashboard snapshots carry the current stale contract', async () => {
  const now = Date.now();
  const ctx = context({ sockets: { dashboard: [{ attachment: { user: 'admin' } }] } });
  const hub = new realtime.DashboardHub(ctx, {
    DB: {
      prepare: sql => ({
        all: async () => ({ results: sql.includes('proxy_ctrl_servers') ? [] : [{ ip: '203.0.113.8', cpu: 1, mem: 2, disk: 3, load: 0.1, uptime: 10, net_in_speed: 1, net_out_speed: 2, tcp_conn: 3, udp_conn: 4, last_report: now }] }),
      }),
    },
    VPS_PRESENCE: {
      idFromName: name => name,
      get: () => ({ fetch: async () => jsonResponse({ ip: '203.0.113.8', core: coreState(), core_last_seen: now, core_state: 'online', interval_ms: 10000, stale_after_ms: 25000 }) }),
    },
  });
  await ctx.ready;
  hub.frequencyPolicy = { admin: 60000, public: 120000, idle: 300000 };
  hub.activityInterval = 60000;
  const snapshots = await hub.snapshot();
  assert.equal(snapshots[0].stale_after_ms, 25000);
  assert.equal(snapshots[0].interval_ms, 10000);
});

test('frontend uses server stale_after_ms and the shared fallback formula', () => {
  assert.doesNotMatch(frontendSource, /now - server\.last_report > 20000|now - server\.last_updated > 20000/);
  assert.match(frontendSource, /stale_after_ms/);
  assert.match(frontendSource, /realtimeStaleAfterMs\(serverInterval \|\| activeRealtimeInterval\(\)\)/);
  assert.match(frontendSource, /realtimeStaleAfterMs\(activeRealtimeInterval\(\)\)/);
  const frontend = read('../frontend/src/composables/useRealtime.js');
  assert.match(frontend, /export const realtimeStaleAfterMs/);
  for (const interval of [5000, 10000, 30000, 60000, 120000]) assert.equal(realtime.staleAfterMs(interval), Math.max(20000, interval * 2 + 5000));
});

test('frontend realtime state accepts the server-provided stale deadline', async () => {
  globalThis.window = {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    location: { origin: 'https://panel.example' },
    addEventListener() {},
  };
  globalThis.document = {
    documentElement: { dataset: {}, style: {} },
    body: {},
    addEventListener() {},
    hidden: false,
    getElementById: () => null,
    createElement: () => ({ content: {}, set innerHTML(value) { this.content = { textContent: value }; } }),
    createElementNS: () => ({}),
    createTextNode: () => ({}),
    querySelector: () => null,
  };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.location = { origin: 'https://panel.example' };
  globalThis.alert = () => {};
  globalThis.confirm = () => false;
  const { useKuiState } = await import('../frontend/src/composables/useKuiState.js');
  const state = useKuiState();
  assert.equal(typeof state.applyRealtimeSnapshot, 'function');
  state.servers.value = [{ ip: '203.0.113.8', last_report: Date.now() - 59000, realtime_state: 'online' }];
  state.applyRealtimeSnapshot({ ip: '203.0.113.8', core: coreState(), core_state: 'online', core_last_seen: Date.now() - 59000, stale_after_ms: 125000, interval_ms: 60000 });
  assert.equal(state.servers.value[0].stale_after_ms, 125000);
  assert.equal(state.servers.value[0].realtime_state, 'online');
  state.servers.value = [{ ip: '203.0.113.8', last_report: Date.now() - 90000, realtime_state: 'stale' }];
  state.applyRealtimeSnapshot({ ip: '203.0.113.8', core: coreState(), core_state: 'stale', core_last_seen: Date.now() - 90000, stale_after_ms: 125000, interval_ms: 60000 });
  assert.equal(state.servers.value[0].realtime_state, 'stale');
  state.servers.value = [{ ip: '203.0.113.8', last_report: Date.now(), realtime_state: 'online' }];
  state.applyRealtimeSnapshot({ ip: '203.0.113.8', core: coreState(), core_state: 'offline', core_last_seen: Date.now(), stale_after_ms: 125000, interval_ms: 60000 });
  assert.equal(state.servers.value[0].realtime_state, 'offline');
  const { mergeServerRealtimeTelemetry } = await import('../frontend/src/utils/egressState.js');
  const merged = mergeServerRealtimeTelemetry({ ip: '203.0.113.8', last_report: 0 }, { ip: '203.0.113.8', last_report: Date.now(), stale_after_ms: 125000, interval_ms: 60000 });
  assert.equal(merged.stale_after_ms, 125000);
  assert.equal(merged.interval_ms, 60000);
});

test('frontend equal timestamps and missing intervals keep server realtime state', async () => {
  globalThis.window = {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    location: { origin: 'https://panel.example' },
    addEventListener() {},
  };
  globalThis.document = {
    documentElement: { dataset: {}, style: {} },
    body: {},
    addEventListener() {},
    hidden: false,
    getElementById: () => null,
    createElement: () => ({ content: {}, set innerHTML(value) { this.content = { textContent: value }; } }),
    createElementNS: () => ({}),
    createTextNode: () => ({}),
    querySelector: () => null,
  };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.location = { origin: 'https://panel.example' };
  globalThis.alert = () => {};
  globalThis.confirm = () => false;
  const timestamp = Date.now();
  const { useKuiState } = await import('../frontend/src/composables/useKuiState.js');
  const state = useKuiState();
  state.probeSys.realtime_admin_interval = '';
  state.servers.value = [{ ip: '203.0.113.8', last_report: timestamp, realtime_state: 'stale', stale_after_ms: 65000, interval_ms: 30000 }];
  state.servers.value[0]._realtime_ts = timestamp;
  state.applyRealtimeSnapshot({ ip: '203.0.113.8', core: coreState(), core_state: 'stale', core_last_seen: timestamp, stale_after_ms: 125000, interval_ms: 60000 });
  assert.equal(state.servers.value[0].realtime_state, 'stale');
  assert.equal(state.servers.value[0].stale_after_ms, 125000);
  assert.equal(state.servers.value[0].interval_ms, 60000);

  const { mergeServerRealtimeTelemetry } = await import('../frontend/src/utils/egressState.js');
  const merged = mergeServerRealtimeTelemetry(
    { ip: '203.0.113.8', last_report: timestamp, stale_after_ms: 65000, interval_ms: 30000, realtime_state: 'stale' },
    { ip: '203.0.113.8', last_report: timestamp, _realtime_ts: timestamp, stale_after_ms: 360000, interval_ms: 5000, realtime_state: 'online', cpu: 50 },
  );
  assert.equal(merged.stale_after_ms, 360000);
  assert.equal(merged.interval_ms, 5000);
  assert.equal(merged.realtime_state, 'online');
  assert.equal(merged.cpu, 50);
  assert.doesNotMatch(frontendSource, /return admin \* 1000|return publicInterval \* 1000|return idle \* 1000/);
  assert.match(frontendSource, /positiveMs\(Number\(val\) \* 1000\)/);
  assert.match(frontendSource, /if \(serverState === 'offline'\) return 'offline'/);
  assert.match(frontendSource, /if \(serverState === 'stale'\) return 'stale'/);
  assert.match(frontendSource, /live\._realtime_ts >= Number\(item\.last_updated/);
  assert.match(frontendSource, /Number\(live\._realtime_ts \|\| 0\) >= Number\(detail\.last_updated/);
  assert.match(frontendSource, /connectPublicRealtime[\s\S]*refreshRealtimeStaleStates\(\)/);
});

test('frontend separates sample freshness from the connection heartbeat', async () => {
  globalThis.window = {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    location: { origin: 'https://panel.example' },
    addEventListener() {},
  };
  globalThis.document = {
    documentElement: { dataset: {}, style: {} },
    body: {},
    addEventListener() {},
    hidden: false,
    getElementById: () => null,
    createElement: () => ({ content: {}, set innerHTML(value) { this.content = { textContent: value }; } }),
    createElementNS: () => ({}),
    createTextNode: () => ({}),
    querySelector: () => null,
  };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.location = { origin: 'https://panel.example' };
  globalThis.alert = () => {};
  globalThis.confirm = () => false;

  const now = Date.now();
  const sampleAt = now - 55_000;
  const heartbeatAt = now - 2_000;
  const { useKuiState } = await import('../frontend/src/composables/useKuiState.js');
  const state = useKuiState();
  state.servers.value = [{ ip: '203.0.113.8', last_report: now - 60_000, realtime_state: 'stale' }];
  state.applyRealtimeSnapshot({
    ip: '203.0.113.8',
    core: { ...coreState(), cpu: 81 },
    core_state: 'online',
    core_last_seen: sampleAt,
    core_heartbeat_at: heartbeatAt,
    stale_after_ms: 20_000,
    interval_ms: 10_000,
  });
  assert.equal(state.servers.value[0].realtime_state, 'online');
  assert.equal(state.servers.value[0]._realtime_heartbeat_ts, heartbeatAt);
  state.refreshRealtimeStaleStates();
  assert.equal(state.servers.value[0].realtime_state, 'online');

  state.servers.value = [{
    ip: '203.0.113.8',
    cpu: 92,
    last_report: heartbeatAt,
    _realtime_ts: heartbeatAt,
    realtime_state: 'online',
    stale_after_ms: 20_000,
    interval_ms: 10_000,
  }];
  state.applyRealtimeSnapshot({
    ip: '203.0.113.8',
    core: { ...coreState(), cpu: 81 },
    core_state: 'online',
    core_last_seen: sampleAt,
    core_heartbeat_at: heartbeatAt,
    stale_after_ms: 20_000,
    interval_ms: 10_000,
  });
  assert.equal(state.servers.value[0].cpu, 92);
  assert.equal(state.servers.value[0].last_report, heartbeatAt);
  assert.equal(state.servers.value[0]._realtime_heartbeat_ts, heartbeatAt);
  assert.equal(state.servers.value[0].realtime_state, 'online');

  const { mergeServerRealtimeTelemetry } = await import('../frontend/src/utils/egressState.js');
  const merged = mergeServerRealtimeTelemetry(
    { ip: '203.0.113.8', last_report: sampleAt },
    { ip: '203.0.113.8', last_report: sampleAt, _realtime_ts: sampleAt, _realtime_heartbeat_ts: heartbeatAt },
  );
  assert.equal(merged._realtime_heartbeat_ts, heartbeatAt);
});

test('frontend keeps the newer heartbeat when equal core samples arrive out of order', async () => {
  globalThis.window = {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    location: { origin: 'https://panel.example' },
    addEventListener() {},
  };
  globalThis.document = {
    documentElement: { dataset: {}, style: {} },
    body: {},
    addEventListener() {},
    hidden: false,
    getElementById: () => null,
    createElement: () => ({ content: {}, set innerHTML(value) { this.content = { textContent: value }; } }),
    createElementNS: () => ({}),
    createTextNode: () => ({}),
    querySelector: () => null,
  };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.location = { origin: 'https://panel.example' };
  globalThis.alert = () => {};
  globalThis.confirm = () => false;

  const now = Date.now();
  const sampleAt = now - 40_000;
  const { useKuiState } = await import('../frontend/src/composables/useKuiState.js');
  const state = useKuiState();
  state.servers.value = [{ ip: '203.0.113.8', last_report: sampleAt, realtime_state: 'stale' }];

  state.applyRealtimeSnapshot({
    ip: '203.0.113.8',
    core: { ...coreState(), cpu: 50 },
    core_state: 'online',
    core_last_seen: sampleAt,
    core_heartbeat_at: now - 1_000,
    stale_after_ms: 20_000,
    interval_ms: 10_000,
  });
  state.applyRealtimeSnapshot({
    ip: '203.0.113.8',
    core: { ...coreState(), cpu: 51 },
    core_state: 'stale',
    core_last_seen: sampleAt,
    core_heartbeat_at: now - 30_000,
    stale_after_ms: 20_000,
    interval_ms: 10_000,
  });

  assert.equal(state.servers.value[0].realtime_state, 'online');
  assert.equal(state.servers.value[0]._realtime_heartbeat_ts, now - 1_000);
  assert.equal(state.isOnline(state.servers.value[0]), true);
});

test('frontend keeps proxy-only snapshots from advancing the core sample timestamp', async () => {
  globalThis.window = {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    location: { origin: 'https://panel.example' },
    addEventListener() {},
  };
  globalThis.document = {
    documentElement: { dataset: {}, style: {} },
    body: {},
    addEventListener() {},
    hidden: false,
    getElementById: () => null,
    createElement: () => ({ content: {}, set innerHTML(value) { this.content = { textContent: value }; } }),
    createElementNS: () => ({}),
    createTextNode: () => ({}),
    querySelector: () => null,
  };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.location = { origin: 'https://panel.example' };
  globalThis.alert = () => {};
  globalThis.confirm = () => false;

  const now = Date.now();
  const { useKuiState } = await import('../frontend/src/composables/useKuiState.js');
  const state = useKuiState();
  state.servers.value = [{ ip: '203.0.113.8', last_report: 0, realtime_state: 'offline' }];

  state.applyRealtimeSnapshot({
    ip: '203.0.113.8',
    core_last_seen: 0,
    proxy_last_seen: now - 1_000,
    updated_at: now - 1_000,
    core_state: 'offline',
    core: { cpu: 0 },
  });
  assert.equal(state.servers.value[0].last_report, 0);

  state.applyRealtimeSnapshot({
    ip: '203.0.113.8',
    core_last_seen: now - 1_100,
    core_state: 'online',
    core: { cpu: 76 },
  });
  assert.equal(state.servers.value[0].cpu, 76);
  assert.equal(state.servers.value[0].realtime_state, 'online');
  assert.equal(state.isOnline(state.servers.value[0]), true);
});

test('frontend keeps newer HTTP telemetry over an older DO offline heartbeat', async () => {
  globalThis.window = {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    location: { origin: 'https://panel.example' },
    addEventListener() {},
  };
  globalThis.document = {
    documentElement: { dataset: {}, style: {} },
    body: {},
    addEventListener() {},
    hidden: false,
    getElementById: () => null,
    createElement: () => ({ content: {}, set innerHTML(value) { this.content = { textContent: value }; } }),
    createElementNS: () => ({}),
    createTextNode: () => ({}),
    querySelector: () => null,
  };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.location = { origin: 'https://panel.example' };
  globalThis.alert = () => {};
  globalThis.confirm = () => false;

  const now = Date.now();
  const { useKuiState } = await import('../frontend/src/composables/useKuiState.js');
  const state = useKuiState();
  state.servers.value = [{ ip: '203.0.113.8', cpu: 92, last_report: now - 1000, realtime_state: 'online' }];

  state.applyRealtimeSnapshot({
    ip: '203.0.113.8',
    core: { ...coreState(), cpu: 5 },
    core_state: 'offline',
    core_last_seen: now - 30_000,
    core_heartbeat_at: now - 30_000,
    stale_after_ms: 20_000,
    interval_ms: 10_000,
  });

  assert.equal(state.servers.value[0].cpu, 92);
  assert.notEqual(state.servers.value[0].realtime_state, 'offline');
  assert.equal(state.isOnline(state.servers.value[0]), true);
});

test('frontend preserves zero timestamps from a no-sample HTTP fallback snapshot', async () => {
  globalThis.window = {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    location: { origin: 'https://panel.example' },
    addEventListener() {},
  };
  globalThis.document = {
    documentElement: { dataset: {}, style: {} },
    body: {},
    addEventListener() {},
    hidden: false,
    getElementById: () => null,
    createElement: () => ({ content: {}, set innerHTML(value) { this.content = { textContent: value }; } }),
    createElementNS: () => ({}),
    createTextNode: () => ({}),
    querySelector: () => null,
  };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.location = { origin: 'https://panel.example' };
  globalThis.alert = () => {};
  globalThis.confirm = () => false;

  const now = Date.now();
  const { useKuiState } = await import('../frontend/src/composables/useKuiState.js');
  const state = useKuiState();
  state.servers.value = [{ ip: '203.0.113.8', cpu: 0, last_report: 0, realtime_state: 'offline' }];

  state.applyRealtimeSnapshot({
    ip: '203.0.113.8',
    core: { ...coreState(), cpu: 0 },
    core_state: 'offline',
    core_last_seen: 0,
    updated_at: 0,
    stale_after_ms: 20_000,
    interval_ms: 10_000,
  });
  assert.equal(state.servers.value[0].last_report, 0);
  assert.equal(state.servers.value[0]._realtime_ts, 0);
  assert.equal(state.servers.value[0]._realtime_heartbeat_ts, 0);

  state.applyRealtimeSnapshot({
    ip: '203.0.113.8',
    core: { ...coreState(), cpu: 76 },
    core_state: 'online',
    core_last_seen: now - 10,
    stale_after_ms: 20_000,
    interval_ms: 10_000,
  });

  assert.equal(state.servers.value[0].cpu, 76);
  assert.equal(state.servers.value[0].realtime_state, 'online');
  assert.equal(state.isOnline(state.servers.value[0]), true);
});

test('HTTP polling and WS timestamps merge core and residential telemetry independently', async () => {
  const { mergeServerRealtimeTelemetry } = await import('../frontend/src/utils/egressState.js');
  const timestamp = Date.now();

  const httpMerged = mergeServerRealtimeTelemetry(
    { ip: '203.0.113.8', cpu: 70, last_report: timestamp, stale_after_ms: 65000, interval_ms: 30000, realtime_state: 'stale' },
    { ip: '203.0.113.8', cpu: 5, last_report: timestamp, stale_after_ms: 245000, interval_ms: 120000, realtime_state: 'online' },
  );
  assert.equal(httpMerged.cpu, 70);
  assert.equal(httpMerged.stale_after_ms, 65000);
  assert.equal(httpMerged.interval_ms, 30000);
  assert.equal(httpMerged.realtime_state, 'stale');

  const firstPoll = mergeServerRealtimeTelemetry(
    { ip: '203.0.113.8', last_report: timestamp, residential_ready: true, residential_reason: '', residential_last_seen: timestamp - 1 },
    { ip: '203.0.113.8', last_report: timestamp, residential_ready: false, residential_reason: '代理心跳已过期', residential_last_seen: timestamp },
  );
  const secondPoll = mergeServerRealtimeTelemetry(
    firstPoll,
    { ip: '203.0.113.8', last_report: timestamp, residential_ready: false, residential_reason: '代理心跳已过期', residential_last_seen: timestamp },
  );
  assert.equal(secondPoll.residential_ready, false);
  assert.equal(secondPoll.residential_reason, '代理心跳已过期');

  const equalWs = mergeServerRealtimeTelemetry(
    { ip: '203.0.113.8', last_report: timestamp, stale_after_ms: 65000, interval_ms: 30000, realtime_state: 'stale', residential_ready: false, residential_reason: '代理心跳已过期', residential_last_seen: timestamp },
    { ip: '203.0.113.8', last_report: timestamp, _realtime_ts: timestamp, stale_after_ms: 360000, interval_ms: 5000, realtime_state: 'online', cpu: 50, residential_ready: true, residential_reason: '', residential_last_seen: timestamp },
  );
  assert.equal(equalWs.stale_after_ms, 360000);
  assert.equal(equalWs.interval_ms, 5000);
  assert.equal(equalWs.realtime_state, 'online');
  assert.equal(equalWs.cpu, 50);
  assert.equal(equalWs.residential_ready, false);
  assert.equal(equalWs.residential_reason, '代理心跳已过期');

  const newerWs = mergeServerRealtimeTelemetry(
    { ip: '203.0.113.8', last_report: timestamp, residential_ready: false, residential_reason: '代理心跳已过期', residential_last_seen: timestamp },
    { ip: '203.0.113.8', last_report: timestamp, _realtime_ts: timestamp, residential_ready: true, residential_reason: '', residential_last_seen: timestamp + 1 },
  );
  assert.equal(newerWs.residential_ready, true);
  assert.equal(newerWs.residential_reason, '');
});
