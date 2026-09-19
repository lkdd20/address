import { describe, expect, it } from 'vitest';
import { catalogHierarchyPaths, correctSpanishProvinceParents } from '../server/database/catalog-hierarchy.mjs';

describe('catalog hierarchy integrity', () => {
  const province = { id: 1, country_code: 'ES', code: 'O', name: 'Fixture province', type: 'province', parent_id: 1 };
  const community = { id: 2, country_code: 'ES', code: 'AS', name: 'Fixture community', type: 'autonomous community', parent_id: null };

  it.each([['O', 'AS'], ['S', 'CB'], ['LO', 'RI']])('repairs %s using its unique %s community, not a name or fixed ID', (code, parentCode) => {
    const regions = [{ ...province, code }, { ...community, code: parentCode }];
    const corrected = correctSpanishProvinceParents(regions);
    expect(corrected[0]).toEqual({ ...regions[0], parent_id: 2 });
    expect(regions[0].parent_id).toBe(1);
    expect(catalogHierarchyPaths(corrected)).toEqual(new Map([[2, '/2/'], [1, '/2/1/']]));
    expect(correctSpanishProvinceParents(corrected)).toEqual(corrected);
  });

  it('accepts the upstream iso2 field and preserves unrelated countries and identities', () => {
    const unrelated = { id: 3, country_code: 'US', code: 'O', type: 'province', parent_id: null };
    const corrected = correctSpanishProvinceParents([
      { ...province, code: undefined, iso2: 'O' }, { ...community, code: undefined, iso2: 'AS' }, unrelated
    ]);
    expect(corrected[0].parent_id).toBe(2);
    expect(corrected[2]).toBe(unrelated);
  });

  it('refuses a missing or ambiguous community rather than guessing or dropping the province', () => {
    expect(() => correctSpanishProvinceParents([province])).toThrow('missing Spanish community');
    expect(() => correctSpanishProvinceParents([province, community, { ...community, id: 3 }])).toThrow('Ambiguous');
    expect(() => correctSpanishProvinceParents([province, { ...community, country_code: 'US' }])).toThrow('missing');
    expect(() => correctSpanishProvinceParents([province, { ...community, type: 'province' }])).toThrow('missing');
  });

  it('builds canonical paths independent of input order and any obsolete stored path', () => {
    expect(catalogHierarchyPaths([
      { ...province, id: 3, parent_id: 1, path: '/obsolete/' },
      { ...province, parent_id: 2 }, community
    ])).toEqual(new Map([[2, '/2/'], [1, '/2/1/'], [3, '/2/1/3/']]));
  });

  it('rejects self and multi-node cycles instead of silently returning truncated paths', () => {
    expect(() => catalogHierarchyPaths([province])).toThrow('Cyclic');
    expect(() => catalogHierarchyPaths([{ ...province, parent_id: 2 }, { ...community, parent_id: 1 }])).toThrow('Cyclic');
  });

  it('rejects missing, cross-country and duplicate identities', () => {
    expect(() => catalogHierarchyPaths([{ ...province, parent_id: 42 }])).toThrow('Invalid catalog parent');
    expect(() => catalogHierarchyPaths([{ ...province, parent_id: 2 }, { ...community, country_code: 'US' }])).toThrow('Invalid catalog parent');
    expect(() => catalogHierarchyPaths([community, community])).toThrow('Duplicate catalog region identity');
  });
});
