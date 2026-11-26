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

function cleanProfileText(value, limit) {
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  if (typeof value === 'object') return '';
  return String(value).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function cleanProfileToken(value, limit = 32) {
  return cleanProfileText(value, limit).toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, limit);
}

function cleanProfileNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeProfileItems(value, { limit = 8, keyField = 'key', valueField = 'status' } = {}) {
  const source = Array.isArray(value) ? value : (value && typeof value === 'object' ? Object.values(value) : []);
  const entries = [];
  for (const item of source) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const key = cleanProfileToken(item[keyField] || item.id || item.name, 32);
    if (!key || entries.some(entry => entry[keyField] === key)) continue;
    const entry = { [keyField]: key };
    const label = cleanProfileText(item.name || item.label || key, 40);
    if (label) entry.name = label;
    const textValue = cleanProfileText(item[valueField] || item.state || item.result || item.verdict, 48);
    if (textValue) entry[valueField] = textValue;
    const stars = cleanProfileNumber(item.stars ?? item.score ?? item.rating);
    if (stars !== null) entry.stars = Math.max(0, Math.min(5, Math.round(stars * 10) / 10));
    const risk = normalizeRiskScore(item.risk ?? item.score ?? item.value);
    if (risk !== null) entry.risk = risk;
    entries.push(entry);
    if (entries.length >= limit) break;
  }
  return entries;
}

