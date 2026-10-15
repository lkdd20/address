import { requiresAdminCode } from '../../src/domain/address-contracts.mjs';
import { addressCanonicalKey, junkCharacters, localityIssue, validateAddressQuality } from '../../src/domain/address-quality.mjs';
import { refreshAddressGenerationIndex } from '../database/generation-index.mjs';
import { formattedAddress, localizedFormattedAddress } from './address-etl.mjs';
import { administrativeNameCountries, administrativeNamesRevision, loadAdministrativeNames, mixedLevelCountries, postalRegionCodeCountries,
  singaporeRegion } from './administrative-names.mjs';
import { CatalogReverseGeocoder } from './catalog-reverse-geocoder.mjs';
import { regionBoundaryCountries, regionsForPoints } from './region-boundaries.mjs';
import { staleCoverage } from './stale-coverage.mjs';

const clean = (value) => String(value ?? '').trim();
const cleanKey = (value) => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('und');
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const localities = ['locality', 'postalLocality'];
// Cape Town parcels took postcode and city from a national suburb-name match, so suburbs that share a name with one
// elsewhere (Sandown, Windermere) carry a Johannesburg or Durban postcode. City of Cape Town postcodes are 7000-8099.
export const wrongPostalArea = (countryCode, { generation, postcode }) => countryCode === 'ZA'
  && String(generation || '').startsWith('cape-town-') && Boolean(clean(postcode)) && !/^(?:7\d{3}|80\d{2})$/u.test(clean(postcode));

// BDNB shards outside Creuse were exported with Creuse as their department; the postcode names the real one, which
// is left empty where it only repeats the city (Paris).
const bdnbDepartments = { 23: 'Creuse', 33: 'Gironde', 69: 'Rhône', 75: 'Paris' };
export const bdnbDepartment = (countryCode, { generation, postcode, district, locality }) => {
  if (countryCode !== 'FR' || !String(generation || '').startsWith('france-bdnb-') || clean(district) !== 'Creuse'
    || clean(postcode).startsWith('23')) return null;
  const department = bdnbDepartments[clean(postcode).slice(0, 2)] || '';
  return cleanKey(department) === cleanKey(locality) ? '' : department;
};

// Clears city fields that name no city, then lets the catalog fill the city from coordinates as the import does.
const repairedLocality = (countryCode, native, row, geocoder) => {
  const next = { ...native };
  const hints = { en: {}, 'zh-CN': {} };
  if (wrongPostalArea(countryCode, { generation: row.generation, postcode: native.postcode })) {
    for (const field of ['postcode', ...localities]) delete next[field];
  }
  for (const field of localities) {
    if (localityIssue(countryCode, { admin1: next.admin1, admin1Code: next.admin1Code, locality: next[field] })) delete next[field];
  }
  if (!next.locality && !next.postalLocality && (native.locality || native.postalLocality)) {
    const filled = geocoder.lookup({ latitude: row.latitude, longitude: row.longitude, components: next });
    if (filled.locality) {
      next.locality = filled.locality;
      if (native.postalLocality) next.postalLocality = filled.locality;
      for (const field of localities.filter((name) => next[name])) {
        hints.en[field] = filled.localityEn || filled.locality;
        if (filled.localityZh) hints['zh-CN'][field] = filled.localityZh;
      }
    }
  }
  return { next, hints };
};

const scanColumns = `id,admin1,admin1_code,locality,postal_locality,district,postcode,latitude,longitude,generation,street,house_number,building_name,match_level,
  component_variants_json::jsonb->'en'->>'admin1' AS en_admin1,
  component_variants_json::jsonb->'en'->>'locality' AS en_locality,
  component_variants_json::jsonb->'en'->>'postalLocality' AS en_postal_locality,
  component_variants_json::jsonb->'zh-CN'->>'admin1' AS zh_admin1,
  component_variants_json::jsonb->'zh-CN'->>'locality' AS zh_locality,
  component_variants_json::jsonb->'zh-CN'->>'postalLocality' AS zh_postal_locality`;
