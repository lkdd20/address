import { describe, expect, it, vi } from 'vitest';
import app from '../server/api/index';
import { initializeTestDatabase, openTestDatabase } from './helpers/postgres-test-database.mjs';
import { translateAddressComponents } from '../server/api/services/address-translation';
import { eligibleAddresses } from './fixtures/catalog';

const now = new Date('2026-07-20T00:00:00.000Z');
const BOUNDARY = '[[[ADDRESS_COMPONENT_BOUNDARY]]]';
const googleFetcher = (translate: (value: string) => string): typeof fetch => (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  const values = (url.searchParams.get('q') || '').split(`\n${BOUNDARY}\n`);
  return new Response(JSON.stringify([[[values.map(translate).join(`\n${BOUNDARY}\n`), '']]]));
}) as typeof fetch;
const failingFetcher = (async () => { throw new Error('network unavailable'); }) as unknown as typeof fetch;
const youdaoFetcher = (translate: (value: string) => string): typeof fetch => (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const values = (init?.body as URLSearchParams).getAll('q');
  return new Response(JSON.stringify({ errorCode: '0', translateResults: values.map((value) => ({ translation: translate(value) })) }));
}) as typeof fetch;
const routedFetcher = (google: typeof fetch, youdao: typeof fetch): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) =>
  String(input).includes('googleapis') ? google(input, init) : youdao(input, init)) as typeof fetch;

const gb = eligibleAddresses('GB', false, now)[0];
const jp = eligibleAddresses('JP', false, now)[0];
// JP fixtures carry katakana building names; strip them so only the field
// under test drives the localization verdict.
const cleanJp = {
  ...jp,
  componentVariants: {
    ...jp.componentVariants,
    'zh-CN': { ...jp.componentVariants['zh-CN'], buildingName: undefined }
  }
};
const kanaAddress = {
  ...cleanJp,
  componentVariants: {
    ...cleanJp.componentVariants,
    'zh-CN': { ...cleanJp.componentVariants['zh-CN'], street: 'さくらどおり' }
  }
};

