import { isValidPostcode } from './postcode-patterns.mjs';
import { countryBoundAreas } from './country-bounds.mjs';

const policies = {
  US: { admin1: true, locality: true },
  CA: { admin1: true, locality: true },
  MX: { admin1: true, locality: true, district: true },
  GB: { locality: true },
  DE: { locality: true },
  FR: { locality: true },
  IT: { admin1: true, locality: true },
  ES: { admin1: true, locality: true },
  NL: { locality: true },
  JP: { admin1: true, locality: true, district: true },
  CN: { admin1: true, locality: true, district: true, postcode: false },
  HK: { locality: true, postcode: false },
  TW: { admin1: true, locality: true },
  KR: { admin1: true, locality: true, district: true },
  SG: { postcode: true },
  MY: { admin1: true, locality: true },
  TH: { admin1: true, locality: true, district: true },
  PH: { admin1: true, locality: true, district: true },
  VN: { admin1: true, locality: true },
  TR: { admin1: true, locality: true, district: true },
  SA: { locality: true, district: true },
  IN: { admin1: true, locality: true, district: true },
  AU: { admin1: true, locality: true },
  BR: { admin1: true, locality: true, district: true },
  NG: { admin1: true, locality: true, district: true },
  ZA: { admin1: true, locality: true, district: true },
  RU: { admin1: true, locality: true }
};

const clean = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
const compact = (value) => clean(value).replace(/\s+/gu, '').toUpperCase();
const letters = /\p{L}/u;
const han = /\p{Script=Han}/u;
const japanese = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

const same = (left, right) => Boolean(clean(left)) && compact(left) === compact(right);
// AreaCity/StatsGov 2025.251231.260403: mainland direct-admin placeholder levels.
const chinaDirectLocalities = {
  '河南省': ['济源市'],
  '湖北省': ['仙桃市', '潜江市', '天门市', '神农架林区'],
  '广东省': ['东莞市', '中山市'],
  '海南省': ['儋州市', '五指山市', '琼海市', '文昌市', '万宁市', '东方市', '定安县', '屯昌县',
    '澄迈县', '临高县', '白沙黎族自治县', '昌江黎族自治县', '乐东黎族自治县', '陵水黎族自治县',
    '保亭黎族苗族自治县', '琼中黎族苗族自治县'],
  '甘肃省': ['嘉峪关市'],
  '新疆维吾尔自治区': ['石河子市', '阿拉尔市', '图木舒克市', '五家渠市', '北屯市', '铁门关市',
    '双河市', '可克达拉市', '昆玉市', '胡杨河市', '新星市', '白杨市']
};
const addDuplicateReasons = (country, components, reasons) => {
  const locality = localityValue(components);
  const district = districtValue(components);
  const koreanLandLot = country === 'KR' && same(components.street, district)
    && /(?:동|읍|면|리)$/u.test(clean(components.street));
  if (['JP', 'TW'].includes(country) && same(components.admin1, locality)) {
    reasons.push('duplicate_admin1_locality');
  }
  const directChinaLocality = country === 'CN' && chinaDirectLocalities[clean(components.admin1)]?.includes(locality);
  if (district && same(locality, district) && !directChinaLocality) reasons.push('duplicate_locality_district');
  if (same(components.street, locality) || (!koreanLandLot && same(components.street, district))
    || same(components.street, components.admin1)) {
    reasons.push('street_matches_administration');
  }
};