// Retired rows are scanned too: translation recovery republishes publication-validation retirements unchanged.
const scan = async (database, countryCode, pause) => {
  const rows = (await database.prepare(`SELECT ${scanColumns} FROM address_pool WHERE country_code=? AND active=0
    AND retired_at LIKE 'publication-validation:%'`).bind(countryCode).all()).results;
  for (let cursor = ''; ;) {
    const page = (await database.prepare(`SELECT ${scanColumns}
      FROM address_pool WHERE country_code=? AND active=1 AND id>? ORDER BY id LIMIT 5000`).bind(countryCode, cursor).all()).results;
    if (!page.length) return rows;
    rows.push(...page);
    cursor = page.at(-1).id;
    await pause();
  }
};

const current = (row) => ({
  en: { admin1: row.en_admin1, locality: row.en_locality, postalLocality: row.en_postal_locality },
  'zh-CN': { admin1: row.zh_admin1, locality: row.zh_locality, postalLocality: row.zh_postal_locality }
});
// True when the catalog, the region polygon or the city gate would change this row.
export const administrativeNamesCandidate = (countryCode, names, row, boundary) => {
  const native = { admin1: row.admin1, admin1Code: row.admin1_code, locality: row.locality, postalLocality: row.postal_locality };
  if (boundary?.outside || localityIssue(countryCode, native) || wrongPostalArea(countryCode, row)
    || [row.street, row.house_number, row.building_name, row.district, row.admin1, row.locality, row.postal_locality]
      .some((value) => junkCharacters.test(String(value ?? '')))
    || bdnbDepartment(countryCode, row) !== null) return true;
  if (names.regionInBoundary?.(native, boundary, { postcode: row.postcode, latitude: row.latitude, longitude: row.longitude })) return true;
  if (names.unrecognizedRegion?.(native, boundary, row)) return true;
  if (administrativeNameCountries(countryCode) && !clean(row.admin1)) return true;
  // Published rows the import gate would reject are never generated; they are repaired or retired.
  if (validateAddressQuality({ countryCode, latitude: row.latitude, longitude: row.longitude, matchLevel: row.match_level || 'premise',
    components: { ...native, houseNumber: row.house_number, street: row.street, buildingName: row.building_name, district: row.district,
      postcode: row.postcode } }).reasons.length) return true;
  const stored = current(row);
  const corrections = names.names(native, stored);
  if (Object.keys(corrections.native).length) return true;
  return ['en', 'zh-CN'].some((language) => Object.entries(corrections[language])
    .some(([field, value]) => clean(stored[language][field]) !== value));
};

