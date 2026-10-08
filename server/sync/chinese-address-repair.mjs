import { localizedFormattedAddress } from './address-etl.mjs';

export const CHINESE_ADDRESS_FORMAT_REVISION = 'chinese-address-format-v3';

// Every writer stores the Chinese address string together with the Chinese components it was built from, so a
// string that differs from its components is left over from older formatting or a partial translation. It is
// rebuilt once per country; progress is kept per country, so a finished country is never scanned again.
export const repairChineseAddressStrings = async ({ database, countryCode, pageSize = 2_000, now = () => new Date(), signal }) => {
  const country = String(countryCode || '').toUpperCase();
  const key = `${CHINESE_ADDRESS_FORMAT_REVISION}:${country}`;
  const progress = await database.prepare('SELECT value_json FROM translation_backfill_progress WHERE key=?').bind(key).first('value_json');
  const state = progress ? JSON.parse(progress) : { cursor: '', done: false };
  const summary = { countryCode: country, scanned: 0, repaired: 0, stale: 0 };
  const unspaced = (value) => String(value || '').replace(/\s+/gu, '');
  if (state.done) return summary;
  for (;;) {
    signal?.throwIfAborted();
    const rows = (await database.prepare(`SELECT id,component_variants_json,address_variants_json FROM address_pool
      WHERE country_code=? AND active=1 AND id>? ORDER BY id LIMIT ?`).bind(country, state.cursor, pageSize).all()).results;
    const changed = [];
    for (const row of rows) {
      const components = JSON.parse(row.component_variants_json || '{}')['zh-CN'];
      const addresses = JSON.parse(row.address_variants_json || '{}');
      if (!components || addresses['zh-CN'] === undefined) continue;
      const rebuilt = localizedFormattedAddress(components, country, 'zh-CN');
      if (!rebuilt || rebuilt === addresses['zh-CN']) continue;
      changed.push([row.id, JSON.stringify({ ...addresses, 'zh-CN': rebuilt })]);
      if (unspaced(rebuilt) !== unspaced(addresses['zh-CN'])) summary.stale += 1;
    }
    if (changed.length) {
      await database.prepare(`UPDATE address_pool SET address_variants_json=CASE id ${changed.map(() => 'WHEN ? THEN ?').join(' ')} END
        WHERE id IN (${changed.map(() => '?').join(',')})`).bind(...changed.flat(), ...changed.map(([id]) => id)).run();
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
