import { createHash } from 'node:crypto';
import { createPostgresPool, PostgresDatabase } from '../database/postgres.mjs';
import { translateValues, translateNumberedValues, localizedFormattedAddress, usableTranslation, PostgresTranslationCache } from './address-etl.mjs';
import { semanticAddressFields as localizedFields } from '../../src/domain/address-localization.mjs';
import { diagnoseStoredAddressPoolV2Row, storedAddressPoolV2RowCanRecoverTranslations, storedAddressPoolV2RowIsPublishable } from '../api/repositories/address-pool-v2';
import { findNonResidentialMatch } from '../../src/domain/non-residential.mjs';
import { matchesCustomBlacklist } from '../lib/custom-blacklist.mjs';
import { refreshAddressGenerationIndex } from '../database/generation-index.mjs';
import { refreshCountryCounts } from '../database/published-pool.mjs';
import { refreshResidentialCoverage } from '../database/residential-coverage.mjs';
import { administrativeAssignmentJoin, projectAdministrativeRow, refreshAdministrativeAssignments } from '../database/administrative-assignments.mjs';
import { createBackfillProviders, readBackfillProgress, writeBackfillProgress } from './translation-providers.mjs';

const clean = (value) => String(value ?? '').trim();
const integer = (value, fallback, max) => Math.min(max, Math.max(1, Number.parseInt(value, 10) || fallback));
const fingerprint = (row) => createHash('sha256').update(JSON.stringify([
  'semantic-recovery-v1', row.component_variants_json, row.address_variants_json, row.generation,
  row.active, row.retired_at, row.dataset_id, row.dataset_version, row.evidence_id,
  row.admin1, row.admin1_code, row.locality, row.street, row.house_number, row.postcode,
  row.latitude, row.longitude, row.property_type, row.quality_score, row.residential_evidence,
  ...(row.administrative_patch_json && row.administrative_patch_json !== '{}' ? [row.administrative_patch_json] : [])
])).digest('hex');
const parse = (value) => { try { return JSON.parse(value) || {}; } catch { return {}; } };
const eligibleRetirement = (row) => row.active === 1 || String(row.retired_at || '').startsWith('publication-validation:');
function* recoveryCandidates(groups, first) {
  for (let index = 0; index < Math.max(...groups.map((group) => group.length)); index++) {
    for (let lane = 0; lane < groups.length; lane++) {
      const row = groups[(first + lane) % groups.length][index];
      if (row) yield row;
    }
  }
}
const stateRevision = (revision, status, reason) => status === 'rejected' && reason === 'base_contract'
  ? createHash('sha256').update(JSON.stringify(['native-source-contract-v3', revision])).digest('hex')
  : status === 'failed' && reason === 'translation_or_publication_rejected'
    ? createHash('sha256').update(JSON.stringify(['semantic-field-recovery-v2', revision])).digest('hex') : revision;

const safeTranslatedField = (row, field, value) => !matchesCustomBlacklist([value])
  && !(field === 'buildingName' && (row?.residential_evidence || ['residential', 'apartment'].includes(row?.property_type))
    && findNonResidentialMatch({ countryCode: row.country_code, buildingName: value }).excluded);

export const pendingTranslationFields = (variants, nativeLanguage, row) => Object.fromEntries(['en', 'zh-CN'].map((language) => [
  language, localizedFields.filter((field) => {
    const original = clean(variants.native?.[field]);
    if (!original) return false;
    const value = clean(variants[language]?.[field]);
    return !usableTranslation(value, language, original) || !safeTranslatedField(row, field, value)
      || language === 'zh-CN' && !String(nativeLanguage).startsWith('zh')
        && !String(nativeLanguage).startsWith('en') && value === original && /\p{L}/u.test(original);
  })
]));

