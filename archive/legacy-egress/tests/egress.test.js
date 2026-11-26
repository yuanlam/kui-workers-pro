import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { __test } from '../functions/api/[[path]].js';
import { applyEgressProbeResult, applyEgressRealtimeResult, extractTunnelPurity, formatExitPurityMeta, formatPurityVerdict, formatRiskLevel, mergeServerRealtimeTelemetry, normalizeIpProfile, resolveCurrentServer, shouldAutoProbeEgress } from '../frontend/src/utils/egressState.js';
import { formatRegionName, formatRegionWithCity, regionMatchesQuery, resolveRegionCodeFromInput } from '../frontend/src/utils/regionNames.js';

const api = fs.readFileSync(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');
const agent = fs.readFileSync(new URL('../static/vps/agent.py', import.meta.url), 'utf8');
const realtime = fs.readFileSync(new URL('../realtime/src/index.js', import.meta.url), 'utf8');
const frontend = fs.readFileSync(new URL('../frontend/src/composables/useKuiState.js', import.meta.url), 'utf8');
const serversPage = fs.readFileSync(new URL('../frontend/src/pages/ServersPage.vue', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');

test('egress requests normalize selective categories and validate SOCKS5 endpoints', () => {
    const { normalizeEgressRequest } = __test;
    assert.equal(typeof normalizeEgressRequest, 'function');
    const normalized = normalizeEgressRequest({
        egress_mode: 'socks5',
        proxy_mode: 'selective',
        proxy_categories: 'AI,youtube,ai',
        proxy_custom_domains: '',
        socks5_addr: 'proxy.example.com',
        socks5_port: 1080,
        socks5_user: 'alice',
        socks5_pass: 'new-secret',
    });
    assert.equal(normalized.proxyCategories, 'youtube,ai');
    assert.deepEqual(normalized.desiredConfig, {
        mode: 'socks5',
        proxy_mode: 'selective',
        proxy_categories: 'youtube,ai',
        proxy_custom_domains: [],
        socks5: { addr: 'proxy.example.com', port: 1080, user: 'alice', pass: 'new-secret' },
    });
    assert.throws(() => normalizeEgressRequest({ egress_mode: 'socks5', socks5_addr: 'https://proxy.example.com', socks5_port: 1080 }), /address/i);
    assert.throws(() => normalizeEgressRequest({ egress_mode: 'socks5', socks5_addr: 'proxy.example.com', socks5_port: 0 }), /port/i);
    assert.throws(() => normalizeEgressRequest({ egress_mode: 'residential', proxy_mode: 'selective', proxy_categories: 'unknown' }), /categor/i);
    assert.throws(() => normalizeEgressRequest({ egress_mode: 'residential', proxy_mode: 'selective', proxy_categories: '' }), /categor/i);
});

test('custom selective domains are normalized, bounded, and versioned separately', () => {
    const { normalizeEgressRequest, normalizeProxyCustomDomains } = __test;
    assert.deepEqual(
        normalizeProxyCustomDomains('Example.COM.\n*.media.example.com\n例子.测试\nexample.com\n'),
        ['example.com', 'media.example.com', 'xn--fsqu00a.xn--0zwm56d'],
    );
    const normalized = normalizeEgressRequest({
        egress_mode: 'residential',
        proxy_mode: 'selective',
        proxy_categories: 'custom',
        proxy_custom_domains: 'netflix.com\n*.example.org',
    });
    assert.equal(normalized.proxyCategories, 'custom');
    assert.deepEqual(normalized.proxyCustomDomains, ['example.org', 'netflix.com']);
    assert.deepEqual(normalized.desiredConfig.proxy_custom_domains, ['example.org', 'netflix.com']);
    for (const invalid of ['https://example.com', 'example.com/path', 'example.com:443', '127.0.0.1', 'localhost', '*.com', 'internal.local']) {
        assert.throws(() => normalizeProxyCustomDomains(invalid), /domain|IP address/i);
    }
    assert.throws(() => normalizeEgressRequest({ egress_mode: 'residential', proxy_mode: 'selective', proxy_categories: 'custom', proxy_custom_domains: '' }), /at least one domain/i);
});

test('custom domains persist across non-proxy exits but remain inactive there', () => {
    const { normalizeEgressRequest } = __test;
    const current = { proxy_custom_domains: ['example.com', 'netflix.com'] };
    for (const mode of ['native', 'warp_ipv4', 'warp_ipv6', 'warp_dual']) {
        const normalized = normalizeEgressRequest({ egress_mode: mode }, current);
        assert.deepEqual(normalized.proxyCustomDomains, ['example.com', 'netflix.com']);
        assert.deepEqual(normalized.desiredConfig.proxy_custom_domains, ['example.com', 'netflix.com']);
        assert.equal(normalized.proxyMode, 'global');
        assert.equal(normalized.proxyCategories, '');
    }
    assert.match(frontend, /const body = \{ ip: vps\.ip, egress_mode: targetMode, proxy_custom_domains: vps\._proxy_custom_domains \|\| '' \}/);
    assert.match(api, /const proxyCustomDomains = normalizeProxyCustomDomains\(data\.proxy_custom_domains \?\? current\.proxy_custom_domains\)/);
    assert.match(serversPage, /切换出口或关闭自定义后仍会保留/);
});

test('custom domain UI is explicit and submitted with residential and SOCKS5 configurations', () => {
    assert.match(serversPage, /自定义代理域名（每行一个）/);
    assert.match(serversPage, /v-model="vps\._proxy_custom_domains"/);
    assert.match(serversPage, /自定义域名优先级最高/);
    assert.match(frontend, /proxy_custom_domains: vps\._proxy_custom_domains \|\| ''/);
    assert.match(api, /proxy_custom_domains: proxyCustomDomains/);
    assert.match(api, /\['servers', 'proxy_custom_domains'/);
});

test('SOCKS5 password is write-only and an empty field preserves the stored value', () => {
    const { normalizeEgressRequest } = __test;
    const current = { socks5_pass: 'stored-secret' };
    const kept = normalizeEgressRequest({ egress_mode: 'socks5', socks5_addr: '127.0.0.1', socks5_port: 1080, socks5_pass: '' }, current);
    assert.equal(kept.desiredConfig.socks5.pass, 'stored-secret');
    const cleared = normalizeEgressRequest({ egress_mode: 'socks5', socks5_addr: '127.0.0.1', socks5_port: 1080, socks5_clear_password: true }, current);
    assert.equal(cleared.desiredConfig.socks5.pass, '');
    assert.equal(cleared.desiredConfig.socks5.user, '');
    const adminDataRoute = api.slice(api.indexOf('if (action === "data")'), api.indexOf('if (action === "settings"'));
    assert.doesNotMatch(adminDataRoute, /SELECT \* FROM servers/);
    assert.match(adminDataRoute, /socks5_password_set/);
    assert.doesNotMatch(frontend, /s\.socks5_pass\b|vps\.socks5_pass\s*=/);
});

test('every egress selection stays local until the user applies or cancels it', () => {
    const modeChange = frontend.slice(frontend.indexOf('const onEgressModeChange'), frontend.indexOf('const proxyCategoryOptions'));
    const proxyModeChange = frontend.slice(frontend.indexOf('const setProxyMode'), frontend.indexOf('const cancelEgressDraft'));
    assert.match(frontend, /const egressModeOf = vps => vps\._egress_mode_draft \|\| vps\.egress_mode/);
    assert.match(modeChange, /vps\._egress_mode_draft = mode/);
    assert.match(modeChange, /vps\._egress_dirty = true/);
    assert.doesNotMatch(modeChange, /updateVpsEgress/);
    assert.match(proxyModeChange, /vps\._proxy_mode_draft = proxyMode/);
    assert.doesNotMatch(proxyModeChange, /updateVpsEgress/);
    assert.match(frontend, /const applyEgressDraft = async vps/);
    assert.match(frontend, /const cancelEgressDraft = vps/);
    assert.match(frontend, /const body = \{ ip: vps\.ip, egress_mode: targetMode, proxy_custom_domains:/);
    assert.match(frontend, /const draftFields = \['\_egress_mode_draft'/);
    assert.match(frontend, /s\._socks5_addr === undefined/);
    assert.match(serversPage, /@click="applyEgressDraft\(vps\)"/);
    assert.match(serversPage, /@click="cancelEgressDraft\(vps\)"/);
    assert.match(serversPage, /点击“应用”后才会下发到 VPS/);
    assert.doesNotMatch(serversPage, /应用已选分类/);
});

test('desired and applied egress snapshots are persisted independently', () => {
    assert.match(api, /egress_desired_config/);
    assert.match(api, /egress_applied_config/);
    assert.match(api, /egress_applied_config = egress_desired_config/);
    assert.match(realtime, /egress_applied_config = egress_desired_config/);
    assert.match(agent, /applied_config/);
    assert.match(agent, /rollback_config/);
    assert.match(agent, /rollback_healthy = _restore_last_good_singbox\(\)/);
    assert.match(agent, /previous_config_restored=/);
    assert.doesNotMatch(agent, /rollback_socks = \{[^}]*egress\.get\("socks5_addr"/s);
});

test('all egress modes report the IP verified during application', () => {
    assert.match(agent, /verified_egress_ip\s*=\s*build_singbox_config/);
    assert.match(agent, /verified_egress_ip = _verify_socks5_exit\(egress_check_host\)/);
    assert.match(agent, /verified_egress_ip = _verify_native_exit\(\)/);
    assert.match(agent, /"egress_ip": verified_egress_ip/);
});

test('native egress verification can use the authenticated Worker IP echo', () => {
    assert.match(api, /action === "agent_egress_ip"/);
    assert.match(api, /CF-Connecting-IP/);
    assert.match(agent, /\/api\/agent_egress_ip\?ip=/);
    assert.match(agent, /_urlopen\(request, timeout=10\)/);
});

test('WARP and SOCKS5 verification preserve domains for landing-side DNS', () => {
    assert.match(agent, /--proxy", f"socks5h:\/\/\{check_host\}:39482"/);
    assert.doesNotMatch(agent, /--proxy", f"socks5:\/\/\{check_host\}:39482"/);
    assert.match(agent, /"--noproxy", "", "--proxy", f"socks5h:\/\/\{check_host\}:39482"/);
    assert.match(agent, /"--noproxy", "\*"[^\n]+https:\/\/api\.ipify\.org/);
});

test('WARP preparation is asynchronous and endpoint recovery keeps the identity profile', () => {
    assert.match(agent, /def _prepare_warp_profile_async/);
    assert.match(agent, /threading\.Thread\([^\n]+warp-profile/);
    assert.match(agent, /def _refresh_warp_endpoint/);
    assert.match(agent, /peer_host/);
    assert.doesNotMatch(agent, /os\.remove\(WARP_CONF_PATH\)/);
});

test('legacy egress columns and WARP-only state names are no longer active', () => {
    for (const column of ['egress_pending', 'socks5_mode', 'socks5_domains', 'warp_revision', 'warp_status', 'warp_error']) {
        assert.doesNotMatch(api, new RegExp(`\\['servers', '${column}'`));
    }
    assert.doesNotMatch(agent, /def _load_warp_state|def _save_warp_state/);
    assert.match(agent, /def _load_egress_state|def _save_egress_state/);
});

test('admins can refresh the actual VPS egress IP without reapplying configuration', () => {
    assert.match(serversPage, /@click="refreshVpsEgressIp\(vps\)"/);
    assert.match(serversPage, /aria-label="刷新 VPS 实际出口 IP"/);
    assert.match(frontend, /fetchApi\('\/api\/vps\/egress-refresh'/);
    assert.match(api, /params\.path\[1\] === "egress-refresh"/);
    assert.match(api, /env\.VPS_PRESENCE && typeof env\.VPS_PRESENCE\.idFromName === 'function'/);
    assert.match(api, /VPS_PRESENCE\.get\(env\.VPS_PRESENCE\.idFromName\(`v2:\$\{ip\}:\$\{tokenHash\}`\)\)/);
    assert.match(api, /presence\.internal\/egress-refresh/);
    assert.match(api, /实时服务返回非 JSON 响应/);
    assert.match(realtime, /type: "egress\.refresh"/);
    assert.match(realtime, /messageType === "egress\.probe\.result"/);
    assert.match(worker, /pathname === '\/egress-refresh'/);
    assert.match(agent, /def _verify_current_egress_exit\(/);
    assert.match(agent, /"egress\.probe\.result"/);
    assert.match(agent, /"applied_revision": revision/);
    assert.match(realtime, /egress_applied_revision = \?/);
    assert.doesNotMatch(api.slice(api.indexOf('params.path[1] === "egress-refresh"'), api.indexOf('if (method === "DELETE")')), /egress_revision\s*=\s*egress_revision\s*\+\s*1/);
});

test('manual egress probes cannot overwrite a newer applied mode or revision', () => {
    const server = { egress_applied_mode: 'native', egress_applied_revision: 8, egress_ip: '203.0.113.10' };
    assert.equal(applyEgressProbeResult(server, { success: true, accepted: true, applied_mode: 'warp_ipv4', applied_revision: 7, egress_ip: '104.28.1.1' }), false);
    assert.equal(server.egress_ip, '203.0.113.10');
    assert.equal(applyEgressProbeResult(server, { success: true, accepted: false, applied_mode: 'native', applied_revision: 8, egress_ip: '203.0.113.11' }), false);
    assert.equal(server.egress_ip, '203.0.113.10');
    assert.equal(applyEgressProbeResult(server, { success: true, accepted: true, applied_mode: 'native', applied_revision: 8, egress_ip: '203.0.113.12' }), true);
    assert.equal(server.egress_ip, '203.0.113.12');
    assert.match(api, /egress_applied_mode, egress_applied_revision/);
    assert.match(realtime, /expected_mode/);
    assert.match(realtime, /expected_revision/);
});

test('automatic residential verification respects visibility, readiness, cooldown and delayed exit changes', () => {
    const server = { egress_status: 'applied', egress_applied_mode: 'residential', residential_ready: true, residential_active_exit_ip: '1.1.1.1' };
    const state = { lastAttempt: 1000, changedAt: 2000, lastExit: '1.1.1.1' };
    const eligible = { visible: true, online: true, refreshing: false };
    assert.equal(shouldAutoProbeEgress(server, state, { ...eligible, visible: false }, 10000), false);
    assert.equal(shouldAutoProbeEgress(server, state, { ...eligible, online: false }, 10000), false);
    assert.equal(shouldAutoProbeEgress(server, state, eligible, 6000), false);
    assert.equal(shouldAutoProbeEgress(server, state, eligible, 7000), true);
    assert.equal(shouldAutoProbeEgress(server, { ...state, changedAt: 0 }, eligible, 300999), false);
    assert.equal(shouldAutoProbeEgress(server, { ...state, changedAt: 0 }, eligible, 301000), true);
    assert.equal(shouldAutoProbeEgress(server, state, { ...eligible, refreshing: true }, 400000), false);
});

test('an egress apply result received before the save response still refreshes the IP', () => {
    const server = { egress_mode: 'warp_ipv4', egress_revision: 4, egress_applied_revision: 4, egress_status: 'pending', egress_ip: '198.51.100.1' };
    const applied = applyEgressRealtimeResult(server, { component: 'egress', success: true, revision: 5, desired_mode: 'warp_ipv4', applied_mode: 'warp_ipv4', egress_ip: '104.28.222.43' });
    assert.equal(applied, true);
    assert.equal(server.egress_status, 'applied');
    assert.equal(server.egress_revision, 5);
    assert.equal(server.egress_applied_revision, 5);
    assert.equal(server.egress_ip, '104.28.222.43');
    assert.match(frontend, /const alreadyApplied = activeVps\.egress_status === 'applied'/);
    assert.match(frontend, /if \(!alreadyApplied\) activeVps\.egress_status/);
});

test('egress saving state is cleared after a data refresh replaces the server object', () => {
    const staleServer = { ip: '203.0.113.8', _egress_saving: true };
    const currentServer = { ip: '203.0.113.8', _egress_saving: true };
    assert.equal(resolveCurrentServer([currentServer], staleServer), currentServer);
    assert.equal(resolveCurrentServer([], staleServer), staleServer);
    assert.match(frontend, /const activeVps = resolveCurrentServer\(servers\.value, vps\)/);
    assert.match(frontend, /finally \{ vps\._egress_saving = false; resolveCurrentServer\(servers\.value, vps\)\._egress_saving = false; \}/);
});

test('new D1 egress state is never overwritten by an older realtime server object', () => {
    const merged = mergeServerRealtimeTelemetry(
        { ip: '203.0.113.8', cpu: 10, last_report: 100, egress_status: 'applied', egress_applied_revision: 5, egress_ip: '104.28.222.43' },
        { ip: '203.0.113.8', cpu: 25, _realtime_ts: 200, egress_status: 'pending', egress_applied_revision: 4, egress_ip: '198.51.100.1' },
    );
    assert.equal(merged.cpu, 25);
    assert.equal(merged._realtime_ts, 200);
    assert.equal(merged.egress_status, 'applied');
    assert.equal(merged.egress_applied_revision, 5);
    assert.equal(merged.egress_ip, '104.28.222.43');
    assert.match(frontend, /mergeServerRealtimeTelemetry\(item, previous\)/);
    assert.match(frontend, /!egressResult\.egress_ip[\s\S]{0,600}refreshVpsEgressIp\(resultServer, true\)/);
});

test('the integrated Worker sends manual egress refresh directly to the presence object', async () => {
    const requests = [];
    const db = { prepare: () => ({ bind: () => ({ first: async () => ({ agent_token: 'agent-secret', egress_applied_mode: 'warp_ipv4', egress_applied_revision: 6 }) }) }) };
    const env = { VPS_PRESENCE: {
        idFromName: name => name,
        get: name => ({ fetch: async request => { requests.push({ name, request }); return Response.json({ success: true, request_id: request.headers.get('X-KUI-Request-ID') }); } }),
    } };
    const requestId = '11111111-1111-4111-8111-111111111111';
    const result = await __test.requestRealtimeEgressRefresh(env, db, '203.0.113.8', requestId, 'https://panel.example');
    assert.equal(result.status, 200);
    assert.deepEqual(result.result, { success: true, request_id: requestId });
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].request.url).hostname, 'presence.internal');
    assert.equal(requests[0].request.headers.get('X-KUI-Expected-Mode'), 'warp_ipv4');
    assert.equal(requests[0].request.headers.get('X-KUI-Expected-Revision'), '6');
    assert.match(requests[0].name, /^v2:203\.0\.113\.8:[0-9a-f]{64}$/);
});

test('extractTunnelPurity and formatExitPurityMeta classify residential, native, and risk badges', () => {
    assert.equal(extractTunnelPurity(null), null);
    assert.equal(extractTunnelPurity({ tunnel: 'tun_main', fraud_score: 'bad', ipok_risk: 101 }), null);

    const nativeRes = formatExitPurityMeta({
        is_residential: true,
        is_native: true,
        fraud_score: 12.4,
        ipok_risk: 8.2,
        purity_source: 'IPPure+IPOK',
        asn_org: 'NTT <ISP>',
    });
    assert.deepEqual(nativeRes, {
        typeLabel: '原生住宅',
        typeTone: 'emerald',
        fraudScore: 12,
        fraudTone: 'emerald',
        fraudLevelLabel: '极低风险',
        fraudLevelTone: 'good',
        ipokRisk: 8,
        ipokTone: 'emerald',
        ipokLevelLabel: '极低风险',
        ipokLevelTone: 'good',
        hasIpok: true,
        asnOrg: 'NTT ISP',
        puritySource: 'ippure+ipok',
        ipProfile: null,
        isResidential: true,
        isNative: true,
        verdictLabel: '极佳纯净',
        verdictTone: 'good',
        verdictProgress: 88,
    });

    const broadcastRes = formatExitPurityMeta({ is_residential: true, is_native: false, fraud_score: 40 });
    assert.equal(broadcastRes.typeLabel, '广播住宅');
    assert.equal(broadcastRes.typeTone, 'sky');
    assert.equal(broadcastRes.fraudTone, 'amber');
    assert.equal(broadcastRes.hasIpok, false);

    const datacenter = formatExitPurityMeta({ is_residential: false, fraud_score: 72, ipok_risk: 65 });
    assert.equal(datacenter.typeLabel, '机房 IP');
    assert.equal(datacenter.typeTone, 'amber');
    assert.equal(datacenter.fraudTone, 'rose');
    assert.equal(datacenter.ipokTone, 'rose');
    assert.equal(datacenter.hasIpok, true);
});

test('region labels normalize ISO codes and Chinese aliases for display and search', () => {
    assert.equal(formatRegionName('ANY'), '全球自动');
    assert.equal(formatRegionName('AUTO'), '全球自动');
    assert.equal(formatRegionName('JP'), '日本');
    assert.equal(formatRegionName('US'), '美国');
    assert.equal(formatRegionName('TW'), '中国台湾');
    assert.equal(formatRegionName('HK'), '中国香港');
    assert.equal(formatRegionName('MO'), '中国澳门');
    assert.equal(formatRegionName('UK'), '英国');
    assert.equal(formatRegionWithCity('JP', 'Tokyo'), '日本 · Tokyo');
    assert.equal(formatRegionWithCity('JP'), '日本');
    assert.equal(resolveRegionCodeFromInput('日本'), 'JP');
    assert.equal(resolveRegionCodeFromInput(' jp '), 'JP');
    assert.equal(resolveRegionCodeFromInput('ANY'), 'ANY');
    assert.equal(resolveRegionCodeFromInput('auto'), 'ANY');
    assert.equal(regionMatchesQuery('JP', '日本'), true);
    assert.equal(regionMatchesQuery('JP', 'JP'), true);
    assert.equal(regionMatchesQuery('US', '美国'), true);
    assert.equal(regionMatchesQuery('JP', '美国'), false);
});

test('risk levels map numeric bands to stable Chinese verdicts', () => {
    for (const [score, expected] of [[0, '极低风险'], [15, '极低风险'], [16, '低风险'], [30, '低风险'], [31, '中风险'], [55, '中风险'], [56, '高风险'], [100, '高风险']]) {
        assert.deepEqual(formatRiskLevel(score), { score, label: expected, tone: score <= 30 ? 'good' : score <= 55 ? 'warn' : 'bad' });
    }
    assert.deepEqual(formatRiskLevel(null), { score: null, label: '待检测', tone: 'neutral' });
    assert.deepEqual(formatRiskLevel(undefined), { score: null, label: '待检测', tone: 'neutral' });
    assert.deepEqual(formatRiskLevel(Number.NaN), { score: null, label: '待检测', tone: 'neutral' });
});

test('purity verdicts combine scores, IP profile and type signals', () => {
    assert.deepEqual(formatPurityVerdict(null), { label: '待检测', tone: 'neutral', progress: 0, hasData: false, maxRisk: null });
    assert.equal(formatPurityVerdict({ fraudScore: 12 }, {
        ip_type: 'residential',
        native_type: 'native',
    }).label, '极佳纯净');
    assert.equal(formatPurityVerdict({ fraudScore: 40 }).label, '存在风险');
    assert.equal(formatPurityVerdict({ fraudScore: 10 }, { flags: { hosting: true } }).label, '存在风险');
    assert.equal(formatPurityVerdict({ fraudScore: 70 }).label, '高风险');
    const profile = normalizeIpProfile({
        country_code: 'jp',
        ip_type: 'hosting',
        native_type: 'broadcast',
        flags: { proxy: true, hosting: true },
        sources: [{ source: 'ip-api', risk: 0 }],
    });
    assert.equal(profile.country_code, 'JP');
    assert.equal(profile.ip_type, 'hosting');
    assert.equal(profile.native_type, 'broadcast');
    assert.equal(profile.flags.proxy, true);
    assert.equal(profile.sources[0].source, 'ip-api');
    const meta = formatExitPurityMeta({ ip_profile: profile });
    assert.equal(meta.ipProfile.ip_type, 'hosting');
    assert.equal(meta.isResidential, false);
    assert.equal(meta.isNative, false);
    assert.equal(meta.typeLabel, '广播机房');
});

test('mergeServerRealtimeTelemetry merges fresher residential purity fields and ignores stale updates', () => {
    const freshPurity = { is_residential: true, is_native: true, fraud_score: 10, ipok_risk: 8, purity_source: 'ippure+ipok' };
    const merged = mergeServerRealtimeTelemetry(
        {
            ip: '203.0.113.8',
            residential_last_seen: 1000,
            residential_active_exit_ip: '198.51.100.1',
            residential_active_purity: { is_residential: false, fraud_score: 50 },
        },
        {
            ip: '203.0.113.8',
            residential_last_seen: 2000,
            residential_active_exit_ip: '198.51.100.2',
            residential_active_purity: freshPurity,
            residential_standby_purity: { is_residential: true, is_native: false, fraud_score: 30 },
        },
    );
    assert.equal(merged.residential_active_exit_ip, '198.51.100.2');
    assert.deepEqual(merged.residential_active_purity, freshPurity);
    assert.deepEqual(merged.residential_standby_purity, { is_residential: true, is_native: false, fraud_score: 30 });

    const staleMerged = mergeServerRealtimeTelemetry(
        {
            ip: '203.0.113.8',
            residential_last_seen: 3000,
            residential_active_purity: freshPurity,
        },
        {
            ip: '203.0.113.8',
            residential_last_seen: 2000,
            residential_active_purity: { is_residential: false, fraud_score: 80 },
        },
    );
    assert.deepEqual(staleMerged.residential_active_purity, freshPurity);
    assert.match(frontend, /residential_active_purity: extractTunnelPurity\(active\)/);
    assert.match(frontend, /residential_standby_purity: extractTunnelPurity\(standby\)/);
});
