import { describe, expect, it } from 'vitest';
import { foreignAddressScriptPattern } from '../src/domain/address-localization.mjs';

describe('foreign address script patterns', () => {
  // The generation index runs these patterns in PostgreSQL, whose regular expressions have no \p{...} classes.
  it('stay PostgreSQL bracket expressions and cover the supplementary Han extensions', () => {
    for (const locale of ['en', 'zh-CN', 'ja', 'ko']) expect(foreignAddressScriptPattern(locale)).not.toMatch(/\\[pP]\{/u);
    const english = new RegExp(foreignAddressScriptPattern('en'), 'u');
    expect(english.test('\u{29D7A}qitou')).toBe(true);
    expect(english.test('Xiaquan Road')).toBe(false);
  });
});