const sourceRows = async (database, ids) => {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = (await database.prepare(`SELECT address.*,administrative.patch_json AS administrative_patch_json,
  evidence.id AS evidence_id,evidence.source_record_id,evidence.record_url,evidence.observed_at,evidence.evidence_type,
  dataset.id AS dataset_id,dataset.version AS dataset_version,dataset.published_at AS source_updated_at,
  dataset.imported_at,dataset.license_code AS source_license,dataset.license_url,
  source.id AS source_id,source.name AS source_name,source.homepage_url AS source_url,
  source.attribution_text,source.attribution_url,
  CASE WHEN residential.address_id IS NULL THEN 0 ELSE 1 END AS residential_evidence
  FROM address_pool address
  ${administrativeAssignmentJoin('address')}
  JOIN address_pool_evidence evidence ON evidence.address_id=address.id
    AND evidence.is_primary=1 AND evidence.is_current=1 AND evidence.evidence_type='address_existence'
  JOIN address_datasets dataset ON dataset.id=evidence.dataset_id
    AND dataset.status='active' AND dataset.redistribution_allowed=1 AND dataset.country_code=address.country_code
  JOIN address_sources source ON source.id=dataset.source_id AND source.redistribution_allowed=1
  LEFT JOIN (SELECT DISTINCT evidence.address_id FROM address_pool_evidence evidence
    JOIN address_datasets dataset ON dataset.id=evidence.dataset_id AND dataset.status='active' AND dataset.redistribution_allowed=1
    JOIN address_sources source ON source.id=dataset.source_id AND source.redistribution_allowed=1
    WHERE evidence.address_id IN (${placeholders}) AND evidence.evidence_type='residential_use' AND evidence.is_current=1
  ) residential ON residential.address_id=address.id
  WHERE address.id IN (${placeholders})`).bind(...ids, ...ids).all()).results;
  return new Map(rows.map((row) => [row.id, row]));
};

const saveState = (database, row, revision, status, attempts, retryAt, reason, now, diagnostics = []) => database.prepare(`
  INSERT INTO translation_recovery(address_id,input_hash,service_revision,status,attempts,next_attempt_at,reason,updated_at,diagnostics_json)
  VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(address_id) DO UPDATE SET input_hash=excluded.input_hash,
    service_revision=excluded.service_revision,status=excluded.status,attempts=excluded.attempts,
    next_attempt_at=excluded.next_attempt_at,reason=excluded.reason,updated_at=excluded.updated_at,diagnostics_json=excluded.diagnostics_json`)
  .bind(row.id, fingerprint(row), stateRevision(revision, status, reason), status, attempts, retryAt, reason, now.toISOString(), JSON.stringify(diagnostics)).run();

const placeKey = (value) => clean(value).normalize('NFKC').toLocaleLowerCase('und').replace(/[^\p{L}\p{N}]/gu, '');
const uniquePlace = (rows, value, code = false) => {
  if (!clean(value)) return null;
  const matches = rows.filter((row) => [row.name, row.native_name, row.zh_name, ...(code ? [row.code] : [])]
    .some((name) => placeKey(name) === placeKey(value)));
  return matches.length === 1 ? matches[0] : null;
};
const canonicalTranslations = async (database, row, variants, catalogs) => {
  if (!catalogs.has(row.country_code)) {
    const regions = (await database.prepare('SELECT id,code,name,native_name,zh_name,path FROM catalog_regions WHERE country_code=?').bind(row.country_code).all()).results;
    const cities = (await database.prepare('SELECT id,region_id,name,native_name,zh_name FROM catalog_cities WHERE country_code=?').bind(row.country_code).all()).results;
    const citiesByName = new Map();
    for (const city of cities) for (const name of new Set([city.name, city.native_name, city.zh_name].map(placeKey).filter(Boolean))) {
      const matches = citiesByName.get(name) || [];
      matches.push(city);
      citiesByName.set(name, matches);
    }
    catalogs.set(row.country_code, { regions, citiesByName, regionsById: new Map(regions.map((region) => [region.id, region])) });
  }
  const { regions, citiesByName, regionsById } = catalogs.get(row.country_code);
  const source = variants.native;
  const region = uniquePlace(regions, source.admin1Code || source.admin1, true);
  const matches = (citiesByName.get(placeKey(source.locality)) || []).filter((city) => !region
    || city.region_id === region.id || regionsById.get(city.region_id)?.path?.startsWith(region.path));
  const city = !region && (source.admin1 || source.admin1Code) || matches.length !== 1 ? null : matches[0];
  for (const [field, identity] of [['admin1', region], ['locality', city],
    ['postalLocality', placeKey(source.postalLocality) === placeKey(source.locality) ? city : null]]) {
    if (!identity || !source[field]) continue;
    for (const language of ['en', 'zh-CN']) {
      const name = language === 'en' ? identity.name : identity.zh_name;
      if (!usableTranslation(variants[language][field], language, source[field]) && usableTranslation(name, language, source[field])) variants[language][field] = name;
    }
  }
};

