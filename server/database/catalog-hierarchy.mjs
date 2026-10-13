import cityRegions from './catalog-city-regions.json' with { type: 'json' };

// Upstream parents that contradict the official first-level boundaries, checked against the polygons containing each
// region's cities: Spanish single-province communities and Badajoz, Haute-Saône, the Tuscan provinces (filed under
// Udine) and London (filed under Scotland). Paris, the Métropole de Lyon and the Collectivité européenne d'Alsace are
// department-level collectivities that upstream files as regions.
const regionParents = {
  ES: { O: 'AS', S: 'CB', LO: 'RI', BA: 'EX' },
  FR: { 70: 'BFC', '75C': 'IDF', '69M': 'ARA', '6AE': 'GES' },
  IT: Object.fromEntries(['PI', 'PT', 'PO', 'SI', 'LI', 'LU', 'MS', 'GR'].map((code) => [code, '52'])),
  GB: { LND: 'ENG' }
};

export const correctRegionParents = (regions) => regions.map((region) => {
  const parentCode = regionParents[region.country_code]?.[region.code ?? region.iso2];
  if (!parentCode) return region;
  const parents = regions.filter((candidate) => candidate.country_code === region.country_code
    && candidate.parent_id == null && (candidate.code ?? candidate.iso2) === parentCode);
  if (parents.length !== 1) throw new Error(`Ambiguous or missing parent region: ${region.country_code}-${parentCode}`);
  return { ...region, parent_id: parents[0].id };
});

// Reviewed city regions (scripts/verify-catalog-city-regions.mjs): city id -> catalog region code, by country.
export const catalogCityRegions = Object.fromEntries(Object.entries(cityRegions)
  .map(([countryCode, { cities }]) => [countryCode, new Map(Object.entries(cities).map(([id, code]) => [Number(id), code]))]));

export const catalogHierarchyPaths = (regions) => {
  const byId = new Map(regions.map((region) => [Number(region.id), region]));
  if (byId.size !== regions.length) throw new Error('Duplicate catalog region identity');
  const paths = new Map();
  const visiting = new Set();
  const visit = (region) => {
    const id = Number(region.id);
    if (paths.has(id)) return paths.get(id);
    if (visiting.has(id)) throw new Error(`Cyclic catalog hierarchy: ${id}`);
    visiting.add(id);
    let prefix = '/';
    if (region.parent_id != null) {
      const parent = byId.get(Number(region.parent_id));
      if (!parent || parent.country_code !== region.country_code) throw new Error(`Invalid catalog parent: ${id}`);
      prefix = visit(parent);
    }
    const path = `${prefix}${id}/`;
    visiting.delete(id);
    paths.set(id, path);
    return path;
  };
  regions.forEach(visit);
  return paths;
};
