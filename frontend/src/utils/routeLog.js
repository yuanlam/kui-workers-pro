export const ROUTE_RULE_GROUP_LABELS = {
  lan: '局域网',
  custom_direct: '自定义直连',
  custom_proxy: '自定义住宅',
  ai: 'AI',
  youtube: '油管',
  streaming: '流媒体',
  google: '谷歌',
  final: '兜底',
  stack_reject: '协议栈拒绝',
  quic_reject: 'QUIC 拒绝',
  unknown: '未知规则',
};

export const ROUTE_OUTBOUND_LABELS = {
  direct: '直连',
  residential: '住宅',
  reject: '拒绝',
  unknown: '未知',
};

export const ROUTE_SCOPE_LABELS = {
  agent: 'Agent 精确匹配',
  local: '本地名单判定',
  partial: '部分规则判定',
  unknown: '无法判定',
};

export const ROUTE_LOG_BUFFER_LIMIT = 500;
export const ROUTE_CONNECTION_LIMIT = 100;

import {
  normalizeRoutingRules,
  parseRoutingRule,
  routingRuleConflicts,
  ROUTING_RULE_LIMITS,
} from '../../../src/routing-rules.js';

export {
  parseRoutingRule,
  normalizeRoutingRules,
  routingRuleConflicts,
  ROUTING_RULE_LIMITS,
};

export const ruleGroupLabel = value => ROUTE_RULE_GROUP_LABELS[value] || String(value || '未知规则');
export const outboundLabel = value => ROUTE_OUTBOUND_LABELS[value] || String(value || '未知');
export const routeScopeLabel = value => ROUTE_SCOPE_LABELS[value] || String(value || '无法判定');

export const routeLogTone = value => {
  if (value === 'residential') return 'residential';
  if (value === 'reject') return 'reject';
  if (value === 'direct') return 'direct';
  return 'neutral';
};

export const routeEventTone = (event) => {
  if (event?.action === 'reject' || event?.outbound === 'reject' || /_reject$/.test(String(event?.rule_group || ''))) return 'reject';
  return routeLogTone(event?.outbound);
};

const trimText = (value, limit) => String(value ?? '').trim().slice(0, limit);
const finiteNumber = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const positiveInteger = value => {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

export function normalizeRouteLogEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const host = trimText(event.host, 253);
  const targetIp = trimText(event.target_ip, 64);
  if (!host && !targetIp) return null;
  return {
    id: trimText(event.id, 64) || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    ts: Math.max(0, finiteNumber(event.ts)) || Date.now(),
    inbound: trimText(event.inbound, 64),
    network: trimText(event.network, 16).toLowerCase(),
    host,
    target_ip: targetIp,
    port: Math.max(0, Math.trunc(finiteNumber(event.port))),
    ip_version: positiveInteger(event.ip_version),
    rule_group: trimText(event.rule_group, 32) || 'unknown',
    rule: trimText(event.rule, 128),
    outbound: trimText(event.outbound, 16) || 'unknown',
    action: trimText(event.action, 16) || 'unknown',
  };
}

export function normalizeRouteConnection(connection) {
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) return null;
  const host = trimText(connection.host || connection.destination, 253);
  const targetIp = trimText(connection.target_ip || connection.destinationIP, 64);
  if (!host && !targetIp) return null;
  return {
    id: trimText(connection.id, 64),
    host,
    target_ip: targetIp,
    port: Math.max(0, Math.trunc(finiteNumber(connection.port || connection.destinationPort))),
    network: trimText(connection.network, 16).toLowerCase(),
    inbound: trimText(connection.inbound || connection.inboundTag, 64),
    rule_group: trimText(connection.rule_group, 32) || 'unknown',
    outbound: trimText(connection.outbound, 16) || 'unknown',
    upload: Math.max(0, finiteNumber(connection.upload)),
    download: Math.max(0, finiteNumber(connection.download)),
    duration_ms: Math.max(0, finiteNumber(connection.duration_ms)),
  };
}