const localizedRow = (row, variants) => ({ ...row, component_variants_json: JSON.stringify(variants),
  address_variants_json: JSON.stringify({ ...parse(row.address_variants_json),
    en: localizedFormattedAddress(variants.en, row.country_code, 'en'),
    'zh-CN': localizedFormattedAddress(variants['zh-CN'], row.country_code, 'zh-CN') }) });
const translationDiagnostics = (row, variants) => Object.entries(pendingTranslationFields(variants, row.native_language, row))
  .flatMap(([language, fields]) => fields.map((field) => ({ stage: 'translation', language, field, code: 'invalid_or_missing_translation' })));
const readyToPublish = (row, variants, now) => !translationDiagnostics(row, variants).length
  && storedAddressPoolV2RowIsPublishable(localizedRow(row, variants), now);

const publish = async (database, candidates, revision, now, signal, outcome) => {
  const { published, busy, failed, started } = outcome;
  for (const country of new Set(candidates.map(({ row }) => row.country_code))) {
    signal.throwIfAborted();
    try {
    const completed = await database.transaction(async (transaction) => {
      await transaction.exec("SET LOCAL lock_timeout TO '250ms'");
      await transaction.exec("SET LOCAL statement_timeout TO '60s'");
      await transaction.exec(`LOCK TABLE address_pool,address_pool_evidence,address_datasets,address_sources,
        address_generation_index,admin_coverage_stats,residential_coverage,sync_country_state
        IN SHARE ROW EXCLUSIVE MODE`);
      candidates.filter(({ row }) => row.country_code === country).forEach(({ row }) => started.add(row.id));
      const currentRows = await sourceRows(transaction, candidates.filter(({ row }) => row.country_code === country).map(({ row }) => row.id));
      const updates = [];
      for (const { row, variants } of candidates.filter((item) => item.row.country_code === country)) {
        signal.throwIfAborted();
        const current = currentRows.get(row.id);
        if (!current || fingerprint(current) !== fingerprint(row) || !eligibleRetirement(current)) continue;
        const candidate = localizedRow(current, variants);
        if (!storedAddressPoolV2RowIsPublishable(candidate, now())) continue;
        const stored = parse(current.component_variants_json);
        if (current.administrative_patch_json && stored.native) candidate.component_variants_json = JSON.stringify({ ...variants, native: stored.native });
        await transaction.prepare(`UPDATE address_pool SET component_variants_json=?,address_variants_json=?,active=1,retired_at=NULL WHERE id=?`)
          .bind(candidate.component_variants_json, candidate.address_variants_json, row.id).run();
        updates.push(row);
      }
      if (!updates.length) return [];
      signal.throwIfAborted();
      await refreshAddressGenerationIndex(transaction, country, { addressIds: updates.map((row) => row.id) });
      signal.throwIfAborted();
      await refreshCountryCounts(transaction, country, now().toISOString(), { useGenerationIndex: true });
      await refreshResidentialCoverage(transaction, country, now().toISOString(), signal,
        { useGenerationIndex: true, inTransaction: true });
      const datasets = [...new Set(updates.map((row) => row.dataset_id))];
      const counts = (await transaction.prepare(`SELECT evidence.dataset_id,COUNT(DISTINCT evidence.address_id) AS total
          FROM address_pool_evidence evidence JOIN address_pool address ON address.id=evidence.address_id AND address.active=1
          WHERE evidence.dataset_id IN (${datasets.map(() => '?').join(',')}) AND evidence.is_current=1
          GROUP BY evidence.dataset_id`).bind(...datasets).all()).results;
      const countsByDataset = new Map(counts.map((row) => [row.dataset_id, Number(row.total)]));
      for (const dataset of datasets) {
        await transaction.prepare('UPDATE address_datasets SET active_count=? WHERE id=?').bind(countsByDataset.get(dataset) || 0, dataset).run();
      }
      await transaction.prepare(`INSERT INTO address_pool_revisions(kind,version) VALUES ('translation',?)
        ON CONFLICT(kind) DO UPDATE SET version=excluded.version`).bind(now().toISOString()).run();
      const publishedRows = await sourceRows(transaction, updates.map((row) => row.id));
      for (const row of updates) {
        const current = publishedRows.get(row.id);
        const attempts = candidates.find((item) => item.row.id === row.id).attempts;
        await saveState(transaction, current, revision, 'complete', attempts, null, null, now());
      }
      signal.throwIfAborted();
      return updates.map((row) => row.id);
    });
    completed.forEach((id) => published.add(id));
    } catch (error) {
      if (!['55P03', '57014', '40001', '40P01'].includes(error.code)) throw error;
      for (const { row } of candidates.filter(({ row }) => row.country_code === country)) {
        if (error.code === '55P03') busy.add(row.id);
        else failed.set(row.id, error.code === '57014' ? 'publication_timeout' : 'publication_conflict');
      }
    }
  }
};

