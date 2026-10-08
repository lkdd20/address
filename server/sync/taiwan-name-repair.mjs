import { addressCanonicalKey } from '../../src/domain/address-quality.mjs';
import { refreshAddressGenerationIndex } from '../database/generation-index.mjs';
import { formattedAddress, taiwanOfficialName } from './address-etl.mjs';

export const TAIWAN_OFFICIAL_NAME_REVISION = 'taiwan-official-name-v1';

// Rewrites stored Taiwan county and township names to the official 臺 form. A row that then matches an address
// already stored under the official name is the same address twice and is removed; the official row stays.
export const repairTaiwanOfficialNames = async ({ database, now = () => new Date() }) => {
  const key = `${TAIWAN_OFFICIAL_NAME_REVISION}:TW`;
  const summary = { countryCode: 'TW', renamed: 0, duplicates: 0 };
  if (await database.prepare('SELECT value_json FROM translation_backfill_progress WHERE key=?').bind(key).first('value_json')) return summary;
  const rows = (await database.prepare(`SELECT id,match_level,component_variants_json,address_variants_json FROM address_pool
    WHERE country_code='TW' AND (admin1 LIKE '台%' OR locality LIKE '台%' OR postal_locality LIKE '台%') ORDER BY id`).all()).results;
  const renamed = [];
  await database.transaction(async (transaction) => {
    for (const row of rows) {
      const components = JSON.parse(row.component_variants_json || '{}');
      const addresses = JSON.parse(row.address_variants_json || '{}');
      const previous = components.native || {};
      const native = { ...previous, admin1: taiwanOfficialName(previous.admin1),
        locality: taiwanOfficialName(previous.locality), postalLocality: taiwanOfficialName(previous.postalLocality) };
      const canonicalKey = addressCanonicalKey('TW', native, row.match_level);
      const duplicate = await transaction.prepare(`SELECT id FROM address_pool WHERE country_code='TW' AND canonical_key=? AND id<>? LIMIT 1`)
        .bind(canonicalKey, row.id).first('id');
      if (duplicate) {
        await transaction.prepare('DELETE FROM address_pool WHERE id=?').bind(row.id).run();
        summary.duplicates += 1;
        continue;
      }
      if (addresses.native === formattedAddress(previous, 'TW')) addresses.native = formattedAddress(native, 'TW');
      await transaction.prepare(`UPDATE address_pool SET admin1=?,locality=?,postal_locality=?,canonical_key=?,
          component_variants_json=?,address_variants_json=? WHERE id=?`)
        .bind(native.admin1, native.locality, native.postalLocality, canonicalKey,
          JSON.stringify({ ...components, native }), JSON.stringify(addresses), row.id).run();
      renamed.push(row.id);
    }
    await transaction.prepare(`INSERT INTO translation_backfill_progress(key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .bind(key, JSON.stringify({ done: true }), now().toISOString()).run();
  });
  summary.renamed = renamed.length;
  if (renamed.length) await refreshAddressGenerationIndex(database, 'TW', { addressIds: renamed });
  return summary;
};