const addCountryReasons = (country, components, reasons) => {
  const admin1 = clean(components.admin1);
  const locality = localityValue(components);
  const district = districtValue(components);
  const street = clean(components.street);
  if (country === 'US' && !/^(?:[A-Z]{2}|[\p{L} .'-]+)$/u.test(clean(components.admin1Code || admin1))) {
    reasons.push('invalid_us_admin1');
  }
  if (country === 'JP') {
    if (!japanese.test(`${admin1}${locality}${district}${street}`)) reasons.push('invalid_japanese_script');
    if (admin1 && !/[都道府県]$/u.test(admin1)) reasons.push('invalid_japanese_prefecture');
    if (locality && !/[市区町村郡]$/u.test(locality)) reasons.push('invalid_japanese_locality');
  }
  if (country === 'TW') {
    if (!han.test(`${admin1}${locality}${street}`)) reasons.push('invalid_taiwan_script');
    if (admin1 && !/[縣市]$/u.test(admin1)) reasons.push('invalid_taiwan_admin1');
    if (locality && !/[區鄉鎮市]$/u.test(locality)) reasons.push('invalid_taiwan_locality');
  }
  if (['DE', 'FR'].includes(country) && (!letters.test(street) || /^\d+$/u.test(street))) {
    reasons.push('invalid_street_name');
  }
};

const addCoordinateReasons = (country, latitude, longitude, reasons) => {
  if (latitude === undefined && longitude === undefined) return;
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    reasons.push('invalid_coordinates');
    return;
  }
  const bounds = countryBoundAreas[country];
  if (bounds && !bounds.some(([minimumLongitude, minimumLatitude, maximumLongitude, maximumLatitude]) =>
    lon >= minimumLongitude && lat >= minimumLatitude && lon <= maximumLongitude && lat <= maximumLatitude)) {
    reasons.push('coordinates_outside_country');
  }
};

export const normalizePostcode = (countryCode, value) => {
  const country = clean(countryCode).toUpperCase();
  const source = clean(value).toUpperCase();
  if (!source) return '';
  const packed = compact(source);
  if (country === 'CA' && /^[A-Z]\d[A-Z]\d[A-Z]\d$/u.test(packed)) return `${packed.slice(0, 3)} ${packed.slice(3)}`;
  if (country === 'GB' && /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/u.test(packed)) return `${packed.slice(0, -3)} ${packed.slice(-3)}`;
  if (country === 'NL' && /^\d{4}[A-Z]{2}$/u.test(packed)) return `${packed.slice(0, 4)} ${packed.slice(4)}`;
  if (country === 'JP' && /^\d{7}$/u.test(packed)) return `${packed.slice(0, 3)}-${packed.slice(3)}`;
  if (country === 'BR' && /^\d{8}$/u.test(packed)) return `${packed.slice(0, 5)}-${packed.slice(5)}`;
  if (country === 'IN' && /^\d{6}$/u.test(packed)) return packed;
  return source;
};

const localityValue = (components) => clean(components.locality || components.postalLocality);
const districtValue = (components) => clean(components.district || components.dependentLocality);

export const normalizeAddressFacts = (countryCode, input = {}) => {
  const components = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, typeof value === 'string' ? clean(value) : value]));
  components.postcode = normalizePostcode(countryCode, components.postcode);
  const buildingName = clean(components.buildingName);
  const unit = clean(components.unit);
  if (/^\d+[\p{L}\p{N}./-]*$/u.test(buildingName)) {
    delete components.buildingName;
  } else if (/^(?:apt|apartment|unit|ste|suite|fl|floor|bldg|building|#|no\.?)$/iu.test(buildingName)) {
    delete components.buildingName;
  }
  if (/^(?:apt|apartment|unit|ste|suite|fl|floor|#|no\.?)$/iu.test(unit)) delete components.unit;
  return components;
};

export const streetAddressKey = (countryCode, components = {}) => [
  'street', countryCode, components.admin1Code || components.admin1,
  components.locality || components.postalLocality, components.district || components.dependentLocality,
  components.street
].map((value) => clean(value).toLocaleLowerCase('und')).join('\u001f');

export const addressCanonicalKey = (countryCode, components = {}, matchLevel = 'premise') => {
  if (matchLevel === 'street') return streetAddressKey(countryCode, components);
  return ['premise', countryCode, components.admin1Code || components.admin1,
    components.locality || components.postalLocality, components.district || components.dependentLocality,
    components.postcode, components.street, components.houseNumber, components.unit
  ].map((value) => clean(value).toLocaleLowerCase('und')).join('\u001f');
};

export const validateAddressQuality = ({ countryCode, components, latitude, longitude, matchLevel = 'premise' } = {}) => {
  const country = clean(countryCode).toUpperCase();
  const policy = policies[country];
  const normalizedComponents = normalizeAddressFacts(country, components);
  const reasons = [];
  if (!policy) reasons.push('unsupported_country');
  const streetLevel = matchLevel === 'street' && country !== 'CN';
  if (!['street', 'premise', 'subpremise'].includes(matchLevel)
    || (matchLevel === 'street' && !streetLevel)) reasons.push('invalid_match_level');
  if (streetLevel && ['houseNumber', 'buildingName', 'unit'].some((field) => clean(normalizedComponents[field]))) {
    reasons.push('street_has_premise_fields');
  }
  if (!streetLevel && !clean(normalizedComponents.houseNumber)) reasons.push('missing_house_number');
  if (!clean(normalizedComponents.street)) reasons.push('missing_street');
  if (policy?.admin1 && !clean(normalizedComponents.admin1 || normalizedComponents.admin1Code)) reasons.push('missing_admin1');
  if (policy?.locality && !localityValue(normalizedComponents)) reasons.push('missing_locality');
  if (policy?.district && !districtValue(normalizedComponents)) reasons.push('missing_district');
  const postcode = clean(normalizedComponents.postcode);
  if (policy?.postcode && !postcode) reasons.push('missing_postcode');
  if (postcode && !isValidPostcode(country, postcode)) reasons.push('invalid_postcode');
  if (clean(normalizedComponents.buildingName) && /^\d+[\p{L}\p{N}./-]*$/u.test(clean(normalizedComponents.buildingName))) {
    reasons.push('numeric_building_name');
  }
  addDuplicateReasons(country, normalizedComponents, reasons);
  addCountryReasons(country, normalizedComponents, reasons);
  addCoordinateReasons(country, latitude, longitude, reasons);
  return { valid: reasons.length === 0, reasons, components: normalizedComponents };
};

export const addressQualitySqlClause = (prefix = '') => {
  const value = (field) => `trim(${prefix}${field}) <> ''`;
  const fresh = `(${prefix}expires_at IS NULL OR CASE WHEN ${prefix}expires_at ~
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
    THEN ${prefix}expires_at::timestamptz > CURRENT_TIMESTAMP
    WHEN ${prefix}expires_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    THEN ${prefix}expires_at::date >= CURRENT_DATE
    ELSE FALSE END)`;
  const city = `(${value('locality')} OR (${value('postal_locality')} AND ${prefix}postal_locality <> ${prefix}street))`;
  const district = `(${value('district')})`;
  const region = `(${value('admin1')} OR ${value('admin1_code')})`;
  const streetLevel = `(${prefix}country_code <> 'CN' AND ${prefix}match_level = 'street'
    AND trim(${prefix}house_number) = '' AND trim(${prefix}building_name) = '' AND ${prefix}property_type = 'unknown')`;
  const groups = new Map();
  for (const [country, policy] of Object.entries(policies)) {
    const checks = [`((${prefix}match_level IN ('premise','subpremise') AND ${value('house_number')}) OR ${streetLevel})`, value('street')];
    if (policy.admin1) checks.push(region);
    if (policy.locality) checks.push(city);
    if (policy.district) checks.push(district);
    if (country === 'CN') checks.push(value('postcode'));
    if (country === 'SG') checks.push(`${prefix}postcode ~ '^[0-9]{6}$'`);
    const expression = [fresh, ...checks].join(' AND ');
    const countries = groups.get(expression) || [];
    countries.push(country);
    groups.set(expression, countries);
  }
  const coordinateClause = Object.entries(countryBoundAreas).map(([country, bounds]) =>
    `(${prefix}country_code='${country}' AND (${bounds.map(([minimumLongitude, minimumLatitude, maximumLongitude, maximumLatitude]) =>
      `(${prefix}longitude BETWEEN ${minimumLongitude} AND ${maximumLongitude} AND ${prefix}latitude BETWEEN ${minimumLatitude} AND ${maximumLatitude})`
    ).join(' OR ')}))`
  ).join(' OR ');
  const policyClause = [...groups]
    .map(([expression, countries]) => `(${prefix}country_code IN (${countries.map((country) => `'${country}'`).join(',')}) AND ${expression})`)
    .join(' OR ');
  return `(${coordinateClause}) AND (${policyClause})`;
};

export const countryAddressPolicies = policies;
