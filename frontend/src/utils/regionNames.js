const REGION_NAMES = Object.freeze({
  AE: '阿联酋',
  AF: '阿富汗',
  AL: '阿尔巴尼亚',
  AM: '亚美尼亚',
  AO: '安哥拉',
  AR: '阿根廷',
  AT: '奥地利',
  AU: '澳大利亚',
  AZ: '阿塞拜疆',
  BA: '波黑',
  BD: '孟加拉国',
  BE: '比利时',
  BG: '保加利亚',
  BH: '巴林',
  BM: '百慕大',
  BN: '文莱',
  BR: '巴西',
  BW: '博茨瓦纳',
  BY: '白俄罗斯',
  CA: '加拿大',
  CH: '瑞士',
  CI: '科特迪瓦',
  CL: '智利',
  CM: '喀麦隆',
  CN: '中国',
  CO: '哥伦比亚',
  CY: '塞浦路斯',
  CZ: '捷克',
  DE: '德国',
  DK: '丹麦',
  DZ: '阿尔及利亚',
  EE: '爱沙尼亚',
  EG: '埃及',
  ES: '西班牙',
  ET: '埃塞俄比亚',
  FI: '芬兰',
  FJ: '斐济',
  FO: '法罗群岛',
  FR: '法国',
  GB: '英国',
  GE: '格鲁吉亚',
  GF: '法属圭亚那',
  GH: '加纳',
  GI: '直布罗陀',
  GL: '格陵兰',
  GP: '瓜德罗普',
  GR: '希腊',
  GU: '关岛',
  HK: '中国香港',
  HR: '克罗地亚',
  HU: '匈牙利',
  ID: '印度尼西亚',
  IE: '爱尔兰',
  IL: '以色列',
  IN: '印度',
  IQ: '伊拉克',
  IR: '伊朗',
  IS: '冰岛',
  IT: '意大利',
  JO: '约旦',
  JP: '日本',
  KE: '肯尼亚',
  KH: '柬埔寨',
  KI: '基里巴斯',
  KR: '韩国',
  KW: '科威特',
  KY: '开曼群岛',
  KZ: '哈萨克斯坦',
  LA: '老挝',
  LB: '黎巴嫩',
  LK: '斯里兰卡',
  LT: '立陶宛',
  LU: '卢森堡',
  LV: '拉脱维亚',
  LY: '利比亚',
  MA: '摩洛哥',
  MC: '摩纳哥',
  MD: '摩尔多瓦',
  ME: '黑山',
  MG: '马达加斯加',
  MH: '马绍尔群岛',
  MK: '北马其顿',
  MM: '缅甸',
  MN: '蒙古',
  MO: '中国澳门',
  MQ: '马提尼克',
  MT: '马耳他',
  MU: '毛里求斯',
  MV: '马尔代夫',
  MX: '墨西哥',
  MY: '马来西亚',
  MZ: '莫桑比克',
  NA: '纳米比亚',
  NC: '新喀里多尼亚',
  NG: '尼日利亚',
  NL: '荷兰',
  NO: '挪威',
  NP: '尼泊尔',
  NR: '瑙鲁',
  NZ: '新西兰',
  OM: '阿曼',
  PA: '巴拿马',
  PE: '秘鲁',
  PF: '法属波利尼西亚',
  PG: '巴布亚新几内亚',
  PH: '菲律宾',
  PK: '巴基斯坦',
  PL: '波兰',
  PR: '波多黎各',
  PT: '葡萄牙',
  PW: '帕劳',
  QA: '卡塔尔',
  RE: '留尼汪',
  RO: '罗马尼亚',
  RS: '塞尔维亚',
  RU: '俄罗斯',
  SA: '沙特阿拉伯',
  SB: '所罗门群岛',
  SD: '苏丹',
  SE: '瑞典',
  SG: '新加坡',
  SI: '斯洛文尼亚',
  SK: '斯洛伐克',
  SN: '塞内加尔',
  SY: '叙利亚',
  TH: '泰国',
  TN: '突尼斯',
  TO: '汤加',
  TR: '土耳其',
  TV: '图瓦卢',
  TW: '中国台湾',
  TZ: '坦桑尼亚',
  UA: '乌克兰',
  UG: '乌干达',
  US: '美国',
  UZ: '乌兹别克斯坦',
  VA: '梵蒂冈',
  VI: '美属维尔京群岛',
  VN: '越南',
  VU: '瓦努阿图',
  WF: '瓦利斯和富图纳',
  WS: '萨摩亚',
  YE: '也门',
  ZA: '南非',
  ZM: '赞比亚',
  ZW: '津巴布韦',
});

