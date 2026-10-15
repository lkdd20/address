// Checks that every servable address can be reached through the location dropdowns, that each option's count is what
// generation for that option can return, that each field's counts add up to the country total, and that postcode
// options cover every address with a postcode, nationally and within each region. Region and city
// options are replayed with the exact parameters the generator page sends (a city choice also sends that city's
// region). Any unreachable address, count mismatch or total difference fails.
// Run inside the production API or sync container:
// `address-entrypoint node node_modules/tsx/dist/cli.mjs scripts/audit-location-reachability.ts`.
import { writeFile } from 'node:fs/promises';
import { createPostgresPool, PostgresDatabase } from '../server/database/postgres.mjs';
import { queryLocationCatalog, resolveLocationScope, type CatalogField } from '../server/api/repositories/location-catalog';
import { resolveCatalogTarget, type AddressFilters, type CatalogTarget } from '../server/api/repositories/address-repository';
import { poolLocationAliases, scopeGroupMatches } from '../server/api/repositories/address-pool-v2';
import type { CountryCode, LocationOption } from '../src/domain/types';
import type { Database } from '../server/database/database.mjs';
import { countryByCode } from '../src/domain/countries';

interface Group { admin1_key: string; admin1_code_key: string; locality_key: string; postal_locality_key: string; address_count: number; with_postcode: number }
interface Finding { option: string; id?: string; shown: number; reachable: number }

const clean = (value: unknown) => String(value ?? '').trim();
const database = new PostgresDatabase(createPostgresPool({ environment: process.env })) as unknown as Database;
const requested = clean(process.env.AUDIT_COUNTRIES).toUpperCase().split(',').map(clean).filter(Boolean);
const countries = (requested.length ? requested : ((await database.prepare(
  'SELECT country_code FROM sync_country_policies WHERE enabled=1 ORDER BY country_code').all<{ country_code: string }>()).results || [])
  .map((row) => row.country_code)).filter((country) => country !== 'CN') as CountryCode[];

const optionsOf = async (country: CountryCode, field: CatalogField, residential: boolean): Promise<LocationOption[]> => {
  const options: LocationOption[] = [];
  for (let cursor: string | undefined; ;) {
    const page = await queryLocationCatalog(database, { country, field, residential, cursor, limit: 200 });
    options.push(...page.options);
    if (!page.nextCursor || !page.options.length) return options;
    cursor = page.nextCursor;
  }
};

// Mirrors pickAddressPoolV2Address: region names are matched against admin1 keys, city names against locality keys.
const reachable = (groups: Group[], filters: AddressFilters, target: CatalogTarget | undefined): Set<number> => {
  if (target?.scope) return new Set(groups.flatMap((group, index) => scopeGroupMatches(group, target.scope!) ? [index] : []));
  const regionNames = new Set(poolLocationAliases([filters.region, target?.region, target?.regionNative, target?.regionCode,
    ...target?.regionAliases || []]));
  const cityNames = new Set(poolLocationAliases([filters.city, target?.city, target?.cityNative, ...target?.cityAliases || []]));
  const byRegion = Boolean(filters.region || target?.region) && regionNames.size > 0;
  const byCity = Boolean(filters.city || target?.city) && cityNames.size > 0;
  const matched = new Set<number>();
  groups.forEach((group, index) => {
    if (byRegion && !regionNames.has(group.admin1_key) && !regionNames.has(group.admin1_code_key)) return;
    if (byCity && !cityNames.has(group.locality_key) && !cityNames.has(group.postal_locality_key)) return;
    matched.add(index);
  });
  return matched;
};

