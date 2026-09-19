import { hashSeed } from '../../../src/domain/generator';
import { Converter as createSimplifier } from 'opencc-js/t2cn';
import { Converter as createTraditionalizer } from 'opencc-js/cn2t';
import type { Database } from '../../database/database.mjs';
import type { VerifiedAddress } from '../../../src/domain/types';
import { aliasClauseValues, poolLocationAliases } from './address-pool-v2';

const toSimplifiedHan = createSimplifier({ from: 'hk', to: 'cn' });
const toTraditionalHan = createTraditionalizer({ from: 'cn', to: 'tw' });
const hanScript = /\p{Script=Han}/u;
const adminSuffix = /(?:自治区|自治區|特别行政区|特別行政區|省|市|縣|县|区|區|都|道|府|県)$/u;
// Distinct Han script/suffix variants of a place name for cross-script catalog matching.
const hanVariants = (value: string | undefined): string[] => {
  const trimmed = String(value || '').trim();
  if (!trimmed || !hanScript.test(trimmed)) return trimmed ? [trimmed] : [];
  const base = [...new Set([trimmed, toSimplifiedHan(trimmed), toTraditionalHan(trimmed)])];
  return [...new Set(base.flatMap((variant) => {
    const stem = variant.replace(adminSuffix, '');
    return stem && stem !== variant ? [variant, stem] : [variant];
  }))];
};

export interface AddressFilters {
  q?: string;
  region?: string;
  regionId?: string;
  city?: string;
  cityId?: string;
  district?: string;
  districtId?: string;
  postcode?: string;
  postcodeId?: string;
}

export interface CatalogTarget {
  coordinates?: { latitude: number; longitude: number };
  regionId?: number;
  region?: string;
  regionNative?: string;
  regionCode?: string;
  regionAliases: string[];
  cityId?: number;
  city?: string;
  cityNative?: string;
  cityAliases: string[];
  postcodeId?: number;
  postcode?: string;
  bucket: string;
}

export interface NearestCatalogTarget {
  target: CatalogTarget;
  distanceKm: number;
  matchLevel: 'city' | 'region';
}

interface TargetRow {
  id: number;
  region_id: number | null;
  city_id: number | null;
  postcode: string | null;
  city_name: string | null;
  city_native: string | null;
  city_zh: string | null;
  region_name: string | null;
  region_native: string | null;
  region_zh: string | null;
  region_code: string | null;
  latitude: number | null;
  longitude: number | null;
}

