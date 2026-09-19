import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { initializePostgres, PostgresDatabase, postgresPoolOptions } from '../server/database/postgres.mjs';

describe('PostgreSQL database adapter', () => {
  it('skips repeated schema DDL when both schemas are current', async () => {
    const query = vi.fn(async () => ({
      rows: [{ address_version: 30, control_version: 24 }], fields: [], rowCount: 1
    }));
    const release = vi.fn();
    await initializePostgres({ connect: async () => ({ query, release }) });
    expect(query).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('migrates a database that only has the previous control schema version', async () => {
    const query = vi.fn(async () => ({
      rows: [{ address_version: 20, control_version: 18 }], fields: [], rowCount: 1
    }));
    const release = vi.fn();
    await initializePostgres({ connect: async () => ({ query, release }) });
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements).toContain("SET LOCAL statement_timeout TO '30min'");
    expect(statements).toContain("SET LOCAL lock_timeout TO '5min'");
    expect(statements).toContain('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('adds the OpenAI-compatible provider to control constraints from version 22', async () => {
    const query = vi.fn(async () => ({
      rows: [{ address_version: 30, control_version: 22 }], fields: [], rowCount: 1
    }));
    await initializePostgres({ connect: async () => ({ query, release: vi.fn() }) });
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("'openai-compatible'"))).toBe(true);
    expect(statements.some((sql) => sql.includes('VALUES (23,CURRENT_TIMESTAMP::text)'))).toBe(true);
  });

  it('migrates a database that only has the previous address schema version', async () => {
    const query = vi.fn(async () => ({
      rows: [{ address_version: 19, control_version: 19 }], fields: [], rowCount: 1
    }));
    const release = vi.fn();
    await initializePostgres({ connect: async () => ({ query, release }) });
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes('idx_generation_country_residential_rank'))).toBe(true);
    expect(statements).toContain('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('applies checkpoint page signatures to a deployed version 21 database', async () => {
    const query = vi.fn(async () => ({
      rows: [{ address_version: 21, control_version: 19 }], fields: [], rowCount: 1
    }));
    await initializePostgres({ connect: async () => ({ query, release: vi.fn() }) });
    expect(query.mock.calls.some(([sql]) => String(sql).includes(
      'ALTER TABLE cn_sync_checkpoints ADD COLUMN IF NOT EXISTS page_signature TEXT'
    ))).toBe(true);
    expect(query.mock.calls.map(([sql]) => sql)).toContain('COMMIT');
  });

  it('uses a configurable high but finite pool ceiling', () => {
    expect(postgresPoolOptions({}).max).toBe(16);
    expect(postgresPoolOptions({ POSTGRES_POOL_MAX: '512' }).max).toBe(512);
    expect(postgresPoolOptions({ POSTGRES_POOL_MAX: '9999' }).max).toBe(16);
  });

  it('bounds parallel query shared memory while keeping an explicit override', () => {
    expect(postgresPoolOptions({}).options).toBe(
      '-c search_path=address,control,public -c max_parallel_workers_per_gather=0'
    );
    expect(postgresPoolOptions({
      POSTGRES_OPTIONS: '-c search_path=address',
      POSTGRES_MAX_PARALLEL_WORKERS_PER_GATHER: '2'
    }).options).toBe('-c search_path=address -c max_parallel_workers_per_gather=2');
  });

  it('upgrades coverage identity from version 26 without rebuilding the address pool or reopening sources', async () => {
    const query = vi.fn(async (sql) => ({ rows: String(sql).includes('idx_address_pool_canonical_key')
      ? [{ valid: true, ready: true, live: true, expected_definition: true }]
      : [{ address_version: 26, control_version: 21 }] }));
    await initializePostgres({ connect: async () => ({ query, release: vi.fn() }) });
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain('LOCK TABLE residential_coverage IN ACCESS EXCLUSIVE MODE NOWAIT');
    expect(statements).toContain("SET LOCAL statement_timeout TO '2s'");
    expect(statements.some((sql) => sql.includes('PRIMARY KEY (country_code,region_name,city_name,identity_key)'))).toBe(true);
    expect(statements.some((sql) => sql.includes('VALUES (27,CURRENT_TIMESTAMP::text)'))).toBe(true);
    expect(statements.some((sql) => /UPDATE address_pool SET match_level|DROP VIEW|UPDATE sync_source|UPDATE cn_sync/u.test(sql))).toBe(false);
  });

  it('stops a contended coverage migration after three short attempts without marking it applied', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback) => {
      queueMicrotask(callback);
      return 0;
    });
    try {
      const query = vi.fn(async (sql) => {
        if (sql.startsWith('LOCK TABLE residential_coverage')) throw Object.assign(new Error('Fixture lock busy'), { code: '55P03' });
        return { rows: [{ address_version: 26, control_version: 21 }] };
      });
      await expect(initializePostgres({ connect: async () => ({ query, release: vi.fn() }) }))
        .rejects.toThrow('Fixture lock busy');
      expect(timer.mock.calls.map(([, delay]) => delay)).toEqual([1000, 2000]);
      expect(query.mock.calls.filter(([sql]) => sql.startsWith('LOCK TABLE residential_coverage'))).toHaveLength(3);
      expect(query.mock.calls.some(([sql]) => sql.includes('VALUES (27,CURRENT_TIMESTAMP::text)'))).toBe(false);
    } finally { timer.mockRestore(); }
  });

  it('upgrades version 23 with short DDL locks and backfills after releasing them', async () => {
    const query = vi.fn(async () => ({ rows: [{
      address_version: 23, control_version: 19, acquired: true,
      statement_timeout: '30s', lock_timeout: '0',
      valid: true, ready: true, live: true, expected_definition: true
    }], fields: [], rowCount: 1 }));
    await initializePostgres({ connect: async () => ({ query, release: vi.fn() }) });
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain("SET LOCAL lock_timeout TO '250ms'");
    expect(statements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS address_pool ('))).toBe(false);
    const firstCommit = statements.indexOf('COMMIT');
    const backfill = statements.findIndex((sql) => sql.includes("UPDATE address_pool SET match_level='subpremise'"));
    expect(firstCommit).toBeGreaterThan(-1);
    expect(backfill).toBeGreaterThan(firstCommit);
    expect(statements.some((sql) => sql.includes('VALIDATE CONSTRAINT address_pool_match_level_check'))).toBe(true);
    expect(statements.filter((sql) => sql === 'COMMIT').length).toBeGreaterThanOrEqual(9);
    expect(statements.findIndex((sql) => sql.includes('pg_try_advisory_lock')))
      .toBeGreaterThan(statements.indexOf('COMMIT', firstCommit + 1));
    expect(statements.some((sql) => sql.includes('VALUES (25,CURRENT_TIMESTAMP::text)'))).toBe(true);
  });

  it('upgrades version 24 with a concurrent index before additive recovery tables', async () => {
    let built = false;
    const query = vi.fn(async (sql) => {
      if (sql.includes('FROM pg_class index_relation')) return { rows: built ? [{
        valid: true, ready: true, live: true, expected_definition: true
      }] : [] };
      if (sql.startsWith('CREATE INDEX CONCURRENTLY')) built = true;
      return { rows: [{ address_version: 24, control_version: 19, acquired: true,
        statement_timeout: '30s', lock_timeout: '0' }] };
    });
    const release = vi.fn();
    await initializePostgres({ connect: async () => ({ query, release }) });
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(built).toBe(true);
    expect(statements.indexOf('BEGIN')).toBeGreaterThan(statements.findIndex((sql) => sql.startsWith('CREATE INDEX CONCURRENTLY')));
    expect(statements.some((sql) => /UPDATE address_pool SET match_level|DROP VIEW/u.test(sql))).toBe(false);
    expect(statements.some((sql) => sql.includes('VALUES (25,CURRENT_TIMESTAMP::text)'))).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it('ships native PostgreSQL schemas', async () => {
    for (const file of ['server/database/schema.sql', 'server/control/schema.sql']) {
      const schema = await readFile(file, 'utf8');
      expect(schema).not.toMatch(/PRAGMA|CREATE VIRTUAL|AUTOINCREMENT|COLLATE NOCASE|json_valid|INSERT OR IGNORE/iu);
      expect(schema).toContain('ON CONFLICT');
      expect(schema).toContain('CREATE TABLE IF NOT EXISTS');
    }
    const addressSchema = await readFile('server/database/schema.sql', 'utf8');
    expect(addressSchema).toContain("native_name='Fryslân'");
    expect(addressSchema).toContain("generate_series(1, 30)");
    expect(addressSchema).toContain('idx_address_pool_active_country_id ON address_pool(country_code, id) WHERE active=1');
    expect(addressSchema).toContain("match_level TEXT NOT NULL DEFAULT 'premise'");
    expect(addressSchema).toContain('DROP CONSTRAINT IF EXISTS address_pool_house_number_check');
    expect(addressSchema).toContain('idx_cn_communities_city_random');
    const controlSchema = await readFile('server/control/schema.sql', 'utf8');
    expect(controlSchema).toContain("WHERE provider='mappls' AND status='needs_review'");
    expect(controlSchema).toContain("generate_series(1, 24)");
  });

  it('does not mark version 25 applied when the cursor index cannot be verified', async () => {
    const query = vi.fn(async (sql) => ({ rows: [sql.includes('FROM pg_class index_relation')
      ? { expected_definition: false, valid: true }
      : { address_version: 24, control_version: 19, acquired: true, statement_timeout: '30s', lock_timeout: '0' }] }));
    const release = vi.fn();
    await expect(initializePostgres({ connect: async () => ({ query, release }) }))
      .rejects.toThrow('Unexpected definition');
    expect(query.mock.calls.some(([sql]) => sql.includes('VALUES (25,CURRENT_TIMESTAMP::text)'))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it('rewrites parameters without changing quoted question marks', async () => {
    const query = vi.fn(async () => ({ rows: [{ marker: '?' }], fields: [{ name: 'marker' }], rowCount: 1 }));
    const database = new PostgresDatabase({ query });
    await database.prepare("SELECT marker FROM item WHERE id=? AND marker='?'").bind('row-1').all();
    expect(query).toHaveBeenCalledWith("SELECT marker FROM item WHERE id=$1 AND marker='?'", ['row-1']);
  });

  it('uses explicit PostgreSQL conflict handling', async () => {
    const query = vi.fn(async () => ({ rows: [], fields: [], rowCount: 0 }));
    const database = new PostgresDatabase({ query });
    await database.prepare('INSERT INTO item(id) VALUES (?) ON CONFLICT (id) DO NOTHING').bind('row-1').run();
    expect(query).toHaveBeenCalledWith('INSERT INTO item(id) VALUES ($1) ON CONFLICT (id) DO NOTHING', ['row-1']);
  });

  it('isolates a transaction connection from unrelated asynchronous reads', async () => {
    const poolQuery = vi.fn(async () => ({ rows: [], fields: [], rowCount: 0 }));
    const clientQuery = vi.fn(async () => ({ rows: [], fields: [], rowCount: 0 }));
    const client = { query: clientQuery, release: vi.fn() };
    const database = new PostgresDatabase({ query: poolQuery, connect: async () => client });
    let releaseOutside;
    const outside = new Promise((resolve) => { releaseOutside = resolve; })
      .then(() => database.prepare('SELECT 2').all());

    await database.transaction(async () => {
      await database.prepare('SELECT 1').all();
      releaseOutside();
      await outside;
    });

    expect(clientQuery).toHaveBeenCalledWith('BEGIN');
    expect(clientQuery).toHaveBeenCalledWith('SELECT 1', []);
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
    expect(poolQuery).toHaveBeenCalledWith('SELECT 2', []);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rolls back active transactions and prevents work from falling back to the pool during close', async () => {
    const poolQuery = vi.fn(async () => ({ rows: [], fields: [], rowCount: 0 }));
    const clientQuery = vi.fn(async () => ({ rows: [], fields: [], rowCount: 0 }));
    const end = vi.fn(async () => undefined);
    const client = { query: clientQuery, release: vi.fn() };
    const database = new PostgresDatabase({ query: poolQuery, connect: async () => client, end }, { ownsPool: true });
    let releaseWork;
    const work = new Promise((resolve) => { releaseWork = resolve; });
    const transaction = database.transaction(async () => {
      await database.prepare('SELECT 1').all();
      await work;
      await database.prepare('SELECT 2').all();
    });
    await vi.waitFor(() => expect(clientQuery).toHaveBeenCalledWith('SELECT 1', []));
    await database.close();
    releaseWork();
    await expect(transaction).rejects.toMatchObject({ code: 'DATABASE_CLOSED' });
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(clientQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledWith(true);
    expect(end).toHaveBeenCalledOnce();
    expect(poolQuery).not.toHaveBeenCalled();
  });
});
