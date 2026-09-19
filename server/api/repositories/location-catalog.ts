import { pinyin } from 'pinyin-pro';
import type { CountryCode, LocationOption } from '../../../src/domain/types';
import type { Database } from '../../database/database.mjs';
import { chinaCommunityPublicationClause } from './china-community';
import { catalogDescendantClause, catalogId, cityAliases, findRegion, loadCatalogRegions, regionAliasResolver, resolveCatalogTarget } from './address-repository';
import { aliasClauseValues, poolLocationAliases } from './address-pool-v2';

export type CatalogField = 'region' | 'city' | 'district' | 'postcode';

export interface CatalogQuery {
  country: CountryCode;
  field: CatalogField;
  query?: string;
  region?: string;
  regionId?: string;
  cityId?: string;
  city?: string;
  residential?: boolean;
  cursor?: string;
  limit?: number;
}

export interface CatalogPage {
  options: LocationOption[];
  total: number;
  availableTotal: number;
  nextCursor?: string;
  revision?: string;
  source: 'postgres';
}

interface RegionRow {
  id: number;
  parent_id: number | null;
  code: string;
  name: string;
  native_name: string;
  zh_name: string;
}

interface CityRow {
  id: number;
  region_id: number | null;
  name: string;
  native_name: string;
  zh_name: string;
  region_name: string | null;
  region_native_name: string | null;
  region_zh_name: string | null;
  region_code: string | null;
}

interface PostcodeRow {
  address_count: number;
  city_count: number;
  region_count: number;
  id: number | null;
  city_id: number | null;
  code: string;
  locality_name: string;
  city_name: string | null;
  city_native_name: string | null;
  city_zh_name: string | null;
  region_id: number | null;
  region_name: string | null;
  region_native_name: string | null;
  region_zh_name: string | null;
  region_code: string | null;
}

interface ChinaProvinceAvailabilityRow { province: string; address_count: number }
interface GenerationLocationGroup {
  admin1_key: string; admin1_code_key: string; locality_key: string; postal_locality_key: string; address_count: number;
}

