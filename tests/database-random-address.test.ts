import { describe, expect, it } from 'vitest';
import {
  loadRandomAddressIndexRows, loadRandomAddressVersionToken
} from '../server/api/services/database-random-address';
import type { CountryCode } from '../src/domain/types';

describe('database random address index loader', () => {
  it('uses the same derived administrative labels as the SQL generation index', async () => {
    const native = { admin1: '九龍', admin1Code: 'KLN', locality: '觀塘區' };
    const en = { admin1: 'Kowloon', admin1Code: 'KLN', locality: 'Kwun Tong' };
    const row = { id: 'fixture', country_code: 'HK', admin1: 'Hong Kong', admin1_code: '', locality: 'Kwun Tong',
      administrative_patch_json: JSON.stringify({ native, en, 'zh-CN': native }) };
    const database = { prepare: () => ({ bind() { return this; }, all: async () => ({ results: [row] }) }) };
    expect((await loadRandomAddressIndexRows(database as never, ['HK']))[0].regionValues).toEqual(['Kowloon', 'KLN']);
    const revisions = { prepare: () => ({ first: async () => ({ address_version: 'source', administrative_version: 'admin-v2' }) }) };
    expect(await loadRandomAddressVersionToken(revisions as never)).toBe('source:::admin-v2');
  });
  it('loads complete address pools in country-scoped queries', async () => {
    const calls: Array<{ sql: string; country?: string }> = [];
    const database = {
      prepare(sql: string) {
        const call = { sql, country: undefined as string | undefined };
        calls.push(call);
        return {
          bind(country: string) {
            call.country = country;
            return this;
          },
          async all() {
            if (sql.includes('cn_communities_v2')) return { results: [] };
            return { results: [{
              id: `${call.country}-1`, country_code: call.country as CountryCode,
              admin1: 'Region', admin1_code: '', locality: 'City', postal_locality: 'City',
              district: 'District', postcode: '10000', street: 'Main Street',
              house_number: '1', building_name: ''
            }] };
          }
        };
      }
    };

    const rows = await loadRandomAddressIndexRows(database as never, ['US', 'JP', 'CN'], 2);

    expect(calls.filter(({ sql }) => sql.includes('address_pool_runtime'))).toHaveLength(2);
    expect(calls.filter(({ sql }) => sql.includes('address_pool_runtime')).map(({ country }) => country).sort())
      .toEqual(['JP', 'US']);
    expect(calls.filter(({ sql }) => sql.includes('address_pool_runtime'))
      .every(({ sql }) => /WHERE country_code=\?/u.test(sql))).toBe(true);
    expect(calls.filter(({ sql }) => sql.includes('address_pool_runtime'))
      .every(({ sql }) => sql.includes("component_variants_json::jsonb -> 'zh-CN'"))).toBe(true);
    expect(rows.map(({ addressId }) => addressId).sort()).toEqual(['JP-1', 'US-1']);
  });

  it('tracks source and bucketed translation revisions independently', async () => {
    let sql = '';
    const database = {
      prepare(value: string) {
        sql = value;
        return {
          async first() {
            return {
              address_version: 'source-v1', china_version: 'china-v2', translation_version: '2026-08-16T17:00:00.000Z'
            };
          }
        };
      }
    };

    await expect(loadRandomAddressVersionToken(database as never))
      .resolves.toBe('source-v1:china-v2:2026-08-16T17:00:00.000Z');
    expect(sql).toContain("FROM address_pool_revisions WHERE kind='translation'");
  });
});
