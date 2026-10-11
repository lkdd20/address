import { addressCanonicalKey } from '../../src/domain/address-quality.mjs';
import { refreshAddressGenerationIndex } from '../database/generation-index.mjs';
import { formattedAddress } from './address-etl.mjs';

const cleanKey = (value) => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('und');
const localityFields = ['locality', 'postalLocality'];
// v2 also scopes cities by region code (WA, GU) and replays every repair once; replays are idempotent.
export const CATALOG_NATIVE_REPAIR_REVISION = 'catalog-native-addresses-v2';

// Rewrites stored addresses whose region or city was filled with a catalog native name that the reviewed correction
// table replaced (Ordu stored as "Saat"). A city is renamed only inside its own region, so a common word that was a
// bad native elsewhere is left alone. A renamed row that then matches an existing address is the same address twice.
export const repairCatalogNativeAddresses = async ({ database, now = () => new Date() }) => {
  const revisionKey = `${CATALOG_NATIVE_REPAIR_REVISION}:all`;
  const replay = !await database.prepare('SELECT value_json FROM translation_backfill_progress WHERE key=?').bind(revisionKey).first('value_json');
  const pending = (await database.prepare(`SELECT table_name,catalog_id,country_code,region_id,old_native,new_native,english_name
    FROM catalog_native_repairs WHERE (applied_at IS NULL OR ?=1) AND old_native<>'' ORDER BY country_code,table_name,catalog_id`)
    .bind(Number(replay)).all()).results;
  const summaries = [];
  for (const countryCode of [...new Set(pending.map((repair) => repair.country_code))]) {
    const repairs = pending.filter((repair) => repair.country_code === countryCode);
    const regionNames = new Map(((await database.prepare('SELECT id,code,name,native_name FROM catalog_regions WHERE country_code=?')
      .bind(countryCode).all()).results || []).map((region) => [Number(region.id), new Set([region.code, region.name, region.native_name].filter(Boolean).map(cleanKey))]));
    const regions = new Map();
    const cities = new Map();
    for (const repair of repairs) {
      if (repair.table_name === 'catalog_regions') {
        regions.set(repair.old_native, repair);
        regionNames.get(Number(repair.catalog_id))?.add(cleanKey(repair.old_native));
      } else cities.set(repair.old_native, [...cities.get(repair.old_native) || [], repair]);
    }
    const summary = { countryCode, renamed: 0, duplicates: 0 };
    const renamed = [];
    const keys = [...new Set([...regions.keys(), ...cities.keys()].map(cleanKey))];
    for (let offset = 0; offset < keys.length; offset += 400) {
      const chunk = keys.slice(offset, offset + 400);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = (await database.prepare(`SELECT id,match_level,component_variants_json,address_variants_json FROM address_pool
        WHERE country_code=? AND (admin1_key IN (${placeholders}) OR locality_key IN (${placeholders})
          OR postal_locality_key IN (${placeholders}))`).bind(countryCode, ...chunk, ...chunk, ...chunk).all()).results;
      await database.transaction(async (transaction) => {
        for (const row of rows) {
          const components = JSON.parse(row.component_variants_json || '{}');
          const addresses = JSON.parse(row.address_variants_json || '{}');
          const before = components.native || {};
          const english = components.en ? { ...components.en } : undefined;
          const native = { ...before };
          const region = regions.get(before.admin1);
          if (region) {
            native.admin1 = region.new_native;
            if (english?.admin1 === before.admin1) english.admin1 = region.english_name;
          }
          const inRegion = (repair) => repair.region_id == null
            || [before.admin1, native.admin1].some((name) => regionNames.get(Number(repair.region_id))?.has(cleanKey(name)));
          for (const field of localityFields) {
            const city = (cities.get(before[field]) || []).find(inRegion);
            if (!city) continue;
            native[field] = city.new_native;
            if (english?.[field] === before[field]) english[field] = city.english_name;
          }
          if (JSON.stringify(native) === JSON.stringify(before)) continue;
          const canonicalKey = addressCanonicalKey(countryCode, native, row.match_level);
          const duplicate = await transaction.prepare('SELECT id FROM address_pool WHERE country_code=? AND canonical_key=? AND id<>? LIMIT 1')
            .bind(countryCode, canonicalKey, row.id).first('id');
          if (duplicate) {
            await transaction.prepare('DELETE FROM address_pool WHERE id=?').bind(row.id).run();
            summary.duplicates += 1;
            continue;
          }
          if (addresses.native === formattedAddress(before, countryCode)) addresses.native = formattedAddress(native, countryCode);
          if (english && components.en && addresses.en === formattedAddress(components.en, countryCode)) addresses.en = formattedAddress(english, countryCode);
          await transaction.prepare(`UPDATE address_pool SET admin1=?,locality=?,postal_locality=?,admin1_key=?,locality_key=?,
              postal_locality_key=?,canonical_key=?,component_variants_json=?,address_variants_json=? WHERE id=?`)
            .bind(native.admin1 || '', native.locality || '', native.postalLocality || '', cleanKey(native.admin1),
              cleanKey(native.locality), cleanKey(native.postalLocality), canonicalKey,
              JSON.stringify({ ...components, native, ...(english ? { en: english } : {}) }), JSON.stringify(addresses), row.id).run();
          renamed.push(row.id);
        }
      });
    }
    // The index is refreshed before the repairs are marked applied, so a timeout here is retried at the next start.
    for (let offset = 0; offset < renamed.length; offset += 500) {
      await refreshAddressGenerationIndex(database, countryCode, { addressIds: renamed.slice(offset, offset + 500) });
    }
    await database.prepare('UPDATE catalog_native_repairs SET applied_at=? WHERE country_code=? AND (applied_at IS NULL OR ?=1)')
      .bind(now().toISOString(), countryCode, Number(replay)).run();
    summary.renamed = renamed.length;
    summaries.push(summary);
  }
  if (replay) {
    await database.prepare(`INSERT INTO translation_backfill_progress(key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .bind(revisionKey, JSON.stringify({ done: true }), now().toISOString()).run();
  }
  return summaries;
};
