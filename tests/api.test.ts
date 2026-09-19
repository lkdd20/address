import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeneratedBundle, LocationOption } from '../src/domain/types';
import app from '../server/api/index';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';
import { eligibleAddresses } from './fixtures/catalog';

const overpassMock = (country: string, city: string, index = 1) => JSON.stringify({ elements: [{
  type: 'way', id: Number(`${country.charCodeAt(0)}${country.charCodeAt(1)}${index}`),
  center: { lat: 34 + index / 100, lon: -118 - index / 100 },
  tags: {
    'addr:housenumber': String(100 + index), 'addr:street': `Dynamic Street ${index}`,
    'addr:city': city, 'addr:state': 'Dynamic Region', 'addr:postcode': `9000${index}`,
    building: 'apartments'
  }
}] });
const mockBindings = { ALLOWED_ORIGIN: '*', GOOGLE_TRANSLATION_ENABLED: false } as const;

afterEach(() => vi.unstubAllGlobals());

describe('synchronized address registry', () => {
  it('handles preflight requests for every configured origin and rejects unlisted origins', async () => {
    const bindings = { ALLOWED_ORIGINS: 'https://address.daimonna.com, https://address.333186.xyz' };
    for (const origin of ['https://address.daimonna.com', 'https://address.333186.xyz']) {
      const response = await app.request('/api/v1/generate', {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type'
        }
      }, bindings);
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe(origin);
      expect(response.headers.get('access-control-allow-methods')).toContain('POST');
      expect(response.headers.get('vary')).toContain('Origin');
    }
    const rejected = await app.request('/api/v1/generate', {
      method: 'OPTIONS', headers: { Origin: 'https://attacker.example' }
    }, bindings);
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('reports countries that still require a synchronized snapshot', async () => {
    const response = await app.request('/api/v1/countries', {}, { ALLOWED_ORIGIN: '*' });
    const payload = await response.json() as { data: Array<{ code: string; addressCount: null; generationMode: string }> };
    expect(response.status).toBe(200);
    expect(payload.data).toHaveLength(27);
    expect(payload.data.every((country) => country.addressCount === null && country.generationMode === 'sync-required')).toBe(true);
  });

  it('reports v2 address and residential coverage from ADDRESS_DB', async () => {
    const statements: string[] = [];
    const addressDb = {
      prepare: (sql: string) => {
        statements.push(sql);
        const statement = {
          bind: () => statement,
          all: async () => ({ results: [{ country_code: 'US', total: 10, residential: 8 }] }),
          first: async () => 12
        };
        return statement;
      }
    };
    const response = await app.request('/api/v1/countries', {}, { ALLOWED_ORIGIN: '*', ADDRESS_DB: addressDb });
    const payload = await response.json() as { data: Array<{ code: string; addressCount: number; residentialCount: number; residentialAvailable: boolean; generationMode: string }> };
    expect(payload.data.find(({ code }) => code === 'US')).toMatchObject({
      addressCount: 10, residentialCount: 8, residentialAvailable: true, generationMode: 'synchronized-pool'
    });
    expect(payload.data.find(({ code }) => code === 'CN')).toMatchObject({
      addressCount: 12, residentialCount: 12, residentialAvailable: true, generationMode: 'synchronized-pool'
    });
    expect(statements.some((sql) => sql.includes('FROM sync_country_state'))).toBe(true);
    expect(statements.some((sql) => sql.includes('FROM address_generation_index'))).toBe(true);
    expect(statements.some((sql) => sql.includes('cn_communities_v2'))).toBe(true);
    expect(statements.every((sql) => !sql.includes('address_pool_runtime'))).toBe(true);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('returns a database failure instead of an empty country list', async () => {
    const failure = Object.assign(new Error('database connection lost'), { code: 'ECONNRESET' });
    const response = await app.request('/api/v1/countries', {}, {
      ALLOWED_ORIGIN: '*', ADDRESS_DB: { prepare: () => { throw failure; } }
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'DATABASE_UNAVAILABLE' } });
  });

  it('marks residential mode available when the evidence-backed pool is non-empty', async () => {
    const addressDb = {
      prepare: () => {
        const statement = {
          bind: () => statement,
          all: async () => ({ results: [{ country_code: 'US', total: 5000, residential: 250 }] })
        };
        return statement;
      }
    };
    const response = await app.request('/api/v1/countries', {}, { ALLOWED_ORIGIN: '*', ADDRESS_DB: addressDb });
    const payload = await response.json() as { data: Array<{ code: string; residentialAvailable: boolean }> };
    expect(payload.data.find(({ code }) => code === 'US')).toMatchObject({ residentialAvailable: true });
  });

  it('reads v2 counts from the synchronized country summary', async () => {
    const statements: string[] = [];
    const addressDb = {
      prepare: (sql: string) => {
        statements.push(sql);
        const statement = {
          bind: () => statement,
          all: async () => ({ results: [{ country_code: 'US', total: 7, residential: 3 }] })
        };
        return statement;
      }
    };
    const response = await app.request('/api/v1/countries', {}, { ALLOWED_ORIGIN: '*', ADDRESS_DB: addressDb });
    const payload = await response.json() as { data: Array<{ code: string; addressCount: number; residentialCount: number }> };

    expect(payload.data.find(({ code }) => code === 'US')).toMatchObject({ addressCount: 7, residentialCount: 3 });
    expect(statements.some((sql) => sql.includes('FROM sync_country_state'))).toBe(true);
    expect(statements.some((sql) => sql.includes('FROM address_generation_index'))).toBe(true);
    expect(statements.some((sql) => sql.includes('cn_communities_v2'))).toBe(true);
  });

  it('serves lightweight availability from precomputed state', async () => {
    const statements: string[] = [];
    const addressDb = {
      prepare: (sql: string) => {
        statements.push(sql);
        return {
          first: async () => 2,
          all: async () => ({ results: [
            { country_code: 'US', total: 8, residential: 8 }, { country_code: 'SA', total: 0, residential: 0 }
          ] })
        };
      }
    };
    const response = await app.request('/api/v1/availability', {}, { ALLOWED_ORIGIN: '*', ADDRESS_DB: addressDb });
    expect(await response.json()).toEqual({ data: [
      { code: 'CN', available: true, residentialAvailable: true }, { code: 'US', available: true, residentialAvailable: true }
    ] });
    expect(statements.some((sql) => sql.includes('sync_country_state'))).toBe(true);
    expect(statements.join(' ')).not.toContain('address_datasets');
    expect(statements.some((sql) => sql.includes('cn_communities_v2'))).toBe(true);
    expect(statements.every((sql) => !sql.includes('address_pool_runtime'))).toBe(true);
    expect(response.headers.get('Cache-Control')).toContain('max-age=30');
  });

  it('lists hierarchy children and reports the three synchronization rules', async () => {
    const database = openTestDatabase(':memory:');
    const now = new Date().toISOString();
    try {
      await database.batch([
        database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
          VALUES (901,'US','CA','California','California','加利福尼亚州','state',NULL,'/901')`),
        database.prepare(`INSERT INTO sync_country_policies(
          country_code,enabled,target_count,level1_limit,level2_limit,level3_limit,level4_limit,min_per_node,coverage_ratio,level1_min,level2_min,updated_at
        ) VALUES ('US',1,10,10,10,10,10,2,1,2,0,?)`).bind(now),
        database.prepare(`INSERT INTO admin_coverage_stats(
          node_key,parent_key,country_code,level,region_code,region_name,residential_count,total_count,child_count,updated_at
        ) VALUES ('US','','US',0,'US','United States',5,5,1,?)`).bind(now),
        database.prepare(`INSERT INTO admin_coverage_stats(
          node_key,parent_key,country_code,level,region_code,region_name,residential_count,total_count,child_count,updated_at
        ) VALUES ('US:1:CA','US','US',1,'CA','California',1,1,0,?)`).bind(now)
      ]);
      await database.exec(`INSERT INTO address_pool(id,country_code,street,latitude,longitude,native_language,
        component_variants_json,address_variants_json,quality_score,generation,coverage,random_key,first_seen_at,last_seen_at)
        VALUES ('hierarchy-fixture','US','Fixture Road',37,-122,'en','{}','{}',.95,'fixture','fixture',1,'2026-01-01','2026-01-01');
        INSERT INTO address_generation_index(address_id,country_code,admin1_key,admin1_code_key,residential_ready,random_key,updated_at)
        VALUES ('hierarchy-fixture','US','california','ca',1,1,'2026-01-01');`);
      const hierarchy = await app.request('/api/v1/locations/hierarchy?country=US&parentType=country&childType=region', {}, {
        ALLOWED_ORIGIN: '*', LOCATION_DB: database
      });
      const hierarchyPayload = await hierarchy.json() as { data: { children: LocationOption[] } };
      expect(hierarchy.status).toBe(200);
      expect(hierarchyPayload.data.children).toContainEqual(expect.objectContaining({ id: '901', value: 'California' }));

      const coverage = await app.request('/api/v1/coverage?country=US', {}, { ALLOWED_ORIGIN: '*', ADDRESS_DB: database });
      const coveragePayload = await coverage.json() as { data: { countries: Array<{ unmetRules: string[]; rules: Record<string, unknown> }> } };
      expect(coverage.status).toBe(200);
      expect(coveragePayload.data.countries[0].unmetRules).toEqual(['total', 'administrative_coverage', 'regional_minimums']);
      expect(coveragePayload.data.countries[0].rules).toHaveProperty('total');
      expect(coveragePayload.data.countries[0].rules).toHaveProperty('administrativeCoverage');
      expect(coveragePayload.data.countries[0].rules).toHaveProperty('regionalMinimums');
    } finally {
      database.close();
    }
  });

  it('returns not found for an address ID outside the published synchronized pool', async () => {
    const response = await app.request('/api/v1/addresses/pool-v2-missing', {}, { ALLOWED_ORIGIN: '*' });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'ADDRESS_NOT_FOUND' } });
  });

  it('returns a typed database error when a China address lookup fails', async () => {
    const failure = Object.assign(new Error('database connection lost'), { code: 'ECONNRESET' });
    const response = await app.request('/api/v1/addresses/cn-community-1', {}, {
      ALLOWED_ORIGIN: '*', ADDRESS_DB: { prepare: () => { throw failure; } }
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'DATABASE_UNAVAILABLE' } });
  });

  it('counts each publishable residential runtime address once and rejects stale or invalid records', async () => {
    const database = openTestDatabase(':memory:');
    const observedAt = '2026-07-01T00:00:00Z';
    try {
      await database.prepare(`INSERT INTO address_sources VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        'fixture-source', 'Fixture source', 'https://example.test', 'https://example.test/data', 'fixture', 'Fixture',
        'https://example.test/license', 'Fixture attribution', 'https://example.test/attribution',
        'https://example.test/terms', 0, 0, 1, '{}', observedAt, observedAt
      ).run();
      for (const [id, version, checksum] of [['dataset-a', '1', 'a'.repeat(64)]]) {
        await database.prepare(`INSERT INTO address_datasets(
          id,source_id,country_code,version,published_at,retrieved_at,imported_at,input_checksum,format,
          license_code,license_name,license_url,attribution_text,attribution_url,terms_url,
          share_alike,notice_required,redistribution_allowed,status
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
          id, 'fixture-source', 'US', version, observedAt, observedAt, observedAt, checksum, 'fixture',
          'fixture', 'Fixture', 'https://example.test/license', 'Fixture attribution',
          'https://example.test/attribution', 'https://example.test/terms', 0, 0, 1, 'active'
        ).run();
      }
      const insertAddress = async (id: string, expiresAt: string | null, residentialEvidence: boolean) => {
        const components = { houseNumber: '10', street: 'Market Street', locality: 'Philadelphia', admin1: 'Pennsylvania', admin1Code: 'PA', postcode: '19103' };
        await database.prepare(`INSERT INTO address_pool(
          id,country_code,admin1,admin1_code,locality,postal_locality,postcode,street,house_number,
          latitude,longitude,native_language,component_variants_json,address_variants_json,
          property_type,quality_score,generation,coverage,random_key,first_seen_at,last_seen_at,expires_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
          id, 'US', 'Pennsylvania', 'PA', 'Philadelphia', 'Philadelphia', '19103', 'Market Street', '10',
          39.95, -75.16, 'en', JSON.stringify({ native: components, en: components, 'zh-CN': components }),
          JSON.stringify({ native: '10 Market Street, Philadelphia, PA 19103', en: '10 Market Street, Philadelphia, PA 19103', 'zh-CN': '美国宾夕法尼亚州费城市场街10号' }),
          'residential', 0.95, 'fixture', 'US:PA:Philadelphia', 1, observedAt, observedAt, expiresAt
        ).run();
        await database.prepare('INSERT INTO address_pool_evidence VALUES (?,?,?,?,?,?,?,?,?,?)').bind(
          `${id}-dataset-a-address`, id, 'dataset-a', `${id}-record`, '', observedAt, 'address_existence', 1, 1, observedAt
        ).run();
        if (residentialEvidence) {
          await database.prepare('INSERT INTO address_pool_evidence VALUES (?,?,?,?,?,?,?,?,?,?)').bind(
            `${id}-residential`, id, 'dataset-a', `${id}-building`, '', observedAt, 'residential_use', 0, 1, observedAt
          ).run();
        }
      };
      await insertAddress('valid', '2099-01-01T00:00:00Z', true);
      await insertAddress('expired', '2000-01-01T00:00:00Z', true);
      await insertAddress('invalid-date', 'not-a-date', true);
      await insertAddress('no-residential-evidence', null, false);

      expect((await database.prepare(`SELECT id,residential_evidence FROM address_pool_runtime
        ORDER BY id`).all()).results).toEqual([
        { id: 'expired', residential_evidence: 1 },
        { id: 'invalid-date', residential_evidence: 1 },
        { id: 'no-residential-evidence', residential_evidence: 0 },
        { id: 'valid', residential_evidence: 1 }
      ]);
      expect(await database.prepare(`SELECT id FROM address_pool_runtime WHERE id='valid'
        AND expires_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
        AND expires_at::timestamptz > ?::timestamptz`).bind(new Date().toISOString()).first('id')).toBe('valid');
      await database.prepare(`INSERT INTO sync_country_state(country_code,status,address_count,residential_count,updated_at)
        VALUES ('US','ready',1,1,?) ON CONFLICT(country_code) DO UPDATE SET
        status='ready',address_count=1,residential_count=1,updated_at=excluded.updated_at`).bind(observedAt).run();
      const response = await app.request('/api/v1/countries', {}, { ALLOWED_ORIGIN: '*', ADDRESS_DB: database });
      const payload = await response.json() as { data: Array<{ code: string; addressCount: number; residentialCount: number }> };
      expect(payload.data.find(({ code }) => code === 'US')).toMatchObject({ addressCount: 1, residentialCount: 1 });
    } finally {
      database.close();
    }
  });

  it('does not advertise legacy residential coverage when the active pool has none', async () => {
    const legacyDb = {
      prepare: (sql: string) => {
        const statement = {
          bind: () => statement,
          all: async () => ({ results: sql.includes('residential_coverage')
            ? [{ country_code: 'US', total: 13 }]
            : [{ country_code: 'US', total: 50 }] })
        };
        return statement;
      }
    };
    const addressDb = {
      prepare: () => {
        const statement = {
          bind: () => statement,
          all: async () => ({ results: [{ country_code: 'US', total: 10, residential: 0 }] })
        };
        return statement;
      }
    };
    const response = await app.request('/api/v1/countries', {}, {
      ALLOWED_ORIGIN: '*', LOCATION_DB: legacyDb, ADDRESS_DB: addressDb
    });
    const payload = await response.json() as { data: Array<{ code: string; addressCount: number; residentialCount: number; residentialAvailable: boolean }> };
    expect(payload.data.find(({ code }) => code === 'US')).toMatchObject({
      addressCount: 10, residentialCount: 0, residentialAvailable: false, available: true
    });
  });

  it('falls back to the published generation index when the count projection is missing', async () => {
    const database = openTestDatabase(':memory:');
    try {
      await database.prepare(`INSERT INTO address_pool(
        id,country_code,street,latitude,longitude,native_language,component_variants_json,address_variants_json,
        quality_score,generation,coverage,random_key,first_seen_at,last_seen_at
      ) VALUES ('indexed-only','GB','High Street',51.5,-0.1,'en','{}','{}',.95,'fixture','fixture',1,?,?)`)
        .bind('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z').run();
      await database.prepare(`INSERT INTO address_generation_index(address_id,country_code,random_key,updated_at)
        VALUES ('indexed-only','GB',1,?)`).bind('2026-01-01T00:00:00Z').run();
      const availability = await app.request('/api/v1/availability', {}, { ALLOWED_ORIGIN: '*', ADDRESS_DB: database });
      expect(await availability.json()).toEqual({ data: [{ code: 'GB', available: true, residentialAvailable: false }] });
      const countries = await app.request('/api/v1/countries', {}, { ALLOWED_ORIGIN: '*', ADDRESS_DB: database });
      const payload = await countries.json() as { data: Array<{ code: string; addressCount: number }> };
      expect(payload.data.find(({ code }) => code === 'GB')).toMatchObject({ addressCount: 1 });
    } finally {
      await database.close();
    }
  });

  it('returns configured region and city discovery options without reading address snapshots', async () => {
    const regions = await app.request('/api/v1/locations/search?country=US&field=region', {}, { ALLOWED_ORIGIN: '*' });
    const regionPayload = await regions.json() as { data: { regions: LocationOption[] } };
    const cities = await app.request('/api/v1/locations/search?country=US&field=city', {}, { ALLOWED_ORIGIN: '*' });
    const cityPayload = await cities.json() as { data: { cities: LocationOption[] } };
    expect(regionPayload.data.regions).toContainEqual(expect.objectContaining({
      value: 'California', label: 'California（CA）加利福尼亚州', en: 'California', zhCN: '加利福尼亚州'
    }));
    expect(cityPayload.data.cities.map((item) => item.value)).toContain('Los Angeles');
    expect(cityPayload.data.cities.map((item) => item.value)).toContain('Chicago');
  });
});

describe('pool-only and IP address generation', () => {
  it.each([
    ['mode', 'nearby'], ['strategy', 'fast'], ['q', 'x'.repeat(301)],
    ['region', 'x'.repeat(301)], ['cityId', 'x'.repeat(161)],
    ['seed', 'x'.repeat(301)], ['requestId', 'x'.repeat(161)]
  ])('rejects invalid or oversized GET generation input: %s', async (name, value) => {
    const response = await app.request(`/api/v1/generate?country=US&${name}=${encodeURIComponent(value)}`, {}, mockBindings);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_GENERATION_REQUEST' } });
  });

  it('generates a filtered GB London address instead of returning a generic failure', async () => {
    const address = eligibleAddresses('GB', false, new Date('2026-01-01T00:00:00Z'))[0];
    const pick = vi.fn(async ({ countryCode, filters }: { countryCode: string; filters: { city?: string } }) => {
      expect(countryCode).toBe('GB');
      expect(filters.city).toBe('London');
      return { ready: true as const, result: { address, source: 'address-pool-v2' as const, eligibleCount: 1 } };
    });
    const response = await app.request('/api/v1/generate?country=GB&city=London&seed=gb-london-api&requestId=gb-london-api', {}, {
      ...mockBindings, RANDOM_ADDRESS_SERVICE: { pick }
    });
    const payload = await response.json() as { data?: { result?: GeneratedBundle }; error?: { code?: string } };
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.data?.result?.address.countryCode).toBe('GB');
    expect(payload.data?.result?.address.components.locality).toBe('London');
  });

  it('uses the unified database selector before legacy country-specific queries', async () => {
    const address = eligibleAddresses('US', true, new Date('2026-01-01T00:00:00Z'))[0];
    const pick = vi.fn(async () => ({
      ready: true as const,
      result: { address, source: 'address-pool-v2' as const, eligibleCount: 12_345 }
    }));
    const response = await app.request(
      '/api/v1/generate?country=US&residential=true&seed=database-seed&requestId=database-request',
      {},
      { ...mockBindings, RANDOM_ADDRESS_SERVICE: { pick } }
    );
    const payload = await response.json() as {
      data: { eligibleCount: number; sourcesTried: string[]; result: GeneratedBundle }
    };

    expect(response.status).toBe(200);
    expect(pick).toHaveBeenCalledWith(expect.objectContaining({ countryCode: 'US', seed: 'database-seed' }));
    expect(payload.data.eligibleCount).toBe(12_345);
    expect(payload.data.sourcesTried).toEqual(['address-pool-v2']);
    expect(payload.data.result.address.id).toBe(address.id);
  });

  it('batch-generates unique database records with structured filters', async () => {
    const base = eligibleAddresses('US', true, new Date('2026-01-01T00:00:00Z'))[0];
    const pick = vi.fn(async ({ seed }: { seed: string }) => ({
      ready: true as const,
      result: { address: { ...base, id: `pool-v2-${seed}` }, source: 'address-pool-v2' as const, eligibleCount: 10_000 }
    }));
    const response = await app.request('/api/v1/generate/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        count: 3,
        filters: { country: 'US', region: 'California', q: 'Street' },
        options: { unique: true, seed: 'batch-seed', strategy: 'instant', requestId: 'batch-request' },
        excludeAddressIds: []
      })
    }, { ...mockBindings, RANDOM_ADDRESS_SERVICE: { pick } });
    const payload = await response.json() as { data: { requestedCount: number; returnedCount: number; unique: boolean; exhausted: boolean; results: GeneratedBundle[] } };
    expect(response.status).toBe(200);
    expect(payload.data).toMatchObject({ requestedCount: 3, returnedCount: 3, unique: true, exhausted: false });
    expect(new Set(payload.data.results.map((result) => result.address.id)).size).toBe(3);
    expect(pick).toHaveBeenCalledWith(expect.objectContaining({
      countryCode: 'US', filters: expect.objectContaining({ region: 'California', q: 'Street' })
    }));
  });

  it('gives batch generation its own concurrency budget', async () => {
    const base = eligibleAddresses('US', true, new Date('2026-07-16T00:00:00Z'))[0];
    const pick = vi.fn(async ({ seed }: { seed: string }) => ({
      ready: true as const,
      result: { address: { ...base, id: `pool-v2-${seed}` }, source: 'address-pool-v2' as const, eligibleCount: 10_000 }
    }));
    let interactiveHeld = 0;
    let batchHeld = 0;
    const interactive = {
      tryAcquire: () => { interactiveHeld += 1; return true; },
      release: () => { interactiveHeld = Math.max(0, interactiveHeld - 1); }
    };
    const batch = {
      tryAcquire: () => { batchHeld += 1; return batchHeld <= 6; },
      release: () => { batchHeld = Math.max(0, batchHeld - 1); }
    };
    const response = await app.request('/api/v1/generate/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 5, filters: { country: 'US' }, options: { unique: true, seed: 'slot-fairness' } })
    }, {
      ...mockBindings,
      GENERATION_SLOT: interactive,
      BATCH_GENERATION_SLOT: batch,
      RANDOM_ADDRESS_SERVICE: { pick }
    });
    const payload = await response.json() as { data?: { returnedCount?: number }; error?: { code?: string } };
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.data?.returnedCount).toBe(5);
    expect(interactiveHeld).toBe(0);
    expect(batchHeld).toBe(0);
  });

  it('does not return a partial success when a later batch generation fails', async () => {
    const base = eligibleAddresses('US', true, new Date('2026-01-01T00:00:00Z'))[0];
    let calls = 0;
    const pick = vi.fn(async ({ seed }: { seed: string }) => {
      calls += 1;
      if (calls > 4) throw Object.assign(new Error('database connection lost'), { code: 'ECONNRESET' });
      return {
        ready: true as const,
        result: { address: { ...base, id: `pool-v2-${seed}` }, source: 'address-pool-v2' as const, eligibleCount: 10_000 }
      };
    });
    const response = await app.request('/api/v1/generate/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 5, filters: { country: 'US' }, options: { unique: true, seed: 'partial-failure-seed' } })
    }, { ...mockBindings, RANDOM_ADDRESS_SERVICE: { pick } });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'DATABASE_UNAVAILABLE' } });
  });

  it('stops a batch request when the client aborts while generations are in flight', async () => {
    const base = eligibleAddresses('US', false, new Date('2026-01-01T00:00:00Z'))[0];
    const controller = new AbortController();
    const waiters: Array<() => void> = [];
    let started = 0;
    let releaseStarted!: () => void;
    const allStarted = new Promise<void>((resolve) => { releaseStarted = resolve; });
    const pick = vi.fn(async () => {
      started += 1;
      if (started === 4) releaseStarted();
      await new Promise<void>((resolve) => waiters.push(resolve));
      return { ready: true as const, result: { address: base, source: 'address-pool-v2' as const, eligibleCount: 1 } };
    });
    const request = app.request('/api/v1/generate/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ count: 3, filters: { country: 'US' }, options: { seed: 'abort-seed' } })
    }, { ...mockBindings, RANDOM_ADDRESS_SERVICE: { pick } });
    await allStarted;
    controller.abort();
    const response = await request;
    expect(response.status).toBe(499);
    expect(started).toBe(4);
    waiters.forEach((resolve) => resolve());
  });

  it.each(['57P01', '53300', '57014'] as const)('maps transient database error %s to service unavailable', async (code) => {
    const pick = vi.fn(async () => { throw Object.assign(new Error('database unavailable'), { code }); });
    const response = await app.request('/api/v1/generate?country=US', {}, {
      ...mockBindings, RANDOM_ADDRESS_SERVICE: { pick }
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'DATABASE_UNAVAILABLE' } });
  });

  it('returns a typed busy response when batch generation has no global slot', async () => {
    const response = await app.request('/api/v1/generate/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 1, filters: { country: 'US' } })
    }, {
      ...mockBindings,
      GENERATION_SLOT: { tryAcquire: () => false, release: vi.fn() }
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'GENERATION_BUSY' } });
  });

  it('rejects batch sizes above the public limit', async () => {
    const response = await app.request('/api/v1/generate/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 51, filters: { country: 'US' } })
    }, mockBindings);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'INVALID_BATCH_REQUEST' } });
  });

  it('does not enter an online provider when a regular synchronized pool misses', async () => {
    const response = await app.request('/api/v1/generate?country=US&residential=false&city=Chicago', {}, {
      ...mockBindings, OVERPASS_MOCK: overpassMock('US', 'Chicago')
    });
    const payload = await response.json() as { error: { code: string } };
    expect(response.status).toBe(404);
    expect(payload.error.code).toBe('NO_POOL_COVERAGE');
  });

  it('serves catalog alternate-name shortcuts through the published pool', async () => {
    const base = eligibleAddresses('ES', false, new Date('2026-01-01T00:00:00Z'))[0];
    const pick = vi.fn(async ({ filters }: { filters: { city?: string } }) => ({
      ready: true as const,
      result: {
        address: { ...base, id: `pool-v2-${filters.city}`, components: { ...base.components, locality: filters.city } },
        source: 'address-pool-v2' as const,
        eligibleCount: 1
      }
    }));
    const response = await app.request('/api/v1/generate?country=ES&residential=false&city=Val%C3%A8ncia&requestId=alias-city', {}, {
      ...mockBindings,
      ADDRESS_DB: { prepare: () => ({ bind() { return this; }, all: async () => ({ results: [] }), first: async () => null }) },
      RANDOM_ADDRESS_SERVICE: { pick }
    });
    const payload = await response.json() as { data?: { result?: GeneratedBundle }; error?: { code?: string } };
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.data?.result?.address.components.locality).toBe('València');
  });

  it('relaxes a catalog region that blocks an otherwise published city', async () => {
    const base = eligibleAddresses('US', true, new Date('2026-07-16T00:00:00Z'))[0];
    const pick = vi.fn(async ({ filters }: { filters: { region?: string; city?: string } }) => {
      if (filters.region) return { ready: true as const };
      return {
        ready: true as const,
        result: {
          address: { ...base, id: 'pool-v2-region-fallback', components: { ...base.components, locality: filters.city || '', admin1: 'Texas' } },
          source: 'address-pool-v2' as const,
          eligibleCount: 1
        }
      };
    });
    const response = await app.request('/api/v1/generate?country=US&residential=false&region=Rh%C3%B4ne&city=Dallas&requestId=region-fallback', {}, {
      ...mockBindings,
      ADDRESS_DB: { prepare: () => ({ bind() { return this; }, all: async () => ({ results: [] }), first: async () => null }) },
      RANDOM_ADDRESS_SERVICE: { pick }
    });
    expect(pick).toHaveBeenCalledWith(expect.objectContaining({
      filters: expect.objectContaining({ region: 'Rhône', city: 'Dallas' })
    }));
    const payload = await response.json() as {
      data?: { filterMatchLevel?: string; filters?: { region?: string; city?: string }; result?: GeneratedBundle };
      error?: { code?: string };
    };
    expect(response.status, JSON.stringify(payload)).toBe(404);
    expect(payload.error?.code).toBe('NO_POOL_COVERAGE');
  });

  it('does not query a live address provider for an explicit IP-region request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      country_code: 'US', region: 'Dynamic Region', city: 'Chicago',
      latitude: 41.8781, longitude: -87.6298
    })));
    const response = await app.request('/api/v1/generate?mode=ip-region&ip=8.8.8.8&residential=true&live=true&requestId=res-1', {}, {
      ...mockBindings, OVERPASS_MOCK: overpassMock('US', 'Chicago')
    });
    const payload = await response.json() as { error: { code: string } };
    expect(response.status).toBe(404);
    expect(payload.error.code).toBe('IP_REGION_NO_RESULT');
  });

  it('returns prelocalized v2 rows without entering the localization network path', async () => {
    const components = { houseNumber: '4-27-7', street: '永福四丁目', locality: '杉並区', admin1: '東京都', admin1Code: '13', postcode: '168-0064' };
    const row = {
      id: 'jp-hot', country_code: 'JP', admin1: '東京都', admin1_code: '13', locality: '杉並区', postal_locality: '杉並区',
      district: '永福', postcode: '168-0064', street: '永福四丁目', house_number: '4-27-7', building_name: '', latitude: 35.676,
      longitude: 139.642, native_language: 'ja', property_type: 'residential', generation: 'test', quality_score: 0.95,
      first_seen_at: '2026-07-15T00:00:00Z', expires_at: '2027-07-15T00:00:00Z',
      component_variants_json: JSON.stringify({
        native: { ...components, postalLocality: '杉並区', district: '永福' },
        en: { ...components, street: 'Eifuku', locality: 'Suginami', postalLocality: 'Suginami', district: 'Eifuku', admin1: 'Tokyo' },
        'zh-CN': { ...components, street: '永福', locality: '杉并区', postalLocality: '杉并区', district: '永福', admin1: '东京都' }
      }),
      address_variants_json: JSON.stringify({ native: '東京都杉並区永福四丁目4-27-7', en: '4-27-7 Eifuku, Suginami, Tokyo 168-0064', 'zh-CN': '东京都杉并区永福四丁目4-27-7' }),
      source_id: 'fixture', source_name: 'Fixture', source_url: 'https://example.test', source_record_id: 'jp-hot',
      observed_at: '2026-07-15T00:00:00Z', evidence_type: 'address_existence', dataset_id: 'fixture-v2', dataset_version: 'test',
      source_updated_at: '2026-07-15T00:00:00Z', imported_at: '2026-07-16T00:00:00Z', residential_evidence: 1
    };
    const addressDb = {
      prepare: (sql: string) => {
        const statement = {
          bind: () => statement,
          all: async () => ({ results: sql.startsWith('SELECT id FROM address_pool')
            ? sql.includes('random_key >=') ? [{ id: row.id }] : []
            : sql.includes('FROM address_pool_runtime') ? [row] : [] })
        };
        return statement;
      }
    };
    const response = await app.request('/api/v1/generate?country=JP&strategy=instant&seed=hot&requestId=hot', {}, {
      ...mockBindings, ADDRESS_DB: addressDb
    });
    const payload = await response.json() as { data: { sourcesTried: string[]; result: GeneratedBundle } };
    expect(payload.data.sourcesTried).toEqual(['address-pool-v2']);
    expect(payload.data.result.address.addressVariants.en).toContain('Eifuku');
    expect(response.headers.get('Server-Timing')).toMatch(/localize;dur=0\.0/);
  });

  it('returns a dedicated coverage error instead of a generic provider timeout', async () => {
    const response = await app.request('/api/v1/generate?country=US&city=Chicago', {}, {
      ...mockBindings, OVERPASS_MOCK: JSON.stringify({ elements: [] })
    });
    const payload = await response.json() as { error: { code: string } };
    expect(response.status).toBe(404);
    expect(payload.error.code).toBe('NO_POOL_COVERAGE');
  });
});
