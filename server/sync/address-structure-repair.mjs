import {
  addressCanonicalKey, houseNumberIssue, splitConcatenatedLocality, trimStreetAdministration, validateAddressQuality
} from '../../src/domain/address-quality.mjs';
import { refreshAddressGenerationIndex } from '../database/generation-index.mjs';
import { formattedAddress, localizedFormattedAddress } from './address-etl.mjs';
import { CatalogReverseGeocoder } from './catalog-reverse-geocoder.mjs';
import { correctedRegion, regionBoundaryCountries, regionsForPoints } from './region-boundaries.mjs';

export const ADDRESS_STRUCTURE_REVISION = 'address-structure-v1';
const cleanKey = (value) => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('und');
const premiseFields = ['houseNumber', 'buildingName', 'unit'];

const separated = /[,，;]/u;
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

// A light pass over short columns finds the rows any rule can change; only those rows' JSON variants are read.
const scanCandidates = async ({ database, countryCode, pause }) => {
  const rows = [];
  for (let cursor = ''; ;) {
    const page = (await database.prepare(`SELECT id,match_level,house_number,street,locality,postal_locality,admin1,admin1_code,
        latitude,longitude FROM address_pool WHERE country_code=? AND active=1 AND id>? ORDER BY id LIMIT 5000`)
      .bind(countryCode, cursor).all()).results;
    if (!page.length) return rows;
    rows.push(...page);
    cursor = page.at(-1).id;
    await pause();
  }
};

