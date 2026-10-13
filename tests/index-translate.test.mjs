import { describe, expect, it, vi } from 'vitest';
import { ControlStore } from '../server/control/store.ts';
import { createBackfillProviders } from '../server/sync/translation-providers.mjs';
import {
  INDEX_TRANSLATE_DEFAULTS, INDEX_TRANSLATE_SETTINGS_KEY, indexTranslate, normalizeIndexTranslateSettings, parseIndexTranslateResponse
} from '../server/translation/index-translate.mjs';
import { initializeTestDatabase, openTestDatabase } from './helpers/postgres-test-database.mjs';

const reply = (content, init) => Response.json({ choices: [{ message: { role: 'assistant', content } }] }, init);

describe('Index-Translate route', () => {
  it('sends one user message in the instTrans JSON format without reasoning or authorization', async () => {
    let request;
    const fetchImpl = vi.fn(async (url, init) => { request = { url, init, body: JSON.parse(init.body) }; return reply('{"0":"北京","1":"D1-12座"}'); });
    expect(await indexTranslate(['Beijing', 'Block D1-12'], 'zh-CN', INDEX_TRANSLATE_DEFAULTS, fetchImpl)).toEqual(['北京', 'D1-12座']);
    expect(request.url).toBe('https://index-translate.bilibili.com/v1/chat/completions');
    expect(request.init.headers).not.toHaveProperty('Authorization');
    expect(request.body).toMatchObject({ model: 'Index-Translate-35B-A3B', temperature: 0, stream: false, chat_template_kwargs: { enable_thinking: false } });
    expect(request.body).not.toHaveProperty('reasoning_effort');
    expect(request.body.messages).toHaveLength(1);
    expect(request.body.messages[0].role).toBe('user');
    expect(request.body.messages[0].content).toContain('翻译成简体中文');
    expect(request.body.messages[0].content).toContain('{"0":"Beijing","1":"Block D1-12"}');
    expect(request.body.messages[0].content).toContain('严格保留合法 JSON 语法格式');
    expect(await indexTranslate(['Beijing'], 'ja', INDEX_TRANSLATE_DEFAULTS, fetchImpl)).toBeNull();
  });

  it('reads the JSON after a think block or inside a fence and rejects a changed shape', () => {
    expect(parseIndexTranslateResponse('<think>…</think>\n{"0":"北京","1":"道路 18"}', 2)).toEqual(['北京', '道路 18']);
    expect(parseIndexTranslateResponse('```json\n{"0":"Beijing"}\n```', 1)).toEqual(['Beijing']);
    expect(parseIndexTranslateResponse('{"0":"北京"}', 2)).toBeNull();
    expect(parseIndexTranslateResponse('北京', 1)).toBeNull();
    expect(parseIndexTranslateResponse('{"0":""}', 1)).toBeNull();
  });

  it('reports HTTP limits with the provider retry time and invalid replies with their own code', async () => {
    const limited = async () => new Response('busy', { status: 429, headers: { 'Retry-After': '120' } });
    await expect(indexTranslate(['Road'], 'en', INDEX_TRANSLATE_DEFAULTS, limited)).rejects.toMatchObject({ code: 'INDEX_TRANSLATE_HTTP_429', status: 429 });
    await expect(indexTranslate(['Road'], 'en', INDEX_TRANSLATE_DEFAULTS, async () => reply('Road translated'))).rejects.toMatchObject({ code: 'INDEX_TRANSLATE_INVALID_RESPONSE' });
  });

  it('validates settings and keeps unspecified fields', () => {
    expect(normalizeIndexTranslateSettings({ enabled: true }, { ...INDEX_TRANSLATE_DEFAULTS, concurrency: 3 })).toMatchObject({ enabled: true, concurrency: 3 });
    expect(normalizeIndexTranslateSettings({ baseUrl: 'http://localhost:8080/v1/' }).baseUrl).toBe('http://localhost:8080/v1');
    for (const input of [{ baseUrl: 'http://example.com/v1' }, { model: 'bad model' }, { concurrency: 0 }, { enabled: 'yes' }]) {
      expect(() => normalizeIndexTranslateSettings(input)).toThrow('INVALID_INDEX_TRANSLATE_SETTINGS');
    }
  });

  it('joins the backfill chain only when enabled and cools down after a rate limit', async () => {
    const database = openTestDatabase(':memory:');
    try {
      await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
      const control = new ControlStore(database, Buffer.alloc(32, 7));
      await control.initialize('index translate fixture');
      await control.setSetting('google_translation_enabled', false);
      const services = (fetchImpl) => createBackfillProviders({ database, environment: {}, fetchImpl, signal: new AbortController().signal,
        now: () => new Date('2026-10-12T00:00:00Z'), brokerClient: null });
      expect((await services(vi.fn())).translationChain).toEqual([]);
      await control.setSetting(INDEX_TRANSLATE_SETTINGS_KEY, { ...INDEX_TRANSLATE_DEFAULTS, enabled: true });
      expect((await control.translationRoutes()).find((route) => route.provider === 'index-translate')).toMatchObject({ priority: 35, status: 'healthy' });
      const limited = await services(async () => new Response('busy', { status: 429, headers: { 'Retry-After': '60' } }));
      expect(limited.translationChain.map((route) => route.id)).toEqual(['index-translate']);
      expect(await limited.translationChain[0].translate(['Road 18'], 'zh-CN')).toBeNull();
      expect(limited.wait).toMatchObject({ reason: 'index_cooldown' });
      const cooled = await services(async () => reply('{"0":"道路 18"}'));
      expect(await cooled.translationChain[0].translate(['Road 18'], 'zh-CN')).toBeNull();
      expect(cooled.wait).toMatchObject({ reason: 'index_cooldown' });
    } finally { await database.close(); }
  });
});
