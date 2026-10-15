import { describe, expect, it } from 'vitest';
import { adjustCountryCounts } from '../server/database/published-pool.mjs';

const fakeDatabase = (changes) => {
  const statements = [];
  const database = {
    statements,
    prepare: (sql) => ({
      bind: (...values) => {
        statements.push({ sql, values });
        return {
          run: async () => ({ meta: { changes: sql.startsWith('UPDATE sync_country_state') ? changes.state : changes.coverage } }),
          first: async () => ({ address_count: 7, residential_count: 2 })
        };
      }
    }),
    batch: async (batch) => { statements.push(...batch.map(() => ({ sql: 'batch' }))); }
  };
  return database;
};

describe('published country counts', () => {
  it('adds a batch delta to the stored counts without recounting the country', async () => {
    const database = fakeDatabase({ state: 1, coverage: 1 });
    await adjustCountryCounts(database, 'FR', { total: 3, residential: 1 }, '2026-10-15T00:00:00.000Z');
    expect(database.statements.map(({ sql }) => sql.split(/\s/u)[0])).toEqual(['UPDATE', 'UPDATE']);
    expect(database.statements[0].values).toEqual([3, 1, '2026-10-15T00:00:00.000Z', 'FR']);
    expect(database.statements[1].values).toEqual([3, 1, 2, '2026-10-15T00:00:00.000Z', 'FR']);
  });

  it('recounts a country whose count rows do not exist yet', async () => {
    const database = fakeDatabase({ state: 0, coverage: 1 });
    await adjustCountryCounts(database, 'FR', { total: 1, residential: 0 }, '2026-10-15T00:00:00.000Z');
    expect(database.statements.some(({ sql }) => sql.includes('COUNT(*)'))).toBe(true);
  });

  it('writes nothing for an unchanged batch', async () => {
    const database = fakeDatabase({ state: 1, coverage: 1 });
    await adjustCountryCounts(database, 'CN', { total: 0, residential: 0 }, '2026-10-15T00:00:00.000Z');
    expect(database.statements).toEqual([]);
  });
});
