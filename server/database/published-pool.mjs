import { storedAddressPoolV2RowIsPublishable } from '../api/repositories/address-pool-v2';
import { countries } from '../../src/domain/countries';
import { refreshResidentialCoverage } from './residential-coverage.mjs';
import { addressPublicationSqlClause, refreshAddressGenerationIndex } from './generation-index.mjs';

const PUBLICATION_VALIDATION_REVISION = 'address-reader-v4-index-consistency';

const requestedCountries = (countryCodes) => [...new Set((countryCodes || [])
  .map((value) => String(value || '').toUpperCase()).filter((value) => /^[A-Z]{2}$/u.test(value)))];

const inactiveCountries = async (database) => (await database.prepare(`SELECT DISTINCT dataset.country_code
  FROM address_pool address
  JOIN address_pool_evidence evidence ON evidence.address_id=address.id
    AND evidence.is_current=1 AND evidence.evidence_type='address_existence'
  JOIN address_datasets dataset ON dataset.id=evidence.dataset_id AND dataset.status='active'
  JOIN address_sources source ON source.id=dataset.source_id
  WHERE address.active=0 AND (address.retired_at IS NULL OR address.retired_at NOT LIKE 'publication-validation:%')
    AND dataset.redistribution_allowed=1 AND source.redistribution_allowed=1
  ORDER BY dataset.country_code`).all()).results.map((row) => String(row.country_code));

const retireInvalidRows = async (database, rows, checkedAt) => {
  const invalidIds = rows.filter((row) => !storedAddressPoolV2RowIsPublishable(row, new Date(checkedAt)))
    .map((row) => row.id);
  for (let offset = 0; offset < invalidIds.length; offset += 500) {
    const batch = invalidIds.slice(offset, offset + 500);
    await database.prepare(`UPDATE address_pool SET active=0,retired_at=?
      WHERE id IN (${batch.map(() => '?').join(',')})`)
      .bind(`publication-validation:${PUBLICATION_VALIDATION_REVISION}:${checkedAt}`, ...batch).run();
  }
  return invalidIds.length;
};

const retireInvalidCountryRows = async (database, countryCode, checkedAt, limit = 2000) => {
  let lastId = '';
  let retired = 0;
  while (true) {
    const rows = (await database.prepare(`SELECT * FROM address_pool_runtime
      WHERE country_code=? AND id>? ORDER BY id LIMIT ?`).bind(countryCode, lastId, limit).all()).results;
    if (!rows.length) return retired;
    retired += await retireInvalidRows(database, rows, checkedAt);
    lastId = rows.at(-1).id;
  }
};

export const refreshCountryCounts = async (database, countryCode, checkedAt, { useGenerationIndex = false } = {}) => {
  const counts = await database.prepare(useGenerationIndex ? `SELECT COUNT(*) AS address_count,
    SUM(residential_ready) AS residential_count FROM address_generation_index WHERE country_code=? AND active=1`
    : `SELECT COUNT(*) AS address_count,
    SUM(CASE WHEN property_type IN ('residential','apartment') AND residential_evidence=1
      THEN 1 ELSE 0 END) AS residential_count
    FROM address_pool_runtime WHERE country_code=? AND ${addressPublicationSqlClause()}`)
    .bind(countryCode).first();
  const total = Number(counts?.address_count || 0);
  const residential = Number(counts?.residential_count || 0);
  const statements = [database.prepare(`INSERT INTO sync_country_state(country_code,address_count,residential_count,updated_at)
    VALUES (?,?,?,?) ON CONFLICT(country_code) DO UPDATE SET address_count=excluded.address_count,
      residential_count=excluded.residential_count,updated_at=excluded.updated_at`).bind(
    countryCode, total, residential, checkedAt
  )];
  if (countryCode !== 'CN') statements.push(database.prepare(`INSERT INTO admin_coverage_stats(
    node_key,parent_key,country_code,level,region_code,region_name,total_count,residential_count,ordinary_count,updated_at
  ) VALUES (?,'',?,0,?,?,?,?,?,?) ON CONFLICT(node_key) DO UPDATE SET
    total_count=excluded.total_count,residential_count=excluded.residential_count,
    ordinary_count=excluded.ordinary_count,updated_at=excluded.updated_at`).bind(
    countryCode, countryCode, countryCode, countries.find((country) => country.code === countryCode)?.name['zh-CN'] || countryCode,
    total, residential, total - residential, checkedAt
  ));
  await database.batch(statements);
};

