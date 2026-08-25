import { DurableObject } from "cloudflare:workers";

// Admins need the fastest updates. Public monitoring remains responsive at
// ten seconds, while no viewers reduces routine status work to thirty seconds.
const ADMIN_STATUS_INTERVAL = 5_000;
const PUBLIC_STATUS_INTERVAL = 10_000;
const IDLE_STATUS_INTERVAL = 30_000;
const STATUS_STALE_AFTER = 20_000;
const VIEWER_LEASE_MS = 90_000;
const RESYNC_COOLDOWN_MS = 30_000;
const SNAPSHOT_CACHE_MS = 10_000;
const PROXY_DB_PERSIST_INTERVAL = 300_000;
const PRESENCE_NAME_CACHE_MS = 60_000;
const MAX_DASHBOARD_SOCKETS = 5;
const DEFAULT_FREQUENCY_POLICY = { admin: ADMIN_STATUS_INTERVAL, public: PUBLIC_STATUS_INTERVAL, idle: IDLE_STATUS_INTERVAL };
const presenceNameCache = new Map();

function validFrequencyPolicy(value) {
  const admin = Number(value?.admin);
  const publicInterval = Number(value?.public);
  const idle = Number(value?.idle);
  if (!Number.isInteger(admin) || !Number.isInteger(publicInterval) || !Number.isInteger(idle) || admin < 5 || admin > 60 || publicInterval < 10 || publicInterval > 120 || idle < 30 || idle > 600 || publicInterval < admin || idle < publicInterval) return null;
  return { admin: admin * 1000, public: publicInterval * 1000, idle: idle * 1000 };
}

function viewerActive(attachment, now = Date.now()) { return Number(attachment?.lastActivity || 0) + VIEWER_LEASE_MS > now; }

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });
}

