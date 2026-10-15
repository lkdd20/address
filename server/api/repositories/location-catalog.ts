import { createHash } from 'node:crypto';
import { pinyin } from 'pinyin-pro';
import type { CountryCode, CountryShortcutConfig, LocationOption, LocationShortcut } from '../../../src/domain/types';
import type { Database } from '../../database/database.mjs';
import { chinaCommunityPublicationClause } from './china-community';
import { chinaEnglishComponent } from '../../../src/domain/china-address-language';
import { normalizePostcode } from '../../../src/domain/address-quality.mjs';
import { catalogId, cityAliases, findRegion, loadCatalogRegions, resolveCatalogTarget, type AddressFilters, type CatalogRegion, type CatalogTarget, type LocationScopeClause } from './address-repository';
import { assignRegions, pairKey, type AdminPair } from './location-assignment';
import { foldName, nameVariants, regionSpellingKey } from '../../../src/domain/region-names.mjs';
import { usTerritories } from '../../sync/administrative-names.mjs';
import { poolLocationAliases, scopeGroupMatches } from './address-pool-v2';

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

type CityNames = { name: string; native_name: string; zh_name: string };

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

interface GenerationLocationGroup {
  admin1_key: string; admin1_code_key: string; locality_key: string; postal_locality_key: string; address_count: number;
}

const PAGE_SIZE = 100;
const normalizeLimit = (value = PAGE_SIZE, maximum = 200): number => {
  const parsed = Number.isFinite(value) ? Math.trunc(value) : PAGE_SIZE;
  return Math.max(20, Math.min(maximum, parsed));
};
const normalizeOffset = (cursor?: string): number => Math.max(0, Number.parseInt(cursor || '0', 10) || 0);
const lowerKey = (value: string | null | undefined): string => (value || '').trim().toLocaleLowerCase();
const regionLabel = (row: RegionRow, country: CountryCode): string => {
  if (country === 'CN') return row.zh_name;
  const abbreviation = row.code && ['US', 'CA', 'AU', 'BR', 'IN', 'MX', 'NG'].includes(country) ? `（${row.code}）` : '';
  const translated = row.zh_name && row.zh_name !== row.name ? row.zh_name : '';
  return `${row.name}${abbreviation}${translated ? ` ${translated}` : ''}`;
};

