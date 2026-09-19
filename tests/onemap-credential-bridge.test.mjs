import { afterEach, describe, expect, it } from 'vitest';
import { createOneMapCredentialBridge } from '../server/sync/onemap-credential-bridge.mjs';
import { CredentialBrokerClient } from '../server/credential-broker/client.mjs';

describe('OneMap credential bridge', () => {
  const bridges = [];

  afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  });

  it('caps actual dispatches across concurrent queries and credential rotation', async () => {
    const budgets = [];
    const bridge = createOneMapCredentialBridge({
      maxRequests: 3,
      brokerClient: {
        request: async (_operation, _parameters, { maxDispatches, onDispatch }) => {
          budgets.push(maxDispatches);
          onDispatch(Math.min(2, maxDispatches));
          return { results: [] };
        }
      }
    });
    bridges.push(bridge);
    const url = await bridge.start();
    const responses = await Promise.all(Array.from({ length: 3 }, () => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '1 TEST ROAD' })
    })));
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 200, 429]);
    expect(budgets).toEqual([3, 1]);
    expect(bridge.requestCount()).toBe(3);
    expect(await responses.find(({ status }) => status === 429).json())
      .toEqual({ code: 'SOURCE_REQUEST_BUDGET', nextAvailableAt: null });
  });

  it('routes a fixed search operation through the broker without exposing credentials', async () => {
    const calls = [];
    const bridge = createOneMapCredentialBridge({
      brokerClient: {
        request: async (operation, parameters) => {
          calls.push([operation, parameters]);
          return { results: [{ POSTAL: '339944' }] };
        }
      }
    });
    bridges.push(bridge);
    const url = await bridge.start();
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '26 BENDEMEER RD' })
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({ results: [{ POSTAL: '339944' }] });
    expect(calls).toEqual([['onemap.search', { searchVal: '26 BENDEMEER RD' }]]);
    expect(body).not.toContain('Authorization');
    expect(body).not.toContain('Bearer');
  });

  it.each(['lost response', 'missing accounting'])('stops dispatching when broker %s makes the remaining budget unknown', async (failure) => {
    let dispatches = 0;
    const brokerClient = new CredentialBrokerClient({
      url: 'http://broker.internal', token: 'onemap-broker-fixture-token',
      fetchImpl: async (_url, init) => {
        dispatches += JSON.parse(init.body).maxDispatches;
        if (failure === 'missing accounting') return Response.json({ data: { results: [] } });
        throw new TypeError('Fixture lost broker response');
      }
    });
    const bridge = createOneMapCredentialBridge({ brokerClient, maxRequests: 2 });
    bridges.push(bridge);
    const url = await bridge.start();
    const responses = await Promise.all(Array.from({ length: 2 }, () => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '1 TEST ROAD' })
    })));
    expect(responses.map(({ status }) => status)).toEqual([502, 502]);
    expect(dispatches).toBe(2);
    expect(bridge.requestCount()).toBeNull();
  });

  it.each([
    ['SOURCE_QUOTA_UNAVAILABLE', 429, '2026-08-11T00:00:00.000Z'],
    ['SOURCE_CREDENTIAL_UNAVAILABLE', 503, null],
    ['BROKER_UNAVAILABLE', 502, null]
  ])('preserves bounded broker failure %s', async (code, status, retryAt) => {
    const bridge = createOneMapCredentialBridge({
      brokerClient: {
        request: async () => { throw Object.assign(new Error(code), { code, retryAt }); }
      }
    });
    bridges.push(bridge);
    const response = await fetch(await bridge.start(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '26 BENDEMEER RD' })
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code, nextAvailableAt: retryAt });
  });
});
