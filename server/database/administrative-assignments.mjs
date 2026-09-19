import { createHash } from 'node:crypto';
import { findHongKongDistrict, findHongKongRegion, hongKongRegions } from '../../src/domain/hk-administrative-divisions.mjs';

const parse = (value) => { try { return JSON.parse(value) || {}; } catch { return {}; } };
const key = (value) => String(value || '').normalize('NFKC').toLocaleLowerCase('und').replace(/[^\p{L}\p{N}]/gu, '');
const legacyHongKongDistrictCodes = { HCW: 'CW', HEA: 'EST', HSO: 'STH', HWC: 'WC', KKC: 'KLC', KKT: 'KT',
  KSS: 'SSP', KWT: 'WTS', KYT: 'YTM', NIS: 'ILD', NKT: 'KC', NNO: 'NTH', NSK: 'SK', NST: 'ST',
  NTP: 'TP', NTW: 'TW', NTM: 'TM', NYL: 'YL' };
const sourceFields = ['country_code', 'generation', 'admin1', 'admin1_code', 'locality', 'postal_locality', 'district',
  'street', 'house_number', 'postcode', 'latitude', 'longitude', 'component_variants_json'];
export const administrativeInputSql = (prefix) => `md5(jsonb_build_array(${sourceFields.map((field) => `${prefix}.${field}::text`).join(',')})::text)`;
export const administrativeAssignmentJoin = (prefix) => `LEFT JOIN address_administrative_assignments administrative
  ON administrative.address_id=${prefix}.id AND CASE WHEN ${prefix}.country_code IN ('HK','SG')
    THEN administrative.input_hash=${administrativeInputSql(prefix)} ELSE FALSE END`;
export const administrativeValueSql = (column, prefix) => {
  const field = { admin1: 'admin1', admin1_code: 'admin1Code', locality: 'locality' }[column];
  return `COALESCE(${prefix}.administrative_patch_json::jsonb -> 'en' ->> '${field}',${prefix}.${column})`;
};
export const administrativeKeySql = (column, prefix) => {
  const field = { admin1: 'admin1', admin1_code: 'admin1Code', locality: 'locality' }[column];
  return `COALESCE(lower(trim(${prefix}.administrative_patch_json::jsonb -> 'en' ->> '${field}')),${prefix}.${column}_key)`;
};

export const administrativeAssignmentSchema = `CREATE TABLE IF NOT EXISTS address_administrative_assignments (
  address_id TEXT PRIMARY KEY REFERENCES address_pool(id) ON DELETE CASCADE,
  country_code TEXT NOT NULL,
  region_id INTEGER REFERENCES catalog_regions(id) ON DELETE SET NULL,
  city_id INTEGER REFERENCES catalog_cities(id) ON DELETE SET NULL,
  reference_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('verified','unresolved','conflict')),
  reason TEXT,
  patch_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);`;

export const administrativeRuntimeView = (source) => {
  const view = source.match(/CREATE VIEW address_pool_runtime AS[\s\S]*?WHERE address_pool.active = 1;/u)?.[0];
  if (!view) throw new Error('Administrative projection runtime view is missing');
  return view.replace('CREATE VIEW ', 'CREATE OR REPLACE VIEW ')
    .replace('address_sources.attribution_url\nFROM address_pool', 'address_sources.attribution_url,\n  administrative.patch_json AS administrative_patch_json\nFROM address_pool')
    .replace('address_sources.attribution_url\r\nFROM address_pool', 'address_sources.attribution_url,\n  administrative.patch_json AS administrative_patch_json\r\nFROM address_pool')
    .replace('FROM address_pool\nJOIN address_pool_evidence', `FROM address_pool\n${administrativeAssignmentJoin('address_pool')}\nJOIN address_pool_evidence`)
    .replace('FROM address_pool\r\nJOIN address_pool_evidence', `FROM address_pool\r\n${administrativeAssignmentJoin('address_pool')}\r\nJOIN address_pool_evidence`);
};

export const projectAdministrativeRow = (row) => {
  const patch = parse(row.administrative_patch_json);
  if (!patch.native) return row;
  const variants = parse(row.component_variants_json);
  const projected = { ...row, component_variants_json: JSON.stringify(Object.fromEntries(['native', 'en', 'zh-CN']
    .map((language) => [language, { ...variants.native, ...variants[language], ...patch[language] }]))) };
  for (const [column, field] of [['admin1', 'admin1'], ['admin1_code', 'admin1Code'], ['locality', 'locality']]) {
    if (patch.native[field] !== undefined) {
      projected[column] = patch.en?.[field] || patch.native[field];
      projected[`${column}_key`] = String(projected[column]).normalize('NFKC').toLocaleLowerCase('und').trim();
    }
  }
  return projected;
};

const identityPatch = (region, city, nativeLanguage) => Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => {
  const name = (place) => language === 'zh-CN' ? place.zh_name || place.native_name || place.name
    : language === 'native' && nativeLanguage.startsWith('zh') ? place.native_name || place.name : place.name;
  return [language, { admin1: name(region), admin1Code: region.code, ...(city ? { locality: name(city) } : {}) }];
}));

