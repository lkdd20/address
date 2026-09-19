import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { validateAddressQuality } from '../src/domain/address-quality.mjs';
import { validateAddressContract } from '../src/domain/address-contracts.mjs';
import { normalizeSourceRecord } from '../server/sync/address-etl.mjs';
import { PostgresAddressImporter } from '../server/sync/postgres-address-importer.mjs';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';
import { pickAddressPoolV2Address } from '../server/api/repositories/address-pool-v2.ts';
import { refreshAddressCoverage } from '../server/control/coverage.ts';
import { refreshResidentialCoverage } from '../server/database/residential-coverage.mjs';
import app from '../server/api/index.ts';

const components = {
  houseNumber: '', street: 'Main Street', locality: 'Springfield',
  admin1: 'Illinois', admin1Code: 'IL', postcode: ''
};
const shard = { id: 'street-fixture', countryCode: 'US', source: {
  id: 'fixture', name: 'OpenStreetMap', adapter: 'fixture', homepageUrl: 'https://example.test',
  dataUrl: 'https://example.test/data', licenseCode: 'CC0-1.0', licenseName: 'CC0',
  licenseUrl: 'https://example.test/license', attributionText: 'Fixture',
  attributionUrl: 'https://example.test', termsUrl: 'https://example.test/terms'
} };
const source = (longitude = -89.65) => ({
  id: 'road-1', source_record_id: 'way/1', match_level: 'street',
  admin1: 'Illinois', locality: 'Springfield', street: 'Main Street', number: '',
  longitude, latitude: 39.78
});

