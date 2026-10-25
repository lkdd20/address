import { componentLooksLocalized, implausibleChineseTranslation, normalizeChineseStreetType, semanticAddressFields } from '../../src/domain/address-localization.mjs';
import { localizedFormattedAddress } from './address-etl.mjs';

export const CHINESE_ADDRESS_FORMAT_REVISION = 'chinese-address-format-v4';
// Japan rescans once more: the first English-first release replaced its usable kanji place names with English
// (北海道 → Hokkaidō). Chinese-language sources (TW, HK) never queue their Chinese names, so they were not affected.
const countryRevisions = { JP: 'chinese-address-format-v5' };
const hanSourceField = (native, english, value) => Boolean(native && value && value === english && native !== english
  && /\p{Script=Han}/u.test(native) && componentLooksLocalized(native, 'zh-CN'));

// Every writer stores the Chinese address string together with the Chinese components it was built from, so a
// string that differs from its components is left over from older formatting or a partial translation. It is
// rebuilt once per country; progress is kept per country, so a finished country is never scanned again. A Chinese
// street that misreads its English type (果园关闭, 卡森博士) takes the address type first, as new translations do; one
// still unusable falls back to the source street, which ordinary addresses publish with until translation recovery.
export const repairChineseAddressStrings = async ({ database, countryCode, pageSize = 2_000, now = () => new Date(), signal }) => {
  const country = String(countryCode || '').toUpperCase();
  const key = `${countryRevisions[country] || CHINESE_ADDRESS_FORMAT_REVISION}:${country}`;
  const progress = await database.prepare('SELECT value_json FROM translation_backfill_progress WHERE key=?').bind(key).first('value_json');
  const state = progress ? JSON.parse(progress) : { cursor: '', done: false };
  const summary = { countryCode: country, scanned: 0, repaired: 0, stale: 0, streetTypes: 0 };
  const unspaced = (value) => String(value || '').replace(/\s+/gu, '');
  if (state.done) return summary;
  for (;;) {
    signal?.throwIfAborted();
    const rows = (await database.prepare(`SELECT id,component_variants_json,address_variants_json FROM address_pool
      WHERE country_code=? AND active=1 AND id>? ORDER BY id LIMIT ?`).bind(country, state.cursor, pageSize).all()).results;
    const changed = [];
    for (const row of rows) {
      const variants = JSON.parse(row.component_variants_json || '{}');
      const components = variants['zh-CN'];
      const addresses = JSON.parse(row.address_variants_json || '{}');
      if (!components || addresses['zh-CN'] === undefined) continue;
      const restored = Object.fromEntries(semanticAddressFields
        .filter((field) => hanSourceField(variants.native?.[field], variants.en?.[field], components[field]))
        .map((field) => [field, variants.native[field]]));
      const source = variants.native?.street;
      const normalized = components.street && normalizeChineseStreetType(source, restored.street || components.street);
      const street = normalized && source && implausibleChineseTranslation(source, normalized, 'street') ? source : normalized;
      const updated = { ...components, ...restored, ...(street ? { street } : {}) };
      const localized = JSON.stringify(updated) === JSON.stringify(components) ? components : updated;
      const rebuilt = localizedFormattedAddress(localized, country, 'zh-CN');
      if (!rebuilt || rebuilt === addresses['zh-CN'] && localized === components) continue;
      changed.push([row.id, JSON.stringify(localized === components ? variants : { ...variants, 'zh-CN': localized }),
        JSON.stringify({ ...addresses, 'zh-CN': rebuilt })]);
      if (localized !== components) summary.streetTypes += 1;
      else if (unspaced(rebuilt) !== unspaced(addresses['zh-CN'])) summary.stale += 1;
    }
    if (changed.length) {
      await database.prepare(`UPDATE address_pool SET component_variants_json=CASE id ${changed.map(() => 'WHEN ? THEN ?').join(' ')} END,
        address_variants_json=CASE id ${changed.map(() => 'WHEN ? THEN ?').join(' ')} END
        WHERE id IN (${changed.map(() => '?').join(',')})`)
        .bind(...changed.flatMap(([id, components]) => [id, components]), ...changed.flatMap(([id, , address]) => [id, address]),
          ...changed.map(([id]) => id)).run();
    }
    summary.scanned += rows.length;
    summary.repaired += changed.length;
    state.cursor = rows.at(-1)?.id || state.cursor;
    state.done = rows.length < pageSize;
    await database.prepare(`INSERT INTO translation_backfill_progress(key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .bind(key, JSON.stringify(state), now().toISOString()).run();
    if (state.done) return summary;
  }
};
