import { describe, expect, it } from 'vitest';
import { initializeTestDatabase, openTestDatabase } from './helpers/postgres-test-database.mjs';
import { refreshAddressGenerationIndex } from '../server/database/generation-index.mjs';
import { reconcilePublishedPool } from '../server/database/published-pool.mjs';
import { loadAddressPoolV2AddressById, pickAddressPoolV2Address } from '../server/api/repositories/address-pool-v2';
import { queryLocationCatalog } from '../server/api/repositories/location-catalog';
import { normalizeSourceRecord } from '../server/sync/address-etl.mjs';
import { validateAddressQuality } from '../src/domain/address-quality.mjs';

const now = '2026-09-13T00:00:00.000Z';
const shard = { id: 'sg-fixture', countryCode: 'SG', source: { id: 'fixture', name: 'Fixture', adapter: 'fixture',
  homepageUrl: 'https://example.test', dataUrl: 'https://example.test/data', licenseCode: 'CC0-1.0',
  licenseName: 'CC0', licenseUrl: 'https://example.test/license', attributionText: 'Fixture',
  attributionUrl: 'https://example.test', termsUrl: 'https://example.test/terms' } };

describe('Singapore source-backed postcode publication', () => {
  it('never fills a missing source postcode for either address precision', () => {
    for (const matchLevel of ['premise', 'street'] as const) {
      const input = { id: 'fixture', source_record_id: 'fixture', match_level: matchLevel, admin1: 'Singapore',
        locality: 'Singapore', street: 'Fixture Road', number: matchLevel === 'street' ? '' : '12', latitude: 1.3, longitude: 103.8 };
      const missing = normalizeSourceRecord(input, shard, 'overture-jsonl');
      expect(missing?.postcode).toBe('');
      expect(validateAddressQuality({ countryCode: 'SG', components: missing?.components, matchLevel }).reasons).toContain('missing_postcode');
      expect(normalizeSourceRecord({ ...input, postcode: '123456' }, shard, 'overture-jsonl'))
        .toMatchObject({ postcode: '123456', matchLevel });
    }
  });

  it('rebuilds publication and retires old missing-postcode rows without deleting source records or unlocking sources', async () => {
    const db = openTestDatabase();
    try {
      await initializeTestDatabase(db, new URL('../server/control/schema.sql', import.meta.url));
      await db.exec(`INSERT INTO address_sources(id,name,homepage_url,data_url,license_code,license_name,license_url,
        attribution_text,attribution_url,terms_url,share_alike,notice_required,redistribution_allowed,created_at,updated_at)
        VALUES ('fixture','Fixture','https://example.test','https://example.test/data','CC0-1.0','CC0','https://example.test/license',
          'Fixture','https://example.test','https://example.test/terms',0,0,1,'${now}','${now}');
        INSERT INTO address_datasets(id,source_id,country_code,version,retrieved_at,imported_at,input_checksum,format,
          license_code,license_name,license_url,attribution_text,attribution_url,terms_url,share_alike,notice_required,redistribution_allowed,status)
        VALUES ('sg-fixture','fixture','SG','unchanged-source','${now}','${now}','${'a'.repeat(64)}','jsonl',
          'CC0-1.0','CC0','https://example.test/license','Fixture','https://example.test','https://example.test/terms',0,0,1,'active');
        INSERT INTO sync_source_execution_state(country_code,source_id,state,source_fingerprint,updated_at)
          VALUES ('SG','fixture','exhausted','unchanged-source','${now}');
        INSERT INTO catalog_postcodes(id,country_code,code,locality_name) VALUES (1,'SG','123456','Singapore'),(2,'SG','654321','Singapore');`);
      const sourceState = await db.prepare('SELECT * FROM sync_source_execution_state').first();
      for (const [id, postcode, precision] of [
        ['valid-premise', '123456', 'premise'], ['valid-street', '654321', 'street'],
        ['missing-premise', '', 'premise'], ['missing-street', '', 'street'],
        ['invalid-format', '12345', 'premise'], ['no-evidence', '123456', 'premise']
      ]) {
        const components = { houseNumber: precision === 'street' ? '' : '12', street: `Fixture ${id} Road`,
          locality: 'Singapore', admin1: 'Singapore', postcode };
        await db.prepare(`INSERT INTO address_pool(id,country_code,admin1,locality,postcode,street,house_number,
          latitude,longitude,native_language,component_variants_json,address_variants_json,property_type,
          quality_score,generation,coverage,random_key,active,first_seen_at,last_seen_at,match_level,
          admin1_key,locality_key,postcode_key)
          VALUES (?,'SG','Singapore','Singapore',?,?,?,1.3,103.8,'en',?,?,'unknown',.95,'fixture','SG',1,1,?,?,?,'singapore','singapore',?)`)
          .bind(id, postcode, components.street, components.houseNumber, JSON.stringify({ native: components, en: components,
            'zh-CN': { ...components, street: '测试路', locality: '新加坡', admin1: '新加坡' } }),
          JSON.stringify({ native: `${components.street}, Singapore ${postcode}`, en: `${components.street}, Singapore ${postcode}`,
            'zh-CN': `新加坡测试路 ${postcode}` }), now, now, precision, postcode).run();
        if (id !== 'no-evidence') await db.prepare(`INSERT INTO address_pool_evidence(id,address_id,dataset_id,source_record_id,
          observed_at,evidence_type,is_primary,is_current,created_at) VALUES (?,?,'sg-fixture',?,?,'address_existence',1,1,?)`)
          .bind(id, id, id, now, now).run();
        if (!['no-evidence', 'invalid-format'].includes(id)) await db.prepare(`INSERT INTO address_generation_index(
          address_id,country_code,country_rank,random_key,updated_at) VALUES (?,'SG',1,1,?)`).bind(id, now).run();
      }
      expect(await refreshAddressGenerationIndex(db, 'SG')).toBe(2);
      expect((await db.prepare("SELECT address_id FROM address_generation_index WHERE active=1 ORDER BY address_id").all()).results)
        .toEqual([{ address_id: 'valid-premise' }, { address_id: 'valid-street' }]);
      const reconciled = await reconcilePublishedPool(db, ['SG'], now);
      expect(reconciled[0].retired).toBe(3);
      expect(await db.prepare('SELECT COUNT(*) AS total FROM address_pool').first('total')).toBe(6);
      expect(await db.prepare('SELECT COUNT(*) AS total FROM address_pool_evidence').first('total')).toBe(5);
      expect(await db.prepare("SELECT postcode,active,retired_at FROM address_pool WHERE id='missing-street'").first())
        .toMatchObject({ postcode: '', active: 0, retired_at: expect.stringMatching(/^publication-validation:/u) });
      expect(await db.prepare("SELECT address_count FROM sync_country_state WHERE country_code='SG'").first('address_count')).toBe(2);
      expect(await db.prepare('SELECT * FROM sync_source_execution_state').first()).toEqual(sourceState);
      expect(await loadAddressPoolV2AddressById(db, 'pool-v2-missing-street')).toBeUndefined();
      const generated = await pickAddressPoolV2Address(db, 'SG', false, {}, undefined, 'fixture');
      expect(generated?.addressStatus).toBe('verified');
      expect(generated?.components.postcode).toMatch(/^\d{6}$/u);
      expect(generated?.evidence[0].datasetId).toBe('sg-fixture');
      const options = await queryLocationCatalog(db, { country: 'SG', field: 'postcode' });
      expect(options.options.map((option) => option.value)).toEqual(['123456', '654321']);
    } finally { await db.close(); }
  });
});
