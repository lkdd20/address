import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listAddressCoverage, refreshAddressCoverage } from '../server/control/coverage';
import { evaluateCountryGoals } from '../server/sync/country-goals.mjs';
import { applyAdministrativeCatalogOverrides } from '../server/database/administrative-catalog-overrides';
import { openTestDatabase, type PostgresDatabase } from './helpers/postgres-test-database.mjs';

describe('admin address coverage', () => {
  let database: PostgresDatabase;

  beforeEach(() => { database = openTestDatabase(':memory:'); });
  afterEach(() => database.close());

  it('keeps all countries visible after a China-only bootstrap and drill-down', async () => {
    await refreshAddressCoverage(database, { chinaOnly: true });
    expect(await listAddressCoverage(database, 'CN')).toEqual([]);
    const countries = await listAddressCoverage(database);
    expect(countries).toHaveLength(27);
    expect(new Set(countries.map((item) => item.countryCode)).size).toBe(27);
    expect(countries.every((item) => item.level === 0 && item.totalCount === 0)).toBe(true);
  });

  it('repairs Spanish self-parent provinces so every community reaches its cities without a cycle', async () => {
    for (const [province, community, provinceCode, communityCode, name] of [
      [1160, 5701, 'O', 'AS', 'Asturias'], [1170, 5702, 'S', 'CB', 'Cantabria'], [1171, 5703, 'LO', 'RI', 'La Rioja']
    ] as const) {
      await database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
        VALUES (?,'ES',?,?,?,?,'autonomous community',NULL,?),
          (?,'ES',?,?,?,?,'province',NULL,?)`).bind(community, communityCode, name, name, name, `/${community}/`,
          province, provinceCode, name, name, name, `/${province}/`).run();
      await database.prepare('UPDATE catalog_regions SET parent_id=id WHERE id=?').bind(province).run();
      await database.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name)
        VALUES (?,'ES',?,'Synthetic municipality','Synthetic municipality','Synthetic municipality')`).bind(province, province).run();
    }
    expect(await applyAdministrativeCatalogOverrides(database)).toBe(true);
    const communities = await listAddressCoverage(database, 'ES');
    expect(communities).toHaveLength(3);
    expect(communities.every((node) => node.childCount === 1)).toBe(true);
    for (const community of communities) {
      const provinces = await listAddressCoverage(database, community.key);
      expect(provinces).toHaveLength(1);
      expect(provinces[0]).toMatchObject({ level: 2, childCount: 1, totalCount: 0 });
      expect(provinces[0].key).not.toBe(community.key);
      const cities = await listAddressCoverage(database, provinces[0].key);
      expect(cities).toHaveLength(1);
      expect(cities[0]).toMatchObject({ level: 3, childCount: 0, totalCount: 0 });
      expect(cities[0].key).not.toBe(provinces[0].key);
    }
    expect(await applyAdministrativeCatalogOverrides(database)).toBe(false);
  });

  it('joins unique residential evidence instead of rescanning it for every address', async () => {
    const prepare = vi.spyOn(database, 'prepare');
    await refreshAddressCoverage(database);
    const [query] = prepare.mock.calls.find(([source]) => source.startsWith('INSERT INTO strict_pool_rows'))!;
    expect(query).toContain('LEFT JOIN (SELECT DISTINCT evidence.address_id');
    expect(query).toContain('residential.address_id IS NOT NULL');
    expect(query.split(' END')[0]).not.toContain('address_pool.id IN');
  });

  it('supports the migration fast path from the validated generation index', async () => {
    const prepare = vi.spyOn(database, 'prepare');
    await refreshAddressCoverage(database, { useGenerationIndex: true });
    const [query] = prepare.mock.calls.find(([source]) => source.startsWith('INSERT INTO strict_pool_rows'))!;
    expect(query).toContain('FROM address_generation_index generation');
    expect(query).not.toContain('component_variants_json');
  });

  it.each([false, true])('builds country-first China province, city, and district statistics (chinaOnly=%s)', async (chinaOnly) => {
    const now = new Date().toISOString();
    await database.batch([
      database.prepare(`INSERT INTO sync_country_policies(
        country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,updated_at
      ) VALUES ('CN',1,10,20,10,5,5,?)`).bind(now),
      database.prepare(`INSERT INTO sync_country_state(country_code,status,address_count,residential_count,updated_at)
        VALUES ('CN','ready',999,999,?)`).bind(now),
      database.prepare(`INSERT INTO cn_admin_areas(adcode,parent_adcode,level,name,full_path,source_version,updated_at)
        VALUES ('110000',NULL,'province','北京市','北京市','fixture',?)`).bind(now),
      database.prepare(`INSERT INTO cn_admin_areas(adcode,parent_adcode,level,name,full_path,source_version,updated_at)
        VALUES ('110100','110000','city','北京市','北京市/北京市','fixture',?)`).bind(now),
      database.prepare(`INSERT INTO cn_admin_areas(adcode,parent_adcode,level,name,full_path,source_version,updated_at)
        VALUES ('110105','110100','district','朝阳区','北京市/北京市/朝阳区','fixture',?)`).bind(now),
      database.prepare(`INSERT INTO cn_communities_v2(id,canonical_name,normalized_name,province,city,district,provider_address,
        longitude,latitude,verification_level,source_count,first_seen_at,last_seen_at,updated_at)
        VALUES ('community','望京花园','望京','北京市','北京市','朝阳区','阜通东大街6号',116.46,39.98,'L1',1,?,?,?)`).bind(now, now, now),
      database.prepare(`INSERT INTO cn_community_sources(provider,provider_poi_id,community_id,raw_name,raw_address,
        raw_longitude,raw_latitude,raw_crs,response_hash,first_seen_at,last_seen_at)
        VALUES ('amap','amap-poi','community','望京花园','阜通东大街6号',116.46,39.98,'GCJ-02',?,?,?)`)
        .bind('a'.repeat(64), now, now),
      database.prepare(`INSERT INTO address_sources(id,name,homepage_url,data_url,license_code,license_name,license_url,
        attribution_text,attribution_url,terms_url,share_alike,notice_required,redistribution_allowed,created_at,updated_at)
        VALUES ('cn-pool-source','Fixture','https://example.test','https://example.test/data','CC0','CC0','https://example.test/license',
        'Fixture','https://example.test','https://example.test/terms',0,0,1,?,?)`).bind(now, now),
      database.prepare(`INSERT INTO address_datasets(id,source_id,country_code,version,retrieved_at,imported_at,input_checksum,
        format,license_code,license_name,license_url,attribution_text,attribution_url,terms_url,share_alike,notice_required,
        redistribution_allowed,status) VALUES ('cn-pool-dataset','cn-pool-source','CN','fixture',?,?,?,'jsonl','CC0','CC0',
        'https://example.test/license','Fixture','https://example.test','https://example.test/terms',0,0,1,'active')`)
        .bind(now, now, 'b'.repeat(64))
    ]);
    for (const [id, houseNumber] of [['cn-pool-1', '1'], ['cn-pool-2', '2']]) {
      const components = {
        houseNumber, street: '阜通东大街', admin1: '北京市', locality: '北京市',
        postalLocality: '北京市', district: '朝阳区'
      };
      await database.prepare(`INSERT INTO address_pool(id,country_code,admin1,locality,postal_locality,district,street,
        house_number,latitude,longitude,native_language,component_variants_json,address_variants_json,property_type,
        quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at)
        VALUES (?,'CN','北京市','北京市','北京市','朝阳区','阜通东大街',?,39.98,116.46,'zh-CN',?,?,
        'residential',.95,'fixture','CN:北京市:北京市',1,1,?,?)`)
        .bind(id, houseNumber, JSON.stringify({ native: components, en: components, 'zh-CN': components }),
          JSON.stringify({ native: `北京市朝阳区阜通东大街${houseNumber}号`, en: `${houseNumber} Futong East Street`, 'zh-CN': `北京市朝阳区阜通东大街${houseNumber}号` }),
          now, now).run();
      await database.batch(['address_existence', 'residential_use'].map((type, index) => database.prepare(`
        INSERT INTO address_pool_evidence(id,address_id,dataset_id,source_record_id,observed_at,evidence_type,
          is_primary,is_current,created_at) VALUES (?,?,?,?,?,?,?,1,?)`)
        .bind(`${id}-${type}`, id, 'cn-pool-dataset', id, now, type, index === 0 ? 1 : 0, now)));
    }
    await refreshAddressCoverage(database, { chinaOnly });
    const countries = await listAddressCoverage(database);
    const china = countries.find((item) => item.countryCode === 'CN');
    expect(china).toMatchObject({ regionName: '中国', residentialCount: 1, totalCount: 1, childCount: 1 });
    expect(await database.prepare(`SELECT address_count,residential_count FROM sync_country_state WHERE country_code='CN'`).first())
      .toEqual({ address_count: 1, residential_count: 1 });
    const goal = (await evaluateCountryGoals(database)).get('CN');
    expect(goal?.current).toBe(1);
    expect(goal?.rules).toMatchObject({
      total: { current: 1, target: 10, met: false },
      administrativeCoverage: { actual: 1, target: 1, met: true, covered: 1, total: 1 },
      regionalMinimums: {
        actual: 0, target: 1, met: false,
        lowest: { minimum: 5, qualified: 0, total: 1 },
        overrides: { satisfied: 0, total: 0, met: true }
      }
    });
    const provinces = await listAddressCoverage(database, china?.key);
    expect(provinces[0]).toMatchObject({ regionName: '北京市', levelLabel: '省级', residentialCount: 1 });
    const cities = await listAddressCoverage(database, provinces[0].key);
    expect(cities[0]).toMatchObject({ regionName: '北京市', levelLabel: '地级市', residentialCount: 1 });
    const districts = await listAddressCoverage(database, cities[0].key);
    expect(districts[0]).toMatchObject({ regionName: '朝阳区', levelLabel: '区县', residentialCount: 1 });
  });

  it.each([0, 1])('repairs China-only projections with %i published rows without touching other countries', async (published) => {
    const now = new Date().toISOString();
    await database.batch([
      database.prepare(`INSERT INTO sync_country_state(country_code,status,address_count,residential_count,updated_at)
        VALUES ('CN','ready',9,9,?),('US','ready',42,32,?)`).bind(now, now),
      database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_name,
        ordinary_count,residential_count,total_count,child_count,updated_at)
        VALUES ('CN','','CN',0,'中国',0,9,9,1,?),('CN:obsolete','CN','CN',1,'旧节点',0,9,9,0,?),
          ('US','','US',0,'美国',10,32,42,1,?),('US:fixture','US','US',1,'Fixture',10,32,42,0,?)`)
        .bind(now, now, now, now),
      ...[
        ['110000', null, 'province', '北京市'], ['110100', '110000', 'city', '北京市'],
        ['110105', '110100', 'district', '朝阳区'], ['110108', '110100', 'district', '海淀区']
      ].map(([code, parent, level, name]) => database.prepare(`INSERT INTO cn_admin_areas(
        adcode,parent_adcode,level,name,full_path,source_version,updated_at) VALUES (?,?,?,?,?,'fixture',?)`)
        .bind(code, parent, level, name, name, now)),
      database.prepare(`INSERT INTO cn_communities_v2(id,canonical_name,normalized_name,province,city,district,
        postcode,provider_address,longitude,latitude,active,first_seen_at,last_seen_at,updated_at)
        VALUES ('cn-fixture','望京花园','望京','北京市','北京市','朝阳区','100102','阜通东大街6号',116.46,39.98,?,?,?,?)`)
        .bind(published, now, now, now),
      database.prepare(`INSERT INTO cn_community_sources(provider,provider_poi_id,community_id,raw_name,
        raw_longitude,raw_latitude,raw_crs,response_hash,first_seen_at,last_seen_at)
        VALUES ('amap','cn-fixture','cn-fixture','望京花园',116.46,39.98,'GCJ-02',?,?,?)`)
        .bind('a'.repeat(64), now, now)
    ]);
    const otherCoverage = await database.prepare("SELECT * FROM admin_coverage_stats WHERE country_code='US' ORDER BY node_key").all();
    const otherState = await database.prepare("SELECT * FROM sync_country_state WHERE country_code='US'").first();
    const prepare = vi.spyOn(database, 'prepare');
    await refreshAddressCoverage(database, { chinaOnly: true });
    expect(await database.prepare("SELECT * FROM admin_coverage_stats WHERE country_code='US' ORDER BY node_key").all())
      .toMatchObject({ results: otherCoverage.results });
    expect(await database.prepare("SELECT * FROM sync_country_state WHERE country_code='US'").first()).toEqual(otherState);
    expect(prepare.mock.calls.some(([query]) => /\baddress_pool\b|\baddress_generation_index\b/u.test(query))).toBe(false);
    expect(prepare.mock.calls.filter(([query]) => query.includes('FROM cn_communities_v2'))).toHaveLength(1);
    expect(await database.prepare("SELECT address_count,residential_count FROM sync_country_state WHERE country_code='CN'").first())
      .toEqual({ address_count: published, residential_count: published });
    expect(await database.prepare("SELECT total_count,residential_count,child_count FROM admin_coverage_stats WHERE node_key='CN'").first())
      .toEqual({ total_count: published, residential_count: published, child_count: 1 });
    expect(await database.prepare("SELECT region_code,total_count FROM admin_coverage_stats WHERE country_code='CN' AND level=3 ORDER BY region_code").all())
      .toMatchObject({ results: [{ region_code: '110105', total_count: published }, { region_code: '110108', total_count: 0 }] });
    expect(await database.prepare("SELECT node_key FROM admin_coverage_stats WHERE node_key='CN:obsolete'").first()).toBeNull();
    const first = (await database.prepare("SELECT node_key,total_count,residential_count,child_count FROM admin_coverage_stats WHERE country_code='CN' ORDER BY node_key").all()).results;
    await refreshAddressCoverage(database, { chinaOnly: true });
    expect((await database.prepare("SELECT node_key,total_count,residential_count,child_count FROM admin_coverage_stats WHERE country_code='CN' ORDER BY node_key").all()).results).toEqual(first);
  });

  it('reports official per-level ratios and drills through covered catalog nodes', async () => {
    const now = new Date().toISOString();
    await database.batch([
      database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
        VALUES (1,'US','NY','New York','New York','纽约州','state',NULL,'/1')`),
      database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
        VALUES (2,'US','CA','California','California','加利福尼亚州','state',NULL,'/2')`),
      database.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population)
        VALUES (11,'US',1,'New York City','New York City','纽约市','city',8000000)`),
      database.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population)
        VALUES (12,'US',2,'Los Angeles','Los Angeles','洛杉矶','city',3900000)`),
      database.prepare(`INSERT INTO residential_coverage(country_code,region_name,city_name,address_count,last_verified_at,region_id,city_id)
        VALUES ('US','New York','New York City',3,?,1,11)`).bind(now),
      database.prepare(`INSERT INTO residential_coverage(country_code,region_name,city_name,address_count,last_verified_at,region_id,city_id)
        VALUES ('US','California','Los Angeles',6,?,2,12)`).bind(now)
    ]);
    await refreshAddressCoverage(database);
    const countries = await listAddressCoverage(database);
    const unitedStates = countries.find((item) => item.countryCode === 'US');
    expect(unitedStates).toMatchObject({ childCount: 2 });
    expect(unitedStates?.coverageLevels).toEqual([
      expect.objectContaining({ labelEn: 'State', covered: 2, qualified: 1, total: 2 }),
      expect.objectContaining({ labelEn: 'City', covered: 2, qualified: 1, total: 2 })
    ]);
    const states = await listAddressCoverage(database, 'US');
    expect(states.map((item) => item.regionNameEn)).toEqual(['California', 'New York']);
    const california = states.find((item) => item.regionCode === 'CA');
    expect(california).toMatchObject({ residentialCount: 6, childCount: 1 });
    const cities = await listAddressCoverage(database, california?.key);
    expect(cities[0]).toMatchObject({ regionNameEn: 'Los Angeles', residentialCount: 6, childCount: 0 });
  });

  it('uses zero-address catalog nodes in the all-country goal denominator', async () => {
    const now = new Date().toISOString();
    await database.batch([
      database.prepare(`INSERT INTO sync_country_policies(
        country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,min_per_node,coverage_ratio,level1_min,level2_min,updated_at
      ) VALUES ('NL',1,1,10,10,10,10,1,1,0,0,?)`).bind(now),
      database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
        VALUES (21,'NL','NH','Noord-Holland','Noord-Holland','北荷兰省','province',NULL,'/21')`),
      database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
        VALUES (22,'NL','ZH','Zuid-Holland','Zuid-Holland','南荷兰省','province',NULL,'/22')`),
      database.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population)
        VALUES (211,'NL',21,'Amsterdam','Amsterdam','阿姆斯特丹','municipality',900000)`),
      database.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population)
        VALUES (221,'NL',22,'Rotterdam','Rotterdam','鹿特丹','municipality',650000)`),
      database.prepare(`INSERT INTO residential_coverage(country_code,region_name,city_name,address_count,last_verified_at,region_id,city_id)
        VALUES ('NL','Noord-Holland','Amsterdam',4,?,21,211)`).bind(now)
    ]);
    const goal = (await evaluateCountryGoals(database)).get('NL');
    expect(goal?.rules.administrativeCoverage).toMatchObject({ covered: 1, total: 2, met: false });
    expect(goal?.rules.regionalMinimums.lowest).toMatchObject({ total: 2, qualified: 1 });
    expect(goal?.unmetRules).toEqual(['total', 'administrative_coverage', 'regional_minimums']);
    expect(goal?.complete).toBe(false);
    const regions = await listAddressCoverage(database, 'NL');
    const emptyRegion = regions.find((region) => region.regionCode === 'ZH');
    expect(emptyRegion).toMatchObject({ childCount: 1, totalCount: 0 });
    expect(await listAddressCoverage(database, emptyRegion!.key)).toEqual([
      expect.objectContaining({ key: 'catalog-city:221', regionNameEn: 'Rotterdam', level: 2,
        totalCount: 0, residentialCount: 0, childCount: 0 })
    ]);
  });

  it('counts catalog cities from mixed-depth branches in one lowest-level denominator', async () => {
    const now = new Date().toISOString();
    await database.batch([
      database.prepare(`INSERT INTO sync_country_policies(
        country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,min_per_node,coverage_ratio,level1_min,level2_min,updated_at
      ) VALUES ('PH',1,1,10,10,10,10,1,1,0,0,?)`).bind(now),
      database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
        VALUES (31,'PH','A','Region A','Region A','甲区','region',NULL,'/31')`),
      database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
        VALUES (32,'PH','A1','Province A','Province A','甲省','province',31,'/31/32')`),
      database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
        VALUES (33,'PH','B','Region B','Region B','乙区','region',NULL,'/33')`),
      database.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population)
        VALUES (311,'PH',32,'Deep City','Deep City','深层市','city',100)`),
      database.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population)
        VALUES (312,'PH',33,'Shallow City','Shallow City','浅层市','city',100)`),
      database.prepare(`INSERT INTO residential_coverage(country_code,region_name,city_name,address_count,last_verified_at,region_id,city_id)
        VALUES ('PH','Province A','Deep City',1,?,32,311)`).bind(now)
    ]);
    const goal = (await evaluateCountryGoals(database)).get('PH');
    expect(goal?.rules.administrativeCoverage).toMatchObject({ covered: 1, total: 2, met: false });
    expect(goal?.rules.regionalMinimums.lowest).toMatchObject({ total: 2, qualified: 1 });
  });
});
