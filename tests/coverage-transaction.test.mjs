import { expect, it, vi } from 'vitest';
import { refreshIndexedResidentialCoverage, refreshResidentialCoverage } from '../server/database/residential-coverage.mjs';

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

it('retries a lock timeout with backoff instead of failing the refresh', async () => {
  let attempts = 0;
  const lockTimeout = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
  const database = { transaction: async () => { attempts += 1; if (attempts < 3) throw lockTimeout; return 'refreshed'; } };
  await expect(refreshResidentialCoverage(database, 'CA')).resolves.toBe('refreshed');
  expect(attempts).toBe(3);
});

it('gives up after bounded lock retries and leaves other errors untouched', async () => {
  const fail = (code) => ({ transaction: async () => { throw Object.assign(new Error(code), { code }); } });
  await expect(refreshResidentialCoverage(fail('23505'), 'CA')).rejects.toMatchObject({ code: '23505' });
  const controller = new AbortController();
  controller.abort();
  await expect(refreshResidentialCoverage(fail('55P03'), 'CA', undefined, controller.signal)).rejects.toThrow();
});

it('skips only lock-contended countries when the migration asks to', async () => {
  const lockTimeout = Object.assign(new Error('lock timeout'), { code: '55P03' });
  let calls = 0;
  const countries = { prepare: () => ({ all: async () => ({ results: [{ country_code: 'BR' }, { country_code: 'PH' }] }) }) };
  const database = { ...countries, transaction: async () => { calls += 1; if (calls <= 6) throw lockTimeout; return 'done'; } };
  vi.useFakeTimers();
  try {
    const skipped = refreshIndexedResidentialCoverage(database, '2026-10-01T00:00:00Z', { skipLocked: true });
    await vi.runAllTimersAsync();
    await expect(skipped).resolves.toEqual(['PH']);
    const strict = refreshIndexedResidentialCoverage({ ...countries, transaction: async () => { throw lockTimeout; } });
    const assertion = expect(strict).rejects.toMatchObject({ code: '55P03' });
    await vi.runAllTimersAsync();
    await assertion;
  } finally {
    vi.useRealTimers();
  }
});
