import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { __test } from '../functions/api/[[path]].js';
import { shouldSuggestWarpOptimization } from '../frontend/src/utils/egressState.js';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const realtime = read('../realtime/src/index.js');
const worker = read('../src/worker.js');
const state = read('../frontend/src/composables/useKuiState.js');
const shell = read('../frontend/src/app/AppShell.vue');
const desktop = read('../frontend/src/app/DesktopNavigation.vue');
const mobile = read('../frontend/src/app/MobileNavigation.vue');
const topbar = read('../frontend/src/app/TopBar.vue');
const page = read('../frontend/src/pages/WarpTunnelPage.vue');
const installer = read('../static/vps/kui.sh');
const agent = read('../static/vps/agent.py');

test('WARP optimizer requests accept only bounded actions and candidates', () => {
  const { normalizeWarpOptimizeRequest } = __test;
  assert.deepEqual(normalizeWarpOptimizeRequest({ ip: '203.0.113.8', action: 'scan' }), { ip: '203.0.113.8', action: 'scan', address: '', port: 0, policy: '' });
  assert.deepEqual(normalizeWarpOptimizeRequest({ ip: '2001:db8::8', action: 'scan' }), { ip: '2001:db8::8', action: 'scan', address: '', port: 0, policy: '' });
  assert.deepEqual(normalizeWarpOptimizeRequest({ ip: '203.0.113.8', action: 'apply', address: '162.159.192.1', port: 2408 }), { ip: '203.0.113.8', action: 'apply', address: '162.159.192.1', port: 2408, policy: '' });
  assert.deepEqual(normalizeWarpOptimizeRequest({ ip: '203.0.113.8', action: 'policy', policy: 'on_failure' }), { ip: '203.0.113.8', action: 'policy', address: '', port: 0, policy: 'on_failure' });
  for (const invalid of [
    { ip: '', action: 'scan' },
    { ip: 'deadbeef', action: 'scan' },
    { ip: ':::', action: 'scan' },
    { ip: '999.1.1.1', action: 'scan' },
    { ip: '203.0.113.8', action: 'apply', address: 'example.com', port: 2408 },
    { ip: '203.0.113.8', action: 'apply', address: ':::', port: 2408 },
    { ip: '203.0.113.8', action: 'apply', address: '162.159.192.1', port: 0 },
    { ip: '203.0.113.8', action: 'policy', policy: 'always' },
    { ip: '203.0.113.8', action: 'unknown' },
  ]) assert.throws(() => normalizeWarpOptimizeRequest(invalid), /WARP|VPS|Endpoint|policy/i);
});

