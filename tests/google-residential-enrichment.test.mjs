import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  evaluateGoogleAddressResults, evaluateGoogleResidentialResult, reconcileGoogleProgressOutput, requestGoogleReverse, selectGoogleResidentialResult
} from '../server/sync/google-residential-enrichment.mjs';
import { executeOperation, operationDefinitions } from '../server/credential-broker/operations.mjs';
import { evaluateMapplsAddressResults } from '../server/sync/mappls-residential-enrichment.mjs';

const seed = {
  building_id: 'way/123',
  building_class: 'apartments',
  latitude: 13.7563,
  longitude: 100.5018,
  ring: [
    [100.5017, 13.7562], [100.5019, 13.7562], [100.5019, 13.7564],
    [100.5017, 13.7564], [100.5017, 13.7562]
  ]
};

const response = (overrides = {}) => ({
  results: [{
    placeId: 'google-place-1',
    types: ['street_address'],
    addressComponents: [
      { longText: '99', shortText: '99', types: ['street_number'] },
      { longText: 'ถนนพระรามที่ 1', shortText: 'ถนนพระรามที่ 1', types: ['route'] },
      { longText: 'ปทุมวัน', shortText: 'ปทุมวัน', types: ['sublocality_level_1'] },
      { longText: 'กรุงเทพมหานคร', shortText: 'กรุงเทพมหานคร', types: ['locality'] },
      { longText: 'กรุงเทพมหานคร', shortText: 'กทม.', types: ['administrative_area_level_1'] },
      { longText: '10330', shortText: '10330', types: ['postal_code'] },
      { longText: 'ประเทศไทย', shortText: 'TH', types: ['country'] }
    ],
    postalAddress: { regionCode: 'TH', postalCode: '10330' },
    granularity: 'ROOFTOP',
    location: { latitude: 13.7563, longitude: 100.5018 },
    ...overrides
  }]
});

