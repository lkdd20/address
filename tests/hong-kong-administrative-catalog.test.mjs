import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { applyAdministrativeCatalogOverrides } from '../server/database/administrative-catalog-overrides';
import { queryLocationCatalog } from '../server/api/repositories/location-catalog';
import { evaluateCountryGoals } from '../server/sync/country-goals.mjs';
import {
  hongKongDistricts,
  hongKongRegions,
  validateHongKongAdministrativeHierarchy
} from '../src/domain/hk-administrative-divisions.mjs';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';
import { deriveAdministrativeAssignment } from '../server/database/administrative-assignments.mjs';

const regions = JSON.parse(await readFile(new URL('../src/domain/regions.json', import.meta.url), 'utf8'));

describe('Hong Kong administrative catalog', () => {
  it('keeps ambiguous country and town labels separate from administrative evidence', () => {
    expect(deriveAdministrativeAssignment({ country_code: 'SG', admin1: 'Singapore', locality: 'Tampines' },
      [{ id: 1, code: '01', name: 'Central Singapore' }], [{ id: 1, region_id: 1, name: 'Singapore' }]))
      .toMatchObject({ status: 'unresolved', reason: 'authoritative_boundary_unavailable', regionId: null, patch: {} });
    expect(deriveAdministrativeAssignment({ country_code: 'HK', admin1: 'Kowloon', locality: 'Wan Chai' }, [], []))
      .toMatchObject({ status: 'conflict', reason: 'conflicting_official_region', patch: {} });
  });
  it('does not let one Singapore administrative field override conflicting source evidence', () => {
    const catalog = [{ id: 1, code: '01', name: 'Central Singapore' }, { id: 2, code: '02', name: 'North East' }];
    for (const row of [
      { admin1_code: '01', admin1: 'North East' },
      { admin1_code: '01', admin1: 'Singapore', component_variants_json: JSON.stringify({ native: { admin1Code: '02' } }) }
    ]) expect(deriveAdministrativeAssignment({ country_code: 'SG', ...row }, catalog, []))
      .toMatchObject({ status: 'conflict', reason: 'conflicting_official_region', patch: {} });
    expect(deriveAdministrativeAssignment({ country_code: 'SG', admin1_code: '01', admin1: 'Unverified district' }, catalog, []))
      .toMatchObject({ status: 'unresolved', reason: 'official_region_unresolved', patch: {} });
    expect(deriveAdministrativeAssignment({ country_code: 'SG', admin1_code: '01', admin1: 'Singapore' }, catalog, []))
      .toMatchObject({ status: 'verified', regionId: 1, cityId: null });
  });
  it('preserves an unrecognized Hong Kong parent and checks native region codes', () => {
    const row = { country_code: 'HK', locality: 'Kwun Tong', admin1: 'Unverified region' };
    const catalog = hongKongRegions.map((region) => ({ ...region, native_name: region.native, zh_name: region.zh }));
    const cities = hongKongDistricts.map((district) => ({ ...district,
      region_id: hongKongRegions.find((region) => region.code === district.regionCode).id }));
    expect(deriveAdministrativeAssignment(row, catalog, cities))
      .toMatchObject({ status: 'unresolved', reason: 'official_region_unresolved', patch: {} });
    expect(deriveAdministrativeAssignment({ ...row, admin1: 'Hong Kong',
      component_variants_json: JSON.stringify({ native: { admin1Code: 'HK' } }) }, catalog, cities))
      .toMatchObject({ status: 'conflict', reason: 'conflicting_official_region', patch: {} });
  });
  it('recognizes source-catalog district aliases without treating them as geographic regions', () => {
    const catalog = hongKongRegions.map((region) => ({ ...region, native_name: region.native, zh_name: region.zh }));
    const cities = hongKongDistricts.map((district) => ({ ...district,
      region_id: hongKongRegions.find((region) => region.code === district.regionCode).id }));
    const row = { country_code: 'HK', admin1: 'Kwun Tong', admin1_code: 'KKT', locality: '觀塘區',
      component_variants_json: JSON.stringify({ native: { admin1: '觀塘區', admin1Code: 'KKT' } }) };
    expect(deriveAdministrativeAssignment(row, catalog, cities))
      .toMatchObject({ status: 'verified', regionId: 344_001_002, cityId: 344_002_006 });
    expect(deriveAdministrativeAssignment({ ...row, admin1_code: 'HWC' }, catalog, cities))
      .toMatchObject({ status: 'conflict', reason: 'conflicting_official_districts', patch: {} });
    expect(deriveAdministrativeAssignment({ ...row, admin1_code: 'ZZZ' }, catalog, cities))
      .toMatchObject({ status: 'unresolved', reason: 'official_region_unresolved', patch: {} });
  });
  it('uses the three official geographic regions as first-level divisions', () => {
    expect(regions.filter((region) => region.countryCode === 'HK')).toEqual([
      { countryCode: 'HK', name: 'Hong Kong Island', native: '香港島', zh: '香港岛', code: 'HK' },
      { countryCode: 'HK', name: 'Kowloon', native: '九龍', zh: '九龙', code: 'KLN' },
      { countryCode: 'HK', name: 'New Territories', native: '新界', zh: '新界', code: 'NT' }
    ]);
  });

  it('defines all 18 official districts with the correct geographic region', () => {
    expect(hongKongRegions.map(({ code }) => code)).toEqual(['HK', 'KLN', 'NT']);
    expect(hongKongDistricts).toHaveLength(18);
    expect(new Set(hongKongDistricts.map(({ code }) => code))).toEqual(new Set([
      'CW', 'EST', 'ILD', 'KLC', 'KC', 'KT', 'NTH', 'SK', 'ST', 'SSP', 'STH', 'TP', 'TW', 'TM', 'WC', 'WTS', 'YTM', 'YL'
    ]));
    expect(hongKongDistricts.filter(({ regionCode }) => regionCode === 'HK').map(({ native }) => native))
      .toEqual(['中西區', '東區', '南區', '灣仔區']);
    expect(hongKongDistricts.filter(({ regionCode }) => regionCode === 'KLN').map(({ native }) => native))
      .toEqual(['九龍城區', '觀塘區', '深水埗區', '黃大仙區', '油尖旺區']);
    expect(hongKongDistricts.filter(({ regionCode }) => regionCode === 'NT')).toHaveLength(9);
  });

  it('rejects neighborhoods and mismatched region/district pairs', () => {
    expect(validateHongKongAdministrativeHierarchy('香港島', '灣仔區')).toEqual({ valid: true });
    expect(validateHongKongAdministrativeHierarchy('Hong Kong', 'Wan Chai District')).toEqual({ valid: true });
    expect(validateHongKongAdministrativeHierarchy('九龍', '灣仔區')).toEqual({
      valid: false, reason: 'mismatched-hk-hierarchy'
    });
    expect(validateHongKongAdministrativeHierarchy('香港島', '金鐘')).toEqual({
      valid: false, reason: 'invalid-hk-district'
    });
  });

  it('corrects literal catalog Chinese names without reporting a Hong Kong change', async () => {
    const database = openTestDatabase(':memory:');
    try {
      await database.batch([
        database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
          VALUES (10,'TR','16','Bursa','Bursa','囊','province',NULL,'/10/'),(11,'AU','QLD','Queensland','Queensland','昆士兰州','state',NULL,'/11/')`),
        database.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population)
          VALUES (12,'AU',11,'Emerald','Emerald','翠','city',NULL),(13,'AU',11,'Brisbane','Brisbane','布里斯班','city',NULL),
            (14,'JP',NULL,'Tsu','津','津','city',NULL)`)
      ]);
      await applyAdministrativeCatalogOverrides(database);
      expect(await applyAdministrativeCatalogOverrides(database)).toBe(false);
      expect(await database.prepare('SELECT zh_name FROM catalog_regions WHERE id=10').first('zh_name')).toBe('布尔萨');
      expect(await database.prepare('SELECT zh_name FROM catalog_regions WHERE id=11').first('zh_name')).toBe('昆士兰州');
      expect((await database.prepare('SELECT id,zh_name FROM catalog_cities WHERE id IN (12,13,14) ORDER BY id').all()).results)
        .toEqual([{ id: 12, zh_name: 'Emerald' }, { id: 13, zh_name: '布里斯班' }, { id: 14, zh_name: '津' }]);
    } finally {
      await database.close();
    }
  });

  it('restores truncated China city names and moves Jiangsu cities out of the Taiwan province', async () => {
    const database = openTestDatabase(':memory:');
    try {
      await database.batch([
        database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
          VALUES (20,'CN','TW','Taiwan','台湾','台湾','province',NULL,'/20/'),(21,'CN','JS','Jiangsu','江苏省','江苏省','province',NULL,'/21/'),
            (22,'CN','ZJ','Zhejiang','浙江省','浙江省','province',NULL,'/22/')`),
        database.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population,latitude,longitude)
          VALUES (30,'CN',22,'Taizhou','台州','台','prefecture',NULL,28.658,121.416),
            (31,'CN',20,'Taizhou','台州','台','adm3',NULL,32.491,119.908),
            (32,'CN',20,'Nanjing','南京','南京','adm1',NULL,32.061,118.778),
            (33,'CN',20,'Kaohsiung','高雄','高雄','city',NULL,22.620,120.312),
            (34,'CN',20,'Zhenzhou','郑州','郑','adm3',NULL,32.280,119.170)`)
      ]);
      await applyAdministrativeCatalogOverrides(database);
      expect((await database.prepare('SELECT id,region_id,native_name,zh_name FROM catalog_cities WHERE id BETWEEN 30 AND 34 ORDER BY id').all()).results)
        .toEqual([
          { id: 30, region_id: 22, native_name: '台州', zh_name: '台州' },
          { id: 31, region_id: 21, native_name: '泰州', zh_name: '泰州' },
          { id: 32, region_id: 21, native_name: '南京', zh_name: '南京' },
          { id: 33, region_id: 20, native_name: '高雄', zh_name: '高雄' },
          { id: 34, region_id: 21, native_name: '真州', zh_name: '真州' }
        ]);
    } finally {
      await database.close();
    }
  });

  it('replaces a legacy catalog and scopes filters and coverage to the official hierarchy', async () => {
    const database = openTestDatabase(':memory:');
    const now = new Date().toISOString();
    try {
      await database.batch([
        database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
          VALUES (1,'HK','HWC','Wan Chai','Wan Chai','湾仔','district',NULL,'/1/')`),
        database.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population)
          VALUES (2,'HK',1,'Admiralty','金鐘','金钟','city',NULL)`),
        database.prepare(`INSERT INTO sync_country_policies(
          country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,
          min_per_node,coverage_ratio,level1_min,level2_min,updated_at
        ) VALUES ('HK',1,20000,10000,2000,300,0,1,1,0,0,?)`).bind(now)
      ]);
      expect(await applyAdministrativeCatalogOverrides(database)).toBe(true);
      expect(await applyAdministrativeCatalogOverrides(database)).toBe(false);

      const regionCount = await database.prepare("SELECT COUNT(*) AS total FROM catalog_regions WHERE country_code='HK'").first();
      const districtCount = await database.prepare("SELECT COUNT(*) AS total FROM catalog_cities WHERE country_code='HK'").first();
      expect(Number(regionCount.total)).toBe(3);
      expect(Number(districtCount.total)).toBe(18);

      const hongKongIsland = hongKongRegions.find(({ code }) => code === 'HK');
      const wanChai = hongKongDistricts.find(({ code }) => code === 'WC');
      await database.prepare(`INSERT INTO residential_coverage(
        country_code,region_name,city_name,address_count,last_verified_at,region_id,city_id
      ) VALUES ('HK',?,?,?,?,?,?)`).bind(
        hongKongIsland.name, wanChai.name, 10, now, hongKongIsland.id, wanChai.id
      ).run();
      await database.exec(`INSERT INTO address_pool(id,country_code,street,latitude,longitude,native_language,
        component_variants_json,address_variants_json,quality_score,generation,coverage,random_key,first_seen_at,last_seen_at)
        VALUES ('hierarchy-fixture','HK','Fixture Road',22,114,'zh-Hant','{}','{}',.95,'fixture','fixture',1,'2026-01-01','2026-01-01');`);
      await database.prepare(`INSERT INTO address_generation_index(address_id,country_code,admin1_key,locality_key,residential_ready,random_key,updated_at)
        VALUES ('hierarchy-fixture','HK',?,?,1,1,'2026-01-01')`).bind(hongKongIsland.name.toLowerCase(), wanChai.name.toLowerCase()).run();

      const regionsPage = await queryLocationCatalog(database, { country: 'HK', field: 'region', residential: false });
      expect(regionsPage.options.map(({ native }) => native)).toEqual(['香港島']);
      expect(regionsPage.options[0].availableCount).toBe(1);
      const districtsPage = await queryLocationCatalog(database, {
        country: 'HK', field: 'city', regionId: String(hongKongIsland.id), residential: false
      });
      expect(districtsPage.options.map(({ native }) => native)).toEqual(['灣仔區']);
      expect(districtsPage.options.some(({ native }) => native === '金鐘')).toBe(false);

      const goal = (await evaluateCountryGoals(database)).get('HK');
      expect(goal.rules.administrativeCoverage).toMatchObject({ covered: 1, total: 18, met: false });
      expect(goal.rules.regionalMinimums.lowest).toMatchObject({ qualified: 1, total: 18 });
    } finally {
      await database.close();
    }
  });
});