describe('address translation service', () => {
  it.each([['2-chome', 'translated'], ['999-chome', 'fallback']])('checks the actual value of a translated CJK ordinal: %s', async (translated, status) => {
    const address = { ...jp, componentVariants: { ...jp.componentVariants,
      en: { houseNumber: '1', street: '二丁目', locality: 'Tokyo', postcode: '100-0001' } } };
    expect((await translateAddressComponents(address, 'de', {},
      googleFetcher((value) => value === '二丁目' ? translated : value))).status).toBe(status);
  });

  it.each([['street', 'Rue 99'], ['admin1Code', 'WRONG']])('rejects a cached translation with a changed %s identifier', async (field, value) => {
    const db = openTestDatabase(':memory:');
    await initializeTestDatabase(db);
    try {
      const address = { ...gb, componentVariants: { ...gb.componentVariants,
        en: { ...gb.componentVariants.en, street: 'Main Street 21' } } };
      const first = await translateAddressComponents(address, 'fr', { LOCATION_DB: db },
        googleFetcher((text) => text === 'Main Street 21' ? 'Rue 21' : text));
      expect(first.status).toBe('translated');
      if (first.status !== 'translated') return;
      await db.prepare('UPDATE translation_cache SET value=?').bind(JSON.stringify({ provider: 'fixture',
        components: { ...first.components, [field]: value } })).run();
      expect((await translateAddressComponents(address, 'fr', {
        LOCATION_DB: db, GOOGLE_TRANSLATION_ENABLED: 'false'
      }, failingFetcher)).status).toBe('unavailable');
    } finally { await db.close(); }
  });

  it('uses DeepL before Youdao and Google, with validation before fallback', async () => {
    const calls: string[] = [];
    const deepl = vi.fn(async (values: string[]) => { calls.push('deepl'); return values; });
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('googleapis')) {
        calls.push('google');
        return googleFetcher((value) => value === 'さくらどおり' ? '樱花大道' : value)(input, init);
      }
      calls.push('youdao');
      return youdaoFetcher((value) => value)(input, init);
    }) as typeof fetch;
    const bindings = { DEEPL_TRANSLATE: deepl, YOUDAO_APP_KEY: 'key', YOUDAO_APP_SECRET: 'secret' };
    expect((await translateAddressComponents(kanaAddress, 'zh-CN', bindings, fetcher)).status).toBe('translated');
    expect(calls).toEqual(['deepl', 'youdao', 'google']);
    calls.length = 0;
    deepl.mockImplementationOnce(async (values) => { calls.push('deepl'); return values.map((value) => value === 'さくらどおり' ? '樱花大道' : value); });
    expect((await translateAddressComponents(kanaAddress, 'zh-CN', bindings, fetcher)).status).toBe('translated');
    expect(calls).toEqual(['deepl']);
  });

  it('uses OpenAI-compatible translation after DeepL and before paid or keyless fallbacks', async () => {
    const openAI = vi.fn(async (values: string[]) => values.map((value) => value === 'さくらどおり' ? '樱花大道' : value));
    const result = await translateAddressComponents(kanaAddress, 'zh-CN', {
      OPENAI_COMPATIBLE_TRANSLATE: openAI,
      YOUDAO_APP_KEY: 'unused-key', YOUDAO_APP_SECRET: 'unused-secret'
    }, failingFetcher);
    expect(result.status).toBe('translated');
    expect(openAI).toHaveBeenCalledOnce();
    if (result.status !== 'translated') return;
    expect(result.components.street).toBe('樱花大道');
  });

  it('translates semantic components, preserves identifiers and localizes the country line', async () => {
    const result = await translateAddressComponents(gb, 'ja', {}, googleFetcher((value) => `訳:${value}`));
    expect(result.status).toBe('translated');
    if (result.status !== 'translated') return;
    const source = gb.componentVariants.en;
    expect(result.components.street).toBe(`訳:${source.street}`);
    expect(result.components.locality).toBe(`訳:${source.locality}`);
    expect(result.components.houseNumber).toBe(source.houseNumber);
    expect(result.components.postcode).toBe(source.postcode);
    expect(result.lines.at(-1)).toBe('イギリス');
    expect(result.singleLine.endsWith('イギリス')).toBe(true);
    expect(result.lines.join('\n')).toContain(`${source.houseNumber} 訳:${source.street}`);
  });

  it('returns the native components for a same-language target without calling the provider', async () => {
    const de = eligibleAddresses('DE', false, now)[0];
    const result = await translateAddressComponents(de, 'de', {}, failingFetcher);
    expect(result.status).toBe('translated');
    if (result.status !== 'translated') return;
    expect(result.components).toBe(de.componentVariants.native);
    expect(result.lines.join('\n')).toContain(de.componentVariants.native.street);
  });

  it('rejects a translation that drops or changes digits and falls back completely', async () => {
    const jp = eligibleAddresses('JP', false, now).find((address) => /\d/u.test(address.componentVariants.en.street));
    expect(jp).toBeDefined();
    const result = await translateAddressComponents(jp!, 'de', {}, googleFetcher((value) =>
      value.replace(/\d+/gu, '').trim() || 'X'));
    expect(result).toEqual({ status: 'fallback' });
  });

  it('falls back completely when the provider batch is incomplete', async () => {
    const incomplete = (async () => new Response(JSON.stringify([[['only one', '']]]))) as unknown as typeof fetch;
    await expect(translateAddressComponents(gb, 'fr', {}, incomplete)).resolves.toEqual({ status: 'fallback' });
  });

  it('falls back completely when the provider errors', async () => {
    await expect(translateAddressComponents(gb, 'es', {}, failingFetcher)).resolves.toEqual({ status: 'fallback' });
  });

  it('reports unavailable when no translation provider is configured', async () => {
    await expect(translateAddressComponents(gb, 'ko', { GOOGLE_TRANSLATION_ENABLED: 'false' }, failingFetcher))
      .resolves.toEqual({ status: 'unavailable' });
  });

  it('serves repeat requests from translation_cache without calling the provider', async () => {
    const db = openTestDatabase(':memory:');
    await initializeTestDatabase(db);
    try {
      const bindings = { LOCATION_DB: db };
      const first = await translateAddressComponents(gb, 'ja', bindings, googleFetcher((value) => `訳:${value}`));
      expect(first.status).toBe('translated');
      await expect(translateAddressComponents(gb, 'ja', bindings, failingFetcher)).resolves.toEqual(first);
    } finally {
      db.close();
    }
  });

  it('converts the simplified Chinese variant for zh-TW without a provider', async () => {
    const address = {
      ...gb,
      componentVariants: {
        ...gb.componentVariants,
        'zh-CN': { ...gb.componentVariants['zh-CN'], street: '复兴门内大街', admin1: '广东省' }
      }
    };
    const result = await translateAddressComponents(address, 'zh-TW', {}, failingFetcher);
    expect(result.status).toBe('translated');
    if (result.status !== 'translated') return;
    expect(result.components.street).toBe('復興門內大街');
    expect(result.components.admin1).toBe('廣東省');
    expect(result.lines.at(-1)).toBe('英國');
  });

  it('serves a zh-CN target from the stored variant or OpenCC without a provider', async () => {
    const stored = await translateAddressComponents(cleanJp, 'zh-CN', { GOOGLE_TRANSLATION_ENABLED: 'false' }, failingFetcher);
    expect(stored.status).toBe('translated');
    if (stored.status !== 'translated') return;
    expect(stored.components).toEqual(cleanJp.componentVariants['zh-CN']);
    const shinjitai = {
      ...cleanJp,
      componentVariants: { ...cleanJp.componentVariants, 'zh-CN': { ...cleanJp.componentVariants['zh-CN'], street: '桜丘町東通' } }
    };
    const converted = await translateAddressComponents(shinjitai, 'zh-CN', { GOOGLE_TRANSLATION_ENABLED: 'false' }, failingFetcher);
    expect(converted.status).toBe('translated');
    if (converted.status !== 'translated') return;
    expect(converted.components.street).toBe('樱丘町东通');
  });

  it('sends a kana zh-CN component to the provider when OpenCC is insufficient', async () => {
    const result = await translateAddressComponents(kanaAddress, 'zh-CN', {},
      googleFetcher((value) => value === 'さくらどおり' ? '樱花大道' : value));
    expect(result.status).toBe('translated');
    if (result.status !== 'translated') return;
    expect(result.components.street).toBe('樱花大道');
    expect(result.components.houseNumber).toBe(kanaAddress.componentVariants['zh-CN'].houseNumber);
  });

  it('tries the next provider when a translation still fails script validation', async () => {
    const google = googleFetcher((value) => value === 'さくらどおり' ? 'まだカナ' : value);
    const youdao = youdaoFetcher((value) => value === 'さくらどおり' ? '樱花大道' : value);
    const bindings = { YOUDAO_APP_KEY: 'key', YOUDAO_APP_SECRET: 'secret' };
    const accepted = await translateAddressComponents(kanaAddress, 'zh-CN', bindings, routedFetcher(google, youdao));
    expect(accepted.status).toBe('translated');
    if (accepted.status !== 'translated') return;
    expect(accepted.components.street).toBe('樱花大道');
    const rejected = await translateAddressComponents(kanaAddress, 'zh-CN', {}, google);
    expect(rejected).toEqual({ status: 'fallback' });
  });

  it('acquires the Youdao credential through the service credential resolver with env fallback', async () => {
    const google = googleFetcher((value) => value === 'さくらどおり' ? 'まだカナ' : value);
    const youdao = youdaoFetcher((value) => value === 'さくらどおり' ? '樱花大道' : value);
    const resolved = await translateAddressComponents(kanaAddress, 'zh-CN', {
      SERVICE_CREDENTIALS: async (provider) => provider === 'youdao'
        ? JSON.stringify({ appKey: 'store-key', appSecret: 'store-secret' })
        : undefined
    }, routedFetcher(google, youdao));
    expect(resolved.status).toBe('translated');
    if (resolved.status !== 'translated') return;
    expect(resolved.components.street).toBe('樱花大道');
    const fallback = await translateAddressComponents(kanaAddress, 'zh-CN', {
      SERVICE_CREDENTIALS: async () => { throw new Error('store offline'); },
      YOUDAO_APP_KEY: 'env-key', YOUDAO_APP_SECRET: 'env-secret'
    }, routedFetcher(google, youdao));
    expect(fallback.status).toBe('translated');
    const unavailable = await translateAddressComponents(kanaAddress, 'zh-CN', {
      GOOGLE_TRANSLATION_ENABLED: false,
      SERVICE_CREDENTIALS: async () => undefined
    }, failingFetcher);
    expect(unavailable).toEqual({ status: 'unavailable' });
  });

  it('reports unavailable instead of returning kana for zh-TW without a provider', async () => {
    await expect(translateAddressComponents(kanaAddress, 'zh-TW', { GOOGLE_TRANSLATION_ENABLED: 'false' }, failingFetcher))
      .resolves.toEqual({ status: 'unavailable' });
  });

  it('romanizes Chinese components as the English last resort with digits intact', async () => {
    const cn = eligibleAddresses('CN', false, now)[0];
    const address = {
      ...cn,
      componentVariants: {
        ...cn.componentVariants,
        en: { ...cn.componentVariants.en, street: '永兴路12号', locality: '南京' }
      }
    };
    const result = await translateAddressComponents(address, 'en', {}, failingFetcher);
    expect(result.status).toBe('translated');
    if (result.status !== 'translated') return;
    expect(result.components.street).toBe('Yong Xing Lu 12 Hao');
    expect(result.components.locality).toBe('Nan Jing');
    expect(result.components.houseNumber).toBe(address.componentVariants.en.houseNumber);
    const jpResult = await translateAddressComponents(
      { ...jp, componentVariants: { ...jp.componentVariants, en: { ...jp.componentVariants.en, street: '桜通り' } } },
      'en', {}, failingFetcher
    );
    expect(jpResult).toEqual({ status: 'fallback' });
  });

  it('ignores translation_cache entries from a previous cache revision', async () => {
    const db = openTestDatabase(':memory:');
    await initializeTestDatabase(db);
    try {
      const staleKey = ['xlate-v1', gb.id, gb.sourceVersion, gb.sourceUpdatedAt].join(':');
      await db.prepare('INSERT INTO translation_cache(cache_key, target_language, value, updated_at) VALUES (?, ?, ?, ?)')
        .bind(staleKey, 'ja', JSON.stringify(gb.componentVariants.en), new Date().toISOString()).run();
      await expect(translateAddressComponents(gb, 'ja', { LOCATION_DB: db }, failingFetcher))
        .resolves.toEqual({ status: 'fallback' });
    } finally {
      db.close();
    }
  });
});

