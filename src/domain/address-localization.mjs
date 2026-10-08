const scriptPatterns = {
  han: /[⺀-⻿㐀-䶿一-鿿豈-﫿]/u,
  kana: /[぀-ヿㇰ-ㇿｦ-ﾝ]/u,
  hangul: /[ᄀ-ᇿ㄰-㆏가-힯]/u,
  thai: /[฀-๿]/u,
  arabic: /[؀-ۿݐ-ݿ]/u,
  cyrillic: /[Ѐ-ӿ]/u
};
const foreignScripts = {
  zh: [scriptPatterns.kana, scriptPatterns.hangul, scriptPatterns.thai, scriptPatterns.arabic, scriptPatterns.cyrillic],
  ja: [scriptPatterns.hangul, scriptPatterns.thai, scriptPatterns.arabic, scriptPatterns.cyrillic],
  ko: [scriptPatterns.kana, scriptPatterns.thai, scriptPatterns.arabic, scriptPatterns.cyrillic],
  latin: Object.values(scriptPatterns)
};
export const semanticAddressFields = [
  'buildingName', 'street', 'locality', 'postalLocality', 'dependentLocality', 'district', 'admin1'
];
const patternsFor = (locale) => foreignScripts[locale.split('-')[0].toLowerCase()] || foreignScripts.latin;

export const foreignAddressScriptPattern = (locale) => patternsFor(locale).map((pattern) => pattern.source).join('|');
export const componentLooksLocalized = (text, locale) => !patternsFor(locale).some((pattern) => pattern.test(text));
export const storedVariantLooksLocalized = (components, locale) => semanticAddressFields.every((field) => {
  const value = components[field];
  return typeof value !== 'string' || !value.trim() || componentLooksLocalized(value, locale);
});

const decimalText = (text) => String(text ?? '').normalize('NFKC').replace(/\p{Decimal_Number}/gu, (digit) => {
  const code = digit.codePointAt(0);
  let start = code;
  while (/\p{Decimal_Number}/u.test(String.fromCodePoint(start - 1))) start--;
  return String((code - start) % 10);
});
export const normalizeAddressDigits = decimalText;
const hanDigits = { '〇': 0, '零': 0, '一': 1, '二': 2, '两': 2, '兩': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
const hanNumber = (text) => {
  if (![...text].some((digit) => '十百千'.includes(digit))) return [...text].map((digit) => hanDigits[digit]).join('');
  let total = 0;
  let digit = 0;
  let pendingDigit = false;
  let previousUnit = 10_000;
  for (const character of text) {
    const unit = { '十': 10, '百': 100, '千': 1000 }[character];
    if (!unit) {
      if (pendingDigit && digit !== 0) return `han:${text}`;
      digit = hanDigits[character]; pendingDigit = true; continue;
    }
    if (unit >= previousUnit) return text;
    total += (digit || 1) * unit;
    digit = 0;
    pendingDigit = false;
    previousUnit = unit;
  }
  if (previousUnit >= 100 && digit && !text.includes('零') && !text.includes('〇')) return `han:${text}`;
  return String(total + digit);
};
const numberTokens = (text) => [...decimalText(text).matchAll(
  /\p{N}+|(?:第)?([〇零一二两兩三四五六七八九十百千]+)(?=丁目|番地|番|段|号|號|弄|巷|街|路|道|棟|栋|座|区|區)/gu
)].map(([value, ordinal]) => ordinal ? hanNumber(ordinal) : value).join('|');
const identifierTokens = (text) => String(text ?? '').normalize('NFKC').match(/[A-Za-z0-9]+(?:[./-][A-Za-z0-9]+)*/gu)
  ?.filter((token) => /[A-Za-z]/u.test(token) && /[0-9]/u.test(token)) || [];
export const preservesAddressNumbers = (original, translated) => {
  const left = numberTokens(original);
  const right = numberTokens(translated);
  if (!/\p{N}/u.test(decimalText(original) + decimalText(translated)) && (!left || !right)) return true;
  return left === right;
};
export const preservesAddressIdentifiers = (original, translated) => {
  const required = identifierTokens(original);
  if (!required.length) return true;
  const available = identifierTokens(translated);
  const counts = new Map();
  for (const token of available) counts.set(token, (counts.get(token) || 0) + 1);
  return required.every((token) => {
    const count = counts.get(token) || 0;
    if (!count) return false;
    counts.set(token, count - 1);
    return true;
  });
};

// Machine translations that answer back, transliterate a Russian street type word, or collapse a multi-letter name into
// a single literal character are not address translations.
const conversationalChinese = /它是|什么|无法|抱歉|对不起|说明/u;
const replyPunctuation = /[？?！!]/u;
const cyrillicStreetType = /(?<!\p{L})(?:улица|ул\.|проспект|переулок|шоссе|бульвар|проезд|площадь|набережная|тупик|аллея)(?!\p{L})/iu;
const chineseStreetType = /[街路道巷弄场岸滨堤]|胡同|林荫/u;
export const implausibleChineseTranslation = (original, translated) => {
  const value = String(translated ?? '').trim();
  if (conversationalChinese.test(value) || replyPunctuation.test(value) && !replyPunctuation.test(String(original ?? ''))) return true;
  if (cyrillicStreetType.test(String(original ?? '')) && !chineseStreetType.test(value)) return true;
  // Short names can be one-syllable transliterations (Rau → 劳) and generic words can be one character (Street → 街,
  // West → 西); other longer names collapsed to one character were translated literally (Badger → 獾).
  if (/^[街路道巷弄栋楼座塔号区村镇乡市县省州港桥岛园场庄屯东西南北中]$/u.test(value)) return false;
  const sourceLetters = [...String(original ?? '')].filter((character) => /\p{L}/u.test(character) && !/\p{Script=Han}/u.test(character));
  const minimum = sourceLetters.some((character) => /\p{Script=Cyrillic}/u.test(character)) ? 4 : 5;
  return sourceLetters.length >= minimum && /^\p{Script=Han}$/u.test(value);
};

export const usableAddressTranslation = (value, target, original = '') => {
  const translated = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (!translated || original && (!preservesAddressNumbers(original, translated) || !preservesAddressIdentifiers(original, translated))) return false;
  if (!componentLooksLocalized(translated, target)) return false;
  if (target === 'en') return !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Thai}\p{Script=Cyrillic}]/u.test(translated);
  if (target === 'zh-CN' && original && implausibleChineseTranslation(original, translated)) return false;
  if (target === 'zh-CN') return !/\p{L}/u.test(original || translated) || /\p{Script=Han}/u.test(translated)
    || /^[A-Z]{1,6}[-./ ]?\d+(?:[-./ ]?[A-Z\d]+)*$/u.test(original) && translated === original;
  return true;
};
