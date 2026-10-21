import manifest from '../src/domain/location-catalog.meta.json' with { type: 'json' };

const base = process.env.API_BASE_URL || 'http://127.0.0.1:8787/api/v1';
const authorization = process.env.API_TOKEN ? { Authorization: `Bearer ${process.env.API_TOKEN}` } : {};
const maxMetadataMs = Number.parseInt(process.env.MAX_METADATA_MS || '3000', 10);
const maxGenerationMs = Number.parseInt(process.env.MAX_ORDINARY_GENERATION_MS || '5000', 10);
const maxGenerationServerMs = Number.parseInt(process.env.MAX_GENERATION_SERVER_P95_MS || '100', 10);
const maxIpGenerationMs = Number.parseInt(process.env.MAX_IP_GENERATION_MS || '30000', 10);
const countryConcurrency = Math.max(1, Math.min(27, Number.parseInt(process.env.LIVE_API_COUNTRY_CONCURRENCY || '4', 10) || 4));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const serverTimings = (header) => Object.fromEntries(
  String(header || '').split(',').map((entry) => {
    const match = entry.trim().match(/^([^;]+);dur=([0-9.]+)$/u);
    return match ? [match[1], Number(match[2])] : [];
  }).filter((entry) => entry.length === 2)
);
const request = async (path, timeoutMs = 15000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${base}${path}`, { headers: authorization, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${path}: timeout after ${timeoutMs}ms`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const payload = await response.json();
  if (!response.ok) throw new Error(`${path}: ${payload.error?.code || response.status}`);
  return { data: payload.data, ms: Date.now() - started, serverTiming: serverTimings(response.headers.get('Server-Timing')) };
};
const get = async (path) => (await request(path)).data;

const collect = async (country, field, params = {}) => {
  const options = [];
  const revisions = new Set();
  let cursor;
  let total = 0;
  do {
    const query = new URLSearchParams({ country, field, limit: '200', ...params });
    if (cursor) query.set('cursor', cursor);
    const data = await get(`/locations/search?${query}`);
    const values = field === 'region' ? data.regions : field === 'city' ? data.cities : data.postcodes;
    total = data.total;
    revisions.add(data.revision || '');
    options.push(...values);
    cursor = data.nextCursor;
  } while (cursor);
  // Pages served from two snapshots cannot be compared; the caller pages again.
  if (revisions.size === 1) {
    assert(options.length === total, `${country} ${field} pagination mismatch ${options.length}/${total}`);
    assert(new Set(options.map((option) => option.id || option.value)).size === options.length, `${country} ${field} duplicate options`);
  }
  return { total, options, revisions };
};