export const reconcilePublishedPoolProjections = async (database, checkedAt = new Date().toISOString()) => {
  const rows = (await database.prepare(`WITH published AS (
      SELECT country_code,COUNT(DISTINCT id) AS total,
        COUNT(DISTINCT id) FILTER (WHERE property_type IN ('residential','apartment') AND residential_evidence=1) AS residential
      FROM address_pool_runtime WHERE country_code<>'CN' AND ${addressPublicationSqlClause()} GROUP BY country_code
    ), indexed AS (
      SELECT country_code,COUNT(*) AS total,SUM(residential_ready) AS residential
      FROM address_generation_index WHERE active=1 GROUP BY country_code
    ) SELECT policy.country_code FROM sync_country_policies policy
      LEFT JOIN published ON published.country_code=policy.country_code
      LEFT JOIN indexed ON indexed.country_code=policy.country_code
      LEFT JOIN admin_coverage_stats coverage ON coverage.node_key=policy.country_code AND coverage.level=0
      LEFT JOIN sync_country_state state ON state.country_code=policy.country_code
    WHERE policy.country_code<>'CN' AND (
      COALESCE(published.total,0)<>COALESCE(indexed.total,0)
      OR COALESCE(published.residential,0)<>COALESCE(indexed.residential,0)
      OR COALESCE(published.total,0)<>COALESCE(coverage.total_count,0)
      OR COALESCE(published.residential,0)<>COALESCE(coverage.residential_count,0)
      OR COALESCE(published.total,0)<>COALESCE(state.address_count,0)
      OR COALESCE(published.residential,0)<>COALESCE(state.residential_count,0)
    ) ORDER BY policy.country_code`).all()).results;
  for (const { country_code: countryCode } of rows) {
    await refreshAddressGenerationIndex(database, countryCode);
    await refreshResidentialCoverage(database, countryCode, checkedAt);
    await refreshCountryCounts(database, countryCode, checkedAt);
  }
  return rows.map((row) => row.country_code);
};

export const reconcilePublishedPool = async (database, countryCodes, checkedAt = new Date().toISOString()) => {
  const countries = requestedCountries(countryCodes);
  const validateActiveRows = countries.length > 0;
  if (!countries.length) countries.push(...await inactiveCountries(database));
  const results = [];
  for (const countryCode of countries) {
    const before = Number(await database.prepare(`SELECT COUNT(*) AS total FROM address_pool
      WHERE country_code=? AND active=1`).bind(countryCode).first('total') || 0);
    const result = await database.transaction(async (transaction) => {
      let activated = 0;
      let retired = 0;
      const activation = await transaction.prepare(`UPDATE address_pool SET active=1,retired_at=NULL
        WHERE country_code=? AND active=0
          AND (retired_at IS NULL OR retired_at NOT LIKE 'publication-validation:%') AND id IN (
          SELECT evidence.address_id FROM address_pool_evidence evidence
          JOIN address_datasets dataset ON dataset.id=evidence.dataset_id
          JOIN address_sources source ON source.id=dataset.source_id
          WHERE evidence.is_current=1 AND evidence.evidence_type='address_existence'
            AND dataset.status='active' AND dataset.country_code=?
            AND dataset.redistribution_allowed=1 AND source.redistribution_allowed=1
        ) RETURNING id`).bind(countryCode, countryCode).all();
      const activatedIds = activation.results.map((row) => row.id);
      activated = activatedIds.length;
      if (validateActiveRows) {
        retired = await retireInvalidCountryRows(transaction, countryCode, checkedAt);
      } else {
        for (let offset = 0; offset < activatedIds.length; offset += 500) {
          const batch = activatedIds.slice(offset, offset + 500);
          const rows = (await transaction.prepare(`SELECT * FROM address_pool_runtime
            WHERE id IN (${batch.map(() => '?').join(',')})`).bind(...batch).all()).results;
          retired += await retireInvalidRows(transaction, rows, checkedAt);
        }
      }
      const datasets = (await transaction.prepare(`SELECT id FROM address_datasets
        WHERE country_code=? AND status='active'`).bind(countryCode).all()).results;
      for (const dataset of datasets) {
        const activeCount = Number(await transaction.prepare(`SELECT COUNT(DISTINCT evidence.address_id) AS total
          FROM address_pool_evidence evidence JOIN address_pool address ON address.id=evidence.address_id
          JOIN address_datasets dataset ON dataset.id=evidence.dataset_id
          JOIN address_sources source ON source.id=dataset.source_id
          WHERE evidence.dataset_id=? AND evidence.is_current=1 AND address.active=1
            AND dataset.redistribution_allowed=1 AND source.redistribution_allowed=1`)
          .bind(dataset.id).first('total') || 0);
        await transaction.prepare('UPDATE address_datasets SET active_count=? WHERE id=?')
          .bind(activeCount, dataset.id).run();
      }
      await refreshAddressGenerationIndex(transaction, countryCode);
      await refreshCountryCounts(transaction, countryCode, checkedAt);
      return { activated, retired };
    });
    const { activated, retired } = result;
    const after = Number(await database.prepare(`SELECT COUNT(*) AS total FROM address_pool
      WHERE country_code=? AND active=1`).bind(countryCode).first('total') || 0);
    results.push({ countryCode, before, after, activated, retired });
  }
  return results;
};

