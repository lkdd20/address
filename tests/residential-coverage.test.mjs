import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { initializeTestDatabase, openTestDatabase } from './helpers/postgres-test-database.mjs';
import { refreshResidentialCoverage, refreshIndexedResidentialCoverage } from '../server/database/residential-coverage.mjs';
import { refreshAddressGenerationIndex } from '../server/database/generation-index.mjs';
import { reconcilePublishedPoolProjections, refreshCountryCounts } from '../server/database/published-pool.mjs';
import { createSyncRuntime } from '../server/sync/index.mjs';
import { queryLocationCatalog } from '../server/api/repositories/location-catalog';

describe('coverage administrative identity', () => {
  const project = async (regions, cities, group, country = 'US') => {
    const rows = [];
    const database = {
      prepare: (sql) => ({ bind: (...values) => ({ sql, values, run: async () => ({}),
        all: async () => ({ results: sql.includes('FROM catalog_regions') ? regions
          : sql.includes('FROM catalog_cities') ? cities
            : [{ address_count: 1, residential_count: 1, ...group }] }) }) }),
      batch: async (statements) => rows.push(...statements.map(({ values }) => ({
        regionId: values[5], cityId: values[6], total: values[7]
      })))
    };
    const summary = await refreshResidentialCoverage(database, country, '2026-09-13', undefined,
      { useGenerationIndex: true, inTransaction: true });
    return { rows, summary };
  };
  const regions = [
    { id: 1, code: 'NY', name: 'New York', path: '/1' },
    { id: 2, code: 'CA', name: 'California', path: '/2' }
  ];

  it('never overrides an explicit source state with a city in another state', async () => {
    const result = await project(regions, [{ id: 11, region_id: 2, name: 'Fixture City', population: 1000 }],
      { admin1: 'New York', admin1_code: 'NY', city_name: 'Fixture City' });
    expect(result.rows).toEqual([{ regionId: 1, cityId: null, total: 1 }]);
  });

  it('does not decide between same-name cities by population', async () => {
    const result = await project(regions, [
      { id: 11, region_id: 1, name: 'Fixture City', population: 1000 },
      { id: 12, region_id: 1, name: 'Fixture City', population: 10 }
    ], { admin1: 'New York', admin1_code: 'NY', city_name: 'Fixture City' });
    expect(result.rows).toEqual([{ regionId: 1, cityId: null, total: 1 }]);
  });

  it('does not arbitrarily resolve an ambiguous region alias', async () => {
    const result = await project(regions.map((region) => ({ ...region, name: 'Same State' })), [],
      { admin1: 'Same State', city_name: '' });
    expect(result.rows).toEqual([]);
    expect(result.summary.unmatchedAddresses).toBe(1);
  });

  it('does not discard an unrecognized explicit region to match a city elsewhere', async () => {
    const result = await project(regions, [{ id: 11, region_id: 2, name: 'Fixture City' }],
      { admin1: 'Unresolved State', city_name: 'Fixture City' });
    expect(result.rows).toEqual([]);
  });

  it.each(['/1', '/1/'])('recognizes the child region under parent path %s', async (path) => {
    const result = await project([...regions.map((region) => region.id === 1 ? { ...region, path } : region),
      { id: 3, code: 'NY-1', name: 'Fixture County', parent_id: 1, path: '/1/3/' }
    ], [
      { id: 11, region_id: 3, name: 'Fixture City', population: 10 },
      { id: 12, region_id: 2, name: 'Fixture City', population: 1000 }
    ], { admin1: 'New York', admin1_code: 'NY', city_name: 'Fixture City' });
    expect(result.rows).toEqual([{ regionId: 3, cityId: 11, total: 1 }]);
  });

  it('never treats an empty region path as an ancestor of every region', async () => {
    const result = await project(regions.map((region) => ({ ...region, path: '' })),
      [{ id: 11, region_id: 2, name: 'Fixture City' }],
      { admin1: 'New York', admin1_code: 'NY', city_name: 'Fixture City' });
    expect(result.rows).toEqual([{ regionId: 1, cityId: null, total: 1 }]);
  });

  it.each([
    ['JP', '02', 'Aomori', '青森', '青森县', '青森県', 'prefecture'],
    ['KR', '11', 'Seoul', '서울', '', '서울특별시', 'city'],
    ['KR', '50', 'Sejong City', '세종시', '', '세종특별자치시', 'city'],
    ['SA', '01', 'Riyadh', 'الرياض', '', 'منطقة الرياض', 'region'],
    ['VN', 'HN', 'Hà Nội', 'Hà Nội', '', 'Thành phố Hà Nội', 'municipality'],
    ['IN', 'JK', 'Jammu and Kashmir', '', '', 'Jammu & Kashmir', 'territory']
  ])('maps the unique %s administrative spelling without a supplier request', async (country, code, name, native_name, zh_name, admin1, type) => {
    const result = await project([{ id: 1, code, name, native_name, zh_name, type, path: '/1/' }], [],
      { admin1, city_name: '' }, country);
    expect(result.rows).toEqual([{ regionId: 1, cityId: null, total: 1 }]);
  });

  it.each([['新竹市', 1], ['新竹縣', 2], ['新竹县', 2]])('keeps Taiwan city and county identities separate for %s', async (admin1, regionId) => {
    const result = await project([
      { id: 1, code: 'HSZ', name: 'Hsinchu', zh_name: '新竹', type: 'city', path: '/1/' },
      { id: 2, code: 'HSQ', name: 'Hsinchu County', native_name: '新竹縣', zh_name: '新竹县', type: 'county', path: '/2/' }
    ], [], { admin1, city_name: '' }, 'TW');
    expect(result.rows).toEqual([{ regionId, cityId: null, total: 1 }]);
  });

  it('resolves traditional and simplified Taiwan names within the known county', async () => {
    const result = await project([{ id: 1, code: 'TXG', name: 'Taichung', zh_name: '台中',
      type: 'special municipality', path: '/1/' }],
    [{ id: 11, region_id: 1, name: 'Xitun', native_name: '西屯區' }],
    { admin1: '臺中市', city_name: '西屯区' }, 'TW');
    expect(result.rows).toEqual([{ regionId: 1, cityId: 11, total: 1 }]);
  });
});

