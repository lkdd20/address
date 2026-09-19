import { describe, expect, it, vi } from 'vitest';
import { pendingTranslationFields, runTranslationBackfillBatch, startTranslationBackfill } from '../server/sync/translation-backfill.mjs';
import { translateNumberedValues, translateValues, usableTranslation } from '../server/sync/address-etl.mjs';
import { preservesAddressIdentifiers, preservesAddressNumbers } from '../src/domain/address-localization.mjs';

describe('bounded translation backfill', () => {
  it('repairs numeric translations without sending ordinal and mixed identifiers to providers', async () => {
    const translate = vi.fn(async (values) => values.map((value) => ({ West: '西', Street: '街', Block: '栋', 'Rue du': '街', Mai: '五月' })[value]));
    const originals = ['West 23rd Street', 'Block D1-12', 'Rue du 8 Mai 1945'];
    const result = await translateNumberedValues(originals, 'zh-CN', {}, vi.fn(), null, undefined,
      { translationChain: [{ translate }] });
    expect([...result.keys()]).toEqual(originals);
    expect(translate.mock.calls[0][0]).toEqual(['West', 'Street', 'Block', 'Rue du', 'Mai']);
    expect(result.get('West 23rd Street')).toBe('西 23rd 街');
    expect(result.get('Block D1-12')).toBe('栋 D1-12');
    expect(result.get('Rue du 8 Mai 1945')).toBe('街 8 五月 1945');
  });
  it('preserves contextual ordinals, leading zeros and unchanged route identifiers', () => {
    expect(preservesAddressNumbers('二丁目', '三丁目')).toBe(false);
    expect(preservesAddressNumbers('二丁目', '2-chome')).toBe(true);
    expect(preservesAddressNumbers('二丁目', '999-chome')).toBe(false);
    expect(preservesAddressNumbers('〇一号', '1号')).toBe(false);
    expect(preservesAddressNumbers('First Avenue', '第一大道')).toBe(true);
    expect(usableTranslation('BR-101', 'zh-CN', 'BR-101')).toBe(true);
    expect(usableTranslation('BR-102', 'zh-CN', 'BR-101')).toBe(false);
  });
  it.each([
    ['ซอย ๑๒', 'Soi 12', 'en'],
    ['شارع ١٢', 'Street 12', 'en'],
    ['通り １２', 'Road 12', 'en']
  ])('accepts equivalent decimal scripts without accepting changed identifiers: %s', (original, translated, language) => {
    expect(usableTranslation(translated, language, original)).toBe(true);
    expect(usableTranslation(translated.replace('12', '21'), language, original)).toBe(false);
    expect(usableTranslation(translated.replace('12', '012'), language, original)).toBe(false);
  });

  it('preserves mixed letter-number address identifiers', () => {
    expect(preservesAddressIdentifiers('Block D1-12', 'Block D1-12')).toBe(true);
    expect(preservesAddressIdentifiers('Block D1-12', 'Block D1-21')).toBe(false);
    expect(preservesAddressIdentifiers('SW1A 1AA', 'SW1A 1AA')).toBe(true);
    expect(preservesAddressIdentifiers('SW1A 1AA', 'SW1A 1AB')).toBe(false);
  });

  it('does not read settings or send requests when explicitly disabled', async () => {
    const database = { prepare: vi.fn() };
    const setTimer = vi.fn();
    const environment = { TRANSLATION_BACKFILL_ENABLED: 'false' };
    expect(await runTranslationBackfillBatch({ database, environment })).toEqual({ scanned: 0, updated: 0, done: true });
    await startTranslationBackfill({ database, workerPool: {}, environment, setTimer })();
    expect(database.prepare).not.toHaveBeenCalled();
    expect(setTimer).not.toHaveBeenCalled();
  });

  it('finds missing fields, Japanese Han and mixed scripts without translating identifiers', () => {
    const native = { admin1: '\u4e09\u91cd\u770c', street: '\u5927\u5b57\u7e04\u751f',
      dependentLocality: '\u4e09\u91cd', unit: 'A-21', houseNumber: '771-6', postcode: '510-8101' };
    const result = pendingTranslationFields({ native, en: {}, 'zh-CN': native }, 'ja');
    expect(result.en.sort()).toEqual(['admin1', 'dependentLocality', 'street']);
    expect(result['zh-CN'].sort()).toEqual(['admin1', 'dependentLocality', 'street']);
    expect(usableTranslation('\u4e3b\u8857 \u0627\u0644', 'zh-CN', 'Main Street')).toBe(false);
    expect(usableTranslation('\u4e3b\u8857 22', 'zh-CN', 'Main Street 21')).toBe(false);
    expect(usableTranslation('Main Street', 'zh-CN', 'Main Street')).toBe(false);
  });

  it('uses validated cache hits and falls back only for unresolved values', async () => {
    const cache = { get: vi.fn(async () => new Map([['Main Street', '\u4e3b\u8857']])), set: vi.fn() };
    const google = vi.fn(async () => ['\u9053\u8def 21']);
    const youdao = vi.fn(async () => ['Road 22']);
    const result = await translateValues(['Main Street', 'Road 21', 'Road 21'], 'zh-CN', {}, vi.fn(), cache,
      new AbortController().signal, { google, youdao });
    expect(result.get('Road 21')).toBe('\u9053\u8def 21');
    expect(google.mock.calls[0][0]).toEqual(['Road 21']);
    expect(youdao.mock.calls[0][0]).toEqual(['Road 21']);
    expect(youdao.mock.invocationCallOrder[0]).toBeLessThan(google.mock.invocationCallOrder[0]);
    expect(cache.set).toHaveBeenCalledOnce();
  });

  it('does not cache failed or digit-changing translations', async () => {
    const cache = { get: async () => new Map(), set: vi.fn() };
    const result = await translateValues(['Road 21'], 'zh-CN', {}, vi.fn(), cache, undefined,
      { google: async () => ['\u9053\u8def 22'], youdao: async () => null });
    expect(result.get('Road 21')).toBe('Road 21');
    expect(cache.set).not.toHaveBeenCalled();
  });
});
