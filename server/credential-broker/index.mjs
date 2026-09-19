import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresPool, initializePostgres, PostgresDatabase } from '../database/postgres.mjs';
import { CredentialBrokerStore } from './store.mjs';
import { executeOperation, operationDefinitions } from './operations.mjs';
import { executeDeepL } from './deepl.mjs';

const REQUEST_LIMIT_BYTES = 16 * 1024;
const releaseId = process.env.ADDRESS_RELEASE?.trim() || 'development';
const tokenDigest = (value) => createHash('sha256').update(value).digest();
const parametersDigest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const send = (status, body, headers = {}) => Response.json(body, {
  status,
  headers: { 'Cache-Control': 'no-store', 'X-Address-Release': releaseId, 'X-Address-Upstream-Requests': '0', ...headers }
});

const readBody = async (request) => {
  const chunks = [];
  let bytes = 0;
  if (!request.body) throw Object.assign(new Error('EMPTY_BODY'), { status: 400 });
  for await (const chunk of request.body) {
    bytes += chunk.length;
    if (bytes > REQUEST_LIMIT_BYTES) throw Object.assign(new Error('REQUEST_TOO_LARGE'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('INVALID_JSON'), { status: 400 });
  }
};

class ProviderPriorityGate {
  constructor({ maxPending = 64 } = {}) {
    this.providers = new Map();
    this.maxPending = Math.max(1, Number(maxPending) || 64);
  }

  run(provider, clientId, work, { signal } = {}) {
    return new Promise((resolvePromise, rejectPromise) => {
      if (signal?.aborted) {
        rejectPromise(Object.assign(new Error('Credential Broker request was cancelled'), {
          code: 'BROKER_REQUEST_CANCELLED', status: 499
        }));
        return;
      }
      const state = this.providers.get(provider) || { active: false, production: [], test: [] };
      this.providers.set(provider, state);
      const queue = state[clientId];
      if (queue.length >= this.maxPending) {
        rejectPromise(Object.assign(new Error('Credential Broker queue is full'), {
          code: 'BROKER_QUEUE_FULL', status: 429
        }));
        return;
      }
      const item = { work, resolve: resolvePromise, reject: rejectPromise, cancelled: false };
      const cancel = () => {
        if (item.cancelled) return;
        item.cancelled = true;
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
        rejectPromise(Object.assign(new Error('Credential Broker request was cancelled'), {
          code: 'BROKER_REQUEST_CANCELLED', status: 499
        }));
      };
      item.cancel = cancel;
      signal?.addEventListener('abort', cancel, { once: true });
      queue.push(item);
      this.#drain(state);
    });
  }

  #drain(state) {
    if (state.active) return;
    const item = state.production.shift() || state.test.shift();
    if (!item) return;
    if (item.cancelled) { this.#drain(state); return; }
    state.active = true;
    Promise.resolve().then(item.work).then(item.resolve, item.reject).finally(() => {
      state.active = false;
      this.#drain(state);
    });
  }
}

const authClient = (request, tokens) => {
  const match = /^Bearer\s+(.+)$/iu.exec(request.headers.get('authorization') || '');
  if (!match) return null;
  const received = tokenDigest(match[1]);
  for (const [clientId, token] of Object.entries(tokens)) {
    const expected = tokenDigest(token);
    if (expected.length === received.length && timingSafeEqual(expected, received)) return clientId;
  }
  return null;
};

const retryHeaders = (nextAvailableAt) => {
  if (!nextAvailableAt) return {};
  const seconds = Math.max(1, Math.ceil((Date.parse(nextAvailableAt) - Date.now()) / 1000));
  return Number.isFinite(seconds) ? { 'Retry-After': String(seconds) } : {};
};

export const createCredentialBroker = async ({
  database,
  masterKey,
  tokens,
  testPolicies = {},
  fetchImpl = fetch,
  now,
  staleMs,
  gate = new ProviderPriorityGate({ maxPending: Number(process.env.CREDENTIAL_BROKER_MAX_QUEUE) || 64 })
}) => {
  if (!database) throw new Error('Credential Broker requires a database');
  if (!tokens?.production || !tokens?.test || tokens.production.length < 24 || tokens.test.length < 24
    || tokens.production === tokens.test) throw new Error('Credential Broker requires distinct production and test tokens');
  const store = new CredentialBrokerStore(database, masterKey, { testPolicies, now, staleMs });
  await store.repairStaleRequests();
  const activeRequests = new Set();
  const compatibilityFallbacks = new Set();

  const execute = async ({ clientId, requestKey, definition, parameters, maxDispatches, accounting, signal: providedSignal }) => {
    const excluded = [];
    let lastRetry = null;
    const respond = (status, body, headers = {}) => send(status, body, {
      ...headers, 'X-Address-Upstream-Requests': String(accounting.dispatchCount)
    });
    const signal = providedSignal || AbortSignal.timeout(30_000);
    if (definition.provider === 'deepl') {
      const result = await executeDeepL({ database, masterKey: store.masterKey, clientId, testPolicies: store.testPolicies,
        requestKey, parameters, usageOnly: definition.usageOnly, fetchImpl, now, signal, maxDispatches,
        onDispatch: () => { accounting.dispatchCount += 1; } });
      await store.finishRequest(requestKey, { status: result.status === 200 ? 'completed' : 'failed',
        responseStatus: result.status, errorCode: result.body.code || null });
      return respond(result.status, result.body, retryHeaders(result.body.nextAvailableAt));
    }
    for (let attempt = 0; attempt < maxDispatches; attempt += 1) {
      if (signal.aborted) break;
      const reservation = await store.reserve({
        requestKey, clientId, provider: definition.provider,
        credentialId: parameters.credentialId || null, excludeIds: excluded
      });
      if (!reservation.credential) {
        if (lastRetry && excluded.length) {
          const retryCode = lastRetry.outcome === 'network' ? 'SOURCE_NETWORK_UNAVAILABLE'
            : lastRetry.outcome === 'auth' ? 'SOURCE_CREDENTIAL_EXPIRED'
              : lastRetry.outcome === 'quota' ? 'SOURCE_QUOTA_UNAVAILABLE' : 'SOURCE_RATE_LIMITED';
          const retryStatus = lastRetry.outcome === 'auth' ? 503
            : ['qps', 'quota'].includes(lastRetry.outcome) ? 429 : 503;
          await store.finishRequest(requestKey, {
            status: 'failed', responseStatus: retryStatus, errorCode: retryCode
          });
          return respond(retryStatus, {
            code: retryCode,
            nextAvailableAt: reservation.nextAvailableAt || lastRetry.retryAt || null
          }, retryHeaders(reservation.nextAvailableAt || lastRetry.retryAt));
        }
        const testPolicy = reservation.reason === 'test_policy';
        const status = testPolicy ? 403 : reservation.reason === 'unavailable' ? 503 : 429;
        const code = testPolicy ? 'BROKER_TEST_POLICY_BLOCKED'
          : reservation.reason === 'quota' ? 'SOURCE_QUOTA_UNAVAILABLE'
            : reservation.reason === 'qps' ? 'SOURCE_RATE_LIMITED' : 'SOURCE_CREDENTIAL_UNAVAILABLE';
        const authFailure = reservation.reason === 'auth';
        const responseStatus = authFailure ? 503 : status;
        const responseCode = authFailure ? 'SOURCE_CREDENTIAL_EXPIRED' : code;
        await store.finishRequest(requestKey, { status: 'failed', responseStatus: responseStatus, errorCode: responseCode });
        return respond(responseStatus, { code: responseCode, nextAvailableAt: reservation.nextAvailableAt }, retryHeaders(reservation.nextAvailableAt));
      }
      const usingFallback = compatibilityFallbacks.has(definition);
      const operationParameters = definition.provider === 'openai-compatible'
        ? { ...parameters, prompt: await store.translationPrompt(reservation.credential.id) } : parameters;
      const result = await executeOperation({
        definition: usingFallback ? { ...definition, request: definition.fallbackRequest } : definition,
        parameters: operationParameters, secret: reservation.credential.secret, signal,
        fetchImpl: (...args) => {
          accounting.dispatchCount += 1;
          return fetchImpl(...args);
        }
      });
      if (signal.aborted) {
        await store.cancelDispatch(reservation.dispatchId);
        throw Object.assign(new Error('Credential Broker request was cancelled'), {
          code: 'BROKER_REQUEST_CANCELLED', status: 499
        });
      }
      await store.report({
        dispatchId: reservation.dispatchId,
        outcome: result.outcome || 'success',
        retryAt: result.retryAt,
        providerCode: result.providerCode || null,
        httpStatus: result.httpStatus || null,
        observation: result.observation || null,
        service: result.service || null,
        period: result.quotaPeriod || null
      });
      if (!usingFallback && definition.fallbackRequest && result.code === 'UPSTREAM_INVALID_JSON'
        && result.outcome === 'request') {
        compatibilityFallbacks.add(definition);
        // Reserve the fallback separately so it cannot bypass quota or pacing.
        continue;
      }
      if (result.type === 'success') {
        await store.finishRequest(requestKey, { status: 'completed', responseStatus: result.status });
        return respond(result.status, { data: result.data });
      }
      if (result.type === 'error') {
        await store.finishRequest(requestKey, { status: 'failed', responseStatus: result.status, errorCode: result.code });
        return respond(result.status, { code: result.code });
      }
      lastRetry = result;
      excluded.push(reservation.credential.id);
    }
    const code = signal.aborted || lastRetry?.outcome === 'network' ? 'SOURCE_NETWORK_UNAVAILABLE'
      : lastRetry?.outcome === 'auth' ? 'SOURCE_CREDENTIAL_EXPIRED'
        : lastRetry?.outcome === 'quota' ? 'SOURCE_QUOTA_UNAVAILABLE'
          : lastRetry?.outcome === 'qps' ? 'SOURCE_RATE_LIMITED' : 'SOURCE_CREDENTIAL_UNAVAILABLE';
    await store.finishRequest(requestKey, { status: 'failed', responseStatus: 503, errorCode: code });
    return respond(503, { code, ...(lastRetry?.retryAt ? { nextAvailableAt: lastRetry.retryAt } : {}) });
  };

  const api = async (request) => {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') return send(200, { ok: true });
    if (request.method !== 'POST' || !['/v1/requests', '/v1/availability'].includes(url.pathname)) {
      return send(404, { code: 'NOT_FOUND' });
    }
    const clientId = authClient(request, tokens);
    if (!clientId) return send(401, { code: 'UNAUTHORIZED' });
    let input;
    try { input = await readBody(request); }
    catch (error) { return send(error?.status || 400, { code: error?.message || 'INVALID_REQUEST' }); }
    if (url.pathname === '/v1/availability') {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some((key) => key !== 'providers')
        || !Array.isArray(input.providers) || input.providers.length < 1 || input.providers.length > 10) {
        return send(400, { code: 'INVALID_REQUEST' });
      }
      const providers = [...new Set(input.providers.map(String))];
      if (providers.some((provider) => !['amap', 'baidu', 'tencent', 'onemap', 'geoapify', 'google-geocoding', 'mappls', 'youdao', 'deepl', 'openai-compatible'].includes(provider))) {
        return send(400, { code: 'UNSUPPORTED_PROVIDER' });
      }
      const statuses = await Promise.all(providers.map((provider) => store.availability({ clientId, provider })));
      return send(200, { providers: Object.fromEntries(statuses.map((status) => [status.provider, status])) });
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => !['requestId', 'operation', 'parameters', 'maxDispatches'].includes(key))
      || (input.maxDispatches !== undefined && (!Number.isInteger(input.maxDispatches) || input.maxDispatches < 1 || input.maxDispatches > 32))
      || !/^[A-Za-z0-9._:-]{8,128}$/u.test(String(input.requestId || ''))) {
      return send(400, { code: 'INVALID_REQUEST' });
    }
    const definition = operationDefinitions[input.operation];
    if (!definition) return send(400, { code: 'UNSUPPORTED_OPERATION' });
    const parameters = definition.validate(input.parameters);
    if (!parameters) return send(400, { code: 'INVALID_PARAMETERS' });
    const activeKey = `${clientId}:${input.requestId}`;
    if (activeRequests.has(activeKey)) return send(409, { code: 'REQUEST_IN_PROGRESS' });
    activeRequests.add(activeKey);
    let started;
    const accounting = { dispatchCount: 0 };
    try {
      started = await store.beginRequest({
        clientId,
        requestId: input.requestId,
        provider: definition.provider,
        operation: input.operation,
        parametersHash: parametersDigest(input.maxDispatches === undefined ? parameters : { parameters, maxDispatches: input.maxDispatches })
      });
      if (!started.created) {
        const code = started.conflict ? 'REQUEST_ID_CONFLICT'
          : started.request.status === 'pending' ? 'REQUEST_IN_PROGRESS'
            : started.request.status === 'unknown' ? 'BROKER_OUTCOME_UNKNOWN' : 'REQUEST_ALREADY_COMPLETED';
        return send(409, { code });
      }
      const requestSignal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
      return await gate.run(definition.provider, clientId, () => execute({
        clientId, requestKey: started.request.id, definition, parameters,
        maxDispatches: input.maxDispatches ?? 32, accounting, signal: requestSignal
      }), { signal: requestSignal });
    } catch (error) {
      if (started?.created) await store.finishRequest(started.request.id, {
        status: 'failed', responseStatus: error?.status || 500, errorCode: error?.code || 'BROKER_INTERNAL_ERROR'
      }).catch(() => {});
      const status = Number.isInteger(error?.status) ? error.status : 500;
      const code = typeof error?.code === 'string' ? error.code : 'BROKER_INTERNAL_ERROR';
      return send(status, { code }, {
        'X-Address-Upstream-Requests': String(accounting.dispatchCount)
      });
    } finally {
      activeRequests.delete(activeKey);
    }
  };

  return { api, store };
};