export function normalizeIpProfile(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const profile = {};
  const textFields = {
    asn: 32,
    isp: 80,
    org: 80,
    region: 48,
    city: 48,
    timezone: 48,
    reverse: 128,
    usage_type: 32,
    ip_type: 32,
    native_type: 32,
    shared_users: 24,
    purity_label: 48,
    purity_tone: 16,
  };
  for (const [field, limit] of Object.entries(textFields)) {
    const text = cleanProfileText(source[field], limit);
    if (text) profile[field] = text;
  }
  const countryCode = cleanProfileText(source.country_code, 8).toUpperCase().slice(0, 2);
  if (/^[A-Z]{2}$/.test(countryCode)) profile.country_code = countryCode;
  const driftKm = cleanProfileNumber(source.drift_km);
  if (driftKm !== null && driftKm >= 0) profile.drift_km = Math.round(driftKm * 1000) / 1000;
  const flags = source.flags && typeof source.flags === 'object' ? source.flags : null;
  if (flags) {
    const normalizedFlags = {};
    for (const key of ['proxy', 'hosting', 'vpn', 'tor', 'mobile', 'abuser']) {
      if (typeof flags[key] === 'boolean') normalizedFlags[key] = flags[key];
    }
    if (Object.keys(normalizedFlags).length) profile.flags = normalizedFlags;
  }
  if (source.blocklist && typeof source.blocklist === 'object') {
    const listed = Math.max(0, Math.round(cleanProfileNumber(source.blocklist.listed) || 0));
    const checked = Math.max(0, Math.round(cleanProfileNumber(source.blocklist.checked) || 0));
    const total = Math.max(0, Math.round(cleanProfileNumber(source.blocklist.total) || 0));
    if (listed || checked || total) profile.blocklist = { listed, checked, total };
  }
  const signals = Array.isArray(source.signals)
    ? source.signals.map(signal => cleanProfileText(signal, 32).toLowerCase()).filter(Boolean).slice(0, 8)
    : [];
  if (signals.length) profile.signals = [...new Set(signals)];
  const services = normalizeProfileItems(source.services, { limit: 8, keyField: 'key', valueField: 'status' });
  if (services.length) profile.services = services;
  const media = normalizeProfileItems(source.media, { limit: 8, keyField: 'key', valueField: 'status' });
  if (media.length) profile.media = media;
  const scenarios = normalizeProfileItems(source.scenarios, { limit: 8, keyField: 'key', valueField: 'verdict' });
  if (scenarios.length) profile.scenarios = scenarios;
  const sources = normalizeProfileItems(source.sources, { limit: 8, keyField: 'source', valueField: 'risk' });
  if (sources.length) profile.sources = sources;
  const checkedAt = cleanProfileNumber(source.checked_at);
  if (checkedAt !== null && checkedAt > 0) profile.checked_at = checkedAt < 1e12 ? Math.round(checkedAt * 1000) : Math.round(checkedAt);
  const profileSource = cleanProfileToken(source.source, 32);
  if (profileSource) profile.source = profileSource;
  const substantive = Object.keys(profile).filter(key => !['checked_at', 'source'].includes(key));
  return substantive.length ? profile : null;
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

export function formatRiskLevel(score) {
  const normalized = normalizeRiskScore(score);
  if (normalized === null) {
    return { score: null, label: '待检测', tone: 'neutral' };
  }
  if (normalized <= 15) return { score: normalized, label: '极低风险', tone: 'good' };
  if (normalized <= 30) return { score: normalized, label: '低风险', tone: 'good' };
  if (normalized <= 55) return { score: normalized, label: '中风险', tone: 'warn' };
  return { score: normalized, label: '高风险', tone: 'bad' };
}

export function formatPurityVerdict(meta, profile = null) {
  const normalizedProfile = normalizeIpProfile(profile);
  const fraudScore = normalizeRiskScore(meta?.fraudScore);
  const ipokRisk = normalizeRiskScore(meta?.ipokRisk);
  const scores = [fraudScore, ipokRisk].filter(score => score !== null);
  const maxRisk = scores.length ? Math.max(...scores) : null;
  const flags = normalizedProfile?.flags || {};
  const hardFlag = flags.abuser === true || flags.tor === true;
  const riskFlag = flags.proxy === true || flags.hosting === true || flags.vpn === true;
  const ipType = String(normalizedProfile?.ip_type || '').toLowerCase();
  const nativeType = String(normalizedProfile?.native_type || '').toLowerCase();
  const isResidential = typeof meta?.isResidential === 'boolean'
    ? meta.isResidential
    : ['residential', 'mobile'].includes(ipType)
      ? true
      : ['hosting', 'datacenter'].includes(ipType)
        ? false
        : null;
  const isNative = typeof meta?.isNative === 'boolean'
    ? meta.isNative
    : nativeType === 'native'
      ? true
      : nativeType === 'broadcast'
        ? false
        : null;
  const hasData = Boolean(meta || normalizedProfile);
  let label = '待检测';
  let tone = 'neutral';
  let progress = 0;
  if (hasData && (maxRisk !== null || hardFlag || riskFlag || meta?.typeLabel)) {
    if ((maxRisk !== null && maxRisk >= 56) || hardFlag) {
      label = '高风险';
      tone = 'bad';
    } else if ((maxRisk !== null && maxRisk >= 31) || riskFlag || isResidential === false) {
      label = '存在风险';
      tone = 'warn';
    } else if (maxRisk !== null && maxRisk <= 15 && isResidential === true && isNative === true) {
      label = '极佳纯净';
      tone = 'good';
    } else if (maxRisk !== null) {
      label = '良好可用';
      tone = 'good';
    } else {
      label = '良好可用';
      tone = 'good';
    }
    progress = maxRisk === null ? (tone === 'good' ? 82 : 46) : Math.max(8, Math.min(100, 100 - maxRisk));
  }
  return { label, tone, progress, hasData, maxRisk };
}

export function formatExitPurityMeta(source) {
  const purity = extractTunnelPurity(source);
  const ipProfile = normalizeIpProfile(source?.ip_profile);
  if (!purity && !ipProfile) return null;
  const profileIpType = String(ipProfile?.ip_type || '').toLowerCase();
  const profileNativeType = String(ipProfile?.native_type || '').toLowerCase();
  const isResidential = typeof purity?.is_residential === 'boolean'
    ? purity.is_residential
    : ['residential', 'mobile'].includes(profileIpType)
      ? true
      : ['hosting', 'datacenter'].includes(profileIpType)
        ? false
        : (ipProfile?.flags?.hosting === true ? false : undefined);
  const isNative = typeof purity?.is_native === 'boolean'
    ? purity.is_native
    : profileNativeType === 'native'
      ? true
      : profileNativeType === 'broadcast'
        ? false
        : undefined;
  let typeLabel = '';
  let typeTone = 'slate';
  if (isResidential === true && isNative === true) {
    typeLabel = '原生住宅';
    typeTone = 'emerald';
  } else if (isResidential === true && isNative === false) {
    typeLabel = '广播住宅';
    typeTone = 'sky';
  } else if (isResidential === true) {
    typeLabel = '住宅 IP';
    typeTone = 'emerald';
  } else if (isResidential === false && isNative === true) {
    typeLabel = '原生机房';
    typeTone = 'amber';
  } else if (isResidential === false && isNative === false) {
    typeLabel = '广播机房';
    typeTone = 'rose';
  } else if (isResidential === false) {
    typeLabel = '机房 IP';
    typeTone = 'amber';
  } else if (isNative === true) {
    typeLabel = '原生 IP';
    typeTone = 'sky';
  } else if (isNative === false) {
    typeLabel = '广播 IP';
    typeTone = 'amber';
  }
  const fraudScore = purity?.fraud_score ?? null;
  const ipokRisk = purity?.ipok_risk ?? null;
  const puritySource = purity?.purity_source || ipProfile?.source || '';
  const hasIpok = ipokRisk !== null || String(puritySource).includes('ipok');
  const fraudLevel = formatRiskLevel(fraudScore);
  const ipokLevel = formatRiskLevel(ipokRisk);
  const meta = {
    typeLabel,
    typeTone,
    fraudScore,
    fraudTone: riskScoreTone(fraudScore),
    fraudLevelLabel: fraudLevel.label,
    fraudLevelTone: fraudLevel.tone,
    ipokRisk,
    ipokTone: riskScoreTone(ipokRisk),
    ipokLevelLabel: ipokLevel.label,
    ipokLevelTone: ipokLevel.tone,
    hasIpok,
    asnOrg: purity?.asn_org || ipProfile?.org || ipProfile?.isp || '',
    puritySource,
    ipProfile,
    isResidential,
    isNative,
  };
  const verdict = formatPurityVerdict(meta, ipProfile);
  return {
    ...meta,
    verdictLabel: verdict.label,
    verdictTone: verdict.tone,
    verdictProgress: verdict.progress,
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
