import { describe, expect, it } from 'vitest';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';
import { PERMANENT_RETIREMENT_PREFIXES, purgePermanentRetirements } from '../server/sync/retired-purge.mjs';

const insert = (database, id, retiredAt, lastSeenAt = '2026-01-01T00:00:00Z') => database.prepare(`INSERT INTO address_pool(id,country_code,admin1,locality,street,house_number,
    postcode,latitude,longitude,native_language,component_variants_json,address_variants_json,quality_score,generation,coverage,
    random_key,active,first_seen_at,last_seen_at,retired_at)
  VALUES (?,'IT','Lazio','Roma','Via Roma','1','',41.9,12.5,'it','{}','{}',.9,'v1','x',1,?,'2026-01-01T00:00:00Z',?,?)`)
  .bind(id, retiredAt ? 0 : 1, lastSeenAt, retiredAt).run();

describe('retired address purge', () => {
  it('deletes permanently retired rows and keeps published, translation-retired and freshly imported rows', async () => {
    const database = openTestDatabase(':memory:');
    try {
      await insert(database, 'published', null);
      await insert(database, 'postcode', 'publication-validation:postcode-required-v1:2026-10-26T00:00:00Z');
      await insert(database, 'region', 'publication-validation:administrative-names-v21:2026-10-26T00:00:00Z');
      await insert(database, 'structure', 'publication-validation:address-structure-v1:2026-10-26T00:00:00Z');
      await insert(database, 'translation', 'publication-validation:address-reader-v7-implausible-phrases:2026-10-26T00:00:00Z');
      // Written by an import still running: its postcode inference may yet publish it.
      await insert(database, 'importing', 'publication-validation:postcode-required-v2:2026-10-27T00:00:00Z', new Date().toISOString());
      await database.prepare(`INSERT INTO address_postcode_inference(address_id,postcode,method,source,checked_revision,updated_at)
        VALUES ('postcode','','','','v1','2026-10-26T00:00:00Z')`).run();

      const keepPostcode = PERMANENT_RETIREMENT_PREFIXES.filter((prefix) => prefix !== 'postcode-required-');
      expect(await purgePermanentRetirements({ database, countryCode: 'IT', prefixes: keepPostcode, pauseMs: 0 })).toMatchObject({ deleted: 2 });
      expect(await purgePermanentRetirements({ database, countryCode: 'IT', pauseMs: 0, pageSize: 1 })).toMatchObject({ deleted: 1 });
      const left = (await database.prepare('SELECT id FROM address_pool ORDER BY id').all()).results.map((row) => row.id);
      expect(left).toEqual(['importing', 'published', 'translation']);
      expect(await database.prepare('SELECT COUNT(*) AS total FROM address_postcode_inference').first('total')).toBe(0);
    } finally {
      await database.close();
    }
  });
});
