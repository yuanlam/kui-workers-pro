const MAX_RULES = 200;
const MAX_RULE_BYTES = 32 * 1024;
const MAX_RULE_LENGTH = 253;
const MAX_KEYWORD_LENGTH = 64;
const PRIVATE_IPV4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const PRIVATE_IPV6 = [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

function utf8Length(value) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).byteLength;
  let bytes = 0;
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function splitLines(value) {
  if (value !== undefined && value !== null && typeof value !== 'string' && !Array.isArray(value)) throw new Error('Invalid routing list');
  const source = Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/);
  if (source.some(item => typeof item !== 'string')) throw new Error('Invalid routing list entry');
  return source;
}

function addRule(list, value) {
  if (!list.includes(value)) list.push(value);
  return list;
}

function normalizedHostname(value, allowLocal = false) {
  const raw = String(value || '').trim().toLowerCase().replace(/\.+$/, '');
  if (!raw || raw.length > MAX_RULE_LENGTH || /[\x00-\x20\x7f/\\:%?#@]/.test(raw)) throw new Error(`Invalid routing domain: ${value}`);
  let hostname;
  try {
    hostname = new URL(`http://${raw}/`).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    throw new Error(`Invalid routing domain: ${value}`);
  }
  const labels = hostname.split('.');
  if (hostname.length > 253 || parseIpv4(hostname)) throw new Error(`Invalid routing domain: ${value}`);
  const localName = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local');
  const validLabel = label => Boolean(label) && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label);
  if (localName || labels.length < 2 || labels.some(label => !validLabel(label))) {
    if (allowLocal && localName && labels.every(validLabel)) return hostname;
    throw new Error(`Invalid routing domain: ${value}`);
  }
  return hostname;
}

function parseIpv4(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  if (!parts.every(part => part <= 255)) return null;
  return parts;
}

function parseIpv6(value) {
  if (typeof value !== 'string' || !value.includes(':') || !/^[0-9A-Fa-f:.]+$/.test(value)) return null;
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const parseHalf = half => {
    if (!half) return [];
    const parts = [];
    const pieces = half.split(':');
    for (const [index, piece] of pieces.entries()) {
      if (!piece) return null;
      if (piece.includes('.')) {
        const ipv4 = parseIpv4(piece);
        if (!ipv4 || index !== pieces.length - 1) return null;
        parts.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      } else {
        if (!/^[0-9A-Fa-f]{1,4}$/.test(piece)) return null;
        parts.push(parseInt(piece, 16));
      }
    }
    return parts;
  };
  const left = parseHalf(halves[0]);
  if (halves.length === 2 && halves[0].includes('.')) return null;
  const right = halves.length === 2 ? parseHalf(halves[1]) : null;
  if (!left || (halves.length === 2 && !right)) return null;
  if (halves.length === 2) {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    return [...left, ...Array(missing).fill(0), ...right];
  }
  return left.length === 8 ? left : null;
}

function prefixBits(value, family) {
  const text = String(value);
  if (!/^\d{1,3}$/.test(text)) return null;
  const prefix = Number(text);
  const max = family === 4 ? 32 : 128;
  return prefix >= 0 && prefix <= max ? prefix : null;
}

function ipBytes(parts, family) {
  if (family === 4) return parts;
  const bytes = [];
  for (const part of parts) bytes.push(part >> 8, part & 0xff);
  return bytes;
}

function matchesPrefix(value, network, prefix, family) {
  const left = ipBytes(value, family);
  const right = ipBytes(network, family);
  let remaining = prefix;
  for (let index = 0; index < left.length; index++) {
    const bits = Math.min(8, remaining);
    if (bits <= 0) return true;
    const mask = (0xff << (8 - bits)) & 0xff;
    if ((left[index] & mask) !== (right[index] & mask)) return false;
    remaining -= bits;
  }
  return true;
}

function ipToBigInt(parts, family) {
  let value = 0n;
  for (const part of ipBytes(parts, family)) value = (value << 8n) | BigInt(part);
  return value;
}

function ipRange(rule) {
  const bits = rule.family === 4 ? 32 : 128;
  const start = ipToBigInt(rule.parts, rule.family);
  const hostBits = BigInt(bits - rule.prefix);
  return { start, end: start + ((1n << hostBits) - 1n) };
}

function formatIpv6(parts) {
  const hex = parts.map(part => part.toString(16));
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < hex.length;) {
    if (hex[index] !== '0') {
      index++;
      continue;
    }
    let end = index;
    while (end < hex.length && hex[end] === '0') end++;
    if (end - index > bestLength && end - index >= 2) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  if (bestStart < 0) return hex.join(':');
  const left = hex.slice(0, bestStart).join(':');
  const right = hex.slice(bestStart + bestLength).join(':');
  return `${left}::${right}`;
}

function parseIpRule(value) {
  const raw = String(value || '').trim().toLowerCase();
  const slash = raw.indexOf('/');
  if (slash < 0) {
    const singleIpv4 = parseIpv4(raw);
    if (singleIpv4) return { family: 4, parts: singleIpv4, prefix: 32, canonical: `${singleIpv4.join('.')}/32` };
    const singleIpv6 = parseIpv6(raw);
    if (singleIpv6) return { family: 6, parts: singleIpv6, prefix: 128, canonical: `${formatIpv6(singleIpv6)}/128`, ipv6: true };
    return null;
  }
  if (slash !== raw.lastIndexOf('/')) throw new Error(`Invalid routing CIDR: ${value}`);
  const address = raw.slice(0, slash);
  const ipv4 = parseIpv4(address);
  if (ipv4) {
    const prefix = prefixBits(raw.slice(slash + 1), 4);
    if (prefix === null) throw new Error(`Invalid routing CIDR prefix: ${value}`);
    const parts = networkParts(ipv4, prefix, 8);
    return { family: 4, parts, prefix, canonical: `${parts.join('.')}/${prefix}` };
  }
  const ipv6 = parseIpv6(address);
  if (ipv6) {
    const prefix = prefixBits(raw.slice(slash + 1), 6);
    if (prefix === null) throw new Error(`Invalid routing CIDR prefix: ${value}`);
    const parts = networkParts(ipv6, prefix, 16);
    return { family: 6, parts, prefix, canonical: `${formatIpv6(parts)}/${prefix}`, ipv6: true };
  }
  throw new Error(`Invalid routing CIDR: ${value}`);
}

function networkParts(parts, prefix, width) {
  return parts.map((part, index) => {
    const hostBits = width - Math.min(width, Math.max(0, prefix - index * width));
    return (part >> hostBits) << hostBits;
  });
}

export function normalizeRouteTarget(value) {
  const target = String(value ?? '').trim().toLowerCase();
  const ipv4 = parseIpv4(target);
  if (ipv4) return ipv4.join('.');
  const ipv6 = parseIpv6(target);
  if (ipv6) return formatIpv6(ipv6);
  return normalizedHostname(target, true);
}

export function isLocalRouteTarget(target) {
  if (target === 'localhost' || target.endsWith('.local') || target.endsWith('.localhost')) return true;
  const ip = parseIpRule(target);
  return ip !== null && isPrivateIpRule(ip);
}

const privateRanges = [PRIVATE_IPV4, PRIVATE_IPV6].map(ranges =>
  ranges.map(([network, prefix]) => ipRange({ ...parseIpRule(network), prefix })));

function isPrivateIpRule(rule) {
  const ranges = privateRanges[rule.family === 4 ? 0 : 1];
  const candidate = ipRange(rule);
  return ranges.some(range => candidate.start <= range.end && range.start <= candidate.end);
}

export function parseRoutingRule(value, options = {}) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  const ip = parseIpRule(raw);
  if (ip) {
    if (options.residential && isPrivateIpRule(ip)) throw new Error(`Private or reserved IP is not allowed in the residential list: ${value}`);
    return { type: 'ip_cidr', value: ip.canonical, family: ip.family };
  }
  if (raw.startsWith('keyword:')) {
    const keyword = raw.slice(8).trim();
    if (keyword.length < 3 || keyword.length > MAX_KEYWORD_LENGTH || !/^[a-z0-9-]+$/.test(keyword)) throw new Error(`Invalid routing keyword: ${value}`);
    return { type: 'domain_keyword', value: `keyword:${keyword}` };
  }
  if (raw.startsWith('full:')) {
    const hostname = normalizedHostname(raw.slice(5), options.residential !== true);
    return { type: 'domain', value: `full:${hostname}` };
  }
  const domain = raw.startsWith('*.') ? raw.slice(2) : raw;
  return { type: 'domain_suffix', value: normalizedHostname(domain, options.residential !== true) };
}

