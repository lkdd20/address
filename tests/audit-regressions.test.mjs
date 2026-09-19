import { it, expect } from 'vitest';
import { openTestDatabase, initializeTestDatabase } from './helpers/postgres-test-database.mjs';
import { ControlStore } from '../server/control/store.ts';
import { localizeAddressRecords } from '../server/sync/address-etl.mjs';
import { createImportTranslationProviders } from '../server/sync/translation-providers.mjs';
import { translateAddressComponents } from '../server/api/services/address-translation.ts';
import { eligibleAddresses } from './fixtures/catalog.ts';
import { ensureAddressPolicies, upsertNodeTarget, deleteNodeTarget, deleteNodePolicy, listCountryNodeTargets, upsertNodePolicy, loadImportPolicy, applyHierarchicalQuota, policyNodeKeys } from '../server/sync/address-policy.mjs';
import { retryAtFromHeader } from '../server/lib/retry-after.mjs';
import { evaluateCountryGoals } from '../server/sync/country-goals.mjs';
import { fetchOpenAICompatibleModels } from '../server/credential-broker/openai-compatible.mjs';
import { ChinaCoverageTracker } from '../server/china/service.ts';

const key = Buffer.alloc(32, 23);
const tokens = { production: 'review-production-fixture-token-0001', test: 'review-testing-fixture-token-0000002' };
const setup = async () => {
  const database = openTestDatabase(':memory:');
  await initializeTestDatabase(database, new URL('../server/control/schema.sql', import.meta.url));
  const control = new ControlStore(database, key);
  await control.initialize('review-synthetic-admin-password');
  await control.setSetting('google_translation_enabled', false);
  return { database, control };
};

it.each(['lower', 'upper'])('honors Chinese coverage overrides with %s-case legacy compatibility', (casing) => {
  const hex = Buffer.from('北京市').toString('hex');
  const tracker = new ChinaCoverageTracker([{ province: '北京市', city: '北京市', district: '东城区', adcode: '110101',
    count: 5 }], { minPerNode: 1, coverageRatio: 1, level1Min: 1, level2Min: 1 },
  new Map([[`CN:a1:${casing === 'upper' ? hex.toUpperCase() : hex}`, 10]]));
  expect(tracker.met()).toBe(false);
  expect(tracker.needsSync('110101')).toBe(true);
  expect(tracker.deficit('110101')).toBe(5);
  tracker.record('110101', 5);
  expect(tracker.met()).toBe(true);
});
it('migrates legacy node settings idempotently without reviving cleared canonical settings', async () => {
  const { database } = await setup();
  const canonical = `DE:a1:${Buffer.from('Berlin').toString('hex')}`;
  const legacy = `DE:a1:${Buffer.from('Berlin').toString('hex').toUpperCase()}`;
  try {
    await ensureAddressPolicies(database);
    await database.prepare('DELETE FROM sync_node_overrides WHERE node_key=?').bind(canonical).run();
    const insertLegacy = () => database.prepare(`INSERT INTO sync_node_overrides(node_key,country_code,level,target_count,min_count,updated_at)
      VALUES (?,'DE',1,777,2222,'2099-01-01T00:00:00Z')`).bind(legacy).run();
    await insertLegacy();
    await database.transaction((transaction) => ensureAddressPolicies(transaction));
    expect(await database.prepare('SELECT target_count,min_count FROM sync_node_overrides WHERE node_key=?').bind(canonical).first())
      .toEqual({ target_count: 777, min_count: 2222 });
    await deleteNodeTarget(database, legacy);
    await deleteNodePolicy(database, legacy);
    await insertLegacy();
    await ensureAddressPolicies(database);
    await ensureAddressPolicies(database);
    expect(await database.prepare('SELECT target_count,min_count FROM sync_node_overrides WHERE node_key=?').bind(canonical).first())
      .toEqual({ target_count: null, min_count: null });
    expect(await database.prepare('SELECT node_key FROM sync_node_overrides WHERE node_key=?').bind(legacy).first()).toBeNull();
  } finally { await database.close(); }
});

it('preserves PostgreSQL lowercase hex semantics in test fixtures', async () => {
  const { database } = await setup();
  try {
    expect(await database.prepare("SELECT encode(convert_to('Berlin','UTF8'),'hex') AS value").first('value')).toBe('4265726c696e');
  } finally { await database.close(); }
});

it.each([
  [null, null], ['', null], ['   ', null], ['-1', null], ['invalid', null], ['1e100', null],
  ['0', '2026-09-19T00:00:00.000Z'], ['120', '2026-09-19T00:02:00.000Z'],
  ['Sat, 19 Sep 2026 00:10:00 GMT', '2026-09-19T00:10:00.000Z']
])('parses bounded Retry-After values: %s', (value, expected) => {
  expect(retryAtFromHeader(value, Date.parse('2026-09-19T00:00:00Z'))).toBe(expected);
});

