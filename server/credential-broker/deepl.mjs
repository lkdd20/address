import { createDecipheriv } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const deeplLanguages = { en: 'EN', 'zh-CN': 'ZH-HANS', 'zh-TW': 'ZH-HANT', ja: 'JA', ko: 'KO', de: 'DE', fr: 'FR', es: 'ES', pt: 'PT' };
export const isDeepLFreeKey = (value) => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}:fx$/iu.test(value.trim());
export const characterCount = (values) => values.reduce((sum, value) => sum + Array.from(value).length, 0);

export const deeplBudgetSchema = `CREATE TABLE IF NOT EXISTS deepl_character_budget (
  id INTEGER PRIMARY KEY CHECK (id=1),
  used_count BIGINT NOT NULL DEFAULT 0 CHECK (used_count>=0),
  provider_used BIGINT NOT NULL DEFAULT 0 CHECK (provider_used>=0),
  provider_limit BIGINT NOT NULL DEFAULT 0 CHECK (provider_limit>=0),
  observed_at TEXT,
  period_start TEXT,
  period_end TEXT
);`;

const nextCheck = (now) => new Date(now.getTime() + 5 * 60_000).toISOString();
const decrypt = (row, key) => {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.secret_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(row.secret_tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(row.secret_ciphertext, 'base64')), decipher.final()]).toString('utf8');
};

export const deepLBudgetStatus = async (database) => {
  const row = await database.prepare('SELECT * FROM deepl_character_budget WHERE id=1').first();
  const cap = await database.prepare("SELECT MIN(quota_limit) AS cap FROM provider_credentials WHERE provider='deepl' AND enabled=1").first('cap');
  const limit = Math.min(Number(cap || 0), Number(row?.provider_limit || 0));
  return { used: Number(row?.used_count || 0), limit, remaining: Math.max(0, limit - Number(row?.used_count || 0)),
    providerUsed: Number(row?.provider_used || 0), providerLimit: Number(row?.provider_limit || 0),
    observedAt: row?.observed_at || null, resetAt: row?.period_end || null, unit: 'characters' };
};

