// Spelling-insensitive forms of first-level region names, shared by the dropdown assignment and the sync repair.
export const foldName = (value) => {
  const lowered = String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/đ/gu, 'd').replace(/ı/gu, 'i');
  const base = /\p{Script=Latin}/u.test(lowered) ? lowered.normalize('NFKD').replace(/\p{M}/gu, '') : lowered;
  return base.replace(/[^\p{L}\p{N}\p{M}]+/gu, '');
};

// Words that official and colloquial region names add or drop: 서울 / 서울특별시, 大阪 / 大阪府, الرياض / منطقة الرياض,
// Hà Nội / Thành phố Hà Nội, Белгород / Белгородская область, Ogun / Ogun State.
const prefixes = ['منطقة', 'thành phố', 'tỉnh', 'tp', 'จังหวัด', 'республика', 'republic of', 'province of', 'state of', 'city of']
  .map(foldName);
const suffixes = ['특별자치시', '특별자치도', '특별시', '광역시', '자치시', '자치도', '도', '都', '府', '県', 'область', 'край', 'автономный округ',
  'автономная область', 'республика', 'province', 'state', 'region', 'oblast', 'prefecture', 'governorate', 'territory'].map(foldName);
const russianEndings = ['ская', 'ский', 'ая', 'ий'];

export const nameVariants = (value) => {
  const variants = new Set();
  const text = String(value ?? '');
  for (const part of [text, ...text.split(/[()/]/u)]) {
    const folded = foldName(part);
    if (folded.length >= 2) variants.add(folded);
  }
  for (const base of [...variants]) for (const prefix of prefixes) {
    if (base.startsWith(prefix) && base.length - prefix.length >= 2) variants.add(base.slice(prefix.length));
  }
  for (const base of [...variants]) for (const suffix of suffixes) {
    if (base.endsWith(suffix) && base.length - suffix.length >= 2) variants.add(base.slice(0, -suffix.length));
  }
  for (const base of [...variants]) if (/\p{Script=Cyrillic}/u.test(base)) for (const ending of russianEndings) {
    if (base.endsWith(ending) && base.length - ending.length >= 3) variants.add(base.slice(0, -ending.length));
  }
  return variants;
};

// Spellings of one unrecognized region (Quảng Nam, quang nam, Tỉnh Quảng Nam) share their shortest name variant.
export const regionSpellingKey = (admin1) =>
  [...nameVariants(admin1)].sort((left, right) => left.length - right.length || (left < right ? -1 : 1))[0] || String(admin1 ?? '');

// Resolves a region name to the one root it names: by its folded form first, then by its name variants. Regions are
// catalog rows; rootOf maps a row to the root id it belongs to.
export const variantRegionIndex = (regions, rootOf) => {
  const folded = new Map();
  const variants = new Map();
  const add = (map, key, root) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(root);
  };
  for (const region of regions) for (const name of [region.name, region.native_name, region.zh_name, region.code]) {
    add(folded, foldName(name), rootOf(region));
    for (const variant of nameVariants(name)) add(variants, variant, rootOf(region));
  }
  return (value) => {
    const exact = folded.get(foldName(value));
    if (exact?.size === 1) return [...exact][0];
    const roots = new Set([...nameVariants(value)].flatMap((variant) => [...variants.get(variant) || []]));
    return roots.size === 1 ? [...roots][0] : undefined;
  };
};