// One pass per country and revision over published and retired rows: regions and cities take their catalog names, the
// admin1 text corrects its code, and a city field that names no city is refilled from the catalog or the row is retired.
export const repairAdministrativeNames = async ({
  database, countryCode, cacheDir, pythonBin, regionLookup = regionsForPoints, now = () => new Date(), pageSize = 500, pauseMs = 200
}) => {
  const revision = administrativeNamesRevision(countryCode);
  const key = `${revision}:${countryCode}`;
  const summary = { countryCode, changed: 0, codes: 0, localities: 0, postcodes: 0, retired: 0, duplicates: 0, restored: 0 };
  if (countryCode === 'CN' || await database.prepare('SELECT value_json FROM translation_backfill_progress WHERE key=?')
    .bind(key).first('value_json')) return summary;
  // v1 retired rows for any quality reason and v4 for findings its own corrections caused (a Paris department equal
  // to the city); they are restored and judged again.
  const restored = (await database.prepare(`UPDATE address_pool SET active=1,retired_at=NULL WHERE country_code=? AND active=0
    AND (retired_at LIKE 'publication-validation:administrative-names-v1:%' OR retired_at LIKE 'publication-validation:administrative-names-v4:%')
    RETURNING id`).bind(countryCode).all()).results.map((row) => row.id);
  summary.restored = restored.length;
  // Chinese-script and city-state countries keep their own names; only the city gate applies to them.
  const names = administrativeNameCountries(countryCode)
    ? await loadAdministrativeNames(database, countryCode, { withPostcodes: mixedLevelCountries.has(countryCode) })
    : { names: () => ({ native: {}, en: {}, 'zh-CN': {} }), unrecognizedRegion: countryCode === 'SG' ? singaporeRegion((await database.prepare(
      'SELECT name,native_name,zh_name FROM catalog_regions WHERE country_code=?').bind(countryCode).all()).results || []) : undefined };
  const geocoder = await CatalogReverseGeocoder.load(database, countryCode);
  const pause = () => delay(pauseMs);
  const scanned = await scan(database, countryCode, pause);
  // Without the polygons the revision fails and is retried at the next start.
  // Points outside every region polygon are outside the country; mixed-level countries also check their regions.
  const boundaries = regionBoundaryCountries.has(countryCode) && scanned.length
    ? await regionLookup({ countryCode, points: scanned, cacheDir, pythonBin }) : new Map();
  const candidates = scanned.filter((row) => administrativeNamesCandidate(countryCode, names, row, boundaries.get(row.id))).map((row) => row.id);
  const retiredAt = `publication-validation:${revision}:${now().toISOString()}`;
  const touched = [...restored];
  const removed = new Set();
  for (let offset = 0; offset < candidates.length; offset += pageSize) {
    const batch = candidates.slice(offset, offset + pageSize);
    const rows = (await database.prepare(`SELECT id,active,match_level,latitude,longitude,generation,component_variants_json,address_variants_json
      FROM address_pool WHERE id IN (${batch.map(() => '?').join(',')})`).bind(...batch).all()).results;
    await pause();
    await database.transaction(async (transaction) => {
      for (const row of rows) {
        if (removed.has(row.id)) continue;
        if (boundaries.get(row.id)?.outside) {
          if (Number(row.active) !== 1) continue;
          await transaction.prepare('UPDATE address_pool SET active=0,retired_at=? WHERE id=?').bind(retiredAt, row.id).run();
          touched.push(row.id);
          summary.retired += 1;
          continue;
        }
        const variants = JSON.parse(row.component_variants_json || '{}');
        const before = variants.native || {};
        const { next, hints } = repairedLocality(countryCode, before, row, geocoder);
        const moved = names.regionInBoundary?.(next, boundaries.get(row.id), { postcode: next.postcode, latitude: row.latitude, longitude: row.longitude });
        const located = !moved && names.unrecognizedRegion?.(next, boundaries.get(row.id), row);
        if (moved || located) Object.assign(next, { admin1: (moved || located).admin1, admin1Code: (moved || located).admin1Code });
        // A region still missing takes the one the import fill would give: the catalog region nearest the point.
        const filled = !moved && !located && administrativeNameCountries(countryCode) && !clean(next.admin1)
          ? geocoder.lookup({ latitude: row.latitude, longitude: row.longitude, components: next }) : {};
        if (filled.admin1) Object.assign(next, { admin1: postalRegionCodeCountries.has(countryCode) && filled.admin1Code || filled.admin1,
          admin1Code: filled.admin1Code });
        const region = located || (filled.admin1 ? { admin1En: filled.admin1En, admin1Zh: filled.admin1Zh } : null);
        if (region) {
          hints.en.admin1 = region.admin1En;
          if (region.admin1Zh) hints['zh-CN'].admin1 = region.admin1Zh;
        }
        const department = bdnbDepartment(countryCode, { generation: row.generation, postcode: next.postcode, district: next.district,
          locality: next.locality });
        if (department) next.district = department;
        else if (department === '') delete next.district;
        Object.assign(next, names.names(next).native);
        const active = Number(row.active) === 1;
        touched.push(row.id);
        const gate = () => validateAddressQuality({ countryCode, components: next, latitude: row.latitude, longitude: row.longitude, matchLevel: row.match_level });
        // A district repeating the city (Huonville, Huonville) adds nothing and fails the import gate; it is dropped.
        if (gate().reasons.includes('duplicate_locality_district')) {
          if (clean(next.district)) delete next.district; else delete next.dependentLocality;
        }
        const quality = gate();
        // A row the import gate still rejects (a whole address in the street field) is never generated and retires, as
        // does a region the polygon proved wrong when no province code can replace a required one (Italy).
        if (quality.reasons.length || moved && requiresAdminCode(countryCode) && !clean(next.admin1Code)) {
          if (!active) continue;
          await transaction.prepare('UPDATE address_pool SET active=0,retired_at=? WHERE id=?').bind(retiredAt, row.id).run();
          summary.retired += 1;
          continue;
        }
        // A published row keeps its address over a retired twin; a retired row yields to any twin.
        const canonicalKey = addressCanonicalKey(countryCode, next, row.match_level);
        const twins = (await transaction.prepare('SELECT id,active FROM address_pool WHERE country_code=? AND canonical_key=? AND id<>?')
          .bind(countryCode, canonicalKey, row.id).all()).results;
        if (!active && twins.length || twins.some((twin) => Number(twin.active) === 1)) {
          await transaction.prepare('DELETE FROM address_pool WHERE id=?').bind(row.id).run();
          summary.duplicates += 1;
          continue;
        }
        for (const twin of twins) {
          await transaction.prepare('DELETE FROM address_pool WHERE id=?').bind(twin.id).run();
          removed.add(twin.id);
        }
        summary.duplicates += twins.length;
        const updated = Object.fromEntries(['en', 'zh-CN'].map((language) => {
          const value = { ...(variants[language] || {}) };
          for (const field of new Set([...Object.keys(before), ...Object.keys(next)])) {
            if (next[field] === before[field]) continue;
            if (!next[field]) delete value[field];
            else value[field] = hints[language][field] || next[field];
          }
          return [language, value];
        }));
        // Catalog names are judged against the variants as they will be stored, including a refilled city.
        const corrections = names.names(next, updated);
        const localized = Object.fromEntries(['en', 'zh-CN'].map((language) => [language, { ...updated[language], ...corrections[language] }]));
        const addresses = JSON.parse(row.address_variants_json || '{}');
        // The repair only ever clears a postcode, so a kept postcode keeps its key.
        await transaction.prepare(`UPDATE address_pool SET postcode=?,postcode_key=CASE WHEN postcode=? THEN postcode_key ELSE '' END,
            district=?,district_key=?,locality=?,postal_locality=?,admin1=?,admin1_code=?,admin1_key=?,
            admin1_code_key=?,locality_key=?,postal_locality_key=?,canonical_key=?,component_variants_json=?,address_variants_json=? WHERE id=?`)
          .bind(next.postcode || '', next.postcode || '', next.district || '', cleanKey(next.district), next.locality || '', next.postalLocality || '', next.admin1 || '', next.admin1Code || '', cleanKey(next.admin1),
            cleanKey(next.admin1Code), cleanKey(next.locality), cleanKey(next.postalLocality), canonicalKey,
            JSON.stringify({ ...variants, native: next, ...localized }),
            JSON.stringify({ ...addresses, native: formattedAddress(next, countryCode),
              en: localizedFormattedAddress(localized.en, countryCode, 'en'),
              'zh-CN': localizedFormattedAddress(localized['zh-CN'], countryCode, 'zh-CN') }), row.id).run();
        if (clean(next.admin1Code) !== clean(before.admin1Code) || clean(next.admin1) !== clean(before.admin1)) summary.codes += 1;
        if (localities.some((field) => clean(next[field]) !== clean(before[field]))) summary.localities += 1;
        if (clean(next.postcode) !== clean(before.postcode)) summary.postcodes += 1;
        summary.changed += 1;
      }
    });
  }
  // The index is refreshed before the revision is recorded, so a timeout here is retried at the next start.
  for (let offset = 0; offset < touched.length; offset += 500) {
    await refreshAddressGenerationIndex(database, countryCode, { addressIds: touched.slice(offset, offset + 500) });
    await pause();
  }
  if (summary.codes || summary.localities || summary.retired || summary.restored || summary.duplicates) staleCoverage.add(countryCode);
  await database.prepare(`INSERT INTO translation_backfill_progress(key,value_json,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
    .bind(key, JSON.stringify({ done: true, ...summary }), now().toISOString()).run();
  return summary;
};
