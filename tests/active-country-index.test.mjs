import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { ensureActiveCountryCursorIndex } from '../server/database/active-country-index.mjs';

const validIndex = { expected_definition: true, valid: true, ready: true, live: true, building: false };
const fixture = ({ index, acquired = true, failures = [] } = {}) => {
  const query = vi.fn(async (sql) => {
    if (sql.includes('current_setting')) return { rows: [{ statement_timeout: '30s', lock_timeout: '0' }] };
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired }] };
    if (sql.includes('FROM pg_class index_relation')) return { rows: index ? [index] : [] };
    if (sql.startsWith('DROP INDEX')) index = undefined;
    if (sql.startsWith('CREATE INDEX')) {
      const failure = failures.shift();
      index = { ...validIndex, valid: !failure };
      if (failure) throw Object.assign(new Error('Index build failed'), { code: failure });
    }
    return { rows: [] };
  });
  return { query };
};

describe('active country cursor index migration', () => {
  it('builds the complete active-row cursor index concurrently outside transactions', async () => {
    const client = fixture();
    await ensureActiveCountryCursorIndex(client);
    const statements = client.query.mock.calls.map(([sql]) => sql);
    expect(statements).toContain('CREATE INDEX CONCURRENTLY idx_address_pool_active_country_id ON address.address_pool (country_code, id) WHERE active=1');
    expect(statements).not.toContain('BEGIN');
    expect(statements.some((sql) => sql.includes('CREATE INDEX CONCURRENTLY IF NOT EXISTS'))).toBe(false);
    expect(statements).toContain("SET statement_timeout TO '10min'");
    expect(statements.at(-1)).toContain('pg_advisory_unlock');
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('set_config'), ['30s', '0']);
  });

  it('skips an already valid index without address validation or data changes', async () => {
    const client = fixture({ index: validIndex });
    await ensureActiveCountryCursorIndex(client);
    expect(client.query.mock.calls.some(([sql]) => /^(CREATE|DROP|UPDATE|INSERT|DELETE|BEGIN)/u.test(sql))).toBe(false);
  });

  it.each(['valid', 'ready', 'live'])('recovers an index with %s unset and the exact expected definition', async (flag) => {
    const client = fixture({ index: { ...validIndex, [flag]: false } });
    await ensureActiveCountryCursorIndex(client);
    const statements = client.query.mock.calls.map(([sql]) => sql);
    expect(statements.indexOf('DROP INDEX CONCURRENTLY address.idx_address_pool_active_country_id'))
      .toBeLessThan(statements.findIndex((sql) => sql.startsWith('CREATE INDEX')));
  });

  it.each([
    { ...validIndex, expected_definition: false },
    { ...validIndex, expected_definition: false, valid: false },
    { ...validIndex, building: true, valid: false }
  ])('does not remove another definition or an in-progress build: %j', async (index) => {
    const client = fixture({ index });
    await expect(ensureActiveCountryCursorIndex(client)).rejects.toThrow();
    expect(client.query.mock.calls.some(([sql]) => /^(CREATE|DROP)/u.test(sql))).toBe(false);
  });

  it('does not race another migration session', async () => {
    const client = fixture({ acquired: false });
    await expect(ensureActiveCountryCursorIndex(client)).rejects.toThrow(/already running/u);
    expect(client.query.mock.calls.some(([sql]) => /^(CREATE|DROP)/u.test(sql))).toBe(false);
    expect(client.query.mock.calls.some(([sql]) => sql.includes('pg_advisory_unlock'))).toBe(false);
  });

  it('retries a timed-out build once after cleaning only its invalid index', async () => {
    const client = fixture({ failures: ['57014'] });
    await ensureActiveCountryCursorIndex(client);
    expect(client.query.mock.calls.filter(([sql]) => sql.startsWith('CREATE INDEX'))).toHaveLength(2);
    expect(client.query.mock.calls.filter(([sql]) => sql.startsWith('DROP INDEX'))).toHaveLength(1);
  });

  it('stops after two failures and cleans the final invalid index', async () => {
    const client = fixture({ failures: ['57014', '57014', '57014'] });
    await expect(ensureActiveCountryCursorIndex(client)).rejects.toThrow('Index build failed');
    expect(client.query.mock.calls.filter(([sql]) => sql.startsWith('CREATE INDEX'))).toHaveLength(2);
    expect(client.query.mock.calls.filter(([sql]) => sql.startsWith('DROP INDEX'))).toHaveLength(2);
    expect(client.query.mock.calls.at(-1)[0]).toContain('pg_advisory_unlock');
  });

  it('does not retry nontransient failures', async () => {
    const client = fixture({ failures: ['42501'] });
    await expect(ensureActiveCountryCursorIndex(client)).rejects.toThrow('Index build failed');
    expect(client.query.mock.calls.filter(([sql]) => sql.startsWith('CREATE INDEX'))).toHaveLength(1);
  });

  it('does not hide a failed cleanup or mark the migration successful', async () => {
    const client = fixture({ index: { ...validIndex, valid: false } });
    const query = client.query.getMockImplementation();
    client.query.mockImplementation(async (sql, ...args) => {
      if (sql.startsWith('DROP INDEX')) throw Object.assign(new Error('Cleanup timed out'), { code: '57014' });
      return query(sql, ...args);
    });
    await expect(ensureActiveCountryCursorIndex(client)).rejects.toThrow('Cleanup timed out');
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith('CREATE INDEX'))).toBe(false);
    expect(client.query.mock.calls.at(-1)[0]).toContain('pg_advisory_unlock');
  });

  it('ships an index-only immutable image and runner without publication or queue work', async () => {
    const dockerfile = await readFile('ops/Dockerfile.cursor-index', 'utf8');
    const runner = await readFile('server/database/migrate-active-country-index.mjs', 'utf8');
    expect(dockerfile).toContain('FROM ${BASE_IMAGE}');
    expect(dockerfile).toContain('COPY --chown=address:address');
    expect(dockerfile).not.toContain('VOLUME');
    expect(runner).toContain('ensureActiveCountryCursorIndex(client)');
    expect(runner).toContain('address_version');
    expect(runner).not.toMatch(/initializePostgres|reconcilePublishedPool|openRuntimeDatabases/u);
  });
});
