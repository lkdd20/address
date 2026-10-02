const navigationTerms = [
  '交叉口', '路口', '附近', '步行', '地铁站', '公交站', '东侧', '西侧', '南侧', '北侧',
  '东面', '西面', '南面', '北面', '正对面'
];

const trailingNavigation = /[（(][^）)]*(?:步行|地铁|公交|入口|出口|\d+\s*米)[）)]\s*$/u;
const directionalDistance = /(?:东北|东南|西北|西南|东|西|南|北)\s*(?:方向\s*)?\d+\s*米/u;
const directionalDistanceFragment = /(?:东北|东南|西北|西南|东|西|南|北)\s*(?:方向\s*)?\d+\s*米(?:处)?/gu;

export interface ChinaAdministrativeFields {
  province?: string;
  city?: string;
  district?: string;
  township?: string;
}

export const normalizeChinaDeliveryAddress = (value: string): string => {
  let normalized = String(value || '').normalize('NFKC').replace(/\s+/gu, '').trim();
  while (trailingNavigation.test(normalized)) normalized = normalized.replace(trailingNavigation, '');
  normalized = normalized.replace(directionalDistanceFragment, '');
  return normalized;
};

export const normalizeChinaProviderAddress = (value: string, fields: ChinaAdministrativeFields): string => {
  let normalized = normalizeChinaDeliveryAddress(value);
  const parts = [fields.province, fields.city, fields.district, fields.township]
    .map((part) => normalizeChinaDeliveryAddress(part || ''))
    .filter(Boolean);
  const prefixes = new Set<string>();
  for (let mask = 1; mask < (1 << parts.length); mask += 1) {
    if (mask.toString(2).replace(/0/g, '').length < 2) continue;
    let prefix = '';
    for (let index = 0; index < parts.length; index += 1) if (mask & (1 << index)) prefix += parts[index];
    if (prefix) prefixes.add(prefix);
  }
  const ordered = [...prefixes].sort((left, right) => right.length - left.length);
  for (;;) {
    const prefix = ordered.find((candidate) => normalized.startsWith(candidate));
    if (!prefix) break;
    normalized = normalized.slice(prefix.length);
  }
  return cleanChinaDeliveryAddress(normalized);
};

// Chinese communities are addressed by district and community name; a road and house number are kept only when the
// provider gives a clean one, and navigation descriptions are dropped rather than rejecting the community.
export const cleanChinaDeliveryAddress = (value: string): string => {
  const normalized = normalizeChinaDeliveryAddress(value);
  if (!normalized || normalized.length > 160 || directionalDistance.test(normalized)
    || navigationTerms.some((term) => normalized.includes(term))) return '';
  return normalized;
};

// Providers often append the community name to its address; the published address already ends with that name.
export const withoutTrailingCommunityName = (address: string, name: string): string => {
  const communityName = normalizeChinaDeliveryAddress(name);
  return communityName && address.endsWith(communityName) ? address.slice(0, -communityName.length) : address;
};

export const chinaDeliveryAddressClause = (alias = 'community'): string => [
  ...navigationTerms.map((term) => `${alias}.provider_address NOT LIKE '%${term}%'`),
  `${alias}.provider_address !~ '[东南西北][0-9]+米'`
].join(' AND ');
