import { describe, expect, it } from 'vitest';
import { queryLocationCatalog, resolveCountryShortcuts, resolveLocationScope } from '../server/api/repositories/location-catalog';
import { assignRegions } from '../server/api/repositories/location-assignment';
import { nameVariants, regionSpellingKey } from '../src/domain/region-names.mjs';
import { scopeClauseValues, scopeGroupMatches } from '../server/api/repositories/address-pool-v2';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';
import type { LocationShortcut } from '../src/domain/types';

const regions = [
  { id: 1, parent_id: null, code: 'ENG', name: 'England', native_name: 'England', zh_name: '英格兰' },
  { id: 2, parent_id: 1, code: 'WSM', name: 'Westminster', native_name: 'Westminster', zh_name: '威斯敏斯特' },
  { id: 3, parent_id: 1, code: 'CMD', name: 'Camden', native_name: 'Camden', zh_name: '卡姆登' },
  { id: 4, parent_id: null, code: 'SCT', name: 'Scotland', native_name: 'Scotland', zh_name: '苏格兰' }
];

describe('location option reachability', () => {
  it('assigns admin1 spellings to their catalog region', () => {
    const korea = [{ id: 11, parent_id: null, code: '11', name: 'Seoul', native_name: '서울', zh_name: '首尔' },
      { id: 26, parent_id: null, code: '26', name: 'Busan', native_name: '부산', zh_name: '釜山' }];
    const assigned = assignRegions(korea, [{ admin1: '서울특별시', code: '' }, { admin1: '부산광역시', code: '' }, { admin1: 'unknown', code: '' }]);
    expect(assigned.get('서울특별시\u0000')).toBe(11);
    expect(assigned.get('부산광역시\u0000')).toBe(26);
    expect(assigned.has('unknown\u0000')).toBe(false);
    expect(nameVariants('Белгородская область')).toContain('белгород');
    expect(nameVariants('Thành phố Hà Nội')).toContain('hanoi');
    expect(nameVariants('National Capital Region (Metro Manila)')).toContain('metromanila');
  });

  it('keeps one option for every spelling of an unrecognized region', () => {
    expect(new Set(['Quảng Nam', 'quang nam', 'Tỉnh Quảng Nam'].map(regionSpellingKey)).size).toBe(1);
    expect(regionSpellingKey('Bình Định')).not.toBe(regionSpellingKey('Bình Dương'));
  });

  it('lists every address under one region and one city option and generates exactly what an option counts', async () => {
    const database = openTestDatabase(':memory:');
    try {
      for (const region of regions) {
        await database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
          VALUES (?,'GB',?,?,?,?,'region',?,?)`).bind(region.id, region.code, region.name, region.native_name, region.zh_name,
          region.parent_id, region.parent_id ? `/1/${region.id}/` : `/${region.id}/`).run();
      }
      await database.exec(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population)
        VALUES (10,'GB',2,'London','London','伦敦','city',9000000);`);
      const rows = [
        ['westminster', 'westminster', 'wsm', 'london', 'london', 'London', 'Strand'],
        ['camden', 'camden', 'cmd', 'london', 'london', 'London', 'Camden Road'],
        ['hamlet', 'camden', 'cmd', 'kentish town', 'london', 'Kentish Town', 'Leighton Road'],
        ['glasgow', 'glasgow city', '', 'glasgow', '', 'Glasgow', 'Argyle Street'],
        ['island', 'isle of nowhere', '', 'port nowhere', '', 'Port Nowhere', 'Harbour Road']
      ];
      for (const [index, [id, admin1, code, locality, postal, localityName, street]] of rows.entries()) {
        const variants = JSON.stringify({ native: { admin1: admin1.replace(/\b\w/gu, (letter) => letter.toUpperCase()), locality: localityName },
          en: {}, 'zh-CN': { locality: id === 'island' ? '无名港' : '' } });
        await database.prepare(`INSERT INTO address_pool(id,country_code,street,latitude,longitude,native_language,component_variants_json,
          address_variants_json,quality_score,generation,coverage,random_key,first_seen_at,last_seen_at)
          VALUES (?,'GB',?,51.5,-0.1,'en',?,'{}',.95,'fixture','fixture',?,'2026-01-01','2026-01-01')`)
          .bind(id, street, variants, index + 1).run();
        await database.prepare(`INSERT INTO address_generation_index(address_id,country_code,admin1_key,admin1_code_key,locality_key,
          postal_locality_key,locality,residential_ready,random_key,updated_at) VALUES (?,'GB',?,?,?,?,?,1,?,'2026-01-01')`)
          .bind(id, admin1, code, locality, postal, localityName, index + 1).run();
      }
      const regionPage = await queryLocationCatalog(database, { country: 'GB', field: 'region', limit: 100 });
      const cityPage = await queryLocationCatalog(database, { country: 'GB', field: 'city', limit: 100 });
      const total = (options: Array<{ availableCount?: number }>) => options.reduce((sum, option) => sum + Number(option.availableCount), 0);
      expect(total(regionPage.options)).toBe(rows.length);
      expect(total(cityPage.options)).toBe(rows.length);
      const england = regionPage.options.find((option) => option.value === 'England');
      expect(england).toMatchObject({ id: '1', availableCount: 3 });
      expect(regionPage.options.find((option) => option.value === 'Isle Of Nowhere')?.id).toMatch(/^loc-region-[0-9a-f]{20}$/u);
      const london = cityPage.options.find((option) => option.value === 'London');
      expect(london).toMatchObject({ id: '10', availableCount: 2, regionId: '1', regionValue: 'England' });
      const port = cityPage.options.find((option) => option.native === 'Port Nowhere');
      expect(port).toMatchObject({ availableCount: 1, label: 'Port Nowhere · 无名港' });
      expect(port?.id).toMatch(/^loc-city-[0-9a-f]{20}$/u);

      // The generator page sends a city together with the region the option names.
      const scope = await resolveLocationScope(database, 'GB', { region: london!.regionValue, regionId: london!.regionId, city: london!.value, cityId: london!.id });
      const clause = scopeClauseValues(scope!.scope!);
      const generated = (await database.prepare(`SELECT address_id FROM address_generation_index WHERE country_code='GB' AND active=1
        AND ${clause.sql} ORDER BY address_id`).bind(...clause.values).all<{ address_id: string }>()).results;
      expect(generated.map((row) => row.address_id)).toEqual(['camden', 'westminster']);
      expect(await resolveLocationScope(database, 'GB', { cityId: port!.id })).toMatchObject({ scope: [{ cities: ['port nowhere'] }] });
      expect(await resolveLocationScope(database, 'GB', { cityId: 'loc-city-00000000000000000000' })).toBeNull();
      expect(await resolveLocationScope(database, 'GB', { regionId: '4', cityId: '10' })).toBeNull();
      const shortcut = (type: 'region' | 'city', value: string): LocationShortcut => ({ type, value, label: { en: value, 'zh-CN': value } });
      const resolved = resolveCountryShortcuts(database, { GB: { countryCode: 'GB' as const, specialAreaTitle: { en: '', 'zh-CN': '' }, specialAreas: [],
        adminShortcuts: [shortcut('region', 'England'), shortcut('region', 'Wales')],
        popularCities: [shortcut('city', 'London'), shortcut('city', 'England'), shortcut('city', 'Paris')] } });
      expect(resolved.GB.adminShortcuts.map((item) => item.option)).toEqual([{ field: 'region', id: '1', value: 'England', regionId: undefined, regionValue: undefined }]);
      expect(resolved.GB.popularCities.map((item) => [item.value, item.option?.field, item.option?.id])).toEqual([['London', 'city', '10'], ['England', 'region', '1']]);
      expect(scopeGroupMatches({ admin1_key: 'camden', admin1_code_key: 'cmd', locality_key: '', postal_locality_key: 'london' }, scope!.scope!)).toBe(true);
    } finally {
      await database.close();
    }
  });
});
