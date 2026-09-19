import { createHash } from 'node:crypto';

export const TRANSLATION_ROUTE_PROVIDERS = Object.freeze(['openai-compatible', 'deepl', 'youdao', 'google']);
export const OPENAI_TRANSLATION_ROUTE_PREFIX = 'openai:';
export const TRANSLATION_PROMPT_MAX_LENGTH = 4_000;
export const TRANSLATION_PRIORITY_MIN = 1;
export const TRANSLATION_PRIORITY_MAX = 10_000;
export const DEFAULT_TRANSLATION_ROUTE_PRIORITIES = Object.freeze({
  'openai-compatible': 10,
  deepl: 20,
  youdao: 30,
  google: 40
});
export const translationRoutesSchema = `CREATE TABLE IF NOT EXISTS translation_routes (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('openai-compatible','deepl','youdao','google')),
  credential_id TEXT REFERENCES provider_credentials(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 10000),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  prompt TEXT NOT NULL DEFAULT '' CHECK (length(prompt) <= 4000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, credential_id)
);
CREATE INDEX IF NOT EXISTS idx_translation_routes_order ON translation_routes(enabled,priority,id);
CREATE INDEX IF NOT EXISTS idx_translation_routes_credential ON translation_routes(credential_id);`;

const logicalRoutes = [
  ['deepl', 'deepl', DEFAULT_TRANSLATION_ROUTE_PRIORITIES.deepl],
  ['youdao', 'youdao', DEFAULT_TRANSLATION_ROUTE_PRIORITIES.youdao],
  ['google', 'google', DEFAULT_TRANSLATION_ROUTE_PRIORITIES.google]
];

export const routeIdForCredential = (credentialId, provider = 'openai-compatible') =>
  `${provider === 'openai-compatible' ? 'openai' : provider}:${String(credentialId)}`;

export const translationRouteStatus = (status, cooldownUntil, now = new Date()) =>
  ['cooldown', 'quota_exhausted'].includes(status) && cooldownUntil
    && Date.parse(cooldownUntil) <= new Date(now).getTime() ? 'healthy' : status;

export const normalizeTranslationPrompt = (value) => {
  const prompt = String(value ?? '').trim();
  if (prompt.length > TRANSLATION_PROMPT_MAX_LENGTH) throw new Error('INVALID_TRANSLATION_PROMPT');
  return prompt;
};

export const normalizeTranslationPriority = (value, fallback = DEFAULT_TRANSLATION_ROUTE_PRIORITIES.google) => {
  const priority = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(priority) || priority < TRANSLATION_PRIORITY_MIN || priority > TRANSLATION_PRIORITY_MAX) {
    throw new Error('INVALID_TRANSLATION_PRIORITY');
  }
  return priority;
};

export const translationRouteRevision = (routes) => createHash('sha256')
  .update(JSON.stringify((routes || []).map((route) => [
    route.id, route.provider, route.credentialId || null, route.priority, Boolean(route.enabled), route.prompt || '',
    route.status || '', route.model || '', route.updatedAt || ''
  ]).sort((left, right) => String(left[0]).localeCompare(String(right[0])))))
  .digest('hex');

export const ensureTranslationRoutes = async (database, now = new Date()) => {
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  for (const [id, provider, priority] of logicalRoutes) {
    await database.prepare(`INSERT INTO translation_routes(
      id,provider,credential_id,priority,enabled,prompt,created_at,updated_at
    ) VALUES (?,?,NULL,?,1,'',?,?) ON CONFLICT(id) DO NOTHING`)
      .bind(id, provider, priority, timestamp, timestamp).run();
  }
  const legacy = new Map((await database.prepare(`SELECT provider,priority,enabled FROM translation_routes
    WHERE credential_id IS NULL`).all()).results.map((row) => [row.provider, row]));
  const credentials = (await database.prepare(`SELECT id,provider FROM provider_credentials
    WHERE provider IN ('openai-compatible','deepl','youdao') ORDER BY id`).all()).results;
  for (const credential of credentials) {
    const id = routeIdForCredential(credential.id, credential.provider);
    const previous = legacy.get(credential.provider);
    await database.prepare(`INSERT INTO translation_routes(
      id,provider,credential_id,priority,enabled,prompt,created_at,updated_at
    ) VALUES (?,?,?,?,?,'',?,?) ON CONFLICT(id) DO NOTHING`)
      .bind(id, credential.provider, credential.id, previous?.priority ?? DEFAULT_TRANSLATION_ROUTE_PRIORITIES[credential.provider],
        previous?.enabled ?? 1, timestamp, timestamp).run();
  }
};

export class TranslationRouteScheduler {
  #cursors = new Map();

  order(routes = []) {
    const blockedStatuses = new Set(['disabled', 'needs_review', 'unconfigured', 'expired', 'quota_exhausted', 'cooldown', 'failed']);
    const groups = new Map();
    for (const route of routes) {
      if (!route || route.enabled === false || blockedStatuses.has(route.status)) continue;
      const priority = normalizeTranslationPriority(route.priority);
      const group = groups.get(priority) || [];
      group.push({ ...route, priority });
      groups.set(priority, group);
    }
    const ordered = [];
    for (const [priority, group] of [...groups.entries()].sort(([left], [right]) => left - right)) {
      const sorted = group.slice().sort((left, right) => String(left.id).localeCompare(String(right.id)));
      if (!sorted.length) continue;
      const key = `${priority}:${sorted.map((route) => route.id).join('|')}`;
      const cursor = this.#cursors.get(key) || 0;
      const offset = cursor % sorted.length;
      this.#cursors.set(key, (cursor + 1) % sorted.length);
      ordered.push(...sorted.slice(offset), ...sorted.slice(0, offset));
    }
    return ordered;
  }
}
