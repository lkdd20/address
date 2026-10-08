import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isValidPostcode } from '../../src/domain/postcode-patterns.mjs';
import { refreshAddressGenerationIndex } from '../database/generation-index.mjs';
import { formattedAddress, localizedFormattedAddress } from './address-etl.mjs';

const execFileAsync = promisify(execFile);
const boundaryScript = fileURLToPath(new URL('./postcode-boundary.py', import.meta.url));

export const POSTCODE_INFERENCE_REVISION = 'postcode-inference-v1';
// Postcodes finer than a neighbourhood (or absent) cannot be derived from areas or neighbours.
export const POSTCODE_INFERENCE_EXCLUDED = new Set(['CN', 'HK', 'GB', 'NL', 'CA', 'JP', 'SG', 'BR']);
export const postcodeBoundarySources = {
  US: {
    id: 'census-zcta-2020', field: 'ZCTA5CE20', name: 'U.S. Census Bureau TIGER/Line 2020 ZCTA5',
    url: 'https://www2.census.gov/geo/tiger/TIGER2020/ZCTA520/tl_2020_us_zcta520.zip'
  },
  AU: {
    id: 'abs-poa-2021', field: 'POA_CODE21', name: 'ABS ASGS Edition 3 Postal Areas 2021',
    url: 'https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs/edition-3-july-2021-june-2026/access-and-downloads/digital-boundary-files/POA_2021_AUST_GDA2020_SHP.zip'
  }
};
// Taiwan's 3-digit postal zones are assigned per township (鄉鎮市區), so one township's source postcodes determine it.
const TOWNSHIP_POSTCODE_COUNTRIES = new Set(['TW']);
const inferenceRevision = (country) => TOWNSHIP_POSTCODE_COUNTRIES.has(country)
  ? `${POSTCODE_INFERENCE_REVISION}+township` : POSTCODE_INFERENCE_REVISION;
const CATALOG_DISTANCE_DEGREES = 0.3;
const NEIGHBOR_LATITUDE = 0.01;
const NEIGHBOR_LONGITUDE = 0.012;
const MINIMUM_NEIGHBORS = 3;

const clean = (value) => String(value ?? '').trim();
const nameKey = (value) => clean(value).normalize('NFKC').toLocaleUpperCase('und').replace(/\s+/gu, ' ');
const postcodeKey = (value) => clean(value).normalize('NFKC').toLocaleLowerCase('und').replace(/\s/gu, '');
const localityOf = (row) => nameKey(row.postal_locality || row.locality);

const downloadBoundary = async (source, cacheDir) => {
  // Kept outside raw/ so stale-artifact cleanup does not force a re-download on every run.
  const directory = resolve(cacheDir, 'reference', 'postcode-boundaries');
  const file = resolve(directory, `${source.id}.zip`);
  if (await stat(file).then((info) => info.size > 0, () => false)) return file;
  await mkdir(directory, { recursive: true });
  const partial = `${file}.part`;
  await execFileAsync('curl', ['-4', '-fsSL', '--retry', '3', '--connect-timeout', '20', '-o', partial, source.url],
    { maxBuffer: 1024 * 1024, timeout: 30 * 60_000 });
  await rename(partial, file);
  return file;
};

// Point-in-polygon lookup in DuckDB; returns address id -> postcode for points inside exactly one area.
export const boundaryPostcodes = async (source, points, { cacheDir, pythonBin = process.env.PYTHON_BIN || 'python3' }) => {
  if (!points.length) return new Map();
  const zip = await downloadBoundary(source, cacheDir);
  const directory = resolve(cacheDir, 'postcode-inference');
  await mkdir(directory, { recursive: true });
  const stamp = `${source.id}-${process.pid}-${Date.now()}`;
  const input = resolve(directory, `${stamp}.csv`);
  const output = resolve(directory, `${stamp}.out.csv`);
  try {
    await writeFile(input, `id,longitude,latitude\n${points.map((point) => `${point.id},${point.longitude},${point.latitude}`).join('\n')}\n`);
    await execFileAsync(pythonBin, [boundaryScript, '--boundary-zip', zip, '--field', source.field, '--input', input, '--output', output],
      { maxBuffer: 16 * 1024 * 1024, timeout: 60 * 60_000 });
    const lines = (await readFile(output, 'utf8')).trim().split('\n').slice(1).filter(Boolean);
    return new Map(lines.map((line) => line.split(',')).map(([id, code]) => [id, clean(code)]));
  } finally {
    await rm(input, { force: true });
    await rm(output, { force: true });
  }
};

