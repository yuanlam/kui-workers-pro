import fs from 'node:fs/promises';
import path from 'node:path';

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.py': 'text/x-python; charset=utf-8',
    '.sh': 'text/x-shellscript; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
};

function contentTypeFor(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_TYPES[ext] || 'application/octet-stream';
}

function etagMatches(headerValue, etag) {
    if (!headerValue) return false;
    if (headerValue.trim() === '*') return true;
    return headerValue
        .split(',')
        .map(tag => tag.trim().replace(/^W\//i, ''))
        .includes(etag);
}

function resolveSafeFilePath(rootDir, pathname) {
    let decoded;
    try {
        decoded = decodeURIComponent(pathname || '/');
    } catch {
        return null;
    }
    if (decoded.includes('\0')) return null;
    const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const resolved = path.resolve(rootDir, relativePath);
    const rootPrefix = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
    if (resolved !== rootDir && !resolved.startsWith(rootPrefix)) {
        return null;
    }
    return resolved;
}

export function createStaticAssetsBinding(staticDir) {
    const rootDir = path.resolve(staticDir);

    return {
        async fetch(requestOrUrl) {
            const isRequest = requestOrUrl instanceof Request;
            const method = isRequest ? requestOrUrl.method.toUpperCase() : 'GET';
            if (method !== 'GET' && method !== 'HEAD') {
                return new Response('Method Not Allowed', { status: 405 });
            }
            const rawUrl = isRequest ? requestOrUrl.url : String(requestOrUrl);
            let url;
            try {
                url = new URL(rawUrl, 'http://localhost');
            } catch {
                return new Response('Bad Request', { status: 400 });
            }

            let filePath = resolveSafeFilePath(rootDir, url.pathname);
            if (!filePath) return new Response('Not Found', { status: 404 });

            let stat;
            try {
                stat = await fs.stat(filePath);
                if (stat.isDirectory()) {
                    filePath = path.join(filePath, 'index.html');
                    stat = await fs.stat(filePath);
                }
            } catch {
                return new Response('Not Found', { status: 404 });
            }
            if (!stat.isFile()) return new Response('Not Found', { status: 404 });

            const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
            const headers = new Headers({
                'Content-Type': contentTypeFor(filePath),
                'Content-Length': String(stat.size),
                ETag: etag,
                'Last-Modified': stat.mtime.toUTCString(),
            });

            if (isRequest && etagMatches(requestOrUrl.headers.get('If-None-Match'), etag)) {
                return new Response(null, { status: 304, headers });
            }

            if (method === 'HEAD') {
                return new Response(null, { status: 200, headers });
            }

            const body = await fs.readFile(filePath);
            return new Response(body, { status: 200, headers });
        },
    };
}
