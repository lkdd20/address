// Rebuilds server/database/catalog-city-regions.json: the upstream location catalog files most Philippine cities under
// the wrong province (Cebu towns under Bataan). Each city is placed in the official province polygon (NAMRIA/PSA via
// OCHA COD-AB) that contains it; only cities whose catalog region changes are written.
// Run inside the production sync container: `address-entrypoint node scripts/verify-catalog-city-regions.mjs`.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPostgresPool, PostgresDatabase } from '../server/database/postgres.mjs';
import { runProcess } from '../server/sync/process.mjs';

const output = process.env.OUTPUT || new URL('../server/database/catalog-city-regions.json', import.meta.url).pathname;
const cacheDir = resolve(process.env.ADDRESS_SYNC_CACHE_DIR || '.data-cache', 'boundaries');
const pythonBin = process.env.PYTHON_BIN || 'python3';
const countries = {
  PH: {
    source: 'NAMRIA and PSA via OCHA HDX COD-AB (phl_admin2), CC BY-IGO',
    dataset: {
      id: 'phl-cod-ab', kind: 'zip-shapefile',
      url: 'https://data.humdata.org/dataset/caf116df-f984-4deb-85ca-41b349d3f313/resource/4e4067d6-3fc8-4d2c-91ea-330c3d4f8e8e/download/phl_admin_boundaries.shp.zip',
      layers: [{ member: 'phl_admin2', role: 'province', name: 'adm2_name', nameEn: 'adm2_name', code: 'adm2_pcode' }]
    },
    // Polygon names the catalog spells differently, and areas that belong to a region rather than a province.
    aliases: {
      'Cotabato (North Cotabato)': 'NCO', 'Davao de Oro (Compostela Valley)': 'COM', 'Samar (Western Samar)': 'WSA',
      'Metropolitan Manila First District': '00', 'Metropolitan Manila Second District': '00',
      'Metropolitan Manila Third District': '00', 'Metropolitan Manila Fourth District': '00',
      'Special Geographic Area': '14', 'City of Isabela (not a province)': '09'
    }
  }
};
const fold = (value) => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/gu, '');

const pool = createPostgresPool({ environment: process.env });
const database = new PostgresDatabase(pool);
const result = {};
try {
  for (const [countryCode, country] of Object.entries(countries)) {
    const stem = resolve(cacheDir, `${countryCode}-city-regions`);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(`${stem}.json`, JSON.stringify({ revision: 1, datasets: [country.dataset] }));
    await runProcess({ file: pythonBin, timeoutMs: 30 * 60_000, args: [new URL('../server/sync/admin-boundary-build.py', import.meta.url).pathname,
      '--country', countryCode, '--config-file', `${stem}.json`, '--cache-dir', cacheDir, '--output', `${stem}.parquet`] });
    const regions = (await database.prepare('SELECT id,code,name FROM catalog_regions WHERE country_code=?').bind(countryCode).all()).results;
    const byCode = new Map(regions.map((region) => [region.code, region]));
    const byName = new Map(regions.map((region) => [fold(region.name), region]));
    const cities = (await database.prepare(`SELECT id,region_id,latitude,longitude FROM catalog_cities
      WHERE country_code=? AND latitude IS NOT NULL ORDER BY id`).bind(countryCode).all()).results;
    await writeFile(`${stem}.in.jsonl`, cities.map(({ id, latitude, longitude }) => JSON.stringify({ id, latitude, longitude })).join('\n'));
    await runProcess({ file: pythonBin, timeoutMs: 30 * 60_000, args: [new URL('../server/sync/admin-boundary-assign.py', import.meta.url).pathname,
      '--boundaries', `${stem}.parquet`, '--input', `${stem}.in.jsonl`, '--output', `${stem}.out.jsonl`, '--format', 'overture-jsonl',
      '--field', 'province', '--nearest-degrees', '0.1'] });
    const placed = new Map((await readFile(`${stem}.out.jsonl`, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
      .map((line) => [line.id, line.province?.province?.name]));
    const corrections = {};
    const unknown = new Set();
    for (const city of cities) {
      const name = placed.get(city.id);
      if (!name) continue;
      const region = byCode.get(country.aliases[name]) || byName.get(fold(name));
      if (!region) { unknown.add(name); continue; }
      if (region.id !== city.region_id) corrections[city.id] = region.code;
    }
    if (unknown.size) throw new Error(`${countryCode} polygons without a catalog region: ${[...unknown].join(', ')}`);
    result[countryCode] = { source: country.source, cities: corrections };
    console.log(JSON.stringify({ event: 'catalog_city_regions', countryCode, cities: cities.length, corrected: Object.keys(corrections).length }));
    for (const suffix of ['.json', '.parquet', '.in.jsonl', '.out.jsonl']) await rm(`${stem}${suffix}`, { force: true });
  }
} finally {
  await pool.end();
}
await writeFile(output, `${JSON.stringify(result, null, 1)}\n`);