function pagesOrigins(env) {
  return String(env.PAGES_ORIGIN || "").split(",").map(origin => origin.trim().replace(/\/$/, "")).filter(origin => /^https:\/\//.test(origin));
}

function isAllowedPagesOrigin(origin, env) {
  const configured = pagesOrigins(env);
  return configured.length > 0 && configured.includes(origin);
}

function requestPagesOrigin(request, env) {
  const candidates = [request.headers.get("X-KUI-Pages-Origin"), request.headers.get("Origin")].filter(Boolean);
  return candidates.find(origin => isAllowedPagesOrigin(origin, env)) || "";
}

function cors(request, env) {
  const requested = request.headers.get("Origin") || "";
  const origin = isAllowedPagesOrigin(requested, env) ? requested : "null";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

function validIp(value) {
  if (typeof value !== "string" || value !== value.trim()) return false;
  if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return value.split(".").every(part => Number(part) <= 255);
  if (!value.includes(":") || !/^[0-9A-Fa-f:.]{2,45}$/.test(value)) return false;
  try {
    const parsed = new URL(`http://[${value}]/`);
    return parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]") && parsed.port === "" && parsed.pathname === "/";
  } catch {
    return false;
  }
}

function safeProxyAddress(value) {
  const address = String(value || "").trim();
  return validIp(address) ? address : "";
}

function compactWarpCandidate(value) {
  const address = safeProxyAddress(value?.address);
  const port = Number(value?.port) || 0;
  if (!address || port < 1 || port > 65535) return null;
  return {
    address, port,
    family: String(value?.family || "").slice(0, 8),
    current: value?.current === true,
    refined: value?.refined === true,
    success: value?.success === true,
    latency_ms: Math.max(0, Math.min(Number(value?.latency_ms) || 0, 60000)),
    loss_pct: Math.max(0, Math.min(Number(value?.loss_pct) || 0, 100)),
    colo: String(value?.colo || "").toUpperCase().slice(0, 8),
    exit_ipv4: safeProxyAddress(value?.exit_ipv4),
    exit_ipv6: safeProxyAddress(value?.exit_ipv6),
    error: String(value?.error || "").slice(0, 240),
  };
}

function compactWarpState(value) {
  if (!value || typeof value !== "object") return null;
  const optimizer = value.optimizer && typeof value.optimizer === "object" ? value.optimizer : {};
  const candidates = Array.isArray(optimizer.candidates) ? optimizer.candidates.slice(0, 48).map(compactWarpCandidate).filter(Boolean) : [];
  const recommended = compactWarpCandidate(optimizer.recommended);
  const previous = optimizer.previous && safeProxyAddress(optimizer.previous.address) ? { address: safeProxyAddress(optimizer.previous.address), port: Number(optimizer.previous.port) || 0 } : null;
  const history = Array.isArray(optimizer.history) ? optimizer.history.slice(0, 12).map(item => ({
    at: Number(item?.at) || 0,
    from_address: safeProxyAddress(item?.from_address), from_port: Number(item?.from_port) || 0,
    to_address: safeProxyAddress(item?.to_address), to_port: Number(item?.to_port) || 0,
    reason: String(item?.reason || "").slice(0, 32), success: item?.success === true,
  })) : [];
  return {
    configured: value.configured === true,
    active_mode: String(value.active_mode || "native").slice(0, 32),
    peer_address: safeProxyAddress(value.peer_address), peer_port: Number(value.peer_port) || 0,
    peer_family: String(value.peer_family || "").slice(0, 8),
    tunnel_ipv4: String(value.tunnel_ipv4 || "").slice(0, 64), tunnel_ipv6: String(value.tunnel_ipv6 || "").slice(0, 96),
    optimizer: {
      status: String(optimizer.status || "idle").slice(0, 24), stage: String(optimizer.stage || "").slice(0, 120),
      policy: ["manual", "on_failure", "first_enable"].includes(optimizer.policy) ? optimizer.policy : "manual",
      progress: Math.max(0, Math.min(Number(optimizer.progress) || 0, 100)), candidates, recommended, previous, history,
      error: String(optimizer.error || "").slice(0, 500), last_scan_at: Number(optimizer.last_scan_at) || 0, updated_at: Number(optimizer.updated_at) || 0,
    },
  };
}

function compactRoleState(role, data) {
  if (role === "core") {
    const keys = ["cpu", "mem", "disk", "load", "uptime", "net_in_speed", "net_out_speed", "tcp_conn", "udp_conn", "os", "arch"];
    const result = Object.fromEntries(keys.filter(key => data?.[key] !== undefined).map(key => [key, data[key]]));
    const warp = compactWarpState(data?.warp);
    if (warp) result.warp = warp;
    return result;
  }
  return {
    details: Array.isArray(data?.details) ? data.details.slice(0, 4).map(item => ({ tunnel: String(item?.tunnel || "").slice(0, 32), active: item?.active === true, node_ip: safeProxyAddress(item?.node_ip), exit_ip: safeProxyAddress(item?.exit_ip), country: String(item?.country || "").toUpperCase().slice(0, 2), port: Number(item?.port) || 0, ready: item?.ready === true, connected_time: Math.max(0, Math.min(Number(item?.connected_time) || 0, 31536000)) })) : [],
    logs: String(data?.logs || "").slice(0, 16 * 1024),
  };
}

async function verifyAdmin(header, request, env) {
  try {
    if (!header) return false;
    if (header.startsWith("Realtime ")) {
      const encoder = new TextEncoder();
      const supplied = encoder.encode(header.slice(9));
      const configured = encoder.encode(String(env.REALTIME_AUTH_SECRET || ""));
      if (configured.length < 32 || supplied.length > 1024) return false;
      const [suppliedHash, configuredHash] = await Promise.all([
        crypto.subtle.digest("SHA-256", supplied),
        crypto.subtle.digest("SHA-256", configured),
      ]);
      const suppliedBytes = new Uint8Array(suppliedHash);
      const configuredBytes = new Uint8Array(configuredHash);
      let difference = 0;
      for (let index = 0; index < configuredBytes.length; index++) difference |= suppliedBytes[index] ^ configuredBytes[index];
      return difference === 0;
    }
    if (header.startsWith("Bearer ")) {
      const token = header.slice(7);
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return false;
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      const tokenHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      const session = await env.DB.prepare("SELECT username FROM auth_sessions WHERE token_hash = ? AND expires_at > ?").bind(tokenHash, Date.now()).first();
      if (session?.username === (env.ADMIN_USERNAME || "admin")) return true;
    }

    // Signed browser requests are validated by the Pages API. Keep this
    // fallback for clients that have not yet migrated to session tokens.
    const configured = pagesOrigins(env);
    const origins = configured.length ? configured : [requestPagesOrigin(request, env)].filter(Boolean);
    for (const origin of origins) {
      const response = await fetch(`${origin}/api/realtime_auth`, {
        method: "POST",
        headers: { Authorization: header, "Content-Type": "application/json", "X-KUI-Realtime-Secret": env.REALTIME_AUTH_SECRET || "" },
        body: "{}",
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok && (await response.json()).admin === true) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function verifyAgent(header, ip, env) {
  if (!header || !ip) return false;
  const server = await env.DB.prepare("SELECT agent_token FROM servers WHERE ip = ?").bind(ip).first();
  return !!server?.agent_token && header === server.agent_token;
}

async function presenceName(ip, env) {
  const cached = presenceNameCache.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.name;
  const server = await env.DB.prepare("SELECT agent_token FROM servers WHERE ip = ?").bind(ip).first();
  if (!server?.agent_token) return "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(server.agent_token));
  const tokenHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const name = `v2:${ip}:${tokenHash}`;
  presenceNameCache.set(ip, { name, expiresAt: Date.now() + PRESENCE_NAME_CACHE_MS });
  return name;
}

function doRequest(path, request, headers = {}) {
  const outgoing = new Request(`https://durable.internal${path}`, request);
  for (const [name, value] of Object.entries(headers)) outgoing.headers.set(name, value);
  return outgoing;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request, env) });
    if (url.pathname === "/health") return json({ ok: true, service: "kui-realtime", version: 1 }, 200, cors(request, env));

    if (url.pathname === "/agent/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "WebSocket required" }, 426);
      const ip = url.searchParams.get("ip") || "";
      const role = url.searchParams.get("role") || "";
      if (!['core', 'proxy'].includes(role)) return json({ error: "Invalid role" }, 400);
      if (!(await verifyAgent(request.headers.get("Authorization"), ip, env))) return json({ error: "Unauthorized" }, 401);
      const name = await presenceName(ip, env);
      if (!name) return json({ error: "VPS not found" }, 404);
      const stub = env.VPS_PRESENCE.get(env.VPS_PRESENCE.idFromName(name));
      return stub.fetch(doRequest("/ws", request, { "X-KUI-IP": ip, "X-KUI-ROLE": role }));
    }

    if (url.pathname === "/dashboard/ticket" && request.method === "POST") {
      if (!(await verifyAdmin(request.headers.get("Authorization"), request, env))) return json({ error: "Forbidden" }, 403, cors(request, env));
      const hub = env.DASHBOARD_HUB.get(env.DASHBOARD_HUB.idFromName("main"));
      const response = await hub.fetch(new Request("https://hub.internal/ticket", { method: "POST", headers: { "X-KUI-USER": "admin" } }));
      return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...cors(request, env) } });
    }

    if (url.pathname === "/dashboard/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "WebSocket required" }, 426);
      if (!isAllowedPagesOrigin(request.headers.get("Origin") || "", env)) return json({ error: "Forbidden origin" }, 403);
      const hub = env.DASHBOARD_HUB.get(env.DASHBOARD_HUB.idFromName("main"));
      return hub.fetch(doRequest(`/ws?ticket=${encodeURIComponent(url.searchParams.get("ticket") || "")}`, request));
    }

    if (url.pathname === "/public/ws") {
      return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }

    if (url.pathname === "/dashboard/snapshot") {
      if (!(await verifyAdmin(request.headers.get("Authorization"), request, env))) return json({ error: "Forbidden" }, 403, cors(request, env));
      const hub = env.DASHBOARD_HUB.get(env.DASHBOARD_HUB.idFromName("main"));
      const response = await hub.fetch(new Request("https://hub.internal/snapshot"));
      return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...cors(request, env) } });
    }

    if (url.pathname === "/notify" && request.method === "POST") {
      if (!(await verifyAdmin(request.headers.get("Authorization"), request, env))) return json({ error: "Forbidden" }, 403, cors(request, env));
      const body = await request.json().catch(() => ({}));
      const ips = body.ip ? [body.ip] : (await env.DB.prepare("SELECT ip FROM servers").all()).results.map(row => row.ip);
      await Promise.all(ips.slice(0, 100).map(async ip => {
        const name = await presenceName(ip, env);
        if (!name) return;
        const stub = env.VPS_PRESENCE.get(env.VPS_PRESENCE.idFromName(name));
        return stub.fetch(new Request("https://presence.internal/notify", { method: "POST" }));
      }));
      return json({ success: true, notified: ips.length }, 200, cors(request, env));
    }

    if (url.pathname === "/egress-refresh" && request.method === "POST") {
      if (!(await verifyAdmin(request.headers.get("Authorization"), request, env))) return json({ error: "Forbidden" }, 403, cors(request, env));
      const body = await request.json().catch(() => ({}));
      const ip = String(body.ip || "");
      const expectedMode = String(body.expected_mode || "");
      const expectedRevision = Number(body.expected_revision);
      const name = await presenceName(ip, env);
      if (!name) return json({ error: "VPS not found" }, 404, cors(request, env));
      const requestId = /^[0-9a-f-]{36}$/i.test(String(body.request_id || "")) ? String(body.request_id) : crypto.randomUUID();
      const stub = env.VPS_PRESENCE.get(env.VPS_PRESENCE.idFromName(name));
      const response = await stub.fetch(new Request("https://presence.internal/egress-refresh", { method: "POST", headers: { "X-KUI-Request-ID": requestId, "X-KUI-Expected-Mode": expectedMode, "X-KUI-Expected-Revision": String(expectedRevision) } }));
      return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...cors(request, env) } });
    }

    if (url.pathname === "/warp-optimize" && request.method === "POST") {
      if (!(await verifyAdmin(request.headers.get("Authorization"), request, env))) return json({ error: "Forbidden" }, 403, cors(request, env));
      const body = await request.json().catch(() => ({}));
      const ip = String(body.ip || "");
      const action = String(body.action || "");
      if (!/^[0-9A-Fa-f:.]{2,64}$/.test(ip) || !["scan", "apply", "cancel", "restore", "policy"].includes(action)) return json({ error: "Invalid WARP optimizer request" }, 400, cors(request, env));
      if (action === "apply" && (!safeProxyAddress(body.address) || !Number.isInteger(Number(body.port)) || Number(body.port) < 1 || Number(body.port) > 65535)) return json({ error: "Invalid WARP Endpoint" }, 400, cors(request, env));
      if (action === "policy" && !["manual", "on_failure", "first_enable"].includes(String(body.policy || ""))) return json({ error: "Invalid WARP optimizer policy" }, 400, cors(request, env));
      const name = await presenceName(ip, env);
      if (!name) return json({ error: "VPS not found" }, 404, cors(request, env));
      const requestId = /^[0-9a-f-]{36}$/i.test(String(body.request_id || "")) ? String(body.request_id) : crypto.randomUUID();
      const stub = env.VPS_PRESENCE.get(env.VPS_PRESENCE.idFromName(name));
      const response = await stub.fetch(new Request("https://presence.internal/warp-optimize", { method: "POST", headers: { "Content-Type": "application/json", "X-KUI-Request-ID": requestId }, body: JSON.stringify({ action, address: String(body.address || ""), port: Number(body.port) || 0, policy: String(body.policy || "") }) }));
      return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...cors(request, env) } });
    }

    if (url.pathname === "/public-policy" && request.method === "POST") {
      if (!(await verifyAdmin(request.headers.get("Authorization"), request, env))) return json({ error: "Forbidden" }, 403, cors(request, env));
      const body = await request.json().catch(() => ({}));
      const hub = env.DASHBOARD_HUB.get(env.DASHBOARD_HUB.idFromName("main"));
      const response = await hub.fetch(new Request("https://hub.internal/public-policy", { method: "POST", headers: { "X-KUI-Public": body.public === true ? "1" : "0" } }));
      return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...cors(request, env) } });
    }

    if (url.pathname === "/frequency-policy" && request.method === "POST") {
      if (!(await verifyAdmin(request.headers.get("Authorization"), request, env))) return json({ error: "Forbidden" }, 403, cors(request, env));
      const policy = validFrequencyPolicy(await request.json().catch(() => null));
      if (!policy) return json({ error: "Invalid frequency policy" }, 400, cors(request, env));
      const hub = env.DASHBOARD_HUB.get(env.DASHBOARD_HUB.idFromName("main"));
      const response = await hub.fetch(new Request("https://hub.internal/frequency-policy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ admin: policy.admin / 1000, public: policy.public / 1000, idle: policy.idle / 1000 }) }));
      return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...cors(request, env) } });
    }

    return json({ error: "Not found" }, 404, cors(request, env));
  },
};

