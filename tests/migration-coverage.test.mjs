import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(() => ({ all: async () => ({ results: [] }) })),
  close: vi.fn(), index: vi.fn(), projection: vi.fn(), catalog: vi.fn(), overrides: vi.fn(),
  reconcile: vi.fn(), regions: vi.fn(async () => ['US']), admin: vi.fn()
}));
vi.mock('../server/database/runtime', () => ({
  openRuntimeDatabases: async () => ({ address: { prepare: mocks.prepare }, close: mocks.close })
}));
vi.mock('../server/database/generation-index.mjs', () => ({
  refreshStaleAddressGenerationIndexes: mocks.index,
  refreshAddressGenerationIndex: mocks.projection
}));
vi.mock('../server/database/bootstrap', () => ({ ensureLocationCatalog: mocks.catalog }));
vi.mock('../server/database/administrative-catalog-overrides', () => ({ applyAdministrativeCatalogOverrides: mocks.overrides }));
vi.mock('../server/database/published-pool.mjs', () => ({ reconcilePublishedPool: mocks.reconcile }));
vi.mock('../server/database/residential-coverage.mjs', () => ({ refreshIndexedResidentialCoverage: mocks.regions }));
vi.mock('../server/control/coverage', () => ({ refreshAddressCoverage: mocks.admin }));

describe('migration coverage recovery', () => {
  const argv = [...process.argv];
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.argv = [...argv];
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    process.argv = [...argv];
    vi.restoreAllMocks();
  });

  it('refreshes every relevant country even when this attempt retired no records', async () => {
    mocks.reconcile.mockResolvedValueOnce([{ countryCode: 'HK', before: 2, after: 2 }]);
    await import('../server/database/migrate.ts');
    expect(mocks.regions).toHaveBeenCalledOnce();
    expect(mocks.projection.mock.calls.map(([, country]) => country)).toEqual(['HK', 'SG']);
    expect(mocks.reconcile).toHaveBeenCalledWith(expect.anything(), ['HK']);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.admin).toHaveBeenCalledWith(expect.anything(), { useGenerationIndex: true });
    expect(mocks.regions.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.reconcile.mock.invocationCallOrder[0]);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('runs coverage-only recovery after checking the index without revalidating addresses or catalogs', async () => {
    process.argv.push('--coverage-only');
    await import('../server/database/migrate.ts');
    expect(mocks.index).toHaveBeenCalledOnce();
    expect(mocks.regions).toHaveBeenCalledOnce();
    expect(mocks.regions.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.index.mock.invocationCallOrder[0]);
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.overrides).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('fails closed and closes the database when publication-index verification fails', async () => {
    process.argv.push('--coverage-only');
    mocks.index.mockRejectedValueOnce(new Error('Index verification failed'));
    await expect(import('../server/database/migrate.ts')).rejects.toThrow('Index verification failed');
    expect(mocks.regions).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
