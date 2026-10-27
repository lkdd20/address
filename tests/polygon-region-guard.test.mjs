import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';
import { normalizeSourceRecord } from '../server/sync/address-etl.mjs';
import { PostgresAddressImporter } from '../server/sync/postgres-address-importer.mjs';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('import-time polygon region guard', () => {
  it('rejects records a polygon-assigned snapshot left without a region', async () => {
    const directory = resolve('.data-cache', 'polygon-guard-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'regions.jsonl');
    const row = (index, extra = {}) => JSON.stringify({
      id: `overture-${index}`, admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia', postcode: '19103',
      street: 'Market Street', number: String(1700 + index), longitude: -75.169 + index / 1000, latitude: 39.953,
      property_type: 'unknown', ...extra
    });
    const region = { region: { name: 'Pennsylvania', nameEn: 'Pennsylvania', code: 'US-PA' } };
    await writeFile(file, `${[row(0, { admin_region: region }), row(1)].join('\n')}\n`, 'utf8');
    const database = openTestDatabase(':memory:');
    const importer = new PostgresAddressImporter({
      database,
      normalizeRecord: normalizeSourceRecord,
      hash: (value) => createHash('sha256').update(value).digest('hex'),
      localizeRecords: async (records) => records.map((value) => ({
        ...value,
        localizations: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
          components: value.components, formattedAddress: value.formattedAddress, source: 'fixture'
        }]))
      }))
    });
    const source = {
      id: 'polygon', adapter: 'overture', name: 'Fixture', homepageUrl: 'https://example.test',
      dataUrl: 'https://example.test/data', licenseCode: 'CC0-1.0', licenseName: 'CC0',
      licenseUrl: 'https://example.test/license', attributionText: 'Fixture',
      attributionUrl: 'https://example.test', termsUrl: 'https://example.test/terms',
      shareAlike: false, redistributionAllowed: true
    };
    const result = await importer.importShard({
      shard: { id: 'polygon-us', countryCode: 'US', source },
      discovery: { version: 'v1', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: 'd'.repeat(64), regionsAssigned: true },
      maxRecords: 10, perLocality: 10, policy: { targetCount: 10, levelLimits: [100, 100, 100, 0], overrides: new Map() }
    });
    expect(result).toMatchObject({ acceptedCount: 1, rejectedCount: 1 });
    expect(result.rejectionReasons).toMatchObject({ region_unverified: 1 });
    database.close();
  });
});
