import { createHash } from 'node:crypto';
import { createCredentialBrokerClient } from '../credential-broker/client.mjs';
import { OPENAI_COMPATIBLE_TIMEOUT_MS } from '../credential-broker/openai-compatible.mjs';
import { googleTranslate } from './address-etl.mjs';
import { indexTranslate, readIndexTranslateSettings } from '../translation/index-translate.mjs';
import { ensureTranslationRoutes, TranslationRouteScheduler, translationRouteRevision, translationRouteStatus } from '../translation/routing.mjs';

const translationRouteScheduler = new TranslationRouteScheduler();
const DEFAULT_GOOGLE_TRANSLATION_CONCURRENCY = 1;
const googleTranslationConcurrency = async (database) => {
  const value = Number(parse(await database.prepare("SELECT value_json FROM system_settings WHERE key='google_translation_concurrency'")
    .first('value_json'), DEFAULT_GOOGLE_TRANSLATION_CONCURRENCY));
  return Number.isInteger(value) && value >= 1 && value <= 50 ? value : DEFAULT_GOOGLE_TRANSLATION_CONCURRENCY;
};
// A key at its concurrency limit answers SOURCE_RATE_LIMITED with a sub-second retry; wait for it instead of failing over.
const waitForBusyKey = async (request, signal) => {
  for (let attempt = 0; ; attempt += 1) {
    try { return await request(); } catch (error) {
      const waitMs = Date.parse(error?.retryAt || '') - Date.now();
      if (error?.code !== 'SOURCE_RATE_LIMITED' || attempt >= 40 || !(waitMs <= 2_000)) throw error;
      signal?.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, Math.max(50, waitMs)));
    }
  }
};

