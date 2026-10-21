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

    it('gives a Chinese street that misreads its English type the address type', async () => {
      const native = { houseNumber: '4', street: 'Orchard Close', locality: 'Oxford', admin1: 'England', postcode: 'OX1 1AA' };
      const zh = { ...native, street: '果园关闭', locality: '牛津', admin1: '英格兰' };
      await database.prepare(`INSERT INTO address_pool(id,country_code,admin1,locality,street,house_number,latitude,longitude,
          native_language,component_variants_json,address_variants_json,property_type,quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at,match_level)
        VALUES ('close','GB','England','Oxford','Orchard Close','4',51.7,-1.2,'en',?,?,'unknown',.9,'v1','x',1,1,'2026-10-07','2026-10-07','premise')`)
        .bind(JSON.stringify({ native, en: native, 'zh-CN': zh }), JSON.stringify({ native: 'n', en: 'e', 'zh-CN': localizedFormattedAddress(zh, 'GB', 'zh-CN') })).run();
      expect(await repairChineseAddressStrings({ database, countryCode: 'GB' })).toMatchObject({ scanned: 1, repaired: 1, streetTypes: 1 });
      const row = await database.prepare("SELECT component_variants_json,address_variants_json FROM address_pool WHERE id='close'").first();
      expect(JSON.parse(row.component_variants_json)['zh-CN'].street).toBe('果园巷');
      expect(JSON.parse(row.address_variants_json)['zh-CN']).toBe(localizedFormattedAddress({ ...zh, street: '果园巷' }, 'GB', 'zh-CN'));
    });

    it('restores kanji place names an English fallback replaced in the Chinese variant', async () => {
      const native = { houseNumber: '1', street: '北一条西二丁目', locality: '札幌市', admin1: '北海道', postcode: '060-0001' };
      const en = { ...native, street: 'Kita 1-jo Nishi 2-chome', locality: 'Sapporo', admin1: 'Hokkaidō' };
      const zh = { ...native, street: '北一条西二丁目', locality: 'Sapporo', admin1: 'Hokkaidō' };
      await database.prepare(`INSERT INTO address_pool(id,country_code,admin1,locality,street,house_number,latitude,longitude,
          native_language,component_variants_json,address_variants_json,property_type,quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at,match_level)
        VALUES ('kanji','JP','北海道','札幌市','北一条西二丁目','1',43.06,141.35,'ja',?,?,'unknown',.9,'v1','x',1,1,'2026-10-07','2026-10-07','premise')`)
        .bind(JSON.stringify({ native, en, 'zh-CN': zh }), JSON.stringify({ native: 'n', en: 'e', 'zh-CN': 'z' })).run();
      await repairChineseAddressStrings({ database, countryCode: 'JP' });
      const row = await database.prepare("SELECT component_variants_json FROM address_pool WHERE id='kanji'").first();
      expect(JSON.parse(row.component_variants_json)['zh-CN']).toMatchObject({ admin1: '北海道', locality: '札幌市', street: '北一条西二丁目' });
    });

    it('falls back to the source street when the Chinese street keeps no usable type', async () => {
      const native = { houseNumber: '9', street: 'Judge Close', locality: 'Oxford', admin1: 'England', postcode: 'OX1 1AA' };
      const zh = { ...native, street: '克洛斯法官', locality: '牛津', admin1: '英格兰' };
      await database.prepare(`INSERT INTO address_pool(id,country_code,admin1,locality,street,house_number,latitude,longitude,
          native_language,component_variants_json,address_variants_json,property_type,quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at,match_level)
        VALUES ('judge','GB','England','Oxford','Judge Close','9',51.7,-1.2,'en',?,?,'unknown',.9,'v1','x',1,1,'2026-10-07','2026-10-07','premise')`)
        .bind(JSON.stringify({ native, en: native, 'zh-CN': zh }), JSON.stringify({ native: 'n', en: 'e', 'zh-CN': localizedFormattedAddress(zh, 'GB', 'zh-CN') })).run();
      await repairChineseAddressStrings({ database, countryCode: 'GB' });
      const row = await database.prepare("SELECT component_variants_json FROM address_pool WHERE id='judge'").first();
      expect(JSON.parse(row.component_variants_json)['zh-CN'].street).toBe('Judge Close');
    });
  });
});
