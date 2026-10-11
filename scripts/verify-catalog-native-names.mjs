// Rebuilds server/database/catalog-native-corrections.json: upstream `native` names in the location catalog are often
// machine translations (Alaska -> "Down", Ordu -> "Saat"). Each catalog entry is checked against the Wikidata label
// in the country's language; only entries whose stored native name changes are written.
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { diacriticsOnly, englishNativeCountries, nativeNameMatches } from '../server/database/catalog-native-names.mjs';

const cacheDir = resolve(process.env.LOCATION_CATALOG_CACHE_DIR || '.data-cache');
const output = new URL('../server/database/catalog-native-corrections.json', import.meta.url);
const userAgent = 'address-catalog-verifier/1.0 (https://github.com/daimon3332/address)';
const languages = {
  DE: ['de'], FR: ['fr'], ES: ['es'], IT: ['it'], NL: ['nl'], TR: ['tr'], BR: ['pt-br', 'pt'], MX: ['es'],
  VN: ['vi'], RU: ['ru'], JP: ['ja'], KR: ['ko'], TH: ['th'], SA: ['ar'], TW: ['zh-tw', 'zh-hant', 'zh']
};
const usStateCodes = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
// Hand-reviewed exceptions: the official local name where upstream translation and Wikidata both give an exonym.
const reviewed = {
  'ES:Ourense': 'Ourense', 'ES:Castile and Leon': 'Castilla y León', 'NL:Friesland': 'Fryslân',
  'MY:Malacca': 'Melaka', 'MY:Penang': 'Pulau Pinang', 'VN:Huế': 'Thừa Thiên-Huế'
};
const nonLatinCountries = new Set(['RU', 'JP', 'KR', 'TH', 'SA', 'TW']);
const checkedCountries = new Set([...englishNativeCountries, ...Object.keys(languages)]);

const cached = async (name, url) => {
  const target = resolve(cacheDir, name);
  try { if ((await stat(target)).size > 0) return target; } catch {}
  const response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': userAgent } });
  if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}`);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(target, new Uint8Array(await response.arrayBuffer()));
  return target;
};
const states = JSON.parse(await readFile(await cached('states.json',
  'https://raw.githubusercontent.com/dr5hn/countries-states-cities-database/master/json/states.json'), 'utf8'));
const cities = JSON.parse(gunzipSync(await readFile(await cached('json-cities.json.gz',
  'https://github.com/dr5hn/countries-states-cities-database/releases/latest/download/json-cities.json.gz'))).toString('utf8'));

const entries = [
  ...states.filter((state) => checkedCountries.has(state.country_code) && (state.country_code !== 'US' || usStateCodes.has(state.iso2)))
    .map((state) => ({ kind: 'regions', ...state })),
  ...cities.filter((city) => checkedCountries.has(city.country_code)).map((city) => ({ kind: 'cities', ...city }))
];

const labelCache = resolve(cacheDir, 'wikidata-labels.json');
const labels = new Map(Object.entries(await readFile(labelCache, 'utf8').then(JSON.parse).catch(() => ({}))));
const wanted = [...new Set(entries.filter((entry) => languages[entry.country_code] && /^Q\d+$/u.test(entry.wikiDataId || ''))
  .map((entry) => entry.wikiDataId))].filter((id) => !labels.has(id));
const allLanguages = [...new Set(Object.values(languages).flat())].join('|');
for (let offset = 0; offset < wanted.length; offset += 50) {
  const ids = wanted.slice(offset, offset + 50);
  const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels&ids=${ids.join('|')}&languages=${allLanguages}`;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, { headers: { 'User-Agent': userAgent } });
    if (response.ok) {
      for (const [id, entity] of Object.entries((await response.json()).entities || {})) labels.set(id, entity.labels || {});
      break;
    }
    if (attempt >= 4) throw new Error(`Wikidata returned HTTP ${response.status}`);
    await new Promise((done) => setTimeout(done, 2_000 * (attempt + 1)));
  }
  if (offset % 2_500 === 0) console.error(`wikidata ${offset}/${wanted.length}`);
}
await writeFile(labelCache, JSON.stringify(Object.fromEntries(labels)));

const corrections = { regions: {}, cities: {} };
const summary = {};
for (const entry of entries) {
  const country = entry.country_code;
  const current = entry.native || entry.name;
  let corrected = current;
  let status = 'kept';
  if (entry.kind === 'regions' && reviewed[`${country}:${entry.name}`]) { corrected = reviewed[`${country}:${entry.name}`]; status = 'reviewed'; }
  else if (englishNativeCountries.has(country)) {
    if (!diacriticsOnly(current, entry.name)) { corrected = entry.name; status = 'english'; }
  } else {
    // Upstream Wikidata ids are often wrong for cities (Abbeville -> Abbaretz), so a label counts only when it names
    // the same place as the entry: it matches the native or the romanized name.
    const label = (languages[country] || []).map((language) => labels.get(entry.wikiDataId)?.[language]?.value).find(Boolean);
    // Regions also carry upstream translations, a second source next to Wikidata.
    const translation = (languages[country] || []).map((language) => entry.translations?.[language]).find(Boolean);
    const latin = !nonLatinCountries.has(country);
    const asName = nativeNameMatches(current, entry.name, { exact: true });
    if (label && nativeNameMatches(current, label, { exact: true })) {
      if (!diacriticsOnly(current, label)) corrected = label;
      status = corrected === current ? 'verified' : 'formatted';
    }
    else if (label && nativeNameMatches(current, label)) status = 'verified';
    else if (latin && translation && nativeNameMatches(current, translation, { exact: true })) status = 'verified';
    else if (asName) status = 'verified';
    // City translations are Castilian exonyms for Catalan and Galician municipalities (Pont d'Armentera), so only
    // regions use them.
    else if (latin && entry.kind === 'regions' && translation && label && nativeNameMatches(translation, label)) { corrected = translation; status = 'translation'; }
    // An accented official name wins over a label that only differs in accents (Mácher, Polinyà).
    else if (label && latin && nativeNameMatches(entry.name, label, { exact: true })) {
      corrected = /[^\p{ASCII}]/u.test(entry.name) ? entry.name : label;
      status = 'wikidata';
    }
    // Non-Latin region labels are reviewed by hand before they are committed; Latin-script regions never take a bare
    // label, which often carries a "provincia de" prefix or a Castilian exonym (Vizcaya for Bizkaia).
    else if (label && !latin && entry.kind === 'regions') { corrected = label; status = 'region-wikidata'; }
    else if (latin && !nativeNameMatches(current, entry.name)) { corrected = entry.name; status = 'romanized'; }
    else status = 'unverified';
  }
  const counts = summary[country] ||= {};
  counts[status] = (counts[status] || 0) + 1;
  // Every checked region is listed: older catalog snapshots can hold natives that upstream has since fixed.
  if (corrected !== current || entry.kind === 'regions') corrections[entry.kind][entry.id] = corrected;
}
const sorted = (table) => Object.fromEntries(Object.entries(table).sort(([left], [right]) => Number(left) - Number(right)));
await writeFile(output, `${JSON.stringify({
  source: 'countries-states-cities-database native names verified against Wikidata labels',
  generatedAt: new Date().toISOString().slice(0, 10),
  regions: sorted(corrections.regions),
  cities: sorted(corrections.cities)
}, null, 1)}\n`);
console.log(JSON.stringify(summary));
console.log(`regions ${Object.keys(corrections.regions).length}, cities ${Object.keys(corrections.cities).length}`);
