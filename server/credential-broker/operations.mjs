import { createHash, randomUUID } from 'node:crypto';
import { retryAtFromHeader } from '../lib/retry-after.mjs';
import { characterCount, deeplLanguages } from './deepl.mjs';
import { OPENAI_COMPATIBLE_TARGETS, openAICompatibleRequest, parseOpenAICompatibleResponse, parseOpenAICompatibleSecret } from './openai-compatible.mjs';

const REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;

const exactKeys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every((key) => allowed.has(key));
const finite = (value, minimum, maximum) => Number.isFinite(value) && value >= minimum && value <= maximum;
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;

const nextPeriod = (period, offsetMinutes = 480) => {
  const shifted = new Date(Date.now() + offsetMinutes * 60_000);
  if (period === 'month') shifted.setUTCMonth(shifted.getUTCMonth() + 1, 1);
  else shifted.setUTCDate(shifted.getUTCDate() + 1);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - offsetMinutes * 60_000).toISOString();
};

const geoapifyReverse = (value) => {
  if (!exactKeys(value, new Set(['latitude', 'longitude', 'language']))
    || !finite(value.latitude, -90, 90) || !finite(value.longitude, -180, 180)) return null;
  const language = value.language === undefined ? 'ko' : String(value.language);
  if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(language)) return null;
  return { latitude: value.latitude, longitude: value.longitude, language };
};

const googleReverse = (value) => {
  if (!exactKeys(value, new Set(['latitude', 'longitude', 'language', 'regionCode']))
    || !finite(value.latitude, -90, 90) || !finite(value.longitude, -180, 180)) return null;
  const language = String(value.language || 'en');
  if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(language)) return null;
  const regionCode = value.regionCode === undefined ? '' : String(value.regionCode).toUpperCase();
  if (regionCode && !/^[A-Z]{2}$/u.test(regionCode)) return null;
  return { latitude: value.latitude, longitude: value.longitude, language, regionCode };
};

const mapplsReverse = (value) => {
  if (!exactKeys(value, new Set(['latitude', 'longitude']))
    || !finite(value.latitude, 6, 38) || !finite(value.longitude, 67, 98)) return null;
  return { latitude: value.latitude, longitude: value.longitude };
};

const chinaPlace = (value) => {
  if (!exactKeys(value, new Set(['region', 'page', 'subdivision']))
    || !/^.{1,100}$/u.test(String(value.region || ''))
    || !integer(value.page, 1, 100)
    || !/^.{0,100}$/u.test(String(value.subdivision || ''))) return null;
  return { region: String(value.region), page: value.page, subdivision: String(value.subdivision || '') };
};

const onemapSearch = (value) => exactKeys(value, new Set(['searchVal']))
  && /^.{1,160}$/u.test(String(value.searchVal || '')) ? { searchVal: String(value.searchVal) } : null;

const providerFailure = (outcome, retryAt = null, metadata = {}) => {
  const base = outcome === 'invalid'
    ? { type: 'error', outcome: 'request', status: 502, code: 'UPSTREAM_REQUEST_REJECTED' }
    : { type: 'retry', outcome, retryAt };
  return {
    ...base,
    ...(metadata.providerCode ? { providerCode: String(metadata.providerCode) } : {}),
    ...(metadata.quotaPeriod ? { quotaPeriod: metadata.quotaPeriod } : {}),
    ...(metadata.service ? { service: String(metadata.service) } : {})
  };
};

const classifyAmap = (body) => {
  if (body?.status === '1') return null;
  const code = String(body?.infocode || '');
  const outcome = ['10003', '10044', '10045', '40000'].includes(code) ? 'quota'
    : ['10004', '10014', '10015', '10019', '10020', '10021', '10029'].includes(code) ? 'qps'
      : ['10001', '10002', '10005', '10006', '10007', '10008', '10009', '10010', '10011', '10012', '10013', '10026', '10041'].includes(code) ? 'auth'
        : 'invalid';
  const retryAt = outcome === 'quota' ? nextPeriod(code === '40000' ? 'month' : 'day')
    : outcome === 'qps' ? new Date(Date.now() + 2_000).toISOString() : null;
  return providerFailure(outcome, retryAt, {
    providerCode: code,
    quotaPeriod: outcome === 'quota' ? (code === '40000' ? 'month' : 'day') : null,
    service: 'place-search'
  });
};