const report: Record<string, unknown> = {};
let failed = false;
for (const country of countries) {
  const residential = false;
  const groups = ((await database.prepare(`SELECT admin1_key,admin1_code_key,locality_key,postal_locality_key,COUNT(*) AS address_count,
      SUM(CASE WHEN postcode_key<>'' THEN 1 ELSE 0 END) AS with_postcode FROM address_generation_index WHERE country_code=? AND active=1
    GROUP BY admin1_key,admin1_code_key,locality_key,postal_locality_key`).bind(country).all<Group>()).results || [])
    .map((group) => ({ ...group, address_count: Number(group.address_count), with_postcode: Number(group.with_postcode) }));
  const total = groups.reduce((sum, group) => sum + group.address_count, 0);
  const countOf = (indexes: Iterable<number>) => [...indexes].reduce((sum, index) => sum + groups[index].address_count, 0);
  const result: Record<string, unknown> = { total };
  const filterFields = countryByCode.get(country)?.addressSchema.filters || [];
  for (const field of (['region', 'city'] as const).filter((name) => filterFields.includes(name))) {
    const covered = new Set<number>();
    const mismatches: Finding[] = [];
    let shownSum = 0;
    for (const option of await optionsOf(country, field, residential)) {
      const filters: AddressFilters = field === 'region' ? { region: option.value, regionId: option.id }
        : { region: option.regionValue, regionId: option.regionId, city: option.value, cityId: option.id };
      // The generate endpoint resolves the option scope first and falls back to the catalog only for unknown names.
      const scoped = await resolveLocationScope(database, country, filters);
      const target = scoped === undefined ? await resolveCatalogTarget(database, country, filters, 'reachability-audit') : scoped || undefined;
      let matched = target ? reachable(groups, filters, target) : new Set<number>();
      // The generate endpoint retries a city without its region when the region excludes it.
      if (!matched.size && field === 'city' && target && !target.scope) {
        matched = reachable(groups, { city: filters.city, cityId: filters.cityId }, { ...target, region: undefined, regionId: undefined, regionAliases: [] });
      }
      for (const index of matched) covered.add(index);
      const count = countOf(matched);
      shownSum += Number(option.availableCount || 0);
      if (count !== Number(option.availableCount || 0)) mismatches.push({ option: option.value, id: option.id, shown: Number(option.availableCount || 0), reachable: count });
    }
    const uncovered = groups.map((group, index) => ({ group, index })).filter(({ index }) => !covered.has(index))
      .sort((left, right) => right.group.address_count - left.group.address_count);
    const unreachable = uncovered.reduce((sum, { group }) => sum + group.address_count, 0);
    if (unreachable || mismatches.length || shownSum !== total) failed = true;
    result[field] = {
      reachable: total - unreachable, unreachable, shownSum, mismatchedOptions: mismatches.length,
      mismatches: mismatches.sort((left, right) => Math.abs(right.reachable - right.shown) - Math.abs(left.reachable - left.shown)).slice(0, 8),
      unreachableExamples: uncovered.slice(0, 8).map(({ group }) => group)
    };
  }
  // Postcode options cover every address with a postcode, nationally and within each region option.
  if (filterFields.includes('postcode')) {
    const postcodeSum = async (scope: { regionId?: string }) => {
      let sum = 0;
      for (let cursor: string | undefined; ;) {
        const page = await queryLocationCatalog(database, { country, field: 'postcode', residential, cursor, limit: 200, ...scope });
        sum += page.options.reduce((value, option) => value + Number(option.availableCount || 0), 0);
        if (!page.nextCursor || !page.options.length) return sum;
        cursor = page.nextCursor;
      }
    };
    const withPostcode = groups.reduce((sum, group) => sum + group.with_postcode, 0);
    const mismatches: Finding[] = [];
    const national = await postcodeSum({});
    if (national !== withPostcode) mismatches.push({ option: '(country)', shown: national, reachable: withPostcode });
    if (filterFields.includes('region')) for (const option of await optionsOf(country, 'region', residential)) {
      const scoped = await resolveLocationScope(database, country, { region: option.value, regionId: option.id });
      const expected = groups.filter((group) => scoped?.scope && scopeGroupMatches(group, scoped.scope)).reduce((sum, group) => sum + group.with_postcode, 0);
      const shown = await postcodeSum({ regionId: option.id });
      if (shown !== expected) mismatches.push({ option: option.value, id: option.id, shown, reachable: expected });
    }
    if (mismatches.length) failed = true;
    result.postcode = { withPostcode, mismatchedOptions: mismatches.length, mismatches: mismatches.slice(0, 8) };
  }
  report[country] = result;
  const summary = (field: string) => {
    const value = result[field] as { unreachable?: number; mismatchedOptions: number; shownSum?: number } | undefined;
    if (!value) return '';
    return field === 'postcode' ? ` postcode mismatched=${value.mismatchedOptions}`
      : ` ${field} unreachable=${value.unreachable} mismatched=${value.mismatchedOptions} shownSum=${value.shownSum}`;
  };
  console.log(`${country} total=${total}${summary('region')}${summary('city')}${summary('postcode')}`);
}
if (process.env.AUDIT_OUTPUT) await writeFile(process.env.AUDIT_OUTPUT, JSON.stringify(report, null, 2));
await (database as unknown as { close: () => Promise<void> }).close();
console.log(failed ? 'location reachability: FAILED' : 'location reachability: passed');
process.exitCode = failed ? 1 : 0;
// A background snapshot rebuild started during the audit must not keep the process alive.
setTimeout(() => process.exit(process.exitCode), 1000).unref();
