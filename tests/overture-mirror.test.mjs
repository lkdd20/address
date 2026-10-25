import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSourceAdapters } from '../server/sync/source-adapters.mjs';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Overture address mirror', () => {
  it('downloads each release asset once and hands the exporter local files', async () => {
    const cacheDir = resolve('.data-cache', `overture-mirror-${process.pid}-${Date.now()}`);
    directories.push(cacheDir);
    await mkdir(resolve(cacheDir, 'overture-mirror', '2026-01-01.0'), { recursive: true });
    await mkdir(resolve(cacheDir, 'overture-mirror', '2026-02-01.0'), { recursive: true });
    const body = 'parquet-fixture';
    const requests = [];
    const fetchImpl = async (input, init = {}) => {
      requests.push(`${init.method || 'GET'} ${new URL(String(input)).pathname}`);
      const headers = { 'content-length': String(body.length) };
      return init.method === 'HEAD' ? new Response(null, { status: 200, headers }) : new Response(body, { status: 200, headers });
    };
    const exporterAssets = [];
    const execute = async ({ args }) => {
      const assetsFile = args[args.indexOf('--assets-file') + 1];
      if (assetsFile && args.indexOf('--assets-file') >= 0) exporterAssets.push(...JSON.parse(await readFile(assetsFile, 'utf8')));
      const output = args[args.indexOf('--output') + 1];
      await mkdir(resolve(output, '..'), { recursive: true });
      await writeFile(output, `${JSON.stringify({ id: 'fixture' })}\n`, 'utf8');
    };
    const adapters = createSourceAdapters({ fetchImpl, execute, pythonBin: 'python-fixture', environment: {} });
    const shard = { id: 'overture-addresses-sg', countryCode: 'SG', source: { id: 'overture-addresses', adapter: 'overture' } };
    const assets = ['https://example.test/release/2026-03-01.0/part-1.parquet', 'https://example.test/release/2026-03-01.0/part-2.parquet'];
    await adapters.materialize(shard, { adapter: 'overture', version: '2026-03-01.0', assets, buildingAssets: [] },
      { cacheDir, maxRecords: 10, perLocality: 10, maxBytes: 1_000_000 });

    const mirror = resolve(cacheDir, 'overture-mirror', '2026-03-01.0');
    expect(exporterAssets).toEqual([resolve(mirror, 'part-1.parquet'), resolve(mirror, 'part-2.parquet')]);
    expect(await readFile(resolve(mirror, 'part-1.parquet'), 'utf8')).toBe(body);
    expect((await readdir(resolve(cacheDir, 'overture-mirror'))).sort()).toEqual(['2026-02-01.0', '2026-03-01.0']);

    const downloads = requests.filter((request) => request.startsWith('GET')).length;
    await adapters.materialize(shard, { adapter: 'overture', version: '2026-03-01.0', assets, buildingAssets: [] },
      { cacheDir, maxRecords: 20, perLocality: 10, maxBytes: 1_000_000 });
    expect(requests.filter((request) => request.startsWith('GET')).length).toBe(downloads);
  });
});