export const validatePublishedPoolBatch = async (
  database,
  { checkedAt = new Date().toISOString(), limit = 2000 } = {}
) => {
  let state = await database.prepare(`SELECT revision,country_code,last_id,completed_at
    FROM publication_validation_state WHERE id=1`).first();
  if (!state || state.revision !== PUBLICATION_VALIDATION_REVISION) {
    state = { revision: PUBLICATION_VALIDATION_REVISION, country_code: '', last_id: '', completed_at: null };
    await database.prepare(`INSERT INTO publication_validation_state(
      id,revision,country_code,last_id,completed_at,updated_at
    ) VALUES (1,?,'','',NULL,?) ON CONFLICT(id) DO UPDATE SET
      revision=excluded.revision,country_code='',last_id='',completed_at=NULL,updated_at=excluded.updated_at`)
      .bind(PUBLICATION_VALIDATION_REVISION, checkedAt).run();
  }
  if (state.completed_at) return { completed: true, scanned: 0, retired: 0 };
  let countryCode = state.country_code;
  let lastId = state.last_id;
  if (!lastId) {
    countryCode = await database.prepare(`SELECT MIN(dataset.country_code) AS country_code
      FROM address_datasets dataset WHERE dataset.status='active' AND dataset.country_code>?`)
      .bind(countryCode).first('country_code');
    if (!countryCode) {
      await database.prepare(`UPDATE publication_validation_state SET completed_at=?,updated_at=? WHERE id=1`)
        .bind(checkedAt, checkedAt).run();
      return { completed: true, scanned: 0, retired: 0 };
    }
  }
  const rows = (await database.prepare(`SELECT * FROM address_pool_runtime
    WHERE country_code=? AND id>? ORDER BY id LIMIT ?`).bind(countryCode, lastId, limit).all()).results;
  if (!rows.length) {
    await refreshAddressGenerationIndex(database, countryCode);
    await refreshResidentialCoverage(database, countryCode, checkedAt);
    await refreshCountryCounts(database, countryCode, checkedAt);
    await database.prepare(`UPDATE publication_validation_state SET country_code=?,last_id='',updated_at=? WHERE id=1`)
      .bind(countryCode, checkedAt).run();
    return { completed: false, countryCode, countryCompleted: true, scanned: 0, retired: 0 };
  }
  const retired = await database.transaction(async (transaction) => {
    const retired = await retireInvalidRows(transaction, rows, checkedAt);
    await transaction.prepare(`UPDATE publication_validation_state SET country_code=?,last_id=?,updated_at=? WHERE id=1`)
      .bind(countryCode, rows.at(-1).id, checkedAt).run();
    return retired;
  });
  return { completed: false, countryCode, scanned: rows.length, retired };
};
