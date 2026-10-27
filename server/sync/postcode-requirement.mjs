import { refreshAddressGenerationIndex } from '../database/generation-index.mjs';
import { addressContracts } from '../../src/domain/address-contracts.mjs';
import { staleCoverage } from './stale-coverage.mjs';

// v2 sweeps rows an interrupted import left published before imports stored postcode-less rows unpublished.
export const POSTCODE_REQUIRED_REVISION = 'postcode-required-v2';
// Hong Kong has no postcodes; China keeps its own district-level postcode rule.
export const postcodeRequired = (countryCode) => countryCode !== 'CN'
  && Boolean(addressContracts[countryCode]?.required.includes('postcode'));

// Retires rows still without a postcode once inference had its chance: after an import for the rows it wrote, and
// once per country and revision for the whole pool. A source that later supplies the postcode imports the row again.
export const retirePostcodeLessRows = async ({ database, countryCode, addressIds, pageSize = 2_000, now = () => new Date() }) => {
  const country = String(countryCode || '').toUpperCase();
  const summary = { countryCode: country, retired: 0 };
  if (!postcodeRequired(country)) return summary;
  const scoped = Array.isArray(addressIds);
  const markerKey = `${POSTCODE_REQUIRED_REVISION}:${country}`;
  if (!scoped && await database.prepare('SELECT value_json FROM translation_backfill_progress WHERE key=?')
    .bind(markerKey).first('value_json')) return summary;
  const retiredAt = `publication-validation:${POSTCODE_REQUIRED_REVISION}:${now().toISOString()}`;
  const ids = scoped ? [...new Set(addressIds.map(String))] : [];
  let cursor = '';
  for (let offset = 0; ; offset += pageSize) {
    const batch = ids.slice(offset, offset + pageSize);
    if (scoped && !batch.length) break;
    const retired = (await database.prepare(`UPDATE address_pool SET active=0,retired_at=?
      WHERE id IN (SELECT id FROM address_pool WHERE country_code=? AND active=1 AND trim(postcode)=''
        AND ${scoped ? `id IN (${batch.map(() => '?').join(',')})` : 'id>?'} ORDER BY id LIMIT ?)
      RETURNING id`).bind(retiredAt, country, ...(scoped ? batch : [cursor]), pageSize).all()).results.map((row) => row.id);
    if (retired.length) {
      await refreshAddressGenerationIndex(database, country, { addressIds: retired });
      summary.retired += retired.length;
    }
    if (!scoped) {
      if (!retired.length) break;
      cursor = retired.sort().at(-1);
    }
  }
  if (summary.retired) {
    // Loaded on use: published-pool pulls in the TypeScript reader, which plain-Node audit scripts cannot load.
    const { refreshCountryCounts } = await import('../database/published-pool.mjs');
    await refreshCountryCounts(database, country, now().toISOString(), { useGenerationIndex: true });
    staleCoverage.add(country);
  }
  if (!scoped) {
    await database.prepare(`INSERT INTO translation_backfill_progress(key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .bind(markerKey, JSON.stringify({ done: true, retired: summary.retired }), now().toISOString()).run();
  }
  return summary;
};
