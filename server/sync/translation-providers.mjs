import { createHash } from 'node:crypto';
import { createCredentialBrokerClient } from '../credential-broker/client.mjs';
import { googleTranslate } from './address-etl.mjs';
import { ensureTranslationRoutes, TranslationRouteScheduler, translationRouteRevision, translationRouteStatus } from '../translation/routing.mjs';

const translationRouteScheduler = new TranslationRouteScheduler();

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
  const rows = (await database.prepare(`SELECT route.id,route.provider,route.credential_id,route.priority,route.enabled,
      route.prompt,credential.enabled AS credential_enabled,credential.status,credential.cooldown_until
    FROM translation_routes route LEFT JOIN provider_credentials credential ON credential.id=route.credential_id
    WHERE route.credential_id IS NOT NULL OR route.provider='google'`).all()).results;
  const routes = rows.map((row) => ({ ...row, credentialId: row.credential_id, enabled: Boolean(row.enabled) && (row.provider === 'google'
    ? googleEnabled : Boolean(broker && row.credential_enabled)), status: translationRouteStatus(row.status || 'healthy', row.cooldown_until) }));
  return { translationChain: translationRouteScheduler.order(routes).map((route) => ({ id: route.id, provider: route.provider,
    translate: async (values, target) => {
      if (route.provider === 'google') return googleTranslate(values, target, fetchImpl, signal);
      const result = await broker.request(`${route.provider}.translate`, {
        values, target, credentialId: route.credentialId,
        ...(route.provider === 'openai-compatible' && route.prompt ? { prompt: route.prompt } : {})
      }, { signal, maxDispatches: route.provider === 'deepl' ? 2 : 1 });
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
  const routeRows = (await database.prepare(`SELECT route.id,route.provider,route.credential_id,route.priority,route.enabled,
      route.prompt,route.updated_at,credential.label,credential.enabled AS credential_enabled,
      credential.status AS credential_status,credential.cooldown_until,credential.last_used_at
    FROM translation_routes route LEFT JOIN provider_credentials credential ON credential.id=route.credential_id
    WHERE route.credential_id IS NOT NULL OR route.provider='google'
    ORDER BY route.priority,route.id`).all()).results;
  const routes = routeRows.map((row) => ({
    id: String(row.id), provider: String(row.provider), credentialId: row.credential_id ? String(row.credential_id) : null,
    priority: Number(row.priority), enabled: Boolean(row.enabled) && (row.credential_id ? Boolean(row.credential_enabled) : true),
    prompt: String(row.prompt || ''), status: translationRouteStatus(String(row.credential_status || 'healthy'), row.cooldown_until, now()), model: '',
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null, updatedAt: String(row.updated_at || '')
  }));
  const configured = (provider) => credentials.some((row) => row.provider === provider && row.enabled && !row.needs_review);
  const broker = brokerClient === undefined ? await createCredentialBrokerClient(environment, { fetchImpl }) : brokerClient;
  let availability = {};
  const brokerProviders = ['youdao', 'openai-compatible'].filter(configured);
  if (broker && brokerProviders.length) {
    try { availability = await broker.availability(brokerProviders, { signal }); }
    catch { availability = Object.fromEntries(brokerProviders.map((provider) => [provider, { available: false }])); }
  }
  const revision = createHash('sha256').update(JSON.stringify({ googleEnabled, credentials, routes: translationRouteRevision(routes),
    brokerRevision: Object.fromEntries(Object.entries(availability).map(([provider, value]) => [provider, value?.revision || ''])) })).digest('hex');
  const date = new Date(now().getTime() + 480 * 60_000).toISOString().slice(0, 10);
  const resetAt = new Date(Date.parse(`${date}T16:00:00Z`)).toISOString();
  const state = await readBackfillProgress(database, 'providers');
  const googleRevision = String(googleEnabled);
  if (state.googleRevision !== googleRevision) Object.assign(state, { googleRevision, googleFailures: 0, googleRetryAt: null });
  let requests = 0;
  let wait = null;
  let googleUnavailable = false;
  const dispatched = new Set();
  const failed = new Set();
  const key = (value, target) => JSON.stringify([target, value]);
  const record = (set, values, target) => values.forEach((value) => set.add(key(value, target)));
  const requestLimit = Math.min(20, Math.max(1, Number(environment.TRANSLATION_BACKFILL_REQUESTS) || 8));
  const reserveRequest = (count = 1) => {
    signal.throwIfAborted();
    if (requests + count > requestLimit) {
      wait = { reason: 'batch_budget', retryAt: new Date(now().getTime() + 60_000).toISOString() };
      return false;
    }
    requests += count;
    return true;
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
    async google(values, target, _fetch, requestSignal) {
      if (!googleEnabled || googleUnavailable) return null;
      if (state.googleRetryAt && Date.parse(state.googleRetryAt) > now().getTime()) {
        wait = { reason: 'google_cooldown', retryAt: state.googleRetryAt };
        return null;
      }
      if (state.googleFailures >= 3) return null;
      if (!reserveRequest()) return null;
      // Persist before dispatch so a lost response or process restart consumes an attempt.
      state.googleFailures = (state.googleFailures || 0) + 1;
      await writeBackfillProgress(database, 'providers', state, now());
      if (signal.aborted) {
        state.googleFailures -= 1;
        requests -= 1;
        await writeBackfillProgress(database, 'providers', state, now());
        signal.throwIfAborted();
      }
      record(dispatched, values, target);
      try {
        const result = await googleTranslate(values, target, fetchImpl, requestSignal);
        if (!result) throw new Error('GOOGLE_INVALID_RESPONSE');
        state.googleFailures = 0;
        state.googleRetryAt = null;
        await writeBackfillProgress(database, 'providers', state, now());
        return result;
      } catch (error) {
        googleUnavailable = true;
        if (error.code === 'GOOGLE_HTTP_429') state.googleFailures = Math.max(0, state.googleFailures - 1);
        else record(failed, values, target);
        state.googleRetryAt = state.googleFailures < 3 ? error.retryAt
          || new Date(now().getTime() + 60_000 * 2 ** Math.max(0, state.googleFailures - 1)).toISOString() : null;
        if (state.googleRetryAt) wait = { reason: 'google_cooldown', retryAt: state.googleRetryAt };
        await writeBackfillProgress(database, 'providers', state, now());
        if (signal.aborted) throw error;
        return null;
      }
    },
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
        const result = await broker.request('openai-compatible.translate', { values, target }, { signal, maxDispatches: 2,
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
      || ['deepl', 'youdao'].includes(route.provider) && configured(route.provider)
      || route.provider === 'openai-compatible' && route.credentialId
        && configured('openai-compatible') && !['disabled', 'needs_review'].includes(route.status)
  ));
  const translationChain = translationRouteScheduler.order(eligibleRoutes).map((route) => {
    if (route.provider !== 'openai-compatible') {
      const translateProvider = providers[route.provider];
      return {
        id: route.id, provider: route.provider,
        translate: (values, target) => translateProvider?.(values, target, fetchImpl, signal, route.credentialId)
      };
    }
    return {
      id: route.id, provider: route.provider,
      translate: async (values, target) => {
        if (!broker || !route.credentialId || !reserveRequest()) return null;
        record(dispatched, values, target);
        try {
          const result = await broker.request('openai-compatible.translate', {
            values, target, credentialId: route.credentialId,
            ...(route.prompt ? { prompt: route.prompt } : {})
          }, { signal, maxDispatches: 1, onDispatch: (count) => { requests += count - 1; } });
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
  return { providers: { ...providers, translationChain }, translationChain, revision, googleEnabled,
    enabled: Boolean(translationChain.length),
    wasDispatched: (value, target) => dispatched.has(key(value, target)),
    failed: (value, target) => failed.has(key(value, target)),
    get wait() { return wait; }, get requests() { return requests; } };
};
