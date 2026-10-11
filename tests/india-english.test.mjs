import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeTestDatabase, openTestDatabase } from './helpers/postgres-test-database.mjs';
import { PostgresDatabase } from '../server/database/postgres.mjs';
import { addressCanonicalKey, englishOnlyComponents, stripNonLatinText, validateAddressQuality } from '../src/domain/address-quality.mjs';
import { normalizeSourceRecord } from '../server/sync/address-etl.mjs';
import { repairIndiaEnglishAddresses } from '../server/sync/india-english-repair.mjs';

const at = '2026-10-11T00:00:00.000Z';
const shard = { countryCode: 'IN', source: { name: 'OpenStreetMap' } };
const osm = (properties) => normalizeSourceRecord({
  properties: { '@id': 'node/1', 'addr:housenumber': '9', 'addr:street': 'Park Road', 'addr:city': 'Chennai', 'addr:state': 'Tamil Nadu', ...properties },
  geometry: { type: 'Point', coordinates: [80.27, 13.08] }
}, shard, 'geofabrik-geojsonseq');

describe('India English-only text', () => {
  it('removes local-script runs and keeps the English part', () => {
    expect(stripNonLatinText('சென்னை - Chennai')).toBe('Chennai');
    expect(stripNonLatinText('MG Road (एमजी रोड)')).toBe('MG Road');
    expect(stripNonLatinText('पाली रोड, Jothi Nagar')).toBe('Jothi Nagar');
    expect(stripNonLatinText('दुकान ४')).toBe('4');
    expect(stripNonLatinText('Prayagraj (Allahabad)')).toBe('Prayagraj (Allahabad)');
    expect(englishOnlyComponents({ street: 'पाली रोड', locality: 'तिगरी', houseNumber: '१२' }, { street: 'Pali Road' }))
      .toEqual({ components: { street: 'Pali Road', houseNumber: '12' }, emptied: ['locality'] });
  });

  it('rejects any local-script component in an Indian address', () => {
    const components = { street: 'Park Road', houseNumber: '9', locality: 'Chennai', admin1: 'Tamil Nadu' };
    expect(validateAddressQuality({ countryCode: 'IN', components }).valid).toBe(true);
    expect(validateAddressQuality({ countryCode: 'IN', components: { ...components, buildingName: 'होटल आमंत्रण' } }).reasons).toContain('non_latin_text');
    expect(validateAddressQuality({ countryCode: 'TH', components: { ...components, locality: 'พระนคร' } }).reasons).not.toContain('non_latin_text');
  });

  it('imports Indian records in English and drops records whose core field is local script only', () => {
    expect(osm({ 'addr:city': 'சென்னை - Chennai', name: 'होटल आमंत्रण' })).toMatchObject({
      nativeLanguage: 'en', locality: 'Chennai', buildingName: '', components: { locality: 'Chennai' }
    });
    expect(osm({ 'addr:city': 'சென்னை' })).toBeNull();
    expect(osm({ 'addr:street': 'பாலாஜி நகர் 10வது தெரு' })).toBeNull();
    expect(osm({ 'addr:housenumber': 'कोमत्त' })).toBeNull();
  });
});

const insert = (database, id, native, en = native, active = 1) => database.prepare(`INSERT INTO address_pool(id,canonical_key,country_code,admin1,
    locality,postal_locality,street,house_number,building_name,latitude,longitude,native_language,component_variants_json,address_variants_json,
    property_type,quality_score,generation,coverage,random_key,active,retired_at,first_seen_at,last_seen_at,match_level)
  VALUES (?,?,'IN',?,?,?,?,?,?,28.6,77.2,'hi',?,?,'unknown',.9,'v1','x',1,?,?,?,?,'premise')`).bind(
  id, addressCanonicalKey('IN', native), native.admin1, native.locality, native.locality, native.street, native.houseNumber,
  native.buildingName || '', JSON.stringify({ native, en, 'zh-CN': { ...native, admin1: '德里' } }),
  JSON.stringify({ native: 'x', en: 'x', 'zh-CN': '德里' }), active, active ? null : 'source-retired', at, at
).run();

describe('India English repair', () => {
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

  it('cleans stored rows once, keeps English translations, retires rows without a core field and removes duplicates', async () => {
    const base = { admin1: 'DL', street: 'Geetanjali Enclave', houseNumber: '6', postcode: '' };
    await insert(database, 'tigri', { ...base, locality: 'तिगरी', postalLocality: 'तिगरी', buildingName: 'होटल आमंत्रण' },
      { ...base, locality: 'Tigri', postalLocality: 'Tigri', buildingName: 'Hotel Amantran' });
    await insert(database, 'untranslated', { ...base, houseNumber: '7', locality: 'तिगरी', postalLocality: 'तिगरी' });
    await insert(database, 'chennai', { ...base, houseNumber: '8', locality: 'சென்னை - Chennai', postalLocality: '' });
    await insert(database, 'existing', { ...base, houseNumber: '9', locality: 'Chennai', postalLocality: '' });
    await insert(database, 'twin', { ...base, houseNumber: '9', locality: 'சென்னை - Chennai', postalLocality: '' });
    await insert(database, 'clean', { ...base, houseNumber: '10', locality: 'Saket', postalLocality: 'Saket' });

    expect(await repairIndiaEnglishAddresses({ database, now: () => new Date(at) }))
      .toEqual({ countryCode: 'IN', cleaned: 2, retired: 1, duplicates: 1 });
    const rows = new Map((await database.prepare('SELECT * FROM address_pool').all()).results.map((row) => [row.id, row]));
    expect([...rows.keys()].sort()).toEqual(['chennai', 'clean', 'existing', 'tigri', 'untranslated']);
    expect(rows.get('tigri')).toMatchObject({ locality: 'Tigri', locality_key: 'tigri', building_name: 'Hotel Amantran', native_language: 'en' });
    const variants = JSON.parse(rows.get('tigri').component_variants_json);
    expect(variants.native).toMatchObject({ locality: 'Tigri', buildingName: 'Hotel Amantran' });
    expect(variants['zh-CN'].admin1).toBe('德里');
    expect(JSON.parse(rows.get('tigri').address_variants_json).native).toBe('6 Geetanjali Enclave, Hotel Amantran, Tigri, DL, IN');
    expect(rows.get('untranslated')).toMatchObject({ active: 0, retired_at: `publication-validation:india-english-v1:${at}` });
    expect(rows.get('chennai')).toMatchObject({ locality: 'Chennai', canonical_key: addressCanonicalKey('IN', { ...base, houseNumber: '8', locality: 'Chennai' }) });
    expect([...rows.values()].every((row) => row.native_language === 'en')).toBe(true);

    expect(await repairIndiaEnglishAddresses({ database, now: () => new Date(at) }))
      .toEqual({ countryCode: 'IN', cleaned: 0, retired: 0, duplicates: 0 });
  });
});