export const deriveAdministrativeAssignment = (row, regions, cities) => {
  const unresolved = (reason, status = 'unresolved') => ({ status, reason, method: 'none', regionId: null, cityId: null, patch: {} });
  const native = parse(row.component_variants_json).native || {};
  if (row.country_code === 'HK') {
    const districts = [...new Map([row.locality, native.locality].map(findHongKongDistrict).filter(Boolean).map((district) => [district.id, district])).values()];
    if (districts.length !== 1) return unresolved(districts.length ? 'conflicting_official_districts' : 'official_district_unresolved', districts.length ? 'conflict' : 'unresolved');
    const district = districts[0];
    const countryLabel = (value) => !value || ['hongkong', 'hongkongsar', '香港', '香港特别行政区', '香港特別行政區'].includes(key(value));
    const declared = [row.admin1_code, row.admin1, native.admin1Code, native.admin1]
      .filter((value) => !countryLabel(value)).map((value) => ({ region: findHongKongRegion(value),
        district: findHongKongDistrict(value) || findHongKongDistrict(legacyHongKongDistrictCodes[String(value).trim().toUpperCase()]) }));
    if (declared.some((value) => value.region && value.region.code !== district.regionCode)) return unresolved('conflicting_official_region', 'conflict');
    if (declared.some((value) => value.district && value.district.id !== district.id)) return unresolved('conflicting_official_districts', 'conflict');
    if (declared.some((value) => !value.region && !value.district)) return unresolved('official_region_unresolved');
    const parent = hongKongRegions.find((region) => region.code === district.regionCode);
    const region = regions.find((region) => Number(region.id) === parent.id && region.code === parent.code);
    const city = cities.find((city) => Number(city.id) === district.id && Number(city.region_id) === parent.id);
    if (!region || !city) return unresolved('official_catalog_unavailable');
    return { status: 'verified', reason: null, method: 'official_district_parent', regionId: region.id, cityId: city.id,
      patch: identityPatch(region, city, 'zh-HK') };
  }
  if (row.country_code === 'SG') {
    const countryLabel = (value) => !value || ['singapore', 'republicofsingapore', '新加坡', '新加坡共和国'].includes(key(value));
    const declared = [row.admin1_code, row.admin1, native.admin1Code, native.admin1].filter((value) => !countryLabel(value));
    const matches = declared.map((explicit) => regions.filter((region) =>
      [region.code, region.name, region.native_name, region.zh_name].some((value) => key(value) === key(explicit))));
    if (matches.some((matched) => matched.length > 1)) return unresolved('ambiguous_region', 'conflict');
    const matched = [...new Map(matches.flat().map((region) => [region.id, region])).values()];
    if (matched.length > 1) return unresolved('conflicting_official_region', 'conflict');
    if (!declared.length) return unresolved('authoritative_boundary_unavailable');
    if (matches.some((matched) => !matched.length)) return unresolved('official_region_unresolved');
    const region = matched[0];
    // Town membership alone is not CDC evidence. Only the explicit source region is projected.
    return { status: 'verified', reason: null, method: 'source_region_identity', regionId: region.id, cityId: null,
      patch: identityPatch(region, null, 'en') };
  }
  return unresolved('unsupported_reference');
};

export const refreshAdministrativeAssignments = async (database, country, { addressIds, signal } = {}) => {
  if (!['HK', 'SG'].includes(country) || addressIds?.length === 0) return 0;
  const [regions, cities] = await Promise.all([
    database.prepare('SELECT id,code,name,native_name,zh_name FROM catalog_regions WHERE country_code=? ORDER BY id').bind(country).all(),
    database.prepare('SELECT id,region_id,name,native_name,zh_name FROM catalog_cities WHERE country_code=? ORDER BY id').bind(country).all()
  ]);
  const reference = `${country}-administrative-v1:${createHash('sha256').update(JSON.stringify([regions.results, cities.results])).digest('hex')}`;
  let cursor = '';
  let changed = 0;
  for (;;) {
    signal?.throwIfAborted();
    const rows = (await database.prepare(`SELECT address.*,${administrativeInputSql('address')} AS current_input_hash,
        administrative.input_hash AS previous_input_hash,administrative.reference_version
      FROM address_pool address LEFT JOIN address_administrative_assignments administrative ON administrative.address_id=address.id
      WHERE address.country_code=? AND address.id>?${addressIds ? ` AND address.id IN (${addressIds.map(() => '?').join(',')})` : ''}
      ORDER BY address.id LIMIT 500`).bind(country, cursor, ...(addressIds || [])).all()).results;
    const changedRows = rows.filter((row) => row.previous_input_hash !== row.current_input_hash || row.reference_version !== reference);
    await database.batch(changedRows.map((row) => {
      const assignment = deriveAdministrativeAssignment(row, regions.results, cities.results);
      return database.prepare(`INSERT INTO address_administrative_assignments(address_id,country_code,region_id,city_id,
          reference_version,input_hash,method,status,reason,patch_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(address_id) DO UPDATE SET region_id=excluded.region_id,city_id=excluded.city_id,
          reference_version=excluded.reference_version,input_hash=excluded.input_hash,method=excluded.method,
          status=excluded.status,reason=excluded.reason,patch_json=excluded.patch_json,updated_at=excluded.updated_at`)
        .bind(row.id, country, assignment.regionId, assignment.cityId, reference, row.current_input_hash,
          assignment.method, assignment.status, assignment.reason, JSON.stringify(assignment.patch), new Date().toISOString());
    }));
    changed += changedRows.length;
    if (rows.length < 500) break;
    cursor = rows.at(-1).id;
  }
  if (changed) await database.prepare(`INSERT INTO address_pool_revisions(kind,version) VALUES ('administrative',?)
    ON CONFLICT(kind) DO UPDATE SET version=excluded.version`).bind(new Date().toISOString()).run();
  return changed;
};