test('WARP optimizer command crosses API, realtime presence, and agent channels', () => {
  assert.match(worker, /pathname === '\/warp-optimize'/);
  assert.match(realtime, /url\.pathname === "\/warp-optimize"/);
  assert.match(realtime, /type: "warp\.optimize"/);
  assert.match(realtime, /messageType === "warp\.optimize\.result"/);
  assert.match(state, /fetchApi\('\/api\/vps\/warp-optimize'/);
});

test('integrated Worker sends WARP optimizer commands directly to the VPS presence object', async () => {
  const requests = [];
  const db = { prepare: () => ({ bind: () => ({ first: async () => ({ agent_token: 'agent-secret' }) }) }) };
  const env = { VPS_PRESENCE: {
    idFromName: name => name,
    get: name => ({ fetch: async request => { requests.push({ name, request }); return Response.json({ success: true, request_id: request.headers.get('X-KUI-Request-ID') }); } }),
  } };
  const requestId = '22222222-2222-4222-8222-222222222222';
  const command = { ip: '203.0.113.8', action: 'scan', address: '', port: 0, policy: '' };
  const result = await __test.requestRealtimeWarpOptimize(env, db, command, requestId, 'https://panel.example');
  assert.equal(result.status, 200);
  assert.equal(requests.length, 1);
  assert.match(requests[0].name, /^v2:203\.0\.113\.8:[0-9a-f]{64}$/);
  assert.equal(new URL(requests[0].request.url).pathname, '/warp-optimize');
  assert.deepEqual(await requests[0].request.json(), command);
});

test('WARP optimizer status is sanitized and survives an Agent update', () => {
  const sanitizer = realtime.slice(realtime.indexOf('function compactWarpCandidate'), realtime.indexOf('function compactRoleState'));
  const publicState = agent.slice(agent.indexOf('def _public_warp_optimizer_state'), agent.indexOf('def _free_loopback_port'));
  assert.doesNotMatch(sanitizer, /private_key|peer_public_key/);
  assert.doesNotMatch(publicState, /private_key|peer_public_key/);
  assert.match(installer, /warp-benchmark\.json/);
  assert.match(installer, /warp-optimizer\.json/);
});

test('WARP tunnel page is reachable and keeps scan separate from apply', () => {
  assert.match(shell, /WarpTunnelPage/);
  assert.ok(desktop.indexOf("id: 'proxy'") < desktop.indexOf("id: 'warp'") && desktop.indexOf("id: 'warp'") < desktop.indexOf("id: 'public-listener'"));
  assert.match(mobile, /id: 'warp'/);
  assert.match(topbar, /warp: 'WARP 隧道'/);
  assert.match(page, /开始检测/);
  assert.match(page, /应用推荐端点/);
  assert.match(page, /恢复上一个端点/);
  assert.match(page, /候选端点矩阵/);
  assert.match(page, /手动优化/);
  assert.match(page, /连续失败时自动优化/);
  assert.match(page, /首次启用后检测一次/);
});

test('only refined WARP candidates can be selected and applied', () => {
  assert.match(agent, /"refined": bool\(refined\)/);
  assert.match(agent, /item\.get\("success"\) and item\.get\("refined"\)/);
  assert.match(realtime, /refined: value\?\.refined === true/);
  assert.match(page, /candidate\.success && candidate\.refined/);
  assert.match(page, /candidate\.refined \? '可用' : '初测'/);
});

test('WARP benchmark timing and cancellation are measured inside each request', () => {
  assert.match(agent, /__KUI_TIME_TOTAL__=%\{time_total\}/);
  assert.match(agent, /cancel_event and cancel_event\.is_set\(\)/);
  assert.match(agent, /cancel_event=_warp_optimizer_cancel/);
  assert.match(agent, /WARP_MANUAL_SCAN_COOLDOWN_MS = 60 \* 1000/);
  assert.match(agent, /WARP_AUTO_SCAN_COOLDOWN_MS = 15 \* 60 \* 1000/);
  assert.match(agent, /last_scan_started_at/);
});

test('a newly applied WARP egress suggests opening the optimizer exactly from a successful result', () => {
  const now = Date.now();
  assert.equal(shouldSuggestWarpOptimization({ component: 'egress', success: true, applied_mode: 'warp_dual', applied_at: now }, now), true);
  assert.equal(shouldSuggestWarpOptimization({ component: 'egress', success: true, applied_mode: 'native', applied_at: now }, now), false);
  assert.equal(shouldSuggestWarpOptimization({ component: 'egress', success: false, applied_mode: 'warp_dual', applied_at: now }, now), false);
  assert.equal(shouldSuggestWarpOptimization({ component: 'egress', success: true, applied_mode: 'warp_dual', applied_at: now - 11 * 60 * 1000 }, now), false);
  assert.match(state, /建议前往「WARP 隧道」页面/);
  assert.match(state, /activeTab\.value = 'warp'/);
  assert.match(state, /warpTargetIp\.value = resultServer\.ip/);
});

test('applying an optimized Endpoint reports and persists the newly verified WARP exit IP', () => {
  assert.match(agent, /verified_egress_ip = _verify_warp_exit\(applied_mode\[5:\]/);
  assert.match(agent, /_emit_warp_optimizer_state\([^\n]*egress_ip=verified_egress_ip/);
  assert.match(realtime, /messageType === "warp\.optimize\.result"[\s\S]*egress_ip: safeProxyAddress/);
  assert.match(realtime, /UPDATE servers SET egress_ip = \?/);
  assert.match(realtime, /egress_applied_mode = \? AND egress_applied_revision = \?/);
  assert.match(agent, /"applied_revision": int\(egress_state\.get\("applied_revision", 0\)\)/);
  assert.match(state, /snapshot\.core_warp_result\?\.egress_ip/);
});