const runTranslationBatch = async ({ database, environment = process.env, fetchImpl = fetch,
  pendingLimit = integer(environment.TRANSLATION_BACKFILL_BATCH, 30, 300),
  scanLimit = integer(environment.TRANSLATION_BACKFILL_SCAN, 2000, 20_000),
  now = () => new Date(), signal: parentSignal, brokerClient, cacheOnly: onlyCached = false, countryCodes = [] }) => {
  const countries = [...new Set(countryCodes.map((country) => String(country).toUpperCase()))];
  if (countries.some((country) => !/^[A-Z]{2}$/u.test(country) || country === 'CN')) throw new Error('INVALID_RECOVERY_COUNTRY');
  const countryScope = countries.length ? ` AND address.country_code IN (${countries.map(() => '?').join(',')})` : '';
  const progressKey = onlyCached || countries.length ? `scan:${onlyCached ? 'cache' : 'online'}:${countries.sort().join(',') || 'all'}` : 'scan';
  const timeout = AbortSignal.timeout(integer(environment.TRANSLATION_BACKFILL_TIMEOUT_MS, 180_000, 300_000));
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
  const services = await createBackfillProviders({ database, environment, fetchImpl, signal, now, brokerClient });
  if (!services.enabled && !onlyCached) return { scanned: 0, updated: 0, done: true };
  const progress = await readBackfillProgress(database, progressKey, { phase: onlyCached ? 'all' : 'street', cursor: '' });
  const cacheProgress = await readBackfillProgress(database, 'terminal-cache', { cursor: '' });
  const terminal = onlyCached ? [] : (await database.prepare(`SELECT recovery.address_id AS id,address.country_code FROM translation_recovery recovery
    JOIN address_pool address ON address.id=recovery.address_id
    WHERE recovery.status='failed' AND recovery.reason IN ('translation_or_publication_rejected','retry_limit')
      AND recovery.address_id>?${countryScope} ORDER BY recovery.address_id LIMIT ?`).bind(cacheProgress.cursor, ...countries, pendingLimit).all()).results;
  const due = onlyCached ? [] : (await database.prepare(`SELECT recovery.address_id AS id,address.country_code FROM translation_recovery recovery
    JOIN address_pool address ON address.id=recovery.address_id
    WHERE ((recovery.status IN ('pending','waiting') AND (recovery.next_attempt_at IS NULL OR recovery.next_attempt_at<=?))
      OR (recovery.status IN ('failed','rejected') AND recovery.service_revision<>
        CASE WHEN recovery.status='rejected' AND recovery.reason='base_contract' THEN ?
          WHEN recovery.status='failed' AND recovery.reason='translation_or_publication_rejected' THEN ? ELSE ? END))${countryScope}
    ORDER BY CASE WHEN address.match_level='street' THEN 0 ELSE 1 END,address.active DESC,recovery.updated_at LIMIT ?`)
    .bind(now().toISOString(), stateRevision(services.revision, 'rejected', 'base_contract'),
      stateRevision(services.revision, 'failed', 'translation_or_publication_rejected'), services.revision, ...countries, scanLimit).all()).results;
  const rows = (await database.prepare(`SELECT address.id,address.country_code,address.component_variants_json,address.native_language,
      address.active,address.retired_at,recovery.status AS recovery_status
    FROM address_pool address LEFT JOIN translation_recovery recovery ON recovery.address_id=address.id
    WHERE address.country_code<>'CN' AND address.id>?
      AND (address.active=1 OR address.retired_at LIKE 'publication-validation:%')
      ${progress.phase === 'street' ? "AND address.match_level='street'" : ''}${countryScope} ORDER BY address.id LIMIT ?`)
    .bind(progress.cursor, ...countries, scanLimit).all()).results;
  let scanned = 0;
  const pending = [];
  const outcome = { published: new Set(), busy: new Set(), failed: new Map(), started: new Set() };
  const deferred = new Set();
  let ready = [];
  let interrupted = null;
  let phase = 'preparation';
  const cache = new PostgresTranslationCache(database);
  const catalogs = new Map();
  const seen = new Set();
  try {
    for (const country of ['HK', 'SG']) {
      const addressIds = [...new Set([...due, ...terminal, ...rows].filter((row) => row.country_code === country).map((row) => row.id))];
      await refreshAdministrativeAssignments(database, country, { addressIds, signal });
    }
    const firstLane = Number(progress.lane || 0) % 3;
    progress.lane = (firstLane + 1) % 3;
    const candidates = [...recoveryCandidates([due, rows, terminal], firstLane)];
    let prefetched = new Map();
    let recoveryStates = new Map();
    let cachedValues = {};
    for (let index = 0; index < candidates.length; index++) {
      signal.throwIfAborted();
      if (pending.length >= pendingLimit) break;
      if (index % 200 === 0) {
        const ids = [...new Set(candidates.slice(index, index + 200).map((row) => row.id))];
        prefetched = await sourceRows(database, ids);
        const states = (await database.prepare(`SELECT * FROM translation_recovery WHERE address_id IN (${ids.map(() => '?').join(',')})`)
          .bind(...ids).all()).results;
        recoveryStates = new Map(states.map((state) => [state.address_id, state]));
        if (onlyCached) {
          const values = [...new Set([...prefetched.values()].flatMap((row) => {
            const native = parse(projectAdministrativeRow(row).component_variants_json).native || {};
            return localizedFields.map((field) => clean(native[field])).filter(Boolean);
          }))];
          cachedValues = { en: await cache.get(values, 'en', signal), 'zh-CN': await cache.get(values, 'zh-CN', signal) };
        }
      }
      const scannedRow = candidates[index];
      if (rows.includes(scannedRow)) { progress.cursor = scannedRow.id; scanned += 1; }
      if (terminal.includes(scannedRow)) cacheProgress.cursor = scannedRow.id;
      if (seen.has(scannedRow.id)) continue;
      seen.add(scannedRow.id);
      const row = prefetched.get(scannedRow.id);
      if (!row || !eligibleRetirement(row)) {
        await database.prepare(`UPDATE translation_recovery SET status='rejected',reason='source_unavailable',
          diagnostics_json='[{"stage":"source","code":"source_unavailable"}]',
          service_revision=?,next_attempt_at=NULL,updated_at=? WHERE address_id=?`)
          .bind(services.revision, now().toISOString(), scannedRow.id).run();
        continue;
      }
      const previous = recoveryStates.get(row.id);
      if (row.active === 1 && storedAddressPoolV2RowIsPublishable(row, now())) {
        if (previous && previous.status !== 'complete') await saveState(database, row, services.revision, 'complete', previous.attempts, null, null, now());
        continue;
      }
      const unchanged = previous?.input_hash === fingerprint(row)
        && previous?.service_revision === stateRevision(services.revision, previous?.status, previous?.reason);
      const cacheOnly = onlyCached || unchanged && (previous.status === 'failed'
        && ['translation_or_publication_rejected', 'retry_limit'].includes(previous.reason)
        || previous.status === 'waiting' && previous.attempts >= 3
          && ['publication_busy', 'publication_deferred', 'cancelled', 'batch_timeout'].includes(previous.reason));
      if (unchanged && !onlyCached && (previous.status === 'rejected'
        || previous.status === 'complete' && storedAddressPoolV2RowIsPublishable(row, now())
        || previous.status === 'failed' && !cacheOnly
        || previous.next_attempt_at && previous.next_attempt_at > now().toISOString())) continue;
      if (!storedAddressPoolV2RowCanRecoverTranslations(row, now())) {
        if (!onlyCached) await saveState(database, row, services.revision, 'rejected', 0, null, 'base_contract', now(),
          diagnoseStoredAddressPoolV2Row(row, { recovery: true, now: now() }).issues);
        continue;
      }
      const attempts = cacheOnly ? Number(previous?.attempts || 0) : unchanged ? previous.attempts + 1 : 1;
      if (attempts > 3) {
        await saveState(database, row, services.revision, 'failed', 3, null, 'retry_limit', now());
        continue;
      }
      const retryAt = new Date(now().getTime() + 60_000 * 2 ** (attempts - 1)).toISOString();
      const variants = parse(projectAdministrativeRow(row).component_variants_json);
      variants.en = { ...variants.native, ...variants.en };
      variants['zh-CN'] = { ...variants.native, ...variants['zh-CN'] };
      for (const language of ['en', 'zh-CN']) {
        for (const [field, value] of Object.entries(variants.native || {})) {
          if (!localizedFields.includes(field)) variants[language][field] = value;
        }
      }
      await canonicalTranslations(database, row, variants, catalogs);
      let fields = pendingTranslationFields(variants, row.native_language, row);
      if (cacheOnly) {
        for (const language of ['en', 'zh-CN']) {
          const cached = onlyCached ? cachedValues[language]
            : await cache.get(fields[language].map((field) => clean(variants.native[field])), language, signal);
          for (const field of fields[language]) {
            const original = clean(variants.native[field]);
            const value = cached.get(original);
            if (usableTranslation(value, language, original) && safeTranslatedField(row, field, value)) variants[language][field] = value;
          }
        }
        if (!readyToPublish(row, variants, now())) continue;
        fields = { en: [], 'zh-CN': [] };
      }
      pending.push({ row, variants, attempts, retryAt, fields, cacheOnly });
      if (!cacheOnly) await saveState(database, row, services.revision, 'pending', attempts, retryAt, 'in_progress', now());
    }
    signal.throwIfAborted();
    phase = 'translation';
    for (const language of ['en', 'zh-CN']) {
      const values = [...new Set(pending.flatMap(({ variants, fields }) => fields[language].map((field) => clean(variants.native[field]))))];
      const accepts = (value, target, original) => usableTranslation(value, target, original)
          && pending.every(({ row, variants, fields }) => fields[target].every((field) => clean(variants.native[field]) !== original
            || safeTranslatedField(row, field, value)));
      const providerEnvironment = { ...environment, GOOGLE_TRANSLATION_ENABLED: String(services.googleEnabled) };
      const translations = await translateValues(values, language, providerEnvironment, fetchImpl, cache, signal, services.providers, accepts);
      const repaired = await translateNumberedValues(values.filter((value) => !accepts(translations.get(value), language, value)),
        language, providerEnvironment, fetchImpl, cache, signal, services.providers, accepts);
      for (const [value, translated] of repaired) translations.set(value, translated);
      for (const { row, variants, fields } of pending) {
        for (const field of fields[language]) {
          const original = clean(variants.native[field]);
          const value = translations.get(original);
          if (usableTranslation(value, language, original) && safeTranslatedField(row, field, value)) variants[language][field] = value;
        }
      }
    }
    ready = pending.filter(({ row, variants }) => readyToPublish(row, variants, now()));
    const country = ready[0]?.row.country_code;
    ready.filter(({ row }) => row.country_code !== country).forEach(({ row }) => deferred.add(row.id));
    phase = 'publication';
    await publish(database, ready.filter(({ row }) => !deferred.has(row.id)), services.revision, now, signal, outcome);
  } catch (error) {
    if (!signal.aborted) throw error;
    interrupted = parentSignal?.aborted ? 'cancelled' : 'batch_timeout';
  }
  const readyIds = new Set(ready.map(({ row }) => row.id));
  for (const { row, variants, fields, attempts, cacheOnly } of pending) {
    if (outcome.published.has(row.id)) continue;
    const hasProviderResult = (predicate) => Object.entries(fields).some(([language, names]) =>
      names.some((field) => predicate(clean(variants.native[field]), language)));
    const publicationFailure = outcome.failed.get(row.id);
    const waitingReason = deferred.has(row.id) ? 'publication_deferred'
      : outcome.busy.has(row.id) ? 'publication_busy' : interrupted;
    const waiting = waitingReason ? { reason: waitingReason, retryAt: new Date(now().getTime() + 60_000).toISOString() }
      : !publicationFailure && !readyIds.has(row.id) ? services.wait : null;
    const spentAttempt = !deferred.has(row.id) && !outcome.busy.has(row.id) && Boolean(publicationFailure || (interrupted
      ? outcome.started.has(row.id) || hasProviderResult(services.wasDispatched)
      : !waiting || hasProviderResult(services.failed)));
    const usedAttempts = attempts - Number(!spentAttempt && !cacheOnly);
    const retryAt = new Date(now().getTime() + 60_000 * 2 ** Math.max(0, usedAttempts - 1)).toISOString();
    let nextAttemptAt = waiting?.retryAt || retryAt;
    if (spentAttempt && nextAttemptAt < retryAt) nextAttemptAt = retryAt;
    const status = waiting && cacheOnly ? 'waiting' : usedAttempts >= 3 ? 'failed' : waiting ? 'waiting' : 'pending';
    await saveState(database, row, services.revision, status, usedAttempts,
      status === 'failed' ? null : nextAttemptAt,
      publicationFailure || waiting?.reason || 'translation_or_publication_rejected', now(),
      [...translationDiagnostics(row, variants), ...diagnoseStoredAddressPoolV2Row(localizedRow(row, variants), { now: now() }).issues]);
  }
  const completed = !interrupted && (!rows.length || scanned === rows.length && rows.length < scanLimit);
  if (completed) {
    progress.cursor = '';
    progress.phase = onlyCached || progress.phase === 'street' ? 'all' : 'street';
  }
  await writeBackfillProgress(database, progressKey, progress, now());
  if (!onlyCached) {
    if (!terminal.length || cacheProgress.cursor === terminal.at(-1)?.id && terminal.length < pendingLimit) cacheProgress.cursor = '';
    await writeBackfillProgress(database, 'terminal-cache', cacheProgress, now());
  }
  return { scanned, updated: outcome.published.size, attempted: pending.length, requests: services.requests, done: onlyCached && completed,
    ...(outcome.busy.size ? { publicationBusy: outcome.busy.size } : {}),
    ...(interrupted ? { interrupted, phase } : {}) };
};

