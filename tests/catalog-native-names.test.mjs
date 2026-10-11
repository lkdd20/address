import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';
import { repairCatalogNativeNames } from '../server/database/administrative-catalog-overrides.ts';
import { catalogNativeCorrections, correctedNativeName, diacriticsOnly, nativeNameMatches } from '../server/database/catalog-native-names.mjs';
import { repairCatalogNativeAddresses } from '../server/sync/catalog-native-repair.mjs';

const address = async (db, id, country, admin1, locality) => {
  const native = { street: 'Fixture Road', houseNumber: '1', admin1, locality, postalLocality: locality, postcode: '' };
  await db.prepare(`INSERT INTO address_pool(id,country_code,admin1,locality,postal_locality,street,house_number,latitude,longitude,
      native_language,component_variants_json,address_variants_json,admin1_key,locality_key,postal_locality_key,quality_score,generation,
      coverage,random_key,first_seen_at,last_seen_at)
    VALUES (?,?,?,?,?,'Fixture Road','1',1,1,'en',?,'{}',?,?,?,.95,'fixture','fixture',1,'2026-01-01','2026-01-01')`)
    .bind(id, country, admin1, locality, locality, JSON.stringify({ native, en: native }),
      admin1.toLowerCase(), locality.toLowerCase(), locality.toLowerCase()).run();
};
const native = async (db, id) => JSON.parse(await db.prepare('SELECT component_variants_json FROM address_pool WHERE id=?')
  .bind(id).first('component_variants_json')).native;

describe('catalog native names', () => {
  let db;
  beforeEach(async () => {
    db = openTestDatabase();
    await db.exec(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,path) VALUES
      (2174,'TR','52','Ordu','Saat','奥尔杜','/2174/'),(1416,'US','CA','California','California','加利福尼亚州','/1416/'),
      (1407,'US','TX','Texas','Texas','得克萨斯州','/1407/');
      INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name) VALUES
      (114662,'US',1416,'Corona','Crown','Crown');`);
  });
  afterEach(() => db.close());

  it('keeps accented local spellings and recognizes extended official names', () => {
    expect(diacriticsOnly('Montréal', 'Montreal')).toBe(true);
    expect(diacriticsOnly('ITHACA', 'Ithaca')).toBe(false);
    expect(nativeNameMatches('東京', '東京都')).toBe(true);
    expect(nativeNameMatches('Zuid -Holland', 'Zuid-Holland', { exact: true })).toBe(true);
    expect(nativeNameMatches('Saat', 'Ordu')).toBe(false);
    expect(correctedNativeName('regions', 2174, 'Saat')).toBe('Ordu');
    expect(catalogNativeCorrections.cities['114662']).toBe('Corona');
  });

  it('corrects the catalog and rewrites only addresses filled with the old name inside its region', async () => {
    await address(db, 'tr-ordu', 'TR', 'Saat', 'Altınordu');
    await address(db, 'us-corona', 'US', 'California', 'Crown');
    await address(db, 'us-other-crown', 'US', 'Texas', 'Crown');
    await address(db, 'us-coded-region', 'US', 'CA', 'Crown');

    expect(await repairCatalogNativeNames(db)).toBeGreaterThanOrEqual(2);
    expect(await db.prepare('SELECT native_name FROM catalog_regions WHERE id=2174').first('native_name')).toBe('Ordu');
    expect(await db.prepare('SELECT native_name,zh_name FROM catalog_cities WHERE id=114662').first())
      .toEqual({ native_name: 'Corona', zh_name: 'Corona' });

    expect(await repairCatalogNativeAddresses({ database: db })).toEqual(expect.arrayContaining([
      expect.objectContaining({ countryCode: 'TR', renamed: 1 }), expect.objectContaining({ countryCode: 'US', renamed: 2 })
    ]));
    expect(await native(db, 'tr-ordu')).toMatchObject({ admin1: 'Ordu', locality: 'Altınordu' });
    expect(await db.prepare("SELECT admin1,admin1_key FROM address_pool WHERE id='tr-ordu'").first()).toEqual({ admin1: 'Ordu', admin1_key: 'ordu' });
    expect(await native(db, 'us-corona')).toMatchObject({ locality: 'Corona', postalLocality: 'Corona' });
    expect(await native(db, 'us-other-crown')).toMatchObject({ locality: 'Crown' });
    expect(await native(db, 'us-coded-region')).toMatchObject({ admin1: 'CA', locality: 'Corona' });
    expect(await db.prepare('SELECT COUNT(*) AS total FROM catalog_native_repairs WHERE applied_at IS NULL').first('total')).toBe(0);

    expect(await repairCatalogNativeNames(db)).toBe(0);
    expect(await repairCatalogNativeAddresses({ database: db })).toEqual([]);
  });

  it('creates the repair log on databases that predate it', async () => {
    await db.exec('DROP TABLE catalog_native_repairs');
    expect(await repairCatalogNativeNames(db)).toBeGreaterThanOrEqual(2);
    expect(Number(await db.prepare('SELECT COUNT(*) AS total FROM catalog_native_repairs').first('total'))).toBeGreaterThanOrEqual(2);
  });
});
