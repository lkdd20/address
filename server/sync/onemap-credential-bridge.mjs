import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const readBody = async (request) => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 2048) throw Object.assign(new Error('Bridge request is too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Bridge request is invalid'), { status: 400 }); }
};

const send = (response, status, body) => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  response.end(payload);
};

const bridgeFailure = (error) => {
  const code = String(error?.code || 'ONEMAP_BRIDGE_FAILED');
  const status = ['SOURCE_QUOTA_UNAVAILABLE', 'SOURCE_RATE_LIMITED', 'SOURCE_REQUEST_BUDGET'].includes(code) ? 429
    : code === 'SOURCE_CREDENTIAL_UNAVAILABLE' || code === 'BROKER_TEST_POLICY_BLOCKED' ? 503
      : Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
  return { status, body: { code, nextAvailableAt: error?.retryAt || null } };
};

export const createOneMapCredentialBridge = ({ brokerClient, signal, maxRequests = 500 } = {}) => {
  if (!brokerClient) throw Object.assign(new Error('OneMap requires the credential broker'), {
    code: 'SOURCE_CREDENTIAL_UNAVAILABLE'
  });
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new Error('Invalid OneMap request budget');
  let requestCount = 0;
  let accountingFailure = null;
  let requestTail = Promise.resolve();
  const search = async (query) => {
    let release;
    const previous = requestTail;
    requestTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      signal?.throwIfAborted();
      if (accountingFailure) throw accountingFailure;
      if (requestCount >= maxRequests) throw Object.assign(new Error('OneMap request budget reached'), {
        code: 'SOURCE_REQUEST_BUDGET'
      });
      let accounted = false;
      try {
        return await brokerClient.request('onemap.search', { searchVal: query }, {
          signal, maxDispatches: Math.min(32, maxRequests - requestCount),
          onDispatch: (count) => { accounted = true; requestCount += count; }
        });
      } catch (error) {
        if (!accounted && ['BROKER_UNAVAILABLE', 'BROKER_INVALID_RESPONSE'].includes(error?.code)) accountingFailure = error;
        throw error;
      }
    } finally {
      release();
    }
  };
  const token = randomUUID();
  const path = `/${token}`;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== path) {
      send(response, 404, { code: 'NOT_FOUND' });
      return;
    }
    try {
      const body = await readBody(request);
      const query = String(body?.query || '').trim();
      if (!query || query.length > 160 || Object.keys(body || {}).some((key) => key !== 'query')) {
        send(response, 400, { code: 'INVALID_QUERY' });
        return;
      }
      const payload = await search(query);
      send(response, 200, payload);
    } catch (error) {
      const failure = bridgeFailure(error);
      send(response, failure.status, failure.body);
    }
  });

  return {
    requestCount: () => accountingFailure ? null : requestCount,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      return `http://127.0.0.1:${address.port}${path}`;
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
};
