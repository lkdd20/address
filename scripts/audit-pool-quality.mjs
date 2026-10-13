// Checks every published address, not a sample: region codes and names against the catalog, catalog Chinese and
// English names, and city fields that name no city. Any blocking rule above zero fails the audit.
// Run inside the production sync or API container: `address-entrypoint node scripts/audit-pool-quality.mjs`.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { requiresAdminCode } from '../src/domain/address-contracts.mjs';
import { junkCharacters, localityIssue } from '../src/domain/address-quality.mjs';
import { createPostgresPool, PostgresDatabase } from '../server/database/postgres.mjs';
import { administrativeNameCountries, loadAdministrativeNames, mixedLevelCountries, usTerritories } from '../server/sync/administrative-names.mjs';
import { wrongPostalArea } from '../server/sync/administrative-names-repair.mjs';
import { runProcess } from '../server/sync/process.mjs';
import { regionBoundaryCountries, regionsForPoints } from '../server/sync/region-boundaries.mjs';

const clean = (value) => String(value ?? '').trim();
const han = /\p{Script=Han}/u;
const blocking = ['outside_country', 'junk_characters', 'region_code_conflict', 'region_name_is_code', 'region_outside_catalog', 'region_boundary', 'postal_area',
  'zh_region', 'en_region', 'zh_city', 'en_city', 'locality_invalid'];
// The catalog postcode table assigns some postcodes to the wrong region (e.g. NL 4542 Hoek to Friesland), so a
// postcode conflict is reported for review but cannot block or drive repairs.
const warnings = ['region_postcode_conflict', 'zh_place_pending'];
const output = process.env.AUDIT_OUTPUT || '';
const pool = createPostgresPool({ environment: process.env });
const database = new PostgresDatabase(pool);
const requested = clean(process.env.AUDIT_COUNTRIES).toUpperCase().split(',').map(clean).filter(Boolean);
const countries = requested.length ? requested : (await database.prepare(
  'SELECT country_code FROM sync_country_policies WHERE enabled=1 ORDER BY country_code').all()).results.map((row) => row.country_code);

