import { addressCanonicalKey, englishOnlyComponents, englishOnlyCoreFields, hasNonLatinText } from '../../src/domain/address-quality.mjs';
import { refreshAddressGenerationIndex } from '../database/generation-index.mjs';
import { formattedAddress, localizedFormattedAddress } from './address-etl.mjs';

export const INDIA_ENGLISH_REVISION = 'india-english-v1';
const cleanKey = (value) => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('und');
const foreignChinese = (value) => hasNonLatinText(String(value || '').replace(/\p{Script=Han}/gu, ''));

// India is published in English only. Stored rows lose their local-script text: an earlier English translation of the
// field is kept when there is one, otherwise the local-script runs are removed. A row left without a street, city,
// state or premise number is retired; a row that then matches an existing address is the same address twice.
export const repairIndiaEnglishAddresses = async ({ database, now = () => new Date(), pageSize = 2000 }) => {
  const key = `${INDIA_ENGLISH_REVISION}:IN`;
  const summary = { countryCode: 'IN', cleaned: 0, retired: 0, duplicates: 0 };
  if (await database.prepare('SELECT value_json FROM translation_backfill_progress WHERE key=?').bind(key).first('value_json')) return summary;
  const retiredAt = `publication-validation:${INDIA_ENGLISH_REVISION}:${now().toISOString()}`;
  const changed = [];
  let lastId = '';
  while (true) {
    const rows = (await database.prepare(`SELECT id,active,match_level,component_variants_json,address_variants_json
      FROM address_pool WHERE country_code='IN' AND id>? ORDER BY id LIMIT ?`).bind(lastId, pageSize).all()).results;
    if (!rows.length) break;
    lastId = rows.at(-1).id;
    await database.transaction(async (transaction) => {
      for (const row of rows) {
        const components = JSON.parse(row.component_variants_json || '{}');
        const before = components.native || {};
        const previousEnglish = components.en || {};
        if (![before, previousEnglish].some((variant) => Object.values(variant).some(hasNonLatinText))) continue;
        const { components: native, emptied } = englishOnlyComponents(before, previousEnglish);
        if (emptied.some((field) => englishOnlyCoreFields.includes(field) || field === 'houseNumber' && row.match_level !== 'street')) {
          if (Number(row.active) !== 1) continue;
          await transaction.prepare('UPDATE address_pool SET active=0,retired_at=? WHERE id=?').bind(retiredAt, row.id).run();
          changed.push(row.id);
          summary.retired += 1;
          continue;
        }
        const english = { ...previousEnglish };
        const chinese = { ...components['zh-CN'] };
        for (const field of new Set([...Object.keys(before), ...Object.keys(english)])) {
          if (native[field] === before[field] && !hasNonLatinText(english[field])) continue;
          if (native[field] === undefined) {
            delete english[field];
            delete chinese[field];
            continue;
          }
          english[field] = native[field];
          if (chinese[field] === undefined || foreignChinese(chinese[field])) chinese[field] = native[field];
        }
        const canonicalKey = addressCanonicalKey('IN', native, row.match_level);
        const duplicate = await transaction.prepare(`SELECT id FROM address_pool WHERE country_code='IN' AND canonical_key=? AND id<>? LIMIT 1`)
          .bind(canonicalKey, row.id).first('id');
        if (duplicate) {
          await transaction.prepare('DELETE FROM address_pool WHERE id=?').bind(row.id).run();
          changed.push(row.id);
          summary.duplicates += 1;
          continue;
        }
        const addresses = JSON.parse(row.address_variants_json || '{}');
        await transaction.prepare(`UPDATE address_pool SET street=?,house_number=?,building_name=?,locality=?,postal_locality=?,
            district=?,admin1=?,admin1_key=?,locality_key=?,postal_locality_key=?,district_key=?,canonical_key=?,
            native_language='en',component_variants_json=?,address_variants_json=? WHERE id=?`)
          .bind(native.street, native.houseNumber || '', native.buildingName || '', native.locality || '', native.postalLocality || '',
            native.district || '', native.admin1 || '', cleanKey(native.admin1), cleanKey(native.locality), cleanKey(native.postalLocality),
            cleanKey(native.district), canonicalKey,
            JSON.stringify({ ...components, native, en: english, 'zh-CN': chinese }),
            JSON.stringify({ ...addresses, native: formattedAddress(native, 'IN'), en: localizedFormattedAddress(english, 'IN', 'en'),
              ...(foreignChinese(addresses['zh-CN']) || JSON.stringify(chinese) !== JSON.stringify(components['zh-CN'] || {})
                ? { 'zh-CN': localizedFormattedAddress(chinese, 'IN', 'zh-CN') } : {}) }), row.id).run();
        changed.push(row.id);
        summary.cleaned += 1;
      }
    });
  }
  await database.prepare(`UPDATE address_pool SET native_language='en' WHERE country_code='IN' AND native_language<>'en'`).run();
  // The index is refreshed before the revision is recorded, so a timeout here is retried at the next start.
  for (let offset = 0; offset < changed.length; offset += 500) {
    await refreshAddressGenerationIndex(database, 'IN', { addressIds: changed.slice(offset, offset + 500) });
  }
  await database.prepare(`INSERT INTO translation_backfill_progress(key,value_json,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
    .bind(key, JSON.stringify({ done: true, ...summary }), now().toISOString()).run();
  return summary;
};
