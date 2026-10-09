import { describe, expect, it, vi } from 'vitest';
import { ensureEvidenceDatasetIndex } from '../server/database/evidence-dataset-index.mjs';

const client = (state) => {
  const statements = [];
  return {
    statements,
    query: vi.fn(async (sql) => {
      statements.push(sql);
      if (sql.includes("relname='idx_address_pool_evidence_dataset'")) return { rows: state.index ? [state.index] : [] };
      if (sql.startsWith('CREATE INDEX CONCURRENTLY')) state.index = { valid: true, ready: true };
      if (sql.startsWith('SELECT current_setting')) return { rows: [{ statement_timeout: '30s', lock_timeout: '2s' }] };
      return { rows: [] };
    })
  };
};

describe('evidence dataset index', () => {
  it('builds the index concurrently and restores session timeouts', async () => {
    const connection = client({});
    await ensureEvidenceDatasetIndex(connection);
    expect(connection.statements).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_address_pool_evidence_dataset ON address.address_pool_evidence (dataset_id, evidence_type)');
    expect(connection.statements.at(-1)).toContain("set_config('statement_timeout'");
  });

  it('drops an invalid index left by an interrupted build before rebuilding, and skips a valid one', async () => {
    const invalid = client({ index: { valid: false, ready: false } });
    await ensureEvidenceDatasetIndex(invalid);
    expect(invalid.statements.findIndex((sql) => sql.startsWith('DROP INDEX CONCURRENTLY')))
      .toBeLessThan(invalid.statements.findIndex((sql) => sql.startsWith('CREATE INDEX CONCURRENTLY')));
    const valid = client({ index: { valid: true, ready: true } });
    await ensureEvidenceDatasetIndex(valid);
    expect(valid.statements).toHaveLength(1);
  });
});
