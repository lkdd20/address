import type { CatalogRegion } from './address-repository';
import { poolLocationAliases } from './address-pool-v2';
import { variantRegionIndex } from '../../../src/domain/region-names.mjs';

// One distinct (admin1, admin1Code) key pair of a country's published addresses.
export interface AdminPair { admin1: string; code: string }

export const pairKey = (admin1: string, code: string): string => `${admin1}\u0000${code}`;

const add = (map: Map<string, Set<number>>, key: string, root: number) => {
  if (!key) return;
  const roots = map.get(key) || new Set<number>();
  roots.add(root);
  map.set(key, roots);
};
const only = (roots: Set<number> | undefined): number | undefined => roots?.size === 1 ? [...roots][0] : undefined;

// The first-level catalog region of every admin1 pair. Generation matches admin1 keys against catalog aliases, so an
// alias match decides first (the admin1 text before its code); then folded names and names without administrative
// words. City names do not decide: towns share names across regions (San Juan in Puerto Rico and Texas). Pairs left
// out name no catalog region. `canonical` folds regions that form one option (alike in every name) together.
export const assignRegions = (regions: CatalogRegion[], pairs: AdminPair[], canonical = (root: number) => root): Map<string, number> => {
  const byId = new Map(regions.map((region) => [Number(region.id), region]));
  const rootOf = (id: number): number => {
    let current = byId.get(Number(id));
    for (let depth = 0; current?.parent_id != null && byId.has(Number(current.parent_id)) && depth < 8; depth += 1) {
      current = byId.get(Number(current.parent_id));
    }
    return Number(current?.id ?? id);
  };
  const aliasRoots = new Map<string, Set<number>>();
  for (const region of regions) {
    const root = canonical(rootOf(region.id));
    for (const alias of poolLocationAliases([region.name, region.native_name, region.zh_name, region.code])) add(aliasRoots, alias, root);
  }
  const byName = variantRegionIndex(regions, (region) => canonical(rootOf(region.id)));
  const assigned = new Map<string, number>();
  for (const pair of pairs) {
    const text = aliasRoots.get(pair.admin1);
    const code = aliasRoots.get(pair.code);
    const narrowed = text && code ? new Set([...text].filter((root) => code.has(root))) : undefined;
    const root = only(text) ?? only(narrowed) ?? (text?.size ? undefined : only(code))
      ?? byName(pair.admin1);
    if (root !== undefined) assigned.set(pairKey(pair.admin1, pair.code), root);
  }
  return assigned;
};