export class VpsPresence extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.snapshot = { ip: "", core: null, proxy: null, updated_at: 0 };
    this.dashboardActive = false;
    this.dashboardInterval = IDLE_STATUS_INTERVAL;
    this.dashboardActiveUntil = 0;
    this.lastPersisted = 0;
    this.lastProxyDbPersisted = 0;
    this.lastStatusBroadcast = 0;
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong")); } catch {}
    this.lastSeq = { core: -1, proxy: -1 };
    this.bootId = { core: "", proxy: "" };
    ctx.blockConcurrencyWhile(async () => {
      const state = await ctx.storage.get("state");
      this.snapshot = state?.snapshot || (await ctx.storage.get("snapshot")) || this.snapshot;
      this.lastSeq = state?.lastSeq || (await ctx.storage.get("lastSeq")) || this.lastSeq;
      this.bootId = state?.bootId || (await ctx.storage.get("bootId")) || this.bootId;
      this.lastPersisted = Number(state?.persistedAt) || 0;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const ip = request.headers.get("X-KUI-IP") || "";
      const role = request.headers.get("X-KUI-ROLE") || "";
      for (const existing of this.ctx.getWebSockets(role)) {
        try { existing.close(1000, "replaced"); } catch {}
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.serializeAttachment({ ip, role, connected_at: Date.now(), bootId: "", lastSeq: -1, lastSeen: 0, state: null });
      this.ctx.acceptWebSocket(server, [role]);
      const hub = this.env.DASHBOARD_HUB.get(this.env.DASHBOARD_HUB.idFromName("main"));
      try {
        const activeResponse = await hub.fetch(new Request("https://hub.internal/active"));
        const active = activeResponse.ok ? await activeResponse.json() : null;
        this.setDashboardActivity(active?.active === true, Number(active?.interval_seconds) * 1000 || IDLE_STATUS_INTERVAL, Number(active?.until) || Date.now() + 300000);
      } catch {}
      this.snapshot.ip = ip;
      this.snapshot[`${role}_connected`] = true;
      this.snapshot[`${role}_connected_at`] = Date.now();
      await this.broadcast();
      server.send(JSON.stringify({ type: "hello.ok", ts: Date.now(), role }));
      server.send(JSON.stringify({ type: "status.interval", seconds: this.dashboardInterval / 1000 }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/notify") {
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.send(JSON.stringify({ type: "config.refresh", ts: Date.now() })); } catch {}
      }
      return json({ success: true });
    }
    if (url.pathname === "/egress-refresh" && request.method === "POST") {
      const sockets = this.ctx.getWebSockets("core");
      if (!sockets.length) return json({ error: "VPS Agent 当前离线" }, 409);
      const requestId = request.headers.get("X-KUI-Request-ID") || crypto.randomUUID();
      const expectedMode = request.headers.get("X-KUI-Expected-Mode") || "";
      const expectedRevision = Number(request.headers.get("X-KUI-Expected-Revision"));
      if (!["native", "residential", "warp_ipv4", "warp_ipv6", "warp_dual", "socks5"].includes(expectedMode) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return json({ error: "出口检测目标状态无效" }, 409);
      let sent = false;
      for (const ws of sockets) {
        try { ws.send(JSON.stringify({ type: "egress.refresh", request_id: requestId, expected_mode: expectedMode, expected_revision: expectedRevision, ts: Date.now() })); sent = true; } catch {}
      }
      return sent ? json({ success: true, request_id: requestId }) : json({ error: "出口检测指令发送失败" }, 503);
    }
    if (url.pathname === "/warp-optimize" && request.method === "POST") {
      const sockets = this.ctx.getWebSockets("core");
      if (!sockets.length) return json({ error: "VPS Agent 当前离线" }, 409);
      const requestId = request.headers.get("X-KUI-Request-ID") || crypto.randomUUID();
      const command = await request.json().catch(() => ({}));
      let sent = false;
      for (const ws of sockets) {
        try { ws.send(JSON.stringify({ type: "warp.optimize", request_id: requestId, action: command.action, address: command.address, port: command.port, policy: command.policy, ts: Date.now() })); sent = true; } catch {}
      }
      return sent ? json({ success: true, request_id: requestId }) : json({ error: "WARP 优化指令发送失败" }, 503);
    }
    if (url.pathname === "/dashboard-active" && request.method === "POST") {
      this.setDashboardActivity(request.headers.get("X-KUI-Active") === "1", Number(request.headers.get("X-KUI-Interval")) || IDLE_STATUS_INTERVAL, Number(request.headers.get("X-KUI-Until")) || Date.now() + 300000);
      return json({ success: true });
    }
    if (url.pathname === "/snapshot") return json(this.publicSnapshot());
    return json({ error: "Not found" }, 404);
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > 64 * 1024) return;
    let envelope;
    try { envelope = JSON.parse(message); } catch { return; }
    const attachment = ws.deserializeAttachment() || {};
    const role = attachment?.role;
    if (!['core', 'proxy'].includes(role) || envelope.role !== role || envelope.ip !== attachment.ip) return;
    const sequence = Number(envelope.seq);
    const bootId = String(envelope.boot_id || "");
    const messageType = String(envelope.type || "status");
    if (!Number.isSafeInteger(sequence) || sequence < 0 || !bootId) return;
    if (attachment.bootId !== bootId) {
      attachment.bootId = bootId;
      attachment.lastSeq = -1;
    }
    if (this.bootId[role] === bootId && sequence <= Number(this.lastSeq[role] ?? -1)) return;
    if (sequence <= Number(attachment.lastSeq ?? -1)) return;
    attachment.lastSeq = sequence;
    this.bootId[role] = bootId;
    this.lastSeq[role] = sequence;
    if (messageType === "hello") {
      attachment.capabilities = Array.isArray(envelope.data?.capabilities) ? envelope.data.capabilities.slice(0, 20).map(value => String(value).slice(0, 64)) : [];
      ws.serializeAttachment(attachment);
      return;
    }
    if (messageType === "config.result") {
      const result = { success: envelope.data?.success === true, status: String(envelope.data?.status || "").slice(0, 32), message: String(envelope.data?.message || "").slice(0, 500), component: String(envelope.data?.component || "").slice(0, 32), revision: Number(envelope.data?.revision) || 0, deployment_id: String(envelope.data?.deployment_id || "").slice(0, 64), desired_mode: String(envelope.data?.desired_mode || "").slice(0, 32), applied_mode: String(envelope.data?.applied_mode || "").slice(0, 32), egress_ip: safeProxyAddress(envelope.data?.egress_ip), error: String(envelope.data?.error || "").slice(0, 500), applied_at: Number(envelope.data?.applied_at) || Date.now() };
      this.snapshot[`${role}_config_result`] = result;
      if (result.component === "egress") {
        this.snapshot[`${role}_egress_result`] = result;
        const accepted = await this.persistEgressResult(attachment.ip, result);
        try { ws.send(JSON.stringify({ type: "config.result.ack", component: "egress", revision: result.revision, success: result.success, accepted, ts: Date.now() })); } catch {}
      }
      this.snapshot[`${role}_config_result_at`] = Date.now();
      ws.serializeAttachment(attachment);
      await this.persistAndBroadcast();
      return;
    }
    if (messageType === "egress.probe.result") {
      if (role !== "core") return;
      const result = {
        success: envelope.data?.success === true,
        request_id: String(envelope.data?.request_id || "").slice(0, 64),
        applied_mode: String(envelope.data?.applied_mode || "").slice(0, 32),
        applied_revision: Number(envelope.data?.applied_revision),
        egress_ip: safeProxyAddress(envelope.data?.egress_ip),
        error: String(envelope.data?.error || "").slice(0, 500),
        measured_at: Number(envelope.data?.measured_at) || Date.now(),
      };
      result.accepted = false;
      if (result.success && result.egress_ip && Number.isSafeInteger(result.applied_revision) && result.applied_revision >= 0) {
        const updated = await this.env.DB.prepare("UPDATE servers SET egress_ip = ? WHERE ip = ? AND egress_applied_mode = ? AND egress_applied_revision = ?").bind(result.egress_ip, attachment.ip, result.applied_mode, result.applied_revision).run();
        result.accepted = Number(updated.meta?.changes || 0) > 0;
        if (!result.accepted) {
          result.success = false;
          result.error = "出口配置已变化，已丢弃过期检测结果";
        }
      } else if (result.success) {
        result.success = false;
        result.error = "Agent 未返回有效的出口模式、版本或 IP";
      }
      this.snapshot.core_egress_probe_result = result;
      this.snapshot.core_egress_probe_result_at = Date.now();
      ws.serializeAttachment(attachment);
      await this.persistAndBroadcast();
      return;
    }
    if (messageType === "warp.optimize.result") {
      if (role !== "core") return;
      const warp = compactWarpState(envelope.data);
      if (!warp) return;
      const warpResult = { request_id: String(envelope.data?.request_id || "").slice(0, 64), error: String(envelope.data?.error || "").slice(0, 500), applied_mode: String(envelope.data?.applied_mode || "").slice(0, 32), applied_revision: Number(envelope.data?.applied_revision), egress_ip: safeProxyAddress(envelope.data?.egress_ip), accepted: false, warp, updated_at: Date.now() };
      if (warp.optimizer.status === "success" && warp.active_mode.startsWith("warp_") && warpResult.egress_ip) {
        const updated = await this.env.DB.prepare("UPDATE servers SET egress_ip = ? WHERE ip = ? AND egress_applied_mode = ? AND egress_applied_revision = ?").bind(warpResult.egress_ip, attachment.ip, warpResult.applied_mode, warpResult.applied_revision).run();
        warpResult.accepted = Number(updated.meta?.changes || 0) > 0;
        if (!warpResult.accepted) warpResult.egress_ip = "";
      } else {
        warpResult.egress_ip = "";
      }
      this.snapshot.core = { ...(this.snapshot.core || {}), warp };
      this.snapshot.core_warp_result = warpResult;
      this.snapshot.core_warp_result_at = Date.now();
      ws.serializeAttachment(attachment);
      await this.persistAndBroadcast();
      return;
    }
    if (messageType !== "status") return;
    const previousRoleState = this.snapshot[role];
    const nextRoleState = compactRoleState(role, envelope.data || {});
    const criticalChange = !previousRoleState || (role === "proxy" && JSON.stringify((previousRoleState.details || []).map(item => [item.tunnel, item.active, item.node_ip])) !== JSON.stringify((nextRoleState.details || []).map(item => [item.tunnel, item.active, item.node_ip])));
    attachment.lastSeen = Date.now();
    attachment.state = compactRoleState(role, nextRoleState);
    ws.serializeAttachment(attachment);
    this.snapshot.ip = attachment.ip;
    this.snapshot[role] = nextRoleState;
    this.snapshot[`${role}_connected`] = true;
    this.snapshot[`${role}_last_seen`] = attachment.lastSeen;
    this.snapshot.updated_at = attachment.lastSeen;
    if (role === "proxy") await this.persistProxyStatus(attachment.ip, nextRoleState, attachment.lastSeen, criticalChange);
    if (role === "core" && Date.now() - this.lastPersisted >= 60000) {
      this.lastPersisted = Date.now();
      await this.ctx.storage.put("state", { snapshot: this.snapshot, lastSeq: this.lastSeq, bootId: this.bootId, persistedAt: this.lastPersisted });
    }
    if (Date.now() >= this.dashboardActiveUntil) await this.refreshDashboardActivity();
    const statusBroadcastDue = this.dashboardActive && Date.now() - this.lastStatusBroadcast >= this.dashboardInterval;
    if (statusBroadcastDue) this.lastStatusBroadcast = Date.now();
    if (statusBroadcastDue || criticalChange) await this.broadcast();
  }

  async persistProxyStatus(ip, state, lastSeen, force = false) {
    if (!force && lastSeen - this.lastProxyDbPersisted < PROXY_DB_PERSIST_INTERVAL) return;
    this.lastProxyDbPersisted = lastSeen;
    try {
      const statements = [
        this.env.DB.prepare(`INSERT INTO proxy_ctrl_servers (ip, details, last_seen) VALUES (?1, ?2, ?3) ON CONFLICT(ip) DO UPDATE SET details = excluded.details, last_seen = excluded.last_seen`).bind(ip, JSON.stringify(state.details || []), lastSeen),
      ];
      if (state.logs) statements.push(this.env.DB.prepare(`INSERT INTO server_logs (ip, logs, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(ip) DO UPDATE SET logs = excluded.logs, updated_at = excluded.updated_at`).bind(ip, state.logs, lastSeen));
      await this.env.DB.batch(statements);
    } catch (error) {
      this.lastProxyDbPersisted = 0;
      console.error("[realtime] proxy status persistence failed", ip, error);
    }
  }

  async persistEgressResult(ip, result) {
    const modes = ["native", "residential", "warp_ipv4", "warp_ipv6", "warp_dual", "socks5"];
    if (!Number.isSafeInteger(result.revision) || result.revision < 0 || !modes.includes(result.applied_mode)) return false;
    try {
      if (result.deployment_id) {
        const deployment = await this.env.DB.prepare("SELECT val FROM sys_config WHERE key = 'deployment_id'").first();
        if (deployment?.val && deployment.val !== result.deployment_id) return false;
      }
      let update;
      if (result.status === "preparing") {
        update = await this.env.DB.prepare("UPDATE servers SET egress_status = 'preparing', egress_error = ? WHERE ip = ? AND egress_revision = ? AND egress_mode = ?").bind(result.message || "WARP environment is preparing", ip, result.revision, result.desired_mode).run();
      } else if (result.success) {
        update = await this.env.DB.prepare("UPDATE servers SET egress_applied_mode = ?, egress_applied_revision = ?, egress_applied_config = egress_desired_config, egress_status = 'applied', egress_error = '', egress_applied_at = ?, egress_ip = ? WHERE ip = ? AND egress_revision = ? AND egress_mode = ?").bind(result.applied_mode, result.revision, result.applied_at, result.egress_ip || "", ip, result.revision, result.applied_mode).run();
      } else {
        update = await this.env.DB.prepare("UPDATE servers SET egress_status = 'failed', egress_error = ?, egress_applied_at = ? WHERE ip = ? AND egress_revision = ? AND egress_applied_mode = ?").bind(result.error || "Egress apply failed", result.applied_at, ip, result.revision, result.applied_mode).run();
      }
      if (Number(update.meta?.changes || 0) > 0) return true;
      const current = await this.env.DB.prepare("SELECT egress_mode, egress_applied_mode, egress_revision, egress_applied_revision, egress_status FROM servers WHERE ip = ?").bind(ip).first();
      return result.status === "preparing"
        ? current?.egress_status === "preparing" && Number(current.egress_revision) === result.revision
        : result.success
        ? current?.egress_status === "applied" && Number(current.egress_applied_revision) === result.revision && current.egress_applied_mode === result.applied_mode
        : current?.egress_status === "failed" && Number(current.egress_revision) === result.revision && current.egress_applied_mode === result.applied_mode;
    } catch (error) {
      console.error("[realtime] egress result persistence failed", ip, error);
      return false;
    }
  }

  async webSocketClose(ws) {
    await this.markDisconnected(ws);
  }

  async webSocketError(ws) {
    await this.markDisconnected(ws);
  }

  async markDisconnected(ws) {
    const role = ws.deserializeAttachment()?.role;
    if (['core', 'proxy'].includes(role) && this.ctx.getWebSockets(role).length === 0) {
      this.snapshot[`${role}_connected`] = false;
      this.snapshot[`${role}_disconnected_at`] = Date.now();
      await this.persistAndBroadcast();
    }
  }

  setDashboardActivity(active, interval, until) {
    const changed = this.dashboardActive !== active || this.dashboardInterval !== interval;
    this.dashboardActive = active;
    this.dashboardInterval = interval;
    this.dashboardActiveUntil = until;
    if (!changed) return;
    this.lastStatusBroadcast = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(JSON.stringify({ type: "status.interval", seconds: interval / 1000 })); } catch {}
    }
  }

  async refreshDashboardActivity() {
    const hub = this.env.DASHBOARD_HUB.get(this.env.DASHBOARD_HUB.idFromName("main"));
    try {
      const response = await hub.fetch(new Request("https://hub.internal/active"));
      const active = response.ok ? await response.json() : null;
      this.setDashboardActivity(active?.active === true, Number(active?.interval_seconds) * 1000 || IDLE_STATUS_INTERVAL, Number(active?.until) || Date.now() + IDLE_STATUS_INTERVAL);
    } catch {
      this.setDashboardActivity(false, IDLE_STATUS_INTERVAL, Date.now() + IDLE_STATUS_INTERVAL);
    }
  }

  publicSnapshot() {
    this.syncFromSockets();
    const now = Date.now();
    const coreAge = this.snapshot.core_last_seen ? now - this.snapshot.core_last_seen : null;
    const proxyAge = this.snapshot.proxy_last_seen ? now - this.snapshot.proxy_last_seen : null;
    return {
      ...this.snapshot,
      core_state: !this.snapshot.core_connected ? "offline" : coreAge === null || coreAge > STATUS_STALE_AFTER ? "stale" : "online",
      proxy_state: !this.snapshot.proxy_connected ? "offline" : proxyAge === null || proxyAge > STATUS_STALE_AFTER ? "stale" : "online",
      core_age: coreAge,
      proxy_age: proxyAge,
      boot_id: this.bootId,
      sequence: this.lastSeq,
    };
  }

  syncFromSockets() {
    for (const role of ["core", "proxy"]) {
      const socket = this.ctx.getWebSockets(role)[0];
      const attachment = socket?.deserializeAttachment();
      this.snapshot[`${role}_connected`] = !!socket;
      if (!attachment) continue;
      this.snapshot.ip = attachment.ip || this.snapshot.ip;
      if (attachment.state) this.snapshot[role] = { ...(this.snapshot[role] || {}), ...attachment.state };
      if (attachment.lastSeen) this.snapshot[`${role}_last_seen`] = attachment.lastSeen;
      this.bootId[role] = attachment.bootId || this.bootId[role];
      this.lastSeq[role] = Number(attachment.lastSeq ?? this.lastSeq[role]);
    }
    this.snapshot.updated_at = Math.max(this.snapshot.core_last_seen || 0, this.snapshot.proxy_last_seen || 0, this.snapshot.updated_at || 0);
  }

  async persistAndBroadcast() {
    this.snapshot.updated_at = Date.now();
    this.lastPersisted = Date.now();
    await this.ctx.storage.put("state", { snapshot: this.snapshot, lastSeq: this.lastSeq, bootId: this.bootId, persistedAt: this.lastPersisted });
    await this.broadcast();
  }

  async broadcast() {
    const hub = this.env.DASHBOARD_HUB.get(this.env.DASHBOARD_HUB.idFromName("main"));
    if (Date.now() >= this.dashboardActiveUntil) await this.refreshDashboardActivity();
    if (!this.dashboardActive) return;
    await hub.fetch(new Request("https://hub.internal/update", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-KUI-Presence": "1" },
      body: JSON.stringify(this.publicSnapshot()),
    }));
  }
}

