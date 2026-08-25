import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { __test } from '../functions/api/[[path]].js';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const agent = read('../static/vps/agent.py');
const api = read('../functions/api/[[path]].js');
const frontendState = read('../frontend/src/composables/useKuiState.js');
const serversPage = read('../frontend/src/pages/ServersPage.vue');
const { buildSevenDayTrafficSeries, validateTrafficReport } = __test;

test('traffic reports keep node billing separate from system traffic', () => {
    const report = validateTrafficReport({
        ip: '203.0.113.8',
        report_id: '203.0.113.8:1',
        node_traffic: [{ id: 'node_1', delta_bytes: 123 }],
        system_traffic_delta: 456,
    });
    assert.equal(report.total_delta, 123);
    assert.equal(report.system_traffic_delta, 456);

    const legacy = validateTrafficReport({
        ip: '203.0.113.8',
        report_id: '203.0.113.8:2',
        node_traffic: [{ id: 'node_1', delta_bytes: 123 }],
    });
    assert.equal(legacy.system_traffic_delta, 123);
    assert.throws(() => validateTrafficReport({
        ip: '203.0.113.8',
        report_id: '203.0.113.8:3',
        node_traffic: [],
        system_traffic_delta: -1,
    }), /Invalid system traffic delta/);
});

test('seven-day traffic series fills missing Shanghai calendar days with zero', () => {
    const now = Date.UTC(2026, 7, 12, 4, 0, 0);
    const series = buildSevenDayTrafficSeries([
        { day: '2026-08-06', total_bytes: 10 },
        { day: '2026-08-12', total_bytes: 20 },
    ], now);
    assert.equal(series.length, 7);
    assert.deepEqual(series[0], { day: '08-06', total_bytes: 10 });
    assert.deepEqual(series[1], { day: '08-07', total_bytes: 0 });
    assert.deepEqual(series[6], { day: '08-12', total_bytes: 20 });
});

test('agent persists system traffic baseline and advances it only after HTTP acknowledgement', () => {
    assert.match(agent, /last_reported_system_bytes/);
    assert.match(agent, /pending_system_bytes/);
    assert.match(agent, /status\["system_traffic_delta"\]/);
    assert.match(agent, /last_reported_system_bytes = pending_system_bytes/);
    assert.match(agent, /"last_reported_system_bytes": last_reported_system_bytes/);
    assert.match(api, /INSERT INTO traffic_daily[\s\S]{0,320}data\.system_traffic_delta/);
});

test('server overview loads all traffic totals and trends in one request', () => {
    assert.match(frontendState, /const trafficTotals = ref\(\{\}\)/);
    assert.match(frontendState, /const trafficSeries = ref\(\{\}\)/);
    assert.match(frontendState, /fetchApi\('\/api\/stats'\)/);
    assert.doesNotMatch(frontendState, /fetchApi\(`\/api\/stats\?ip=/);
    assert.match(frontendState, /Object\.values\(trafficTotals\.value\)/);
    assert.match(frontendState, /trafficSeries\.value\[vps\.ip\]/);
    assert.match(api, /CREATE TABLE IF NOT EXISTS traffic_daily/);
    assert.match(api, /strftime\('%Y-%m-%d', datetime\(timestamp \/ 1000, 'unixepoch', '\+8 hours'\)\) AS day/);
    assert.match(api, /CREATE INDEX IF NOT EXISTS idx_traffic_time_ip/);
    assert.match(api, /STATS_CACHE_MS = 60_000/);
    assert.match(frontendState, /trafficStatsLastFetchedAt < 120000/);
    assert.match(agent, /REALTIME_HTTP_INTERVAL = 300/);
    assert.match(fs.readFileSync(new URL('../static/vps/lite_manager.py', import.meta.url), 'utf8'), /REALTIME_HTTP_INTERVAL = 300/);
    assert.match(api, /now - current\.ts > 300000/);
    assert.match(api, /nowMs - uiActive\.ts < 360000/);
    assert.match(api, /fastMode \? Math\.max\(60, reportInterval\)/);
});

test('applied egress version shares the verification row at the card bottom', () => {
    const verification = serversPage.indexOf('配置应用时验证出口');
    const appliedBlock = serversPage.slice(serversPage.lastIndexOf('<div v-if=', verification), serversPage.indexOf('v-else-if="vps.egress_status === \'pending\'"', verification));
    assert.match(appliedBlock, /flex items-end justify-between/);
    assert.match(appliedBlock, /配置应用时验证出口/);
    assert.match(appliedBlock, /版本 \{\{ vps\.egress_applied_revision/);
});