export const runTranslationBackfillBatch = async (options) => {
  const environment = options.environment || process.env;
  if (/^(0|false|no)$/iu.test(String(environment.TRANSLATION_BACKFILL_ENABLED))) return { scanned: 0, updated: 0, done: true };
  const lease = await options.database.pool.connect();
  let acquired = false;
  try {
    acquired = Boolean((await lease.query('SELECT pg_try_advisory_lock(172901,1) AS acquired')).rows[0]?.acquired);
    if (!acquired) return { scanned: 0, updated: 0, attempted: 0, requests: 0, done: false, waiting: 'recovery_in_progress' };
    return await runTranslationBatch(options);
  } finally {
    let discard = false;
    try { if (acquired) await lease.query('SELECT pg_advisory_unlock(172901,1)'); }
    catch { discard = true; }
    lease.release(discard);
  }
};

export const startTranslationBackfill = ({ database, environment = process.env, isBusy = () => false,
  intervalMs = integer(environment.TRANSLATION_BACKFILL_INTERVAL_MS, 60_000, 3_600_000),
  setTimer = setTimeout, now = () => new Date(), fetchImpl = fetch, workerPool }) => {
  if (/^(0|false|no)$/iu.test(String(environment.TRANSLATION_BACKFILL_ENABLED))) return async () => {};
  // Import uses a legacy transaction connection; this worker needs its own transaction context.
  const pool = workerPool || createPostgresPool({ ...database.pool.options, max: 2, min: 0,
    statement_timeout: 15_000, application_name: 'address-translation-backfill' });
  const workerDatabase = new PostgresDatabase(pool);
  const controller = new AbortController();
  let timer;
  let running = Promise.resolve();
  const schedule = () => {
    if (controller.signal.aborted) return;
    timer = setTimer(() => {
      running = runTranslationBackfillBatch({ database: workerDatabase, environment, now, fetchImpl, signal: controller.signal })
        .then((result) => { if (result.attempted) console.log(JSON.stringify({ event: 'translation_backfill', ...result, duringSync: isBusy() })); })
        .then(async () => {
          controller.signal.throwIfAborted();
          const result = await runTranslationBackfillBatch({ database: workerDatabase, environment, now, fetchImpl,
            signal: controller.signal, cacheOnly: true, pendingLimit: 300 });
          if (result.updated) console.log(JSON.stringify({ event: 'translation_cache_recovery', ...result }));
        })
        .catch((error) => { if (!controller.signal.aborted) console.error('Translation backfill failed',
          error.name, typeof error.code === 'string' ? error.code : ''); })
        .finally(schedule);
      return running;
    }, intervalMs);
    timer.unref?.();
  };
  schedule();
  return async () => {
    controller.abort(); clearTimeout(timer); await running;
    if (pool !== database.pool) await pool.end();
  };
};