// Generation latency is sampled before the option scans below, whose snapshot rebuilds would otherwise be measured.
const xiamenChinese = await request('/locations/search?country=CN&field=city&q=%E5%8E%A6%E9%97%A8&limit=200');
const xiamenEnglish = await request('/locations/search?country=CN&field=city&q=Xiamen&limit=200');
assert(xiamenChinese.ms <= maxMetadataMs, `Xiamen Chinese search took ${xiamenChinese.ms}ms`);
assert(xiamenEnglish.ms <= maxMetadataMs, `Xiamen English search took ${xiamenEnglish.ms}ms`);
const isXiamen = (city) => city.value === 'Xiamen' || city.en === 'Xiamen' || /厦门/u.test(city.value);
const xiamen = xiamenChinese.data.cities.find(isXiamen) || xiamenEnglish.data.cities.find(isXiamen);
assert(xiamen, 'Xiamen is missing from Chinese and English fuzzy search');
assert(/厦门/u.test(xiamen.label), `Xiamen label is not Chinese-only: ${xiamen.label}`);
assert(!/福建|Fujian|FJ/u.test(xiamen.label), `Xiamen label contains its parent region: ${xiamen.label}`);
for (const residentialMode of [false, true]) {
  const query = new URLSearchParams({
    country: 'CN', city: xiamen.value, cityId: xiamen.id, residential: String(residentialMode),
    strategy: 'instant', seed: `live-xiamen-${residentialMode ? 'residential' : 'ordinary'}`
  });
  if (xiamen.regionId) query.set('regionId', xiamen.regionId);
  if (xiamen.regionValue) query.set('region', xiamen.regionValue);
  const generated = await request(`/generate?${query}`, maxGenerationMs + 5000);
  assert(generated.ms <= maxGenerationMs, `Xiamen ${residentialMode ? 'residential' : 'ordinary'} generation took ${generated.ms}ms`);
  assert(Number.isFinite(generated.serverTiming.total), 'Xiamen generation has no Server-Timing total duration');
  const serverTotals = [];
  for (let sample = 0; sample < 60; sample += 1) {
    query.set('seed', `live-xiamen-p95-${residentialMode}-${sample}`);
    const timed = await request(`/generate?${query}`, maxGenerationMs + 5000);
    assert(Number.isFinite(timed.serverTiming.total), 'Xiamen generation has no Server-Timing total duration');
    serverTotals.push(timed.serverTiming.total);
    // Spaced samples keep one short database stall from landing on several consecutive requests.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  const p95 = serverTotals.sort((left, right) => left - right)[Math.ceil(serverTotals.length * 0.95) - 1];
  assert(p95 <= maxGenerationServerMs, `Xiamen server generation P95 is ${p95}ms (${serverTotals.join(', ')})`);
  assert(generated.data.country === 'CN', 'Xiamen generation returned the wrong country');
  assert(generated.data.sourcesTried?.includes('china-map-community'), 'Xiamen generation did not use the China community pool');
  assert(!generated.data.sourcesTried?.includes('osm-overpass'), 'Xiamen generation entered the online provider path');
  assert(/Xiamen|厦门/u.test(JSON.stringify(generated.data.result?.address)), 'Xiamen generation returned a different city');
  if (residentialMode) assert(generated.data.result?.address?.evidence?.some((item) => item.type === 'residential_use'), 'Xiamen residential generation lacks residential evidence');
}

const countryEntries = Object.entries(manifest.countries);
const published = new Map((await get('/countries')).map((country) => [country.code, country]));
assert(countryEntries.every(([country]) => published.has(country)), 'country registry is missing manifest countries');
const summaries = [];
let nextCountry = 0;
const verifyCountry = async ([country, expected]) => {
  const filters = published.get(country)?.addressSchema?.filters || [];
  const residential = String(country === 'CN');
  const summary = { country, addressCount: published.get(country)?.[country === 'CN' ? 'residentialCount' : 'addressCount'] };
  // Every published address sits under one region option and one city option, so both fields count the same total.
  const counted = ({ options }) => options.reduce((sum, option) => sum + Number(option.availableCount || 0), 0);
  if (filters.includes('region') && filters.includes('city')) {
    // Publication rebuilds the option snapshot while the lists are paged; both lists are compared within one revision.
    let regions;
    let cities;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      regions = await collect(country, 'region', { residential });
      cities = await collect(country, 'city', { residential });
      if (new Set([...regions.revisions, ...cities.revisions]).size === 1) break;
    }
    assert(new Set([...regions.revisions, ...cities.revisions]).size === 1, `${country} option snapshot changed during every scan`);
    assert(regions.total > 0 && cities.total > 0, `${country} has no region or city options`);
    assert(counted(regions) === counted(cities), `${country} region and city counts differ ${counted(regions)}/${counted(cities)}`);
    Object.assign(summary, { regions: regions.total, cities: cities.total, counted: counted(regions) });
  }
  if (filters.includes('postcode') && expected.postcodes > 0) {
    const postcodes = await get(`/locations/search?${new URLSearchParams({ country, field: 'postcode', limit: '200' })}`);
    assert(postcodes.total > 0 && postcodes.postcodes.length > 0, `${country} postcode options are empty`);
    summary.postcodes = postcodes.total;
  }
  return summary;
};
await Promise.all(Array.from({ length: Math.min(countryConcurrency, countryEntries.length) }, async () => {
  while (nextCountry < countryEntries.length) {
    const index = nextCountry++;
    summaries[index] = await verifyCountry(countryEntries[index]);
  }
}));

