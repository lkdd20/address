import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { ControlStore } from '../server/control/store.ts';
import { createCredentialBroker } from '../server/credential-broker/index.mjs';
import { characterCount, deepLBudgetStatus } from '../server/credential-broker/deepl.mjs';
import { translateValues } from '../server/sync/address-etl.mjs';
import { initializeTestDatabase, openTestDatabase } from './helpers/postgres-test-database.mjs';

const secret = '00000000-0000-0000-0000-000000000001:fx';
const masterKey = Buffer.alloc(32, 23);
const tokens = { production: 'production-token-fixture-00000001', test: 'test-token-fixture-00000000000002' };
const now = () => new Date('2026-09-13T00:00:00Z');
const call = (broker, requestId, values = ['Hello']) => broker.api(new Request('http://broker/v1/requests', {
  method: 'POST', headers: { Authorization: `Bearer ${tokens.production}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ requestId, operation: 'deepl.translate', parameters: { values, target: 'zh-CN' } })
}));

describe('DeepL Free character gate', () => {
  let database, control;
  beforeEach(async () => {
    database = openTestDatabase();
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    control = new ControlStore(database, masterKey);
    await control.initialize('fixture-password-for-admin');
  });
  afterEach(async () => { await database.close(); });
  const add = (quotaLimit = 100) => control.addCredential({ provider: 'deepl', label: 'Fixture', secret, quotaLimit, qpsLimit: 10_000 });
  const usage = (broker, credentialId) => broker.api(new Request('http://broker/v1/requests', {
    method: 'POST', headers: { Authorization: `Bearer ${tokens.production}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'explicit-usage-check', operation: 'deepl.usage', parameters: { credentialId }, maxDispatches: 1 })
  }));
  const fetcher = (used, limit, translations, failure) => async (request, options) => {
    expect(new URL(request.url).origin).toBe('https://api-free.deepl.com');
    expect(options.redirect).toBe('error');
    expect(request.headers.get('Authorization')).toBe(`DeepL-Auth-Key ${secret}`);
    if (request.url.endsWith('/usage')) return Response.json({ character_count: used, character_limit: limit });
    translations.push(await request.json());
    if (failure) throw new Error('Lost upstream response');
    return Response.json({ translations: translations.at(-1).text.map((text) => ({ text: '译文', billed_characters: characterCount([text]) })) });
  };

  it('honors the actual account allowance, Unicode code points and delayed usage', async () => {
    await add(1_000_000);
    const translations = [];
    const broker = await createCredentialBroker({ database, masterKey, tokens, now,
      fetchImpl: fetcher(999_995, 1_000_000, translations) });
    expect((await call(broker, 'unicode-first', ['😀你好'])).status).toBe(200);
    expect((await call(broker, 'unicode-second', ['Hello'])).status).toBe(429);
    expect(translations).toHaveLength(1);
    expect(translations[0].target_lang).toBe('ZH-HANS');
    expect(await deepLBudgetStatus(database)).toMatchObject({ used: 999_998, limit: 1_000_000, remaining: 2, resetAt: null });
  });

  it('keeps the administrator cap across restart, key replacement and calendar changes', async () => {
    const id = await add(10);
    const translations = [];
    const options = { database, masterKey, tokens, now, fetchImpl: fetcher(4, 1_000_000, translations) };
    expect((await call(await createCredentialBroker(options), 'before-restart')).status).toBe(200);
    await control.updateCredential(id, { secret: '00000000-0000-0000-0000-000000000002:fx' });
    await control.updateCredential(id, { secret });
    expect((await call(await createCredentialBroker({ ...options, now: () => new Date('2026-10-01') }), 'after-restart')).status).toBe(429);
    expect(translations).toHaveLength(1);
    expect((await deepLBudgetStatus(database)).used).toBe(9);
  });

  it('does not release reserved characters after an uncertain upstream outcome', async () => {
    await add(10);
    const translations = [];
    const broker = await createCredentialBroker({ database, masterKey, tokens, now, fetchImpl: fetcher(0, 100, translations, true) });
    expect((await call(broker, 'unknown-result')).status).toBe(503);
    expect((await deepLBudgetStatus(database)).used).toBe(5);
    expect(await database.prepare('SELECT status FROM credential_broker_dispatches').first('status')).toBe('unknown');
  });

  it('does not cool DeepL after an active request is cancelled', async () => {
    const id = await add(100);
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const broker = await createCredentialBroker({ database, masterKey, tokens, now, fetchImpl: async (request, { signal }) => {
      if (request.url.endsWith('/usage')) return Response.json({ character_count: 0, character_limit: 100 });
      startedResolve();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
    const controller = new AbortController();
    const pending = broker.api(new Request('http://broker/v1/requests', {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${tokens.production}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'deepl-cancelled-active', operation: 'deepl.translate',
        parameters: { values: ['Hello'], target: 'zh-CN' } })
    }));
    await started;
    controller.abort(Object.assign(new Error('fixture cancellation'), { code: 'BROKER_REQUEST_CANCELLED', status: 499 }));
    expect((await pending).status).toBe(499);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await database.prepare('SELECT status,failure_count FROM provider_credentials WHERE id=?').bind(id).first())
      .toMatchObject({ status: 'healthy', failure_count: 0 });
    expect(await database.prepare('SELECT status,outcome FROM credential_broker_dispatches').first())
      .toEqual({ status: 'unknown', outcome: 'cancelled' });
    expect((await deepLBudgetStatus(database)).used).toBe(5);
  });

  it('resets only when the provider supplies a verified new billing period', async () => {
    await add(5);
    let clock = new Date('2026-09-13T00:00:00Z');
    let period = { start_time: '2026-09-01T00:00:00Z', end_time: '2026-10-01T00:00:00Z' };
    const broker = await createCredentialBroker({ database, masterKey, tokens, now: () => clock, fetchImpl: async (request) =>
      request.url.endsWith('/usage') ? Response.json({ character_count: 0, character_limit: 5, ...period })
        : Response.json({ translations: [{ text: '你好', billed_characters: 5 }] }) });
    expect((await call(broker, 'previous-period-translation')).status).toBe(200);
    clock = new Date('2026-10-02T00:00:00Z');
    expect((await call(broker, 'stale-period-translation')).status).toBe(429);
    period = { start_time: '2026-10-01T00:00:00Z', end_time: '2026-11-01T00:00:00Z' };
    expect((await call(broker, 'verified-period-translation')).status).toBe(200);
    expect(await deepLBudgetStatus(database)).toMatchObject({ used: 5, remaining: 0, resetAt: '2026-11-01T00:00:00.000Z' });
  });

  it('requires valid usage and never substitutes a paid key', async () => {
    await expect(control.addCredential({ provider: 'deepl', label: 'Pro', secret: secret.replace(':fx', '') })).rejects.toThrow('DEEPL_FREE_KEY_REQUIRED');
    await add();
    let requests = 0;
    const broker = await createCredentialBroker({ database, masterKey, tokens,
      fetchImpl: async () => { requests += 1; return Response.json({ character_count: -1, character_limit: 100 }); } });
    expect((await call(broker, 'invalid-usage')).status).toBe(503);
    expect(requests).toBe(1);
    expect(await database.prepare('SELECT COUNT(*) AS count FROM credential_broker_dispatches').first('count')).toBe(0);
  });

  it('shares a cap between credentials and simultaneous requests', async () => {
    await add(5);
    await add(5);
    const translations = [];
    const broker = await createCredentialBroker({ database, masterKey, tokens, now, fetchImpl: fetcher(0, 100, translations) });
    const results = await Promise.all([call(broker, 'parallel-first'), call(broker, 'parallel-second')]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 429]);
    expect(translations).toHaveLength(1);
  });

  it('recovers an explicitly selected credential using a read-only usage test', async () => {
    const id = await add();
    await database.prepare("UPDATE provider_credentials SET status='needs_review',failure_count=3 WHERE id=?").bind(id).run();
    const translations = [];
    const broker = await createCredentialBroker({ database, masterKey, tokens, now, fetchImpl: fetcher(4, 100, translations) });
    expect((await usage(broker, id)).status).toBe(200);
    expect(translations).toHaveLength(0);
    expect((await deepLBudgetStatus(database)).used).toBe(4);
    expect(await database.prepare('SELECT status,failure_count FROM provider_credentials WHERE id=?').bind(id).first())
      .toMatchObject({ status: 'healthy', failure_count: 0 });
    expect(await database.prepare('SELECT COUNT(*) AS total FROM credential_broker_dispatches').first('total')).toBe(0);
  });

  it('does not dispatch translation or usage for a disabled credential', async () => {
    const id = await control.addCredential({ provider: 'deepl', label: 'Disabled', secret, enabled: false });
    let requests = 0;
    const broker = await createCredentialBroker({ database, masterKey, tokens, fetchImpl: async () => { requests += 1; return Response.json({}); } });
    expect((await call(broker, 'disabled-translation')).status).toBe(503);
    expect((await usage(broker, id)).status).toBe(503);
    expect(requests).toBe(0);
  });

  it('shows exhausted character budgets without inventing a reset date', async () => {
    await add(5);
    const broker = await createCredentialBroker({ database, masterKey, tokens, now, fetchImpl: fetcher(0, 100, []) });
    const before = await broker.store.availability({ clientId: 'production', provider: 'deepl' });
    expect((await call(broker, 'exhaust-characters')).status).toBe(200);
    expect((await control.listCredentials())[0]).toMatchObject({ status: 'quota_exhausted', quotaRemaining: 0, quotaResetAt: '' });
    expect(await broker.store.availability({ clientId: 'production', provider: 'deepl' }))
      .toMatchObject({ available: false, waitState: 'quota_wait', nextResetAt: null, revision: before.revision });
  });

  it('paces usage and translation requests, including concurrent callers', async () => {
    const id = await add();
    await control.updateCredential(id, { qpsLimit: 20 });
    const dispatchedAt = [];
    const options = { database, masterKey, tokens, fetchImpl: async (request) => {
      dispatchedAt.push(performance.now());
      return request.url.endsWith('/usage') ? Response.json({ character_count: 0, character_limit: 100 })
        : Response.json({ translations: [{ text: '你好', billed_characters: 5 }] });
    } };
    const broker = await createCredentialBroker(options);
    expect((await Promise.all([0, 1].map((index) => call(broker, `paced-request-${index}`)))).map((response) => response.status))
      .toEqual([200, 200]);
    expect(dispatchedAt).toHaveLength(4);
    for (let index = 1; index < dispatchedAt.length; index += 1) expect(dispatchedAt[index] - dispatchedAt[index - 1]).toBeGreaterThanOrEqual(40);
  });

  it('paces actual dispatch after a slow reservation write', async () => {
    const id = await add();
    await control.updateCredential(id, { qpsLimit: 20 });
    const query = database.query.bind(database);
    let delayed = false;
    database.query = async (statement, bindings) => {
      const result = await query(statement, bindings);
      if (!delayed && statement.startsWith('UPDATE provider_credentials SET last_used_at=')) {
        delayed = true;
        await delay(100);
      }
      return result;
    };
    const dispatchedAt = [];
    const broker = await createCredentialBroker({ database, masterKey, tokens, fetchImpl: async (request) => {
      dispatchedAt.push(performance.now());
      return request.url.endsWith('/usage') ? Response.json({ character_count: 0, character_limit: 100 })
        : Response.json({ translations: [{ text: '你好', billed_characters: 5 }] });
    } });
    expect((await call(broker, 'slow-reservation-write')).status).toBe(200);
    expect(delayed).toBe(true);
    expect(dispatchedAt).toHaveLength(2);
    expect(dispatchedAt[1] - dispatchedAt[0]).toBeGreaterThanOrEqual(40);
  });

  it.each([403, 456])('blocks provider HTTP %i and retains uncertain billed characters', async (status) => {
    await add();
    const broker = await createCredentialBroker({ database, masterKey, tokens, now, fetchImpl: async (request) => request.url.endsWith('/usage')
      ? Response.json({ character_count: 0, character_limit: 100 }) : Response.json({ message: secret }, { status }) });
    const response = await call(broker, `provider-status-${status}`);
    expect(response.status).toBe(status === 456 ? 429 : 503);
    expect(await response.text()).not.toContain(secret);
    expect((await deepLBudgetStatus(database)).used).toBe(5);
    expect(await database.prepare('SELECT status FROM provider_credentials').first('status')).toBe(status === 456 ? 'quota_exhausted' : 'needs_review');
  });

  it('stops repeated network failures after three attempts', async () => {
    await add();
    let clock = now().getTime();
    let requests = 0;
    const broker = await createCredentialBroker({ database, masterKey, tokens, now: () => new Date(clock), fetchImpl: async () => {
      requests += 1; throw new Error(`Offline ${secret}`);
    } });
    for (let index = 0; index < 4; index += 1) {
      expect((await call(broker, `network-failure-${index}`)).status).toBe(503);
      clock += 10_000;
    }
    expect(requests).toBe(3);
    expect(await database.prepare('SELECT status FROM provider_credentials').first('status')).toBe('needs_review');
  });

  it('rejects malformed test policy before querying the provider', async () => {
    await add();
    let requests = 0;
    const broker = await createCredentialBroker({ database, masterKey, tokens, testPolicies: { deepl: {} }, fetchImpl: async () => {
      requests += 1; return Response.json({ character_count: 0, character_limit: 100 });
    } });
    const response = await broker.api(new Request('http://broker/v1/requests', {
      method: 'POST', headers: { Authorization: `Bearer ${tokens.test}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'invalid-test-policy', operation: 'deepl.translate', parameters: { values: ['Hello'], target: 'zh-CN' } })
    }));
    expect(response.status).toBe(403);
    expect(requests).toBe(0);
  });

  it('requires room for usage plus translation and never redispatches a request ID', async () => {
    await add();
    const translations = [];
    const broker = await createCredentialBroker({ database, masterKey, tokens, now, fetchImpl: fetcher(0, 100, translations) });
    const response = await broker.api(new Request('http://broker/v1/requests', {
      method: 'POST', headers: { Authorization: `Bearer ${tokens.production}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'insufficient-request-budget', operation: 'deepl.translate', maxDispatches: 1,
        parameters: { values: ['Hello'], target: 'zh-CN' } })
    }));
    expect(response.status).toBe(400);
    expect(response.headers.get('X-Address-Upstream-Requests')).toBe('0');
    expect((await call(broker, 'idempotent-translation')).status).toBe(200);
    expect((await call(broker, 'idempotent-translation')).status).toBe(409);
    expect(translations).toHaveLength(1);
  });

  it('prioritizes DeepL, Youdao, Google only for remaining untranslated values', async () => {
    const calls = [];
    const providers = {
      deepl: async (values) => { calls.push(['deepl', values]); return ['甲路', 'Second Street', 'Third Street']; },
      youdao: async (values) => { calls.push(['youdao', values]); return ['乙路', 'Third Street']; },
      google: async (values) => { calls.push(['google', values]); return ['丙路']; }
    };
    const values = ['First Street', 'Second Street', 'Third Street'];
    expect([...await translateValues(values, 'zh-CN', {}, null, null, undefined, providers)])
      .toEqual([['First Street', '甲路'], ['Second Street', '乙路'], ['Third Street', '丙路']]);
    expect(calls).toEqual([['deepl', values], ['youdao', values.slice(1)], ['google', values.slice(2)]]);
  });
});