export const executeDeepL = async ({ database, masterKey, clientId, testPolicies, requestKey, parameters, usageOnly,
  fetchImpl, now = () => new Date(), signal, maxDispatches, onDispatch = () => {} }) => {
  const fail = (code, status = 503, retryAt = null) => ({ status, body: { code, ...(retryAt ? { nextAvailableAt: retryAt } : {}) } });
  const throwIfCancelled = () => {
    if (signal?.aborted) throw Object.assign(new Error('Credential Broker request was cancelled'), {
      code: 'BROKER_REQUEST_CANCELLED', status: 499
    });
  };
  throwIfCancelled();
  if (clientId === 'test' && !testPolicies.deepl) return fail('BROKER_TEST_POLICY_BLOCKED', 403);
  if (!usageOnly && maxDispatches < 2) return fail('DEEPL_REQUEST_BUDGET_REQUIRED', 400);
  const reviewing = Boolean(usageOnly && parameters.credentialId);
  const rows = (await database.prepare(`SELECT * FROM provider_credentials WHERE provider='deepl' AND enabled=1
    AND status<>'disabled' ORDER BY last_used_at IS NOT NULL,last_used_at,id`).all()).results;
  const disabledRoutes = usageOnly ? new Set() : new Set((await database.prepare(`SELECT credential_id FROM translation_routes
    WHERE provider='deepl' AND credential_id IS NOT NULL AND enabled=0`).all()).results.map((item) => item.credential_id));
  const row = rows.find((item) => (!parameters.credentialId || item.id === parameters.credentialId)
    && !disabledRoutes.has(item.id)
    && (reviewing || item.status !== 'needs_review' && (!item.cooldown_until || item.cooldown_until <= now().toISOString())));
  if (!row) return fail('SOURCE_CREDENTIAL_UNAVAILABLE', 503,
    rows.map((item) => item.cooldown_until).filter(Boolean).sort()[0] || null);
  let secret;
  try { secret = decrypt(row, masterKey); } catch { return fail('SOURCE_CREDENTIAL_EXPIRED'); }
  if (!isDeepLFreeKey(secret)) return fail('DEEPL_FREE_KEY_REQUIRED', 400);
  const headers = { Authorization: `DeepL-Auth-Key ${secret}`, Accept: 'application/json' };
  let response;
  const request = async (path, init = {}) => {
    signal?.throwIfAborted();
    const upstream = new Request(`https://api-free.deepl.com/v2/${path}`, { ...init, headers: { ...headers, ...init.headers } });
    const controller = new AbortController();
    let pending;
    try {
      await database.transaction(async (transaction) => {
        const current = await transaction.prepare('SELECT * FROM provider_credentials WHERE id=? FOR UPDATE').bind(row.id).first();
        if (!current?.enabled || current.status === 'disabled' || !reviewing && current.status === 'needs_review'
          || current.secret_ciphertext !== row.secret_ciphertext) throw Object.assign(new Error('Credential changed'), { code: 'SOURCE_CREDENTIAL_UNAVAILABLE' });
        const waitMs = (Date.parse(current.last_used_at || '') || 0) + Math.ceil(1000 / Number(current.qps_limit || 1)) - now().getTime();
        if (waitMs > 0) await delay(waitMs, undefined, { signal });
        signal?.throwIfAborted();
        onDispatch();
        pending = (async () => fetchImpl(upstream, {
          redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000), ...(signal ? [signal] : [])])
        }))();
        pending.catch(() => {});
        const dispatchedAt = now().toISOString();
        await transaction.prepare('UPDATE provider_credentials SET last_used_at=?,updated_at=? WHERE id=?')
          .bind(dispatchedAt, dispatchedAt, row.id).run();
      });
    } catch (error) {
      controller.abort();
      throw error;
    }
    return pending;
  };
  const reject = async (status) => {
    throwIfCancelled();
    const auth = status === 401 || status === 403;
    const quota = status === 456;
    const failures = Number(row.failure_count || 0) + 1;
    const exhausted = !quota && status !== 429 && failures >= 3;
    const retryAt = auth || exhausted ? null : quota ? nextCheck(now())
      : new Date(now().getTime() + Math.min(300_000, 1000 * 2 ** Math.min(failures, 8))).toISOString();
    await database.prepare(`UPDATE provider_credentials SET status=?,failure_count=?,cooldown_until=?,last_failure_at=?,updated_at=?
      WHERE id=? AND enabled=1 AND secret_ciphertext=?`)
      .bind(auth || exhausted ? 'needs_review' : quota ? 'quota_exhausted' : 'cooldown', failures, retryAt,
        now().toISOString(), now().toISOString(), row.id, row.secret_ciphertext).run();
    return fail(auth ? 'SOURCE_CREDENTIAL_EXPIRED' : quota ? 'SOURCE_QUOTA_UNAVAILABLE'
      : status === 429 ? 'SOURCE_RATE_LIMITED' : 'SOURCE_NETWORK_UNAVAILABLE', auth ? 503 : quota || status === 429 ? 429 : 503, retryAt);
  };
  let usage;
  try {
    response = await request('usage');
    if (!response.ok) return await reject(response.status);
    usage = await response.json();
  } catch (error) { return error.code === 'SOURCE_CREDENTIAL_UNAVAILABLE' ? fail(error.code) : await reject(0); }
  if (!Number.isSafeInteger(usage?.character_count) || usage.character_count < 0
    || !Number.isSafeInteger(usage?.character_limit) || usage.character_limit <= 0) return await reject(0);
  const characters = usageOnly ? 0 : characterCount(parameters.values);
  const reservation = await database.transaction(async (transaction) => {
    await transaction.prepare('INSERT INTO deepl_character_budget(id) VALUES (1) ON CONFLICT(id) DO NOTHING').run();
    const budget = await transaction.prepare('SELECT * FROM deepl_character_budget WHERE id=1 FOR UPDATE').first();
    const credentials = (await transaction.prepare("SELECT id,enabled,status,quota_limit,secret_ciphertext FROM provider_credentials WHERE provider='deepl' ORDER BY id FOR UPDATE").all()).results;
    const current = credentials.find((item) => item.id === row.id);
    if (!current?.enabled || current.status === 'disabled' || !reviewing && current.status === 'needs_review'
      || current.secret_ciphertext !== row.secret_ciphertext) return null;
    const limit = Math.min(usage.character_limit, ...credentials.filter((item) => item.enabled).map((item) => Number(item.quota_limit)));
    const periodStart = Number.isFinite(Date.parse(usage.start_time)) ? new Date(usage.start_time).toISOString() : null;
    const periodEnd = Number.isFinite(Date.parse(usage.end_time)) ? new Date(usage.end_time).toISOString() : null;
    const newPeriod = budget.period_end && periodStart && periodEnd && periodStart >= budget.period_end
      && periodStart <= now().toISOString() && periodEnd > now().toISOString();
    const used = Math.max(newPeriod ? 0 : Number(budget.used_count), usage.character_count);
    await transaction.prepare(`UPDATE deepl_character_budget SET used_count=?,provider_used=?,provider_limit=?,observed_at=?,period_start=?,period_end=? WHERE id=1`)
      .bind(used, usage.character_count, usage.character_limit, now().toISOString(), periodStart, periodEnd).run();
    if (usageOnly) {
      await transaction.prepare(`UPDATE provider_credentials SET status=?,failure_count=0,cooldown_until=NULL,last_success_at=?,updated_at=? WHERE id=?`)
        .bind(used >= limit ? 'quota_exhausted' : 'healthy', now().toISOString(), now().toISOString(), row.id).run();
      return { usage: true };
    }
    const policy = testPolicies.deepl;
    const testCount = clientId === 'test' ? Number(await transaction.prepare(`SELECT COUNT(*) AS total
      FROM credential_broker_dispatches dispatch JOIN credential_broker_requests request ON request.id=dispatch.request_key
      WHERE request.provider='deepl' AND request.client_id='test'`).first('total')) : 0;
    if (used + characters > limit || clientId === 'test'
      && (testCount >= policy.cap || used + characters > Math.max(0, limit - policy.reserve))) return { blocked: true };
    await transaction.prepare('UPDATE deepl_character_budget SET used_count=? WHERE id=1').bind(used + characters).run();
    const dispatch = await transaction.prepare(`INSERT INTO credential_broker_dispatches(request_key,credential_id,status,reserved_at)
      VALUES (?,?,'dispatched',?) RETURNING id`).bind(requestKey, row.id, now().toISOString()).first();
    return { dispatchId: dispatch.id };
  });
  if (!reservation) return fail('SOURCE_CREDENTIAL_UNAVAILABLE');
  if (usageOnly) return { status: 200, body: { data: await deepLBudgetStatus(database) } };
  if (reservation.blocked) return fail('SOURCE_QUOTA_UNAVAILABLE', 429, nextCheck(now()));
  try {
    response = await request('translate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: parameters.values, target_lang: deeplLanguages[parameters.target], show_billed_characters: true }) });
    if (!response.ok) return await reject(response.status);
    const body = await response.json();
    if (!Array.isArray(body?.translations) || body.translations.length !== parameters.values.length
      || body.translations.some((item) => typeof item.text !== 'string' || !item.text.trim()
        || !Number.isSafeInteger(item.billed_characters) || item.billed_characters < 0)
      || body.translations.reduce((sum, item) => sum + item.billed_characters, 0) !== characters) return await reject(0);
    await database.prepare("UPDATE credential_broker_dispatches SET status='success',outcome='success',completed_at=? WHERE id=?")
      .bind(now().toISOString(), reservation.dispatchId).run();
    await database.prepare(`UPDATE provider_credentials SET status='healthy',failure_count=0,cooldown_until=NULL,last_success_at=?,updated_at=?
      WHERE id=? AND enabled=1 AND secret_ciphertext=?`)
      .bind(now().toISOString(), now().toISOString(), row.id, row.secret_ciphertext).run();
    return { status: 200, body: { data: { translations: body.translations.map((item) => ({
      text: item.text.split(secret).join('[REDACTED]'), billed_characters: item.billed_characters
    })) } } };
  } catch (error) { return error.code === 'SOURCE_CREDENTIAL_UNAVAILABLE' ? fail(error.code) : await reject(0); }
  finally {
    await database.prepare("UPDATE credential_broker_dispatches SET status='unknown',outcome=CASE WHEN ? THEN 'cancelled' ELSE outcome END,completed_at=? WHERE id=? AND status='dispatched'")
      .bind(Boolean(signal?.aborted), now().toISOString(), reservation.dispatchId).run();
  }
};
