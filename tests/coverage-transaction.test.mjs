import { expect, it } from 'vitest';
import { refreshResidentialCoverage } from '../server/database/residential-coverage.mjs';

it('does not overwrite a concurrently committed publication with pre-transaction coverage', async () => {
  let sourceCount = 1;
  let storedCount = 0;
  const database = {
    exec: async () => {},
    prepare(sql) {
      let values;
      return {
        bind(...args) { values = args; return this; },
        async all() {
          return { results: sql.includes('FROM catalog_regions')
            ? [{ id: 1, code: 'ON', name: 'Ontario', path: 'CA/ON' }]
            : sql.includes('FROM catalog_cities') ? []
              : [{ admin1: 'Ontario', admin1_code: 'ON', city_name: '', address_count: sourceCount, residential_count: sourceCount }] };
        },
        async run() { if (sql.includes('INSERT INTO residential_coverage')) storedCount = values[7]; }
      };
    },
    async batch(statements) { for (const statement of statements) await statement.run(); },
    async transaction(work) { sourceCount = 2; return work(database); }
  };
  await refreshResidentialCoverage(database, 'CA', '2026-09-13T00:00:00Z', undefined, { useGenerationIndex: true });
  expect(storedCount).toBe(sourceCount);
});
