import corrections from './catalog-native-corrections.json' with { type: 'json' };

// Countries whose addresses are written in English; their catalog native names are the English names, apart from
// accented local spellings such as Montréal.
export const englishNativeCountries = new Set(['US', 'GB', 'AU', 'CA', 'NG', 'ZA', 'SG', 'PH', 'MY', 'IN']);

const folded = (value) => String(value || '').normalize('NFKD').replace(/[̀-ͯ]/gu, '');
const key = (value) => folded(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export const diacriticsOnly = (native, name) => native === name || folded(native) === name;

// `exact` compares names ignoring case, accents and punctuation; otherwise one name may extend the other
// (東京 / 東京都, 서울 / 서울특별시).
export const nativeNameMatches = (left, right, { exact = false } = {}) => {
  const a = key(left);
  const b = key(right);
  if (!a || !b) return false;
  return a === b || (!exact && Math.min(a.length, b.length) >= 2 && (a.includes(b) || b.includes(a)));
};

export const catalogNativeCorrections = corrections;
export const correctedNativeName = (kind, id, native) => corrections[kind]?.[String(id)] ?? native;
