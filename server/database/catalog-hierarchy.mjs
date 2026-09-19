const spanishProvinceParents = new Map([['O', 'AS'], ['S', 'CB'], ['LO', 'RI']]);

export const correctSpanishProvinceParents = (regions) => regions.map((region) => {
  if (region.country_code !== 'ES' || region.type !== 'province') return region;
  const parentCode = spanishProvinceParents.get(region.code ?? region.iso2);
  if (!parentCode) return region;
  const parents = regions.filter((candidate) => candidate.country_code === 'ES'
    && candidate.type === 'autonomous community' && candidate.parent_id == null
    && (candidate.code ?? candidate.iso2) === parentCode);
  if (parents.length !== 1) throw new Error(`Ambiguous or missing Spanish community: ${parentCode}`);
  return { ...region, parent_id: parents[0].id };
});

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
