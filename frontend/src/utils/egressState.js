export function shouldAutoProbeEgress(server, state, context, now = Date.now()) {
  if (!context.visible || !context.online || context.refreshing) return false;
  if (server?.egress_status !== 'applied' || server?.egress_applied_mode !== 'residential'
      || !server?.residential_ready || !server?.residential_active_exit_ip) return false;
  if (state.changedAt) return now - state.changedAt >= 5000;
  return !state.lastAttempt || now - state.lastAttempt >= 300000;
}

export function applyEgressRealtimeResult(server, result) {
  if (!server || result?.component !== 'egress') return false;
  const revision = Number(result.revision);
  const currentRevision = Number(server.egress_revision || 0);
  if (!Number.isSafeInteger(revision) || revision < 0) return false;
  const exactRevision = revision === currentRevision;
  const pendingTarget = ['pending', 'preparing'].includes(server.egress_status)
    && revision >= currentRevision
    && result.desired_mode === server.egress_mode;
  if (!exactRevision && !pendingTarget) return false;

  server.egress_revision = Math.max(currentRevision, revision);
  server.egress_status = result.status === 'preparing' ? 'preparing' : (result.success ? 'applied' : 'failed');
  server.egress_applied_mode = result.applied_mode;
  server.egress_error = result.status === 'preparing' ? (result.message || '') : (result.error || '');
  if (server.egress_status === 'applied') {
    server.egress_applied_revision = revision;
    if (result.egress_ip) server.egress_ip = result.egress_ip;
  }
  return true;
}

export function applyEgressProbeResult(server, result) {
  if (!server || result?.success !== true || result?.accepted !== true || !result.egress_ip) return false;
  const revision = Number(result.applied_revision);
  if (!Number.isSafeInteger(revision) || revision < 0) return false;
  if (String(result.applied_mode || '') !== String(server.egress_applied_mode || 'native')) return false;
  if (revision !== Number(server.egress_applied_revision || 0)) return false;
  server.egress_ip = result.egress_ip;
  return true;
}

export function resolveCurrentServer(servers, server) {
  if (!server) return server;
  const key = String(server.ip || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!key) return server;
  return (Array.isArray(servers) ? servers : []).find(item => (
    String(item?.ip || '').trim().replace(/^\[|\]$/g, '').toLowerCase() === key
  )) || server;
}

export function shouldSuggestWarpOptimization(result, now = Date.now()) {
  if (result?.component !== 'egress' || result.success !== true) return false;
  if (!String(result.applied_mode || '').startsWith('warp_')) return false;
  const appliedAt = Number(result.applied_at);
  return Number.isFinite(appliedAt) && appliedAt <= now && now - appliedAt <= 10 * 60 * 1000;
}

const CORE_REALTIME_TELEMETRY_FIELDS = [
  'cpu', 'mem', 'disk', 'load', 'uptime', 'net_in_speed', 'net_out_speed',
  'tcp_conn', 'udp_conn', 'last_report', 'realtime_state', 'stale_after_ms', 'interval_ms', 'boot_id', 'sequence',
  'config_result', 'config_result_at', '_realtime_ts', '_realtime_heartbeat_ts', 'warp',
];

const RESIDENTIAL_REALTIME_TELEMETRY_FIELDS = [
  'residential_active_exit_ip', 'residential_standby_exit_ip',
  'residential_active_purity', 'residential_standby_purity',
  'residential_ready', 'residential_reason', 'residential_last_seen',
];

function normalizeRiskScore(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  return Math.round(parsed);
}

export function extractTunnelPurity(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const purity = {};
  if (typeof detail.is_residential === 'boolean') purity.is_residential = detail.is_residential;
  if (typeof detail.is_native === 'boolean') purity.is_native = detail.is_native;
  const fraudScore = normalizeRiskScore(detail.fraud_score);
  if (fraudScore !== null) purity.fraud_score = fraudScore;
  const ipokRisk = normalizeRiskScore(detail.ipok_risk);
  if (ipokRisk !== null) purity.ipok_risk = ipokRisk;
  const puritySource = String(detail.purity_source || '').toLowerCase().replace(/[^a-z0-9_+.-]/g, '').slice(0, 32);
  if (puritySource) purity.purity_source = puritySource;
  const asnOrg = String(detail.asn_org || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 64);
  if (asnOrg) purity.asn_org = asnOrg;
  return Object.keys(purity).length > 0 ? purity : null;
}

function riskScoreTone(score) {
  if (score === null) return '';
  if (score <= 25) return 'emerald';
  if (score <= 55) return 'amber';
  return 'rose';
}

export function formatExitPurityMeta(source) {
  const purity = extractTunnelPurity(source);
  if (!purity) return null;
  let typeLabel = '';
  let typeTone = 'slate';
  if (purity.is_residential === true && purity.is_native === true) {
    typeLabel = '原生住宅';
    typeTone = 'emerald';
  } else if (purity.is_residential === true && purity.is_native === false) {
    typeLabel = '广播住宅';
    typeTone = 'sky';
  } else if (purity.is_residential === true) {
    typeLabel = '住宅 IP';
    typeTone = 'emerald';
  } else if (purity.is_residential === false && purity.is_native === true) {
    typeLabel = '原生机房';
    typeTone = 'amber';
  } else if (purity.is_residential === false && purity.is_native === false) {
    typeLabel = '广播机房';
    typeTone = 'rose';
  } else if (purity.is_residential === false) {
    typeLabel = '机房 IP';
    typeTone = 'amber';
  } else if (purity.is_native === true) {
    typeLabel = '原生 IP';
    typeTone = 'sky';
  } else if (purity.is_native === false) {
    typeLabel = '广播 IP';
    typeTone = 'amber';
  }
  const fraudScore = purity.fraud_score ?? null;
  const ipokRisk = purity.ipok_risk ?? null;
  const hasIpok = ipokRisk !== null || String(purity.purity_source || '').includes('ipok');
  if (!typeLabel && fraudScore === null && ipokRisk === null) return null;
  return {
    typeLabel,
    typeTone,
    fraudScore,
    fraudTone: riskScoreTone(fraudScore),
    ipokRisk,
    ipokTone: riskScoreTone(ipokRisk),
    hasIpok,
    asnOrg: purity.asn_org || '',
    puritySource: purity.purity_source || '',
  };
}

export function mergeServerRealtimeTelemetry(server, realtime) {
  const merged = { ...server };
  if (!realtime) return merged;
  const hasRealtime = Number(realtime._realtime_ts || 0) > 0;
  const serverTs = Number(server?.last_report || 0);
  const coreIsFresh = hasRealtime
    ? Number(realtime._realtime_ts) >= serverTs
    : Number(realtime.last_report || 0) > serverTs;
  if (coreIsFresh) {
    for (const field of CORE_REALTIME_TELEMETRY_FIELDS) {
      if (realtime[field] !== undefined) merged[field] = realtime[field];
    }
  }
  if (Number(realtime.residential_last_seen || 0) > Number(server?.residential_last_seen || 0)) {
    for (const field of RESIDENTIAL_REALTIME_TELEMETRY_FIELDS) {
      if (realtime[field] !== undefined) merged[field] = realtime[field];
    }
  }
  return merged;
}