function readRuleList(value, label, options = {}) {
  const source = splitLines(value);
  const totalBytes = utf8Length(source.join('\n'));
  if (totalBytes > MAX_RULE_BYTES) throw new Error(`${label} exceeds ${MAX_RULE_BYTES} bytes`);
  const rules = [];
  for (const rawLine of source) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const rule = parseRoutingRule(line, options);
    if (rule) addRule(rules, rule.value);
    if (rules.length > MAX_RULES) throw new Error(`${label} exceeds ${MAX_RULES} entries`);
  }
  if (utf8Length(rules.join('\n')) > MAX_RULE_BYTES) throw new Error(`${label} exceeds ${MAX_RULE_BYTES} bytes`);
  return rules;
}

export function normalizeRoutingRules(value, options = {}) {
  const label = options.residential ? 'Residential routing list' : 'Direct routing list';
  return readRuleList(value, label, options);
}

export function validateRoutingRuleLists(direct, residential) {
  const conflicts = routingRuleConflicts(direct, residential);
  if (conflicts.length) throw new Error(`Routing list conflict: ${conflicts.join(', ')}`);
  return { direct, residential };
}

export function routingRuleConflicts(direct, residential) {
  const directRules = new Set((direct || []).map(normalizeRoutingValue));
  return [...new Set((residential || []).map(normalizeRoutingValue))].filter(value => directRules.has(value));
}

function normalizeRoutingValue(value) {
  return String(value || '').toLowerCase();
}

export function routingRuleMatches(rule, target) {
  const parsed = target && typeof target === 'object' ? target : { hostname: String(target || '').trim().toLowerCase() };
  const value = String(rule || '').trim().toLowerCase();
  if (!value) return false;
  const ip = parseIpRule(value);
  if (ip) {
    const host = String(parsed.hostname || '').replace(/^\[|\]$/g, '');
    const ipv4 = parseIpv4(host);
    if (ipv4 && ip.family === 4) return matchesPrefix(ipv4, ip.parts, ip.prefix, 4);
    const ipv6 = parseIpv6(host);
    if (ipv6 && ip.family === 6) return matchesPrefix(ipv6, ip.parts, ip.prefix, 6);
    return false;
  }
  const hostname = String(parsed.hostname || '').toLowerCase().replace(/\.+$/, '');
  if (!hostname) return false;
  if (value.startsWith('keyword:')) return !parseIpRule(hostname) && hostname.includes(value.slice(8));
  if (value.startsWith('full:')) return hostname === value.slice(5);
  return hostname === value || hostname.endsWith(`.${value}`);
}

export const ROUTING_RULE_LIMITS = Object.freeze({ maxRules: MAX_RULES, maxBytes: MAX_RULE_BYTES });
