import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('live validation contract', () => {
  it('tests every published country ordinarily and residential mode only where available', async () => {
    const source = await readFile('scripts/validate-live-addresses.mjs', 'utf8');
    expect(source).toContain("const expectedMode = ordinaryAvailable ? 'synchronized-pool' : 'sync-required'");
    expect(source).toContain('Number(registryByCode.get(country)?.residentialCount) > 0');
    expect(source).not.toContain('if (includeResidential && !residentialAvailable)');
  });

  it('checks translations for every published country instead of the residential subset', async () => {
    const source = await readFile('scripts/validate-live-translations.mjs', 'utf8');
    expect(source).toContain("country.generationMode === 'synchronized-pool'");
    expect(source).toContain('Number(country.addressCount) > 0');
    expect(source).not.toContain('Number(country.residentialCount) > 0');
  });
});