// GeoNames postal codes keyed by region and place name; a place with exactly one postcode determines it.
const loadCatalogPostcodes = async (database, countryCode) => {
  const rows = (await database.prepare(`SELECT postcode.code,postcode.locality_name,postcode.latitude,postcode.longitude,
      region.code AS region_code,region.name AS region_name,region.native_name AS region_native
    FROM catalog_postcodes postcode LEFT JOIN catalog_regions region ON region.id=postcode.region_id
    WHERE postcode.country_code=?`).bind(countryCode).all()).results;
  const places = new Map();
  for (const row of rows) {
    const code = clean(row.code);
    if (!code || !isValidPostcode(countryCode, code)) continue;
    for (const region of new Set([row.region_code, row.region_name, row.region_native].map(nameKey).filter(Boolean))) {
      const key = `${region}\u001f${nameKey(row.locality_name)}`;
      const place = places.get(key) || { codes: new Set(), points: [] };
      place.codes.add(code);
      if (Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude))) {
        place.points.push([Number(row.latitude), Number(row.longitude)]);
      }
      places.set(key, place);
    }
  }
  return places;
};

const catalogPostcode = (places, row) => {
  for (const region of [row.admin1_code, row.admin1].map(nameKey).filter(Boolean)) {
    for (const place of [row.district, row.postal_locality, row.locality].map(nameKey).filter(Boolean)) {
      const entry = places.get(`${region}\u001f${place}`);
      if (!entry) continue;
      if (entry.codes.size !== 1) return '';
      const near = !entry.points.length || entry.points.some(([latitude, longitude]) =>
        Math.abs(latitude - Number(row.latitude)) <= CATALOG_DISTANCE_DEGREES
        && Math.abs(longitude - Number(row.longitude)) <= CATALOG_DISTANCE_DEGREES);
      return near ? [...entry.codes][0] : '';
    }
  }
  return '';
};

// Source-provided postcodes of nearby addresses in the same place; derived postcodes never vote.
const neighborPostcodes = async (database, countryCode, rows) => {
  const found = new Map();
  for (const row of rows) {
    const latitude = Number(row.latitude);
    const longitude = Number(row.longitude);
    const votes = (await database.prepare(`SELECT pool.postcode,COUNT(*) AS total FROM address_pool pool
      LEFT JOIN address_postcode_inference inferred ON inferred.address_id=pool.id AND inferred.postcode<>''
      WHERE pool.country_code=? AND pool.active=1 AND pool.postcode<>'' AND inferred.address_id IS NULL
        AND pool.latitude BETWEEN ? AND ? AND pool.longitude BETWEEN ? AND ?
        AND upper(coalesce(nullif(pool.postal_locality,''),pool.locality))=?
      GROUP BY pool.postcode`).bind(countryCode, latitude - NEIGHBOR_LATITUDE, latitude + NEIGHBOR_LATITUDE,
      longitude - NEIGHBOR_LONGITUDE, longitude + NEIGHBOR_LONGITUDE, localityOf(row)).all()).results;
    if (votes.length === 1 && Number(votes[0].total) >= MINIMUM_NEIGHBORS) found.set(row.id, clean(votes[0].postcode));
  }
  return found;
};

const townshipKey = (row) => `${clean(row.admin1)}\u001f${clean(row.locality)}`.replaceAll('台', '臺');
const loadTownshipPostcodes = async (database, countryCode) => {
  const rows = (await database.prepare(`SELECT pool.admin1,pool.locality,pool.postcode,COUNT(*) AS total FROM address_pool pool
    LEFT JOIN address_postcode_inference inferred ON inferred.address_id=pool.id AND inferred.postcode<>''
    WHERE pool.country_code=? AND pool.active=1 AND pool.postcode<>'' AND pool.locality<>'' AND inferred.address_id IS NULL
    GROUP BY pool.admin1,pool.locality,pool.postcode`).bind(countryCode).all()).results;
  const townships = new Map();
  for (const row of rows) {
    const township = townships.get(townshipKey(row)) || { codes: new Set(), total: 0 };
    township.codes.add(clean(row.postcode).slice(0, 3));
    township.total += Number(row.total);
    townships.set(townshipKey(row), township);
  }
  return new Map([...townships].filter(([, township]) => township.codes.size === 1 && township.total >= MINIMUM_NEIGHBORS)
    .map(([key, township]) => [key, [...township.codes][0]]));
};