const REGION_ALIASES = Object.freeze({
  '全球': 'ANY',
  '全球自动': 'ANY',
  '自动': 'ANY',
  '自动优选': 'ANY',
  'any': 'ANY',
  'auto': 'ANY',
  '中国': 'CN',
  '中国台湾': 'TW',
  '中国香港': 'HK',
  '中国澳门': 'MO',
  '台湾': 'TW',
  '香港': 'HK',
  '澳门': 'MO',
  '日本': 'JP',
  '美国': 'US',
  '泰国': 'TH',
  '新加坡': 'SG',
  '韩国': 'KR',
  '南韩': 'KR',
  '英国': 'GB',
  '德国': 'DE',
  '法国': 'FR',
  '荷兰': 'NL',
  '加拿大': 'CA',
  '澳大利亚': 'AU',
  '澳洲': 'AU',
  '印度': 'IN',
  '越南': 'VN',
  '马来西亚': 'MY',
  '印度尼西亚': 'ID',
  '印尼': 'ID',
  '菲律宾': 'PH',
  '俄罗斯': 'RU',
  '俄国': 'RU',
  '巴西': 'BR',
  '土耳其': 'TR',
  '意大利': 'IT',
  '西班牙': 'ES',
  '瑞典': 'SE',
  '瑞士': 'CH',
  '波兰': 'PL',
  '阿联酋': 'AE',
  '阿拉伯联合酋长国': 'AE',
  '沙特': 'SA',
  '沙特阿拉伯': 'SA',
  '墨西哥': 'MX',
  '阿根廷': 'AR',
  '智利': 'CL',
  '新西兰': 'NZ',
  '爱尔兰': 'IE',
  '比利时': 'BE',
  '奥地利': 'AT',
  '丹麦': 'DK',
  '挪威': 'NO',
  '芬兰': 'FI',
  '葡萄牙': 'PT',
  '捷克': 'CZ',
  '希腊': 'GR',
  '乌克兰': 'UA',
  '南非': 'ZA',
  '埃及': 'EG',
  '以色列': 'IL',
  'japan': 'JP',
  'united states': 'US',
  'united states of america': 'US',
  'usa': 'US',
  'thailand': 'TH',
  'singapore': 'SG',
  'south korea': 'KR',
  'korea': 'KR',
  'taiwan': 'TW',
  'hong kong': 'HK',
  'macau': 'MO',
  'macao': 'MO',
  'united kingdom': 'GB',
  'uk': 'GB',
  'germany': 'DE',
  'france': 'FR',
  'netherlands': 'NL',
  'canada': 'CA',
  'australia': 'AU',
  'india': 'IN',
  'vietnam': 'VN',
  'malaysia': 'MY',
  'indonesia': 'ID',
  'philippines': 'PH',
  'russia': 'RU',
  'brazil': 'BR',
  'turkey': 'TR',
  'italy': 'IT',
  'spain': 'ES',
  'sweden': 'SE',
  'switzerland': 'CH',
  'poland': 'PL',
  'united arab emirates': 'AE',
});

const REGION_LOOKUP = new Map();
for (const [code, label] of Object.entries(REGION_NAMES)) {
  REGION_LOOKUP.set(normalizeAliasKey(code), code);
  REGION_LOOKUP.set(normalizeAliasKey(label), code);
}
for (const [alias, code] of Object.entries(REGION_ALIASES)) {
  REGION_LOOKUP.set(normalizeAliasKey(alias), code);
}

function normalizeAliasKey(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-·/]+/g, '');
}

function normalizeCode(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!raw) return '';
  if (raw === 'ANY') return 'ANY';
  if (raw === 'UK') return 'GB';
  if (raw === 'AUTO') return 'ANY';
  return /^[A-Z]{2}$/.test(raw) ? raw : '';
}

function intlRegionName(code) {
  if (typeof Intl === 'undefined' || typeof Intl.DisplayNames !== 'function') return '';
  try {
    const label = new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(code);
    return label && label !== code ? String(label) : '';
  } catch (_) {
    return '';
  }
}

export function formatRegionName(code, options = {}) {
  const { fallback = '未知地区', emptyLabel = '全球自动' } = options || {};
  const raw = String(code ?? '').trim();
  if (!raw) return emptyLabel;
  const normalized = normalizeCode(raw);
  if (normalized === 'ANY') return '全球自动';
  if (!normalized) {
    const aliased = REGION_LOOKUP.get(normalizeAliasKey(raw));
    if (aliased) return REGION_NAMES[aliased] || fallback;
    return fallback;
  }
  return REGION_NAMES[normalized] || intlRegionName(normalized) || fallback;
}

export function formatRegionWithCity(code, city, region) {
  const regionLabel = formatRegionName(code);
  const location = String(city ?? '').trim() || String(region ?? '').trim();
  return location ? `${regionLabel} · ${location}` : regionLabel;
}

export function normalizeRegionQuery(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const code = resolveRegionCodeFromInput(raw);
  if (code) return code;
  return raw;
}

export function resolveRegionCodeFromInput(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const direct = normalizeCode(raw);
  if (direct) return direct;
  return REGION_LOOKUP.get(normalizeAliasKey(raw)) || '';
}

export function regionMatchesQuery(code, query) {
  const rawQuery = String(query ?? '').trim();
  if (!rawQuery) return true;
  const normalizedCode = normalizeCode(code);
  if (!normalizedCode) return false;
  const resolved = resolveRegionCodeFromInput(rawQuery);
  if (resolved) return resolved === normalizedCode;
  const queryKey = normalizeAliasKey(rawQuery);
  const codeKey = normalizeAliasKey(normalizedCode);
  const labelKey = normalizeAliasKey(formatRegionName(normalizedCode));
  return codeKey.includes(queryKey) || labelKey.includes(queryKey);
}

export const REGION_NAME_MAP = REGION_NAMES;
