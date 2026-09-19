import { addressPublicationSqlClause } from './generation-index.mjs';
import { administrativeValueSql } from './administrative-assignments.mjs';
import { Converter } from 'opencc-js/t2cn';

const toSimplified = Converter({ from: 'hk', to: 'cn' });

const normalize = (value) => String(value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/gu, '')
  .toLocaleLowerCase('und')
  .replace(/&/gu, 'and')
  .replace(/[^\p{L}\p{N}]+/gu, '')
  .trim();

const aliases = (country, values, expanded = true) => [...new Set(values.flatMap((value) => {
  const name = String(value || '').normalize('NFKC').trim();
  const variants = /\p{Script=Han}/u.test(name) ? [name, toSimplified(name)] : [name];
  return variants.flatMap((variant) => {
    if (!expanded) return [normalize(variant)];
    let stem = variant.replace(/^city of\s+/iu, '').replace(/\s+(?:city|province|prefecture|region|state|county)$/iu, '');
    if (['JP', 'TW', 'HK', 'CN'].includes(country)) stem = stem.replace(/(?:自治区|特别行政区|省|市|縣|县|区|區|都|道|府|県|町|村|鄉|乡|鎮|镇)$/u, '');
    if (country === 'KR') stem = stem.replace(/(?:특별자치시|특별자치도|특별시|광역시|도|시|군|구)$/u, '');
    if (country === 'SA') stem = stem.replace(/^(?:منطقة|المنطقة)\s+/u, '');
    if (country === 'VN') stem = stem.replace(/^(?:thành phố|tỉnh)\s+/iu, '');
    return [normalize(variant), normalize(stem)];
  }).filter(Boolean);
}))];

const addAlias = (map, key, value) => {
  if (!key) return;
  const values = map.get(key) || [];
  if (!values.some((item) => item.id === value.id)) values.push(value);
  map.set(key, values);
};

const regionRelated = (left, right) => {
  if (!left || !right) return false;
  if (left.id === right.id) return true;
  if (!left.path || !right.path) return false;
  const leftPath = `${left.path.replace(/\/+$/u, '')}/`;
  const rightPath = `${right.path.replace(/\/+$/u, '')}/`;
  return leftPath.startsWith(rightPath) || rightPath.startsWith(leftPath);
};

const matchedNames = (value, country, indexes, scope = () => true) => {
  for (const [map, expanded] of [[indexes.exact, false], [indexes.expanded, true]]) {
    const candidates = aliases(country, [value], expanded).flatMap((key) => map.get(key) || []).filter(scope);
    const unique = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
    if (unique.length) return unique.length === 1 ? unique[0] : null;
  }
  return null;
};

const chooseRegion = (row, country, byCode, byName) => {
  const code = normalize(row.admin1_code);
  if (code && byCode.has(code)) return byCode.get(code).length === 1 ? byCode.get(code)[0] : null;
  const codes = byCode.get(normalize(row.admin1));
  if (codes) return codes.length === 1 ? codes[0] : null;
  return matchedNames(row.admin1, country, byName);
};

const chooseCity = (row, country, region, cityAliases, regionsById) => {
  if (!region && (normalize(row.admin1) || normalize(row.admin1_code))) return null;
  return matchedNames(row.city_name, country, cityAliases,
    (candidate) => !region || regionRelated(region, regionsById.get(Number(candidate.region_id))));
};