export class DashboardHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong")); } catch {}
    this.activityUntil = 0;
    this.activityInterval = IDLE_STATUS_INTERVAL;
    this.frequencyPolicy = DEFAULT_FREQUENCY_POLICY;
    this.snapshotCache = null;
    this.snapshotCachedAt = 0;
    ctx.blockConcurrencyWhile(async () => {
      this.frequencyPolicy = validFrequencyPolicy(await ctx.storage.get("frequencyPolicy")) || DEFAULT_FREQUENCY_POLICY;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/ticket" && request.method === "POST") {
      const ticket = crypto.randomUUID();
      await this.ctx.storage.put(`ticket:${ticket}`, { user: request.headers.get("X-KUI-USER") || "", expires: Date.now() + 60000 });
      await this.ctx.storage.setAlarm(Date.now() + 65000);
      return json({ ticket, expires_in: 60 });
    }
    if (url.pathname === "/active") {
      const interval = this.viewerInterval();
      const active = this.ctx.getWebSockets("dashboard").length + this.ctx.getWebSockets("public").length > 0;
      return json({ active, interval_seconds: interval / 1000, until: active ? Date.now() + VIEWER_LEASE_MS : 0 });
    }
    if (url.pathname === "/ws") {
      const ticket = url.searchParams.get("ticket") || "";
      const record = await this.ctx.storage.get(`ticket:${ticket}`);
      if (!record || record.expires < Date.now()) {
        if (record) await this.ctx.storage.delete(`ticket:${ticket}`);
        return json({ error: "Invalid ticket" }, 401);
      }
      await this.ctx.storage.delete(`ticket:${ticket}`);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      if (this.ctx.getWebSockets("dashboard").length >= MAX_DASHBOARD_SOCKETS) return json({ error: "Too many dashboard connections" }, 429);
      server.serializeAttachment({ user: record.user, connected_at: Date.now(), lastActivity: Date.now(), lastResync: 0 });
      this.ctx.acceptWebSocket(server, ["dashboard"]);
      await this.setDashboardActivity();
      await this.ctx.storage.setAlarm(Date.now() + 30000);
      server.send(JSON.stringify({ type: "snapshot", data: await this.snapshot(), ts: Date.now() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/public-ws") {
      return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === "/public-policy" && request.method === "POST") {
      for (const ws of this.ctx.getWebSockets("public")) {
        try { ws.close(1008, "public realtime disabled"); } catch {}
      }
      return json({ success: true, enabled: false });
    }
    if (url.pathname === "/frequency-policy" && request.method === "POST") {
      const policy = validFrequencyPolicy(await request.json().catch(() => null));
      if (!policy) return json({ error: "Invalid frequency policy" }, 400);
      this.frequencyPolicy = policy;
      await this.ctx.storage.put("frequencyPolicy", { admin: policy.admin / 1000, public: policy.public / 1000, idle: policy.idle / 1000 });
      await this.setDashboardActivity();
      return json({ success: true, policy: { admin: policy.admin / 1000, public: policy.public / 1000, idle: policy.idle / 1000 } });
    }
    if (url.pathname === "/update" && request.method === "POST") {
      if (request.headers.get("X-KUI-Presence") !== "1") return json({ error: "Forbidden" }, 403);
      const snapshot = await request.json();
      if (!snapshot.ip) return json({ error: "Invalid snapshot" }, 400);
      this.snapshotCache = null;
      this.snapshotCachedAt = 0;
      const payload = JSON.stringify({ type: "patch", data: snapshot, ts: Date.now() });
      for (const ws of this.ctx.getWebSockets("dashboard")) {
        try { ws.send(payload); } catch {}
      }
      const publicSockets = this.ctx.getWebSockets("public");
      for (const ws of publicSockets) {
        try { ws.close(1008, "public realtime disabled"); } catch {}
      }
      return json({ success: true });
    }
    if (url.pathname === "/snapshot") return json(await this.snapshot());
    return json({ error: "Not found" }, 404);
  }

  async snapshot() {
    if (this.snapshotCache && Date.now() - this.snapshotCachedAt < SNAPSHOT_CACHE_MS) return this.snapshotCache;
    const servers = (await this.env.DB.prepare("SELECT ip, cpu, mem, disk, load, uptime, net_in_speed, net_out_speed, tcp_conn, udp_conn, last_report FROM servers").all()).results || [];
    const proxies = (await this.env.DB.prepare("SELECT ip, details, last_seen FROM proxy_ctrl_servers").all()).results || [];
    const proxyMap = new Map(proxies.map(row => [row.ip, row]));
    const snapshots = await Promise.all(servers.slice(0, 100).map(async row => {
      const { ip } = row;
      const name = await presenceName(ip, this.env);
      if (!name) return null;
      const presence = this.env.VPS_PRESENCE.get(this.env.VPS_PRESENCE.idFromName(name));
      const response = await presence.fetch(new Request("https://presence.internal/snapshot"));
      const live = response.ok ? await response.json() : null;
      if (live?.ip && (live.core || live.proxy)) return live;
      const proxy = proxyMap.get(ip);
      let details = [];
      try { details = JSON.parse(proxy?.details || "[]"); } catch {}
      return {
        ip,
        transport: "http",
        core: { cpu: row.cpu, mem: row.mem, disk: row.disk, load: row.load, uptime: row.uptime, net_in_speed: row.net_in_speed, net_out_speed: row.net_out_speed, tcp_conn: row.tcp_conn, udp_conn: row.udp_conn },
        core_last_seen: row.last_report || 0,
        core_state: Date.now() - (row.last_report || 0) < 360000 ? "online" : Date.now() - (row.last_report || 0) < 1200000 ? "stale" : "offline",
        proxy: proxy ? { details } : null,
        proxy_last_seen: proxy?.last_seen || 0,
        proxy_state: proxy && Date.now() - proxy.last_seen < 360000 ? "online" : proxy && Date.now() - proxy.last_seen < 1200000 ? "stale" : "offline",
        updated_at: Math.max(row.last_report || 0, proxy?.last_seen || 0),
      };
    }));
    this.snapshotCache = snapshots.filter(Boolean);
    this.snapshotCachedAt = Date.now();
    return this.snapshotCache;
  }

  async webSocketMessage(ws, message) {
    if (message === "ping") {
      const attachment = ws.deserializeAttachment() || {}; attachment.lastActivity = Date.now(); ws.serializeAttachment(attachment);
      ws.send("pong");
      return;
    }
    try {
      const parsed = JSON.parse(message);
      if (parsed?.type === "resync") {
        if (ws.deserializeAttachment()?.public === true) {
          ws.close(1008, "public realtime disabled");
          return;
        }
        const attachment = ws.deserializeAttachment() || {};
        if (Date.now() - Number(attachment.lastResync || 0) < RESYNC_COOLDOWN_MS) return;
        attachment.lastResync = Date.now(); attachment.lastActivity = Date.now(); ws.serializeAttachment(attachment);
        const snapshots = await this.snapshot();
        ws.send(JSON.stringify({ type: "snapshot", data: snapshots, ts: Date.now() }));
      }
      if (parsed?.type === "activity") {
        const attachment = ws.deserializeAttachment() || {}; attachment.lastActivity = Date.now(); ws.serializeAttachment(attachment);
        if (ws.deserializeAttachment()?.public === true) {
          ws.close(1008, "public realtime disabled");
          return;
        }
        await this.setDashboardActivity();
      }
    } catch {}
  }

  async webSocketClose() {
    await this.setDashboardActivity();
  }
  async webSocketError() {
    await this.setDashboardActivity();
  }

  viewerInterval() {
    if (this.ctx.getWebSockets("dashboard").length) return this.frequencyPolicy.admin;
    if (this.ctx.getWebSockets("public").length) return this.frequencyPolicy.public;
    return this.frequencyPolicy.idle;
  }

  async setDashboardActivity() {
    const interval = this.viewerInterval();
    const active = this.ctx.getWebSockets("dashboard").length + this.ctx.getWebSockets("public").length > 0;
    const until = active ? Date.now() + VIEWER_LEASE_MS : 0;
    if (this.activityInterval === interval && (!active || this.activityUntil - Date.now() > 60000)) return;
    this.activityUntil = until;
    this.activityInterval = interval;
    const servers = (await this.env.DB.prepare("SELECT ip FROM servers").all()).results || [];
    await Promise.all(servers.slice(0, 100).map(async ({ ip }) => {
      const name = await presenceName(ip, this.env);
      if (!name) return;
      const presence = this.env.VPS_PRESENCE.get(this.env.VPS_PRESENCE.idFromName(name));
      return presence.fetch(new Request("https://presence.internal/dashboard-active", { method: "POST", headers: { "X-KUI-Active": active ? "1" : "0", "X-KUI-Interval": String(interval), "X-KUI-Until": String(until) } }));
    }));
  }

  async alarm() {
    const tickets = await this.ctx.storage.list({ prefix: "ticket:" });
    const now = Date.now();
    const expired = [];
    let next = 0;
    for (const [key, value] of tickets) {
      if (!value?.expires || value.expires <= now) expired.push(key);
      else if (!next || value.expires < next) next = value.expires;
    }
    if (expired.length) await this.ctx.storage.delete(expired);
    const hasActiveViewers = this.ctx.getWebSockets("dashboard").length + this.ctx.getWebSockets("public").length > 0;
    if (!hasActiveViewers) await this.setDashboardActivity();
    const publicSockets = this.ctx.getWebSockets("public");
    if (publicSockets.length) {
      for (const ws of publicSockets) {
        try { ws.close(1008, "public realtime disabled"); } catch {}
      }
    }
    if (hasActiveViewers) { const viewerCheck = Date.now() + 30000; if (!next || viewerCheck < next) next = viewerCheck; }
    if (next) await this.ctx.storage.setAlarm(next + 5000);
  }
}
