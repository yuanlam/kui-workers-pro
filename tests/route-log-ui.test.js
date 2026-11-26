import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  appliedEgressConfigOf,
  appliedEgressPresetOf,
  appendRouteEvents,
  normalizeRuleForSubmit,
  parseRouteLogMessage,
  replaceRouteConnections,
  routingRuleConflicts,
  selectableIpStacks,
} from '../frontend/src/utils/routeLog.js';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const serversPage = read('../frontend/src/pages/ServersPage.vue');
const routeLogPage = read('../frontend/src/pages/RouteLogPage.vue');
const routeLogUtils = read('../frontend/src/utils/routeLog.js');
const useApi = read('../frontend/src/composables/useApi.js');
const appStyles = read('../frontend/src/styles/app.css');

test('route log buffers events and tolerates malformed realtime payloads', () => {
  const event = id => ({ id, host: `host-${id}.example`, outbound: 'direct' });
  const buffer = appendRouteEvents([], Array.from({ length: 510 }, (_, index) => event(String(index))));
  assert.equal(buffer.length, 500);
  assert.equal(buffer[0].id, '509');

  assert.deepEqual(appendRouteEvents([{ id: 'kept' }], undefined), [{ id: 'kept' }]);
  assert.deepEqual(parseRouteLogMessage({ type: 'route_log.batch', vps_ip: '203.0.113.1', data: {} }).events, []);
  assert.deepEqual(parseRouteLogMessage({ type: 'route_log.batch', vps_ip: '203.0.113.1', data: { events: 'bad' } }).events, []);
  assert.deepEqual(parseRouteLogMessage({ type: 'route_log.connections', vps_ip: '203.0.113.1', data: { connections: 'bad' } }).connections, []);

  const duplicate = { id: 'same', host: 'example.org', outbound: 'direct' };
  assert.equal(replaceRouteConnections([duplicate, duplicate]).length, 1);
});

test('ip stack options block ipv6 only only for global residential mode', () => {
  assert.equal(selectableIpStacks({}).find(item => item.key === 'ipv6_only').disabled, false);
  assert.equal(selectableIpStacks({ egress_mode: 'residential', proxy_mode: 'global' }).find(item => item.key === 'ipv6_only').disabled, true);
  assert.equal(selectableIpStacks({ egress_mode: 'residential', proxy_mode: 'selective' }).find(item => item.key === 'ipv6_only').disabled, false);
});

test('route log header reflects applied config rather than local draft', () => {
  const vps = {
    egress_applied_mode: 'native',
    ip_stack: 'dual',
    _egress_mode_draft: 'residential',
    _proxy_mode_draft: 'selective',
    _ip_stack_draft: 'ipv6_only',
    egress_applied_config: JSON.stringify({ mode: 'residential', proxy_mode: 'global', ip_stack: 'ipv4_only' }),
  };
  assert.equal(appliedEgressPresetOf(vps), 'global');
  assert.equal(appliedEgressConfigOf(vps).ip_stack, 'ipv4_only');
  assert.equal(appliedEgressPresetOf({ egress_applied_config: '{bad json' }), 'native');
});

test('routing rules normalize keyword storage and reject conflicting residential rules', () => {
  assert.deepEqual(normalizeRuleForSubmit(['keyword:openai']), ['keyword:openai']);
  assert.throws(() => normalizeRuleForSubmit(['10.0.0.1'], { residential: true }), /Private or reserved IP/);
  assert.throws(() => normalizeRuleForSubmit(['keyword:xx'], { residential: true }), /Invalid routing keyword/);
  assert.deepEqual(normalizeRuleForSubmit(['example.org']), ['example.org']);
  assert.deepEqual(normalizeRuleForSubmit(['example.org'], { residential: true }), ['example.org']);
  assert.equal(routingRuleConflicts(normalizeRuleForSubmit(['example.org']), normalizeRuleForSubmit(['example.org'], { residential: true })).length, 1);
});

test('route log page exposes shared selectors and unsupported state', () => {
  for (const value of [
    'id="kui-route-log-vps"',
    'id="kui-route-test-target"',
    'routeLogStatus === \'unsupported\'',
    'egressHasDraft(currentVps.value)',
    'state.applyEgressDraft(vps)',
  ]) assert.match(routeLogPage, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('route test is read-only and does not trigger realtime mutation refresh', () => {
  assert.match(useApi, /if \(url === '\/api\/vps\/route-test'\) return null;/);
});

test('route log styles provide light, dark, and mobile coverage', () => {
  for (const value of [
    '.kui-route-log-page',
    ':root[data-kui-theme="dark"] .kui-route-log-toolbar',
    '@media (max-width: 640px)',
  ]) assert.match(appStyles, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
