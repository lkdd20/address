import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeTestDatabase, openTestDatabase } from './helpers/postgres-test-database.mjs';
import { PostgresDatabase } from '../server/database/postgres.mjs';
import { POSTCODE_INFERENCE_REVISION, runPostcodeInference } from '../server/sync/postcode-inference.mjs';

const at = '2026-10-06T00:00:00.000Z';
const insertAddress = (database, id, { country = 'US', admin1 = 'CA', locality = 'BOONVILLE', postcode = '', latitude = 39.0, longitude = -123.37 } = {}) => {
  const native = { houseNumber: '1', street: `${id} Road`, locality, postalLocality: '', admin1, admin1Code: admin1, postcode };
  return database.prepare(`INSERT INTO address_pool(id,country_code,admin1,admin1_code,locality,postal_locality,street,house_number,
      postcode,postcode_key,latitude,longitude,native_language,component_variants_json,address_variants_json,property_type,quality_score,
      generation,coverage,random_key,active,first_seen_at,last_seen_at,match_level)
    VALUES (?,?,?,?,?,'',?,'1',?,?,?,?,'en',?,?,'unknown',.9,'v1','x',1,1,?,?,'premise')`).bind(
    id, country, admin1, admin1, locality, `${id} Road`, postcode, postcode, latitude, longitude,
    JSON.stringify({ native, en: native, 'zh-CN': { ...native, locality: '布恩维尔', admin1: '加利福尼亚州' } }),
    JSON.stringify({ native: `1 ${id} Road, ${locality}, ${admin1}${postcode ? `, ${postcode}` : ''}, ${country}`, en: '', 'zh-CN': '' }), at, at
  ).run();
};

describe('postcode inference', () => {
  let database;
  beforeEach(async () => {
    database = openTestDatabase();
    const exec = PostgresDatabase.prototype.exec;
    vi.spyOn(PostgresDatabase.prototype, 'exec').mockImplementation(function (sql) {
      if (/^(LOCK TABLE|SET LOCAL)/u.test(sql)) return Promise.resolve();
      return exec.call(this, sql);
    });
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    await database.exec(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,path)
      VALUES (1,'US','CA','California','California','加利福尼亚州','US/CA'),(2,'DE','BE','Berlin','Berlin','柏林','DE/BE');
      INSERT INTO catalog_postcodes(id,country_code,region_id,city_id,code,locality_name,latitude,longitude)
      VALUES (1,'US',1,NULL,'95415','Boonville',39.0197,-123.3856),(2,'US',1,NULL,'95401','Santa Rosa',38.44,-122.71),
        (3,'US',1,NULL,'95403','Santa Rosa',38.48,-122.75);`);
  });
  afterEach(async () => { await database.close(); vi.restoreAllMocks(); });

  it('fills a missing postcode from a boundary, a unique catalog place or agreeing neighbours, and records the method', async () => {
    await insertAddress(database, 'catalog');
    await insertAddress(database, 'ambiguous', { locality: 'SANTA ROSA', latitude: 38.45, longitude: -122.72 });
    await insertAddress(database, 'boundary', { locality: 'NOWHERE', latitude: 40.0, longitude: -120.0 });
    for (const id of ['n1', 'n2', 'n3']) await insertAddress(database, id, { country: 'DE', admin1: 'BE', locality: 'BERLIN', postcode: '10115', latitude: 52.53, longitude: 13.38 });
    await insertAddress(database, 'neighbor', { country: 'DE', admin1: 'BE', locality: 'BERLIN', latitude: 52.531, longitude: 13.381 });
    const boundaryLookup = vi.fn(async (_source, points) => new Map(points.filter((point) => point.id === 'boundary').map((point) => [point.id, '96001'])));
    expect(await runPostcodeInference({ database, countryCode: 'US', boundaryLookup, now: () => new Date(at) }))
      .toMatchObject({ checked: 3, boundary: 1, catalog: 1, neighbor: 0 });
    expect(await runPostcodeInference({ database, countryCode: 'DE', now: () => new Date(at) })).toMatchObject({ checked: 1, neighbor: 1 });
    const rows = new Map((await database.prepare('SELECT id,postcode,component_variants_json,address_variants_json FROM address_pool').all())
      .results.map((row) => [row.id, row]));
    expect(rows.get('catalog').postcode).toBe('95415');
    expect(rows.get('ambiguous').postcode).toBe('');
    expect(rows.get('boundary').postcode).toBe('96001');
    expect(rows.get('neighbor').postcode).toBe('10115');
    expect(JSON.parse(rows.get('catalog').component_variants_json)['zh-CN'].postcode).toBe('95415');
    expect(JSON.parse(rows.get('catalog').address_variants_json)).toMatchObject({
      native: '1 catalog Road, BOONVILLE, CA, 95415, US', en: expect.stringContaining('95415'), 'zh-CN': expect.stringContaining('95415')
    });
    const inference = new Map((await database.prepare('SELECT * FROM address_postcode_inference').all()).results.map((row) => [row.address_id, row]));
    expect(inference.get('catalog')).toMatchObject({ method: 'catalog-unique', source: 'geonames-postal-codes', checked_revision: POSTCODE_INFERENCE_REVISION });
    expect(inference.get('boundary')).toMatchObject({ method: 'boundary', source: 'census-zcta-2020' });
    expect(inference.get('neighbor')).toMatchObject({ method: 'neighbor-consensus' });
    expect(inference.get('ambiguous')).toMatchObject({ postcode: '', method: '' });
    expect(await runPostcodeInference({ database, countryCode: 'US', boundaryLookup, now: () => new Date(at) })).toMatchObject({ checked: 0 });
  });

  it('fills Taiwan postcodes from a township whose source postcodes share one 3-digit zone', async () => {
    const point = { country: 'TW', latitude: 22.0, longitude: 120.74 };
    for (const [id, postcode] of [['s1', '946'], ['s2', '94641'], ['s3', '946001']]) await insertAddress(database, id, { ...point, admin1: '屏東縣', locality: '恆春鎮', postcode });
    for (const [id, postcode] of [['m1', '100'], ['m2', '100'], ['m3', '103']]) await insertAddress(database, id, { ...point, admin1: '臺北市', locality: '中正區', postcode });
    await insertAddress(database, 'township', { country: 'TW', admin1: '屏東縣', locality: '恆春鎮', latitude: 22.3, longitude: 120.9 });
    await insertAddress(database, 'mixed', { country: 'TW', admin1: '台北市', locality: '中正區', latitude: 25.3, longitude: 121.9 });
    expect(await runPostcodeInference({ database, countryCode: 'TW', now: () => new Date(at) })).toMatchObject({ checked: 2, township: 1, neighbor: 0 });
    expect(await database.prepare('SELECT postcode FROM address_pool WHERE id=?').bind('township').first('postcode')).toBe('946');
    expect(await database.prepare('SELECT postcode FROM address_pool WHERE id=?').bind('mixed').first('postcode')).toBe('');
  });

  it('never derives postcodes for countries with building or street level codes', async () => {
    await insertAddress(database, 'gb', { country: 'GB', admin1: 'ENG', locality: 'LONDON' });
    expect(await runPostcodeInference({ database, countryCode: 'GB' })).toMatchObject({ checked: 0 });
    expect(await database.prepare('SELECT postcode FROM address_pool WHERE id=?').bind('gb').first('postcode')).toBe('');
  });
});
