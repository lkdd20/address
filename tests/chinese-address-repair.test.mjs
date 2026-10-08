import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeTestDatabase, openTestDatabase } from './helpers/postgres-test-database.mjs';
import { localizedFormattedAddress } from '../server/sync/address-etl.mjs';
import { repairChineseAddressStrings } from '../server/sync/chinese-address-repair.mjs';

const english = { houseNumber: '211', street: 'Route 625', locality: 'Cross Creek', admin1: 'New Brunswick', postcode: 'E6B 2G9' };
const chinese = { houseNumber: '17500', street: 'HWY 128', locality: '布恩维尔', admin1: '加利福尼亚州', postcode: '95415' };

describe('Chinese address spacing', () => {
  it('separates adjacent alphabetic or digit parts while keeping Chinese text joined', () => {
    expect(localizedFormattedAddress(chinese, 'US', 'zh-CN')).toBe('美国加利福尼亚州布恩维尔HWY 128 17500 95415');
    expect(localizedFormattedAddress({ ...chinese, street: '主街', houseNumber: '21号' }, 'US', 'zh-CN')).toBe('美国加利福尼亚州布恩维尔主街21号95415');
    expect(localizedFormattedAddress({ houseNumber: '184', street: 'улица Ленина', locality: 'Воскресенское', admin1: '下诺夫哥罗德', postcode: '606730' }, 'RU', 'zh-CN'))
      .toBe('俄罗斯下诺夫哥罗德Воскресенское улица Ленина 184 606730');
    expect(localizedFormattedAddress({ houseNumber: '24番8号', street: '七里滨东3丁目', district: '七里滨东', locality: '镰仓市', admin1: '神奈川县', postcode: '248-0025' }, 'JP', 'zh-CN'))
      .toBe('日本神奈川县镰仓市七里滨东3丁目24番8号248-0025');
  });

  describe('stored string repair', () => {
    let database;
    beforeEach(async () => {
      database = openTestDatabase();
      await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    });
    afterEach(async () => { await database.close(); });

    it('rebuilds strings that differ from their Chinese components once per country', async () => {
      const insert = (id, zh, components = { native: chinese, en: chinese, 'zh-CN': chinese }) => database.prepare(`INSERT INTO address_pool(id,country_code,admin1,locality,street,house_number,latitude,longitude,
          native_language,component_variants_json,address_variants_json,property_type,quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at,match_level)
        VALUES (?,'US','CA','BOONVILLE','HWY 128','17500',39,-123.4,'en',?,?,'unknown',.9,'v1','x',1,1,'2026-10-07','2026-10-07','premise')`)
        .bind(id, JSON.stringify(components), JSON.stringify({ native: 'n', en: 'e', 'zh-CN': zh })).run();
      await insert('jammed', '美国加利福尼亚州布恩维尔HWY 1281750095415');
      await insert('partial', '美国加利福尼亚州BoonvilleHWY 1281750095415');
      await insert('stale', '美国New BrunswickCross CreekRoute 625211E6B 2G9', { native: english, en: english, 'zh-CN': chinese });
      expect(await repairChineseAddressStrings({ database, countryCode: 'US' })).toMatchObject({ scanned: 3, repaired: 3, stale: 2 });
      const rows = new Map((await database.prepare('SELECT id,address_variants_json FROM address_pool').all()).results
        .map((row) => [row.id, JSON.parse(row.address_variants_json)['zh-CN']]));
      expect(rows.get('jammed')).toBe('美国加利福尼亚州布恩维尔HWY 128 17500 95415');
      expect(rows.get('partial')).toBe('美国加利福尼亚州布恩维尔HWY 128 17500 95415');
      expect(rows.get('stale')).toBe('美国加利福尼亚州布恩维尔HWY 128 17500 95415');
      expect(await repairChineseAddressStrings({ database, countryCode: 'US' })).toMatchObject({ scanned: 0, repaired: 0 });
    });
  });
});
