import { randomUUID } from 'node:crypto';
import { addressQualitySqlClause } from '../../src/domain/address-quality.mjs';
import { foreignAddressScriptPattern, semanticAddressFields } from '../../src/domain/address-localization.mjs';
import { addressContracts } from '../../src/domain/address-contracts.mjs';
import { administrativeKeySql, administrativeValueSql, refreshAdministrativeAssignments } from './administrative-assignments.mjs';

const localizedHanClause = (prefix = '') => {
  const value = (language, field) => `${prefix}component_variants_json::jsonb -> '${language}' ->> '${field}'`;
  const country = `${prefix}country_code`;
  const anyHan = `(${semanticAddressFields.map((field) => `(${value('zh-CN', field)} ~ '[一-龥]')`).join(' OR ')})`;
  const requiredCountryPredicate = (field) => {
    const countries = Object.entries(addressContracts)
      .filter(([, contract]) => field === 'street' || contract.required.includes(field))
      .map(([code]) => `'${code}'`);
    return countries.length ? `${country} NOT IN (${countries.join(',')})` : 'TRUE';
  };
  const unchangedIdentifier = (field) => `${value('native', field)} ~ '^[A-Z]{1,6}[-./ ]{0,1}[0-9]+([-./ ]{0,1}[A-Z0-9]+)*$'`;
  const translated = semanticAddressFields.filter((field) => field !== 'buildingName').map((field) => {
    const original = value('native', field);
    return `(${requiredCountryPredicate(field)} OR trim(${original})='' OR ${value('zh-CN', field)} ~ '[一-龥]'
      OR NOT (${original} ~ '[^0-9[:punct:][:space:]]') OR ${unchangedIdentifier(field)})`;
  });
  return [anyHan, ...translated].join(' AND ');
};

export const addressLocalizationSqlClause = (prefix = '') => [
  localizedHanClause(prefix),
  ...['en', 'zh-CN'].map((language) => `NOT (concat_ws('',${semanticAddressFields
    .map((field) => `${prefix}component_variants_json::jsonb -> '${language}' ->> '${field}'`).join(',')})
      ~ '${foreignAddressScriptPattern(language)}')`)
].join(' AND ');

export const addressPublicationSqlClause = (prefix = '') => [
  `${prefix}quality_score >= 0.7`,
  addressQualitySqlClause(prefix),
  addressLocalizationSqlClause(prefix)
].join(' AND ');

export const generationIndexRowCount = async (database) => Number(
  await database.prepare('SELECT COUNT(*) AS total FROM address_generation_index WHERE active=1').first('total') || 0
);

export const refreshAddressGenerationIndex = async (database, countryCode, { addressIds } = {}) => {
  const scope = String(countryCode || '').trim().toUpperCase();
  if (!scope) return 0;
  const ids = addressIds === undefined ? null : [...new Set(addressIds.map(String))];
  if (ids && !ids.length) return generationIndexRowCountForCountry(database, scope);
  await refreshAdministrativeAssignments(database, scope, { addressIds: ids || undefined });
  const placeholders = ids?.map(() => '?').join(',');
  const updatedAt = new Date().toISOString();
  const source = 'address_pool_runtime runtime';
  const eligible = addressPublicationSqlClause('runtime.');
  await database.batch([
    database.prepare(`UPDATE address_generation_index SET active=0 WHERE country_code=?${ids ? ` AND address_id IN (${placeholders})` : ''}`).bind(scope, ...(ids || [])),
    database.prepare(`
    INSERT INTO address_generation_index(
      address_id,country_code,admin1_key,admin1_code_key,locality_key,postal_locality_key,
      district_key,postcode_key,locality,postal_locality,district,postcode,street,house_number,
      building_name,search_text,random_key,country_rank,residential_rank,residential_ready,active,source_revision,updated_at
    ) SELECT ranked.id,ranked.country_code,${administrativeKeySql('admin1', 'ranked')},${administrativeKeySql('admin1_code', 'ranked')},
      ${administrativeKeySql('locality', 'ranked')},ranked.postal_locality_key,ranked.district_key,ranked.postcode_key,
      ${administrativeValueSql('locality', 'ranked')},ranked.postal_locality,ranked.district,ranked.postcode,ranked.street,
      ranked.house_number,ranked.building_name,
      lower(concat_ws(' ',ranked.house_number,ranked.street,ranked.building_name,ranked.district,
        ${administrativeValueSql('locality', 'ranked')},ranked.postal_locality,${administrativeValueSql('admin1', 'ranked')},
        ${administrativeValueSql('admin1_code', 'ranked')},ranked.postcode)),
      ranked.random_key,ranked.country_rank,ranked.residential_rank,ranked.ready,
      1,concat_ws(':',ranked.dataset_id,ranked.dataset_version),?
    FROM (
      SELECT eligible_runtime.*,
        ROW_NUMBER() OVER (ORDER BY random_key,id) AS country_rank,
        CASE WHEN ready=1 THEN ROW_NUMBER() OVER (PARTITION BY ready ORDER BY random_key,id) END AS residential_rank
      FROM (
        SELECT runtime.*,
          CASE WHEN runtime.property_type IN ('residential','apartment') AND runtime.residential_evidence=1 THEN 1 ELSE 0 END AS ready
        FROM ${source}
        WHERE runtime.country_code=?${ids ? ` AND runtime.id IN (${placeholders})` : ''} AND runtime.active=1 AND ${eligible}
      ) eligible_runtime
    ) ranked
    ON CONFLICT(address_id) DO UPDATE SET
      country_code=excluded.country_code,admin1_key=excluded.admin1_key,admin1_code_key=excluded.admin1_code_key,
      locality_key=excluded.locality_key,postal_locality_key=excluded.postal_locality_key,
      district_key=excluded.district_key,postcode_key=excluded.postcode_key,locality=excluded.locality,
      postal_locality=excluded.postal_locality,district=excluded.district,postcode=excluded.postcode,
      street=excluded.street,house_number=excluded.house_number,building_name=excluded.building_name,
      search_text=excluded.search_text,random_key=excluded.random_key,country_rank=excluded.country_rank,
      residential_rank=excluded.residential_rank,residential_ready=excluded.residential_ready,
      active=1,source_revision=excluded.source_revision,updated_at=excluded.updated_at
  `).bind(updatedAt, scope, ...(ids || [])),
    database.prepare(`INSERT INTO address_pool_revisions(kind,version) VALUES (?,?)
      ON CONFLICT(kind) DO UPDATE SET version=excluded.version`).bind(`generation:${scope}`, randomUUID())
  ]);
  if (ids) await database.prepare(`UPDATE address_generation_index
    SET country_rank=ranked.country_rank,residential_rank=ranked.residential_rank
    FROM (SELECT id,ROW_NUMBER() OVER (ORDER BY random_key,id) AS country_rank,
      CASE WHEN ready=1 THEN ROW_NUMBER() OVER (PARTITION BY ready ORDER BY random_key,id) END AS residential_rank
      FROM (SELECT address_id AS id,random_key,residential_ready AS ready FROM address_generation_index
        WHERE country_code=? AND active=1) indexed) ranked
    WHERE address_generation_index.address_id=ranked.id AND (COALESCE(address_generation_index.country_rank,0)<>ranked.country_rank
      OR COALESCE(address_generation_index.residential_rank,0)<>COALESCE(ranked.residential_rank,0))`).bind(scope).run();
  return generationIndexRowCountForCountry(database, scope);
};

