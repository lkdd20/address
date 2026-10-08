import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeTestDatabase, openTestDatabase } from './helpers/postgres-test-database.mjs';
import { PostgresDatabase } from '../server/database/postgres.mjs';
import { addressCanonicalKey } from '../src/domain/address-quality.mjs';
import { repairTaiwanOfficialNames } from '../server/sync/taiwan-name-repair.mjs';

const at = '2026-10-08T00:00:00.000Z';
const insert = (database, id, admin1, houseNumber) => {
  const native = { admin1, locality: '中正區', postalLocality: '中正區', district: '', street: '忠孝東路', houseNumber, postcode: '100' };
  return database.prepare(`INSERT INTO address_pool(id,canonical_key,country_code,admin1,locality,postal_locality,street,house_number,postcode,
      latitude,longitude,native_language,component_variants_json,address_variants_json,property_type,quality_score,generation,coverage,
      random_key,active,first_seen_at,last_seen_at,match_level)
    VALUES (?,?,'TW',?,'中正區','中正區','忠孝東路',?,'100',25.04,121.52,'zh-TW',?,?,'unknown',.9,'v1','x',1,1,?,?,'premise')`).bind(
    id, addressCanonicalKey('TW', native), admin1, houseNumber,
    JSON.stringify({ native, en: native, 'zh-CN': native }), JSON.stringify({ native: `${admin1}中正區忠孝東路${houseNumber}`, en: '', 'zh-CN': '' }), at, at
  ).run();
};

describe('Taiwan official name repair', () => {
  let database;
  beforeEach(async () => {
    database = openTestDatabase();
    const exec = PostgresDatabase.prototype.exec;
    vi.spyOn(PostgresDatabase.prototype, 'exec').mockImplementation(function (sql) {
      if (/^(LOCK TABLE|SET LOCAL)/u.test(sql)) return Promise.resolve();
      return exec.call(this, sql);
    });
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
  });
  afterEach(async () => { await database.close(); vi.restoreAllMocks(); });

  it('renames 台 counties to 臺 once and removes rows that duplicate an official-name address', async () => {
    await insert(database, 'official', '臺北市', '1');
    await insert(database, 'variant', '台北市', '2');
    await insert(database, 'twin', '台北市', '1');
    expect(await repairTaiwanOfficialNames({ database, now: () => new Date(at) })).toMatchObject({ renamed: 1, duplicates: 1 });
    const rows = new Map((await database.prepare('SELECT * FROM address_pool').all()).results.map((row) => [row.id, row]));
    expect([...rows.keys()].sort()).toEqual(['official', 'variant']);
    expect(rows.get('variant')).toMatchObject({ admin1: '臺北市', canonical_key: rows.get('official').canonical_key.replace('\u001f1\u001f', '\u001f2\u001f') });
    expect(JSON.parse(rows.get('variant').component_variants_json).native.admin1).toBe('臺北市');
    expect(await repairTaiwanOfficialNames({ database, now: () => new Date(at) })).toMatchObject({ renamed: 0, duplicates: 0 });
  });
});
