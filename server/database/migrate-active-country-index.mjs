import { readFile } from 'node:fs/promises';
import { createPostgresPool } from './postgres.mjs';
import { ensureActiveCountryCursorIndex } from './active-country-index.mjs';

const timeout = setTimeout(() => {
  console.error('Active country cursor index migration exceeded its 22-minute deadline');
  process.exit(1);
}, 22 * 60_000);
timeout.unref();

const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
const pool = createPostgresPool({
  ...(connectionString ? { connectionString } : {
    host: process.env.POSTGRES_HOST,
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD_FILE
      ? (await readFile(process.env.POSTGRES_PASSWORD_FILE, 'utf8')).trim() : process.env.POSTGRES_PASSWORD
  }),
  max: 1,
  application_name: 'address-active-country-index-v25'
});
try {
  const client = await pool.connect();
  try {
    const { rows: [version] } = await client.query('SELECT MAX(version) AS address_version FROM address.schema_migrations');
    if (Number(version.address_version) < 24) throw new Error('Address schema version 24 or newer is required');
    console.log(JSON.stringify({ event: 'cursor_index_started', at: new Date().toISOString() }));
    await ensureActiveCountryCursorIndex(client);
    await client.query(`INSERT INTO address.schema_migrations(version,applied_at) VALUES (25,CURRENT_TIMESTAMP::text)
      ON CONFLICT (version) DO NOTHING`);
    console.log(JSON.stringify({ event: 'cursor_index_ready', at: new Date().toISOString() }));
  } finally {
    client.release(true);
  }
} finally {
  await pool.end();
  clearTimeout(timeout);
}
