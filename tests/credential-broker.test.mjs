import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  ControlStore, GOOGLE_GEOCODING_FREE_MONTHLY_LIMIT
} from '../server/control/store.ts';
import {
  createCredentialBroker, loadCredentialBrokerConfiguration, ProviderPriorityGate
} from '../server/credential-broker/index.mjs';
import { executeOperation, operationDefinitions } from '../server/credential-broker/operations.mjs';
import { CredentialBrokerClient } from '../server/credential-broker/client.mjs';
import { initializeTestDatabase, openTestDatabase } from './helpers/postgres-test-database.mjs';

const masterKey = Buffer.alloc(32, 23);
const tokens = {
  production: 'production-broker-token-fixture-0001',
  test: 'test-broker-token-fixture-0000000002'
};

const call = (broker, client, body) => broker.api(new Request('http://broker.internal/v1/requests', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${tokens[client]}`,
    'Content-Type': 'application/json'
  },
  body: typeof body === 'string' ? body : JSON.stringify(body)
}));

const availability = (broker, client, providers) => broker.api(new Request('http://broker.internal/v1/availability', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${tokens[client]}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ providers })
}));

const reverse = (requestId, latitude = 37.574) => ({
  requestId,
  operation: 'geoapify.reverse',
  parameters: { latitude, longitude: 126.977, language: 'ko' }
});

describe('credential broker', () => {
  let database;
  let control;

  beforeEach(async () => {
    database = openTestDatabase(':memory:', { migrate: false });
    await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
    control = new ControlStore(database, masterKey);
    await control.initialize('credential broker test password');
  });

  afterEach(async () => { await database.close(); });

  const addGeoapify = (label, secret, options = {}) => control.addCredential({
    provider: 'geoapify', label, secret, qpsLimit: 10_000, quotaLimit: 100, ...options
  });

  it('bounds provider queues and removes cancelled pending work', async () => {
    const gate = new ProviderPriorityGate({ maxPending: 1 });
    let release;
    const first = gate.run('geoapify', 'production', () => new Promise((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const second = gate.run('geoapify', 'production', async () => 'second', { signal: controller.signal });
    await expect(gate.run('geoapify', 'production', async () => 'third')).rejects.toMatchObject({ code: 'BROKER_QUEUE_FULL' });
    controller.abort();
    await expect(second).rejects.toMatchObject({ code: 'BROKER_REQUEST_CANCELLED' });
    release();
    await first;
  });

  it('does not cool a credential when an active request is cancelled', async () => {
    const id = await addGeoapify('Cancelled', 'cancelled-secret');
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const broker = await createCredentialBroker({
      database, masterKey, tokens,
      fetchImpl: async (_request, { signal }) => {
        startedResolve();
        await new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
    });
    const controller = new AbortController();
    const pending = broker.api(new Request('http://broker.internal/v1/requests', {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${tokens.production}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'cancelled-active-01', operation: 'geoapify.reverse',
        parameters: { latitude: 37.5, longitude: 127, language: 'ko' } })
    }));
    await started;
    controller.abort(Object.assign(new Error('fixture cancellation'), { code: 'BROKER_REQUEST_CANCELLED', status: 499 }));
    expect((await pending).status).toBe(499);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await database.prepare('SELECT status,failure_count FROM provider_credentials WHERE id=?').bind(id).first())
      .toMatchObject({ status: 'healthy', failure_count: 0 });
    expect(await database.prepare('SELECT status,outcome FROM credential_broker_dispatches').first())
      .toEqual({ status: 'unknown', outcome: 'cancelled' });
  });

  it('signs Youdao batches, redacts both credential parts and counts real requests against the existing quota', async () => {
    await control.addCredential({ provider: 'youdao', label: 'Youdao',
      secret: JSON.stringify({ appKey: 'fixture-key', appSecret: 'fixture-secret' }), qpsLimit: 10000, quotaLimit: 1 });
    let calls = 0;
    const broker = await createCredentialBroker({ database, masterKey, tokens, fetchImpl: async (request) => {
      calls += 1;
      expect(request.url).toBe('https://openapi.youdao.com/v2/api');
      const body = new URLSearchParams(await request.text());
      expect(body.getAll('q')).toEqual(['Main Street', 'Road 21']);
      expect(body.get('signType')).toBe('v3');
      expect(body.get('sign')).toMatch(/^[a-f0-9]{64}$/u);
      expect(body.get('to')).toBe('zh-CHS');
      return Response.json({ errorCode: '0', translateResults: [{ translation: 'fixture-key fixture-secret' }] });
    } });
    const input = (requestId) => ({ requestId, operation: 'youdao.translate',
      parameters: { values: ['Main Street', 'Road 21'], target: 'zh-CN' }, maxDispatches: 1 });
    const response = await call(broker, 'production', input('youdao-first'));
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Address-Upstream-Requests')).toBe('1');
    expect(await response.text()).not.toMatch(/fixture-key|fixture-secret/u);
    expect((await call(broker, 'production', input('youdao-second'))).status).toBe(429);
    expect(calls).toBe(1);
    expect((await (await availability(broker, 'production', ['youdao'])).json()).providers.youdao.available).toBe(false);
  });

  it('classifies Youdao billing and QPS errors without inventing a daily billing reset', () => {
    const definition = operationDefinitions['youdao.translate'];
    expect(definition.classify({ errorCode: '401' })).toMatchObject({ outcome: 'auth', retryAt: null });
    expect(definition.classify({ errorCode: '202' })).toMatchObject({ outcome: 'auth' });
    expect(definition.classify({ errorCode: '411' })).toMatchObject({ outcome: 'qps' });
    expect(definition.validate({ values: ['x'.repeat(5001)], target: 'en' })).toBeNull();
    expect(definition.validate({ values: ['Road'], target: 'fr' })).toBeNull();
  });

  it('counts every HTTP dispatch and respects a caller budget across credential rotation', async () => {
    await addGeoapify('First', 'first-secret');
    await addGeoapify('Second', 'second-secret');
    let dispatched = 0;
    const broker = await createCredentialBroker({ database, masterKey, tokens,
      fetchImpl: async () => { dispatched += 1; return new Response('{}', { status: 503 }); }
    });
    const client = new CredentialBrokerClient({ url: 'http://broker.internal', token: tokens.production,
      fetchImpl: (url, init) => broker.api(new Request(url, init))
    });
    let accounted = 0;
    await expect(client.request('geoapify.reverse', reverse('fixture-budget').parameters, {
      maxDispatches: 1, onDispatch: (count) => { accounted += count; }
    })).rejects.toMatchObject({ code: 'SOURCE_NETWORK_UNAVAILABLE' });
    expect(dispatched).toBe(1);
    expect(accounted).toBe(1);
    expect(await database.prepare('SELECT COUNT(*) AS total FROM credential_broker_dispatches').first('total')).toBe(1);
  });

  it('dispatches Google v4 through the broker and enforces the pre-existing monthly usage baseline', async () => {
    await control.addCredential({
      provider: 'google-geocoding', label: 'Google', secret: 'google-secret', qpsLimit: 10_000,
      quotaLimit: GOOGLE_GEOCODING_FREE_MONTHLY_LIMIT,
      quotaUsedBaseline: GOOGLE_GEOCODING_FREE_MONTHLY_LIMIT - 1
    });
    let calls = 0;
    const broker = await createCredentialBroker({
      database, masterKey, tokens,
      fetchImpl: async (request) => {
        calls += 1;
        expect(new URL(request.url).pathname).toBe('/v4/geocode/location');
        expect(request.headers.get('X-Goog-Api-Key')).toBe('google-secret');
        return Response.json({ results: [] });
      }
    });
    const input = (requestId) => ({
      requestId, operation: 'google-geocoding.reverse',
      parameters: { latitude: 37.422, longitude: -122.084, language: 'en', regionCode: 'US' }
    });
    expect((await call(broker, 'production', input('request-google-01'))).status).toBe(200);
    expect((await call(broker, 'production', input('request-google-02'))).status).toBe(429);
    expect(calls).toBe(1);
  });

  it('preserves actual request accounting when dispatch-result persistence fails', async () => {
    await addGeoapify('Primary', 'geoapify-secret');
    const broker = await createCredentialBroker({ database, masterKey, tokens,
      fetchImpl: async () => Response.json({ results: [] })
    });
    broker.store.report = async () => { throw new Error('Fixture dispatch persistence failure'); };
    const client = new CredentialBrokerClient({ url: 'http://broker.internal', token: tokens.production,
      fetchImpl: (url, init) => broker.api(new Request(url, init))
    });
    let accounted = 0;
    await expect(client.request('geoapify.reverse', reverse('fixture-budget-persistence').parameters, {
      maxDispatches: 1, onDispatch: (count) => { accounted += count; }
    })).rejects.toMatchObject({ code: 'BROKER_INTERNAL_ERROR' });
    expect(accounted).toBe(1);
  });

  it('requires authentication and rejects arbitrary proxy input before dispatch', async () => {
    const broker = await createCredentialBroker({ database, masterKey, tokens });
    const unauthorized = await broker.api(new Request('http://broker.internal/v1/requests', {
      method: 'POST', body: JSON.stringify(reverse('request-auth-01'))
    }));
    expect(unauthorized.status).toBe(401);

    const arbitrary = await call(broker, 'production', {
      requestId: 'request-ssrf-01', operation: 'http.proxy',
      parameters: { url: 'http://169.254.169.254/latest/meta-data' }
    });
    expect(arbitrary.status).toBe(400);
    expect(await arbitrary.json()).toEqual({ code: 'UNSUPPORTED_OPERATION' });

    const injected = await call(broker, 'production', {
      ...reverse('request-ssrf-02'),
      parameters: { ...reverse('unused-id').parameters, url: 'https://attacker.invalid', headers: { Host: 'attacker.invalid' } }
    });
    expect(injected.status).toBe(400);
    expect(await injected.json()).toEqual({ code: 'INVALID_PARAMETERS' });

    const oversized = await call(broker, 'production', JSON.stringify({ value: 'x'.repeat(20_000) }));
    expect(oversized.status).toBe(413);
  });

  it('does not redispatch a completed request id and redacts an echoed secret', async () => {
    await addGeoapify('Primary', 'geoapify-secret-value');
    let calls = 0;
    const broker = await createCredentialBroker({
      database, masterKey, tokens,
      fetchImpl: async (request) => {
        calls += 1;
        return Response.json({ results: [], echoed: new URL(request.url).searchParams.get('apiKey') });
      }
    });
    const input = reverse('request-idempotent-01');
    const first = await call(broker, 'production', input);
    expect(first.status).toBe(200);
    expect(JSON.stringify(await first.json())).not.toContain('geoapify-secret-value');
    const second = await call(broker, 'production', input);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ code: 'REQUEST_ALREADY_COMPLETED' });
    expect(calls).toBe(1);
  });

  it('deletes a used credential without deleting its dispatch history', async () => {
    const id = await addGeoapify('Used credential', 'used-credential-secret');
    const broker = await createCredentialBroker({
      database, masterKey, tokens,
      fetchImpl: async () => Response.json({ results: [] })
    });
    expect((await call(broker, 'production', reverse('request-delete-used-01'))).status).toBe(200);

    await control.deleteCredential(id);

    expect(await database.prepare('SELECT id FROM provider_credentials WHERE id=?').bind(id).first()).toBeNull();
    expect(await database.prepare('SELECT credential_id,status FROM credential_broker_dispatches').first())
      .toEqual({ credential_id: null, status: 'success' });
    expect(await control.listCredentials()).toEqual([]);
    await expect(control.deleteCredential(id)).rejects.toThrow('CREDENTIAL_NOT_FOUND');
  });

  it('finishes a dispatch report after its credential is deleted', async () => {
    const id = await addGeoapify('In-flight credential', 'in-flight-credential-secret');
    let release;
    let started;
    const requestStarted = new Promise((resolve) => { started = resolve; });
    const pendingResponse = new Promise((resolve) => { release = resolve; });
    const broker = await createCredentialBroker({
      database, masterKey, tokens,
      fetchImpl: async () => {
        started();
        await pendingResponse;
        return Response.json({ results: [] });
      }
    });
    const request = call(broker, 'production', reverse('request-delete-in-flight-01'));
    await requestStarted;
    await control.deleteCredential(id);
    release();

    expect((await request).status).toBe(200);
    expect(await database.prepare('SELECT credential_id,status,outcome FROM credential_broker_dispatches').first())
      .toEqual({ credential_id: null, status: 'success', outcome: 'success' });
  });

  it('rotates China provider keys after an official quota response without exposing either key', async () => {
    await control.addCredential({
      provider: 'amap', label: 'Exhausted', secret: 'amap-exhausted-secret', qpsLimit: 10_000, quotaLimit: 100
    });
    await control.addCredential({
      provider: 'amap', label: 'Available', secret: 'amap-available-secret', qpsLimit: 10_000, quotaLimit: 100
    });
    const requestedKeys = [];
    const broker = await createCredentialBroker({
      database, masterKey, tokens,
      fetchImpl: async (request) => {
        const url = new URL(request.url);
        const key = url.searchParams.get('key');
        expect(url.pathname).toBe('/v5/place/text');
        expect(Object.fromEntries(url.searchParams)).toEqual({
          key, region: '110105', types: '120302', city_limit: 'true', page_size: '25',
          page_num: '1', show_fields: 'business'
        });
        requestedKeys.push(key);
        return Response.json(key === 'amap-exhausted-secret'
          ? { status: '0', infocode: '10003', info: 'DAILY_QUERY_OVER_LIMIT' }
          : { status: '1', pois: [] });
      }
    });
    const result = await call(broker, 'production', {
      requestId: 'request-amap-rotation-01', operation: 'amap.place-search',
      parameters: { region: '110105', page: 1, subdivision: '' }
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ data: { status: '1', pois: [] } });
    expect(requestedKeys).toEqual(['amap-exhausted-secret', 'amap-available-secret']);
    expect(JSON.stringify(await control.listCredentials())).not.toContain('amap-exhausted-secret');
    expect(await control.listCredentials()).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Exhausted', status: 'quota_exhausted' }),
      expect.objectContaining({ label: 'Available', status: 'healthy' })
    ]));
  });

  it('falls back from non-JSON AMap v5 once and reserves quota for every upstream request', async () => {
    await control.addCredential({
      provider: 'amap', label: 'AMap', secret: 'amap-fallback-secret', qpsLimit: 10_000, quotaLimit: 3
    });
    const paths = [];
    const broker = await createCredentialBroker({
      database, masterKey, tokens,
      fetchImpl: async (request) => {
        const url = new URL(request.url);
        paths.push(url.pathname);
        if (url.pathname === '/v5/place/text') return new Response('<html>Unavailable</html>');
        expect(Object.fromEntries(url.searchParams)).toEqual({
          key: 'amap-fallback-secret', city: '110105', types: '120302', citylimit: 'true',
          offset: '25', page: '1', extensions: 'all', keywords: 'fixture'
        });
        return Response.json({ status: '1', pois: [] });
      }
    });
    const input = (requestId) => ({ requestId, operation: 'amap.place-search',
      parameters: { region: '110105', page: 1, subdivision: 'fixture' } });
    expect((await call(broker, 'production', input('amap-fallback-01'))).status).toBe(200);
    expect((await call(broker, 'production', input('amap-fallback-02'))).status).toBe(200);
    expect((await call(broker, 'production', input('amap-fallback-03'))).status).toBe(429);
    expect(paths).toEqual(['/v5/place/text', '/v3/place/text', '/v3/place/text']);
    expect(await database.prepare('SELECT COUNT(*) AS total FROM credential_broker_dispatches').first('total')).toBe(3);
    expect(await database.prepare("SELECT COUNT(*) AS total FROM credential_broker_dispatches WHERE status='dispatched'")
      .first('total')).toBe(0);
  });

  it('stops an AMap compatibility failure after v3 also returns non-JSON', async () => {
    await control.addCredential({
      provider: 'amap', label: 'AMap', secret: 'amap-fallback-secret', qpsLimit: 10_000, quotaLimit: 10
    });
    let calls = 0;
    const broker = await createCredentialBroker({ database, masterKey, tokens, fetchImpl: async () => {
      calls += 1;
      return new Response('<html>Unavailable</html>');
    } });
    const response = await call(broker, 'production', {
      requestId: 'amap-invalid-both-01', operation: 'amap.place-search', parameters: { region: '110105', page: 1 }
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: 'UPSTREAM_INVALID_JSON' });
    expect(calls).toBe(2);
    expect((await control.listCredentials())[0].status).toBe('healthy');
  });

  it('preserves the upstream error code when a request fails before receiving a response', async () => {
    const result = await executeOperation({
      definition: operationDefinitions['amap.place-search'],
      parameters: { region: '110000', page: 1, subdivision: '' },
      secret: 'network-fixture-key',
      fetchImpl: async () => { throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }); }
    });
    expect(result).toMatchObject({ type: 'retry', outcome: 'network', providerCode: 'ECONNRESET' });
  });

  it('does not relabel an upstream network failure as a rate limit after key rotation', async () => {
    await addGeoapify('Network failure', 'geoapify-network-secret');
    const broker = await createCredentialBroker({
      database, masterKey, tokens,
      fetchImpl: async () => { throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }); }
    });
    const result = await call(broker, 'production', reverse('request-network-01'));
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ code: 'SOURCE_NETWORK_UNAVAILABLE' });
  });

  it('classifies Baidu concurrency and configuration failures explicitly', () => {
    const classify = operationDefinitions['baidu.place-search'].classify;
    expect(classify({ status: 401, message: 'concurrency exceeded' })).toMatchObject({
      type: 'retry', outcome: 'qps', providerCode: '401'
    });
    expect(classify({ status: 210, message: 'IP validation failed' })).toMatchObject({
      type: 'retry', outcome: 'auth', providerCode: '210'
    });
    expect(classify({ status: 240, message: 'service disabled' })).toMatchObject({
      type: 'retry', outcome: 'auth', providerCode: '240'
    });
  });

  it('updates only the matching quota period after an upstream daily quota response', async () => {
    const id = await control.addCredential({
      provider: 'amap', label: 'AMap dual window', secret: 'amap-dual-window-secret', qpsLimit: 10_000,
      quotaLimit: 100, quotaPeriod: 'day'
    });
    const row = await database.prepare('SELECT quota_scope_id,quota_service,quota_timezone_offset FROM provider_credentials WHERE id=?')
      .bind(id).first();
    const now = new Date().toISOString();
    await database.prepare(`INSERT INTO provider_quota_windows(
      credential_id,service,scope_id,period,limit_count,timezone_offset,source,enabled,created_at,updated_at
    ) VALUES (?,?,?,'month',1000,?,'admin',1,?,?)`).bind(
      id, row.quota_service, row.quota_scope_id, row.quota_timezone_offset, now, now
    ).run();
    const broker = await createCredentialBroker({
      database, masterKey, tokens,
      fetchImpl: async () => Response.json({ status: '0', infocode: '10003', info: 'DAILY_QUERY_OVER_LIMIT' })
    });
    expect((await call(broker, 'production', {
      requestId: 'request-amap-daily-window', operation: 'amap.place-search',
      parameters: { region: '110000', page: 1, subdivision: '' }
    })).status).toBe(429);
    const observations = (await database.prepare(`SELECT period,limit_count FROM provider_quota_observations
      WHERE credential_id=? ORDER BY period`).bind(id).all()).results;
    expect(observations).toEqual([{ period: 'day', limit_count: 100 }]);
  });

  it('records Tencent X-LIMIT usage without requiring a quota error', async () => {
    const id = await control.addCredential({
      provider: 'tencent', label: 'Tencent headers', secret: 'tencent-headers-secret', qpsLimit: 5, quotaLimit: 10_000
    });
    const broker = await createCredentialBroker({
      database, masterKey, tokens,
      fetchImpl: async () => new Response(JSON.stringify({ status: 0, data: [] }), {
        headers: { 'content-type': 'application/json', 'X-Limit': 'current_qps=1;limit_qps=5;current_pv=17;limit_pv=200' }
      })
    });
    expect((await call(broker, 'production', {
      requestId: 'request-tencent-headers', operation: 'tencent.place-search',
      parameters: { region: '北京市', page: 1, subdivision: '' }
    })).status).toBe(200);
    const observation = await database.prepare(`SELECT used_count,limit_count,period
      FROM provider_quota_observations WHERE credential_id=? AND service='place-search'`).bind(id).first();
    expect(observation).toMatchObject({ used_count: 17, limit_count: 200, period: 'day' });
  });

  it('deduplicates simultaneous requests with the same identity', async () => {
    await addGeoapify('Concurrent idempotency', 'concurrent-idempotency-secret');
    let calls = 0;
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const broker = await createCredentialBroker({
      database, masterKey, tokens,
      fetchImpl: async () => { calls += 1; await blocked; return Response.json({ results: [] }); }
    });
    const input = reverse('request-same-id-01');
    const first = call(broker, 'production', input);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = call(broker, 'production', input);
    release();
    const responses = await Promise.all([first, second]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(calls).toBe(1);
  });

  it('atomically enforces a shared quota scope across concurrent requests and keys', async () => {
    const scope = 'geoapify:shared-concurrency-fixture';
    await addGeoapify('First', 'first-secret', { quotaLimit: 4, quotaScopeId: scope });
    await addGeoapify('Second', 'second-secret', { quotaLimit: 4, quotaScopeId: scope });
    let calls = 0;
    const broker = await createCredentialBroker({
      database, masterKey, tokens,
      fetchImpl: async () => { calls += 1; return Response.json({ results: [] }); }
    });
    const responses = await Promise.all(Array.from({ length: 9 }, (_, index) =>
      call(broker, 'production', reverse(`request-concurrent-${index}`))));
    expect(responses.filter(({ status }) => status === 200)).toHaveLength(4);
    expect(calls).toBe(4);
    const counter = await database.prepare(`SELECT dispatch_count,production_count,test_count
      FROM credential_broker_quota_counters WHERE scope_id=?`).bind(scope).first();
    expect(counter).toEqual({ dispatch_count: 4, production_count: 4, test_count: 0 });
  });

  it('checks every active day and month window before dispatch', async () => {
    const id = await addGeoapify('Dual window', 'dual-window-secret', { quotaLimit: 10 });
    const row = await database.prepare('SELECT quota_scope_id FROM provider_credentials WHERE id=?').bind(id).first();
    const now = new Date().toISOString();
    await database.prepare(`INSERT INTO provider_quota_windows(
      credential_id,service,scope_id,period,limit_count,timezone_offset,source,enabled,created_at,updated_at
    ) VALUES (?,'geocode',?,'month',1,0,'admin',1,?,?)`).bind(id, row.quota_scope_id, now, now).run();
    let calls = 0;
    const broker = await createCredentialBroker({
      database, masterKey, tokens,
      fetchImpl: async () => { calls += 1; return Response.json({ results: [] }); }
    });
    expect((await call(broker, 'production', reverse('request-window-01'))).status).toBe(200);
    expect((await call(broker, 'production', reverse('request-window-02'))).status).toBe(429);
    expect(calls).toBe(1);
    const counters = (await database.prepare(`SELECT period,dispatch_count
      FROM credential_broker_quota_counters WHERE scope_id=? ORDER BY period`).bind(row.quota_scope_id).all()).results;
    expect(counters).toEqual([{ period: 'day', dispatch_count: 1 }, { period: 'month', dispatch_count: 1 }]);
  });

  it('applies an upstream quota signal to every key in the shared scope', async () => {
    const scope = 'geoapify:provider-quota-fixture';
    await addGeoapify('Quota first', 'quota-first-secret', { quotaLimit: 10, quotaScopeId: scope });
    await addGeoapify('Quota second', 'quota-second-secret', { quotaLimit: 10, quotaScopeId: scope });
    let calls = 0;
    const broker = await createCredentialBroker({
      database, masterKey, tokens,
      fetchImpl: async () => {
        calls += 1;
        return new Response('{}', { status: 429, headers: { 'Retry-After': '86400' } });
      }
    });
    expect((await call(broker, 'production', reverse('request-provider-quota-01'))).status).toBe(429);
    expect(calls).toBe(1);
    expect(await database.prepare(`SELECT dispatch_count FROM credential_broker_quota_counters
      WHERE scope_id=?`).bind(scope).first('dispatch_count')).toBe(1);
  });

  it('builds only the fixed Mappls Reverse Geocoding request', async () => {
    await control.addCredential({
      provider: 'mappls', label: 'Mappls', secret: 'mappls-secret', qpsLimit: 10_000, quotaLimit: 10
    });
    const upstream = [];
    const broker = await createCredentialBroker({
      database, masterKey, tokens,
      fetchImpl: async (request) => {
        upstream.push(new URL(request.url));
        return Response.json({ responseCode: 200, results: [] });
      }
    });
    const reverse = await call(broker, 'production', {
      requestId: 'request-mappls-reverse-01', operation: 'mappls.reverse',
      parameters: { latitude: 28.6139, longitude: 77.209 }
    });
    expect(reverse.status).toBe(200);
    expect(upstream.map(({ hostname, pathname }) => [hostname, pathname])).toEqual([
      ['search.mappls.com', '/search/address/rev-geocode']
    ]);
  });

  it('builds a fixed OneMap search without returning its bearer token', async () => {
    await control.addCredential({
      provider: 'onemap', label: 'OneMap', secret: 'onemap-secret', qpsLimit: 10_000, quotaLimit: 10
    });
    let upstream;
    const broker = await createCredentialBroker({
      database, masterKey, tokens,
      fetchImpl: async (request) => {
        upstream = request;
        return Response.json({ results: [], echoed: request.headers.get('authorization') });
      }
    });
    const response = await call(broker, 'production', {
      requestId: 'request-onemap-search-01', operation: 'onemap.search',
      parameters: { searchVal: '26 BENDEMEER RD' }
    });
    expect(response.status).toBe(200);
    const url = new URL(upstream.url);
    expect([url.hostname, url.pathname]).toEqual([
      'www.onemap.gov.sg', '/api/common/elastic/search'
    ]);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      searchVal: '26 BENDEMEER RD', returnGeom: 'Y', getAddrDetails: 'Y', pageNum: '1'
    });
    expect(upstream.headers.get('authorization')).toBe('Bearer onemap-secret');
    expect(JSON.stringify(await response.json())).not.toContain('onemap-secret');
  });

  it('repairs stale broker counters from the current OneMap quota window', async () => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = new Date('2026-08-18T12:00:00.000Z');
    const token = `${encode({ alg: 'none' })}.${encode({ exp: Math.floor(now.getTime() / 1000) + 3600 })}.signature`;
    await control.addCredential({
      provider: 'onemap', label: 'OneMap stale counter', secret: token,
      quotaLimit: 100_000_000, qpsLimit: 10_000
    });
    const row = await database.prepare(`SELECT quota_scope_id,quota_service FROM provider_credentials
      WHERE provider='onemap'`).first();
    await database.prepare(`INSERT INTO credential_broker_quota_counters(
      scope_id,service,period,period_start,limit_count,dispatch_count,production_count,test_count,updated_at
    ) VALUES (?,?,?, ?,100,0,0,0,?)`).bind(
      row.quota_scope_id, row.quota_service, 'day', '2026-08-18', now.toISOString()
    ).run();
    const broker = await createCredentialBroker({ database, masterKey, tokens, now: () => now });
    const result = await availability(broker, 'production', ['onemap']);
    expect(await result.json()).toMatchObject({ providers: { onemap: { available: true } } });
    expect(await database.prepare(`SELECT limit_count FROM credential_broker_quota_counters
      WHERE scope_id=? AND service=? AND period='day' AND period_start='2026-08-18'`)
      .bind(row.quota_scope_id, row.quota_service).first('limit_count')).toBe(100_000_000);
  });

  it('blocks expired OneMap tokens with an explicit credential reason', async () => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = new Date('2026-08-18T12:00:00.000Z');
    const token = `${encode({ alg: 'none' })}.${encode({ exp: Math.floor(now.getTime() / 1000) - 60 })}.signature`;
    const id = await control.addCredential({ provider: 'onemap', label: 'Expired OneMap', secret: token });
    const broker = await createCredentialBroker({ database, masterKey, tokens, now: () => now });
    const result = await availability(broker, 'production', ['onemap']);
    expect(await result.json()).toMatchObject({
      providers: { onemap: { available: false, reason: 'api_key_expired:onemap' } }
    });
    expect(await database.prepare('SELECT status FROM provider_credentials WHERE id=?').bind(id).first('status'))
      .toBe('needs_review');
  });

  it('keeps raw provider credentials out of the isolated application containers', async () => {
    const compose = await readFile(new URL('../ops/docker-compose.isolated.yml', import.meta.url), 'utf8');
    expect(compose.match(/env_file:\s*!reset \[\]/gu)).toHaveLength(3);
    expect(compose).toContain('CREDENTIAL_BROKER_TOKEN_FILE: ""');
    expect(compose).toContain('CREDENTIAL_BROKER_TOKEN_FILE: /run/address-secrets/credential_broker_test_token');
    expect(compose).toContain('ADDRESS_PRODUCTION_BROKER_TEST_TOKEN_FILE');
    expect(compose.match(/http:\/\/gateway:8792/gu)).toHaveLength(2);
    expect(compose).not.toContain('ONEMAP_ACCESS_TOKEN');
  });

  it('fails test traffic closed without policy and preserves configured production reserve', async () => {
    await addGeoapify('Policy', 'policy-secret', { quotaLimit: 5 });
    let calls = 0;
    const noPolicy = await createCredentialBroker({
      database, masterKey, tokens,
      fetchImpl: async () => { calls += 1; return Response.json({ results: [] }); }
    });
    expect((await call(noPolicy, 'test', reverse('request-policy-00'))).status).toBe(403);
    expect(calls).toBe(0);

    const broker = await createCredentialBroker({
      database, masterKey, tokens,
      testPolicies: { geoapify: { cap: 2, reserve: 3 } },
      fetchImpl: async () => { calls += 1; return Response.json({ results: [] }); }
    });
    expect((await call(broker, 'test', reverse('request-policy-01'))).status).toBe(200);
    expect((await call(broker, 'test', reverse('request-policy-02'))).status).toBe(200);
    expect((await call(broker, 'test', reverse('request-policy-03'))).status).toBe(429);
    expect((await call(broker, 'production', reverse('request-policy-04'))).status).toBe(200);
    expect(calls).toBe(3);
  });

  it('reports broker-backed provider availability without exposing credentials or consuming quota', async () => {
    await addGeoapify('Availability', 'availability-secret', { quotaLimit: 2 });
    const noPolicy = await createCredentialBroker({ database, masterKey, tokens });
    const production = await availability(noPolicy, 'production', ['geoapify']);
    expect(production.status).toBe(200);
    expect(await production.json()).toMatchObject({
      providers: { geoapify: { provider: 'geoapify', known: true, available: true } }
    });
    const blocked = await availability(noPolicy, 'test', ['geoapify']);
    expect(await blocked.json()).toMatchObject({
      providers: { geoapify: { available: false, waitState: 'blocked', reason: 'broker_test_policy_missing:geoapify' } }
    });
    expect(await database.prepare('SELECT COUNT(*) AS total FROM credential_broker_dispatches').first('total')).toBe(0);

    const broker = await createCredentialBroker({
      database, masterKey, tokens,
      testPolicies: { geoapify: { cap: 1, reserve: 0 } },
      fetchImpl: async () => Response.json({ results: [] })
    });
    expect((await call(broker, 'test', reverse('request-availability-01'))).status).toBe(200);
    const exhausted = await availability(broker, 'test', ['geoapify']);
    expect(await exhausted.json()).toMatchObject({
      providers: { geoapify: { available: false, waitState: 'quota_wait', nextResetAt: expect.any(String) } }
    });
  });

  it('returns the earliest cooldown when every attempted key is rate limited', async () => {
    const now = new Date('2026-08-11T04:00:00.000Z');
    await addGeoapify('Rate limited', 'rate-limited-secret');
    const broker = await createCredentialBroker({
      database, masterKey, tokens, now: () => now,
      fetchImpl: async () => new Response(null, { status: 429 })
    });
    const response = await call(broker, 'production', reverse('request-rate-limit-01'));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      code: 'SOURCE_RATE_LIMITED', nextAvailableAt: '2026-08-11T04:00:02.000Z'
    });
  });

  it('provides a client facade for synchronization workers and queue availability', async () => {
    await addGeoapify('Client', 'client-secret', { quotaLimit: 2 });
    const broker = await createCredentialBroker({
      database, masterKey, tokens,
      fetchImpl: async () => Response.json({ results: [{ postcode: '03000' }] })
    });
    const client = new CredentialBrokerClient({
      url: 'http://broker.internal', token: tokens.production,
      fetchImpl: (input, init) => broker.api(input instanceof Request ? input : new Request(input, init))
    });
    expect(await client.availability(['geoapify'])).toMatchObject({
      geoapify: { available: true, known: true }
    });
    expect(await client.request('geoapify.reverse', {
      latitude: 37.574, longitude: 126.977, language: 'ko'
    }, { requestId: 'request-client-01' })).toEqual({ results: [{ postcode: '03000' }] });
  });

  it('serves queued production work before queued test work', async () => {
    await addGeoapify('Priority', 'priority-secret', { quotaLimit: 20 });
    const order = [];
    let releaseFirst;
    let firstStarted;
    const started = new Promise((resolve) => { firstStarted = resolve; });
    const blocked = new Promise((resolve) => { releaseFirst = resolve; });
    const broker = await createCredentialBroker({
      database, masterKey, tokens,
      testPolicies: { geoapify: { cap: 10, reserve: 5 } },
      fetchImpl: async (request) => {
        const latitude = Number(new URL(request.url).searchParams.get('lat'));
        order.push(latitude);
        if (latitude === 10) { firstStarted(); await blocked; }
        return Response.json({ results: [] });
      }
    });
    const first = call(broker, 'test', reverse('request-priority-01', 10));
    await started;
    const secondTest = call(broker, 'test', reverse('request-priority-02', 20));
    const production = call(broker, 'production', reverse('request-priority-03', 30));
    releaseFirst();
    await Promise.all([first, secondTest, production]);
    expect(order).toEqual([10, 30, 20]);
  });

  it('marks stale dispatches unknown without refunding their reserved counter', async () => {
    const id = await addGeoapify('Stale', 'stale-secret', { quotaLimit: 2 });
    let clock = new Date('2026-08-10T00:00:00.000Z');
    const broker = await createCredentialBroker({
      database, masterKey, tokens, now: () => clock, staleMs: 1_000,
      fetchImpl: async () => Response.json({ results: [] })
    });
    const started = await broker.store.beginRequest({
      clientId: 'production', requestId: 'request-stale-01', provider: 'geoapify',
      operation: 'geoapify.reverse', parametersHash: 'fixture'
    });
    await broker.store.reserve({ requestKey: started.request.id, clientId: 'production', provider: 'geoapify' });
    clock = new Date('2026-08-10T00:00:02.000Z');
    await broker.store.repairStaleRequests();
    expect(await database.prepare('SELECT status FROM credential_broker_requests WHERE id=?')
      .bind(started.request.id).first('status')).toBe('unknown');
    expect(await database.prepare('SELECT status FROM credential_broker_dispatches WHERE credential_id=?')
      .bind(id).first('status')).toBe('unknown');
    expect(await database.prepare('SELECT dispatch_count FROM credential_broker_quota_counters')
      .first('dispatch_count')).toBe(1);
  });

  it('loads distinct identity tokens from environment files and validates policy JSON', async () => {
    const configuration = await loadCredentialBrokerConfiguration({
      CONFIG_MASTER_KEY: masterKey.toString('base64'),
      CREDENTIAL_BROKER_PRODUCTION_TOKEN: tokens.production,
      CREDENTIAL_BROKER_TEST_TOKEN: tokens.test,
      CREDENTIAL_BROKER_TEST_POLICY_JSON: '{"geoapify":{"cap":2,"reserve":3}}'
    });
    expect(configuration.tokens).toEqual(tokens);
    expect(configuration.testPolicies).toEqual({ geoapify: { cap: 2, reserve: 3 } });
  });
});