const parse = (value, fallback) => {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
};
export const readBackfillProgress = async (database, key, fallback = {}) => parse(
  await database.prepare('SELECT value_json FROM translation_backfill_progress WHERE key=?').bind(key).first('value_json'), fallback
);
export const writeBackfillProgress = (database, key, value, now) => database.prepare(`
  INSERT INTO translation_backfill_progress(key,value_json,updated_at) VALUES (?,?,?)
  ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
  .bind(key, JSON.stringify(value), now.toISOString()).run();

export const createImportTranslationProviders = async ({ database, environment, fetchImpl = fetch, signal, brokerClient }) => {
  await ensureTranslationRoutes(database);
  const setting = await database.prepare("SELECT value_json FROM system_settings WHERE key='google_translation_enabled'").first('value_json');
  const googleEnabled = setting === null ? !/^(0|false|no)$/iu.test(String(environment.GOOGLE_TRANSLATION_ENABLED ?? 'true')) : parse(setting, false) === true;
  const broker = brokerClient === undefined ? await createCredentialBrokerClient(environment, { fetchImpl }) : brokerClient;
  const googleConcurrency = await googleTranslationConcurrency(database);
  const indexSettings = await readIndexTranslateSettings(database);
  const rows = (await database.prepare(`SELECT route.id,route.provider,route.credential_id,route.priority,route.enabled,
      route.prompt,credential.enabled AS credential_enabled,credential.status,credential.cooldown_until,credential.max_concurrency
    FROM translation_routes route LEFT JOIN provider_credentials credential ON credential.id=route.credential_id
    WHERE route.credential_id IS NOT NULL OR route.provider IN ('google','index-translate')`).all()).results;
  const keylessEnabled = { google: googleEnabled, 'index-translate': indexSettings.enabled };
  const routes = rows.map((row) => ({ ...row, credentialId: row.credential_id, enabled: Boolean(row.enabled) && (row.provider in keylessEnabled
    ? keylessEnabled[row.provider] : Boolean(broker && row.credential_enabled)), status: translationRouteStatus(row.status || 'healthy', row.cooldown_until) }));
  return { translationChain: translationRouteScheduler.order(routes).map((route) => ({ id: route.id, provider: route.provider,
    priority: Number(route.priority),
    maxConcurrency: route.provider === 'google' ? googleConcurrency
      : route.provider === 'index-translate' ? indexSettings.concurrency : Number(route.max_concurrency || 1),
    translate: async (values, target) => {
      if (route.provider === 'google') return googleTranslate(values, target, fetchImpl, signal);
      if (route.provider === 'index-translate') return indexTranslate(values, target, indexSettings, fetchImpl, signal);
      const result = await waitForBusyKey(() => broker.request(`${route.provider}.translate`, {
        values, target, credentialId: route.credentialId,
        ...(route.provider === 'openai-compatible' && route.prompt ? { prompt: route.prompt } : {})
      }, { signal, maxDispatches: route.provider === 'deepl' ? 2 : 1 }), signal);
      if (route.provider === 'deepl') return result.translations.map((item) => item.text);
      if (route.provider === 'youdao') return String(result?.errorCode) === '0'
        ? result.translateResults?.map((item) => item.translation) : null;
      return result.translations;
    }
  })) };
};

export const createBackfillProviders = async ({ database, environment, fetchImpl, signal, now, brokerClient }) => {
  const setting = await database.prepare("SELECT value_json FROM system_settings WHERE key='google_translation_enabled'")
    .first('value_json');
  const googleEnabled = setting === null
    ? /^(1|true|yes)$/iu.test(String(environment.GOOGLE_TRANSLATION_ENABLED || '')) : parse(setting, false) === true;
  const credentials = (await database.prepare(`SELECT id,provider,secret_ciphertext,enabled,quota_limit,quota_period,
    CASE WHEN status='needs_review' THEN 1 ELSE 0 END AS needs_review
    FROM provider_credentials WHERE provider IN ('deepl','youdao','openai-compatible') ORDER BY id`).all()).results;
  await ensureTranslationRoutes(database, now());
  const googleConcurrency = await googleTranslationConcurrency(database);
  const indexSettings = await readIndexTranslateSettings(database);
  const routeRows = (await database.prepare(`SELECT route.id,route.provider,route.credential_id,route.priority,route.enabled,
      route.prompt,route.updated_at,credential.label,credential.enabled AS credential_enabled,
      credential.status AS credential_status,credential.cooldown_until,credential.last_used_at,credential.max_concurrency
    FROM translation_routes route LEFT JOIN provider_credentials credential ON credential.id=route.credential_id
    WHERE route.credential_id IS NOT NULL OR route.provider IN ('google','index-translate')
    ORDER BY route.priority,route.id`).all()).results;
  const routes = routeRows.map((row) => ({
    id: String(row.id), provider: String(row.provider), credentialId: row.credential_id ? String(row.credential_id) : null,
    priority: Number(row.priority), enabled: Boolean(row.enabled) && (row.credential_id ? Boolean(row.credential_enabled) : true),
    prompt: String(row.prompt || ''), status: translationRouteStatus(String(row.credential_status || 'healthy'), row.cooldown_until, now()), model: '',
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null, updatedAt: String(row.updated_at || ''),
    maxConcurrency: row.credential_id ? Number(row.max_concurrency || 1)
      : row.provider === 'index-translate' ? indexSettings.concurrency : googleConcurrency
  }));
  const configured = (provider) => credentials.some((row) => row.provider === provider && row.enabled && !row.needs_review);
  const broker = brokerClient === undefined ? await createCredentialBrokerClient(environment, { fetchImpl }) : brokerClient;
  let availability = {};
  const brokerProviders = ['youdao', 'openai-compatible'].filter(configured);
  if (broker && brokerProviders.length) {
    try { availability = await broker.availability(brokerProviders, { signal }); }
    catch { availability = Object.fromEntries(brokerProviders.map((provider) => [provider, { available: false }])); }
  }
  const revision = createHash('sha256').update(JSON.stringify({ googleEnabled, indexSettings, credentials, routes: translationRouteRevision(routes),
    brokerRevision: Object.fromEntries(Object.entries(availability).map(([provider, value]) => [provider, value?.revision || ''])) })).digest('hex');
  const date = new Date(now().getTime() + 480 * 60_000).toISOString().slice(0, 10);
  const resetAt = new Date(Date.parse(`${date}T16:00:00Z`)).toISOString();
  const state = await readBackfillProgress(database, 'providers');
  const googleRevision = String(googleEnabled);
  if (state.googleRevision !== googleRevision) Object.assign(state, { googleRevision, googleFailures: 0, googleRetryAt: null });
  const indexRevision = JSON.stringify(indexSettings);
  if (state.indexRevision !== indexRevision) Object.assign(state, { indexRevision, indexFailures: 0, indexRetryAt: null });
  let requests = 0;
  let wait = null;
  const unavailable = new Set();
  const dispatched = new Set();
  const failed = new Set();
  const key = (value, target) => JSON.stringify([target, value]);
  const record = (set, values, target) => values.forEach((value) => set.add(key(value, target)));
  const requestLimit = Math.min(100, Math.max(1, Number(environment.TRANSLATION_BACKFILL_REQUESTS) || 100));
  const reserveRequest = (count = 1) => {
    signal.throwIfAborted();
    if (requests + count > requestLimit) {
      wait = { reason: 'batch_budget', retryAt: new Date(now().getTime() + 60_000).toISOString() };
      return false;
    }
    requests += count;
    return true;
  };
  // Keyless routes share one failure budget per route: three failures stop it until its settings change, and HTTP 429
  // only cools it down. State persists before dispatch so a lost response or restart still consumes an attempt.
  const keyless = (name, enabled, call) => async (values, target, _fetch, requestSignal) => {
    const failures = `${name}Failures`;
    const retryAt = `${name}RetryAt`;
    if (!enabled || unavailable.has(name)) return null;
    if (state[retryAt] && Date.parse(state[retryAt]) > now().getTime()) {
      wait = { reason: `${name}_cooldown`, retryAt: state[retryAt] };
      return null;
    }
    if (state[failures] >= 3) return null;
    if (!reserveRequest()) return null;
    state[failures] = (state[failures] || 0) + 1;
    await writeBackfillProgress(database, 'providers', state, now());
    if (signal.aborted) {
      state[failures] -= 1;
      requests -= 1;
      await writeBackfillProgress(database, 'providers', state, now());
      signal.throwIfAborted();
    }
    record(dispatched, values, target);
    try {
      const result = await call(values, target, requestSignal);
      if (!result) throw new Error(`${name.toUpperCase()}_INVALID_RESPONSE`);
      state[failures] = 0;
      state[retryAt] = null;
      await writeBackfillProgress(database, 'providers', state, now());
      return result;
    } catch (error) {
      unavailable.add(name);
      if (/_HTTP_429$/u.test(String(error.code || ''))) state[failures] = Math.max(0, state[failures] - 1);
      else record(failed, values, target);
      state[retryAt] = state[failures] < 3 ? error.retryAt
        || new Date(now().getTime() + 60_000 * 2 ** Math.max(0, state[failures] - 1)).toISOString() : null;
      if (state[retryAt]) wait = { reason: `${name}_cooldown`, retryAt: state[retryAt] };
      await writeBackfillProgress(database, 'providers', state, now());
      if (signal.aborted) throw error;
      return null;
    }
  };
  const providers = {
    async deepl(values, target, _fetch, _signal, credentialId) {
      if (!broker || !configured('deepl')) return null;
      if (!reserveRequest(2)) return null;
      try {
        const result = await broker.request('deepl.translate', { values, target, ...(credentialId ? { credentialId } : {}) }, { signal, maxDispatches: 2,
          onDispatch: (count) => { requests += count - 2; } });
        record(dispatched, values, target);
        return result.translations.map((item) => item.text);
      } catch (error) {
        if (error.retryAt || ['SOURCE_QUOTA_UNAVAILABLE', 'SOURCE_RATE_LIMITED', 'SOURCE_CREDENTIAL_UNAVAILABLE', 'SOURCE_CREDENTIAL_EXPIRED'].includes(error.code)) {
          wait = { reason: error.code, retryAt: error.retryAt || new Date(now().getTime() + 300_000).toISOString() };
        } else { record(dispatched, values, target); record(failed, values, target); }
        signal.throwIfAborted();
        return null;
      }
    },
    google: keyless('google', googleEnabled, (values, target, requestSignal) => googleTranslate(values, target, fetchImpl, requestSignal)),
    'index-translate': keyless('index', indexSettings.enabled,
      (values, target, requestSignal) => indexTranslate(values, target, indexSettings, fetchImpl, requestSignal)),
    async 'openai-compatible'(values, target) {
      if (!broker || !configured('openai-compatible') || !['en', 'zh-CN'].includes(target)) return null;
      const current = availability['openai-compatible'];
      if (!current?.available) {
        if (current?.nextResetAt) wait = { reason: 'openai_compatible_wait', retryAt: current.nextResetAt };
        return null;
      }
      if (!reserveRequest(2)) return null;
      record(dispatched, values, target);
      try {
        const result = await broker.request('openai-compatible.translate', { values, target }, { signal, maxDispatches: 2, timeoutMs: OPENAI_COMPATIBLE_TIMEOUT_MS + 5_000,
          onDispatch: (count) => { requests += count - 2; } });
        return result.translations.map((item) => String(item).trim());
      } catch (error) {
        if (error.retryAt || ['SOURCE_QUOTA_UNAVAILABLE', 'SOURCE_RATE_LIMITED', 'SOURCE_CREDENTIAL_UNAVAILABLE', 'SOURCE_CREDENTIAL_EXPIRED'].includes(error.code)) {
          wait = { reason: error.code, retryAt: error.retryAt || new Date(now().getTime() + 300_000).toISOString() };
        } else record(failed, values, target);
        signal.throwIfAborted();
        return null;
      }
    },
    async youdao(values, target, _fetch, _signal, credentialId) {
      if (!broker || !configured('youdao')) return null;
      const current = availability.youdao;
      if (!current?.available) {
        if (current?.nextResetAt) wait = { reason: 'youdao_wait', retryAt: current.nextResetAt };
        return null;
      }
      if (!reserveRequest()) return null;
      const characters = Array.from(values.join('')).length;
      const ceiling = Math.min(10_000, Math.max(0, Number(environment.TRANSLATION_BACKFILL_YOUDAO_DAILY_CHARACTERS ?? 10_000) || 0));
      await database.prepare(`INSERT INTO translation_backfill_usage(usage_date,reserved_characters)
        VALUES (?,0) ON CONFLICT(usage_date) DO NOTHING`).bind(date).run();
      const reserved = await database.prepare(`UPDATE translation_backfill_usage
        SET reserved_characters=reserved_characters+? WHERE usage_date=? AND reserved_characters+?<=?
        RETURNING reserved_characters`).bind(characters, date, characters, ceiling).first();
      if (!reserved) { wait = { reason: 'youdao_character_budget', retryAt: resetAt }; return null; }
      signal.throwIfAborted();
      record(dispatched, values, target);
      try {
        const result = await broker.request('youdao.translate', { values, target, ...(credentialId ? { credentialId } : {}) }, { signal, maxDispatches: 1 });
        if (String(result?.errorCode) === '0' && result.translateResults?.length === values.length) {
          return result.translateResults.map((item) => String(item.translation || '').trim());
        }
        record(failed, values, target);
        return null;
      } catch (error) {
        if (!credentialId) availability.youdao = { available: false, nextResetAt: error.retryAt || null };
        if (error.retryAt && ['SOURCE_QUOTA_UNAVAILABLE', 'SOURCE_RATE_LIMITED'].includes(error.code)) {
          wait = { reason: error.code, retryAt: error.retryAt };
        } else record(failed, values, target);
        if (signal.aborted) throw error;
        return null;
      }
    }
  };
  const eligibleRoutes = routes.filter((route) => route.enabled && ![
    'disabled', 'needs_review', 'unconfigured', 'expired', 'quota_exhausted', 'cooldown', 'failed'
  ].includes(route.status) && (
    route.provider === 'google' && googleEnabled
      || route.provider === 'index-translate' && indexSettings.enabled
      || ['deepl', 'youdao'].includes(route.provider) && configured(route.provider)
      || route.provider === 'openai-compatible' && route.credentialId
        && configured('openai-compatible') && !['disabled', 'needs_review'].includes(route.status)
  ));
  const translationChain = translationRouteScheduler.order(eligibleRoutes).map((route) => {
    if (route.provider !== 'openai-compatible') {
      const translateProvider = providers[route.provider];
      return {
        id: route.id, provider: route.provider, priority: route.priority, maxConcurrency: route.maxConcurrency,
        translate: (values, target) => translateProvider?.(values, target, fetchImpl, signal, route.credentialId)
      };
    }
    return {
      id: route.id, provider: route.provider, priority: route.priority, maxConcurrency: route.maxConcurrency,
      translate: async (values, target) => {
        if (!broker || !route.credentialId || !reserveRequest()) return null;
        record(dispatched, values, target);
        try {
          const result = await waitForBusyKey(() => broker.request('openai-compatible.translate', {
            values, target, credentialId: route.credentialId,
            ...(route.prompt ? { prompt: route.prompt } : {})
          }, { signal, maxDispatches: 1, timeoutMs: OPENAI_COMPATIBLE_TIMEOUT_MS + 5_000, onDispatch: (count) => { requests += count - 1; } }), signal);
          return result.translations.map((item) => String(item).trim());
        } catch (error) {
          if (error.retryAt || ['SOURCE_QUOTA_UNAVAILABLE', 'SOURCE_RATE_LIMITED', 'SOURCE_CREDENTIAL_UNAVAILABLE', 'SOURCE_CREDENTIAL_EXPIRED'].includes(error.code)) {
            wait = { reason: error.code, retryAt: error.retryAt || new Date(now().getTime() + 300_000).toISOString() };
          } else record(failed, values, target);
          signal.throwIfAborted();
          return null;
        }
      }
    };
  });
  return { providers: { ...providers, translationChain }, translationChain, revision, googleEnabled, indexTranslateEnabled: indexSettings.enabled,
    enabled: Boolean(translationChain.length),
    wasDispatched: (value, target) => dispatched.has(key(value, target)),
    failed: (value, target) => failed.has(key(value, target)),
    get wait() { return wait; }, get requests() { return requests; } };
};