it('matches PostgreSQL node keys for import limits and seeded completion minimums', async () => {
  const { database } = await setup();
  try {
    await ensureAddressPolicies(database);
    await database.prepare("UPDATE sync_country_policies SET target_count=5,level1_limit=1,level2_limit=0,level3_limit=0,min_per_node=1,level1_min=0,level2_min=0 WHERE country_code='DE'").run();
    const coverageKey = `DE:a1:${Buffer.from('Berlin').toString('hex')}`;
    await database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_name,total_count,updated_at)
      VALUES (?,'DE','DE',1,'Berlin',1,'2026-09-19T00:00:00Z'),('DE','','DE',0,'Germany',1,'2026-09-19T00:00:00Z')`).bind(coverageKey).run();
    await upsertNodePolicy(database, coverageKey, 3);
    const records = [1, 2, 3].map((number) => ({ countryCode: 'DE', components: { admin1: 'Berlin', locality: 'Berlin', street: 'Teststrasse', houseNumber: String(number) } }));
    const selected = applyHierarchicalQuota(records, await loadImportPolicy(database, 'DE', 10, 10));
    await database.prepare("UPDATE sync_country_policies SET target_count=1 WHERE country_code='DE'").run();
    const goal = (await evaluateCountryGoals(database)).get('DE');
    expect(policyNodeKeys(records[0])[0]).toBe(coverageKey);
    expect(selected).toHaveLength(3);
    expect(goal.complete).toBe(false);
    expect(goal.rules.regionalMinimums.overrides).toMatchObject({ total: 2, met: false });
  } finally { await database.close(); }
});

it('uses configured key priority for initial online ETL', async () => {
  const { database, control } = await setup();
  try {
    await control.addCredential({ provider: 'openai-compatible', label: 'First choice', apiKey: 'synthetic-api-key',
      baseUrl: 'https://fixture.example/v1', model: 'fixture', translationPriority: 1 });
    await control.addCredential({ provider: 'deepl', label: 'Second choice',
      secret: '11111111-1111-4111-8111-111111111111:fx', translationPriority: 50 });
    const routes = (await control.translationRoutes()).filter((route) => route.credentialId);
    const calls = [];
    const translations = { 'Main Street': '主街', Springfield: '斯普林菲尔德', Illinois: '伊利诺伊州' };
    await localizeAddressRecords([{ countryCode: 'US', nativeLanguage: 'en', formattedAddress: '18 Main Street',
      components: { houseNumber: '18', street: 'Main Street', locality: 'Springfield', admin1: 'Illinois', admin1Code: 'IL', postcode: '62701' } }], {
      database, environment: { ADDRESS_SYNC_TRANSLATION_ENABLED: 'true', GOOGLE_TRANSLATION_ENABLED: 'false',
        CREDENTIAL_BROKER_URL: 'http://broker.fixture', CREDENTIAL_BROKER_TOKEN: tokens.production },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body); calls.push({ operation: body.operation, pinned: Boolean(body.parameters.credentialId) });
        return Response.json({ data: { translations: body.parameters.values.map((value) => body.operation === 'deepl.translate' ? { text: translations[value] || value } : translations[value] || value) } });
      }
    });
    expect(routes[0].provider).toBe('openai-compatible');
    expect(calls).toEqual([{ operation: 'openai-compatible.translate', pinned: true }]);
  } finally { await database.close(); }
});

it('invalidates localized address caches when source components change', async () => {
  const { database } = await setup();
  try {
    const base = eligibleAddresses('GB', false, new Date('2026-07-20T00:00:00Z'))[0];
    const address = (street) => ({ ...base, components: { ...base.components, street }, componentVariants: {
      ...base.componentVariants, native: { ...base.componentVariants.native, street }, en: { ...base.componentVariants.en, street } } });
    let calls = 0;
    const bindings = { LOCATION_DB: database, TRANSLATION_ROUTES: [{ id: 'fixture', provider: 'fixture', translate: async (values) => {
      calls++; return values.map((value) => value === 'Main Street' ? 'Rue Principale' : value === 'Oak Street' ? 'Rue des Chenes' : value);
    } }] };
    const first = await translateAddressComponents(address('Main Street'), 'fr', bindings);
    expect(first.status).toBe('translated');
    const second = await translateAddressComponents(address('Oak Street'), 'fr', bindings);
    expect(second).toMatchObject({ status: 'translated', components: { street: 'Rue des Chenes' } });
    expect(calls).toBe(2);
    expect(await translateAddressComponents(address('Oak Street'), 'fr', bindings)).toEqual(second);
    expect(calls).toBe(2);
  } finally { await database.close(); }
});

it('applies explicit node minimums consistently in catalog goals', async () => {
  const { database } = await setup();
  try {
    await ensureAddressPolicies(database);
    const now = new Date().toISOString();
    await database.prepare("UPDATE sync_country_policies SET target_count=5,min_per_node=10,coverage_ratio=1,level1_min=0,level2_min=0 WHERE country_code='NL'").run();
    await database.prepare(`INSERT INTO catalog_regions(id,country_code,code,name,native_name,zh_name,type,parent_id,path)
      VALUES (99001,'NL','NH','Noord-Holland','Noord-Holland','北荷兰省','province',NULL,'/99001')`).run();
    await database.prepare(`INSERT INTO catalog_cities(id,country_code,region_id,name,native_name,zh_name,type,population)
      VALUES (99002,'NL',99001,'Amsterdam','Amsterdam','阿姆斯特丹','city',100)`).run();
    await database.prepare(`INSERT INTO residential_coverage(country_code,region_name,city_name,address_count,total_count,last_verified_at,region_id,city_id)
      VALUES ('NL','Noord-Holland','Amsterdam',5,5,?,99001,99002)`).bind(now).run();
    for (const [node, parent, level, name] of [['NL', '', 0, 'Netherlands'], ['NL:1:NH', 'NL', 1, 'Noord-Holland'], [`NL:loc:${Buffer.from('Noord-Holland').toString('hex')}:${Buffer.from('Amsterdam').toString('hex')}`, 'NL:1:NH', 2, 'Amsterdam']]) {
      await database.prepare(`INSERT INTO admin_coverage_stats(node_key,parent_key,country_code,level,region_name,total_count,updated_at)
        VALUES (?,?,'NL',?,?,5,?)`).bind(node, parent, level, name, now).run();
    }
    await upsertNodeTarget(database, `NL:loc:${Buffer.from('Noord-Holland').toString('hex')}:${Buffer.from('Amsterdam').toString('hex')}`, 2);
    const node = (await listCountryNodeTargets(database, 'NL')).find((item) => item.key === `NL:loc:${Buffer.from('Noord-Holland').toString('hex')}:${Buffer.from('Amsterdam').toString('hex')}`);
    const goal = (await evaluateCountryGoals(database)).get('NL');
    expect(node).toMatchObject({ currentCount: 5, targetCount: 2, satisfied: true });
    expect(goal).toMatchObject({ complete: true, unmetRules: [] });
  } finally { await database.close(); }
});

it('preserves HTTP-date Retry-After in model discovery', async () => {
  const retryAfter = new Date(Date.now() + 600_000).toUTCString();
  await expect(fetchOpenAICompatibleModels({ apiKey: 'synthetic-api-key', baseUrl: 'https://fixture.example/v1' },
    async () => new Response('{}', { status: 429, headers: { 'Retry-After': retryAfter } })))
    .rejects.toMatchObject({ code: 'OPENAI_COMPATIBLE_MODELS_RATE_LIMITED', retryAt: new Date(retryAfter).toISOString() });
});

it('keeps initial ETL fallback pinned to each key and honors disabled routes', async () => {
  const { database, control } = await setup();
  try {
    const first = await control.addCredential({ provider: 'openai-compatible', label: 'First', apiKey: 'fixture-first-key',
      baseUrl: 'https://fixture.example/v1', model: 'first-model', translationPriority: 1, translationPrompt: 'Keep official place names.' });
    const second = await control.addCredential({ provider: 'openai-compatible', label: 'Second', apiKey: 'fixture-second-key',
      baseUrl: 'https://fixture.example/v1', model: 'second-model', translationPriority: 2 });
    const calls = [];
    const brokerClient = { request: async (operation, parameters, options) => {
      calls.push({ operation, parameters, options });
      if (parameters.credentialId === first) throw new Error('Fixture provider unavailable');
      return { translations: parameters.values.map(() => '主街') };
    } };
    const record = { countryCode: 'US', nativeLanguage: 'en', components: { street: 'Main Street' } };
    const options = { database, brokerClient, environment: { ADDRESS_SYNC_TRANSLATION_ENABLED: 'true' } };
    await localizeAddressRecords([record], options);
    expect(calls.map((call) => call.parameters.credentialId)).toEqual([first, second]);
    expect(calls[0].parameters.prompt).toBe('Keep official place names.');
    expect(calls.every((call) => call.options.maxDispatches === 1)).toBe(true);
    await control.updateCredential(first, { enabled: false });
    calls.length = 0;
    await localizeAddressRecords([record], options);
    expect(calls.map((call) => call.parameters.credentialId)).toEqual([second]);
    await control.updateCredential(second, { enabled: false });
    const providers = await createImportTranslationProviders({ database, environment: { GOOGLE_TRANSLATION_ENABLED: 'true' }, brokerClient });
    expect(providers.translationChain).toEqual([]);
  } finally { await database.close(); }
});