const PAGE_SIZE = 100;
const normalizeLimit = (value = PAGE_SIZE, maximum = 200): number => {
  const parsed = Number.isFinite(value) ? Math.trunc(value) : PAGE_SIZE;
  return Math.max(20, Math.min(maximum, parsed));
};
const normalizeOffset = (cursor?: string): number => Math.max(0, Number.parseInt(cursor || '0', 10) || 0);
const searchPattern = (query?: string): string => `%${(query || '').trim().toLocaleLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
const page = <T,>(rows: T[], total: number, offset: number): { rows: T[]; nextCursor?: string } => ({
  rows, nextCursor: offset + rows.length < total ? String(offset + rows.length) : undefined
});
const generationLocations = async (db: Database, input: CatalogQuery): Promise<GenerationLocationGroup[]> =>
  (await db.prepare(`SELECT admin1_key,admin1_code_key,locality_key,postal_locality_key,COUNT(*) AS address_count
    FROM address_generation_index WHERE country_code=? AND active=1${input.residential ? ' AND residential_ready=1' : ''}
    GROUP BY admin1_key,admin1_code_key,locality_key,postal_locality_key`)
    .bind(input.country).all<GenerationLocationGroup>()).results;
const regionMatches = (group: GenerationLocationGroup, names: string[]): boolean =>
  !names.length || names.includes(group.admin1_key) || names.includes(group.admin1_code_key);
const selectedRegion = async (db: Database, input: CatalogQuery): Promise<number | undefined> => {
  if (input.regionId && !catalogId(input.regionId)) return undefined;
  return findRegion(db, input.country, input.region, catalogId(input.regionId));
};

const regionLabel = (row: RegionRow, country: CountryCode): string => {
  if (country === 'CN') return row.zh_name;
  const abbreviation = row.code && ['US', 'CA', 'AU', 'BR', 'IN', 'MX', 'NG'].includes(country) ? `（${row.code}）` : '';
  const translated = row.zh_name && row.zh_name !== row.name ? row.zh_name : '';
  return `${row.name}${abbreviation}${translated ? ` ${translated}` : ''}`;
};

const cityLabel = (row: CityRow, country: CountryCode): string => {
  if (['CN', 'HK', 'TW'].includes(country)) return row.native_name || row.zh_name || row.name;
  const seen = new Set<string>();
  return [row.native_name, row.name, row.zh_name].filter((value) => {
    const key = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(' · ');
};

const queryRegions = async (db: Database, input: CatalogQuery, limit: number, offset: number): Promise<CatalogPage> => {
  if (input.country === 'CN') {
    const [regionResult, availabilityResult] = await Promise.all([
      db.prepare(`SELECT id,parent_id,code,name,native_name,zh_name FROM catalog_regions
        WHERE country_code=? AND parent_id IS NULL ORDER BY name`).bind('CN').all<RegionRow>(),
      db.prepare(`SELECT community.province,COUNT(community.id) AS address_count
        FROM cn_communities_v2 community WHERE ${chinaCommunityPublicationClause('community')}
        GROUP BY community.province`).all<ChinaProvinceAvailabilityRow>()
    ]);
    const availability = new Map((availabilityResult.results || [])
      .map((row) => [row.province.toLocaleLowerCase(), Number(row.address_count || 0)]));
    const query = (input.query || '').trim().toLocaleLowerCase();
    const unique = new Map<string, RegionRow>();
    for (const row of regionResult.results || []) {
      const key = row.name.toLocaleLowerCase();
      if (!unique.has(key)) unique.set(key, row);
    }
    const matching = [...unique.values()].filter((row) => !query
      || [row.name, row.native_name, row.zh_name, row.code].some((value) => value.toLocaleLowerCase().includes(query)));
    const rows = matching.filter((row) => [row.name, row.native_name, row.zh_name].some((value) => (availability.get(value.toLocaleLowerCase()) || 0) > 0));
    const current = page(rows.slice(offset, offset + limit), rows.length, offset);
    return {
      options: current.rows.map((row) => {
        const availableCount = Math.max(...[row.name, row.native_name, row.zh_name]
          .map((value) => availability.get(value.toLocaleLowerCase()) || 0));
        return {
          value: row.zh_name || row.native_name || row.name,
          label: regionLabel(row, input.country),
          availableCount,
          disabled: Boolean(input.residential) && availableCount === 0,
          id: String(row.id),
           parentId: row.parent_id == null ? undefined : String(row.parent_id),
           regionCode: row.code || undefined,
           native: row.native_name,
          en: row.name,
          zhCN: row.zh_name
        };
      }),
      total: rows.length,
      availableTotal: matching.filter((row) => [row.name, row.native_name, row.zh_name]
        .some((value) => (availability.get(value.toLocaleLowerCase()) || 0) > 0)).length,
      nextCursor: current.nextCursor,
      source: 'postgres'
    };
  }
  const [catalog, groups] = await Promise.all([
    loadCatalogRegions(db, input.country),
    generationLocations(db, input)
  ]);
  const regionNames = regionAliasResolver(catalog);
  const query = (input.query || '').trim().toLocaleLowerCase();
  const unique = new Map<string, RegionRow & { availableCount: number }>();
  for (const row of catalog.filter((row) => row.parent_id == null)) {
    if (query && ![row.name, row.native_name, row.zh_name, row.code].some((value) => value.toLocaleLowerCase().includes(query))) continue;
    const names = poolLocationAliases(regionNames(row.id));
    const availableCount = groups.reduce((count, group) => count + (regionMatches(group, names) ? Number(group.address_count) : 0), 0);
    const key = row.name.toLocaleLowerCase();
    if (availableCount && !unique.has(key)) unique.set(key, { ...row, availableCount });
  }
  const rows = [...unique.values()];
  const current = page(rows.slice(offset, offset + limit), rows.length, offset);
  return {
    options: current.rows.map((row) => ({
      value: row.name, label: regionLabel(row, input.country), availableCount: row.availableCount, disabled: false,
      id: String(row.id), regionCode: row.code || undefined, native: row.native_name, en: row.name, zhCN: row.zh_name
    })),
    total: rows.length, availableTotal: rows.length, nextCursor: current.nextCursor, source: 'postgres'
  };
};

const queryCities = async (db: Database, input: CatalogQuery, limit: number, offset: number): Promise<CatalogPage> => {
  const regionId = await selectedRegion(db, input);
  if ((input.region || input.regionId) && regionId === undefined) return emptyPage;
  const scope = regionId === undefined ? '' : `AND c.region_id IN (
    SELECT child.id FROM catalog_regions selected JOIN catalog_regions child
      ON child.country_code=selected.country_code AND ${catalogDescendantClause}
    WHERE selected.id=?)`;
  const [catalog, groups, regionRows] = await Promise.all([
    db.prepare(`SELECT c.id, c.region_id, c.name, c.native_name, c.zh_name,
      r.name AS region_name,r.native_name AS region_native_name,r.zh_name AS region_zh_name,r.code AS region_code
      FROM catalog_cities c LEFT JOIN catalog_regions r ON r.id=c.region_id
      WHERE c.country_code=? ${scope} ORDER BY COALESCE(c.population,0) DESC,c.name,c.id`)
      .bind(input.country, ...(regionId === undefined ? [] : [regionId])).all<CityRow>(),
    generationLocations(db, input), loadCatalogRegions(db, input.country)
  ]);
  const regionNames = regionAliasResolver(regionRows);
  const byCity = new Map<string, Set<GenerationLocationGroup>>();
  for (const group of groups) for (const key of new Set([group.locality_key, group.postal_locality_key])) {
    if (!key) continue;
    const matches = byCity.get(key) || new Set<GenerationLocationGroup>();
    matches.add(group); byCity.set(key, matches);
  }
  const query = (input.query || '').trim().toLocaleLowerCase();
  const unique = new Map<string, CityRow & { availableCount: number }>();
  for (const row of catalog.results) {
    if (query && ![row.name, row.native_name, row.zh_name].some((value) => value.toLocaleLowerCase().includes(query))) continue;
    const regions = poolLocationAliases(row.region_id == null ? [] : regionNames(row.region_id, true));
    const matches = new Set<GenerationLocationGroup>();
    for (const name of poolLocationAliases(cityAliases(row.name, row.native_name, row.zh_name))) {
      for (const group of byCity.get(name) || []) if (regionMatches(group, regions)) matches.add(group);
    }
    const availableCount = [...matches].reduce((sum, group) => sum + Number(group.address_count), 0);
    const key = `${row.name.toLocaleLowerCase()}:${(row.region_name || row.region_code || '').toLocaleLowerCase()}`;
    if (availableCount && !unique.has(key)) unique.set(key, { ...row, availableCount });
  }
  const rows = [...unique.values()];
  const current = page(rows.slice(offset, offset + limit), rows.length, offset);
  return {
    options: current.rows.map((row) => ({
      value: row.name, label: cityLabel(row, input.country), availableCount: row.availableCount, disabled: false,
      id: String(row.id), parentId: row.region_id == null ? undefined : String(row.region_id),
      parentValue: row.region_name || undefined,
      parentLabel: row.region_name ? regionLabel({
        id: row.region_id || 0, parent_id: null, code: row.region_code || '', name: row.region_name,
        native_name: row.region_native_name || row.region_name, zh_name: row.region_zh_name || row.region_name
      }, input.country) : undefined,
      regionId: row.region_id == null ? undefined : String(row.region_id), regionValue: row.region_name || undefined,
      regionCode: row.region_code || undefined, native: row.native_name, en: row.name, zhCN: row.zh_name
    })),
    total: rows.length, availableTotal: rows.length, nextCursor: current.nextCursor, source: 'postgres'
  };
};

interface DistrictRow { district: string; address_count: number }

const emptyPage: CatalogPage = { options: [], total: 0, availableTotal: 0, source: 'postgres' };

// --- China community-backed city options -----------------------------------
// The dr5hn catalog models CN unreliably (districts listed as cities, "X" and
// "X Shi" duplicates, mistranslated zh names), so CN city options are served
// from the published communities themselves and only mapped back to catalog
// ids so the /v1/generate catalog gate keeps working.

interface ChinaCityGroupRow { province: string; city: string; address_count: number }
interface ChinaCatalogCityRow { id: number; region_id: number | null; name: string; native_name: string; zh_name: string; population: number | null }
interface ChinaRegionRow { id: number; code: string; name: string; native_name: string; zh_name: string }

export const CN_SYNTHETIC_CITY_PREFIX = 'cn-city-';
export const CN_SYNTHETIC_DISTRICT_PREFIX = 'cn-district-';
const cnEthnicPrefectureSuffix = /(?:[一-鿿]{1,8}族)*自治[州县縣旗]$/u;
const cnCitySuffix = /(?:地区|地區|林区|林區|新区|新區|盟|市)$/u;
const cnCityStem = (value: string): string => {
  const stemmed = (value || '').replace(cnEthnicPrefectureSuffix, '').replace(cnCitySuffix, '');
  return stemmed || (value || '');
};
const romanizeChinese = (value: string): string => pinyin(value, { toneType: 'none', type: 'array', nonZh: 'consecutive' })
  .map((part) => part.trim()).filter(Boolean).join(' ').replace(/^\p{Ll}/u, (first) => first.toUpperCase());
const syntheticCityId = (city: string): string => `${CN_SYNTHETIC_CITY_PREFIX}${Buffer.from(city, 'utf8').toString('hex')}`;
export const decodeSyntheticCityId = (id: string | undefined): string | undefined => {
  if (!id?.startsWith(CN_SYNTHETIC_CITY_PREFIX)) return undefined;
  const hex = id.slice(CN_SYNTHETIC_CITY_PREFIX.length);
  if (!/^[0-9a-f]+$/u.test(hex) || hex.length % 2 !== 0) return undefined;
  const value = Buffer.from(hex, 'hex').toString('utf8');
  return value.trim() && Buffer.from(value, 'utf8').toString('hex') === hex ? value : undefined;
};
const syntheticDistrictId = (district: string): string => `${CN_SYNTHETIC_DISTRICT_PREFIX}${Buffer.from(district, 'utf8').toString('hex')}`;
export const decodeSyntheticDistrictId = (id: string | undefined): string | undefined => {
  if (!id?.startsWith(CN_SYNTHETIC_DISTRICT_PREFIX)) return undefined;
  const hex = id.slice(CN_SYNTHETIC_DISTRICT_PREFIX.length);
  if (!/^[0-9a-f]+$/u.test(hex) || hex.length % 2 !== 0) return undefined;
  const value = Buffer.from(hex, 'hex').toString('utf8');
  return value.trim() && Buffer.from(value, 'utf8').toString('hex') === hex ? value : undefined;
};
const searchableKey = (value: string): string => (value || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase().replace(/[\s\-'･·]/g, '');

const chinaRegions = async (db: Database): Promise<ChinaRegionRow[]> =>
  (await db.prepare(`SELECT id, code, name, native_name, zh_name FROM catalog_regions WHERE country_code = ? AND parent_id IS NULL`)
    .bind('CN').all<ChinaRegionRow>()).results || [];

const stripProvinceSuffix = (value: string): string => (value || '').replace(/省$/u, '');

const matchChinaRegion = (regions: ChinaRegionRow[], regionId?: string, region?: string): ChinaRegionRow | undefined => {
  const id = Number.parseInt(regionId || '', 10);
  if (Number.isFinite(id)) return regions.find((row) => Number(row.id) === id);
  const needle = (region || '').trim().toLocaleLowerCase();
  if (!needle) return undefined;
  const stripped = stripProvinceSuffix(needle);
  return regions.find((row) => [row.name, row.native_name, row.zh_name].some((name) => {
    const lowered = (name || '').toLocaleLowerCase();
    return lowered === needle || stripProvinceSuffix(lowered) === stripped;
  }));
};

const chinaCatalogCandidates = async (db: Database, cities: string[]): Promise<Map<string, ChinaCatalogCityRow[]>> => {
  const byStem = new Map<string, ChinaCatalogCityRow[]>();
  const variants = [...new Set(cities.flatMap((city) => {
    const stem = cnCityStem(city);
    return [city, stem, `${stem}市`, `${stem}地区`, `${stem}盟`];
  }))].filter(Boolean);
  const seen = new Set<number>();
  for (let index = 0; index < variants.length; index += 300) {
    const chunk = variants.slice(index, index + 300);
    const placeholders = chunk.map(() => '?').join(',');
    const found = (await db.prepare(`SELECT c.id, c.region_id, c.name, c.native_name, c.zh_name, c.population
      FROM catalog_cities c WHERE c.country_code = ?
      AND (c.name IN (${placeholders}) OR c.native_name IN (${placeholders}) OR c.zh_name IN (${placeholders}))`)
      .bind('CN', ...chunk, ...chunk, ...chunk).all<ChinaCatalogCityRow>()).results || [];
    for (const candidate of found) {
      if (seen.has(Number(candidate.id))) continue;
      seen.add(Number(candidate.id));
      for (const stem of new Set([cnCityStem(candidate.native_name), cnCityStem(candidate.zh_name)].filter(Boolean))) {
        byStem.set(stem, [...(byStem.get(stem) || []), candidate]);
      }
    }
  }
  return byStem;
};

const pickChinaCatalogCity = (
  candidatesByStem: Map<string, ChinaCatalogCityRow[]>,
  city: string,
  province: ChinaRegionRow | undefined
): ChinaCatalogCityRow | undefined => {
  const candidates = candidatesByStem.get(cnCityStem(city)) || [];
  if (!candidates.length) return undefined;
  const score = (candidate: ChinaCatalogCityRow): number =>
    (candidate.native_name === city || candidate.zh_name === city ? 4 : 0)
    + (province && Number(candidate.region_id) === Number(province.id) ? 2 : 0);
  return [...candidates].sort((left, right) => score(right) - score(left)
    || Number(right.population || 0) - Number(left.population || 0)
    || Number(left.id) - Number(right.id))[0];
};

const chinaMunicipalityProxy = async (
  db: Database,
  province: ChinaRegionRow | undefined,
  row: ChinaCityGroupRow
): Promise<ChinaCatalogCityRow | undefined> => {
  if (!province || cnCityStem(row.city) !== cnCityStem(row.province)) return undefined;
  return await db.prepare(`SELECT c.id, c.region_id, c.name, c.native_name, c.zh_name, c.population
    FROM catalog_cities c WHERE c.country_code = ? AND c.region_id = ?
    ORDER BY COALESCE(c.population, 0) DESC LIMIT 1`)
    .bind('CN', province.id).first<ChinaCatalogCityRow>() || undefined;
};

const queryChinaCities = async (db: Database, input: CatalogQuery, limit: number, offset: number): Promise<CatalogPage> => {
  const regions = await chinaRegions(db);
  const scoped = Boolean((input.regionId || '').trim() || (input.region || '').trim());
  const regionRow = matchChinaRegion(regions, input.regionId, input.region);
  if (scoped && !regionRow) return emptyPage;
  const clauses = [chinaCommunityPublicationClause('community'), `community.city <> ''`];
  const bindings: unknown[] = [];
  if (regionRow) {
    clauses.push(`(community.province IN (?,?,?) OR REPLACE(community.province,'省','') IN (?,?,?))`);
    bindings.push(regionRow.name, regionRow.native_name, regionRow.zh_name,
      stripProvinceSuffix(regionRow.name), stripProvinceSuffix(regionRow.native_name), stripProvinceSuffix(regionRow.zh_name));
  }
  const grouped = (await db.prepare(`SELECT community.province AS province, community.city AS city, COUNT(community.id) AS address_count
    FROM cn_communities_v2 community WHERE ${clauses.join(' AND ')}
    GROUP BY community.province, community.city`).bind(...bindings).all<ChinaCityGroupRow>()).results || [];
  if (!grouped.length) return emptyPage;

  const candidatesByStem = await chinaCatalogCandidates(db, grouped.map((row) => row.city));
  const regionByName = new Map<string, ChinaRegionRow>();
  for (const region of regions) {
    for (const name of [region.name, region.native_name, region.zh_name]) {
      if (name) regionByName.set(name.toLocaleLowerCase(), region);
    }
  }

  const entries = grouped.map((row) => {
    const province = regionByName.get(row.province.toLocaleLowerCase());
    const catalogCity = pickChinaCatalogCity(candidatesByStem, row.city, province);
    return { row, province, catalogCity, en: catalogCity?.name || romanizeChinese(row.city) };
  });
  const needle = searchableKey(input.query || '');
  const filtered = entries
    .filter((entry) => !needle || [entry.row.city, cnCityStem(entry.row.city), entry.en].some((value) => searchableKey(value).includes(needle)))
    .sort((left, right) => right.row.address_count - left.row.address_count
      || left.row.city.localeCompare(right.row.city, 'zh-CN'));
  const total = filtered.length;
  const slice = filtered.slice(offset, offset + limit);

  const options: LocationOption[] = [];
  for (const entry of slice) {
    const catalogCity = entry.catalogCity || await chinaMunicipalityProxy(db, entry.province, entry.row);
    const availableCount = Number(entry.row.address_count || 0);
    options.push({
      value: entry.row.city,
      label: entry.row.city,
      availableCount,
      disabled: Boolean(input.residential) && availableCount === 0,
      id: catalogCity ? String(catalogCity.id) : syntheticCityId(entry.row.city),
      parentId: entry.province ? String(entry.province.id) : undefined,
      parentValue: entry.province?.zh_name || entry.row.province,
      parentLabel: entry.province?.zh_name || entry.row.province,
      regionId: entry.province ? String(entry.province.id) : undefined,
      regionValue: entry.province?.zh_name || entry.row.province,
      regionCode: entry.province?.code || undefined,
      native: entry.row.city,
      en: entry.en,
      zhCN: entry.row.city
    });
  }
  return {
    options,
    total,
    availableTotal: total,
    nextCursor: offset + options.length < total ? String(offset + options.length) : undefined,
    source: 'postgres'
  };
};

// China is the only country with a served district level; its published
// communities are the authoritative catalog, so every option has coverage
// and an uncovered district can never be selected (exact-or-empty rule).
const queryDistricts = async (db: Database, input: CatalogQuery, limit: number, offset: number): Promise<CatalogPage> => {
  if (input.country !== 'CN') return emptyPage;
  const clauses = [chinaCommunityPublicationClause('community'), `community.district <> ''`];
  const bindings: unknown[] = [];
  const regionId = Number.parseInt(input.regionId || '', 10);
  if (Number.isFinite(regionId)) {
    clauses.push(`community.province IN (SELECT name FROM catalog_regions WHERE id = ?
      UNION SELECT native_name FROM catalog_regions WHERE id = ?
      UNION SELECT zh_name FROM catalog_regions WHERE id = ?)`);
    bindings.push(regionId, regionId, regionId);
  } else if (input.region?.trim()) {
    clauses.push(`(community.province = ? OR REPLACE(community.province,'省','') = REPLACE(?,'省',''))`);
    bindings.push(input.region.trim(), input.region.trim());
  }
  const syntheticCity = decodeSyntheticCityId(input.cityId);
  const cityId = Number.parseInt(input.cityId || '', 10);
  if (syntheticCity) {
    clauses.push(`(community.city = ? OR REPLACE(community.city,'市','') = REPLACE(?,'市',''))`);
    bindings.push(syntheticCity, syntheticCity);
  } else if (Number.isFinite(cityId)) {
    // Suffix tolerance: the catalog stores 北京/唐山 while communities store
    // 北京市/唐山市. Municipality proxies (Shanghai has no city-proper catalog
    // row) resolve through their parent region instead.
    clauses.push(`(community.city IN (SELECT name FROM catalog_cities WHERE id = ?
        UNION SELECT native_name FROM catalog_cities WHERE id = ?
        UNION SELECT zh_name FROM catalog_cities WHERE id = ?)
      OR REPLACE(community.city,'市','') IN (SELECT REPLACE(name,'市','') FROM catalog_cities WHERE id = ?
        UNION SELECT REPLACE(native_name,'市','') FROM catalog_cities WHERE id = ?
        UNION SELECT REPLACE(zh_name,'市','') FROM catalog_cities WHERE id = ?)
      OR (community.city = community.province AND community.province IN (
        SELECT region.name FROM catalog_regions region JOIN catalog_cities city_ref ON city_ref.region_id = region.id WHERE city_ref.id = ?
        UNION SELECT region.native_name FROM catalog_regions region JOIN catalog_cities city_ref ON city_ref.region_id = region.id WHERE city_ref.id = ?
        UNION SELECT region.zh_name FROM catalog_regions region JOIN catalog_cities city_ref ON city_ref.region_id = region.id WHERE city_ref.id = ?)))`);
    bindings.push(cityId, cityId, cityId, cityId, cityId, cityId, cityId, cityId, cityId);
  }
  clauses.push(`LOWER(community.district) LIKE ? ESCAPE '\\'`);
  bindings.push(searchPattern(input.query));
  const where = clauses.join(' AND ');
  const count = await db.prepare(`SELECT COUNT(DISTINCT community.district) AS total
    FROM cn_communities_v2 community WHERE ${where}`).bind(...bindings).first<{ total: number }>();
  const result = await db.prepare(`SELECT community.district AS district, COUNT(community.id) AS address_count
    FROM cn_communities_v2 community WHERE ${where}
    GROUP BY community.district ORDER BY community.district LIMIT ? OFFSET ?`)
    .bind(...bindings, limit, offset).all<DistrictRow>();
  const total = Number(count?.total || 0);
  const current = page(result.results || [], total, offset);
  return {
    options: current.rows.map((row) => {
      const availableCount = Number(row.address_count || 0);
      return {
        id: syntheticDistrictId(row.district), value: row.district, label: row.district, availableCount,
        disabled: input.residential && availableCount === 0,
        native: row.district, en: row.district, zhCN: row.district
      };
    }),
    total,
    availableTotal: total,
    nextCursor: current.nextCursor,
    source: 'postgres'
  };
};

const queryPostcodes = async (db: Database, input: CatalogQuery, limit: number, offset: number): Promise<CatalogPage> => {
  const hasParent = Boolean(input.region || input.regionId || input.city || input.cityId);
  const target = hasParent ? await resolveCatalogTarget(db, input.country, input, 'catalog-options') : undefined;
  if (hasParent && !target) return emptyPage;
  const clauses = ['country_code=?', 'active=1', "postcode_key<>''"];
  const generationBindings: unknown[] = [input.country];
  if (input.residential) clauses.push('residential_ready=1');
  const regionClause = aliasClauseValues(['admin1_key', 'admin1_code_key'],
    poolLocationAliases([input.region, ...target?.regionAliases || []]));
  if (regionClause) {
    clauses.push(regionClause.sql);
    generationBindings.push(...regionClause.values);
  }
  const cityClause = aliasClauseValues(['locality_key', 'postal_locality_key'],
    poolLocationAliases([input.city, ...target?.cityAliases || []]));
  if (cityClause) {
    clauses.push(cityClause.sql);
    generationBindings.push(...cityClause.values);
  }
  const where = ['p.country_code=?'];
  const bindings: unknown[] = [input.country];
  if (target?.regionId) {
    where.push(`COALESCE(p.region_id,c.region_id) IN (SELECT child.id FROM catalog_regions selected
      JOIN catalog_regions child ON child.country_code=selected.country_code
        AND ${catalogDescendantClause} WHERE selected.id=?)`);
    bindings.push(target.regionId);
  }
  if (target?.cityId) {
    where.push(`(p.city_id=? OR LOWER(p.locality_name) IN (SELECT LOWER(name) FROM catalog_cities WHERE id=?
      UNION SELECT LOWER(native_name) FROM catalog_cities WHERE id=?))`);
    bindings.push(target.cityId, target.cityId, target.cityId);
  }
  const search = input.query?.trim()
    ? 'WHERE available.postcode_key LIKE ? OR LOWER(p.locality_name) LIKE ?' : '';
  const searchBindings = search ? [searchPattern(input.query!.replace(/\s/gu, '')), searchPattern(input.query)] : [];
  const cte = `WITH available_postcodes AS (
      SELECT postcode_key,COUNT(*) AS address_count FROM address_generation_index
      WHERE ${clauses.join(' AND ')} GROUP BY postcode_key
    ), catalog_matches AS (
      SELECT p.id,p.code,p.city_id,p.locality_name,COALESCE(p.region_id,c.region_id) AS region_id
      FROM catalog_postcodes p LEFT JOIN catalog_cities c ON c.id=p.city_id
      WHERE ${where.join(' AND ')}
    ), available_options AS (
      SELECT available.postcode_key,MIN(p.id) AS id,MAX(available.address_count) AS address_count,
        CASE WHEN COUNT(DISTINCT p.city_id)=1 AND COUNT(p.city_id)=COUNT(*) THEN 1 ELSE 0 END AS city_count,
        CASE WHEN COUNT(DISTINCT p.region_id)=1 AND COUNT(p.region_id)=COUNT(*) THEN 1 ELSE 0 END AS region_count
      FROM available_postcodes available LEFT JOIN catalog_matches p
        ON available.postcode_key=LOWER(REPLACE(p.code,' ',''))
      ${search} GROUP BY available.postcode_key
    )`;
  const values = [...generationBindings, ...bindings, ...searchBindings];
  const count = await db.prepare(`${cte} SELECT COUNT(*) AS total FROM available_options`).bind(...values).first<{ total: number }>();
  const total = Number(count?.total || 0);
  if (!total) return emptyPage;
  const result = await db.prepare(`${cte} SELECT p.id,p.city_id,COALESCE(p.code,UPPER(available.postcode_key)) AS code,p.locality_name,
      c.name AS city_name,c.native_name AS city_native_name,c.zh_name AS city_zh_name,
      COALESCE(p.region_id,c.region_id) AS region_id,r.name AS region_name,r.native_name AS region_native_name,
      r.zh_name AS region_zh_name,r.code AS region_code,available.address_count,available.city_count,available.region_count
    FROM available_options available LEFT JOIN catalog_postcodes p ON p.id=available.id
    LEFT JOIN catalog_cities c ON c.id=p.city_id LEFT JOIN catalog_regions r ON r.id=COALESCE(p.region_id,c.region_id)
    ORDER BY available.postcode_key,available.id LIMIT ? OFFSET ?`).bind(...values, limit, offset).all<PostcodeRow>();
  const current = page(result.results || [], total, offset);
  return {
    options: current.rows.map((row) => {
      const cityKnown = Number(row.city_count) === 1;
      const regionKnown = Number(row.region_count) === 1;
      return {
        value: row.code, label: [row.code, cityKnown && row.locality_name, regionKnown && row.region_name].filter(Boolean).join(' · '),
        availableCount: Number(row.address_count), disabled: false, id: row.id == null ? undefined : String(row.id),
        parentId: cityKnown && row.city_id != null ? String(row.city_id) : undefined,
        parentValue: cityKnown ? row.city_name || row.locality_name || undefined : undefined,
        parentLabel: cityKnown ? row.city_name || row.locality_name || undefined : undefined,
        regionId: regionKnown && row.region_id != null ? String(row.region_id) : undefined,
        regionValue: regionKnown ? row.region_name || undefined : undefined,
        regionLabel: regionKnown && row.region_name ? regionLabel({
          id: row.region_id || 0, parent_id: null, code: row.region_code || '', name: row.region_name,
          native_name: row.region_native_name || row.region_name, zh_name: row.region_zh_name || row.region_name
        }, input.country) : undefined,
        regionCode: regionKnown ? row.region_code || undefined : undefined,
        native: [row.code, cityKnown && (row.city_native_name || row.locality_name)].filter(Boolean).join(' · '),
        en: [row.code, cityKnown && (row.city_name || row.locality_name)].filter(Boolean).join(' · '),
        zhCN: [row.code, cityKnown && (row.city_zh_name || row.locality_name)].filter(Boolean).join(' · ')
      };
    }),
    total, availableTotal: total, nextCursor: current.nextCursor, source: 'postgres'
  };
};

const locationCatalogCache = new WeakMap<Database, Map<string, { expiresAt: number; promise: Promise<CatalogPage> }>>();
const catalogCacheKey = (input: CatalogQuery): string => JSON.stringify([
  input.country, input.field, input.query || '', input.region || '', input.regionId || '', input.cityId || '', input.city || '',
  Boolean(input.residential), input.cursor || '', input.limit ?? null
]);

export const invalidateLocationCatalogCache = (db: Database): void => {
  locationCatalogCache.delete(db);
};

export const queryLocationCatalog = async (db: Database, input: CatalogQuery): Promise<CatalogPage> => {
  if (input.field === 'district' && input.country !== 'CN') return { ...emptyPage, revision: '' };
  const revision = await db.prepare('SELECT version FROM address_pool_revisions WHERE kind=?')
    .bind(`generation:${input.country}`).first<string>('version');
  const key = `${catalogCacheKey(input)}:${revision || ''}`;
  let cache = locationCatalogCache.get(db);
  if (!cache) {
    cache = new Map();
    locationCatalogCache.set(db, cache);
  }
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const limit = normalizeLimit(input.limit, 200);
  const offset = normalizeOffset(input.cursor);
  const pagePromise = input.field === 'region' ? queryRegions(db, input, limit, offset)
    : input.field === 'city' ? (input.country === 'CN' ? queryChinaCities(db, input, limit, offset) : queryCities(db, input, limit, offset))
      : input.field === 'district' ? queryDistricts(db, input, limit, offset)
        : queryPostcodes(db, input, limit, offset);
  const promise = pagePromise.then((page) => ({ ...page, revision: revision || '' }));
  cache.set(key, { expiresAt: Number.POSITIVE_INFINITY, promise });
  if (cache.size > 500) {
    const now = Date.now();
    for (const [candidate, value] of cache) if (value.expiresAt <= now) cache.delete(candidate);
    while (cache.size > 500) cache.delete(cache.keys().next().value!);
  }
  void promise.then(() => {
    const current = cache?.get(key);
    if (current?.promise === promise) current.expiresAt = Date.now() + 30_000;
  }, () => {
    if (cache?.get(key)?.promise === promise) cache.delete(key);
  });
  return promise;
};

export const recordResidentialCoverage = async (
  db: Database | undefined,
  country: CountryCode,
  region: string | undefined,
  city: string | undefined,
  coordinates?: { latitude: number; longitude: number }
): Promise<void> => {
  if (!db) return;
  const now = new Date().toISOString();
  const cityName = city || '';
  let catalogLocation = await db.prepare(`SELECT c.id AS city_id, c.region_id
    FROM catalog_cities c LEFT JOIN catalog_regions r ON r.id = c.region_id
    WHERE c.country_code = ? AND (
      LOWER(c.name) = LOWER(?) OR LOWER(c.native_name) = LOWER(?) OR LOWER(c.zh_name) = LOWER(?)
      OR LOWER(REPLACE(c.name, ' City', '')) = LOWER(REPLACE(?, ' City', ''))
      OR LOWER(REPLACE(c.name, 'City of ', '')) = LOWER(REPLACE(?, 'City of ', ''))
    )
    ORDER BY CASE WHEN ? IN (r.name, r.native_name, r.zh_name) THEN 0 ELSE 1 END, COALESCE(c.population, 0) DESC LIMIT 1`)
    .bind(country, cityName, cityName, cityName, cityName, cityName, region || '').first<{ city_id: number; region_id: number | null }>();
  if (!catalogLocation && coordinates) {
    catalogLocation = await db.prepare(`SELECT id AS city_id, region_id FROM catalog_cities
      WHERE country_code = ? AND latitude IS NOT NULL AND longitude IS NOT NULL
      ORDER BY ((latitude - ?) * (latitude - ?)) + ((longitude - ?) * (longitude - ?)) LIMIT 1`)
      .bind(country, coordinates.latitude, coordinates.latitude, coordinates.longitude, coordinates.longitude)
      .first<{ city_id: number; region_id: number | null }>();
  }
  await db.prepare(`INSERT INTO residential_coverage(country_code, region_name, city_name, address_count, last_verified_at, region_id, city_id)
    VALUES (?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(country_code, region_name, city_name, identity_key) DO UPDATE SET
      address_count = address_count + 1,
      last_verified_at = excluded.last_verified_at,
      region_id = COALESCE(excluded.region_id, residential_coverage.region_id),
      city_id = COALESCE(excluded.city_id, residential_coverage.city_id)`)
    .bind(country, region || '', cityName, now, catalogLocation?.region_id || null, catalogLocation?.city_id || null).run();
  invalidateLocationCatalogCache(db);
};