const usRegions = await get('/locations/search?country=US&field=region&q=California&limit=20');
const california = usRegions.regions.find((region) => region.value === 'California');
assert(california, 'California region is missing');
const losAngeles = await get(`/locations/search?country=US&field=city&regionId=${california.id}&q=Los%20Angeles&limit=20`);
const chicago = await get(`/locations/search?country=US&field=city&regionId=${california.id}&q=Chicago&limit=20`);
assert(losAngeles.cities.some((city) => city.value === 'Los Angeles'), 'California is missing Los Angeles');
assert(!chicago.cities.some((city) => city.value === 'Chicago'), 'California contains Chicago');

const cnRegions = await get('/locations/search?country=CN&field=region&q=%E5%B9%BF%E4%B8%9C&limit=20');
const guangdong = cnRegions.regions.find((region) => region.value === 'Guangdong' || region.en === 'Guangdong');
assert(guangdong, 'Guangdong region is missing');
const shenzhen = await get(`/locations/search?country=CN&field=city&regionId=${guangdong.id}&q=%E6%B7%B1%E5%9C%B3&limit=20`);
assert(shenzhen.cities.some((city) => /Shenzhen/i.test([city.value, city.en, city.label].join(' '))), 'Guangdong is missing Shenzhen');

const registry = await get('/countries');
assert(registry.length === 27, `country registry exposes ${registry.length}/27 countries`);
const availableCountries = new Set();
for (const country of registry) {
  const ordinaryAvailable = Number(country.addressCount) > 0;
  const residentialAvailable = Number(country.residentialCount) > 0 && country.residentialAvailable;
  if (ordinaryAvailable || residentialAvailable) {
    assert(Number(country.addressCount) > 0, `${country.code} ordinary address count is empty`);
    assert(Number(country.residentialCount) <= Number(country.addressCount), `${country.code} residential count exceeds total`);
    if (country.code === 'CN') assert(residentialAvailable, 'China residential address count is empty');
    assert(country.generationMode === 'synchronized-pool', `${country.code} is not using the synchronized pool`);
    availableCountries.add(country.code);
  } else {
    assert(country.generationMode === 'sync-required', `${country.code} unavailable pool is not sync-required`);
  }
}
const residential = [];
for (const country of registry.filter(({ code }) => availableCountries.has(code))) {
  const cities = await get(`/locations/search?country=${country.code}&field=city&residential=${country.code === 'CN'}&limit=20`);
  assert(cities.total > 0, `${country.code} city coverage is empty`);
  residential.push({ country: country.code, cities: cities.total });
}

const ipContext = await request('/client-context?ip=162.141.137.231', maxIpGenerationMs);
assert(ipContext.data.country === 'HK', `162.141.137.231 resolved to ${ipContext.data.country || 'unknown'} instead of HK`);
assert(ipContext.data.supported === true, '162.141.137.231 is not marked as supported');
assert(Number.isFinite(ipContext.data.latitude) && Number.isFinite(ipContext.data.longitude), '162.141.137.231 has no coordinates');
const ipQuery = new URLSearchParams({
  mode: 'ip-region', ip: '162.141.137.231', residential: 'true', strategy: 'instant', seed: 'live-hk-ip', requestId: 'live-hk-ip'
});
const ipGeneration = await request(`/generate?${ipQuery}`, maxIpGenerationMs + 5000);
assert(ipGeneration.ms <= maxIpGenerationMs, `IP-region generation took ${ipGeneration.ms}ms`);
assert(ipGeneration.data.country === 'HK', `IP-region generation returned ${ipGeneration.data.country || 'unknown'} instead of HK`);
assert(ipGeneration.data.ipMatchLevel === 'coordinate', `IP-region match level is ${ipGeneration.data.ipMatchLevel || 'missing'}`);
assert(ipGeneration.data.sourcesTried?.includes('address-pool-v2'), 'IP-region fallback did not reach the local address pool');

console.log(JSON.stringify({
  countries: summaries.length,
  countryConcurrency,
  summaries,
  residential,
  xiamen: { id: xiamen.id, regionId: xiamen.regionId, searchRttMs: [xiamenChinese.ms, xiamenEnglish.ms] },
  ip: {
    country: ipContext.data.country,
    lookupRttMs: ipContext.ms,
    generationRttMs: ipGeneration.ms,
    generationServerMs: ipGeneration.serverTiming.total ?? null,
    matchLevel: ipGeneration.data.ipMatchLevel
  }
}, null, 2));