export function appendRouteEvents(buffer, events, limit = ROUTE_LOG_BUFFER_LIMIT) {
  const source = Array.isArray(buffer) ? buffer : [];
  const incoming = (Array.isArray(events) ? events : []).map(normalizeRouteLogEvent).filter(Boolean);
  if (!incoming.length) return source;
  const seen = new Set();
  const merged = [];
  for (const event of [...incoming.reverse(), ...source]) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event);
    if (merged.length >= limit) break;
  }
  return merged;
}

export function replaceRouteConnections(connections, limit = ROUTE_CONNECTION_LIMIT) {
  const seen = new Set();
  const normalized = [];
  for (const connection of Array.isArray(connections) ? connections : []) {
    const item = normalizeRouteConnection(connection);
    if (!item) continue;
    const key = item.id || `${item.host}:${item.port}:${item.inbound}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(item);
    if (normalized.length >= limit) break;
  }
  return normalized;
}

export function summarizeRouteEvents(events) {
  const summary = { total: 0, residential: 0, direct: 0, reject: 0 };
  for (const event of Array.isArray(events) ? events : []) {
    summary.total += 1;
    if (event?.outbound === 'reject' || event?.action === 'reject') summary.reject += 1;
    else if (event?.outbound === 'residential') summary.residential += 1;
    else if (event?.outbound === 'direct') summary.direct += 1;
  }
  summary.percent = key => summary.total ? Math.round(summary[key] / summary.total * 1000) / 10 : 0;
  return summary;
}

export function filterRouteEvents(events, filter = {}) {
  const outbound = filter.outbound || 'all';
  const ruleGroup = filter.ruleGroup || 'all';
  const query = String(filter.query || '').trim().toLowerCase();
  return (Array.isArray(events) ? events : []).filter(event => {
    if (outbound !== 'all') {
      const isReject = event.outbound === 'reject' || event.action === 'reject';
      if (outbound === 'reject' ? !isReject : event.outbound !== outbound || isReject) return false;
    }
    if (ruleGroup !== 'all' && event.rule_group !== ruleGroup) return false;
    if (query) {
      const haystack = `${event.host || ''} ${event.target_ip || ''} ${event.inbound || ''} ${event.rule || ''}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

export function routeLogEnvelope(type, vpsIp) {
  const ip = String(vpsIp || '').trim();
  if (!ip) return null;
  if (!['route_log.subscribe', 'route_log.unsubscribe', 'route_log.ping'].includes(type)) return null;
  return { type, vps_ip: ip };
}

export function parseRouteLogMessage(message) {
  if (!message || typeof message !== 'object') return null;
  if (!['route_log.batch', 'route_log.connections', 'route_log.status'].includes(message.type)) return null;
  const vpsIp = String(message.vps_ip || '').trim();
  if (!vpsIp) return null;
  const payload = message.data && typeof message.data === 'object' ? message.data : message;
  if (message.type === 'route_log.batch') {
    const events = Array.isArray(payload.events) ? payload.events : [];
    return { type: message.type, vpsIp, events: events.map(normalizeRouteLogEvent).filter(Boolean).slice(0, 50) };
  }
  if (message.type === 'route_log.connections') {
    return { type: message.type, vpsIp, connections: replaceRouteConnections(payload.connections || [], ROUTE_CONNECTION_LIMIT) };
  }
  const status = ['subscribed', 'unsupported', 'offline', 'error'].includes(payload.status) ? payload.status : 'error';
  return { type: message.type, vpsIp, status, message: trimText(payload.message || payload.error, 200) };
}

export function normalizeRouteTestResult(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const ruleGroup = String(payload.rule_group || 'unknown');
  const outbound = String(payload.outbound || 'unknown');
  const action = String(payload.action || 'unknown');
  const scope = ['agent', 'local', 'partial', 'unknown'].includes(payload.scope) ? payload.scope : 'unknown';
  return {
    revision: Math.max(0, Math.trunc(finiteNumber(payload.revision))),
    ip: trimText(payload.ip, 64),
    target: trimText(payload.target, 253),
    rule_group: ruleGroup,
    outbound,
    action,
    scope,
    rule: trimText(payload.rule, 128),
    reason: trimText(payload.reason, 300),
    notes: Array.isArray(payload.notes) ? payload.notes.map(note => trimText(note, 200)).filter(Boolean).slice(0, 6) : [],
  };
}

const formatTraffic = bytes => {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${Math.max(0, Math.round(value))} B`;
};

export const formatRouteTraffic = formatTraffic;

export function formatRouteDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${String(minutes).padStart(2, '0')}m ${String(rest).padStart(2, '0')}s`;
}

export function formatRouteClock(timestamp) {
  const date = new Date(Number(timestamp) || 0);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

export function routeTargetText(event) {
  const host = String(event?.host || '').trim();
  const ip = String(event?.target_ip || '').trim();
  const port = Number(event?.port) > 0 ? `:${event.port}` : '';
  if (host && ip && host !== ip) return { primary: `${host}${port}`, secondary: ip };
  return { primary: `${host || ip}${port}`, secondary: '' };
}

export function suggestCustomRule(event) {
  if (!event) return '';
  const host = String(event.host || '').trim().toLowerCase().replace(/\.$/, '');
  const targetIp = String(event.target_ip || '').trim();
  const isIpOnly = Boolean(targetIp) && (!host || host === targetIp);
  if (isIpOnly && !targetIp.includes('/')) return targetIp.includes(':') ? `${targetIp}/128` : `${targetIp}/32`;
  if (host) return host.startsWith('*.') ? host : (host.split('.').length > 2 ? host : `*.${host}`);
  return '';
}

export function parseRuleListInput(value) {
  const source = Array.isArray(value) ? value.join('\n') : String(value ?? '');
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  return [...new Set(lines)];
}

export function countRuleList(value) {
  return parseRuleListInput(value).length;
}

export function findRuleConflicts(directRules, customRules) {
  return routingRuleConflicts(
    normalizeRuleForSubmit(directRules),
    normalizeRuleForSubmit(customRules, { residential: true }),
  );
}

export function normalizeRuleForSubmit(value, options = {}) {
  return normalizeRoutingRules(parseRuleListInput(value), options);
}

export function ipStackLabel(value) {
  return ({ ipv4_only: '仅 IPv4', ipv6_only: '仅 IPv6', dual: '双栈' }[value] || '双栈');
}

export function appliedEgressConfigOf(vps) {
  let snapshot = vps?.egress_applied_config;
  if (typeof snapshot === 'string') {
    try {
      snapshot = JSON.parse(snapshot);
    } catch {
      snapshot = null;
    }
  }
  const source = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {};
  const mode = source.mode || vps?.egress_applied_mode || vps?.egress_mode || 'native';
  return {
    mode: mode === 'residential' ? 'residential' : 'native',
    proxy_mode: source.proxy_mode === 'selective' ? 'selective' : 'global',
    ip_stack: source.ip_stack || vps?.ip_stack || 'dual',
  };
}

export function appliedEgressPresetOf(vps) {
  const config = appliedEgressConfigOf(vps);
  if (config.mode !== 'residential') return 'native';
  return config.proxy_mode === 'selective' ? 'selective' : 'global';
}

export function selectableIpStacks(vps) {
  const options = [
    { key: 'ipv4_only', label: '仅 IPv4' },
    { key: 'ipv6_only', label: '仅 IPv6' },
    { key: 'dual', label: '双栈' },
  ];
  const mode = vps?._egress_mode_draft || vps?.egress_mode || 'native';
  const proxyMode = vps?._proxy_mode_draft || vps?.proxy_mode || 'global';
  const residentialGlobal = mode === 'residential' && proxyMode === 'global';
  return options.map(option => {
    let disabled = false;
    let reason = '';
    if (option.key === 'ipv6_only' && residentialGlobal) {
      disabled = true;
      reason = '全局住宅出口固定 IPv4';
    } else if (option.key === 'ipv6_only' && vps?.has_ipv6 === false) {
      disabled = true;
      reason = '该 VPS 未检测到 IPv6 出口';
    } else if (option.key === 'ipv4_only' && vps?.has_ipv4 === false) {
      disabled = true;
      reason = '该 VPS 未检测到 IPv4 出口';
    }
    return { ...option, disabled, reason };
  });
}
