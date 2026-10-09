// Import finalization looks up evidence by dataset; without this index each lookup scans the whole evidence table and
// large imports exceed the statement timeout. It is built concurrently at sync startup, not during deploy migration,
// because a concurrent build waits for running import transactions.
export const evidenceDatasetIndexSql = 'CREATE INDEX IF NOT EXISTS idx_address_pool_evidence_dataset ON address.address_pool_evidence (dataset_id, evidence_type)';

export const ensureEvidenceDatasetIndex = async (client) => {
  const read = async () => (await client.query(`SELECT index_state.indisvalid AS valid,index_state.indisready AS ready
    FROM pg_index index_state JOIN pg_class relation ON relation.oid=index_state.indexrelid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname='address' AND relation.relname='idx_address_pool_evidence_dataset'`)).rows[0];
  const current = await read();
  if (current?.valid && current.ready) return;
  const settings = (await client.query("SELECT current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout")).rows[0];
  try {
    await client.query("SET statement_timeout TO '60min'");
    await client.query("SET lock_timeout TO '0'");
    // An interrupted concurrent build leaves an invalid index that must be dropped before building again.
    if (current) await client.query('DROP INDEX CONCURRENTLY IF EXISTS address.idx_address_pool_evidence_dataset');
    await client.query(evidenceDatasetIndexSql.replace('CREATE INDEX ', 'CREATE INDEX CONCURRENTLY '));
    const created = await read();
    if (!created?.valid || !created.ready) throw new Error('Evidence dataset index did not become valid');
  } finally {
    await client.query("SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false)",
      [settings.statement_timeout, settings.lock_timeout]);
  }
};