const quiet = (options) => runProcess({ ...options, stdio: ['ignore', 'ignore', 'inherit'] });
const field = (row, language, name) => clean(row[`${language === 'en' ? 'en' : 'zh'}_${name}`]);
const report = {};
for (const countryCode of countries) {
  const names = administrativeNameCountries(countryCode) ? await loadAdministrativeNames(database, countryCode, { withPostcodes: true }) : null;
  const counts = Object.fromEntries([...blocking, ...warnings].map((rule) => [rule, 0]));
  const examples = {};
  const flag = (rule, row, detail) => {
    counts[rule] += 1;
    if ((examples[rule] ||= []).length < 3) examples[rule].push({ id: row.id, ...detail });
  };
  let total = 0;
  for (let cursor = ''; ;) {
    const page = (await database.prepare(`SELECT id,native_language,admin1,admin1_code,locality,postal_locality,postcode,latitude,longitude,generation,street,house_number,building_name,district,
        component_variants_json::jsonb->'en'->>'admin1' AS en_admin1,
        component_variants_json::jsonb->'en'->>'locality' AS en_locality,
        component_variants_json::jsonb->'en'->>'postalLocality' AS en_postal_locality,
        component_variants_json::jsonb->'zh-CN'->>'admin1' AS zh_admin1,
        component_variants_json::jsonb->'zh-CN'->>'locality' AS zh_locality,
        component_variants_json::jsonb->'zh-CN'->>'postalLocality' AS zh_postal_locality
      FROM address_pool WHERE country_code=? AND active=1 AND id>? ORDER BY id LIMIT 5000`).bind(countryCode, cursor).all()).results;
    if (!page.length) break;
    cursor = page.at(-1).id;
    total += page.length;
    // Mixed-level countries check admin1 against the first-level polygon containing the point.
    const boundaries = regionBoundaryCountries.has(countryCode) ? await regionsForPoints({ countryCode, points: page,
      cacheDir: process.env.ADDRESS_SYNC_CACHE_DIR || '.data-cache', pythonBin: process.env.PYTHON_BIN || 'python3', execute: quiet }) : new Map();
    for (const row of page) {
      const native = { admin1: row.admin1, admin1Code: row.admin1_code, locality: row.locality, postalLocality: row.postal_locality };
      const issue = countryCode === 'CN' ? '' : localityIssue(countryCode, native);
      if (issue) flag('locality_invalid', row, { issue, locality: row.locality, postalLocality: row.postal_locality });
      const junk = [row.street, row.house_number, row.building_name, row.district, row.admin1, row.locality, row.postal_locality]
        .find((value) => junkCharacters.test(String(value ?? '')));
      if (junk) flag('junk_characters', row, { value: junk });
      if (boundaries.get(row.id)?.outside) flag('outside_country', row, { admin1: row.admin1, locality: row.locality, latitude: row.latitude, longitude: row.longitude });
      if (wrongPostalArea(countryCode, row)) flag('postal_area', row, { postcode: row.postcode, locality: row.locality });
      if (!names) continue;
      const moved = names.regionInBoundary(native, boundaries.get(row.id), { postcode: row.postcode, latitude: row.latitude, longitude: row.longitude });
      if (moved) flag('region_boundary', row, { admin1: row.admin1, postcode: row.postcode, region: boundaries.get(row.id)?.code, expected: moved.admin1 });
      const stored = { en: { admin1: row.en_admin1, locality: row.en_locality, postalLocality: row.en_postal_locality },
        'zh-CN': { admin1: row.zh_admin1, locality: row.zh_locality, postalLocality: row.zh_postal_locality } };
      const corrections = names.names(native, stored);
      if (corrections.native.admin1Code) flag('region_code_conflict', row, { admin1: row.admin1, admin1Code: row.admin1_code, expected: corrections.native.admin1Code });
      if (corrections.native.admin1) flag('region_name_is_code', row, { admin1: row.admin1, expected: corrections.native.admin1 });
      // Independent evidence: the catalog postcode's region must be the region the address names.
      const resolved = names.regionFor(native);
      const named = resolved?.root || resolved?.region;
      const posted = clean(row.postcode) && names.postcodeRegionFor(row.postcode);
      if (named && posted && named.id !== posted.id && clean(named.code) !== clean(posted.code)) {
        flag('region_postcode_conflict', row, { admin1: row.admin1, postcode: row.postcode, postcodeRegion: posted.code || posted.name });
      }
      if (requiresAdminCode(countryCode) && clean(row.admin1) && !names.regionFor(native)
        && !(countryCode === 'US' && usTerritories[clean(row.admin1_code || row.admin1).toUpperCase()])) {
        flag('region_outside_catalog', row, { admin1: row.admin1, admin1Code: row.admin1_code });
      }
      for (const language of ['en', 'zh-CN']) {
        for (const [name, expected] of Object.entries(corrections[language])) {
          const actual = field(row, language, name === 'postalLocality' ? 'postal_locality' : name);
          if (actual === expected) continue;
          flag(`${language === 'en' ? 'en' : 'zh'}_${name === 'admin1' ? 'region' : 'city'}`, row, { [name]: native[name], actual, expected });
        }
      }
      if (!String(row.native_language || '').startsWith('zh')) {
        for (const name of ['admin1', 'locality']) {
          const value = field(row, 'zh-CN', name);
          if (value && !han.test(value) && /\p{L}/u.test(value) && !corrections['zh-CN'][name]) flag('zh_place_pending', row, { [name]: value });
        }
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  report[countryCode] = { total, counts, examples };
  const failed = blocking.filter((rule) => counts[rule]).map((rule) => `${rule}=${counts[rule]}`);
  console.log(`${countryCode} total=${total} ${failed.length ? `FAIL ${failed.join(' ')}` : 'ok'} region_postcode_conflict=${counts.region_postcode_conflict} zh_place_pending=${counts.zh_place_pending}`);
  if (process.env.AUDIT_VERBOSE && failed.length) console.log(JSON.stringify({ countryCode, examples }));
}
await pool.end();
if (output) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
}
const failures = Object.values(report).reduce((sum, country) => sum + blocking.reduce((count, rule) => count + country.counts[rule], 0), 0);
console.log(failures ? `pool audit failed: ${failures} blocking issues` : 'pool audit passed');
process.exitCode = failures ? 1 : 0;
