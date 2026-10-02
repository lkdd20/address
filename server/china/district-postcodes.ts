import { readFileSync } from 'node:fs';

// District (county-level) postcodes keyed by the national adcode, from tombcato/china-zipcode-data (MIT).
// Used only when a provider omits the postcode and the name-based catalog cannot pick a unique code.
interface DistrictPostcodeFile { entries: Array<[string, string, string, string, string]> }

const nameKey = (value: string): string => String(value || '').normalize('NFKC')
  .replace(/(?:特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区|自治州|自治县|地区|省|市|区|县|盟|旗)$/u, '')
  .replace(/[^\p{L}\p{N}]/gu, '');

let indexes: { byAdcode: Map<string, [string, string]>; byName: Map<string, string | null> } | undefined;
const load = () => {
  if (indexes) return indexes;
  const file = JSON.parse(readFileSync(new URL('./district-postcodes.json', import.meta.url), 'utf8')) as DistrictPostcodeFile;
  const byAdcode = new Map<string, [string, string]>();
  const byName = new Map<string, string | null>();
  for (const [adcode, province, , district, postcode] of file.entries) {
    const key = `${nameKey(province)}\u0000${nameKey(district)}`;
    byAdcode.set(adcode, [key, postcode]);
    byName.set(key, byName.has(key) && byName.get(key) !== postcode ? null : postcode);
  }
  indexes = { byAdcode, byName };
  return indexes;
};

export const chinaDistrictPostcode = (place: { adcode?: string; province?: string; district?: string }): string => {
  const { byAdcode, byName } = load();
  const key = `${nameKey(place.province || '')}\u0000${nameKey(place.district || '')}`;
  const byCode = byAdcode.get(String(place.adcode || '').trim());
  if (byCode && byCode[0] === key) return byCode[1];
  return byName.get(key) || '';
};