const cityLabel = (row: CityNames, country: CountryCode): string => {
  if (['CN', 'HK', 'TW'].includes(country)) return row.native_name || row.zh_name || row.name;
  const seen = new Set<string>();
  return [row.native_name, row.name, row.zh_name].filter((value) => {
    const key = value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(' · ');
};

const emptyPage: CatalogPage = { options: [], total: 0, availableTotal: 0, source: 'postgres' };

// --- Per-country option snapshots ------------------------------------------------
// Grouping a country's published addresses takes seconds, so each country's complete option lists are built
// once and every request only filters, scopes and pages them. A snapshot is rebuilt in the background when it
// is older than the TTL, or when publication has changed and the snapshot is old enough; requests meanwhile
// keep receiving the previous snapshot. Background rebuilds run one at a time so a burst of stale countries does not
// starve requests, and builds hand the event loop back between chunks of work.

const SNAPSHOT_TTL_MS = 10 * 60_000;
const SNAPSHOT_MIN_REBUILD_MS = 2 * 60_000;

interface SnapshotEntry { revision: string; builtAt: number; value?: unknown; pending?: Promise<unknown>; queued?: boolean }
const snapshotStore = new WeakMap<Database, Map<string, SnapshotEntry>>();
let backgroundRebuilds: Promise<unknown> = Promise.resolve();
const pauser = (sliceMs = 8): (() => Promise<void>) => {
  let started = performance.now();
  return async () => {
    if (performance.now() - started < sliceMs) return;
    await new Promise((resolveYield) => setImmediate(resolveYield));
    started = performance.now();
  };
};

const loadSnapshot = async <T,>(db: Database, key: string, revision: string, build: () => Promise<T>): Promise<{ value: T; revision: string }> => {
  let store = snapshotStore.get(db);
  if (!store) { store = new Map(); snapshotStore.set(db, store); }
  const entries = store;
  const entry = entries.get(key);
  const rebuild = (): Promise<T> => {
    const pending: Promise<T> = build().then((value) => {
      if (entries.get(key)?.pending === pending) entries.set(key, { revision, builtAt: Date.now(), value });
      return value;
    }, (error: unknown) => {
      const current = entries.get(key);
      if (current?.pending === pending) {
        if (current.value === undefined) entries.delete(key);
        else entries.set(key, { revision: current.revision, builtAt: current.builtAt, value: current.value });
      }
      throw error;
    });
    entries.set(key, { revision: entry?.revision ?? revision, builtAt: entry?.builtAt ?? 0, value: entry?.value, pending });
    return pending;
  };
  if (entry?.value === undefined) return { value: await ((entry?.pending as Promise<T> | undefined) ?? rebuild()), revision };
  const age = Date.now() - entry.builtAt;
  if (!entry.pending && !entry.queued && (age > SNAPSHOT_TTL_MS || (entry.revision !== revision && age > SNAPSHOT_MIN_REBUILD_MS))) {
    entry.queued = true;
    backgroundRebuilds = backgroundRebuilds.then(async () => {
      if (entries.get(key) !== entry) return;
      const started = performance.now();
      await rebuild().catch(() => undefined);
      // Each rebuild leaves the database idle for as long as it took, so requests keep their latency during a burst.
      await new Promise((resolveIdle) => setTimeout(resolveIdle, Math.min(5_000, performance.now() - started)).unref?.());
    });
  }
  return { value: entry.value as T, revision: entry.revision };
};

interface SnapshotItem { option: LocationOption; search: string[] }
interface RegionItem extends SnapshotItem { pairs?: Array<[string, string]>; rootId?: number; rootIds?: number[] }
interface CityItem extends SnapshotItem { regionId?: number; province?: string; regionKey?: string; clause?: LocationScopeClause; population?: number }
interface DistrictItem extends SnapshotItem { province: string; city: string }
interface RegionPath { id: number; path: string | null }
interface AdminSnapshot {
  regions: RegionItem[];
  cities: CityItem[];
  districts: DistrictItem[];
  regionPaths: RegionPath[];
  chinaRegions: ChinaRegionRow[];
}

const pageOf = (items: SnapshotItem[], limit: number, offset: number): CatalogPage => {
  const rows = items.slice(offset, offset + limit);
  return {
    options: rows.map(({ option }) => option),
    total: items.length,
    availableTotal: items.length,
    nextCursor: offset + rows.length < items.length ? String(offset + rows.length) : undefined,
    source: 'postgres'
  };
};
const searched = <T extends SnapshotItem>(items: T[], query: string | undefined, normalizeSearch: (value: string) => string): T[] => {
  const needle = normalizeSearch(query || '');
  return needle ? items.filter((item) => item.search.some((value) => value.includes(needle))) : items;
};
const descendantRegionIds = (paths: RegionPath[], regionId: number): Set<number> => {
  const selected = paths.find((row) => Number(row.id) === regionId);
  const prefix = selected?.path == null ? undefined : `${selected.path.replace(/\/+$/u, '')}/`;
  return new Set([regionId, ...paths.filter((row) => prefix !== undefined && (row.path || '').startsWith(prefix))
    .map((row) => Number(row.id))]);
};

// Region and city options are built from the published addresses themselves, so every servable address is reachable
// through some option and an option's count is exactly what generation for it can return (both use the option's
// admin1 key pairs and city keys). The catalog only names, translates and identifies the options: an admin1 pair
// belongs to the first-level catalog region assignRegions finds for it, a city key to the catalog city of that region
// carrying its name. Pairs naming no catalog region and cities missing from the catalog become options of their own
// with the names the addresses use, under stable `loc-region-` and `loc-city-` ids.
export const LOCATION_REGION_PREFIX = 'loc-region-';
export const LOCATION_CITY_PREFIX = 'loc-city-';
const optionId = (prefix: string, ...parts: string[]): string =>
  `${prefix}${createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0, 20)}`;
export const isLocationOptionId = (id: string | undefined): boolean => /^loc-(?:region|city)-[0-9a-f]{20}$/u.test(id || '');

interface ScopeGroup extends GenerationLocationGroup { sample?: { address_id: string; locality: string | null; postal_locality: string | null } }
interface CatalogCityRow { id: number; region_id: number | null; name: string; native_name: string; zh_name: string; population: number | null }
interface SampleNames { native: Record<string, string>; en: Record<string, string>; zh: Record<string, string> }

const cityKeyOf = (group: GenerationLocationGroup): string => group.locality_key || group.postal_locality_key || '';
// One address of each group, found through the generation index; grouping stays index-only and only options the
// catalog does not name read an address.
const attachSamples = async (db: Database, country: CountryCode, residential: boolean, groups: ScopeGroup[]): Promise<void> => {
  const pending = [...groups];
  await Promise.all(Array.from({ length: Math.min(8, pending.length) }, async () => {
    for (let group = pending.shift(); group; group = pending.shift()) {
      group.sample = await db.prepare(`SELECT address_id,locality,postal_locality FROM address_generation_index
        WHERE country_code=? AND active=1${residential ? ' AND residential_ready=1' : ''}
          AND admin1_key=? AND admin1_code_key=? AND locality_key=? AND postal_locality_key=? LIMIT 1`)
        .bind(country, group.admin1_key, group.admin1_code_key, group.locality_key, group.postal_locality_key)
        .first<NonNullable<ScopeGroup['sample']>>() || undefined;
    }
  }));
};
const sampleNames = async (db: Database, ids: string[]): Promise<Map<string, SampleNames>> => {
  const names = new Map<string, SampleNames>();
  for (let index = 0; index < ids.length; index += 500) {
    const chunk = ids.slice(index, index + 500);
    const rows = (await db.prepare(`SELECT id,component_variants_json FROM address_pool WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .bind(...chunk).all<{ id: string; component_variants_json: string | null }>()).results || [];
    for (const row of rows) {
      let variants: Record<string, Record<string, string>> = {};
      try { variants = JSON.parse(row.component_variants_json || '{}') || {}; } catch { variants = {}; }
      names.set(row.id, { native: variants.native || {}, en: { ...variants.native, ...variants.en }, zh: variants['zh-CN'] || {} });
    }
  }
  return names;
};

const buildAdminSnapshot = async (db: Database, country: CountryCode, residential: boolean): Promise<AdminSnapshot> => {
  const [catalog, groupRows, cityRows, regionPaths] = await Promise.all([
    loadCatalogRegions(db, country),
    db.prepare(`SELECT admin1_key,admin1_code_key,locality_key,postal_locality_key,COUNT(*) AS address_count
      FROM address_generation_index WHERE country_code=? AND active=1${residential ? ' AND residential_ready=1' : ''}
      GROUP BY admin1_key,admin1_code_key,locality_key,postal_locality_key`).bind(country).all<ScopeGroup>(),
    db.prepare(`SELECT c.id,c.region_id,c.name,c.native_name,c.zh_name,c.population FROM catalog_cities c
      WHERE c.country_code=? ORDER BY COALESCE(c.population,0) DESC,c.name,c.id`).bind(country).all<CatalogCityRow>(),
    db.prepare('SELECT id,path FROM catalog_regions WHERE country_code=?').bind(country).all<RegionPath>()
  ]);
  const pause = pauser();
  const groups = groupRows.results || [];
  for (const group of groups) {
    group.admin1_key ||= ''; group.admin1_code_key ||= ''; group.locality_key ||= ''; group.postal_locality_key ||= '';
    group.address_count = Number(group.address_count);
  }
  const catalogCities = cityRows.results || [];
  const byId = new Map(catalog.map((row) => [Number(row.id), row]));
  const rootOf = (id: number | null | undefined): number | undefined => {
    let current = id == null ? undefined : byId.get(Number(id));
    for (let depth = 0; current?.parent_id != null && byId.has(Number(current.parent_id)) && depth < 8; depth += 1) current = byId.get(Number(current.parent_id));
    return current ? Number(current.id) : undefined;
  };

  const pairs = new Map<string, AdminPair & { groups: typeof groups }>();
  for (const group of groups) {
    const key = pairKey(group.admin1_key, group.admin1_code_key);
    const pair = pairs.get(key) || { admin1: group.admin1_key, code: group.admin1_code_key, groups: [] };
    pair.groups.push(group);
    pairs.set(key, pair);
  }
  const roots = catalog.filter((row) => row.parent_id == null || !byId.has(Number(row.parent_id)));
  // Two regions may share an English name (Moscow city and oblast); their filter value is then the native name where
  // that one is unique. Regions alike in every name are one option.
  const repeated = (values: string[]) => new Set(values.filter((name, index) => values.indexOf(name) !== index));
  const sharedNames = repeated(roots.map((row) => lowerKey(row.name)));
  const sharedNatives = repeated(roots.map((row) => lowerKey(row.native_name)));
  const valueOf = (row: CatalogRegion) => sharedNames.has(lowerKey(row.name)) && row.native_name && !sharedNatives.has(lowerKey(row.native_name))
    ? row.native_name : row.name;
  const optionRoot = new Map<number, number>();
  const firstByValue = new Map<string, number>();
  for (const row of roots) {
    const value = lowerKey(valueOf(row));
    if (!firstByValue.has(value)) firstByValue.set(value, Number(row.id));
    optionRoot.set(Number(row.id), firstByValue.get(value)!);
  }
  const assigned = assignRegions(catalog, [...pairs.values()], (root) => optionRoot.get(root) ?? root);
  // Unassigned pairs group by spelling (US territories by code); a pair without admin1 stays unreachable and the
  // reachability audit reports it.
  const territoryOf = (pair: AdminPair) => country === 'US' ? usTerritories[pair.code.toUpperCase()] && pair.code.toUpperCase() : undefined;
  const regionKeyOf = (pair: AdminPair): string | undefined => {
    const root = assigned.get(pairKey(pair.admin1, pair.code));
    if (root !== undefined) return String(optionRoot.get(root) ?? root);
    const territory = territoryOf(pair);
    return territory || pair.admin1 ? optionId(LOCATION_REGION_PREFIX, territory ? `territory:${territory}` : regionSpellingKey(pair.admin1)) : undefined;
  };
  const regionPairs = new Map<string, Array<AdminPair & { groups: typeof groups }>>();
  for (const pair of pairs.values()) {
    const key = regionKeyOf(pair);
    if (!key) continue;
    const members = regionPairs.get(key) || [];
    members.push(pair);
    regionPairs.set(key, members);
  }
  // Catalog cities of each root, by every alias generation would match.
  const catalogByRoot = new Map<number, Map<string, CatalogCityRow>>();
  for (const city of catalogCities) {
    await pause();
    const cityRoot = rootOf(city.region_id);
    if (cityRoot === undefined) continue;
    const root = optionRoot.get(cityRoot) ?? cityRoot;
    const aliases = catalogByRoot.get(root) || new Map<string, CatalogCityRow>();
    for (const alias of poolLocationAliases(cityAliases(city.name, city.native_name, city.zh_name))) if (!aliases.has(alias)) aliases.set(alias, city);
    catalogByRoot.set(root, aliases);
  }
  // City keys of each region option; spellings of one catalog city become one option.
  type CityEntry = { catalog?: CatalogCityRow; keys: string[]; groups: typeof groups; count: number };
  const regionCities = new Map<string, CityEntry[]>();
  for (const [regionKey, members] of regionPairs) {
    const byCity = new Map<string, { groups: typeof groups; count: number }>();
    for (const group of members.flatMap((pair) => pair.groups)) {
      const key = cityKeyOf(group);
      if (!key) continue;
      const entry = byCity.get(key) || { groups: [], count: 0 };
      entry.groups.push(group); entry.count += group.address_count;
      byCity.set(key, entry);
    }
    const aliases = regionKey.startsWith(LOCATION_REGION_PREFIX) ? undefined : catalogByRoot.get(Number(regionKey));
    const merged = new Map<string, CityEntry>();
    for (const [key, entry] of [...byCity].sort((left, right) => right[1].count - left[1].count)) {
      await pause();
      const match = aliases && poolLocationAliases(cityAliases(key)).map((alias) => aliases.get(alias)).find(Boolean);
      const mergeKey = match ? `catalog:${match.id}` : `key:${key}`;
      const target = merged.get(mergeKey) || { catalog: match, keys: [], groups: [], count: 0 };
      target.keys.push(key); target.groups.push(...entry.groups); target.count += entry.count;
      merged.set(mergeKey, target);
    }
    for (const entry of merged.values()) entry.groups.sort((left, right) => right.address_count - left.address_count);
    regionCities.set(regionKey, [...merged.values()]);
  }
  // Only regions and cities the catalog does not name read their names from an address.
  const leadOf = (members: Array<AdminPair & { groups: typeof groups }>) =>
    [...members].sort((left, right) => countOf([right]) - countOf([left]))[0];
  const countOf = (members: Array<{ groups: typeof groups }>) => members.reduce((sum, pair) =>
    sum + pair.groups.reduce((count, group) => count + group.address_count, 0), 0);
  const named = [...new Set([
    ...[...regionPairs].filter(([key]) => key.startsWith(LOCATION_REGION_PREFIX)).map(([, members]) => leadOf(members).groups[0]),
    ...[...regionCities.values()].flat().filter((entry) => !entry.catalog).map((entry) => entry.groups[0])
  ])];
  await attachSamples(db, country, residential, named);
  const samples = await sampleNames(db, named.flatMap((group) => group.sample ? [group.sample.address_id] : []));

  const regions = new Map<string, RegionItem>();
  for (const row of roots) {
    const members = regionPairs.get(String(row.id)) || [];
    if (optionRoot.get(Number(row.id)) !== Number(row.id) || !members.length) continue;
    regions.set(String(row.id), {
      option: { value: valueOf(row), label: regionLabel(row, country), availableCount: countOf(members), disabled: false,
        id: String(row.id), regionCode: row.code || undefined, native: row.native_name, en: row.name, zhCN: row.zh_name },
      search: [row.name, row.native_name, row.zh_name, row.code].map(lowerKey),
      pairs: members.map((pair) => [pair.admin1, pair.code]), rootId: Number(row.id),
      rootIds: [...optionRoot].filter(([, root]) => root === Number(row.id)).map(([id]) => id)
    });
  }
  const synthetic = [...regionPairs].filter(([key]) => key.startsWith(LOCATION_REGION_PREFIX)).map(([key, members]) => {
    const lead = leadOf(members);
    const names = samples.get(lead.groups[0].sample?.address_id || '');
    const code = territoryOf(lead) || '';
    const territory = code ? usTerritories[code] : undefined;
    const native = (territory?.name || names?.native.admin1 || lead.admin1).trim();
    const en = (territory?.name || names?.en.admin1 || native).trim();
    const zh = (territory?.zh || names?.zh.admin1 || '').trim();
    const item: RegionItem = {
      option: { value: native, label: regionLabel({ id: 0, parent_id: null, code, name: en, native_name: native, zh_name: zh }, country),
        availableCount: countOf(members), disabled: false, id: key, regionCode: code || undefined, native, en, zhCN: zh || native },
      search: [...new Set([native, en, zh, code, ...members.map((pair) => pair.admin1)].map(lowerKey))],
      pairs: members.map((pair) => [pair.admin1, pair.code])
    };
    return [key, item] as const;
  }).sort((left, right) => Number(right[1].option.availableCount) - Number(left[1].option.availableCount));
  for (const [key, item] of synthetic) regions.set(key, item);

  const cities: CityItem[] = [];
  const usedIds = new Set<string>();
  for (const [regionKey, region] of regions) {
    for (const entry of regionCities.get(regionKey) || []) {
      await pause();
      const lead = entry.groups[0];
      const names = samples.get(lead.sample?.address_id || '');
      const field = lead.locality_key ? 'locality' : 'postalLocality';
      const nativeName = (lead.locality_key ? lead.sample?.locality : lead.sample?.postal_locality) || names?.native[field] || entry.keys[0];
      const row = entry.catalog ? { ...entry.catalog }
        : { id: 0, region_id: null, name: (names?.en[field] || nativeName).trim(), native_name: nativeName.trim(), zh_name: (names?.zh[field] || '').trim(), population: null };
      const catalogId = entry.catalog && !usedIds.has(String(entry.catalog.id)) ? String(entry.catalog.id) : undefined;
      const id = catalogId || optionId(LOCATION_CITY_PREFIX, regionKey, entry.keys[0]);
      usedIds.add(id);
      const clause: LocationScopeClause = { pairs: [...new Map(entry.groups.map((group) => [pairKey(group.admin1_key, group.admin1_code_key),
        [group.admin1_key, group.admin1_code_key] as [string, string]])).values()], cities: entry.keys };
      cities.push({
        option: {
          value: row.name || row.native_name, label: cityLabel(row, country),
          availableCount: entry.count, disabled: false, id,
          parentId: region.option.id, parentValue: region.option.value, parentLabel: region.option.label,
          regionId: region.option.id, regionValue: region.option.value, regionCode: region.option.regionCode,
          native: row.native_name, en: row.name, zhCN: row.zh_name || row.native_name
        },
        search: [...new Set([row.name, row.native_name, row.zh_name, ...entry.keys].map(lowerKey))],
        regionId: region.rootId, regionKey, clause, population: Number(row.population || 0)
      });
    }
  }
  cities.sort((left, right) => (right.population || 0) - (left.population || 0)
    || Number(right.option.availableCount) - Number(left.option.availableCount) || left.option.value.localeCompare(right.option.value));
  return { regions: [...regions.values()], cities, districts: [], regionPaths: regionPaths.results || [], chinaRegions: [] };
};

const adminSnapshot = async (db: Database, country: CountryCode, residential: boolean): Promise<{ value: AdminSnapshot; revision: string }> => {
  const currentRevision = await db.prepare('SELECT version FROM address_pool_revisions WHERE kind=?')
    .bind(`generation:${country}`).first<string>('version') || '';
  const china = country === 'CN';
  return loadSnapshot(db, china ? 'CN:admin' : `${country}:${residential}:admin`, currentRevision,
    () => china ? buildChinaAdminSnapshot(db) : buildAdminSnapshot(db, country, residential));
};

// The region option a filter names: its option id, a catalog region id (a lower division resolves to its first-level
// region), or a name of the option.
const regionItemFor = async (db: Database, country: CountryCode, snapshot: AdminSnapshot, region?: string, regionId?: string): Promise<RegionItem | null | undefined> => {
  if (regionId) {
    const direct = snapshot.regions.find((item) => item.option.id === regionId);
    if (direct) return direct;
    const id = catalogId(regionId);
    if (id === undefined) return null;
    const regions = await loadCatalogRegions(db, country);
    const byId = new Map(regions.map((row) => [Number(row.id), row]));
    let current = byId.get(id);
    for (let depth = 0; current?.parent_id != null && byId.has(Number(current.parent_id)) && depth < 8; depth += 1) current = byId.get(Number(current.parent_id));
    return current ? snapshot.regions.find((item) => item.rootIds?.includes(Number(current!.id))) || null : null;
  }
  if (!region?.trim()) return undefined;
  const needle = lowerKey(region);
  const named = snapshot.regions.filter((item) => item.search.includes(needle) || lowerKey(item.option.value) === needle);
  if (named.length === 1) return named[0];
  const id = await findRegion(db, country, region, undefined);
  return id === undefined ? undefined : regionItemFor(db, country, snapshot, undefined, String(id));
};

const cityItemsFor = (snapshot: AdminSnapshot, region: RegionItem | undefined, city?: string, cityId?: string): CityItem[] => {
  const scoped = region ? snapshot.cities.filter((item) => item.option.regionId === region.option.id) : snapshot.cities;
  if (cityId) return scoped.filter((item) => item.option.id === cityId);
  const needle = lowerKey(city);
  return needle ? scoped.filter((item) => item.search.includes(needle) || lowerKey(item.option.value) === needle) : [];
};

// Resolves region and city filters to the option scopes the dropdowns count. Undefined means the filters name no
// option and the caller keeps its catalog lookup; null means an option id that does not exist, or a city outside the
// requested region, which no address satisfies.
export const resolveLocationScope = async (db: Database, country: CountryCode, filters: AddressFilters): Promise<CatalogTarget | null | undefined> => {
  if (country === 'CN' || !(filters.region || filters.regionId || filters.city || filters.cityId)) return undefined;
  const { value: snapshot } = await adminSnapshot(db, country, false);
  const region = filters.region || filters.regionId ? await regionItemFor(db, country, snapshot, filters.region, filters.regionId) : undefined;
  if (region === null) return null;
  if (!region && (filters.region || filters.regionId)) return undefined;
  const cities = filters.city || filters.cityId ? cityItemsFor(snapshot, region, filters.city, filters.cityId) : [];
  if ((filters.city || filters.cityId) && !cities.length) return isLocationOptionId(filters.cityId) || region ? null : undefined;
  const regionOption = region?.option || snapshot.regions.find((item) => item.option.id === cities[0]?.option.regionId)?.option;
  const lead = cities[0]?.option;
  return {
    regionId: catalogId(regionOption?.id), region: regionOption?.en || regionOption?.value, regionNative: regionOption?.native,
    regionCode: regionOption?.regionCode, regionAliases: [],
    cityId: catalogId(lead?.id), city: lead ? lead.en || lead.value : undefined, cityNative: lead?.native, cityAliases: [],
    scope: cities.length ? cities.map((item) => item.clause!) : [{ pairs: region?.pairs || [] }],
    scopeCount: (cities.length ? cities.map((item) => item.option) : region ? [region.option] : [])
      .reduce((sum, option) => sum + Number(option.availableCount || 0), 0),
    bucket: `scope-${country}-${regionOption?.id || ''}-${cities.map((item) => item.option.id).join(',')}`
  };
};

const queryCities = async (db: Database, input: CatalogQuery, snapshot: AdminSnapshot, limit: number, offset: number): Promise<CatalogPage> => {
  if (!input.region && !input.regionId) return pageOf(searched(snapshot.cities, input.query, lowerKey), limit, offset);
  const region = await regionItemFor(db, input.country, snapshot, input.region, input.regionId);
  if (!region) return emptyPage;
  return pageOf(searched(snapshot.cities.filter((item) => item.option.regionId === region.option.id), input.query, lowerKey), limit, offset);
};

// --- China community-backed options ------------------------------------------------
// The dr5hn catalog models CN unreliably (districts listed as cities, "X" and
// "X Shi" duplicates, mistranslated zh names), so CN options are served from the
// published communities themselves and cities are only mapped back to catalog
// ids so the /v1/generate catalog gate keeps working.

interface ChinaGroupRow { province: string; city: string; district: string; address_count: number }
interface ChinaCityGroupRow { province: string; city: string; address_count: number }
interface ChinaCatalogCityRow { id: number; region_id: number | null; name: string; native_name: string; zh_name: string; population: number | null }
interface ChinaRegionRow { id: number; parent_id?: number | null; code: string; name: string; native_name: string; zh_name: string }

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
const hexId = (prefix: string, value: string): string => `${prefix}${Buffer.from(value, 'utf8').toString('hex')}`;
const decodeHexId = (prefix: string, id: string | undefined): string | undefined => {
  if (!id?.startsWith(prefix)) return undefined;
  const hex = id.slice(prefix.length);
  if (!/^[0-9a-f]+$/u.test(hex) || hex.length % 2 !== 0) return undefined;
  const value = Buffer.from(hex, 'hex').toString('utf8');
  return value.trim() && Buffer.from(value, 'utf8').toString('hex') === hex ? value : undefined;
};
const syntheticCityId = (city: string): string => hexId(CN_SYNTHETIC_CITY_PREFIX, city);
export const decodeSyntheticCityId = (id: string | undefined): string | undefined => decodeHexId(CN_SYNTHETIC_CITY_PREFIX, id);
// District ids carry their province and city because district names repeat across cities (朝阳区, 鼓楼区).
const DISTRICT_ID_SEPARATOR = '\u001f';
const syntheticDistrictId = (province: string, city: string, district: string): string =>
  hexId(CN_SYNTHETIC_DISTRICT_PREFIX, [province, city, district].join(DISTRICT_ID_SEPARATOR));
export const decodeSyntheticDistrict = (id: string | undefined): { province?: string; city?: string; district: string } | undefined => {
  const parts = decodeHexId(CN_SYNTHETIC_DISTRICT_PREFIX, id)?.split(DISTRICT_ID_SEPARATOR);
  if (!parts?.at(-1)?.trim() || (parts.length !== 1 && parts.length !== 3)) return undefined;
  return parts.length === 1 ? { district: parts[0] } : { province: parts[0] || undefined, city: parts[1] || undefined, district: parts[2] };
};
export const decodeSyntheticDistrictId = (id: string | undefined): string | undefined => decodeSyntheticDistrict(id)?.district;
const searchableKey = (value: string): string => (value || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase().replace(/[\s\-'･·]/g, '');

const stripProvinceSuffix = (value: string): string => (value || '').replace(/省$/u, '');
const stripCitySuffix = (value: string): string => (value || '').replace(/市/gu, '');

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
const inChinaRegion = (province: string, region: ChinaRegionRow): boolean => {
  const names = [region.name, region.native_name, region.zh_name];
  return names.includes(province) || names.map(stripProvinceSuffix).includes(stripProvinceSuffix(province));
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

const sumBy = <T,>(rows: T[], key: (row: T) => string, count: (row: T) => number): Map<string, number> => {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(key(row), (totals.get(key(row)) || 0) + count(row));
  return totals;
};

const buildChinaAdminSnapshot = async (db: Database): Promise<AdminSnapshot> => {
  const [regionResult, groupResult] = await Promise.all([
    db.prepare(`SELECT id,parent_id,code,name,native_name,zh_name FROM catalog_regions
      WHERE country_code=? AND parent_id IS NULL ORDER BY name`).bind('CN').all<ChinaRegionRow>(),
    db.prepare(`SELECT community.province AS province,community.city AS city,community.district AS district,
        COUNT(community.id) AS address_count
      FROM cn_communities_v2 community WHERE ${chinaCommunityPublicationClause('community')}
      GROUP BY community.province,community.city,community.district`).all<ChinaGroupRow>()
  ]);
  const chinaRegions = regionResult.results || [];
  const groups = (groupResult.results || []).map((row) => ({ ...row, city: row.city || '', district: row.district || '' }));
  const provinceCounts = sumBy(groups, (row) => row.province.toLocaleLowerCase(), (row) => Number(row.address_count || 0));
  const regions = new Map<string, SnapshotItem>();
  for (const row of chinaRegions) {
    const key = row.name.toLocaleLowerCase();
    const availableCount = Math.max(...[row.name, row.native_name, row.zh_name].map((value) => provinceCounts.get(value.toLocaleLowerCase()) || 0));
    if (!availableCount || regions.has(key)) continue;
    regions.set(key, {
      option: {
        value: row.zh_name || row.native_name || row.name, label: regionLabel({ parent_id: null, ...row }, 'CN'),
        availableCount, disabled: false, id: String(row.id),
        parentId: row.parent_id == null ? undefined : String(row.parent_id),
        regionCode: row.code || undefined, native: row.native_name, en: row.name, zhCN: row.zh_name
      },
      search: [row.name, row.native_name, row.zh_name, row.code].map(lowerKey)
    });
  }
  const regionByName = new Map<string, ChinaRegionRow>();
  for (const region of chinaRegions) {
    for (const name of [region.name, region.native_name, region.zh_name]) if (name) regionByName.set(name.toLocaleLowerCase(), region);
  }
  const cityGroups: ChinaCityGroupRow[] = [...sumBy(groups.filter((row) => row.city), (row) => `${row.province}\u0000${row.city}`,
    (row) => Number(row.address_count || 0))].map(([key, address_count]) => {
    const [province, city] = key.split('\u0000');
    return { province, city, address_count };
  });
  const candidatesByStem = await chinaCatalogCandidates(db, cityGroups.map((row) => row.city));
  const cities: CityItem[] = [];
  const cityIds = new Map<string, string>();
  for (const row of cityGroups) {
    const province = regionByName.get(row.province.toLocaleLowerCase());
    const catalogCity = pickChinaCatalogCity(candidatesByStem, row.city, province) || await chinaMunicipalityProxy(db, province, row);
    const en = catalogCity?.name || romanizeChinese(row.city);
    const id = catalogCity ? String(catalogCity.id) : syntheticCityId(row.city);
    cityIds.set(`${row.province}\u0000${row.city}`, id);
    cities.push({
      option: {
        value: row.city, label: row.city, availableCount: row.address_count, disabled: false, id,
        parentId: province ? String(province.id) : undefined,
        parentValue: province?.zh_name || row.province, parentLabel: province?.zh_name || row.province,
        regionId: province ? String(province.id) : undefined, regionValue: province?.zh_name || row.province,
        regionCode: province?.code || undefined, native: row.city, en: catalogCity?.name || en, zhCN: row.city
      },
      search: [row.city, cnCityStem(row.city), en].map(searchableKey),
      province: row.province
    });
  }
  cities.sort((left, right) => Number(right.option.availableCount) - Number(left.option.availableCount)
    || left.option.value.localeCompare(right.option.value, 'zh-CN'));
  const districts: DistrictItem[] = groups.filter((row) => row.district).map((row) => {
    const province = regionByName.get(row.province.toLocaleLowerCase());
    const provinceName = province?.zh_name || row.province;
    const en = chinaEnglishComponent('district', row.district);
    return {
      option: {
        id: syntheticDistrictId(row.province, row.city, row.district), value: row.district, label: row.district,
        availableCount: Number(row.address_count || 0), disabled: false,
        parentId: cityIds.get(`${row.province}\u0000${row.city}`), parentValue: row.city || undefined,
        parentLabel: [...new Set([row.city, provinceName].filter(Boolean))].join(' · ') || undefined,
        regionId: province ? String(province.id) : undefined, regionValue: provinceName, regionCode: province?.code || undefined,
        native: row.district, en, zhCN: row.district
      },
      search: [row.district, en].map(searchableKey),
      province: row.province,
      city: row.city
    };
  }).sort((left, right) => Number(right.option.availableCount) - Number(left.option.availableCount)
    || left.option.value.localeCompare(right.option.value, 'zh-CN')
    || String(left.option.parentLabel).localeCompare(String(right.option.parentLabel), 'zh-CN'));
  return { regions: [...regions.values()], cities, districts, regionPaths: [], chinaRegions };
};

const queryChinaCities = (input: CatalogQuery, snapshot: AdminSnapshot, limit: number, offset: number): CatalogPage => {
  const scoped = Boolean((input.regionId || '').trim() || (input.region || '').trim());
  const region = matchChinaRegion(snapshot.chinaRegions, input.regionId, input.region);
  if (scoped && !region) return emptyPage;
  const cities = region ? snapshot.cities.filter((item) => inChinaRegion(item.province || '', region)) : snapshot.cities;
  return pageOf(searched(cities, input.query, searchableKey), limit, offset);
};

// China is the only country with a served district level; its published
// communities are the authoritative catalog, so every option has coverage
// and an uncovered district can never be selected (exact-or-empty rule).
const queryDistricts = async (db: Database, input: CatalogQuery, snapshot: AdminSnapshot, limit: number, offset: number): Promise<CatalogPage> => {
  let districts = snapshot.districts;
  const regionId = Number.parseInt(input.regionId || '', 10);
  if (Number.isFinite(regionId)) {
    const region = snapshot.chinaRegions.find((row) => Number(row.id) === regionId);
    const names = region ? [region.name, region.native_name, region.zh_name] : [];
    districts = districts.filter((item) => names.includes(item.province));
  } else if (input.region?.trim()) {
    const region = input.region.trim();
    districts = districts.filter((item) => item.province === region || stripProvinceSuffix(item.province) === stripProvinceSuffix(region));
  }
  const syntheticCity = decodeSyntheticCityId(input.cityId);
  const cityId = Number.parseInt(input.cityId || '', 10);
  if (syntheticCity) {
    districts = districts.filter((item) => item.city === syntheticCity || stripCitySuffix(item.city) === stripCitySuffix(syntheticCity));
  } else if (Number.isFinite(cityId)) {
    // Suffix tolerance: the catalog stores 北京/唐山 while communities store
    // 北京市/唐山市. Municipality proxies (Shanghai has no city-proper catalog
    // row) resolve through their parent region instead.
    const city = await db.prepare('SELECT id,region_id,name,native_name,zh_name FROM catalog_cities WHERE id = ?')
      .bind(cityId).first<ChinaCatalogCityRow>();
    const names = city ? [city.name, city.native_name, city.zh_name] : [];
    const parent = city?.region_id == null ? undefined : snapshot.chinaRegions.find((row) => Number(row.id) === Number(city.region_id));
    const parentNames = parent ? [parent.name, parent.native_name, parent.zh_name] : [];
    districts = districts.filter((item) => names.includes(item.city) || names.map(stripCitySuffix).includes(stripCitySuffix(item.city))
      || (item.city === item.province && parentNames.includes(item.province)));
  }
  return pageOf(searched(districts, input.query, searchableKey), limit, offset);
};

// --- Postcodes ---------------------------------------------------------------------

interface PostcodeGroup extends GenerationLocationGroup { postcode_key: string }
interface PostcodeCatalogRow extends Omit<PostcodeRow, 'address_count' | 'city_count' | 'region_count'> { postcode_key: string }
interface PostcodeSnapshot {
  groups: PostcodeGroup[]; totals: Array<[string, number]>; catalog: Map<string, PostcodeCatalogRow[]>; regionPaths: RegionPath[];
}
const byPostcodeKey = (left: [string, number], right: [string, number]): number => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;

const buildPostcodeSnapshot = async (db: Database, country: CountryCode, residential: boolean): Promise<PostcodeSnapshot> => {
  const scope = `country_code=? AND active=1 AND postcode_key<>''${residential ? ' AND residential_ready=1' : ''}`;
  const [groups, catalog, regionPaths] = await Promise.all([
    db.prepare(`SELECT postcode_key,admin1_key,admin1_code_key,locality_key,postal_locality_key,COUNT(*) AS address_count
      FROM address_generation_index WHERE ${scope}
      GROUP BY postcode_key,admin1_key,admin1_code_key,locality_key,postal_locality_key`).bind(country).all<PostcodeGroup>(),
    db.prepare(`SELECT p.id,p.city_id,p.code,p.locality_name,LOWER(REPLACE(p.code,' ','')) AS postcode_key,
        c.name AS city_name,c.native_name AS city_native_name,c.zh_name AS city_zh_name,
        COALESCE(p.region_id,c.region_id) AS region_id,r.name AS region_name,r.native_name AS region_native_name,
        r.zh_name AS region_zh_name,r.code AS region_code
      FROM catalog_postcodes p LEFT JOIN catalog_cities c ON c.id=p.city_id
      LEFT JOIN catalog_regions r ON r.id=COALESCE(p.region_id,c.region_id)
      WHERE p.country_code=? AND LOWER(REPLACE(p.code,' ','')) IN (
        SELECT DISTINCT postcode_key FROM address_generation_index WHERE ${scope})
      ORDER BY p.id`).bind(country, country).all<PostcodeCatalogRow>(),
    db.prepare('SELECT id,path FROM catalog_regions WHERE country_code=?').bind(country).all<RegionPath>()
  ]);
  const byKey = new Map<string, PostcodeCatalogRow[]>();
  for (const row of catalog.results || []) {
    const rows = byKey.get(row.postcode_key);
    if (rows) rows.push(row); else byKey.set(row.postcode_key, [row]);
  }
  const rows = groups.results || [];
  const totals = [...sumBy(rows, (group) => group.postcode_key, (group) => Number(group.address_count))].sort(byPostcodeKey);
  return { groups: rows, totals, catalog: byKey, regionPaths: regionPaths.results || [] };
};

const uniqueOf = (rows: PostcodeCatalogRow[], key: (row: PostcodeCatalogRow) => number | null): boolean =>
  rows.length > 0 && rows.every((row) => key(row) != null) && new Set(rows.map(key)).size === 1;

const queryPostcodes = async (db: Database, input: CatalogQuery, snapshot: PostcodeSnapshot, limit: number, offset: number): Promise<CatalogPage> => {
  const hasParent = Boolean(input.region || input.regionId || input.city || input.cityId);
  const scoped = hasParent ? await resolveLocationScope(db, input.country, input) : undefined;
  if (scoped === null) return emptyPage;
  const target = scoped || (hasParent ? await resolveCatalogTarget(db, input.country, input, 'catalog-options') : undefined);
  if (hasParent && !target) return emptyPage;
  const regionAliases = new Set(poolLocationAliases([input.region, ...target?.regionAliases || []]));
  const cityAliases = new Set(poolLocationAliases([input.city, ...target?.cityAliases || []]));
  const matches = (group: PostcodeGroup): boolean => target?.scope ? scopeGroupMatches(group, target.scope)
    : (!regionAliases.size || regionAliases.has(group.admin1_key) || regionAliases.has(group.admin1_code_key))
      && (!cityAliases.size || cityAliases.has(group.locality_key) || cityAliases.has(group.postal_locality_key));
  const available = !target ? snapshot.totals : [...sumBy(snapshot.groups.filter(matches),
    (group) => group.postcode_key, (group) => Number(group.address_count))].sort(byPostcodeKey);
  const regionScope = target?.regionId ? descendantRegionIds(snapshot.regionPaths, Number(target.regionId)) : undefined;
  const cityNames = new Set([target?.city, target?.cityNative].filter(Boolean).map((name) => name!.toLowerCase()));
  const keyNeedle = input.query?.trim() ? input.query.trim().toLocaleLowerCase().replace(/\s/gu, '') : '';
  const localityNeedle = input.query?.trim().toLocaleLowerCase() || '';
  const labelScoped = Boolean(regionScope || target?.cityId);
  const options = available.flatMap(([postcodeKey, addressCount]) => {
    let rows = snapshot.catalog.get(postcodeKey) || [];
    if (labelScoped) rows = rows.filter((row) =>
      (!regionScope || (row.region_id != null && regionScope.has(Number(row.region_id))))
      && (!target?.cityId || Number(row.city_id) === Number(target.cityId) || cityNames.has((row.locality_name || '').toLowerCase())));
    if (keyNeedle && !postcodeKey.includes(keyNeedle)) {
      rows = rows.filter((row) => (row.locality_name || '').toLowerCase().includes(localityNeedle));
      if (!rows.length) return [];
    }
    return [{ postcodeKey, addressCount, rows }];
  });
  if (!options.length) return emptyPage;
  // Only the requested page becomes options; large countries have tens of thousands of postcodes.
  const items: SnapshotItem[] = options.slice(offset, offset + limit).map(({ postcodeKey, addressCount, rows }) => {
    const row = rows[0];
    // A postcode the catalog does not list is written as addresses store it (DA15 8DZ, K1A 0B1).
    const code = row?.code || normalizePostcode(input.country, postcodeKey);
    const cityKnown = uniqueOf(rows, (entry) => entry.city_id);
    const regionKnown = uniqueOf(rows, (entry) => entry.region_id);
    return {
      search: [],
      option: {
        value: code, label: [code, cityKnown && row.locality_name, regionKnown && row.region_name].filter(Boolean).join(' · '),
        availableCount: addressCount, disabled: false, id: row?.id == null ? undefined : String(row.id),
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
        native: [code, cityKnown && (row.city_native_name || row.locality_name)].filter(Boolean).join(' · '),
        en: [code, cityKnown && (row.city_name || row.locality_name)].filter(Boolean).join(' · '),
        zhCN: [code, cityKnown && (row.city_zh_name || row.locality_name)].filter(Boolean).join(' · ')
      }
    };
  });
  return {
    options: items.map(({ option }) => option), total: options.length, availableTotal: options.length,
    nextCursor: offset + items.length < options.length ? String(offset + items.length) : undefined, source: 'postgres'
  };
};

// Configured shortcuts select the dropdown option they name (大阪府 is the option 大阪, the Taiwanese "city" 臺北市 is
// a region option); shortcuts naming no published address are left out. Countries whose snapshot is still being built
// keep their shortcuts as configured.
type ShortcutIndex = Record<'region' | 'city', { exact: Map<string, LocationOption[]>; loose: Map<string, LocationOption[]> }>;
const shortcutIndexes = new WeakMap<AdminSnapshot, ShortcutIndex>();
const shortcutIndex = (snapshot: AdminSnapshot): ShortcutIndex => {
  const cached = shortcutIndexes.get(snapshot);
  if (cached) return cached;
  const build = (items: SnapshotItem[]) => {
    const exact = new Map<string, LocationOption[]>();
    const loose = new Map<string, LocationOption[]>();
    const add = (map: Map<string, LocationOption[]>, key: string, option: LocationOption) => {
      if (key && !map.get(key)?.includes(option)) map.set(key, [...map.get(key) || [], option]);
    };
    for (const { option } of items) for (const name of [option.value, option.native, option.en, option.zhCN]) {
      add(exact, foldName(name), option);
      for (const variant of nameVariants(name)) add(loose, variant, option);
    }
    return { exact, loose };
  };
  const index = { region: build(snapshot.regions), city: build(snapshot.cities) };
  shortcutIndexes.set(snapshot, index);
  return index;
};
const shortcutOption = (snapshot: AdminSnapshot, shortcut: LocationShortcut): LocationShortcut['option'] | null | undefined => {
  if (shortcut.type !== 'region' && shortcut.type !== 'city') return undefined;
  const names = [shortcut.value, shortcut.label.en, shortcut.label['zh-CN']].filter(Boolean);
  const index = shortcutIndex(snapshot);
  const byCount = (left: LocationOption, right: LocationOption) => Number(right.availableCount) - Number(left.availableCount);
  const field = shortcut.type;
  for (const loose of [false, true]) {
    const found = names.flatMap((name) => loose ? [...nameVariants(name)].flatMap((variant) => index[field].loose.get(variant) || [])
      : index[field].exact.get(foldName(name)) || []).sort(byCount)[0];
    if (found) return { field, id: found.id, value: found.value, regionId: found.regionId, regionValue: found.regionValue };
  }
  // A city that is a first-level unit (Taiwan's 臺北市) selects that region; a region merely named like the city
  // (大阪府 for 大阪市) would widen the shortcut and does not.
  const region = shortcut.type === 'city' ? (index.region.exact.get(foldName(shortcut.value)) || []).sort(byCount)[0] : undefined;
  return region ? { field: 'region', id: region.id, value: region.value } : null;
};
const resolvedShortcuts = new WeakMap<AdminSnapshot, { key: string; value: CountryShortcutConfig }>();
export const resolveCountryShortcuts = <T extends Partial<Record<CountryCode, CountryShortcutConfig>>>(db: Database, configs: T): T =>
  Object.fromEntries(Object.entries(configs).map(([country, config]) => {
    const snapshot = snapshotStore.get(db)?.get(country === 'CN' ? 'CN:admin' : `${country}:false:admin`)?.value as AdminSnapshot | undefined;
    if (!snapshot || !config) return [country, config];
    const key = JSON.stringify(config);
    const cached = resolvedShortcuts.get(snapshot);
    if (cached?.key === key) return [country, cached.value];
    const resolve = (items: LocationShortcut[]) => items.flatMap((item) => {
      const option = shortcutOption(snapshot, item);
      return option === null ? [] : [option ? { ...item, option } : item];
    });
    const value = { ...config, popularCities: resolve(config.popularCities), adminShortcuts: resolve(config.adminShortcuts),
      specialAreas: resolve(config.specialAreas) };
    resolvedShortcuts.set(snapshot, { key, value });
    return [country, value];
  })) as T;

export const invalidateLocationCatalogCache = (db: Database): void => {
  snapshotStore.delete(db);
};

export const queryLocationCatalog = async (db: Database, input: CatalogQuery): Promise<CatalogPage> => {
  if (input.field === 'district' && input.country !== 'CN') return { ...emptyPage, revision: '' };
  const currentRevision = await db.prepare('SELECT version FROM address_pool_revisions WHERE kind=?')
    .bind(`generation:${input.country}`).first<string>('version') || '';
  const limit = normalizeLimit(input.limit, 200);
  const offset = normalizeOffset(input.cursor);
  const residential = Boolean(input.residential);
  if (input.field === 'postcode') {
    const { value, revision } = await loadSnapshot(db, `${input.country}:${residential}:postcode`, currentRevision,
      () => buildPostcodeSnapshot(db, input.country, residential));
    return { ...await queryPostcodes(db, input, value, limit, offset), revision };
  }
  const china = input.country === 'CN';
  const { value, revision } = await loadSnapshot(db, china ? 'CN:admin' : `${input.country}:${residential}:admin`, currentRevision,
    () => china ? buildChinaAdminSnapshot(db) : buildAdminSnapshot(db, input.country, residential));
  const page = input.field === 'region' ? pageOf(searched(value.regions, input.query, lowerKey), limit, offset)
    : input.field === 'city' ? (china ? queryChinaCities(input, value, limit, offset) : await queryCities(db, input, value, limit, offset))
      : await queryDistricts(db, input, value, limit, offset);
  return { ...page, revision };
};

// Builds every country's snapshots one at a time so the first visitor of a country does not wait for the grouping.
export const prewarmLocationCatalog = async (db: Database, targets: Array<{ country: CountryCode; postcode: boolean }>): Promise<void> => {
  for (const { country, postcode } of targets) {
    const residential = country === 'CN';
    await queryLocationCatalog(db, { country, field: 'region', residential }).catch(() => undefined);
    if (postcode) await queryLocationCatalog(db, { country, field: 'postcode', residential }).catch(() => undefined);
  }
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