describe('POST /api/v1/address-translation', () => {
  const post = (body: unknown, env: Record<string, unknown> = {}) => app.request('/api/v1/address-translation', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }, { ALLOWED_ORIGIN: '*', ...env });

  it('rejects invalid payloads', async () => {
    expect((await post({ addressId: 'pool-v2-1', targetLocale: 'xx' })).status).toBe(400);
    expect((await post({ addressId: 'pool-v2-1', targetLocale: 'native' })).status).toBe(400);
    expect((await post({ targetLocale: 'ja' })).status).toBe(400);
  });

  it('returns 404 when the address is not in the synchronized pool', async () => {
    expect((await post({ addressId: 'pool-v2-missing', targetLocale: 'ja' })).status).toBe(404);
    expect((await post({ addressId: 'pool-v2-missing', targetLocale: 'en' })).status).toBe(404);
    expect((await post({ addressId: 'pool-v2-missing', targetLocale: 'zh-CN' })).status).toBe(404);
    expect((await post({ addressId: 'not-a-pool-id', targetLocale: 'ja' })).status).toBe(404);
  });

  it('rate limits repeated translation requests per client', async () => {
    let limited: Response | undefined;
    for (let index = 0; index < 40 && !limited; index += 1) {
      const response = await post({ targetLocale: 'ja' });
      if (response.status === 429) limited = response;
    }
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get('Retry-After')).toBe('60');
  });

  it('uses the API token limit without adding the anonymous translation bucket', async () => {
    const responses = await Promise.all(Array.from({ length: 31 }, () => post({
      addressId: 'pool-v2-missing', targetLocale: 'zh-CN'
    }, { API_TOKEN_AUTHENTICATED: true })));
    expect(responses.every((response) => response.status !== 429)).toBe(true);
  });
});