describe('real street address contract', () => {
  it('accepts an explicitly street-level record without a number or postcode', () => {
    expect(validateAddressQuality({ countryCode: 'US', matchLevel: 'street', components })).toMatchObject({ valid: true });
    expect(validateAddressContract('US', components, { strict: true, matchLevel: 'street' })).toMatchObject({ valid: true });
  });

  it('retains administrative, precision and postcode validation', () => {
    expect(validateAddressQuality({ countryCode: 'US', matchLevel: 'street',
      components: { ...components, locality: '' } }).valid).toBe(false);
    expect(validateAddressQuality({ countryCode: 'US', matchLevel: 'premise', components }).valid).toBe(false);
    expect(validateAddressQuality({ countryCode: 'US', matchLevel: 'street',
      components: { ...components, postcode: 'wrong' } }).valid).toBe(false);
    expect(validateAddressQuality({ countryCode: 'US', matchLevel: 'street',
      components: { ...components, houseNumber: '12' } }).valid).toBe(false);
    expect(validateAddressQuality({ countryCode: 'CN', matchLevel: 'street', components }).valid).toBe(false);
  });

  it('retains a real non-China house number when its postcode cannot be established', () => {
    const precise = { ...components, houseNumber: '12' };
    expect(validateAddressQuality({ countryCode: 'US', matchLevel: 'premise', components: precise }).valid).toBe(true);
    expect(validateAddressContract('US', precise, { matchLevel: 'premise' }).valid).toBe(true);
    expect(validateAddressContract('CN', { ...precise, district: 'Example District' }).reasons).toContain('missing_postcode');
  });

  it('normalizes a sourced street without manufacturing residential evidence', () => {
    const record = normalizeSourceRecord(source(), shard, 'overture-jsonl');
    expect(record).toMatchObject({ matchLevel: 'street', houseNumber: '', postcode: '',
      propertyType: 'unknown', residentialSourceRecordId: '' });
  });

  it('deduplicates the same street across sampled points and provider IDs', () => {
    const first = normalizeSourceRecord(source(), shard, 'overture-jsonl');
    const second = normalizeSourceRecord({ ...source(-89.6501), id: 'road-2', source_record_id: 'way/2' }, shard, 'overture-jsonl');
    expect(first).not.toBeNull();
    expect(second?.canonicalHash).toBe(first.canonicalHash);
    const otherTown = normalizeSourceRecord({ ...source(), locality: 'Chatham' }, shard, 'overture-jsonl');
    expect(otherTown?.canonicalHash).not.toBe(first.canonicalHash);
  });

  it('resolves API evidence only from the configured provider metadata', () => {
    const apiShard = { ...shard, source: { ...shard.source, recordSources: {
      geoapify: { name: 'Geoapify Reverse Geocoding', url: 'https://api.geoapify.com/v1/geocode/reverse' }
    } } };
    const value = { ...source(), source_record_provider: 'geoapify', source_dataset: 'Not an official record' };
    expect(normalizeSourceRecord(value, apiShard, 'overture-jsonl')).toMatchObject({
      sourceDataset: 'Geoapify Reverse Geocoding',
      sourceRecordUrl: 'https://api.geoapify.com/v1/geocode/reverse',
      residentialSourceRecordId: ''
    });
    expect(normalizeSourceRecord({ ...value, source_record_provider: 'unconfigured' }, apiShard, 'overture-jsonl')).toBeNull();
  });

  it('imports, indexes and generates streets with matching total counts and no residential claims', async () => {
    const directory = resolve('.data-cache', 'street-tests', randomUUID());
    const database = openTestDatabase();
    try {
      await mkdir(directory, { recursive: true });
      const file = resolve(directory, 'fixture.jsonl');
      const apiShard = { ...shard, source: { ...shard.source,
        licenseCode: 'CC0-1.0+fixture-api-authorization',
        recordSources: { api: { name: 'Fixture API', url: 'https://example.test/api' } }
      } };
      await writeFile(file, [{ ...source(), source_record_provider: 'api' }, { ...source(-89.651), id: 'second-point' },
        { ...source(), id: 'missing-city', locality: '' }].map(JSON.stringify).join('\n'));
      await database.exec(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,path)
        VALUES (1,'US','IL','Illinois','Illinois','伊利诺伊州','US/IL');
        INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name)
        VALUES (1,'US',1,'Springfield','Springfield','斯普林菲尔德');
        INSERT INTO sync_country_state(country_code,updated_at) VALUES ('US','2026-09-07T00:00:00Z');`);
      const lookup = vi.fn(() => ({ locality: 'Invented City', admin1: 'Illinois', admin1Code: 'IL', postcode: '62701' }));
      const importer = new PostgresAddressImporter({
        database, normalizeRecord: normalizeSourceRecord,
        hash: (value) => createHash('sha256').update(value).digest('hex'),
        reverseGeocoder: async () => ({ available: true, lookup }),
        localizeRecords: async (records) => records.map((record) => ({
          ...record, localizations: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
            components: language === 'zh-CN' ? { ...record.components,
              street: '主街', locality: '斯普林菲尔德', postalLocality: '斯普林菲尔德', admin1: '伊利诺伊州'
            } : record.components,
            formattedAddress: language === 'zh-CN' ? '美国伊利诺伊州斯普林菲尔德主街' : 'Main Street, Springfield, IL, US'
          }]))
        }))
      });
      const result = await importer.importShard({
        shard: apiShard, discovery: { version: 'fixture-v1', dataUrl: 'https://example.test/official' },
        materialized: { file, format: 'overture-jsonl', checksum: 'a'.repeat(64) },
        maxRecords: 10, perLocality: 10
      });
      expect(result).toMatchObject({ acceptedCount: 1, residentialCount: 0, rejectedCount: 2 });
      expect(lookup).not.toHaveBeenCalled();
      expect(await database.prepare(`SELECT evidence.record_url, dataset.license_code FROM address_pool_evidence evidence
        JOIN address_datasets dataset ON dataset.id=evidence.dataset_id WHERE evidence.evidence_type='address_existence'`).first())
        .toEqual({ record_url: 'https://example.test/api', license_code: 'CC0-1.0+fixture-api-authorization' });
      expect(await database.prepare('SELECT match_level,house_number,postcode,property_type FROM address_pool').first())
        .toMatchObject({ match_level: 'street', house_number: '', postcode: '', property_type: 'unknown' });
      expect(await database.prepare('SELECT COUNT(*) AS total FROM address_generation_index WHERE active=1').first('total')).toBe(1);
      const address = await pickAddressPoolV2Address(database, 'US', false, {}, undefined, 'fixture-street');
      expect(address).toMatchObject({ matchLevel: 'street', components: { houseNumber: '', postcode: '', admin1Code: 'IL' } });
      expect(address.evidence.map(({ type }) => type)).toEqual(['address_existence', 'coordinate']);
      expect(await pickAddressPoolV2Address(database, 'US', true, {}, undefined, 'fixture-residential')).toBeUndefined();
      await refreshAddressCoverage(database);
      await refreshResidentialCoverage(database, 'US');
      expect(await database.prepare("SELECT total_count,residential_count FROM admin_coverage_stats WHERE node_key='US'").first())
        .toMatchObject({ total_count: 1, residential_count: 0 });
      expect(await database.prepare("SELECT total_count,address_count FROM residential_coverage WHERE country_code='US'").first())
        .toMatchObject({ total_count: 1, address_count: 0 });
      const bindings = { ADDRESS_DB: database, LOCATION_DB: database, ALLOWED_ORIGIN: '*' };
      const registry = await (await app.request('/api/v1/countries', {}, bindings)).json();
      expect(registry.data.find(({ code }) => code === 'US')).toMatchObject({ addressCount: 1, residentialCount: 0 });
      const availability = await (await app.request('/api/v1/availability', {}, bindings)).json();
      expect(availability.data).toContainEqual({ code: 'US', available: true, residentialAvailable: false });
      const generated = await app.request('/api/v1/generate?country=US', {}, bindings);
      expect(generated.status).toBe(200);
      expect((await generated.json()).data.result.address.matchLevel).toBe('street');
      expect((await app.request('/api/v1/generate?country=US&residential=true', {}, bindings)).status).toBe(404);
    } finally {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