// One pass per country and revision over the published rows: the same house number, city, street and region rules the
// import applies. A row that then fails the quality gate is retired; one that matches another address is removed.
export const repairAddressStructure = async ({
  database, countryCode, cacheDir, pythonBin, now = () => new Date(), pageSize = 500, regionLookup = regionsForPoints,
  pauseMs = 200
}) => {
  const key = `${ADDRESS_STRUCTURE_REVISION}:${countryCode}`;
  const summary = { countryCode, changed: 0, downgraded: 0, regions: 0, retired: 0, duplicates: 0 };
  if (countryCode === 'CN' || await database.prepare('SELECT value_json FROM translation_backfill_progress WHERE key=?')
    .bind(key).first('value_json')) return summary;
  const geocoder = await CatalogReverseGeocoder.load(database, countryCode);
  const catalogRegions = [...geocoder.regionsById.values()];
  // Pauses between pages keep this one-time pass from saturating the disk shared with the API.
  const pause = () => delay(pauseMs);
  const scanned = await scanCandidates({ database, countryCode, pause });
  let regions = new Map();
  let regionsMissing = false;
  if (regionBoundaryCountries.has(countryCode) && scanned.length) {
    // Without the polygons the other rules still apply; the revision stays open so regions are checked next start.
    regions = await regionLookup({ countryCode, points: scanned, cacheDir, pythonBin }).catch((error) => {
      console.error(`[address-sync] ${countryCode} region boundaries unavailable`, error?.code || error?.message || error);
      regionsMissing = true;
      return new Map();
    });
  }
  const candidates = scanned.filter((row) => {
    const region = regions.get(row.id);
    return region?.outside
      || (row.match_level !== 'street' && houseNumberIssue(countryCode, row.house_number))
      || [row.street, row.locality, row.postal_locality].some((value) => separated.test(String(value || '')))
      || correctedRegion(countryCode, { admin1: row.admin1, admin1Code: row.admin1_code }, region, catalogRegions);
  }).map((row) => row.id);
  const retiredAt = `publication-validation:${ADDRESS_STRUCTURE_REVISION}:${now().toISOString()}`;
  const touched = [];
  for (let offset = 0; offset < candidates.length; offset += pageSize) {
    const batch = candidates.slice(offset, offset + pageSize);
    const rows = (await database.prepare(`SELECT id,match_level,property_type,native_language,latitude,longitude,
        component_variants_json,address_variants_json FROM address_pool
      WHERE active=1 AND id IN (${batch.map(() => '?').join(',')})`).bind(...batch).all()).results;
    await pause();
    await database.transaction(async (transaction) => {
      for (const row of rows) {
        const variants = JSON.parse(row.component_variants_json || '{}');
        const before = variants.native || {};
        const hints = { en: {}, 'zh-CN': {} };
        let next = splitConcatenatedLocality(countryCode, trimStreetAdministration(countryCode, before),
          (value) => geocoder.isKnownCity(value));
        if (!next.locality && before.locality) {
          const filled = geocoder.lookup({ latitude: row.latitude, longitude: row.longitude, components: next });
          if (filled.locality) {
            next = { ...next, locality: filled.locality, ...(before.postalLocality && !next.postalLocality ? { postalLocality: filled.locality } : {}) };
            hints.en.locality = filled.localityEn || filled.locality;
            if (filled.localityZh) hints['zh-CN'].locality = filled.localityZh;
          }
        }
        const region = regions.get(row.id);
        const outside = region?.outside === true;
        const corrected = outside ? null : correctedRegion(countryCode, next, region, catalogRegions);
        if (corrected) {
          next = { ...next, admin1: corrected.admin1, admin1Code: corrected.admin1Code };
          hints.en.admin1 = corrected.admin1En;
          if (corrected.admin1Zh) hints['zh-CN'].admin1 = corrected.admin1Zh;
        }
        const downgrade = row.match_level !== 'street' && Boolean(houseNumberIssue(countryCode, next.houseNumber));
        if (downgrade) for (const field of premiseFields) delete next[field];
        const matchLevel = downgrade ? 'street' : row.match_level;
        if (!outside && !downgrade && JSON.stringify(next) === JSON.stringify(before)) continue;
        touched.push(row.id);
        const quality = validateAddressQuality({ countryCode, components: next, latitude: row.latitude, longitude: row.longitude, matchLevel });
        if (outside || !quality.valid) {
          await transaction.prepare('UPDATE address_pool SET active=0,retired_at=? WHERE id=?').bind(retiredAt, row.id).run();
          summary.retired += 1;
          continue;
        }
        const canonicalKey = addressCanonicalKey(countryCode, next, matchLevel);
        if (await transaction.prepare('SELECT id FROM address_pool WHERE country_code=? AND canonical_key=? AND id<>? LIMIT 1')
          .bind(countryCode, canonicalKey, row.id).first('id')) {
          await transaction.prepare('DELETE FROM address_pool WHERE id=?').bind(row.id).run();
          summary.duplicates += 1;
          continue;
        }
        const localized = Object.fromEntries(['en', 'zh-CN'].map((language) => {
          const value = { ...(variants[language] || {}) };
          for (const field of new Set([...Object.keys(before), ...Object.keys(next)])) {
            if (next[field] === before[field]) continue;
            if (!next[field]) delete value[field];
            else value[field] = hints[language][field] || next[field];
          }
          return [language, value];
        }));
        const addresses = JSON.parse(row.address_variants_json || '{}');
        await transaction.prepare(`UPDATE address_pool SET match_level=?,property_type=?,street=?,house_number=?,building_name=?,
            locality=?,postal_locality=?,district=?,admin1=?,admin1_code=?,admin1_key=?,admin1_code_key=?,locality_key=?,
            postal_locality_key=?,district_key=?,canonical_key=?,component_variants_json=?,address_variants_json=? WHERE id=?`)
          .bind(matchLevel, downgrade ? 'unknown' : row.property_type, next.street || '', next.houseNumber || '', next.buildingName || '',
            next.locality || '', next.postalLocality || '', next.district || '', next.admin1 || '', next.admin1Code || '',
            cleanKey(next.admin1), cleanKey(next.admin1Code), cleanKey(next.locality), cleanKey(next.postalLocality),
            cleanKey(next.district), canonicalKey, JSON.stringify({ ...variants, native: next, ...localized }),
            JSON.stringify({ ...addresses, native: formattedAddress(next, countryCode),
              en: localizedFormattedAddress(localized.en, countryCode, 'en'),
              'zh-CN': localizedFormattedAddress(localized['zh-CN'], countryCode, 'zh-CN') }), row.id).run();
        if (downgrade) {
          await transaction.prepare("DELETE FROM address_pool_evidence WHERE address_id=? AND evidence_type='residential_use'").bind(row.id).run();
          summary.downgraded += 1;
        }
        if (corrected) summary.regions += 1;
        summary.changed += 1;
      }
    });
  }
  // The index is refreshed before the revision is recorded, so a timeout here is retried at the next start.
  for (let offset = 0; offset < touched.length; offset += 500) {
    await refreshAddressGenerationIndex(database, countryCode, { addressIds: touched.slice(offset, offset + 500) });
  }
  if (!regionsMissing) {
    await database.prepare(`INSERT INTO translation_backfill_progress(key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .bind(key, JSON.stringify({ done: true, ...summary }), now().toISOString()).run();
  }
  return summary;
};
