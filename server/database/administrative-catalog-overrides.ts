import { hongKongDistricts, hongKongRegions } from '../../src/domain/hk-administrative-divisions.mjs';
import { catalogHierarchyPaths, correctSpanishProvinceParents } from './catalog-hierarchy.mjs';
import type { PostgresDatabase } from './postgres.mjs';
import { implausibleChineseTranslation } from '../../src/domain/address-localization.mjs';
import { chinaCityNames, chinaCityRegionCode } from './china-catalog-corrections.mjs';
import { catalogNativeCorrections } from './catalog-native-names.mjs';

const chineseRegionCorrections = [{ countryCode: 'TR', code: '16', zh: '布尔萨' }];
// Upstream catalog Chinese names that are literal translations (Emerald → 翠) fall back to the source name, as for
// entries without a translation, so address translation supplies the Chinese name instead.
const repairChinaCatalog = async (transaction: Pick<PostgresDatabase, 'prepare'>) => {
  const regions = new Map(((await transaction.prepare(`SELECT id,code FROM catalog_regions
    WHERE country_code='CN' AND parent_id IS NULL`).all<{ id: number; code: string }>()).results || [])
    .map((region) => [region.code, Number(region.id)]));
  const codes = new Map([...regions].map(([code, id]) => [id, code]));
  const cities = (await transaction.prepare(`SELECT id,region_id,name,native_name,zh_name,latitude,longitude FROM catalog_cities
    WHERE country_code='CN'`).all<{ id: number; region_id: number | null; name: string; native_name: string; zh_name: string;
      latitude: number | null; longitude: number | null }>()).results || [];
  for (const city of cities) {
    const names = chinaCityNames({ name: city.name, native: city.native_name, zh: city.zh_name, latitude: city.latitude, longitude: city.longitude });
    const regionCode = city.region_id == null ? undefined : codes.get(Number(city.region_id));
    const regionId = regionCode ? regions.get(chinaCityRegionCode(regionCode, city.latitude)) ?? city.region_id : city.region_id;
    if (names.native === city.native_name && names.zh === city.zh_name && regionId === city.region_id) continue;
    await transaction.prepare('UPDATE catalog_cities SET native_name=?,zh_name=?,region_id=? WHERE id=?')
      .bind(names.native, names.zh, regionId, city.id).run();
  }
};

const repairCatalogChineseNames = async (transaction: Pick<PostgresDatabase, 'prepare'>) => {
  await repairChinaCatalog(transaction);
  for (const { countryCode, code, zh } of chineseRegionCorrections) {
    await transaction.prepare("UPDATE catalog_regions SET zh_name=? WHERE country_code=? AND code=? AND zh_name<>?")
      .bind(zh, countryCode, code, zh).run();
  }
  for (const table of ['catalog_regions', 'catalog_cities']) {
    const rows = (await transaction.prepare(`SELECT id,name,native_name,zh_name FROM ${table}
      WHERE country_code<>'CN' AND zh_name<>''`).all<{ id: number; name: string; native_name: string; zh_name: string }>()).results || [];
    const implausible = rows.filter((row) => !/\p{Script=Han}/u.test(row.native_name || '')
      && implausibleChineseTranslation(row.native_name || row.name, row.zh_name));
    for (const row of implausible) {
      await transaction.prepare(`UPDATE ${table} SET zh_name=? WHERE id=?`).bind(row.native_name || row.name, row.id).run();
    }
  }
};

const catalogNativeRepairsSchema = `CREATE TABLE IF NOT EXISTS catalog_native_repairs (
  table_name TEXT NOT NULL, catalog_id BIGINT NOT NULL, country_code TEXT NOT NULL, region_id BIGINT,
  old_native TEXT NOT NULL, new_native TEXT NOT NULL, english_name TEXT NOT NULL, created_at TEXT NOT NULL, applied_at TEXT,
  CONSTRAINT catalog_native_repairs_identity PRIMARY KEY (table_name, catalog_id, old_native)
)`;

