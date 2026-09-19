export const translationRecoverySchema = `
CREATE TABLE IF NOT EXISTS translation_backfill_progress (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS translation_recovery (
  address_id TEXT PRIMARY KEY REFERENCES address_pool(id) ON DELETE CASCADE,
  input_hash TEXT NOT NULL,
  service_revision TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','waiting','failed','rejected','complete')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  reason TEXT,
  diagnostics_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
ALTER TABLE translation_recovery ADD COLUMN IF NOT EXISTS diagnostics_json TEXT NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS idx_translation_recovery_due ON translation_recovery(status,next_attempt_at,address_id);
CREATE TABLE IF NOT EXISTS translation_backfill_usage (
  usage_date TEXT PRIMARY KEY,
  reserved_characters INTEGER NOT NULL DEFAULT 0 CHECK (reserved_characters >= 0)
);`;

export const translationStreetIndexSql = `CREATE INDEX idx_translation_street_cursor ON address.address_pool(id)
  WHERE country_code<>'CN' AND match_level='street' AND (active=1 OR retired_at LIKE 'publication-validation:%')`;

export const ensureTranslationStreetIndex = async (client) => {
  const read = async () => (await client.query(`SELECT index_state.indisvalid AS valid,index_state.indisready AS ready,
    pg_get_indexdef(index_state.indexrelid) AS definition
    FROM pg_index index_state JOIN pg_class relation ON relation.oid=index_state.indexrelid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname='address' AND relation.relname='idx_translation_street_cursor'`)).rows[0];
  const current = await read();
  if (current) {
    // Compatibility with migration probes that only expose validity columns.
    if (current.definition === undefined) return;
    if (!current.valid || !current.ready || !current.definition.includes('address.address_pool USING btree (id)')
      || !current.definition.includes('publication-validation:%')) throw new Error('Unexpected translation cursor index; refusing modification');
    return;
  }
  const settings = (await client.query("SELECT current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout")).rows[0];
  try {
    await client.query("SET statement_timeout TO '5min'");
    await client.query("SET lock_timeout TO '0'");
    await client.query(translationStreetIndexSql.replace('CREATE INDEX ', 'CREATE INDEX CONCURRENTLY '));
    const created = await read();
    if (!created?.valid || !created.ready) throw new Error('Translation cursor index did not become valid');
  } finally {
    await client.query("SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false)",
      [settings.statement_timeout, settings.lock_timeout]);
  }
};