export const refreshResidentialCoverage = async (
  database, countryCode, now = new Date().toISOString(), signal,
  { useGenerationIndex = false, inTransaction = false } = {}
) => {
  const checkpoint = () => signal?.throwIfAborted();
  checkpoint();
  if (!inTransaction) return database.transaction(async (transaction) => {
    await transaction.exec("SET LOCAL lock_timeout TO '250ms'");
    await transaction.exec(`LOCK TABLE address_pool,address_pool_evidence,address_datasets,address_sources,
      address_generation_index,admin_coverage_stats,residential_coverage,sync_country_state
      IN SHARE ROW EXCLUSIVE MODE`);
    return refreshResidentialCoverage(transaction, countryCode, now, signal, { useGenerationIndex, inTransaction: true });
  });
  const country = String(countryCode || '').trim().toUpperCase();
  const cityColumn = (alias) => {
    const locality = alias === 'address' ? administrativeValueSql('locality', alias) : `${alias}.locality`;
    return ['HK', 'SG'].includes(country) ? `COALESCE(NULLIF(${locality},''),${alias}.postal_locality)`
      : `COALESCE(NULLIF(${alias}.postal_locality,''),${locality})`;
  };
  const admin1 = administrativeValueSql('admin1', 'address');
  const admin1Code = administrativeValueSql('admin1_code', 'address');
  const groupsQuery = useGenerationIndex ? `SELECT generation.admin1_key AS admin1,generation.admin1_code_key AS admin1_code,
        ${cityColumn('generation')} AS city_name,COUNT(*) AS address_count,
        SUM(generation.residential_ready) AS residential_count
      FROM address_generation_index generation
      JOIN address_pool address ON address.id=generation.address_id AND address.active=1
      WHERE generation.country_code=? AND generation.active=1
      GROUP BY generation.admin1_key,generation.admin1_code_key,${cityColumn('generation')}` : `SELECT ${admin1} AS admin1,${admin1Code} AS admin1_code,
        ${cityColumn('address')} AS city_name,COUNT(*) AS address_count,
        SUM(CASE WHEN address.property_type IN ('residential','apartment')
          AND address.residential_evidence=1 THEN 1 ELSE 0 END) AS residential_count
      FROM address_pool_runtime address
      WHERE address.country_code=? AND address.active=1
        AND ${addressPublicationSqlClause('address.')}
      GROUP BY ${admin1},${admin1Code},${cityColumn('address')}`;
  const [regionsResult, citiesResult, groupsResult] = await Promise.all([
    database.prepare(`SELECT id,parent_id,code,name,native_name,zh_name,type,path FROM catalog_regions
      WHERE country_code=?`).bind(country).all(),
    database.prepare(`SELECT id,region_id,name,native_name,zh_name FROM catalog_cities
      WHERE country_code=?`).bind(country).all(),
    database.prepare(groupsQuery)
      .bind(country).all()
  ]);
  checkpoint();
  const regions = regionsResult.results || [];
  const cities = citiesResult.results || [];
  const groups = groupsResult.results || [];
  if (!regions.length) return {
    countryCode: country, groups: groups.length, mappedGroups: 0, matchedAddresses: 0,
    unmatchedAddresses: groups.reduce((total, row) => total + Number(row.address_count || 0), 0), skipped: true
  };
  const regionsById = new Map(regions.map((region) => [Number(region.id), region]));
  const regionsByCode = new Map();
  const regionsByName = { exact: new Map(), expanded: new Map() };
  for (const region of regions) {
    checkpoint();
    addAlias(regionsByCode, normalize(region.code), region);
    const names = [region.name, region.native_name, region.zh_name];
    if (country === 'TW') {
      const suffix = region.type === 'county' ? '縣' : ['city', 'special municipality'].includes(region.type) ? '市' : '';
      if (suffix) names.push(...names.filter((name) => /\p{Script=Han}/u.test(name || ''))
        .map((name) => name.replace(/(?:縣|县|市)$/u, '') + suffix));
    }
    for (const key of aliases(country, names, false)) addAlias(regionsByName.exact, key, region);
    for (const key of aliases(country, names)) addAlias(regionsByName.expanded, key, region);
  }
  const cityAliases = { exact: new Map(), expanded: new Map() };
  for (const city of cities) {
    checkpoint();
    const names = [city.name, city.native_name, city.zh_name];
    for (const key of aliases(country, names, false)) addAlias(cityAliases.exact, key, city);
    for (const key of aliases(country, names)) addAlias(cityAliases.expanded, key, city);
  }

  const coverage = new Map();
  let matchedAddresses = 0;
  const totalCount = groups.reduce((total, row) => total + Number(row.address_count || 0), 0);
  const residentialCount = groups.reduce((total, row) => total + Number(row.residential_count || 0), 0);
  for (const row of groups) {
    checkpoint();
    let region = chooseRegion(row, country, regionsByCode, regionsByName);
    const city = chooseCity(row, country, region, cityAliases, regionsById);
    if (city?.region_id) region = regionsById.get(Number(city.region_id)) || region;
    if (!region) continue;
    const regionName = String(region.name);
    const cityName = city ? String(city.name) : '';
    const key = JSON.stringify([Number(region.id), city ? Number(city.id) : null]);
    const count = Number(row.address_count || 0);
    matchedAddresses += count;
    const current = coverage.get(key);
    if (current) {
      current.totalCount += count;
      current.addressCount += Number(row.residential_count || 0);
    }
    else coverage.set(key, {
      country, regionName, cityName, identityKey: key,
      totalCount: count, addressCount: Number(row.residential_count || 0),
      regionId: Number(region.id), cityId: city ? Number(city.id) : null
    });
  }

  const writeCoverage = async (transaction) => {
    checkpoint();
    await transaction.prepare('DELETE FROM residential_coverage WHERE country_code=?').bind(country).run();
    const rows = [...coverage.values()];
    for (let offset = 0; offset < rows.length; offset += 500) {
      checkpoint();
      await transaction.batch(rows.slice(offset, offset + 500).map((row) => transaction.prepare(`
        INSERT INTO residential_coverage(
          country_code,region_name,city_name,address_count,last_verified_at,region_id,city_id,total_count,identity_key
        ) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
        row.country, row.regionName, row.cityName, row.addressCount, now, row.regionId, row.cityId,row.totalCount,row.identityKey
      )));
    }
    await transaction.prepare(`UPDATE admin_coverage_stats SET residential_count=?,ordinary_count=?,
      total_count=?,updated_at=? WHERE node_key=? AND level=0`)
      .bind(residentialCount, totalCount-residentialCount, totalCount, now, country).run();
    checkpoint();
  };
  await writeCoverage(database);
  return {
    countryCode: country,
    groups: groups.length,
    mappedGroups: coverage.size,
    matchedAddresses,
    unmatchedAddresses: totalCount - matchedAddresses
  };
};

export const refreshIndexedResidentialCoverage = async (database, now = new Date().toISOString()) => {
  const countries = (await database.prepare(`SELECT country_code FROM (
    SELECT country_code FROM sync_country_policies WHERE enabled=1
    UNION SELECT country_code FROM address_generation_index
    UNION SELECT country_code FROM residential_coverage
  ) countries WHERE country_code<>'CN' ORDER BY country_code`).all()).results;
  for (const { country_code: countryCode } of countries) {
    await refreshResidentialCoverage(database, countryCode, now, undefined, { useGenerationIndex: true });
  }
  return countries.map((row) => row.country_code);
};
