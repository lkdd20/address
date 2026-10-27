import { describe, expect, it } from 'vitest';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';
import { postcodeRequired, retirePostcodeLessRows } from '../server/sync/postcode-requirement.mjs';

const insert = (database, id, countryCode, postcode, extra = {}) => {
  const components = { houseNumber: '1', street: 'Main Street', locality: extra.locality || 'Berkeley',
    admin1: extra.admin1 || 'California', admin1Code: extra.admin1Code ?? 'CA', postcode };
  return database.prepare(`INSERT INTO address_pool(id,country_code,admin1,admin1_code,locality,postal_locality,street,house_number,
      postcode,latitude,longitude,native_language,component_variants_json,address_variants_json,quality_score,generation,coverage,
      random_key,active,first_seen_at,last_seen_at)
    VALUES (?,?,?,?,?,?,'Main Street','1',?,?,?,'en',?,'{}',.95,'fixture','fixture',1,1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`)
    .bind(id, countryCode, components.admin1, components.admin1Code, components.locality, components.locality, postcode,
      extra.latitude ?? 37.86, extra.longitude ?? -122.25, JSON.stringify({ native: components, en: components, 'zh-CN': components }))
    .run();
};

describe('postcode requirement', () => {
  it('applies everywhere postcodes exist except China and Hong Kong', () => {
    expect(postcodeRequired('US')).toBe(true);
    expect(postcodeRequired('IT')).toBe(true);
    expect(postcodeRequired('HK')).toBe(false);
    expect(postcodeRequired('CN')).toBe(false);
  });

  it('retires published rows without a postcode once per country and drops them from the generation index', async () => {
    const database = openTestDatabase(':memory:');
    try {
      await insert(database, 'with-zip', 'US', '94704');
      await insert(database, 'without-zip', 'US', '');
      await database.prepare("UPDATE address_pool SET postcode='' WHERE id='without-zip'").run();
      await database.prepare(`INSERT INTO address_generation_index(address_id,country_code,admin1_key,admin1_code_key,locality_key,
          postal_locality_key,district_key,postcode_key,locality,postal_locality,district,postcode,street,house_number,building_name,
          search_text,random_key,country_rank,residential_rank,residential_ready,active,source_revision,updated_at)
        VALUES ('without-zip','US','california','ca','berkeley','berkeley','','','Berkeley','Berkeley','','','Main Street','1','',
          'main street',1,2,NULL,0,1,'legacy','2026-01-01T00:00:00Z')`).run();

      expect(await retirePostcodeLessRows({ database, countryCode: 'US' })).toMatchObject({ retired: 1 });
      expect(await database.prepare("SELECT active,retired_at FROM address_pool WHERE id='without-zip'").first())
        .toMatchObject({ active: 0, retired_at: expect.stringMatching(/^publication-validation:postcode-required-v2:/u) });
      expect(await database.prepare("SELECT active FROM address_pool WHERE id='with-zip'").first('active')).toBe(1);
      expect(await database.prepare("SELECT active FROM address_generation_index WHERE address_id='without-zip'").first('active')).toBe(0);

      await insert(database, 'later', 'US', '');
      expect(await retirePostcodeLessRows({ database, countryCode: 'US' })).toMatchObject({ retired: 0 });
      expect(await retirePostcodeLessRows({ database, countryCode: 'US', addressIds: ['later'] })).toMatchObject({ retired: 1 });
    } finally {
      await database.close();
    }
  });

  it('leaves Hong Kong rows without a postcode alone', async () => {
    const database = openTestDatabase(':memory:');
    try {
      await insert(database, 'hk', 'HK', '', { locality: 'Kwun Tong', admin1: 'Kowloon', admin1Code: '', latitude: 22.31, longitude: 114.22 });
      expect(await retirePostcodeLessRows({ database, countryCode: 'HK' })).toMatchObject({ retired: 0 });
      expect(await database.prepare("SELECT active FROM address_pool WHERE id='hk'").first('active')).toBe(1);
    } finally {
      await database.close();
    }
  });
});