describe('published residential coverage', () => {
  let database;
  const now = '2026-07-29T00:00:00.000Z';

  beforeEach(async () => {
    database = openTestDatabase(':memory:');
    await database.batch([
      database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
        VALUES (1,'US','NY','New York','New York','纽约州','state',NULL,'/1')`),
      database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
        VALUES (2,'US','CA','California','California','加利福尼亚州','state',NULL,'/2')`),
      database.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population)
        VALUES (11,'US',1,'New York City','New York City','纽约市','city',8000000)`),
      database.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population)
        VALUES (12,'US',2,'Los Angeles','Los Angeles','洛杉矶','city',3900000)`),
      database.prepare(`INSERT INTO address_sources(id,name,homepage_url,data_url,license_code,license_name,license_url,
        attribution_text,attribution_url,terms_url,share_alike,notice_required,redistribution_allowed,created_at,updated_at)
        VALUES ('source','Fixture','https://example.test','https://example.test/data','CC0','CC0','https://example.test/license',
        'Fixture','https://example.test','https://example.test/terms',0,0,1,?,?)`).bind(now, now),
      database.prepare(`INSERT INTO address_datasets(id,source_id,country_code,version,retrieved_at,imported_at,input_checksum,
        format,license_code,license_name,license_url,attribution_text,attribution_url,terms_url,share_alike,notice_required,
        redistribution_allowed,status) VALUES ('dataset','source','US','fixture',?,?,?,'jsonl','CC0','CC0',
        'https://example.test/license','Fixture','https://example.test','https://example.test/terms',0,0,1,'active')`)
        .bind(now, now, 'a'.repeat(64)),
      database.prepare(`INSERT INTO admin_coverage_stats(
        node_key,parent_key,country_code,level,region_name,residential_count,total_count,updated_at
      ) VALUES ('US','','US',0,'United States',0,0,?)`).bind(now)
    ]);
    for (const [id, admin1, city, postcode, longitude, zhAdmin1, zhCity] of [
      ['ny', 'New York', 'New York City', '10001', -73.99, '纽约州', '纽约市'],
      ['ca', 'California', 'Los Angeles', '90001', -118.24, '加利福尼亚州', '洛杉矶']
    ]) {
      const components = { houseNumber: '1', street: 'Main Street', locality: city, postalLocality: city, admin1, postcode };
      await database.prepare(`INSERT INTO address_pool(id,country_code,admin1,locality,postal_locality,postcode,street,
        house_number,latitude,longitude,native_language,component_variants_json,address_variants_json,property_type,
        quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at)
        VALUES (?,'US',?,?,?,?, 'Main Street','1',40,?,'en',?,?,'residential',.95,'fixture',?,1,1,?,?)`)
        .bind(id, admin1, city, city, postcode, longitude, JSON.stringify({
          native: components, en: components, 'zh-CN': { ...components, street: '主街', locality: zhCity, admin1: zhAdmin1 }
        }), JSON.stringify({ native: '1 Main Street', en: '1 Main Street', 'zh-CN': '主街1号' }), `${admin1}:${city}`, now, now).run();
      await database.batch(['address_existence', 'residential_use'].map((type, index) => database.prepare(`
        INSERT INTO address_pool_evidence(id,address_id,dataset_id,source_record_id,observed_at,evidence_type,
          is_primary,is_current,created_at) VALUES (?,?,?,?,?,?,?,1,?)`)
        .bind(`${id}-${type}`, id, 'dataset', id, now, type, index === 0 ? 1 : 0, now)));
    }
  });
  afterEach(() => database.close());

  it.each(['admin_total', 'admin_residential', 'index', 'missing_counts', 'empty_pool'])(
    'repairs %s at sync startup without reopening sources or validation checkpoints', async (fault) => {
    const stateDir = resolve('.data-cache', 'coverage-startup-tests', randomUUID());
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    await refreshAddressGenerationIndex(database, 'US');
    await database.batch([
      database.prepare(`UPDATE admin_coverage_stats SET total_count=2,residential_count=2 WHERE node_key='US'`),
      database.prepare(`INSERT INTO sync_country_state(country_code,address_count,residential_count,updated_at)
        VALUES ('US',2,2,?)`).bind(now),
      database.prepare(`INSERT INTO sync_source_execution_state(country_code,source_id,state,source_fingerprint,updated_at)
        VALUES ('US','fixture','exhausted','unchanged-source-input',?)`).bind(now),
      database.prepare(`INSERT INTO publication_validation_state(id,revision,country_code,last_id,completed_at,updated_at)
        VALUES (1,'address-reader-v4-index-consistency','ZA','',?,?)`).bind(now, now)
    ]);
    const sourceState = await database.prepare('SELECT * FROM sync_source_execution_state').first();
    const validationState = await database.prepare('SELECT * FROM publication_validation_state').first();
    if (fault === 'admin_total') await database.prepare(`UPDATE admin_coverage_stats SET total_count=0,residential_count=0 WHERE node_key='US'`).run();
    if (fault === 'admin_residential') await database.prepare(`UPDATE admin_coverage_stats SET residential_count=1,ordinary_count=1 WHERE node_key='US'`).run();
    if (fault === 'index') await database.prepare(`DELETE FROM address_generation_index WHERE country_code='US'`).run();
    if (fault === 'missing_counts') await database.batch([
      database.prepare(`DELETE FROM admin_coverage_stats WHERE node_key='US'`),
      database.prepare(`DELETE FROM sync_country_state WHERE country_code='US'`)
    ]);
    if (fault === 'empty_pool') await database.prepare(`UPDATE address_pool SET active=0,retired_at=? WHERE country_code='US'`).bind(now).run();
    const expected = fault === 'empty_pool' ? 0 : 2;
    let runtime;
    try {
      runtime = await createSyncRuntime({
        database, stateDir, environment: { NODE_ENV: 'test', SYNC_ADMIN_TOKEN: 'fixture-token' }
      });
      expect(await database.prepare(`SELECT total_count,residential_count FROM admin_coverage_stats
        WHERE node_key='US'`).first()).toEqual({ total_count: expected, residential_count: expected });
      expect(await database.prepare(`SELECT COALESCE(SUM(total_count),0) AS total,COALESCE(SUM(address_count),0) AS residential
        FROM residential_coverage WHERE country_code='US'`).first()).toEqual({ total: expected, residential: expected });
      expect(await database.prepare(`SELECT address_count,residential_count FROM sync_country_state
        WHERE country_code='US'`).first()).toEqual({ address_count: expected, residential_count: expected });
      expect(await database.prepare(`SELECT COUNT(*) AS total FROM address_generation_index
        WHERE country_code='US' AND active=1`).first('total')).toBe(expected);
      expect(await database.prepare('SELECT * FROM sync_source_execution_state').first()).toEqual(sourceState);
      expect(await database.prepare('SELECT * FROM publication_validation_state').first()).toEqual(validationState);
      const verifiedAt = await database.prepare(`SELECT updated_at FROM admin_coverage_stats WHERE node_key='US'`).first('updated_at');
      expect(await reconcilePublishedPoolProjections(database, '2099-01-01T00:00:00.000Z')).toEqual([]);
      expect(await database.prepare(`SELECT updated_at FROM admin_coverage_stats WHERE node_key='US'`).first('updated_at')).toBe(verifiedAt);
    } finally {
      await runtime?.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('reuses authorized runtime evidence without global evidence aggregates', async () => {
    const queries = [];
    await refreshResidentialCoverage({
      prepare: (sql) => ({ bind: () => ({ all: async () => {
        queries.push(sql);
        return { results: [] };
      } }) })
    }, 'KR', now, undefined, { inTransaction: true });
    const query = queries.find((sql) => sql.includes('FROM address_pool_runtime address'));
    expect(query).toBeDefined();
    const aggregate = query.slice(0, query.indexOf('FROM address_pool_runtime address'));
    expect(aggregate).not.toMatch(/\b(?:IN|EXISTS)\s*\(\s*SELECT\b/iu);
    expect(query).not.toContain('address_pool_evidence');
    expect(aggregate).toContain('address.residential_evidence=1');
  });

  it('uses the validated generation index for migration coverage refreshes', async () => {
    const queries = [];
    await refreshResidentialCoverage({
      prepare: (sql) => ({ bind: () => ({ all: async () => {
        queries.push(sql);
        return { results: [] };
      } }) })
    }, 'KR', now, undefined, { useGenerationIndex: true, inTransaction: true });
    const query = queries.find((sql) => sql.includes('FROM address_generation_index generation'));
    expect(query).toBeDefined();
    expect(query).not.toMatch(/component_variants_json|address_pool_evidence/u);
  });

  it.each(['valid', 'stale_evidence', 'retired_dataset', 'revoked_dataset', 'revoked_source'])(
    'keeps raw and indexed residential evidence authorization equivalent for %s', async (state) => {
      await database.batch([
        database.prepare(`INSERT INTO address_sources(id,name,homepage_url,data_url,license_code,license_name,license_url,
          attribution_text,attribution_url,terms_url,share_alike,notice_required,redistribution_allowed,created_at,updated_at)
          SELECT 'proof-source',name,homepage_url,data_url,license_code,license_name,license_url,
            attribution_text,attribution_url,terms_url,share_alike,notice_required,1,created_at,updated_at
          FROM address_sources WHERE id='source'`),
        database.prepare(`INSERT INTO address_datasets(id,source_id,country_code,version,retrieved_at,imported_at,input_checksum,
          format,license_code,license_name,license_url,attribution_text,attribution_url,terms_url,share_alike,notice_required,
          redistribution_allowed,status)
          SELECT 'proof-dataset','proof-source',country_code,version,retrieved_at,imported_at,input_checksum,
            format,license_code,license_name,license_url,attribution_text,attribution_url,terms_url,share_alike,notice_required,
            1,'active' FROM address_datasets WHERE id='dataset'`),
        database.prepare("UPDATE address_pool_evidence SET dataset_id='proof-dataset' WHERE id='ny-residential_use'")
      ]);
      if (state === 'stale_evidence') await database.exec("UPDATE address_pool_evidence SET is_current=0 WHERE id='ny-residential_use'");
      if (state === 'retired_dataset') await database.exec("UPDATE address_datasets SET status='retired' WHERE id='proof-dataset'");
      if (state === 'revoked_dataset') await database.exec("UPDATE address_datasets SET redistribution_allowed=0 WHERE id='proof-dataset'");
      if (state === 'revoked_source') await database.exec("UPDATE address_sources SET redistribution_allowed=0 WHERE id='proof-source'");
      await refreshAddressGenerationIndex(database, 'US');
      for (const useGenerationIndex of [false, true]) {
        await refreshResidentialCoverage(database, 'US', now, undefined, { useGenerationIndex });
        expect(await database.prepare(`SELECT residential_count,ordinary_count,total_count
          FROM admin_coverage_stats WHERE node_key='US'`).first()).toEqual({
          total_count: 2, residential_count: state === 'valid' ? 2 : 1, ordinary_count: state === 'valid' ? 0 : 1
        });
      }
    }
  );

  it.each(['published', 'retired', 'invalid_language', 'revoked_source'])(
    'reuses the freshly validated index for national counts of %s without repeating the strict scan', async (state) => {
      await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
      if (state === 'retired') await database.prepare("UPDATE address_pool SET active=0,retired_at=? WHERE id='ny'").bind(now).run();
      if (state === 'invalid_language') await database.prepare("UPDATE address_pool SET component_variants_json='{}' WHERE id='ny'").run();
      if (state === 'revoked_source') await database.prepare('UPDATE address_sources SET redistribution_allowed=0').run();
      await refreshAddressGenerationIndex(database, 'US');
      await refreshCountryCounts(database, 'US', now);
      const counts = () => database.prepare("SELECT address_count,residential_count FROM sync_country_state WHERE country_code='US'").first();
      const expected = await counts();
      const queries = [];
      const prepare = database.prepare.bind(database);
      database.prepare = (sql) => { queries.push(sql); return prepare(sql); };
      await refreshCountryCounts(database, 'US', now, { useGenerationIndex: true });
      expect(await counts()).toEqual(expected);
      expect(queries.some((sql) => sql.includes('FROM address_generation_index'))).toBe(true);
      expect(queries.some((sql) => sql.includes('FROM address_pool_runtime'))).toBe(false);
    });

  it.each([false, true])('counts duplicate evidence and street precision correctly with index mode %s', async (useGenerationIndex) => {
    await database.batch(['address_existence', 'residential_use'].map((type) => database.prepare(`
      INSERT INTO address_pool_evidence(id,address_id,dataset_id,source_record_id,observed_at,evidence_type,
        is_primary,is_current,created_at) VALUES (?,'ny','dataset','duplicate-proof',?,?,0,1,?)`)
      .bind(`duplicate-${type}`, now, type, now)));
    const components = { houseNumber: '', street: 'Fixture Road', locality: 'New York City',
      postalLocality: 'New York City', admin1: 'NY', postcode: '' };
    await database.prepare(`INSERT INTO address_pool(id,country_code,admin1,locality,postal_locality,postcode,street,
      house_number,latitude,longitude,native_language,component_variants_json,address_variants_json,property_type,
      quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at,match_level)
      VALUES ('street','US','NY','New York City','New York City','','Fixture Road','',40,-73.99,'en',?,?,'unknown',
        .95,'fixture','NY:New York City',2,1,?,?,'street')`).bind(JSON.stringify({
      native: components, en: components, 'zh-CN': { ...components, street: '测试路', locality: '纽约市', admin1: '纽约州' }
    }), JSON.stringify({ native: 'Fixture Road', en: 'Fixture Road', 'zh-CN': '测试路' }), now, now).run();
    await database.prepare(`INSERT INTO address_pool_evidence(id,address_id,dataset_id,source_record_id,
      observed_at,evidence_type,is_primary,is_current,created_at)
      VALUES ('street-proof','street','dataset','street',?,'address_existence',1,1,?)`).bind(now, now).run();
    if (useGenerationIndex) await refreshAddressGenerationIndex(database, 'US');
    expect(await refreshResidentialCoverage(database, 'US', now, undefined, { useGenerationIndex })).toMatchObject({
      matchedAddresses: 3, unmatchedAddresses: 0
    });
    expect(await database.prepare(`SELECT residential_count,ordinary_count,total_count
      FROM admin_coverage_stats WHERE node_key='US'`).first()).toEqual({
      residential_count: 2, ordinary_count: 1, total_count: 3
    });
    expect(await database.prepare(`SELECT SUM(address_count) AS residential,SUM(total_count) AS total
      FROM residential_coverage WHERE country_code='US'`).first()).toEqual({ residential: 2, total: 3 });
  });

  it.each(['published', 'retired', 'invalid_language', 'revoked_source', 'stale_primary', 'missing_primary'])(
    'matches strict coverage after index refresh for %s', async (state) => {
      if (state === 'retired') await database.prepare(`UPDATE address_pool SET active=0,retired_at=? WHERE id='ny'`).bind(now).run();
      if (state === 'invalid_language') await database.prepare(`UPDATE address_pool SET component_variants_json='{}' WHERE id='ny'`).run();
      if (state === 'revoked_source') await database.prepare('UPDATE address_sources SET redistribution_allowed=0').run();
      if (state === 'stale_primary') await database.exec("UPDATE address_pool_evidence SET is_current=0 WHERE id='ny-address_existence'");
      if (state === 'missing_primary') await database.exec("UPDATE address_pool_evidence SET is_primary=0 WHERE id='ny-address_existence'");
      await refreshAddressGenerationIndex(database, 'US');
      const strict = await refreshResidentialCoverage(database, 'US', now);
      const readCoverage = () => database.prepare(`SELECT country_code,region_name,city_name,address_count,total_count,
        region_id,city_id FROM residential_coverage ORDER BY country_code,region_name,city_name`).all();
      const expected = (await readCoverage()).results;
      expect(expected.reduce((total, row) => total + row.total_count, 0))
        .toBe(state === 'published' ? 2 : state === 'revoked_source' ? 0 : 1);
      expect(await refreshResidentialCoverage(database, 'US', now, undefined, { useGenerationIndex: true })).toEqual(strict);
      expect((await readCoverage()).results).toEqual(expected);
    }
  );

  it('repairs regional coverage when a previous migration already retired the records', async () => {
    await refreshResidentialCoverage(database, 'US', now);
    await database.prepare(`UPDATE address_pool SET active=0,retired_at=? WHERE id='ny'`).bind(now).run();
    await refreshAddressGenerationIndex(database, 'US');
    expect(await database.prepare(`SELECT SUM(total_count) AS total FROM residential_coverage WHERE country_code='US'`)
      .first('total')).toBe(2);
    await refreshIndexedResidentialCoverage(database, now);
    const read = () => database.prepare(`SELECT region_name,total_count,address_count
      FROM residential_coverage WHERE country_code='US'`).all();
    expect((await read()).results).toEqual([{ region_name: 'California', total_count: 1, address_count: 1 }]);
    await refreshIndexedResidentialCoverage(database, now);
    expect((await read()).results).toEqual([{ region_name: 'California', total_count: 1, address_count: 1 }]);
  });

  it.each([false, true])('keeps same-name administrative identities separate with explicit state codes %s', async (explicitCode) => {
    await database.prepare(`INSERT INTO residential_coverage(country_code,region_name,city_name,address_count,last_verified_at,region_id,city_id)
      VALUES ('US','New York','New York City',99,?,1,11)`).bind(now).run();
    await database.batch([
      database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
        VALUES (3,'US','CA2','California','California','加利福尼亚州','state',NULL,'/3')`),
      database.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population)
        VALUES (13,'US',3,'Los Angeles','Los Angeles','洛杉矶','city',3900000)`),
      database.prepare(`INSERT INTO address_pool(id,country_code,admin1,locality,postal_locality,postcode,street,
        house_number,latitude,longitude,native_language,component_variants_json,address_variants_json,property_type,
        quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at)
        SELECT 'ca-duplicate',country_code,'CA2',locality,postal_locality,postcode,street,house_number,latitude,longitude,
          native_language,component_variants_json,address_variants_json,property_type,quality_score,generation,coverage,
          random_key,active,first_seen_at,last_seen_at FROM address_pool WHERE id='ca'`),
      ...['address_existence', 'residential_use'].map((type, index) => database.prepare(`
        INSERT INTO address_pool_evidence(id,address_id,dataset_id,source_record_id,observed_at,evidence_type,
        is_primary,is_current,created_at) VALUES (?,?,?,?,?,?,?,1,?)`)
        .bind(`ca-duplicate-${type}`, 'ca-duplicate', 'dataset', 'ca-duplicate', now, type, index === 0 ? 1 : 0, now))
    ]);
    if (explicitCode) await database.prepare("UPDATE address_pool SET admin1_code='CA' WHERE id='ca'").run();
    const result = await refreshResidentialCoverage(database, 'US', now);
    expect(result).toMatchObject({ matchedAddresses: explicitCode ? 3 : 2,
      unmatchedAddresses: explicitCode ? 0 : 1, mappedGroups: explicitCode ? 3 : 2 });
    expect((await database.prepare(`SELECT region_id,city_id,total_count FROM residential_coverage
      WHERE country_code='US' ORDER BY region_id`).all()).results).toEqual([
      { region_id: 1, city_id: 11, total_count: 1 },
      ...(explicitCode ? [{ region_id: 2, city_id: 12, total_count: 1 }] : []),
      { region_id: 3, city_id: 13, total_count: 1 }
    ]);
    expect(await database.prepare(`SELECT residential_count,total_count FROM admin_coverage_stats
      WHERE node_key='US'`).first()).toEqual({ residential_count: 3, total_count: 3 });
    await database.exec(`UPDATE address_pool SET admin1_key=LOWER(admin1),locality_key=LOWER(locality),postal_locality_key=LOWER(postal_locality)`);
    await refreshAddressGenerationIndex(database, 'US');
    const regions = await queryLocationCatalog(database, { country: 'US', field: 'region', residential: true, limit: 100 });
    const cities = await queryLocationCatalog(database, { country: 'US', field: 'city', residential: true, limit: 100 });
    expect(regions.options.map((item) => item.value)).toEqual(['California', 'New York']);
    expect(cities.options.map((item) => item.value)).toEqual(['New York City', 'Los Angeles']);
  });

  it('exposes covered top-level regions when addresses link to a child division', async () => {
    await database.batch([
      database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
        VALUES (20,'FR','IDF','Île-de-France','Île-de-France','法兰西岛大区','region',NULL,'/20/')`),
      database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
        VALUES (21,'FR','75','Paris','Paris','巴黎省','department',20,'/20/21/')`),
      database.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population)
        VALUES (22,'FR',21,'Paris','Paris','巴黎','city',2100000)`),
      database.prepare(`INSERT INTO residential_coverage(country_code,region_name,city_name,address_count,last_verified_at,region_id,city_id)
        VALUES ('FR','Paris','Paris',5,?,21,22)`).bind(now)
    ]);
    await database.exec(`INSERT INTO address_pool(id,country_code,street,latitude,longitude,native_language,
      component_variants_json,address_variants_json,quality_score,generation,coverage,random_key,first_seen_at,last_seen_at)
      VALUES ('hierarchy-fixture','FR','Fixture Road',48,2,'fr','{}','{}',.95,'fixture','fixture',1,'2026-01-01','2026-01-01');
      INSERT INTO address_generation_index(address_id,country_code,admin1_key,admin1_code_key,locality_key,residential_ready,random_key,updated_at)
      VALUES ('hierarchy-fixture','FR','paris','75','paris',1,1,'2026-01-01');`);
    const regions = await queryLocationCatalog(database, { country: 'FR', field: 'region', residential: true, limit: 100 });
    expect(regions.options.map((item) => item.value)).toEqual(['Île-de-France']);
    expect(regions.options[0].availableCount).toBe(1);
  });
});