const normalize = (value: string | undefined): string => (value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

const equal = (left: string | undefined, right: string | undefined): boolean =>
  !right || normalize(left) === normalize(right);

const matchesOne = (value: string | undefined, expected: string[]): boolean => {
  const normalized = normalize(value);
  return expected.some((item) => normalize(item) === normalized);
};

const matchesAny = (values: Array<string | undefined>, expected: string[]): boolean =>
  values.some((value) => matchesOne(value, expected));

const containsQuery = (address: VerifiedAddress, query: string | undefined): boolean => {
  if (!query) return true;
  const haystack = [
    address.components.street,
    address.components.locality,
    address.components.admin1,
    address.components.postcode,
    address.addressVariants.native,
    address.addressVariants.en,
    address.addressVariants['zh-CN']
  ].map(normalize).join(' ');
  return normalize(query).split(' ').every((term) => haystack.includes(term));
};

export const filterCandidates = (
  candidates: VerifiedAddress[],
  filters: AddressFilters,
  target?: CatalogTarget
): VerifiedAddress[] => candidates.filter((address) =>
  containsQuery(address, filters.q)
  && (filters.region && target
    ? matchesAny([address.components.admin1, address.components.admin1Code], [...target.regionAliases, filters.region])
    : !filters.region || matchesAny([address.components.admin1, address.components.admin1Code], [filters.region]))
  && (filters.city && target
    ? matchesAny([
        address.components.locality,
        address.components.postalLocality,
        address.components.dependentLocality,
        address.components.district
      ], [...target.cityAliases, filters.city])
    : !filters.city || matchesAny([
        address.components.locality,
        address.components.postalLocality,
        address.components.dependentLocality,
        address.components.district
      ], [filters.city]))
  && equal(address.components.postcode.replace(/\s/g, ''), filters.postcode?.replace(/\s/g, ''))
);

const aliases = (...values: Array<string | null | undefined>): string[] => [...new Set(values.filter((value): value is string => Boolean(value)))];
export const cityAliases = (...values: Array<string | null | undefined>): string[] => {
  const result = aliases(...values);
  return aliases(...result, ...result.map((value) => value.replace(/\s+City$/i, '').replace(/^City of\s+/i, '')));
};

const toTarget = (row: TargetRow, kind: string): CatalogTarget | undefined => {
  return {
    coordinates: row.latitude == null || row.longitude == null ? undefined : { latitude: row.latitude, longitude: row.longitude },
    regionId: row.region_id || undefined,
    region: row.region_name || undefined,
    regionNative: row.region_native || undefined,
    regionCode: row.region_code || undefined,
    regionAliases: aliases(row.region_name, row.region_native, row.region_zh, row.region_code),
    cityId: row.city_id || undefined,
    city: row.city_name || undefined,
    cityNative: row.city_native || undefined,
    cityAliases: cityAliases(row.city_name, row.city_native, row.city_zh),
    postcodeId: kind === 'postcode' ? row.id : undefined,
    postcode: row.postcode || undefined,
    bucket: `${kind}-${row.id}`
  };
};

export const catalogId = (value: string | undefined): number | undefined => {
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
};

export interface CatalogRegion {
  id: number; parent_id: number | null; code: string; name: string; native_name: string; zh_name: string;
}

export const loadCatalogRegions = async (db: Database, country: string): Promise<CatalogRegion[]> =>
  (await db.prepare(`SELECT id,parent_id,code,name,native_name,zh_name FROM catalog_regions
    WHERE country_code=? ORDER BY name,id`).bind(country).all<CatalogRegion>()).results;

export const regionAliasResolver = (rows: CatalogRegion[]) => {
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  const children = new Map<number, number[]>();
  for (const row of rows) if (row.parent_id != null) {
    const parent = Number(row.parent_id);
    children.set(parent, [...children.get(parent) || [], Number(row.id)]);
  }
  const cache = new Map<string, string[]>();
  return (id: number, ancestors = false): string[] => {
    const key = `${id}:${ancestors}`;
    if (cache.has(key)) return cache.get(key)!;
    const names = new Set<string>();
    const seen = new Set<number>();
    const pending = [Number(id)];
    while (pending.length) {
      const next = pending.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      const row = byId.get(next);
      if (!row) continue;
      for (const name of aliases(row.name, row.native_name, row.zh_name, row.code)) names.add(name);
      pending.push(...(ancestors ? row.parent_id == null ? [] : [Number(row.parent_id)] : children.get(next) || []));
    }
    const result = [...names]; cache.set(key, result); return result;
  };
};

export const catalogDescendantClause = `(child.id=selected.id OR child.path LIKE RTRIM(selected.path,'/') || '/%')`;

export const findRegion = async (
  db: Database,
  country: string,
  value: string | undefined,
  stableId: number | undefined
): Promise<number | undefined> => {
  if (stableId !== undefined) {
    const row = await db.prepare('SELECT r.id FROM catalog_regions r WHERE r.country_code = ? AND r.id = ? LIMIT 1')
      .bind(country, stableId).first<{ id: number }>();
    return row?.id;
  }
  if (!value) return undefined;
  const variants = hanVariants(value);
  const lowered = [...new Set([value, ...variants].map((entry) => entry.toLowerCase()))];
  const placeholders = lowered.map(() => '?').join(',');
  const rows = (await db.prepare(`SELECT r.id FROM catalog_regions r WHERE r.country_code = ?
    AND (LOWER(r.name) IN (${placeholders}) OR LOWER(r.native_name) IN (${placeholders})
      OR LOWER(r.zh_name) IN (${placeholders}) OR LOWER(r.code) IN (${placeholders}))
    ORDER BY CASE WHEN r.parent_id IS NULL THEN 0 ELSE 1 END, r.id LIMIT 2`)
    .bind(country, ...lowered, ...lowered, ...lowered, ...lowered).all<{ id: number }>()).results;
  return rows.length === 1 ? rows[0].id : undefined;
};

interface CityIdentity { id: number; region_id: number | null }

const findCity = async (
  db: Database,
  country: string,
  value: string | undefined,
  regionId: number | undefined,
  stableId: number | undefined
): Promise<CityIdentity | undefined> => {
  const regionScope = regionId === undefined ? '' : `AND c.region_id IN (
    SELECT child.id FROM catalog_regions selected JOIN catalog_regions child
      ON child.country_code=selected.country_code AND ${catalogDescendantClause} WHERE selected.id = ?
  )`;
  if (stableId !== undefined) {
    const bindings = regionId === undefined ? [country, stableId] : [country, stableId, regionId];
    return await db.prepare(`SELECT c.id, c.region_id FROM catalog_cities c
      WHERE c.country_code = ? AND c.id = ? ${regionScope} LIMIT 1`)
      .bind(...bindings).first<CityIdentity>() || undefined;
  }
  if (!value) return undefined;
  const variants = [...new Set([value, ...hanVariants(value)].map((entry) => entry.toLowerCase()))];
  const placeholders = variants.map(() => '?').join(',');
  const exactMatch = `(LOWER(c.name) IN (${placeholders}) OR LOWER(c.native_name) IN (${placeholders})
    OR LOWER(c.zh_name) IN (${placeholders}))`;
  const bindings = regionId === undefined
    ? [country, ...variants, ...variants, ...variants]
    : [country, ...variants, ...variants, ...variants, regionId];
  const rows = (await db.prepare(`SELECT c.id, c.region_id FROM catalog_cities c
    WHERE c.country_code = ? AND ${exactMatch} ${regionScope}
    ORDER BY COALESCE(c.population, 0) DESC, c.region_id, c.id LIMIT 1`)
    .bind(...bindings).all<CityIdentity>()).results;
  return rows[0];
};

const selectAtOffset = async (
  db: Database,
  countSql: string,
  selectSql: string,
  bindings: unknown[],
  seed: string
): Promise<TargetRow | undefined> => {
  const count = await db.prepare(countSql).bind(...bindings).first<{ total: number }>();
  const total = Number(count?.total || 0);
  if (!total) return undefined;
  const offset = hashSeed(seed) % total;
  return await db.prepare(`${selectSql} LIMIT 1 OFFSET ?`).bind(...bindings, offset).first<TargetRow>() || undefined;
};

const targetColumns = `c.id, c.region_id, c.id AS city_id, NULL AS postcode,
  c.name AS city_name, c.native_name AS city_native, c.zh_name AS city_zh,
  r.name AS region_name, r.native_name AS region_native, r.zh_name AS region_zh, r.code AS region_code,
  COALESCE(c.latitude, r.latitude) AS latitude, COALESCE(c.longitude, r.longitude) AS longitude`;

const distanceKm = (
  left: { latitude: number; longitude: number },
  right: { latitude: number; longitude: number }
): number => {
  const radians = Math.PI / 180;
  const latitudeDelta = (right.latitude - left.latitude) * radians;
  const longitudeDelta = (right.longitude - left.longitude) * radians;
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(left.latitude * radians) * Math.cos(right.latitude * radians) * Math.sin(longitudeDelta / 2) ** 2;
  const bounded = Math.min(1, Math.max(0, a));
  return 6371 * 2 * Math.atan2(Math.sqrt(bounded), Math.sqrt(1 - bounded));
};

export const resolveNearestCatalogTarget = async (
  db: Database,
  country: string,
  coordinates: { latitude: number; longitude: number }
): Promise<NearestCatalogTarget | undefined> => {
  const longitudeScale = Math.max(0.1, Math.cos(coordinates.latitude * Math.PI / 180));
  const citySql = `SELECT ${targetColumns},
    ((c.latitude - ?) * (c.latitude - ?)) +
    ((c.longitude - ?) * (c.longitude - ?) * ? * ?) AS distance_score
    FROM catalog_cities c LEFT JOIN catalog_regions r ON r.id = c.region_id
    WHERE c.country_code = ? AND c.latitude BETWEEN ? AND ? AND c.longitude BETWEEN ? AND ?
    ORDER BY distance_score, COALESCE(c.population, 0) DESC, c.id LIMIT 1`;
  for (const radius of [0.5, 2, 8, 180]) {
    const longitudeRadius = Math.min(180, radius / longitudeScale);
    const row = await db.prepare(citySql).bind(
      coordinates.latitude,
      coordinates.latitude,
      coordinates.longitude,
      coordinates.longitude,
      longitudeScale,
      longitudeScale,
      country,
      Math.max(-90, coordinates.latitude - radius),
      Math.min(90, coordinates.latitude + radius),
      Math.max(-180, coordinates.longitude - longitudeRadius),
      Math.min(180, coordinates.longitude + longitudeRadius)
    ).first<TargetRow>();
    const target = row ? toTarget(row, 'city') : undefined;
    if (target?.coordinates) return { target, distanceKm: distanceKm(coordinates, target.coordinates), matchLevel: 'city' };
  }

  const row = await db.prepare(`SELECT r.id, r.id AS region_id, NULL AS city_id, NULL AS postcode,
    NULL AS city_name, NULL AS city_native, NULL AS city_zh,
    r.name AS region_name, r.native_name AS region_native, r.zh_name AS region_zh, r.code AS region_code,
    r.latitude, r.longitude,
    ((r.latitude - ?) * (r.latitude - ?)) +
    ((r.longitude - ?) * (r.longitude - ?) * ? * ?) AS distance_score
    FROM catalog_regions r
    WHERE r.country_code = ? AND r.latitude IS NOT NULL AND r.longitude IS NOT NULL
    ORDER BY distance_score, r.id LIMIT 1`).bind(
    coordinates.latitude,
    coordinates.latitude,
    coordinates.longitude,
    coordinates.longitude,
    longitudeScale,
    longitudeScale,
    country
  ).first<TargetRow>();
  const target = row ? toTarget(row, 'region') : undefined;
  return target?.coordinates ? { target, distanceKm: distanceKm(coordinates, target.coordinates), matchLevel: 'region' } : undefined;
};

export const resolveCatalogTarget = async (
  db: Database,
  country: string,
  filters: AddressFilters,
  seed: string
): Promise<CatalogTarget | undefined> => {
  const requestedRegionId = catalogId(filters.regionId);
  const requestedCityId = catalogId(filters.cityId);
  const requestedPostcodeId = catalogId(filters.postcodeId);
  if ((filters.regionId && requestedRegionId === undefined)
    || (filters.cityId && requestedCityId === undefined)
    || (filters.postcodeId && requestedPostcodeId === undefined)) return undefined;

  let regionId = filters.region || requestedRegionId !== undefined
    ? await findRegion(db, country, filters.region, requestedRegionId)
    : undefined;
  if ((filters.region || requestedRegionId !== undefined) && regionId === undefined) return undefined;
  const cityIdentity = filters.city || requestedCityId !== undefined
    ? await findCity(db, country, filters.city, regionId, requestedCityId)
    : undefined;
  if ((filters.city || requestedCityId !== undefined) && !cityIdentity) return undefined;
  const cityId = cityIdentity?.id;
  regionId ??= cityIdentity?.region_id || undefined;
  const withRegionAliases = async (target: CatalogTarget | undefined): Promise<CatalogTarget | undefined> => {
    if (target?.regionId) {
      target.regionAliases = regionAliasResolver(await loadCatalogRegions(db, country))(target.regionId, Boolean(cityIdentity));
    }
    return target;
  };

  if (filters.postcode || requestedPostcodeId !== undefined) {
    const scopes: string[] = ['p.country_code = ?'];
    const bindings: unknown[] = [country];
    if (requestedPostcodeId !== undefined) {
      scopes.push('p.code = (SELECT code FROM catalog_postcodes WHERE id = ? AND country_code = ?)');
      bindings.push(requestedPostcodeId, country);
    }
    if (filters.postcode) {
      scopes.push(`LOWER(REPLACE(p.code, ' ', '')) = LOWER(?)`);
      bindings.push(filters.postcode!.replace(/\s/g, ''));
    }
    if (cityId !== undefined) {
      scopes.push(`(p.city_id = ? OR LOWER(p.locality_name) IN (
        SELECT LOWER(name) FROM catalog_cities WHERE id = ?
        UNION SELECT LOWER(native_name) FROM catalog_cities WHERE id = ?
      ))`);
      bindings.push(cityId, cityId, cityId);
    }
    if (regionId !== undefined) {
      scopes.push(`COALESCE(p.region_id,c.region_id) IN (SELECT child.id FROM catalog_regions selected JOIN catalog_regions child
        ON child.country_code=selected.country_code AND ${catalogDescendantClause} WHERE selected.id = ?)`);
      bindings.push(regionId);
    }
    const where = scopes.join(' AND ');
    const columns = `p.id, COALESCE(p.region_id, c.region_id) AS region_id, p.city_id, p.code AS postcode,
      COALESCE(c.name, p.locality_name) AS city_name, c.native_name AS city_native, c.zh_name AS city_zh,
      r.name AS region_name, r.native_name AS region_native, r.zh_name AS region_zh, r.code AS region_code,
      COALESCE(p.latitude, c.latitude, r.latitude) AS latitude, COALESCE(p.longitude, c.longitude, r.longitude) AS longitude`;
    const from = `FROM catalog_postcodes p LEFT JOIN catalog_cities c ON c.id = p.city_id LEFT JOIN catalog_regions r ON r.id = COALESCE(p.region_id, c.region_id) WHERE ${where}`;
    const row = requestedPostcodeId !== undefined
      ? await db.prepare(`SELECT ${columns} ${from} LIMIT 1`).bind(...bindings).first<TargetRow>()
      : await selectAtOffset(
        db,
        `SELECT COUNT(*) AS total ${from}`,
        `SELECT ${columns} ${from} ORDER BY p.id`,
        bindings,
        `${country}:${seed}:postcode`
      );
    let target = row ? toTarget(row, 'postcode') : undefined;
    if (!target && filters.postcode && requestedPostcodeId === undefined && country !== 'CN') {
      const parent = cityId !== undefined || regionId !== undefined
        ? await resolveCatalogTarget(db, country, {
          regionId: regionId === undefined ? undefined : String(regionId),
          cityId: cityId === undefined ? undefined : String(cityId)
        }, seed) : undefined;
      if ((cityId !== undefined || regionId !== undefined) && !parent) return undefined;
      const postcode = normalize(filters.postcode).replace(/\s/gu, '').toUpperCase();
      target = { regionAliases: [], cityAliases: [], ...parent, postcode, bucket: `postcode-${country}-${postcode}` };
    }
    if (target && !cityIdentity) {
      target.cityId = undefined; target.city = undefined; target.cityNative = undefined; target.cityAliases = [];
      if (!filters.region && requestedRegionId === undefined) {
        target.regionId = undefined; target.region = undefined; target.regionNative = undefined;
        target.regionCode = undefined; target.regionAliases = [];
      }
    }
    if (target && !cityIdentity && regionId !== undefined) target.regionId = regionId;
    target = await withRegionAliases(target);
    if (target && country !== 'CN') {
      const clauses = ['country_code=?', 'active=1', 'postcode_key=?'];
      const values: unknown[] = [country, normalize(target.postcode).replace(/\s/gu, '')];
      const regionClause = aliasClauseValues(['admin1_key', 'admin1_code_key'],
        poolLocationAliases([filters.region, ...target.regionAliases]));
      const cityClause = aliasClauseValues(['locality_key', 'postal_locality_key'],
        poolLocationAliases([filters.city, ...target.cityAliases]));
      if (regionClause) {
        clauses.push(regionClause.sql);
        values.push(...regionClause.values);
      }
      if (cityClause) {
        clauses.push(cityClause.sql);
        values.push(...cityClause.values);
      }
      const available = await db.prepare(`SELECT address_id FROM address_generation_index WHERE ${clauses.join(' AND ')} LIMIT 1`)
        .bind(...values).first();
      if (!available) return undefined;
    }
    return target;
  }

  if (cityId !== undefined) {
    const row = await db.prepare(`SELECT ${targetColumns} FROM catalog_cities c LEFT JOIN catalog_regions r ON r.id = c.region_id
      WHERE c.id = ? LIMIT 1`)
      .bind(cityId).first<TargetRow>();
    return withRegionAliases(row ? toTarget(row, 'city') : undefined);
  }

  if (regionId !== undefined) {
    const row = await db.prepare(`SELECT r.id, r.id AS region_id, NULL AS city_id, NULL AS postcode,
      NULL AS city_name, NULL AS city_native, NULL AS city_zh,
      r.name AS region_name, r.native_name AS region_native, r.zh_name AS region_zh, r.code AS region_code,
      r.latitude, r.longitude FROM catalog_regions r
      WHERE r.id = ? LIMIT 1`)
      .bind(regionId).first<TargetRow>();
    return withRegionAliases(row ? toTarget(row, 'region') : undefined);
  }

  const where = `c.country_code = ? AND COALESCE(c.population, 0) >= 5000 AND c.latitude IS NOT NULL AND c.longitude IS NOT NULL`;
  const row = await selectAtOffset(
    db,
    `SELECT COUNT(*) AS total FROM catalog_cities c WHERE ${where}`,
    `SELECT ${targetColumns} FROM catalog_cities c LEFT JOIN catalog_regions r ON r.id = c.region_id WHERE ${where} ORDER BY c.id`,
    [country],
    `${country}:${seed}:city`
  );
  if (!row) return undefined;
  return toTarget(row, 'city');
};

export const orderedCandidate = (
  candidates: VerifiedAddress[],
  seed: string,
  attempt: number
): VerifiedAddress => candidates[(hashSeed(seed) + attempt) % candidates.length];
