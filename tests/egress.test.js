import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { __test } from '../functions/api/[[path]].js';
import { applyEgressProbeResult, applyEgressRealtimeResult, extractTunnelPurity, formatExitPurityMeta, formatPurityVerdict, formatRiskLevel, mergeServerRealtimeTelemetry, normalizeIpProfile, resolveCurrentServer, shouldAutoProbeEgress } from '../frontend/src/utils/egressState.js';
import { formatRegionName, formatRegionWithCity, regionMatchesQuery, resolveRegionCodeFromInput } from '../frontend/src/utils/regionNames.js';

const api = fs.readFileSync(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');
const realtime = fs.readFileSync(new URL('../realtime/src/index.js', import.meta.url), 'utf8');
const frontend = fs.readFileSync(new URL('../frontend/src/composables/useKuiState.js', import.meta.url), 'utf8');

test('egress modes are narrowed to native and residential', () => {
    const { normalizeEgressRequest, legacyEgressMode, normalizeStoredEgressConfig } = __test;
    const normalized = normalizeEgressRequest({
        egress_mode: 'residential',
        proxy_mode: 'selective',
        proxy_categories: 'AI,youtube,ai',
        ip_stack: 'dual',
        block_residential_quic: true,
    });
    assert.equal(normalized.mode, 'residential');
    assert.equal(normalized.proxyCategories, 'ai,youtube');
    assert.deepEqual(normalized.desiredConfig, {
        mode: 'residential',
        ip_stack: 'dual',
        block_residential_quic: true,
        proxy_mode: 'selective',
        proxy_categories: 'ai,youtube',
        proxy_custom_domains: [],
        proxy_direct_rules: [],
        proxy_custom_rules: [],
    });
    for (const mode of ['warp_ipv4', 'warp_ipv6', 'warp_dual', 'socks5', 'unknown']) {
        assert.throws(() => normalizeEgressRequest({ egress_mode: mode }), /Invalid egress mode|Legacy egress mode/);
    }
    assert.equal(legacyEgressMode('warp_dual'), 'native');
    assert.equal(legacyEgressMode('socks5'), 'native');
    assert.equal(legacyEgressMode('residential'), 'residential');
    const legacy = normalizeStoredEgressConfig({ mode: 'socks5', proxy_mode: 'selective', proxy_categories: 'ai,custom', proxy_custom_domains: ['example.com'], socks5: { addr: '127.0.0.1', port: 1080, user: 'x', pass: 'y' } });
    assert.equal(legacy.mode, 'native');
    assert.deepEqual(legacy.proxy_custom_rules, ['example.com']);
    assert.equal(legacy.socks5, null);
    assert.match(api, /const EGRESS_MODES = new Set\(\['native', 'residential'\]\)/);
    assert.match(api, /const LEGACY_EGRESS_MODES = new Set\(\['warp_ipv4', 'warp_ipv6', 'warp_dual', 'socks5'\]\)/);
    assert.match(realtime, /LEGACY_NATIVE_MODES/);
});

test('egress validates nine mode and ip-stack combinations', () => {
    const { normalizeEgressRequest } = __test;
    const combinations = [
        ['native', 'ipv4_only', true],
        ['native', 'ipv6_only', true],
        ['native', 'dual', true],
        ['residential', 'ipv4_only', true],
        ['residential', 'ipv6_only', false],
        ['residential', 'dual', true],
    ];
    for (const [mode, ipStack, valid] of combinations) {
        if (valid) {
            const normalized = normalizeEgressRequest({ egress_mode: mode, ip_stack: ipStack });
            assert.equal(normalized.mode, mode);
            assert.equal(normalized.ipStack, ipStack);
        } else {
            assert.throws(() => normalizeEgressRequest({ egress_mode: mode, ip_stack: ipStack }), /ipv6_only/);
        }
    }
    for (const ip_stack of ['dual', 'ipv4_only', 'ipv6_only']) {
        assert.equal(normalizeEgressRequest({egress_mode:'residential', proxy_mode:'selective', proxy_categories:'ai', ip_stack}).ipStack, ip_stack);
    }
    assert.throws(() => normalizeEgressRequest({ egress_mode: 'native', ip_stack: 'other' }), /Invalid ip_stack/);
    assert.throws(() => normalizeEgressRequest({ egress_mode: 'residential', ip_stack: 'dual', block_residential_quic: 'maybe' }), /Invalid block_residential_quic/);
});

test('routing rule lists are normalized, bounded, and conflict-checked', () => {
    const { normalizeEgressRequest, normalizeProxyCustomDomains, normalizeRulesetMirrorPrefix } = __test;
    assert.deepEqual(
        normalizeProxyCustomDomains('Example.COM.\n*.media.example.com\n例子.测试\nexample.com\n# comment\n'),
        ['example.com', 'media.example.com', 'xn--fsqu00a.xn--0zwm56d'],
    );
    const normalized = normalizeEgressRequest({
        egress_mode: 'residential',
        proxy_mode: 'selective',
        proxy_categories: 'custom',
        proxy_direct_rules: 'direct.example.com\n10.0.0.0/8',
        proxy_custom_rules: 'netflix.com\n*.example.org\n1.1.1.1',
    });
    assert.equal(normalized.proxyCategories, 'custom');
    assert.deepEqual(normalized.proxyDirectRules, ['direct.example.com', '10.0.0.0/8']);
    assert.deepEqual(normalized.proxyCustomRules, ['netflix.com', 'example.org', '1.1.1.1/32']);
    assert.throws(() => normalizeEgressRequest({
        egress_mode: 'native',
        proxy_direct_rules: ['openai.com'],
        proxy_custom_rules: ['*.openai.com'],
    }), /Routing list conflict/);
    assert.throws(() => normalizeProxyCustomDomains('gateway.local'), /Invalid routing domain/);
    assert.throws(() => normalizeEgressRequest({ egress_mode: 'residential', proxy_mode: 'selective', proxy_categories: 'custom', proxy_custom_rules: '' }), /at least one domain/);
    for (const value of ['127.0.0.1', '10.0.0.0/8']) {
        assert.throws(() => normalizeEgressRequest({ egress_mode: 'residential', proxy_custom_rules: value }), /Private or reserved IP/);
    }
    assert.equal(normalizeRulesetMirrorPrefix('https://Mirror.Example.com/base/'), 'https://mirror.example.com/base');
    assert.throws(() => normalizeRulesetMirrorPrefix('http://mirror.example.com'), /https/);
    assert.throws(() => normalizeRulesetMirrorPrefix('https://mirror.example.com/?a=1'), /Invalid/);
});

test('legacy custom domains remain compatible without reactivating SOCKS5', () => {
    const { normalizeEgressRequest } = __test;
    const current = { proxy_custom_domains: ['example.com', 'netflix.com'], ip_stack: 'dual' };
    const normalized = normalizeEgressRequest({ egress_mode: 'native' }, current);
    assert.deepEqual(normalized.proxyCustomDomains, ['example.com', 'netflix.com']);
    assert.deepEqual(normalized.desiredConfig.proxy_custom_domains, ['example.com', 'netflix.com']);
    assert.equal(normalized.proxyMode, 'global');
    assert.equal(normalized.proxyCategories, '');
    assert.match(api, /proxy_custom_rules \?\? data\.proxy_custom_domains/);
    assert.match(api, /proxy_direct_rules \?\? current\.proxy_direct_rules/);
});

test('desired and applied snapshots, legacy SQL guards, and revision handling remain compatible', () => {
    assert.match(api, /egress_applied_config = egress_desired_config/);
    assert.match(api, /CASE WHEN egress_mode IN \('warp_ipv4', 'warp_ipv6', 'warp_dual', 'socks5'\) THEN 'native' ELSE egress_mode END/);
    assert.match(api, /CASE WHEN egress_applied_mode IN \('warp_ipv4', 'warp_ipv6', 'warp_dual', 'socks5'\) THEN 'native' ELSE egress_applied_mode END/);
    assert.match(api, /!modes.includes\(appliedMode\)/);
    assert.match(api, /egress_applied_revision = \?/);
    assert.match(realtime, /revision/);

    const server = { egress_applied_mode: 'native', egress_applied_revision: 8, egress_ip: '203.0.113.10' };
    assert.equal(applyEgressProbeResult(server, { success: true, accepted: true, applied_mode: 'warp_ipv4', applied_revision: 7, egress_ip: '104.28.1.1' }), false);
    assert.equal(server.egress_ip, '203.0.113.10');
    assert.equal(applyEgressRealtimeResult({ egress_mode: 'warp_ipv4', egress_revision: 4, egress_applied_revision: 4, egress_status: 'pending', egress_ip: '198.51.100.1' }, { component: 'egress', success: true, revision: 5, desired_mode: 'warp_ipv4', applied_mode: 'warp_ipv4', egress_ip: '104.28.222.43' }), true);
});

test('server data exposes normalized API-only egress and capability fields', () => {
    assert.match(api, /egress_desired_config, egress_applied_config/);
    assert.match(api, /egress_legacy_migrated =/);
    assert.match(api, /proxy_direct_rules = arrayOrEmpty/);
    assert.match(api, /proxy_custom_rules = arrayOrEmpty/);
    const mixed = __test.normalizeStoredEgressConfig({mode:'residential', proxy_custom_rules:['example.com', 'keyword:example', '1.1.1.1']});
    assert.deepEqual(mixed.proxy_custom_domains, ['example.com']);
    assert.equal(mixed.proxy_custom_rules.length, 3);
    assert.match(api, /block_residential_quic = desiredConfig\.block_residential_quic/);
    assert.match(api, /server\.capabilities = parseCapabilitiesColumn/);
    assert.match(api, /server\.has_ipv4 = nullableBoolean/);
    assert.match(api, /server\.has_ipv6 = nullableBoolean/);
    assert.match(api, /ruleset_mirror_prefix: readRulesetMirrorPrefix/);
    assert.doesNotMatch(api, /SELECT \* FROM servers/);
});

test('manual probes preserve revision guards and realtime merge behavior', () => {
    const server = { egress_status: 'applied', egress_applied_mode: 'residential', residential_ready: true, residential_active_exit_ip: '1.1.1.1' };
    const state = { lastAttempt: 1000, changedAt: 2000, lastExit: '1.1.1.1' };
    const eligible = { visible: true, online: true, refreshing: false };
    assert.equal(shouldAutoProbeEgress(server, state, { ...eligible, visible: false }, 10000), false);
    assert.equal(shouldAutoProbeEgress(server, state, eligible, 6000), false);
    assert.equal(shouldAutoProbeEgress(server, state, eligible, 7000), true);

    const merged = mergeServerRealtimeTelemetry(
        { ip: '203.0.113.8', cpu: 10, last_report: 100, egress_status: 'applied', egress_applied_revision: 5, egress_ip: '104.28.222.43' },
        { ip: '203.0.113.8', cpu: 25, _realtime_ts: 200, egress_status: 'pending', egress_applied_revision: 4, egress_ip: '198.51.100.1' },
    );
    assert.equal(merged.cpu, 25);
    assert.equal(merged.egress_status, 'applied');
    assert.equal(merged.egress_applied_revision, 5);
    assert.equal(resolveCurrentServer([], { ip: 'x' }).ip, 'x');
});

test('route-test exposes shared rule groups and falls back to the local decision', async () => {
    assert.match(api, /'stack_reject', 'quic_reject', 'unknown'/);
    assert.match(api, /readJsonBody\(request, 96 \* 1024\)/);
    const { localRouteDecision, requestRealtimeRouteTest } = __test;
    const config = {
        mode: 'residential',
        proxy_mode: 'selective',
        proxy_categories: 'ai,custom',
        ip_stack: 'dual',
        proxy_direct_rules: ['direct.example.com'],
        proxy_custom_rules: ['custom.example.com'],
    };
    assert.deepEqual(
        [localRouteDecision(config, '192.168.1.10'), localRouteDecision(config, 'direct.example.com'), localRouteDecision(config, 'custom.example.com')].map(item => [item.rule_group, item.scope]),
        [['lan', 'local'], ['custom_direct', 'local'], ['custom_proxy', 'local']],
    );
    assert.equal(localRouteDecision({ ...config, ip_stack: 'ipv4_only' }, '2606:4700::1').rule_group, 'stack_reject');
    assert.equal(localRouteDecision(config, 'chatgpt.com').rule_group, 'unknown');
    const db = { prepare: () => ({ bind: () => ({ first: async () => ({ agent_token: 'agent-secret' }) }) }) };
    const env = { VPS_PRESENCE: { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ rule_group: 'ai', outbound: 'residential', action: 'route', scope: 'agent', revision: 5 }) }) } };
    const upstream = await requestRealtimeRouteTest(env, db, '203.0.113.9', 'chatgpt.com', 5, 'https://panel.example');
    assert.equal(upstream.status, 200);
    assert.equal(upstream.result.scope, 'agent');
    assert.equal(upstream.result.revision, 5);
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
    assert.equal(requests[0].request.headers.get('X-KUI-Expected-Mode'), 'native');
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
