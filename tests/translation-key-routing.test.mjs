import { describe, expect, it, vi } from 'vitest';
import { ControlStore } from '../server/control/store.ts';
import { createCredentialBroker } from '../server/credential-broker/index.mjs';
import { ensureTranslationRoutes, routeIdForCredential } from '../server/translation/routing.mjs';
import { createBackfillProviders } from '../server/sync/translation-providers.mjs';
import { initializeTestDatabase, openTestDatabase } from './helpers/postgres-test-database.mjs';

const masterKey = Buffer.alloc(32, 31);
const tokens = { production: 'production-key-routing-fixture-00001', test: 'testing-key-routing-fixture-0000002' };
const setup = async () => {
  const database = openTestDatabase(':memory:');
  await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
  const control = new ControlStore(database, masterKey);
  await control.initialize('translation key routing fixture');
  return { database, control };
};
const youdao = (name, priority) => ({ provider: 'youdao', label: name,
  secret: JSON.stringify({ appKey: name, appSecret: 'synthetic-secret' }), translationPriority: priority, qpsLimit: 1000 });

describe('translation priority per credential', () => {
  it('inherits legacy settings once, preserves independent priorities and exposes only executable routes', async () => {
    const { database, control } = await setup();
    try {
      const first = await control.addCredential(youdao('first', 5));
      const second = await control.addCredential(youdao('second', 25));
      await database.prepare('DELETE FROM translation_routes WHERE credential_id=?').bind(second).run();
      await database.prepare("UPDATE translation_routes SET priority=17,enabled=0 WHERE id='youdao'").run();
      await ensureTranslationRoutes(database);
      expect(await control.translationRouteForCredential(second)).toMatchObject({ priority: 17, enabled: false });
      await control.updateCredential(second, { translationPriority: 9, enabled: true });
      await ensureTranslationRoutes(database);
      const routes = await control.translationRoutes();
      expect(routes.some((route) => ['youdao', 'deepl'].includes(route.id))).toBe(false);
      expect(routes.find((route) => route.credentialId === first)).toMatchObject({ priority: 5 });
      expect(routes.find((route) => route.credentialId === second)).toMatchObject({ priority: 9, enabled: true });
      const listed = await control.listCredentials();
      expect(listed.find((key) => key.id === first).translationPriority).toBe(5);
      expect(listed.find((key) => key.id === second).translationPriority).toBe(9);
    } finally { await database.close(); }
  });

  it('orders recovery by individual keys and keeps a sibling key available after failure', async () => {
    const { database, control } = await setup();
    try {
      const first = await control.addCredential(youdao('first', 5));
      const second = await control.addCredential(youdao('second', 25));
      const broker = {
        availability: vi.fn(async () => ({ youdao: { available: true } })),
        request: vi.fn(async (_operation, parameters) => {
          if (parameters.credentialId === first) throw Object.assign(new Error('fixture failure'), { code: 'SOURCE_NETWORK_UNAVAILABLE' });
          return { errorCode: '0', translateResults: [{ translation: '道路 18' }] };
        })
      };
      await control.setSetting('google_translation_enabled', false);
      const services = await createBackfillProviders({ database, environment: {}, fetchImpl: vi.fn(),
        signal: new AbortController().signal, now: () => new Date(), brokerClient: broker });
      expect(services.translationChain.map((route) => route.id)).toEqual([
        routeIdForCredential(first, 'youdao'), routeIdForCredential(second, 'youdao')
      ]);
      expect(await services.translationChain[0].translate(['Road 18'], 'zh-CN')).toBeNull();
      expect(await services.translationChain[1].translate(['Road 18'], 'zh-CN')).toEqual(['道路 18']);
      expect(broker.request.mock.calls.map((call) => call[1].credentialId)).toEqual([first, second]);
    } finally { await database.close(); }
  });

  it.each(['youdao', 'deepl'])('dispatches %s through the exact selected key and never substitutes another key', async (provider) => {
    const { database, control } = await setup();
    try {
      const secrets = provider === 'deepl'
        ? ['11111111-1111-4111-8111-111111111111:fx', '22222222-2222-4222-8222-222222222222:fx']
        : [JSON.stringify({ appKey: 'first', appSecret: 'fixture-secret' }), JSON.stringify({ appKey: 'second', appSecret: 'fixture-secret' })];
      const ids = [];
      for (let index = 0; index < 2; index++) ids.push(await control.addCredential({
        provider, label: `fixture-${index}`, secret: secrets[index], qpsLimit: 1000, translationPriority: 10 + index
      }));
      const fetched = [];
      const broker = await createCredentialBroker({ database, masterKey, tokens, fetchImpl: async (request) => {
        fetched.push(provider === 'deepl' ? request.headers.get('authorization') : new URLSearchParams(await request.text()).get('appKey'));
        return Response.json(provider === 'deepl' ? request.url.endsWith('/usage')
          ? { character_count: 0, character_limit: 500000 } : { translations: [{ text: '道路 18', billed_characters: 7 }] }
          : { errorCode: '0', translateResults: [{ translation: '道路 18' }] });
      } });
      const send = (requestId) => broker.api(new Request('http://broker.internal/v1/requests', { method: 'POST',
        headers: { Authorization: `Bearer ${tokens.production}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, operation: `${provider}.translate`,
          parameters: { credentialId: ids[1], values: ['Road 18'], target: 'zh-CN' }, maxDispatches: 2 }) }));
      expect((await send(`selected-${provider}`)).status).toBe(200);
      expect(fetched.every((value) => value === (provider === 'deepl' ? `DeepL-Auth-Key ${secrets[1]}` : 'second'))).toBe(true);
      expect(fetched.length).toBe(provider === 'deepl' ? 2 : 1);
      await control.updateCredential(ids[1], { enabled: false });
      const count = fetched.length;
      expect((await send(`disabled-${provider}`)).status).toBe(503);
      expect(fetched.length).toBe(count);
    } finally { await database.close(); }
  });
});
