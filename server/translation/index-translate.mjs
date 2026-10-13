import { retryAtFromHeader } from '../lib/retry-after.mjs';

// bilibili Index-Translate: a translation model behind a keyless chat endpoint whose template accepts one user message.
// Requests follow bilibili's inference/llm/call_api.py instTrans format; reasoning and authorization are never sent.
export const INDEX_TRANSLATE_DEFAULTS = Object.freeze({
  enabled: false, concurrency: 1, baseUrl: 'https://index-translate.bilibili.com/v1', model: 'Index-Translate-35B-A3B'
});
const TIMEOUT_MS = 60_000;
const targetNames = { en: '英语', 'zh-CN': '简体中文' };

const clean = (value) => String(value ?? '').trim();
const httpsOrLocal = (value) => {
  try {
    const url = new URL(clean(value));
    return url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ? url.toString().replace(/\/+$/u, '') : '';
  } catch { return ''; }
};

// Throws INVALID_INDEX_TRANSLATE_SETTINGS for a malformed field; omitted fields keep their current value.
export const normalizeIndexTranslateSettings = (input = {}, current = INDEX_TRANSLATE_DEFAULTS) => {
  const value = { ...INDEX_TRANSLATE_DEFAULTS, ...current };
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_INDEX_TRANSLATE_SETTINGS');
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new Error('INVALID_INDEX_TRANSLATE_SETTINGS');
    value.enabled = input.enabled;
  }
  if (input.concurrency !== undefined) {
    if (!Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 50) throw new Error('INVALID_INDEX_TRANSLATE_SETTINGS');
    value.concurrency = input.concurrency;
  }
  if (input.baseUrl !== undefined) {
    const baseUrl = httpsOrLocal(input.baseUrl);
    if (!baseUrl) throw new Error('INVALID_INDEX_TRANSLATE_SETTINGS');
    value.baseUrl = baseUrl;
  }
  if (input.model !== undefined) {
    if (!/^[\w.:/-]{1,128}$/u.test(clean(input.model))) throw new Error('INVALID_INDEX_TRANSLATE_SETTINGS');
    value.model = clean(input.model);
  }
  return value;
};

export const indexTranslatePrompt = (values, target) => {
  const source = JSON.stringify(Object.fromEntries(values.map((value, index) => [String(index), value])));
  return [
    `请将以下文本翻译成${targetNames[target]}，并且严格遵循所有约束要求。`,
    '',
    '【源文】',
    source,
    '',
    '【约束要求】',
    '1. 【硬性要求】严格保留合法 JSON 语法格式，仅翻译 value 文本',
    '2. 【硬性要求】每个 value 是一个独立的地址组件，逐项翻译，不合并、不补充或推测地理信息',
    '3. 【硬性要求】数字、门牌号、邮编、楼栋单元号和字母数字编号保持原样',
    '4. 【注意】地名使用目标语言通用译名，没有通用译名时音译',
    '',
    '请以相同的 JSON 格式输出翻译结果，key 保持不变，value 为对应译文。只输出 JSON，不要有任何额外说明。'
  ].join('\n');
};

// Accepts the JSON object, optionally after a <think> block or inside a code fence; anything else is rejected.
export const parseIndexTranslateResponse = (content, count) => {
  let text = clean(content);
  if (text.includes('</think>')) text = clean(text.split('</think>').slice(1).join('</think>'));
  text = text.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== count) return null;
  const translations = Array.from({ length: count }, (_, index) => parsed[String(index)]);
  return translations.every((item) => typeof item === 'string' && item.trim()) ? translations.map(clean) : null;
};

const failure = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

// Returns null for targets the route does not serve; throws a coded error for HTTP, network and response failures.
export const indexTranslate = async (values, target, settings = INDEX_TRANSLATE_DEFAULTS, fetchImpl = fetch, signal) => {
  if (!targetNames[target] || !Array.isArray(values) || !values.length || values.length > 30) return null;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(`${settings.baseUrl}/chat/completions`, {
      method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model, messages: [{ role: 'user', content: indexTranslatePrompt(values, target) }],
        temperature: 0, max_tokens: 2048, stream: false, chat_template_kwargs: { enable_thinking: false }
      })
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw failure('INDEX_TRANSLATE_NETWORK_ERROR');
  }
  if (!response.ok) {
    throw failure(`INDEX_TRANSLATE_HTTP_${response.status}`, { status: response.status, retryAt: retryAtFromHeader(response.headers.get('retry-after')) });
  }
  const body = await response.json().catch(() => null);
  const translations = parseIndexTranslateResponse(body?.choices?.[0]?.message?.content, values.length);
  if (!translations) throw failure('INDEX_TRANSLATE_INVALID_RESPONSE');
  return translations;
};

export const INDEX_TRANSLATE_SETTINGS_KEY = 'index_translate_settings';
export const readIndexTranslateSettings = async (database) => {
  const stored = await database.prepare('SELECT value_json FROM system_settings WHERE key=?').bind(INDEX_TRANSLATE_SETTINGS_KEY).first('value_json');
  try { return normalizeIndexTranslateSettings(stored ? JSON.parse(stored) : {}); } catch { return { ...INDEX_TRANSLATE_DEFAULTS }; }
};
