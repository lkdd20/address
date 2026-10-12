import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './process.mjs';

const syncRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
export const REGION_BOUNDARY_REVISION = 'overture-regions-v2';
// Territories that Overture files under their own country code but the project publishes with the parent country.
const territories = {
  US: ['PR', 'VI', 'GU', 'AS', 'MP', 'UM'], FR: ['GP', 'MQ', 'GF', 'RE', 'YT', 'PM', 'BL', 'MF', 'NC', 'PF', 'WF'],
  NL: ['BQ', 'AW', 'CW', 'SX'], GB: ['IM', 'JE', 'GG'], AU: ['CX', 'CC', 'NF']
};
const regionConfig = (countryCode) => ({
  revision: 2,
  datasets: [{
    id: 'overture-regions', kind: 'overture-divisions', license: 'ODbL',
    attribution: 'Overture Maps Foundation divisions, © OpenStreetMap contributors',
    layers: [{ role: 'region', subtypes: ['region'], codeField: 'region', countries: territories[countryCode] || [] }]
  }]
});
// Points beyond this distance from every first-level region polygon lie outside the country.
const NEAREST_DEGREES = 0.02;
// City states keep their own district assignments; China is anchored by its own catalog.
export const regionBoundaryCountries = new Set(['US', 'CA', 'MX', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'RU', 'TW', 'JP', 'KR', 'VN',
  'TH', 'PH', 'MY', 'SA', 'IN', 'AU', 'TR', 'BR', 'NG', 'ZA']);
// Countries whose catalog regions are exactly the first-level divisions, so the polygon region may replace a
// conflicting or unknown source region. Mixed-level catalogs (ES, FR, IT, PH, GB), Vietnam's merged provinces and
// Taiwan's Han names only use the polygons to reject points outside the country.
export const regionCorrectionCountries = new Set(['US', 'CA', 'MX', 'DE', 'NL', 'RU', 'JP', 'KR', 'TH', 'MY', 'SA', 'IN', 'AU',
  'TR', 'BR', 'NG', 'ZA']);

const pending = new Map();
export const ensureRegionBoundaries = ({ countryCode, cacheDir, pythonBin, execute = runProcess, signal }) => {
  const output = resolve(cacheDir, 'boundaries', 'regions', countryCode, `${REGION_BOUNDARY_REVISION}.parquet`);
  if (existsSync(output)) return Promise.resolve(output);
  if (!pending.has(output)) pending.set(output, (async () => {
    const configFile = `${output}.${process.pid}.json`;
    await mkdir(resolve(output, '..'), { recursive: true });
    await writeFile(configFile, JSON.stringify(regionConfig(countryCode)));
    try {
      await execute({
        file: pythonBin, signal, timeoutMs: 45 * 60_000,
        args: [resolve(syncRoot, 'admin-boundary-build.py'), '--country', countryCode, '--config-file', configFile,
          '--cache-dir', resolve(cacheDir, 'boundaries'), '--output', output, '--overture-release', 'latest']
      });
    } finally {
      await rm(configFile, { force: true });
    }
    return output;
  })().finally(() => pending.delete(output)));
  return pending.get(output);
};

export const assignRegionsToFile = async ({ countryCode, input, output, format, cacheDir, pythonBin, execute = runProcess, signal }) => {
  const boundaries = await ensureRegionBoundaries({ countryCode, cacheDir, pythonBin, execute, signal });
  await execute({
    file: pythonBin, signal, timeoutMs: 30 * 60_000,
    args: [resolve(syncRoot, 'admin-boundary-assign.py'), '--boundaries', boundaries, '--input', input, '--output', output,
      '--format', format, '--field', 'admin_region', '--nearest-degrees', String(NEAREST_DEGREES), '--mark-unassigned']
  });
  return output;
};

// Returns address id -> { name, nameEn, code } or { outside: true }.
export const regionsForPoints = async ({ countryCode, points, cacheDir, pythonBin, execute = runProcess, signal }) => {
  const directory = resolve(cacheDir, 'boundaries', 'regions', 'points');
  await mkdir(directory, { recursive: true });
  const stem = resolve(directory, `${countryCode}-${randomUUID()}`);
  try {
    await writeFile(`${stem}.in.jsonl`, points.map(({ id, latitude, longitude }) => JSON.stringify({ id, latitude, longitude })).join('\n'));
    await assignRegionsToFile({ countryCode, input: `${stem}.in.jsonl`, output: `${stem}.out.jsonl`, format: 'overture-jsonl',
      cacheDir, pythonBin, execute, signal });
    const lines = (await readFile(`${stem}.out.jsonl`, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return new Map(lines.map((line) => [line.id, line.admin_region?.region || line.admin_region || null]));
  } finally {
    await rm(`${stem}.in.jsonl`, { force: true });
    await rm(`${stem}.out.jsonl`, { force: true });
  }
};

const exact = (value) => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('und');
const codeSuffix = (code) => String(code || '').split('-').slice(1).join('-');
export const catalogRegionFor = (regions, region) => {
  const suffix = exact(codeSuffix(region?.code));
  if (!suffix) return null;
  const matches = regions.filter((candidate) => exact(candidate.code) === suffix);
  return matches.length === 1 ? matches[0] : null;
};

// The source region stays when it already names the polygon region in any known form; otherwise the polygon's
// official name replaces it. Regions without an ISO code (disputed areas) are never written.
// Thai province names drop the จังหวัด prefix, as stored addresses and the catalog do.
const regionName = (countryCode, name) => countryCode === 'TH' ? String(name || '').replace(/^จังหวัด/u, '') : name;
export const correctedRegion = (countryCode, components, rawRegion, regions) => {
  const region = rawRegion && { ...rawRegion, name: regionName(countryCode, rawRegion.name) };
  // Territory polygons only prove the point is inside the published country; they never rename its region.
  if (!regionCorrectionCountries.has(countryCode) || !String(region?.code || '').toUpperCase().startsWith(`${countryCode}-`)) return null;
  const catalog = catalogRegionFor(regions, region);
  const known = new Set([region.name, region.nameEn, region.code, codeSuffix(region.code),
    catalog?.code, catalog?.name, catalog?.native_name, catalog?.zh_name].map(exact).filter(Boolean));
  if ([components.admin1, components.admin1Code].some((value) => known.has(exact(value)))) return null;
  const latinOnly = countryCode === 'IN' && /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(region.name);
  const name = latinOnly ? region.nameEn : region.name;
  if (!name) return null;
  return {
    admin1: name, admin1Code: catalog?.code || codeSuffix(region.code),
    admin1En: region.nameEn || catalog?.name || name, admin1Zh: catalog?.zh_name || ''
  };
};