export const refreshStaleAddressGenerationIndexes = async (database) => {
  const eligible = addressPublicationSqlClause('runtime.');
    const rows = (await database.prepare(`WITH source_counts AS (
      SELECT runtime.country_code,COUNT(DISTINCT runtime.id) AS source_count,
        COUNT(DISTINCT generation.address_id) AS matched_index_count
      FROM address_pool_runtime runtime
      LEFT JOIN address_generation_index generation ON generation.address_id=runtime.id
        AND generation.country_code=runtime.country_code AND generation.active=1
      WHERE runtime.active=1 AND ${eligible}
      GROUP BY runtime.country_code
    ), index_counts AS (
      SELECT country_code,COUNT(*) FILTER (WHERE active=1) AS index_count,
        COUNT(*) FILTER (WHERE active=1 AND country_rank IS NULL) AS missing_ranks,
        COUNT(*) FILTER (WHERE active=1 AND residential_ready=1 AND residential_rank IS NULL) AS missing_residential_ranks
      FROM address_generation_index GROUP BY country_code
    )
    , all_countries AS (
      SELECT country_code FROM source_counts
      UNION
      SELECT country_code FROM index_counts
    )
    SELECT all_countries.country_code
    FROM all_countries
      LEFT JOIN source_counts ON source_counts.country_code=all_countries.country_code
      LEFT JOIN index_counts ON index_counts.country_code=all_countries.country_code
    WHERE COALESCE(source_counts.source_count,0)<>COALESCE(index_counts.index_count,0)
      OR COALESCE(source_counts.source_count,0)<>COALESCE(source_counts.matched_index_count,0)
      OR COALESCE(index_counts.missing_ranks,0)>0
      OR COALESCE(index_counts.missing_residential_ranks,0)>0
    ORDER BY all_countries.country_code`).all()).results || [];
  for (const { country_code: countryCode } of rows) await refreshAddressGenerationIndex(database, countryCode);
  return rows.map(({ country_code: countryCode }) => countryCode);
};

const generationIndexRowCountForCountry = async (database, countryCode) => Number(
  await database.prepare('SELECT COUNT(*) AS total FROM address_generation_index WHERE country_code=? AND active=1')
    .bind(countryCode).first('total') || 0
);

export const refreshAddressGenerationIndexIfEmpty = async (database, countryCodes) => {
  let refreshed = false;
  for (const countryCode of countryCodes) {
    if (await generationIndexRowCountForCountry(database, countryCode)) continue;
    await refreshAddressGenerationIndex(database, countryCode);
    refreshed = true;
  }
  return refreshed;
};
