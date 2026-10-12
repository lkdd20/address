import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeTestDatabase, openTestDatabase } from './helpers/postgres-test-database.mjs';
import { PostgresDatabase } from '../server/database/postgres.mjs';
import {
  addressCanonicalKey, houseNumberIssue, splitConcatenatedLocality, trimStreetAdministration, validateAddressQuality
} from '../src/domain/address-quality.mjs';
import { normalizeSourceRecord } from '../server/sync/address-etl.mjs';
import { correctedRegion } from '../server/sync/region-boundaries.mjs';
import { repairAddressStructure } from '../server/sync/address-structure-repair.mjs';

const at = '2026-10-11T00:00:00.000Z';

describe('address structure rules', () => {
  it('treats local no-number markers, digit-free numbers and whole addresses as street-level only', () => {
    for (const [country, value] of [['ES', 'S-N'], ['BR', 'SN (DEPOSITO )'], ['IT', 'snc'], ['MX', 'SIN VALOR'], ['ZA', 'C/O']]) {
      expect(houseNumberIssue(country, value)).toBe('no_number_marker');
    }
    expect(houseNumberIssue('IN', 'Pravin Kerai Residence')).toBe('house_number_without_digits');
    expect(houseNumberIssue('MY', 'Ground Floor, Lot 3A, Block C, 88 Marketplace')).toBe('overlong_house_number');
    for (const [country, value] of [['GB', 'Campion Cottage'], ['DE', '14,14a,14b'], ['JP', '1丁目2番3号'], ['SA', '٩٣٦٢'], ['CN', '无']]) {
      expect(houseNumberIssue(country, value)).toBeNull();
    }
    expect(validateAddressQuality({ countryCode: 'ES', components: { street: 'Camino Crego', houseNumber: 'S-N', locality: 'Redondela' } }).reasons)
      .toContain('invalid_house_number');
  });

  it('keeps the catalog city of a concatenated locality and drops repeated administration from streets', () => {
    const known = (value) => ['Ashford', 'Cape Town'].includes(value);
    expect(splitConcatenatedLocality('GB', { locality: 'Kennington, Ashford' }, known)).toEqual({ locality: 'Ashford', district: 'Kennington' });
    expect(splitConcatenatedLocality('DE', { locality: 'Polle, Flecken' })).toEqual({ locality: 'Polle' });
    expect(splitConcatenatedLocality('FR', { locality: 'Locquirec, France' })).toEqual({ locality: 'Locquirec' });
    expect(splitConcatenatedLocality('VN', { locality: 'Phân khu Tinh Hoa, Global Gate' })).toEqual({ locality: '' });
    expect(trimStreetAdministration('NG', { street: 'Okpora Street, Umueze,', locality: 'Amawbia' }).street).toBe('Okpora Street, Umueze');
    expect(trimStreetAdministration('IN', { street: 'MG Road, Mysuru, Karnataka', locality: 'Mysuru', admin1: 'Karnataka' }).street).toBe('MG Road');
    const quality = (street) => validateAddressQuality({ countryCode: 'BR', components: { street, houseNumber: '1', locality: 'Morrinhos', admin1: 'Goiás' } });
    expect(quality('Avenida Roma, Quadra 47, Lote 17').valid).toBe(true);
    expect(quality('Rua A, Centro, Morrinhos Velho').reasons).toContain('concatenated_street');
  });

  it('imports a numberless premise as a street address without premise or residential claims', () => {
    const record = normalizeSourceRecord({
      properties: { '@id': 'way/1', 'addr:housenumber': 'S/N', 'addr:street': 'Calle Mayor', 'addr:city': 'Madrid', name: 'Casa', building: 'house' },
      geometry: { type: 'Point', coordinates: [-3.7, 40.4] }
    }, { countryCode: 'ES', source: { name: 'OpenStreetMap' } }, 'geofabrik-geojsonseq');
    expect(record).toMatchObject({ matchLevel: 'street', houseNumber: '', buildingName: '', propertyType: 'unknown', residentialSourceRecordId: '' });
  });

  it('replaces only a conflicting or unknown region with the polygon region', () => {
    const regions = [{ id: 1, code: 'TN', name: 'Tamil Nadu', native_name: 'Tamil Nadu', zh_name: '泰米尔纳德邦' }];
    const tamilNadu = { name: 'Tamil Nadu', nameEn: 'Tamil Nadu', code: 'IN-TN' };
    expect(correctedRegion('IN', { admin1: 'Kerala' }, tamilNadu, regions))
      .toEqual({ admin1: 'Tamil Nadu', admin1Code: 'TN', admin1En: 'Tamil Nadu', admin1Zh: '泰米尔纳德邦' });
    expect(correctedRegion('IN', { admin1: 'tamil nadu' }, tamilNadu, regions)).toBeNull();
    expect(correctedRegion('IN', { admin1: 'Kerala' }, { name: '藏南', nameEn: 'South Tibet', code: '' }, regions)).toBeNull();
    expect(correctedRegion('ES', { admin1: 'Madrid' }, { name: 'Comunidad de Madrid', code: 'ES-MD' }, [])).toBeNull();
    expect(correctedRegion('US', { admin1: 'PR' }, { name: 'San Juan', code: 'PR-127' }, [])).toBeNull();
    expect(correctedRegion('TH', { admin1: 'กำแพงเพชร' }, { name: 'จังหวัดกำแพงเพชร', code: 'TH-62' }, [])).toBeNull();
  });
});

