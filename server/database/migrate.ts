import { openRuntimeDatabases } from './runtime';
import { ensureLocationCatalog } from './bootstrap';
import { applyAdministrativeCatalogOverrides } from './administrative-catalog-overrides';
import { refreshIndexedResidentialCoverage } from './residential-coverage.mjs';
import { reconcilePublishedPool } from './published-pool.mjs';
import { refreshAddressGenerationIndex, refreshStaleAddressGenerationIndexes } from './generation-index.mjs';
import { refreshAddressCoverage } from '../control/coverage';

// Deploys skip the full-pool consistency scans; the sync service runs them in the background after it starts.
const skipCoverage = process.argv.includes('--skip-coverage');
const databases = await openRuntimeDatabases();
try {
  if (!skipCoverage) await refreshStaleAddressGenerationIndexes(databases.address);
  if (!process.argv.includes('--coverage-only')) {
    await ensureLocationCatalog(databases.address);
    await applyAdministrativeCatalogOverrides(databases.address);
    for (const country of ['HK', 'SG']) await refreshAddressGenerationIndex(databases.address, country);
    await reconcilePublishedPool(databases.address, ['HK']);
  }
  if (!skipCoverage) {
    const coverageCountries = await refreshIndexedResidentialCoverage(databases.address, undefined, { skipLocked: true });
    await refreshAddressCoverage(databases.address, { useGenerationIndex: true });
    console.log(JSON.stringify({ event: 'migration_coverage_ready', countries: coverageCountries, at: new Date().toISOString() }));
  }
} finally {
  await databases.close();
}