// Upstream native names are often machine translations (Alaska -> "Down"); the reviewed correction table replaces
// them. A Chinese name that fell back to the bad native follows it.
export const repairCatalogNativeNames = async (transaction: Pick<PostgresDatabase, 'prepare'>): Promise<number> => {
  let changed = 0;
  // Existing databases gain the table here; schema.sql creates it for new ones.
  const repairsTable = await transaction.prepare(`SELECT COUNT(*) AS total FROM information_schema.tables
    WHERE table_name='catalog_native_repairs'`).first<{ total: number }>();
  if (!Number(repairsTable?.total || 0)) await transaction.prepare(catalogNativeRepairsSchema).run();
  for (const [table, kind] of [['catalog_regions', 'regions'], ['catalog_cities', 'cities']] as const) {
    const entries = Object.entries(catalogNativeCorrections[kind] as Record<string, string>);
    for (let offset = 0; offset < entries.length; offset += 500) {
      const chunk = new Map(entries.slice(offset, offset + 500));
      const ids = [...chunk.keys()].map(Number);
      const regionColumn = table === 'catalog_cities' ? 'region_id' : 'parent_id';
      const rows = (await transaction.prepare(`SELECT id,country_code,name,native_name,zh_name,${regionColumn} AS region_id
        FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids)
        .all<{ id: number; country_code: string; name: string; native_name: string; zh_name: string; region_id: number | null }>()).results || [];
      for (const row of rows) {
        const native = chunk.get(String(row.id));
        if (!native || native === row.native_name) continue;
        const chinese = row.zh_name === row.native_name && !/\p{Script=Han}/u.test(row.native_name || '') ? native : row.zh_name;
        await transaction.prepare(`UPDATE ${table} SET native_name=?,zh_name=? WHERE id=?`).bind(native, chinese, row.id).run();
        // Stored addresses filled with the old name are rewritten by the sync service.
        await transaction.prepare(`INSERT INTO catalog_native_repairs(table_name,catalog_id,country_code,region_id,old_native,
            new_native,english_name,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`)
          .bind(table, row.id, row.country_code, table === 'catalog_cities' ? row.region_id : row.id, row.native_name || '',
            native, row.name, new Date().toISOString()).run();
        changed += 1;
      }
    }
  }
  return changed;
};

const canonicalHongKongCatalog = async (database: PostgresDatabase): Promise<boolean> => {
  const [regions, districts, postcodes] = await Promise.all([
    database.prepare(`SELECT id,code,name,native_name,zh_name,type,parent_id,path FROM catalog_regions
      WHERE country_code='HK' ORDER BY id`).all<Record<string, unknown>>(),
    database.prepare(`SELECT id,region_id,name,native_name,zh_name,type FROM catalog_cities
      WHERE country_code='HK' ORDER BY id`).all<Record<string, unknown>>(),
    database.prepare("SELECT COUNT(*) AS total FROM catalog_postcodes WHERE country_code='HK'").first<{ total: number }>()
  ]);
  const expectedRegions = hongKongRegions.map((region) => ({
    id: region.id, code: region.code, name: region.name, native_name: region.native, zh_name: region.zh,
    type: 'region', parent_id: null, path: `/${region.id}/`
  }));
  const regionIds = new Map(hongKongRegions.map((region) => [region.code, region.id]));
  const expectedDistricts = hongKongDistricts.map((district) => ({
    id: district.id, region_id: regionIds.get(district.regionCode), name: district.name,
    native_name: district.native, zh_name: district.zh, type: 'district'
  }));
  return JSON.stringify(regions.results || []) === JSON.stringify(expectedRegions)
    && JSON.stringify(districts.results || []) === JSON.stringify(expectedDistricts)
    && Number(postcodes?.total || 0) === 0;
};

export const applyAdministrativeCatalogOverrides = async (database: PostgresDatabase): Promise<boolean> => {
  const catalogIsCanonical = await canonicalHongKongCatalog(database);
  const regionIds = new Map(hongKongRegions.map((region) => [region.code, region.id]));
  let changed = false;
  await database.transaction(async (transaction) => {
    const spanishRegions = (await transaction.prepare(`SELECT id,country_code,code,type,parent_id,path
      FROM catalog_regions WHERE country_code='ES'`).all<{
        id: number; country_code: string; code: string; type: string; parent_id: number | null; path: string;
      }>()).results;
    const corrected = correctSpanishProvinceParents(spanishRegions);
    const paths = catalogHierarchyPaths(corrected);
    const repairs = corrected.filter((region, index) => region.parent_id !== spanishRegions[index].parent_id
      || paths.get(region.id) !== spanishRegions[index].path);
    if (repairs.length) {
      await transaction.batch(repairs.map((region) => transaction.prepare(`UPDATE catalog_regions
        SET parent_id=?,path=? WHERE country_code='ES' AND id=?`).bind(region.parent_id, paths.get(region.id), region.id)));
      changed = true;
    }
    const cleanup = await transaction.prepare(`UPDATE address_pool SET
        locality=REPLACE(locality,' &',''), postal_locality=REPLACE(postal_locality,' &',''),
        component_variants_json=REPLACE(component_variants_json,'中西區 &','中西區'),
        address_variants_json=REPLACE(address_variants_json,'中西區 &','中西區')
      WHERE country_code='HK' AND (
        locality LIKE '%&' OR postal_locality LIKE '%&'
        OR component_variants_json LIKE '%中西區 &%' OR address_variants_json LIKE '%中西區 &%'
      )`).run();
    changed ||= Number(cleanup.meta?.changes || 0) > 0;
    await repairCatalogNativeNames(transaction);
    await repairCatalogChineseNames(transaction);
    if (catalogIsCanonical) return;
    changed = true;
    await transaction.prepare("DELETE FROM residential_coverage WHERE country_code='HK'").run();
    await transaction.prepare("DELETE FROM catalog_postcodes WHERE country_code='HK'").run();
    await transaction.prepare("DELETE FROM catalog_cities WHERE country_code='HK'").run();
    await transaction.prepare("DELETE FROM catalog_regions WHERE country_code='HK'").run();
    await transaction.batch(hongKongRegions.map((region) => transaction.prepare(`INSERT INTO catalog_regions(
        id,country_code,code,name,native_name,zh_name,type,parent_id,path,latitude,longitude
      ) VALUES (?,'HK',?,?,?,?, 'region',NULL,?,NULL,NULL)`).bind(
        region.id, region.code, region.name, region.native, region.zh, `/${region.id}/`
      )));
    await transaction.batch(hongKongDistricts.map((district) => transaction.prepare(`INSERT INTO catalog_cities(
        id,country_code,region_id,name,native_name,zh_name,type,population,latitude,longitude
      ) VALUES (?,'HK',?,?,?,?, 'district',NULL,NULL,NULL)`).bind(
        district.id, regionIds.get(district.regionCode), district.name, district.native, district.zh
      )));
  });
  return changed;
};
