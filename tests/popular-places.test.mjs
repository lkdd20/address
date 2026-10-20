import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildLocalityWeights, LOCALITY_BASELINE, POPULAR_CITY_LIMIT } from '../server/sync/popular-places.mjs';

const fakeDatabase = (regions, cities) => ({
  prepare: (sql) => ({
    bind: () => ({ all: async () => ({ results: sql.includes('FROM catalog_regions') ? regions : cities }) })
  })
});

describe('popular places', () => {
  it('marks curated and most populous cities popular, keyed by their first-level region', async () => {
    const regions = [
      { id: 1, code: 'TX', name: 'Texas', native_name: 'Texas', path: '/1/' },
      { id: 2, code: 'AR', name: 'Arkansas', native_name: 'Arkansas', path: '/2/' },
      { id: 3, code: 'HAR', name: 'Harris County', native_name: 'Harris County', path: '/1/3/' },
      { id: 4, code: 'OR', name: 'Oregon', native_name: 'Oregon', path: '/4/' },
      { id: 5, code: 'ME', name: 'Maine', native_name: 'Maine', path: '/5/' }
    ];
    const cities = [
      { name: 'Houston', native_name: 'Houston', zh_name: '休斯敦', type: 'city', population: 2_300_000, region_id: 3, latitude: 29.76, longitude: -95.37 },
      { name: 'Houston', native_name: 'Houston', zh_name: '', type: 'city', population: 150, region_id: 2 },
      { name: 'Portland', native_name: 'Portland', zh_name: '', type: 'city', population: 650_000, region_id: 4 },
      { name: 'Portland', native_name: 'Portland', zh_name: '', type: 'city', population: 68_000, region_id: 5 },
      { name: 'Harris County', native_name: 'Harris County', zh_name: '', type: 'adm2', population: 4_700_000, region_id: 1 }
    ];
    const weights = await buildLocalityWeights(fakeDatabase(regions, cities), 'US');
    expect(weights).toMatchObject({ baseline: LOCALITY_BASELINE, cityLimit: POPULAR_CITY_LIMIT });
    const [texasHouston, arkansasHouston, oregonPortland, mainePortland, county] = weights.places;
    expect(texasHouston).toMatchObject({ admin1: expect.arrayContaining(['tx', 'texas', 'har']), locality: ['houston'], popular: true, dominant: true,
      latitude: 29.76, longitude: -95.37 });
    expect(texasHouston.radiusKm).toBeCloseTo(23.98, 1);
    expect(arkansasHouston.radiusKm).toBeUndefined();
    expect(arkansasHouston).toMatchObject({ admin1: ['ar', 'arkansas'], popular: false, dominant: false });
    expect(oregonPortland).toMatchObject({ popular: true, dominant: false });
    expect(mainePortland).toMatchObject({ popular: false, dominant: false });
    expect(county.popular).toBe(false);
  });

  it('keeps the ETL modules importable by plain-Node scripts such as the pool audit', () => {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e',
      "await import('./server/sync/administrative-names-repair.mjs'); console.log('loaded');"], { encoding: 'utf8' });
    expect(output.trim()).toBe('loaded');
  });
});