describe('Google residential enrichment', () => {
  it('rejects generic Google results outside the seed geometry or conflicting with sourced administration', () => {
    const road = { ...seed, building_id: undefined, building_class: undefined, match_level: 'street',
      admin1: 'กรุงเทพมหานคร', locality: 'กรุงเทพมหานคร' };
    expect(evaluateGoogleAddressResults(response({ location: { latitude: 13.8, longitude: 100.6 } }), road, 'TH').records).toEqual([]);
    const conflicting = response();
    conflicting.results[0].addressComponents = conflicting.results[0].addressComponents.map((entry) =>
      entry.types.includes('locality') ? { ...entry, longText: 'เชียงใหม่' } : entry);
    expect(evaluateGoogleAddressResults(conflicting, road, 'TH').records).toEqual([]);
  });

  it('does not turn a Mappls premise without a residential seed into a residential claim', () => {
    const result = { area: 'India', state: 'Delhi', city: 'New Delhi', district: 'Central Delhi',
      lat: 28.632, lng: 77.219, pincode: '110001' };
    const source = { id: 'node/fixture', number: '12', street: 'MG Road', latitude: 28.632, longitude: 77.219 };
    expect(evaluateMapplsAddressResults({ responseCode: 200, results: [result] }, source).records)
      .toEqual([expect.objectContaining({ number: '12', property_type: 'unknown' })]);
  });
  it('keeps Mappls street results only when they match the source road and administrative facts', () => {
    const road = { id: 'way/road', match_level: 'street', street: 'MG Road', latitude: 28.632, longitude: 77.219,
      admin1: 'Delhi' };
    const result = { area: 'India', state: 'Delhi', city: 'New Delhi', district: 'Central Delhi',
      street: 'MG Road', lat: 28.632, lng: 77.219, pincode: '110001' };
    expect(evaluateMapplsAddressResults({ responseCode: 200, results: [result,
      { ...result, street: 'Other Road' }, { ...result, state: 'Maharashtra' }, { ...result, area: 'Nepal' }
    ] }, road).records).toEqual([expect.objectContaining({ match_level: 'street', street: 'MG Road',
      number: '', postcode: '', property_type: 'unknown' })]);
  });

  it('keeps all usable route results without borrowing residential evidence or postcodes', () => {
    const route = response({ types: ['route'], granularity: 'GEOMETRIC_CENTER',
      addressComponents: response().results[0].addressComponents.filter(({ types }) =>
        !types.includes('street_number') && !types.includes('postal_code')),
      postalAddress: { regionCode: 'TH' }
    }).results[0];
    const records = evaluateGoogleAddressResults({ results: [route,
      { ...route, placeId: 'another-route', addressComponents: route.addressComponents.map((entry) =>
        entry.types.includes('route') ? { ...entry, longText: 'ถนนตัวอย่าง' } : entry) },
      { ...route, placeId: 'partial-route', partialMatch: true },
      { ...route, placeId: 'foreign-route', postalAddress: { regionCode: 'VN' } }
    ] }, seed, 'TH').records;
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ match_level: 'street', number: '', postcode: '', property_type: 'unknown' });
    expect(records.every((record) => !record.residential_building_id && !record.residential_evidence)).toBe(true);
    expect(evaluateGoogleAddressResults({ results: [route] }, seed, 'CN').records).toEqual([]);
  });

  it('preserves real premises without assuming a missing postcode or residential use', () => {
    const payload = response({ postalAddress: { regionCode: 'TH' },
      addressComponents: response().results[0].addressComponents.filter(({ types }) => !types.includes('postal_code')) });
    const records = evaluateGoogleAddressResults(payload, { ...seed, building_id: undefined,
      building_class: undefined, id: 'way/road', match_level: 'street' }, 'TH').records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ match_level: 'premise', number: '99', postcode: '', property_type: 'unknown' });
  });

  it('retains a valid residential result with unambiguous same-response administrative supplementation', () => {
    const original = response().results[0];
    const incomplete = { ...original, addressComponents: original.addressComponents
      .filter(({ types }) => !types.includes('sublocality_level_1')) };
    const political = { ...original, placeId: 'district-result', types: ['political'] };
    const payload = { results: [incomplete, political] };
    expect(evaluateGoogleResidentialResult(payload, seed, 'TH').record).not.toBeNull();
    expect(evaluateGoogleAddressResults(payload, seed, 'TH').records).toEqual([
      expect.objectContaining({ number: '99', district: 'ปทุมวัน', property_type: 'apartment' })
    ]);
  });

  it('accepts only a complete rooftop address aligned to the residential building', () => {
    expect(selectGoogleResidentialResult(response(), seed, 'TH')).toMatchObject({
      number: '99', postcode: '10330', property_type: 'apartment',
      residential_building_id: 'way/123', residential_evidence: 'OSM_BUILDING_GOOGLE=apartments:ROOFTOP'
    });
    expect(selectGoogleResidentialResult(response({ partialMatch: true }), seed, 'TH')).toBeNull();
    expect(selectGoogleResidentialResult(response({
      location: { latitude: 13.76, longitude: 100.51 }
    }), seed, 'TH')).toBeNull();
    expect(selectGoogleResidentialResult(response({
      postalAddress: { regionCode: 'TH' },
      addressComponents: response().results[0].addressComponents.filter(({ types }) => !types.includes('postal_code'))
    }), seed, 'TH')).toBeNull();
  });

  it('normalizes Arabic-Indic digits without weakening the Saudi postcode gate', () => {
    const saudi = response({
      placeId: 'google-saudi-1',
      addressComponents: [
        { longText: '١٢٣', types: ['street_number'] },
        { longText: 'شارع الملك فهد', types: ['route'] },
        { longText: 'العليا', types: ['sublocality_level_1'] },
        { longText: 'الرياض', types: ['locality'] },
        { longText: '١٢٣٤٥', types: ['postal_code'] },
        { longText: 'السعودية', shortText: 'SA', types: ['country'] }
      ],
      postalAddress: { regionCode: 'SA', postalCode: '١٢٣٤٥' }
    });
    expect(selectGoogleResidentialResult(saudi, seed, 'SA')).toMatchObject({
      number: '123', postcode: '12345'
    });

    const misleadingPostalAddress = {
      ...saudi,
      results: [{ ...saudi.results[0], postalAddress: { regionCode: 'SA', postalCode: 'ABCD EFGHI' } }]
    };
    expect(selectGoogleResidentialResult(misleadingPostalAddress, seed, 'SA')).toMatchObject({
      postcode: '12345'
    });
  });

  it('returns anonymous rejection reasons without retaining an upstream address', () => {
    const evaluation = evaluateGoogleResidentialResult(response({
      addressComponents: response().results[0].addressComponents
        .filter(({ types }) => !types.includes('postal_code')),
      postalAddress: { regionCode: 'TH' }
    }), seed, 'TH');
    expect(evaluation).toEqual({ record: null, reason: 'missing_postcode' });
  });

  it('does not borrow a missing postcode from a conflicting city in the same response', () => {
    const detailed = response().results[0];
    const incomplete = { ...detailed, postalAddress: { regionCode: 'TH' },
      addressComponents: detailed.addressComponents.filter(({ types }) => !types.includes('postal_code')) };
    const otherCity = { ...detailed, placeId: 'other-city', types: ['postal_code'],
      addressComponents: detailed.addressComponents.map((entry) => entry.types.includes('locality')
        ? { ...entry, longText: 'เมืองเชียงใหม่' } : entry) };
    expect(evaluateGoogleResidentialResult({ results: [incomplete, otherCity] }, seed, 'TH').record).toBeNull();
  });

  it('rejects conflicting valid postcodes and unsupported countries', () => {
    expect(evaluateGoogleResidentialResult(response({
      postalAddress: { regionCode: 'TH', postalCode: '10110' }
    }), seed, 'TH').record).toBeNull();
    expect(evaluateGoogleResidentialResult(response(), seed, 'ZZ').record).toBeNull();
  });

  it('maps Turkey administrative level four to the required district field', () => {
    const turkeySeed = {
      ...seed,
      latitude: 39.92,
      longitude: 32.85,
      ring: [[32.8499, 39.9199], [32.8501, 39.9199], [32.8501, 39.9201], [32.8499, 39.9201], [32.8499, 39.9199]]
    };
    const turkey = response({
      placeId: 'google-turkey-1',
      types: ['street_address', 'subpremise'],
      addressComponents: [
        { longText: '12', shortText: '12', types: ['street_number'] },
        { longText: 'Ataturk Caddesi', shortText: 'Ataturk Caddesi', types: ['route'] },
        { longText: 'Cankaya', shortText: 'Cankaya', types: ['administrative_area_level_4'] },
        { longText: 'Ankara', shortText: 'Ankara', types: ['administrative_area_level_2'] },
        { longText: 'Ankara', shortText: '06', types: ['administrative_area_level_1'] },
        { longText: '06690', shortText: '06690', types: ['postal_code'] },
        { longText: 'Turkiye', shortText: 'TR', types: ['country'] }
      ],
      postalAddress: { regionCode: 'TR', postalCode: '06690' },
      granularity: 'ROOFTOP',
      location: { latitude: turkeySeed.latitude, longitude: turkeySeed.longitude }
    });
    expect(selectGoogleResidentialResult(turkey, turkeySeed, 'TR')).toMatchObject({
      number: '12', street: 'Ataturk Caddesi', locality: 'Ankara', district: 'Cankaya', postcode: '06690'
    });
  });

  it('does not treat Turkey-specific administrative level four as a district elsewhere', () => {
    const nonTurkey = response({
      addressComponents: response().results[0].addressComponents
        .filter(({ types }) => !types.includes('sublocality_level_1'))
        .map((entry) => entry.types.includes('locality')
          ? { ...entry, longText: 'Example City', shortText: 'Example City' } : entry)
        .concat([{ longText: 'Example District', shortText: 'Example District', types: ['administrative_area_level_4'] }]),
      postalAddress: { regionCode: 'TH', postalCode: '10330' }
    });
    expect(selectGoogleResidentialResult(nonTurkey, seed, 'TH')).toBeNull();
  });

  it('supplements missing postal and administrative fields from the same reverse response', () => {
    const detailed = response().results[0];
    const incomplete = {
      ...detailed,
      addressComponents: detailed.addressComponents.filter(({ types }) =>
        !types.includes('sublocality_level_1') && !types.includes('postal_code')),
      postalAddress: { regionCode: 'TH' }
    };
    const postal = {
      placeId: 'google-postal-area-1',
      types: ['postal_code'],
      addressComponents: detailed.addressComponents.filter(({ types }) =>
        types.some((type) => ['administrative_area_level_1', 'locality', 'sublocality_level_1', 'postal_code', 'country'].includes(type))),
      postalAddress: { regionCode: 'TH', postalCode: '10330' },
      granularity: 'APPROXIMATE',
      location: { latitude: 13.75, longitude: 100.5 }
    };
    expect(selectGoogleResidentialResult({ results: [incomplete, postal] }, seed, 'TH')).toMatchObject({
      number: '99', street: 'ถนนพระรามที่ 1', district: 'ปทุมวัน', postcode: '10330'
    });
  });

  it('rotates local credentials after an authorization failure', async () => {
    const credentials = [{ id: 'bad', secret: 'bad-key' }, { id: 'good', secret: 'good-key' }];
    const reports = [];
    const result = await requestGoogleReverse({
      latitude: seed.latitude,
      longitude: seed.longitude,
      language: 'th',
      credentialPool: {
        acquire: vi.fn(async (_provider, { excludeIds }) => credentials.find(({ id }) => !excludeIds.has(id)) || null),
        report: vi.fn(async (...args) => reports.push(args))
      },
      regionCode: 'TH',
      fetchImpl: vi.fn(async (_url, init) => init.headers['X-Goog-Api-Key'] === 'bad-key'
        ? new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }), { status: 403 })
        : Response.json(response()))
    });
    expect(result.results).toHaveLength(1);
    expect(reports).toEqual([['bad', 'auth'], ['good', 'success']]);
  });

  it('waits for a short broker QPS window inside the same sync task', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), {
        code: 'SOURCE_RATE_LIMITED', retryAt: new Date(Date.now() + 10).toISOString()
      }))
      .mockResolvedValueOnce(response());
    await expect(requestGoogleReverse({
      latitude: seed.latitude,
      longitude: seed.longitude,
      language: 'th',
      regionCode: 'TH',
      brokerClient: { request }
    })).resolves.toMatchObject({ results: expect.any(Array) });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('preserves long broker waits as resumable checkpoints', async () => {
    const error = Object.assign(new Error('rate limited'), {
      code: 'SOURCE_RATE_LIMITED', retryAt: new Date(Date.now() + 60_000).toISOString()
    });
    await expect(requestGoogleReverse({
      latitude: seed.latitude,
      longitude: seed.longitude,
      language: 'th',
      regionCode: 'TH',
      brokerClient: { request: vi.fn().mockRejectedValue(error) }
    })).rejects.toBe(error);
  });

  it('builds the official v4 reverse request with header credentials and field masks', async () => {
    const definition = operationDefinitions['google-geocoding.reverse'];
    const requested = [];
    const result = await executeOperation({
      definition,
      parameters: definition.validate({ latitude: 20, longitude: 78, language: 'en', regionCode: 'IN' }),
      secret: 'google-secret',
      fetchImpl: vi.fn(async (request) => {
        requested.push(new URL(request.url));
        return Response.json({ results: [] });
      })
    });
    expect(result).toMatchObject({ type: 'success', status: 200, data: { results: [] } });
    expect(Object.fromEntries(requested[0].searchParams)).toEqual({
      'location.latitude': '20', 'location.longitude': '78', languageCode: 'en', regionCode: 'IN'
    });
    expect(requested[0].searchParams.has('types')).toBe(false);
    expect(requested[0].searchParams.has('granularity')).toBe(false);
    const request = definition.request(definition.validate({ latitude: 20, longitude: 78, language: 'en', regionCode: 'IN' }), 'google-secret');
    expect(request.url).not.toContain('google-secret');
    expect(request.headers.get('x-goog-api-key')).toBe('google-secret');
    expect(request.headers.get('x-goog-fieldmask')).toContain('results.postalAddress');
  });

  it('classifies Google HTTP throttling without inventing a monthly reset', async () => {
    const definition = operationDefinitions['google-geocoding.reverse'];
    const result = await executeOperation({
      definition,
      parameters: definition.validate({ latitude: 20, longitude: 78, language: 'en' }),
      secret: 'google-secret',
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }), {
        status: 429, headers: { 'retry-after': '2' }
      }))
    });
    expect(result).toMatchObject({ type: 'retry', outcome: 'qps', retryAt: expect.any(String) });
  });

  it('accepts the empty object returned by Google v4 for zero results', async () => {
    const definition = operationDefinitions['google-geocoding.reverse'];
    const result = await executeOperation({
      definition,
      parameters: definition.validate({ latitude: 12.58851755, longitude: 4.894037273, language: 'en', regionCode: 'NG' }),
      secret: 'google-secret',
      fetchImpl: async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    });
    expect(result).toMatchObject({ type: 'success', status: 200, data: {} });
  });

  it('truncates output written after the last durable checkpoint', async () => {
    const directory = resolve('.data-cache', `google-progress-${process.pid}-${Date.now()}`);
    const output = resolve(directory, 'records.jsonl');
    await mkdir(directory, { recursive: true });
    await writeFile(output, [
      { source_record_id: 'seed-1:place-1' },
      { source_record_id: 'seed-2:place-2' }
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');
    try {
      await expect(reconcileGoogleProgressOutput(output, { nextIndex: 1, accepted: 1 })).resolves.toBe(true);
      expect((await readFile(output, 'utf8')).trim().split('\n')).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a checkpoint whose accepted output is missing', async () => {
    const directory = resolve('.data-cache', `google-progress-invalid-${process.pid}-${Date.now()}`);
    const output = resolve(directory, 'records.jsonl');
    await mkdir(directory, { recursive: true });
    try {
      await expect(reconcileGoogleProgressOutput(output, { nextIndex: 1, accepted: 1 }))
        .rejects.toMatchObject({ code: 'SOURCE_STATE_INVALID' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
