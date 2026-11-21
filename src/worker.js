import { onRequest, onRequestScheduled } from '../functions/api/[[path]].js';
import realtime, { DashboardHub, VpsPresence } from '../realtime/src/index.js';

export { DashboardHub, VpsPresence };

function apiParams(pathname) {
    const segments = pathname.slice('/api/'.length).split('/').filter(Boolean);
    return { path: segments };
}

function withWorkerOrigin(env, origin) {
    return Object.assign(Object.create(env), { PAGES_ORIGIN: origin, REALTIME_URL: origin });
}

function isRealtimeRoute(pathname) {
    return pathname === '/health'
        || pathname === '/agent/ws'
        || pathname === '/dashboard/ticket'
        || pathname === '/dashboard/ws'
        || pathname === '/dashboard/snapshot'
        || pathname === '/public/ws'
        || pathname === '/notify'
        || pathname === '/egress-refresh'
        || pathname === '/warp-optimize'
        || pathname === '/public-policy'
        || pathname === '/frequency-policy';
}

function escapeErrorHtml(value) {
    return String(value || 'Unknown error').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

const HASHED_UI_ASSET = /^\/ui-assets\/.+-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/i;
const RESTRICT_IMMUTABLE_CACHE = /(?:^|,)\s*(?:private|no-store|no-cache)(?:\s*=|\s*(?:,|$))/i;
const RESTRICT_HTML_CACHE = /(?:^|,)\s*(?:private|no-store)(?:\s*=|\s*(?:,|$))/i;
const NO_STORE_CACHE = /(?:^|,)\s*no-store(?:\s*=|\s*(?:,|$))/i;

function decodePathname(pathname) {
    const raw = String(pathname || '/');
    const segments = raw.split('/');
    const decoded = [];
    for (const segment of segments) {
        try {
            decoded.push(decodeURIComponent(segment));
        } catch {
            return null;
        }
    }
    return decoded;
}

export function normalizeStaticPathname(pathname) {
    const decodedSegments = decodePathname(pathname);
    if (!decodedSegments) return null;

    const normalized = [];
    for (const segment of decodedSegments) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            normalized.pop();
            continue;
        }
        if (segment.includes('/') || segment.includes('\\')) return null;
        normalized.push(segment);
    }
    return `/${normalized.join('/')}`;
}

export function isPrivateVpsPath(normalizedPathname) {
    const lowerPathname = normalizedPathname.toLowerCase();
    return lowerPathname === '/vps' || lowerPathname.startsWith('/vps/');
}

function requestMethod(methodOrRequest) {
    if (typeof methodOrRequest === 'string') return methodOrRequest.toUpperCase();
    return String(methodOrRequest?.method || 'GET').toUpperCase();
}

