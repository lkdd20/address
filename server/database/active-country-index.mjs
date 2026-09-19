const indexName = 'address.idx_address_pool_active_country_id';
const readIndex = async (client) => {
  const { rows: [index] } = await client.query(`SELECT
      index_state.indisvalid AS valid, index_state.indisready AS ready, index_state.indislive AS live,
      index_relation.relkind='i' AND table_schema.nspname='address' AND table_relation.relname='address_pool'
        AND access_method.amname='btree' AND NOT index_state.indisunique AND NOT index_state.indisexclusion
        AND index_state.indnkeyatts=2 AND index_state.indnatts=2
        AND pg_get_indexdef(index_state.indexrelid,1,true)='country_code'
        AND pg_get_indexdef(index_state.indexrelid,2,true)='id'
        AND pg_get_expr(index_state.indpred,index_state.indrelid)='(active = 1)' AS expected_definition,
      EXISTS (SELECT 1 FROM pg_stat_progress_create_index progress
        WHERE progress.index_relid=index_relation.oid) AS building
    FROM pg_class index_relation
    JOIN pg_namespace index_schema ON index_schema.oid=index_relation.relnamespace
    LEFT JOIN pg_index index_state ON index_state.indexrelid=index_relation.oid
    LEFT JOIN pg_class table_relation ON table_relation.oid=index_state.indrelid
    LEFT JOIN pg_namespace table_schema ON table_schema.oid=table_relation.relnamespace
    LEFT JOIN pg_am access_method ON access_method.oid=index_relation.relam
    WHERE index_schema.nspname='address' AND index_relation.relname='idx_address_pool_active_country_id'`);
  if (index && !index.expected_definition) throw new Error(`Unexpected definition for ${indexName}; refusing modification`);
  if (index?.building) throw new Error(`Index ${indexName} is already being built`);
  return index;
};

const isValid = (index) => index?.valid && index.ready && index.live;
const cleanInvalidIndex = async (client) => {
  const index = await readIndex(client);
  if (index && !isValid(index)) {
    await client.query("SET statement_timeout TO '30s'");
    await client.query(`DROP INDEX CONCURRENTLY ${indexName}`);
  }
};

export const ensureActiveCountryCursorIndex = async (client) => {
  const { rows: [settings] } = await client.query(`SELECT current_setting('statement_timeout') AS statement_timeout,
    current_setting('lock_timeout') AS lock_timeout`);
  const { rows: [lock] } = await client.query('SELECT pg_try_advisory_lock(724381,25) AS acquired');
  if (!lock.acquired) throw new Error('Active country cursor index migration is already running');
  try {
    await client.query("SET lock_timeout TO '0'");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (isValid(await readIndex(client))) return;
      await cleanInvalidIndex(client);
      try {
        await client.query("SET statement_timeout TO '10min'");
        await client.query('CREATE INDEX CONCURRENTLY idx_address_pool_active_country_id ON address.address_pool (country_code, id) WHERE active=1');
        if (!isValid(await readIndex(client))) throw new Error(`Index ${indexName} did not become valid`);
        return;
      } catch (error) {
        await cleanInvalidIndex(client);
        if (!['55P03', '57014', '40P01'].includes(error?.code) || attempt === 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }
  } finally {
    try {
      await client.query("SELECT set_config('statement_timeout',$1,false),set_config('lock_timeout',$2,false)",
        [settings.statement_timeout, settings.lock_timeout]);
    } finally {
      await client.query('SELECT pg_advisory_unlock(724381,25)');
    }
  }
};
