export const ROUTE_COMMANDS = new Set(['route_log.subscribe', 'route_log.unsubscribe', 'route_log.ping']);
const groups = new Set(['lan', 'custom_direct', 'custom_proxy', 'ai', 'youtube', 'streaming', 'google', 'final', 'stack_reject', 'quic_reject', 'unknown']);
const outbounds = new Set(['direct', 'residential', 'reject', 'unknown']);
const actions = new Set(['route', 'reject', 'dns', 'unknown']);

export function routeDecision(value) {
  if (!value || !groups.has(value.rule_group) || !outbounds.has(value.outbound) || !actions.has(value.action)) return null;
  return {rule_group: value.rule_group, outbound: value.outbound, action: value.action};
}

function text(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit).replace(/[\x00-\x1f\x7f]/g, '') : '';
}

function metric(value, max = Number.MAX_SAFE_INTEGER) {
  return Number.isFinite(value) ? Math.min(max, Math.max(0, Math.trunc(value))) : 0;
}

export function routeFrame(type, data, ip) {
  const active = type === 'route_log.connections';
  if (!active && type !== 'route_log.batch') return null;
  const key = active ? 'connections' : 'events';
  if (!Array.isArray(data?.[key])) return null;
  const rows = [];
  for (const row of data[key].slice(0, active ? 100 : 50)) {
    const decision = routeDecision(row);
    const id = text(row?.id, 64);
    if (!decision || !id) continue;
    rows.push({id, ts: metric(row.ts), inbound: text(row.inbound, 64), network: text(row.network, 8), host: text(row.host, 253), target_ip: text(row.target_ip, 45), port: metric(row.port, 65535), ip_version: [4, 6].includes(row.ip_version) ? row.ip_version : 0, rule: text(row.rule, 128), ...decision,
      ...(active ? {upload: metric(row.upload), download: metric(row.download), duration_ms: metric(row.duration_ms)} : {})});
  }
  return {type, vps_ip: ip, [key]: rows};
}
