import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const api = fs.readFileSync(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../static/index.html', import.meta.url), 'utf8');
const frontend = [
    '../frontend/src/composables/useKuiState.js',
    '../frontend/src/pages/ProbePage.vue',
    '../frontend/src/pages/ServersPage.vue',
    '../frontend/src/pages/ResidentialProxyPage.vue',
    '../frontend/src/proxy/legacyProxy.js',
].map(path => fs.readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');
const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const realtime = fs.readFileSync(new URL('../realtime/src/index.js', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');

test('deployment config does not contain default credentials', () => {
    assert.doesNotMatch(wrangler, /"ADMIN_PASSWORD"\s*:\s*"admin"/);
    assert.doesNotMatch(wrangler, /"PROXY_USER"\s*:\s*"kui"/);
    assert.doesNotMatch(wrangler, /"PROXY_PASS"\s*:\s*"kui"/);
});

test('deployments preserve dashboard variables and document secret types', () => {
    assert.match(wrangler, /"keep_vars"\s*:\s*true/);
    assert.match(readme, /`ADMIN_PASSWORD`\s*\|\s*Secret/);
    assert.match(readme, /`PROXY_USER`\s*\/\s*`PROXY_PASS`\s*\|\s*Secret/);
});

test('proxy list opens as text instead of document-written markup', () => {
    assert.doesNotMatch(frontend, /document\.write\('<pre>'\+t\+'<\/pre>'\)/);
    assert.match(frontend, /pre\.textContent\s*=\s*t/);
});

test('login throttling does not use the Authorization request header', () => {
    const throttle = api.match(/function loginThrottleKey\(request\) \{([^}]+)\}/)?.[1] || '';
    assert.doesNotMatch(throttle, /Authorization/);
    assert.match(throttle, /CF-Connecting-IP/);
});

test('login uses a minimal batched auth schema and exposes request progress', () => {
    const loginStart = api.indexOf('if (action === "login"');
    const loginEnd = api.indexOf('if (action === "logout"', loginStart);
    const loginRoute = api.slice(loginStart, loginEnd);
    assert.match(api, /async function ensureAuthSchema\(db\)[\s\S]*db\.batch\(\[/);
    assert.match(loginRoute, /await ensureAuthSchema\(db\)/);
    assert.doesNotMatch(loginRoute, /ensureDbSchema/);
    assert.match(frontend, /:disabled="loginPending"/);
    assert.match(frontend, /AbortSignal\.timeout\(15000\)/);
    assert.match(frontend, /finally[\s\S]{0,100}loginPending\.value = false/);
});

test('private probe authorization is checked before the public cache', () => {
    const routeStart = api.indexOf("if (method === 'GET' && subPath === 'public')");
    const routeEnd = api.indexOf("if (method === 'GET' && subPath === 'detail')", routeStart);
    const route = api.slice(routeStart, routeEnd);
    assert.ok(route.indexOf('isPublic') < route.indexOf('caches.default.match'));
    assert.match(api, /invalidatePublicProbeCache/);
});

test('proxy config is loaded for a selected VPS and batch results are explicit', () => {
    assert.match(frontend, /\/api\/proxy\/config\?ip=\$\{encodeURIComponent\(targetIp\)\}/);
    assert.match(frontend, /Promise\.allSettled/);
    assert.match(frontend, /成功.*失败/s);
});

test('residential proxy target options show VPS aliases with IPs', () => {
    assert.match(frontend, /window\.kuiManagedServers\s*=\s*\(\)\s*=>/);
    assert.match(frontend, /pcEscapeHtml\(server\.name \|\| server\.ip\)[\s\S]{0,80}\s:\s[\s\S]{0,80}pcEscapeHtml\(server\.ip\)/);
});

test('egress synchronization uses user-facing status copy', () => {
    assert.match(frontend, /配置已同步/);
    assert.match(frontend, /正在应用新配置/);
    assert.match(frontend, /新配置应用失败，当前配置保持不变/);
    assert.match(frontend, /等待 VPS 上线后同步/);
    assert.doesNotMatch(frontend, /revision 期望/);
});

test('manual refresh propagates data loading failures', () => {
    assert.match(frontend, /await refreshData\(true\)/);
    assert.match(frontend, /await fetchProbeData\(false, true\)/);
    assert.match(frontend, /Object\.assign\(window, \{ pcFetchCountries, pcFetchNodes, pcLoadConfig/);
});

test('schema initialization does not silently accept failed migrations', () => {
    assert.doesNotMatch(api, /for \(let query of (?:initQueries|probeQueries|tpsQueries)\) \{ try/);
    assert.match(api, /PRAGMA table_info/);
    assert.match(api, /schemaColumns = new Map\(\)/);
    assert.match(api, /chunkBatch\(db, initQueries\.map/);
});

test('API data never returns password hashes and logout revokes sessions', () => {
    assert.doesNotMatch(api, /SELECT \* FROM users/);
    assert.match(api, /action === "logout"/);
    assert.match(api, /DELETE FROM auth_sessions WHERE token_hash/);
});

test('browser sessions are not persisted in localStorage', () => {
    assert.doesNotMatch(frontend, /localStorage\.(?:getItem|setItem)\('kui_auth_key'/);
    assert.match(frontend, /sessionStorage\.setItem\('kui_auth_key'/);
});

test('external Worker fetches use bounded timeouts', () => {
    assert.match(api, /testisp\.info[\s\S]{0,300}AbortSignal\.timeout/);
    assert.match(api, /frequency-policy[\s\S]{0,400}AbortSignal\.timeout/);
});

test('proxy diagnostics follow the selected VPS', () => {
    assert.match(frontend, /pcRenderSelectedDiagnostics\(pcNodeServers\.find\(server => server\.ip === selectedIp\)\)/);
    assert.match(frontend, /pcRenderLogs\(server\?\.logs \|\| ''\)/);
});

test('SFC frontend preserves residential controller integration points', () => {
    const hashedAssets = [...html.matchAll(/\/ui-assets\/[A-Za-z0-9_.-]+\.(?:js|css)/g)].map(match => match[0]);
    assert.ok(hashedAssets.some(asset => asset.endsWith('.js')));
    assert.ok(hashedAssets.some(asset => asset.endsWith('.css')));
    for (const asset of hashedAssets) {
        assert.match(asset, /^\/ui-assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{6,}\.(?:js|css)$/);
        assert.equal(fs.existsSync(new URL(`../static${asset}`, import.meta.url)), true, `${asset} should exist`);
    }
    for (const id of ['slot-target-ip', 'countries-list', 'pc-nodes-table', 'pc-terminal-output', 'pc-native-score-container']) {
        assert.match(frontend, new RegExp(`id="${id}"`));
    }
});

test('user creation matches backend password policy and preserves unsaved group drafts', () => {
    assert.match(api, /action === "users"[\s\S]*String\(password \|\| ''\)\.length < 12/);
    assert.match(frontend, /newUser\.password\.length < 12/);
    assert.match(frontend, /if \(!groupDrafts\[group\.id\]\) groupDrafts\[group\.id\] =/);
    assert.match(frontend, /encodeURIComponent\(username\)/);
});

test('settings validate values and preserve unsaved probe drafts', () => {
    assert.match(frontend, /const probeSettingsDirty = ref\(false\)/);
    assert.match(frontend, /if \(!probeSettingsDirty\.value\) Object\.assign\(probeSys/);
    assert.match(frontend, /userNewPassword\.value\.length < 12/);
    assert.match(frontend, /publicInterval < adminInterval \|\| idleInterval < publicInterval/);
    assert.match(frontend, /const probeSettingsSaving = ref\(false\)/);
    assert.match(frontend, /const editableProbeSettingKeys = \[/);
    assert.match(api, /site_title\.trim\(\)\.length > 100/);
    assert.match(api, /const allowedSettings = new Set/);
});

test('probe ping targets are validated before storage and never reach a shell', () => {
    assert.match(api, /normalizePingTarget/);
    assert.match(api, /ping_node_ct/);
    assert.match(api, /Invalid ping target/);
    const agent = fs.readFileSync(new URL('../static/vps/agent.py', import.meta.url), 'utf8');
    const pingStart = agent.indexOf('def get_http_ping');
    const pingEnd = agent.indexOf('\ndef ', pingStart + 5);
    const pingFunction = agent.slice(pingStart, pingEnd);
    assert.match(pingFunction, /subprocess\.(?:run|check_output)\(\s*\[/);
    assert.doesNotMatch(pingFunction, /shell=True/);
});

test('standalone realtime trusts only explicitly configured Pages origins', () => {
    const originCheck = realtime.slice(realtime.indexOf('function isAllowedPagesOrigin'), realtime.indexOf('function requestPagesOrigin'));
    assert.match(originCheck, /configured\.includes\(origin\)/);
    assert.doesNotMatch(originCheck, /pages\.dev|workers\.dev/);
});

test('public probe content never executes stored administrator markup', () => {
    assert.doesNotMatch(frontend, /v-html="probeSys\.popup_content"/);
    assert.doesNotMatch(frontend, /headWrapper\.innerHTML|kui-custom-script|wrapper\.innerHTML\s*=\s*newVal/);
    assert.doesNotMatch(frontend, /styleTag\.innerHTML\s*=/);
    assert.match(frontend, /styleTag\.textContent\s*=\s*css/);
    assert.doesNotMatch(api, /publicKeys[^\n]+custom_(?:head|script)/);
    assert.doesNotMatch(api, /allowedSettings[^\n]+custom_(?:head|script)/);
    assert.match(worker, /script-src 'self'/);
});

test('VPS and realtime addresses require valid IPv4 or IPv6 syntax', () => {
    assert.match(api, /function validIp\(value\)[\s\S]{0,900}new URL\(`http:\/\/\[\$\{value\}\]\/`\)/);
    assert.match(api, /if \(!validIp\(ip\)\) return Response\.json\(\{ error: 'Invalid VPS IP'/);
    assert.match(realtime, /function validIp\(value\)[\s\S]{0,900}new URL\(`http:\/\/\[\$\{value\}\]\/`\)/);
    assert.match(realtime, /return validIp\(address\) \? address : ""/);
});

test('long-lived Agent tokens stay off the browser data plane', () => {
    const dataRoute = api.slice(api.indexOf('if (action === "data")'), api.indexOf('if (action === "settings"'));
    assert.doesNotMatch(dataRoute, /agent_token/);
    assert.match(api, /agent_bootstrap_tokens/);
    assert.match(api, /action === "agent_bootstrap"/);
    assert.match(api, /const assetSha256 =/);
    assert.doesNotMatch(api, /const sha256 = Array\.from\(new Uint8Array\(digest\)\)/);
    assert.match(frontend, /requestAgentBootstrapToken/);
    assert.match(frontend, /const payload = await response\.json/);
    assert.match(frontend, /requireBootstrapToken\(payload\?\.token\)/);
    assert.match(frontend, /\^\[A-Za-z0-9_-\]\{32,128\}\$/);
    assert.doesNotMatch(frontend, /await fetchApi\('\/api\/agent_bootstrap'[\s\S]{0,160}\)\)\.token/);
    assert.doesNotMatch(frontend, /servers\.value\.find\(s => s\.ip === ip\)\?\.agent_token/);
});

test('standalone realtime authentication uses a dedicated secret', () => {
    const headerFunction = api.slice(api.indexOf('async function realtimeAdminHeader'), api.indexOf('async function notifyRealtimePublicPolicy'));
    assert.match(headerFunction, /REALTIME_AUTH_SECRET/);
    assert.doesNotMatch(headerFunction, /ADMIN_PASSWORD/);
    assert.match(realtime, /X-KUI-Realtime-Secret/);
    assert.match(realtime, /difference \|= suppliedBytes\[index\] \^ configuredBytes\[index\]/);
    assert.match(readme, /`REALTIME_AUTH_SECRET`/);
});

test('subscription SSRF checks cover every redirect and special IP encodings', () => {
    assert.match(api, /redirect: 'manual'/);
    assert.match(api, /await assertPublicSubscriptionResolution\(current\)/);
    assert.match(api, /host\.startsWith\('::ffff:'\)/);
    assert.match(api, /host\.startsWith\('ff'\)/);
    assert.match(api, /if \(!publicAnswers\) throw new Error/);
});

test('subscription fetches validate resolved addresses and Telegram commands reuse settings limits', () => {
    assert.match(api, /assertPublicSubscriptionResolution/);
    assert.match(api, /cloudflare-dns\.com\/dns-query/);
    assert.match(api, /await assertPublicSubscriptionResolution\(current\)/);
    assert.match(api, /const interval = Number\(cmdParts\[1\]\)/);
    assert.match(api, /interval >= 1 && interval <= 3600/);
    assert.match(api, /title\.length <= 100/);
});

test('diagnostic errors are never interpolated into executable markup', () => {
    assert.doesNotMatch(frontend, /innerHTML\s*=\s*`[^`]*\$\{e\.message\}/);
    assert.match(frontend, /errorMessage\.textContent\s*=\s*String\(e\.message/);
    assert.match(worker, /escapeErrorHtml\(e\.message\)/);
});

test('realtime patches invalidate the snapshot cache', () => {
    const routeStart = realtime.indexOf('url.pathname === "/update"');
    const updateRoute = realtime.slice(routeStart, realtime.indexOf('url.pathname === "/snapshot"', routeStart));
    assert.match(updateRoute, /this\.snapshotCache = null/);
    assert.match(updateRoute, /this\.snapshotCachedAt = 0/);
});

test('executable CDN resources are versioned and integrity pinned', async () => {
    for (const match of html.matchAll(/<script src="https:[^>]+>/g)) {
        assert.match(match[0], /integrity="sha384-/);
        assert.match(match[0], /crossorigin="anonymous"/);
    }
    const { EXTERNAL_DEPS } = await import('../frontend/src/utils/externalDeps.js');
    const pinnedScripts = [
        EXTERNAL_DEPS.tweetnacl,
        EXTERNAL_DEPS.echarts,
        EXTERNAL_DEPS.qrious,
        EXTERNAL_DEPS.chartjs,
        EXTERNAL_DEPS.leaflet.js,
    ];
    for (const spec of pinnedScripts) {
        assert.match(spec.url, /^https:\/\//);
        assert.match(spec.integrity, /^sha384-/);
        assert.equal(spec.crossOrigin, 'anonymous');
    }
    assert.match(EXTERNAL_DEPS.leaflet.css.integrity, /^sha384-/);
    assert.equal(EXTERNAL_DEPS.leaflet.css.crossOrigin, 'anonymous');
    assert.doesNotMatch(html, /cdn\.tailwindcss\.com"/);
});

test('static responses include baseline browser security headers', () => {
    assert.match(worker, /Content-Security-Policy/);
    assert.match(worker, /X-Content-Type-Options/);
    assert.match(worker, /X-Frame-Options/);
    assert.match(wrangler, /"run_worker_first"\s*:\s*true/);
});

test('VPS installer assets are only available through the authenticated API', () => {
    const assetsFallback = worker.indexOf('await env.ASSETS.fetch(request)');
    const normalization = worker.indexOf('normalizeStaticPathname(url.pathname)');
    const privateAssetGuard = worker.lastIndexOf('isPrivateVpsPath(normalizedPathname)');
    assert.ok(normalization > 0 && normalization < assetsFallback);
    assert.ok(privateAssetGuard > normalization && privateAssetGuard < assetsFallback);
    assert.match(worker.slice(privateAssetGuard, assetsFallback), /status:\s*404/);
    assert.match(worker.slice(privateAssetGuard, assetsFallback), /Cache-Control['"]?\s*:\s*['"]no-store/);
    assert.match(api, /action === "agent_update"[\s\S]*env\.ASSETS\.fetch/);
});

test('subscriptions are disabled by default without landing-page camouflage', () => {
    const subscriptionRoute = api.slice(api.indexOf('if (action === "sub"'), api.indexOf('if (action === "thirdparty"'));
    assert.doesNotMatch(api, /protectedSubscriptionResponse/);
    assert.match(subscriptionRoute, /authenticatedSurgeAccess = format === 'surge'[\s\S]{0,100}!!authenticatedSurgeUser/);
    assert.match(subscriptionRoute, /subscriptionProtection\?\.value !== 'false' && !authenticatedSurgeAccess/);
    assert.match(subscriptionRoute, /new Response\('Not Found',[\s\S]{0,160}status:\s*404/);
    assert.match(frontend, /subscription_protection:\s*'true'/);
});

test('probe dashboards default to private and anonymous payloads hide VPS identities', () => {
    assert.match(api, /const isPublic = publicSetting\?\.value === 'true'/);
    assert.match(api, /is_public:\s*'false'/);
    assert.match(frontend, /is_public:\s*'false'/);
    assert.match(api, /id:\s*`public-\$\{index \+ 1\}`/);
    assert.match(api, /details_available:\s*false/);
    assert.match(api, /realtime_url:\s*isAnonymous \? ''/);
    assert.match(realtime, /url\.pathname === "\/public\/ws"[\s\S]{0,300}status:\s*404/);
    assert.match(realtime, /url\.pathname === "\/public-ws"[\s\S]{0,300}status:\s*404/);
    assert.match(realtime, /public realtime disabled/);
    assert.doesNotMatch(realtime, /sanitizeSnapshot/);
});

test('the default deployment does not expose a workers.dev endpoint', () => {
    assert.match(wrangler, /"workers_dev"\s*:\s*false/);
    assert.match(readme + fs.readFileSync(new URL('../docs/deployment.md', import.meta.url), 'utf8'), /自定义域名/);
});

test('Worker runtime environment is copied without using the host object as a prototype', () => {
    assert.doesNotMatch(worker, /Object\.create\(env\)/);
    assert.match(worker, /Object\.assign\(\{\}, env, \{ PAGES_ORIGIN: origin, REALTIME_URL: origin \}\)/);
    assert.match(worker, /\[worker\] uncaught fetch error ray=/);
});

test('Durable Objects use the portable constructor API without a startup-only runtime import', () => {
    assert.doesNotMatch(realtime, /cloudflare:workers|extends DurableObject|super\(ctx, env\)/);
    assert.match(realtime, /export class VpsPresence \{/);
    assert.match(realtime, /export class DashboardHub \{/);
});