function applyStaticCacheHeaders(pathname, response, methodOrRequest = 'GET') {
    const method = requestMethod(methodOrRequest);
    if (method !== 'GET' && method !== 'HEAD') return new Headers(response.headers);

    const headers = new Headers(response.headers);
    const normalizedPath = normalizeStaticPathname(pathname) ?? String(pathname || '').split('?')[0];
    const contentType = (headers.get('Content-Type') || '').toLowerCase();
    const upstreamCache = headers.get('Cache-Control') || '';
    const isHtml = normalizedPath === '/' || normalizedPath === '/index.html' || contentType.startsWith('text/html');
    const isUiAsset = normalizedPath.startsWith('/ui-assets/');

    if (response.status !== 200 && response.status !== 304) {
        if (isUiAsset && !NO_STORE_CACHE.test(upstreamCache)) {
            headers.set('Cache-Control', 'no-store');
        }
    } else if (isHtml) {
        if (!RESTRICT_HTML_CACHE.test(upstreamCache)) {
            headers.set('Cache-Control', 'no-cache, must-revalidate');
        }
    } else if (HASHED_UI_ASSET.test(normalizedPath)) {
        if (!RESTRICT_IMMUTABLE_CACHE.test(upstreamCache)) {
            headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }

    return headers;
}

function mustPreserveResponse(response) {
    return response.status === 304 || response.status === 204 || response.status === 205;
}

export function withStaticCacheHeaders(pathname, response, methodOrRequest = 'GET') {
    const headers = applyStaticCacheHeaders(pathname, response, methodOrRequest);
    const method = requestMethod(methodOrRequest);
    const noBody = method === 'HEAD' || mustPreserveResponse(response);
    if (noBody) response.body?.cancel().catch(() => {});
    return new Response(noBody ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function withSecurityHeaders(response, headers = new Headers(response.headers)) {
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' https://unpkg.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' https: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    headers.set('Referrer-Policy', 'same-origin');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');
    return headers;
}

function hardenedResponse(response, methodOrRequest = 'GET') {
    const headers = withSecurityHeaders(response);
    const noBody = requestMethod(methodOrRequest) === 'HEAD' || mustPreserveResponse(response);
    if (noBody) response.body?.cancel().catch(() => {});
    return new Response(noBody ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const normalizedPathname = normalizeStaticPathname(url.pathname);
        if (normalizedPathname === null) {
            return hardenedResponse(new Response('Bad Request', {
                status: 400,
                headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
            }), request);
        }
        const runtimeEnv = withWorkerOrigin(env, url.origin);

        if (normalizedPathname === '/api' || normalizedPathname.startsWith('/api/')) {
            return onRequest({ request, env: runtimeEnv, params: apiParams(normalizedPathname), waitUntil: ctx.waitUntil.bind(ctx) });
        }

        if (isRealtimeRoute(normalizedPathname)) {
            return realtime.fetch(request, runtimeEnv, ctx);
        }

        if (isPrivateVpsPath(normalizedPathname)) {
            return hardenedResponse(new Response('Not Found', {
                status: 404,
                headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
            }), request);
        }

        // Workers + Assets: 优先通过 Worker 处理，兜底检查 ASSETS 绑定
        if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
            return hardenedResponse(new Response(
                `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>KUI - 部署问题</title><style>body{font-family:-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f8fafc;color:#1e293b;line-height:1.6}div{max-width:600px;padding:40px;text-align:center}h1{font-size:24px;color:#0f172a;margin-bottom:8px}p{color:#64748b;font-size:15px;margin:8px 0}code{background:#e2e8f0;padding:2px 6px;border-radius:4px;font-size:13px}ol{text-align:left;color:#475569;font-size:14px}li{margin:6px 0}.btn{display:inline-block;margin-top:20px;background:#3b82f6;color:#fff;padding:12px 28px;border-radius:12px;text-decoration:none;font-weight:600;font-size:14px}</style></head><body><div>
                <h1>⚙️ KUI 需要配置才能运行</h1>
                <p>一键部署后, Cloudflare 需要正确绑定以下资源：</p>
                <ol>
                    <li><strong>D1 数据库</strong> — Variable name: <code>DB</code></li>
                    <li><strong>Durable Objects</strong> — <code>VPS_PRESENCE</code> → VpsPresence, <code>DASHBOARD_HUB</code> → DashboardHub</li>
                    <li><strong>Assets 绑定</strong> — Workers + Assets 模式</li>
                </ol>
                <p>请进入 Cloudflare Dashboard → Worker → Settings → Variables, 添加缺失的绑定后重新部署。</p>
                <a class="btn" href="https://dash.cloudflare.com/?to=/:account/workers-and-pages" target="_blank">前往 Cloudflare Dashboard</a>
                <p style="margin-top:24px;font-size:12px;color:#94a3b8">详细步骤请查看项目 README → 一键部署故障排除</p>
            </div></body></html>`,
                { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
            ), request);
        }

        try {
            const assetResponse = await env.ASSETS.fetch(request);
            const headers = applyStaticCacheHeaders(normalizedPathname, assetResponse, request);
            const noBody = requestMethod(request) === 'HEAD'
                || mustPreserveResponse(assetResponse);
            if (noBody) assetResponse.body?.cancel().catch(() => {});
            return new Response(noBody ? null : assetResponse.body, {
                status: assetResponse.status,
                statusText: assetResponse.statusText,
                headers: withSecurityHeaders(assetResponse, headers),
            });
        } catch (e) {
            return hardenedResponse(new Response(
                `<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h1>⛔ 服务未就绪</h1><p>${escapeErrorHtml(e.message)}</p><p>请检查 Cloudflare Dashboard 中的绑定配置。</p></body></html>`,
                { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
            ), request);
        }
    },

    async scheduled(controller, env, ctx) {
        return onRequestScheduled({ scheduledTime: controller.scheduledTime, cron: controller.cron, env: withWorkerOrigin(env, ''), waitUntil: ctx.waitUntil.bind(ctx) });
    },
};