const readSetting = async (environment, name) => {
  if (String(environment[name] || '').trim()) return String(environment[name]).trim();
  const file = String(environment[`${name}_FILE`] || '').trim();
  return file ? String(await readFile(file, 'utf8')).trim() : '';
};

const testPoliciesFrom = (source) => {
  if (!source) return {};
  let parsed;
  try { parsed = JSON.parse(source); } catch { throw new Error('CREDENTIAL_BROKER_TEST_POLICY_JSON is invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).some((provider) => !['amap', 'baidu', 'tencent', 'onemap', 'geoapify', 'google-geocoding', 'mappls', 'youdao', 'deepl', 'openai-compatible'].includes(provider))) {
    throw new Error('CREDENTIAL_BROKER_TEST_POLICY_JSON is invalid');
  }
  return parsed;
};

export const loadCredentialBrokerConfiguration = async (environment = process.env) => ({
  masterKey: await readSetting(environment, 'CONFIG_MASTER_KEY'),
  tokens: {
    production: await readSetting(environment, 'CREDENTIAL_BROKER_PRODUCTION_TOKEN'),
    test: await readSetting(environment, 'CREDENTIAL_BROKER_TEST_TOKEN')
  },
  testPolicies: testPoliciesFrom(environment.CREDENTIAL_BROKER_TEST_POLICY_JSON)
});

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const configuration = await loadCredentialBrokerConfiguration();
  const pool = createPostgresPool({ environment: process.env, application_name: 'address-credential-broker' });
  await initializePostgres(pool);
  const broker = await createCredentialBroker({
    database: new PostgresDatabase(pool),
    ...configuration
  });
  const port = Number.parseInt(process.env.CREDENTIAL_BROKER_PORT || '8792', 10);
  const host = process.env.CREDENTIAL_BROKER_HOST || '127.0.0.1';
  const server = createServer(async (request, response) => {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > REQUEST_LIMIT_BYTES) {
        response.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ code: 'REQUEST_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
      else if (value !== undefined) headers.set(name, value);
    }
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('Credential Broker client disconnected'));
    request.once('aborted', abort);
    response.once('close', abort);
    try {
      const result = await broker.api(new Request(new URL(request.url || '/', 'http://credential-broker.internal'), {
        method: request.method, headers, signal: controller.signal,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {})
      }));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } finally {
      request.removeListener('aborted', abort);
      response.removeListener('close', abort);
    }
  });
  server.listen(port, host, () => console.log(`Credential Broker listening on ${host}:${port}`));
}

export { ProviderPriorityGate };