const insert = (database, id, native, { matchLevel = 'premise', latitude = 13.08, longitude = 80.27 } = {}) => database.prepare(`INSERT INTO address_pool(
    id,canonical_key,country_code,admin1,locality,postal_locality,street,house_number,latitude,longitude,native_language,
    component_variants_json,address_variants_json,property_type,quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at,match_level)
  VALUES (?,?,'IN',?,?,?,?,?,?,?,'en',?,'{}','residential',.9,'v1','x',1,1,?,?,?)`).bind(
  id, addressCanonicalKey('IN', native, matchLevel), native.admin1, native.locality, native.postalLocality || '', native.street,
  native.houseNumber || '', latitude, longitude, JSON.stringify({ native, en: native, 'zh-CN': { ...native, admin1: '喀拉拉邦' } }),
  at, at, matchLevel
).run();

describe('address structure repair', () => {
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
      VALUES (1,'IN','TN','Tamil Nadu','Tamil Nadu','泰米尔纳德邦','/1/'),(2,'IN','KL','Kerala','Kerala','喀拉拉邦','/2/')`);
  });
  afterEach(async () => { await database.close(); vi.restoreAllMocks(); });

  it('corrects regions by polygon, downgrades numberless premises, retires points outside the country once', async () => {
    const base = { street: 'Avinashi Road', locality: 'Coimbatore', admin1: 'Kerala' };
    await insert(database, 'wrong-state', { ...base, houseNumber: '605' });
    await insert(database, 'shop', { ...base, street: 'Park Road', houseNumber: 'Rare Rabbit' });
    await insert(database, 'abroad', { ...base, street: 'Kazi Bari Road', houseNumber: '1' }, { latitude: 23.46, longitude: 91.18 });
    await insert(database, 'fine', { street: 'Mount Road', houseNumber: '7', locality: 'Chennai', admin1: 'Tamil Nadu' });
    const regionLookup = vi.fn(async ({ points }) => new Map(points.map(({ id }) => [id, id === 'abroad'
      ? { outside: true } : { name: 'Tamil Nadu', nameEn: 'Tamil Nadu', code: 'IN-TN' }])));

    expect(await repairAddressStructure({ database, countryCode: 'IN', regionLookup, pauseMs: 0, now: () => new Date(at) }))
      .toEqual({ countryCode: 'IN', changed: 2, downgraded: 1, regions: 2, retired: 1, duplicates: 0 });
    const rows = new Map((await database.prepare('SELECT * FROM address_pool').all()).results.map((row) => [row.id, row]));
    expect(rows.get('wrong-state')).toMatchObject({ admin1: 'Tamil Nadu', admin1_code: 'TN', admin1_key: 'tamil nadu' });
    expect(JSON.parse(rows.get('wrong-state').component_variants_json)['zh-CN'].admin1).toBe('泰米尔纳德邦');
    expect(rows.get('shop')).toMatchObject({ match_level: 'street', house_number: '', property_type: 'unknown' });
    expect(rows.get('abroad')).toMatchObject({ active: 0, retired_at: `publication-validation:address-structure-v1:${at}` });
    expect(rows.get('fine').admin1).toBe('Tamil Nadu');

    expect(await repairAddressStructure({ database, countryCode: 'IN', regionLookup, pauseMs: 0 })).toMatchObject({ changed: 0 });
    expect(regionLookup).toHaveBeenCalledOnce();
  });

  it('leaves the revision open when region polygons cannot be built', async () => {
    await insert(database, 'shop', { street: 'Park Road', houseNumber: 'Rare Rabbit', locality: 'Chennai', admin1: 'Tamil Nadu' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const regionLookup = async () => { throw new Error('offline'); };
    expect(await repairAddressStructure({ database, countryCode: 'IN', regionLookup, pauseMs: 0 })).toMatchObject({ downgraded: 1 });
    expect(await database.prepare("SELECT COUNT(*) AS total FROM translation_backfill_progress WHERE key LIKE 'address-structure-v1:%'").first('total')).toBe(0);
    expect(error).toHaveBeenCalled();
  });
});