const withPostcode = (row, postcode, countryCode) => {
  const components = JSON.parse(row.component_variants_json || '{}');
  const addresses = JSON.parse(row.address_variants_json || '{}');
  const previousNative = formattedAddress(components.native || {}, countryCode);
  for (const language of Object.keys(components)) components[language] = { ...components[language], postcode };
  if (addresses.native === previousNative) addresses.native = formattedAddress(components.native, countryCode);
  if (components.en) addresses.en = localizedFormattedAddress(components.en, countryCode, 'en');
  if (components['zh-CN']) addresses['zh-CN'] = localizedFormattedAddress(components['zh-CN'], countryCode, 'zh-CN');
  return { components: JSON.stringify(components), addresses: JSON.stringify(addresses) };
};

export const runPostcodeInference = async ({
  database, countryCode, cacheDir, pythonBin, boundaryLookup = boundaryPostcodes,
  pageSize = 5_000, now = () => new Date(), signal
}) => {
  const country = String(countryCode || '').toUpperCase();
  const summary = { countryCode: country, checked: 0, boundary: 0, catalog: 0, township: 0, neighbor: 0 };
  const revision = inferenceRevision(country);
  if (POSTCODE_INFERENCE_EXCLUDED.has(country)) return summary;
  const boundary = postcodeBoundarySources[country];
  let places;
  let townships;
  let cursor = '';
  for (;;) {
    signal?.throwIfAborted();
    const rows = (await database.prepare(`SELECT pool.id,pool.latitude,pool.longitude,pool.admin1,pool.admin1_code,pool.locality,
        pool.postal_locality,pool.district,pool.component_variants_json,pool.address_variants_json
      FROM address_pool pool LEFT JOIN address_postcode_inference inferred ON inferred.address_id=pool.id
      WHERE pool.country_code=? AND pool.active=1 AND pool.postcode='' AND pool.id>?
        AND (inferred.address_id IS NULL OR inferred.checked_revision<>?)
      ORDER BY pool.id LIMIT ?`).bind(country, cursor, revision, pageSize).all()).results;
    if (!rows.length) break;
    cursor = rows.at(-1).id;
    const results = new Map();
    if (boundary) {
      const found = await boundaryLookup(boundary, rows.map((row) => ({ id: row.id, latitude: row.latitude, longitude: row.longitude })),
        { cacheDir, pythonBin });
      for (const [id, postcode] of found) results.set(id, { postcode, method: 'boundary', source: boundary.id });
    }
    places ||= await loadCatalogPostcodes(database, country);
    for (const row of rows) {
      if (results.has(row.id)) continue;
      const postcode = catalogPostcode(places, row);
      if (postcode) results.set(row.id, { postcode, method: 'catalog-unique', source: 'geonames-postal-codes' });
    }
    if (TOWNSHIP_POSTCODE_COUNTRIES.has(country)) {
      townships ||= await loadTownshipPostcodes(database, country);
      for (const row of rows) {
        const postcode = !results.has(row.id) && townships.get(townshipKey(row));
        if (postcode) results.set(row.id, { postcode, method: 'township-consensus', source: 'address-pool' });
      }
    }
    const remaining = rows.filter((row) => !results.has(row.id));
    for (const [id, postcode] of await neighborPostcodes(database, country, remaining)) {
      results.set(id, { postcode, method: 'neighbor-consensus', source: 'address-pool' });
    }
    const updatedAt = now().toISOString();
    const updated = [];
    await database.transaction(async (transaction) => {
      for (const row of rows) {
        const result = results.get(row.id);
        const postcode = result && isValidPostcode(country, result.postcode) ? result.postcode : '';
        if (postcode) {
          const { components, addresses } = withPostcode(row, postcode, country);
          await transaction.prepare(`UPDATE address_pool SET postcode=?,postcode_key=?,component_variants_json=?,address_variants_json=?
            WHERE id=? AND postcode=''`).bind(postcode, postcodeKey(postcode), components, addresses, row.id).run();
          updated.push(row.id);
          summary[{ boundary: 'boundary', 'catalog-unique': 'catalog', 'township-consensus': 'township' }[result.method] || 'neighbor'] += 1;
        }
        await transaction.prepare(`INSERT INTO address_postcode_inference(address_id,postcode,method,source,checked_revision,updated_at)
          VALUES (?,?,?,?,?,?) ON CONFLICT(address_id) DO UPDATE SET postcode=excluded.postcode,method=excluded.method,
            source=excluded.source,checked_revision=excluded.checked_revision,updated_at=excluded.updated_at`)
          .bind(row.id, postcode, postcode ? result.method : '', postcode ? result.source : '', revision, updatedAt).run();
      }
    });
    if (updated.length) await refreshAddressGenerationIndex(database, country, { addressIds: updated });
    summary.checked += rows.length;
  }
  return summary;
};