const tencentQuotaObservation = (response) => {
  const values = Object.fromEntries([...String(response?.headers?.get('x-limit') || '')
    .matchAll(/([a-z_]+)\s*=\s*(\d+)/giu)].map((match) => [match[1].toLowerCase(), Number(match[2])]));
  if (!Number.isSafeInteger(values.current_pv) || !Number.isSafeInteger(values.limit_pv)
    || values.current_pv < 0 || values.limit_pv <= 0) return null;
  return { used: values.current_pv, limit: values.limit_pv, period: 'day', service: 'place-search' };
};

const classifyTencent = (body, response) => {
  if (body?.status === 0) {
    const observation = tencentQuotaObservation(response);
    return observation ? { observation } : null;
  }
  const status = Number(body?.status);
  const outcome = status === 120 ? 'qps' : status === 121 ? 'quota'
    : [110, 111, 112].includes(status) ? 'auth' : 'invalid';
  return providerFailure(outcome, outcome === 'quota' ? nextPeriod('day')
    : outcome === 'qps' ? new Date(Date.now() + 2_000).toISOString() : null, {
    providerCode: String(status || ''),
    quotaPeriod: outcome === 'quota' ? 'day' : null,
    service: 'place-search'
  });
};

const classifyBaidu = (body) => {
  if (body?.status === 0) return null;
  const status = Number(body?.status);
  const outcome = [4, 302].includes(status) ? 'quota' : [301, 401].includes(status) ? 'qps'
    : [101, 102, 200, 201, 210, 240].includes(status) ? 'auth' : 'invalid';
  return providerFailure(outcome, outcome === 'quota' ? nextPeriod('day')
    : outcome === 'qps' ? new Date(Date.now() + 2_000).toISOString() : null, {
    providerCode: String(status || ''),
    quotaPeriod: outcome === 'quota' ? 'day' : null,
    service: 'place-search'
  });
};

const classifyGoogle = (body) => {
  if (body && typeof body === 'object' && !Array.isArray(body)
    && (body.results === undefined || Array.isArray(body.results))) return null;
  return providerFailure('invalid', null, { providerCode: 'INVALID_RESPONSE', service: 'geocoding' });
};

const classifyMappls = (body) => {
  const code = Number(body?.responseCode);
  if ((code === 200 || !Number.isFinite(code)) && Array.isArray(body?.results)) return null;
  const outcome = [401, 403].includes(code) ? 'auth' : code === 429 ? 'quota'
    : [500, 503].includes(code) ? 'network' : 'invalid';
  return providerFailure(outcome, null, {
    providerCode: String(code || ''), quotaPeriod: outcome === 'quota' ? 'day' : null, service: 'geocoding'
  });
};

const classifyOpenAICompatible = (body) => typeof body?.choices?.[0]?.message?.content === 'string'
  || Array.isArray(body?.choices?.[0]?.message?.content)
  ? null : providerFailure('invalid', null, { providerCode: 'INVALID_TRANSLATION_RESPONSE', service: 'translation' });

const normalizeOpenAICompatible = (body, parameters) => {
  const translations = parseOpenAICompatibleResponse(body, parameters.values.length);
  return translations ? { translations } : null;
};

