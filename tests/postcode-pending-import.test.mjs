import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';
import { normalizeSourceRecord } from '../server/sync/address-etl.mjs';
import { PostgresAddressImporter } from '../server/sync/postgres-address-importer.mjs';
import { runPostcodeInference } from '../server/sync/postcode-inference.mjs';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const source = {
  id: 'pending', adapter: 'overture', name: 'Fixture', homepageUrl: 'https://example.test',
  dataUrl: 'https://example.test/data', licenseCode: 'CC0-1.0', licenseName: 'CC0',
  licenseUrl: 'https://example.test/license', attributionText: 'Fixture',
  attributionUrl: 'https://example.test', termsUrl: 'https://example.test/terms',
  shareAlike: false, redistributionAllowed: true
};

const importRows = async (database, directory, version, rows) => {
  const file = resolve(directory, `${version}.jsonl`);
  await writeFile(file, `${rows.map((extra, index) => JSON.stringify({
    id: `overture-${index}`, admin1: 'Pennsylvania', locality: 'Philadelphia', postal_city: 'Philadelphia',
    street: 'Market Street', number: String(1700 + index), longitude: -75.169 + index / 1000, latitude: 39.953,
    property_type: 'unknown', ...extra
  })).join('\n')}\n`, 'utf8');
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
  return importer.importShard({
    shard: { id: 'pending-us', countryCode: 'US', source },
    discovery: { version, dataUrl: source.dataUrl },
    materialized: { file, format: 'overture-jsonl', checksum: createHash('sha256').update(version).digest('hex') },
    maxRecords: 10, perLocality: 10, policy: { targetCount: 10, levelLimits: [100, 100, 100, 0], overrides: new Map() }
  });
};

describe('imports without a required postcode', () => {
  it('store the row unpublished until inference fills it, and a later import with the postcode publishes', async () => {
    const directory = resolve('.data-cache', 'postcode-pending-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const database = openTestDatabase(':memory:');
    try {
      await importRows(database, directory, 'v1', [{ postcode: '19103' }, {}, {}]);
      const rows = async () => (await database.prepare('SELECT id,active,retired_at,postcode FROM address_pool ORDER BY house_number').all()).results;
      const [published, inferred, later] = await rows();
      expect(published).toMatchObject({ active: 1, retired_at: null });
      for (const row of [inferred, later]) {
        expect(row).toMatchObject({ active: 0, retired_at: expect.stringMatching(/^publication-validation:postcode-required-v2:/u) });
      }
      expect(await database.prepare('SELECT COUNT(*) AS total FROM address_generation_index WHERE active=1').first('total')).toBe(1);

      const summary = await runPostcodeInference({
        database, countryCode: 'US', addressIds: [inferred.id, later.id],
        boundaryLookup: async () => new Map([[inferred.id, '19103']])
      });
      expect(summary).toMatchObject({ boundary: 1, restored: 1 });
      expect(summary.filledIds).toEqual([inferred.id]);
      expect((await rows())[1]).toMatchObject({ active: 1, retired_at: null, postcode: '19103' });

      await importRows(database, directory, 'v2', [{ postcode: '19103' }, {}, { postcode: '19104' }]);
      const published19104 = (await rows()).filter((row) => row.postcode === '19104');
      expect(published19104).toEqual([expect.objectContaining({ active: 1, retired_at: null })]);
      expect(await database.prepare('SELECT active FROM address_pool WHERE id=?').bind(later.id).first('active')).toBe(0);
    } finally {
      await database.close();
    }
  });

  it('skip rows deleted while their postcodes were looked up', async () => {
    const directory = resolve('.data-cache', 'postcode-pending-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const database = openTestDatabase(':memory:');
    try {
      await importRows(database, directory, 'v1', [{}, {}]);
      const ids = (await database.prepare('SELECT id FROM address_pool ORDER BY house_number').all()).results.map((row) => row.id);
      const summary = await runPostcodeInference({
        database, countryCode: 'US', addressIds: ids,
        boundaryLookup: async () => {
          await database.prepare('DELETE FROM address_pool WHERE id=?').bind(ids[1]).run();
          return new Map(ids.map((id) => [id, '19103']));
        }
      });
      expect(summary.filledIds).toEqual([ids[0]]);
      expect(await database.prepare('SELECT COUNT(*) AS total FROM address_postcode_inference').first('total')).toBe(1);
    } finally {
      await database.close();
    }
  });
});