export const operationDefinitions = {
  'deepl.usage': {
    provider: 'deepl', usageOnly: true,
    validate(value) {
      if (!exactKeys(value, new Set(['credentialId']))
        || value.credentialId !== undefined && !/^[a-f\d-]{36}$/iu.test(value.credentialId)) return null;
      return value;
    }
  },
  'deepl.translate': {
    provider: 'deepl',
    validate(value) {
      if (!exactKeys(value, new Set(['values', 'target', 'credentialId'])) || !Object.hasOwn(deeplLanguages, value.target)
        || value.credentialId !== undefined && (typeof value.credentialId !== 'string' || !/^[a-f\d-]{36}$/iu.test(value.credentialId))
        || !Array.isArray(value.values) || !value.values.length || value.values.length > 30
        || value.values.some((text) => typeof text !== 'string' || !text.trim())
        || characterCount(value.values) > 5000) return null;
      return { values: value.values, target: value.target,
        ...(value.credentialId === undefined ? {} : { credentialId: value.credentialId }) };
    }
  },
  'openai-compatible.translate': {
    provider: 'openai-compatible',
    validate(value) {
      if (!exactKeys(value, new Set(['values', 'target', 'credentialId', 'prompt'])) || !OPENAI_COMPATIBLE_TARGETS.includes(value.target)
        || !Array.isArray(value.values) || !value.values.length || value.values.length > 30
        || value.values.some((text) => typeof text !== 'string' || !text.trim() || text.length > 300)
        || characterCount(value.values) > 5000
        || value.prompt !== undefined && (typeof value.prompt !== 'string' || value.prompt.length > 4_000)
        || value.credentialId !== undefined && !/^[a-f\d-]{36}$/iu.test(String(value.credentialId))) return null;
      return { values: value.values, target: value.target,
        ...(value.credentialId === undefined ? {} : { credentialId: String(value.credentialId) }),
        ...(value.prompt === undefined ? {} : { prompt: String(value.prompt).trim() }) };
    },
    request(parameters, secret) { return openAICompatibleRequest(secret, parameters.values, parameters.target, { prompt: parameters.prompt }); },
    classify: classifyOpenAICompatible,
    normalize: normalizeOpenAICompatible,
    redactSecrets(secret) {
      const config = parseOpenAICompatibleSecret(secret);
      return config ? [secret, config.apiKey] : [secret];
    }
  },
  'youdao.translate': {
    provider: 'youdao',
    validate(value) {
      if (!exactKeys(value, new Set(['values', 'target', 'credentialId'])) || !['en', 'zh-CN'].includes(value.target)
        || value.credentialId !== undefined && (typeof value.credentialId !== 'string' || !/^[a-f\d-]{36}$/iu.test(value.credentialId))
        || !Array.isArray(value.values) || !value.values.length || value.values.length > 30
        || value.values.some((text) => typeof text !== 'string' || !text.trim())
        || Array.from(value.values.join('')).length > 5000) return null;
      return { values: value.values, target: value.target,
        ...(value.credentialId === undefined ? {} : { credentialId: value.credentialId }) };
    },
    request({ values, target }, secret) {
      const { appKey, appSecret } = JSON.parse(secret);
      if (!appKey || !appSecret) throw new Error('INVALID_YOUDAO_CREDENTIAL');
      const salt = randomUUID();
      const curtime = String(Math.floor(Date.now() / 1000));
      const joined = Array.from(values.join(''));
      const input = joined.length <= 20 ? joined.join('')
        : `${joined.slice(0, 10).join('')}${joined.length}${joined.slice(-10).join('')}`;
      const sign = createHash('sha256').update(`${appKey}${input}${salt}${curtime}${appSecret}`).digest('hex');
      const body = new URLSearchParams({ appKey, salt, curtime, sign, signType: 'v3',
        from: 'auto', to: target === 'zh-CN' ? 'zh-CHS' : target });
      values.forEach((value) => body.append('q', value));
      return new Request('https://openapi.youdao.com/v2/api', {
        method: 'POST', body, headers: { Accept: 'application/json' }
      });
    },
    classify(body) {
      const code = String(body?.errorCode ?? 'INVALID_RESPONSE');
      if (code === '0' && Array.isArray(body.translateResults)) return null;
      const outcome = ['411', '412'].includes(code) ? 'qps'
        : ['108', '202', '203', '401', '402'].includes(code) ? 'auth'
          : ['206', '302', '303', '304'].includes(code) ? 'network' : 'invalid';
      return providerFailure(outcome, outcome === 'qps' ? new Date(Date.now() + 60_000).toISOString() : null,
        { providerCode: code, service: 'translation' });
    },
    redactSecrets(secret) {
      const { appKey, appSecret } = JSON.parse(secret);
      return [secret, appKey, appSecret];
    }
  },
  'amap.place-search': {
    provider: 'amap',
    validate: chinaPlace,
    request(parameters, secret) {
      const url = new URL('https://restapi.amap.com/v5/place/text');
      Object.entries({
        key: secret, region: parameters.region, types: '120302', city_limit: 'true', page_size: '25',
        page_num: String(parameters.page), show_fields: 'business'
      }).forEach(([name, value]) => url.searchParams.set(name, value));
      if (parameters.subdivision) url.searchParams.set('keywords', parameters.subdivision);
      return new Request(url, { headers: { Accept: 'application/json', 'User-Agent': 'address-credential-broker/1.0' } });
    },
    fallbackRequest(parameters, secret) {
      const url = new URL('https://restapi.amap.com/v3/place/text');
      Object.entries({
        key: secret, city: parameters.region, types: '120302', citylimit: 'true', offset: '25',
        page: String(parameters.page), extensions: 'all'
      }).forEach(([name, value]) => url.searchParams.set(name, value));
      if (parameters.subdivision) url.searchParams.set('keywords', parameters.subdivision);
      return new Request(url, { headers: { Accept: 'application/json', 'User-Agent': 'address-credential-broker/1.0' } });
    },
    classify: classifyAmap
  },
  'baidu.place-search': {
    provider: 'baidu',
    validate: chinaPlace,
    request(parameters, secret) {
      const url = new URL('https://api.map.baidu.com/place/v2/search');
      Object.entries({
        ak: secret, query: `${parameters.subdivision}住宅小区`, region: parameters.region, scope: '2',
        page_size: '20', page_num: String(Math.max(0, parameters.page - 1)), output: 'json'
      }).forEach(([name, value]) => url.searchParams.set(name, value));
      return new Request(url, { headers: { Accept: 'application/json', 'User-Agent': 'address-credential-broker/1.0' } });
    },
    classify: classifyBaidu
  },
  'tencent.place-search': {
    provider: 'tencent',
    validate: chinaPlace,
    request(parameters, secret) {
      const url = new URL('https://apis.map.qq.com/ws/place/v1/search');
      Object.entries({
        key: secret, keyword: `${parameters.subdivision}住宅小区`, boundary: `region(${parameters.region},0)`,
        page_size: '20', page_index: String(parameters.page)
      }).forEach(([name, value]) => url.searchParams.set(name, value));
      return new Request(url, { headers: { Accept: 'application/json', 'User-Agent': 'address-credential-broker/1.0' } });
    },
    classify: classifyTencent
  },
  'onemap.search': {
    provider: 'onemap',
    validate: onemapSearch,
    request(parameters, secret) {
      const url = new URL('https://www.onemap.gov.sg/api/common/elastic/search');
      Object.entries({ searchVal: parameters.searchVal, returnGeom: 'Y', getAddrDetails: 'Y', pageNum: '1' })
        .forEach(([name, value]) => url.searchParams.set(name, value));
      return new Request(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${secret}`, 'User-Agent': 'address-credential-broker/1.0' }
      });
    }
  },
  'geoapify.reverse': {
    provider: 'geoapify',
    validate: geoapifyReverse,
    request(parameters, secret) {
      const url = new URL('https://api.geoapify.com/v1/geocode/reverse');
      Object.entries({
        lat: String(parameters.latitude), lon: String(parameters.longitude), format: 'json',
        lang: parameters.language, apiKey: secret
      }).forEach(([name, value]) => url.searchParams.set(name, value));
      return new Request(url, { headers: { Accept: 'application/json', 'User-Agent': 'address-credential-broker/1.0' } });
    }
  },
  'google-geocoding.reverse': {
    provider: 'google-geocoding',
    validate: googleReverse,
    request(parameters, secret) {
      const url = new URL('https://geocode.googleapis.com/v4/geocode/location');
      url.searchParams.set('location.latitude', String(parameters.latitude));
      url.searchParams.set('location.longitude', String(parameters.longitude));
      url.searchParams.set('languageCode', parameters.language);
      if (parameters.regionCode) url.searchParams.set('regionCode', parameters.regionCode);
      return new Request(url, { headers: {
        Accept: 'application/json', 'User-Agent': 'address-credential-broker/1.0',
        'X-Goog-Api-Key': secret,
        'X-Goog-FieldMask': 'results.placeId,results.types,results.addressComponents,results.postalAddress,results.location,results.granularity'
      } });
    },
    classify: classifyGoogle
  },
  'mappls.reverse': {
    provider: 'mappls',
    validate: mapplsReverse,
    request(parameters, secret) {
      const url = new URL('https://search.mappls.com/search/address/rev-geocode');
      Object.entries({
        lat: String(parameters.latitude), lng: String(parameters.longitude),
        region: 'IND', access_token: secret
      }).forEach(([name, value]) => url.searchParams.set(name, value));
      return new Request(url, { headers: { Accept: 'application/json', 'User-Agent': 'address-credential-broker/1.0' } });
    },
    classify: classifyMappls
  }
};

const retryAtFrom = (response) => retryAtFromHeader(response.headers.get('retry-after'));

const jsonBody = async (response) => {
  if (!response.body) return null;
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > RESPONSE_LIMIT_BYTES) throw Object.assign(new Error('UPSTREAM_RESPONSE_TOO_LARGE'), {
      code: 'UPSTREAM_RESPONSE_TOO_LARGE'
    });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const redact = (value, secret) => {
  const encoded = encodeURIComponent(secret);
  const source = JSON.stringify(value);
  return JSON.parse(source.split(secret).join('[REDACTED]').split(encoded).join('[REDACTED]'));
};

export const executeOperation = async ({ definition, parameters, secret, fetchImpl = fetch, signal }) => {
  let request;
  try {
    request = definition.request(parameters, secret);
  } catch (error) {
    return {
      type: 'retry', outcome: 'auth', retryAt: null,
      providerCode: String(error?.code || 'INVALID_PROVIDER_CREDENTIAL')
    };
  }
  let response;
  try {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    response = await fetchImpl(request, {
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
  } catch (error) {
    return {
      type: 'retry', outcome: 'network', retryAt: null,
      providerCode: String(error?.code || error?.name || 'NETWORK_ERROR')
    };
  }
  if (response.status === 401 || response.status === 403) {
    return { type: 'retry', outcome: 'auth', retryAt: null, providerCode: `HTTP_${response.status}`, httpStatus: response.status };
  }
  if (response.status === 429) {
    const retryAt = retryAtFrom(response);
    const quota = definition.provider === 'mappls'
      || retryAt && Date.parse(retryAt) - Date.now() > 5 * 60_000;
    return {
      type: 'retry', outcome: quota ? 'quota' : 'qps', retryAt,
      providerCode: 'HTTP_429', httpStatus: response.status,
      ...(quota ? { quotaPeriod: definition.provider === 'google-geocoding' ? 'month' : 'day' } : {})
    };
  }
  if (response.status >= 500) return {
    type: 'retry', outcome: 'network', retryAt: retryAtFrom(response),
    providerCode: `HTTP_${response.status}`, httpStatus: response.status
  };
  if (!response.ok) return {
    type: 'error', outcome: 'request', status: 502, code: 'UPSTREAM_REQUEST_REJECTED',
    providerCode: `HTTP_${response.status}`, httpStatus: response.status
  };
  try {
    let data = await jsonBody(response);
    const classified = definition.classify?.(data, response);
    if (classified?.type) return classified;
    if (definition.normalize) {
      data = definition.normalize(data, parameters);
      if (!data) return {
        type: 'error', outcome: 'request', status: 502, code: 'UPSTREAM_INVALID_RESPONSE',
        providerCode: 'UPSTREAM_INVALID_RESPONSE'
      };
    }
    return {
      type: 'success', status: 200,
      data: (definition.redactSecrets?.(secret) || [secret]).reduce((value, key) => redact(value, key), data),
      ...(classified?.observation ? { observation: classified.observation } : {})
    };
  } catch (error) {
    const rejected = error instanceof SyntaxError || error?.code === 'UPSTREAM_RESPONSE_TOO_LARGE';
    return {
      type: rejected ? 'error' : 'retry',
      outcome: rejected ? 'request' : 'network',
      status: 502,
      code: error?.code || 'UPSTREAM_INVALID_JSON',
      retryAt: null,
      providerCode: error?.code || 'UPSTREAM_INVALID_JSON'
    };
  }
};
