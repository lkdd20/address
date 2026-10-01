import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { adminBoundaryRevision, resolveGeofabrikPbfUrl, sourceCapabilityRevision, sourceAdapterRevisions } from '../server/sync/source-adapters.mjs';
import { applyAdministrativeBoundary } from '../server/sync/postgres-address-importer.mjs';

const catalog = JSON.parse(await readFile(new URL('../server/sync/admin-boundaries.json', import.meta.url), 'utf8'));
const record = (components, boundary) => ({
  components: { ...components }, englishComponentHints: {}, administrativeBoundary: boundary,
  locality: components.locality || '', district: components.district || ''
});

describe('administrative boundary catalog', () => {
  it('declares only supported, attributed datasets with district or locality roles', () => {
    for (const [country, entry] of Object.entries(catalog.countries)) {
      expect(country).toMatch(/^[A-Z]{2}$/u);
      expect(Number.isInteger(entry.revision)).toBe(true);
      for (const dataset of entry.datasets) {
        expect(['zip-shapefile', 'geojson', 'parquet', 'overture-divisions']).toContain(dataset.kind);
        expect(dataset.attribution).toBeTruthy();
        if (dataset.kind !== 'overture-divisions') expect(dataset.url).toMatch(/^https:\/\//u);
        for (const layer of dataset.layers) expect(['district', 'locality']).toContain(layer.role);
      }
    }
  });

  it('changes the capability fingerprint only for bulk sources of configured countries', () => {
    const shard = (countryCode, adapter) => ({ countryCode, source: { adapter } });
    expect(sourceCapabilityRevision(shard('PH', 'geofabrik')))
      .toBe(`${sourceAdapterRevisions.geofabrik}:${adminBoundaryRevision('PH')}`);
    expect(sourceCapabilityRevision(shard('BR', 'overture'))).toContain(':adm1-');
    expect(sourceCapabilityRevision(shard('DE', 'geofabrik'))).toBe(sourceAdapterRevisions.geofabrik);
    expect(sourceCapabilityRevision(shard('KR', 'korea-kapt'))).toBe(sourceAdapterRevisions['korea-kapt']);
    expect(adminBoundaryRevision('PH')).not.toBe(adminBoundaryRevision('TH'));
  });
});

describe('applyAdministrativeBoundary', () => {
  const boundary = {
    district: { name: 'Molino III', nameEn: 'Molino III', code: 'PH0402103', dataset: 'phl-cod-ab' },
    locality: { name: 'Bacoor', nameEn: 'Bacoor', code: 'PH04021', dataset: 'phl-cod-ab' }
  };

  it('fills a missing district and city from the containing polygons', () => {
    const value = record({ admin1: 'Cavite', street: 'Molino Road' }, boundary);
    expect(applyAdministrativeBoundary(value)).toBe(true);
    expect(value.components).toMatchObject({ locality: 'Bacoor', postalLocality: 'Bacoor', district: 'Molino III' });
    expect(value).toMatchObject({ locality: 'Bacoor', district: 'Molino III' });
  });

  it('keeps source districts and replaces only a district that repeats the city', () => {
    const kept = record({ locality: 'Bacoor', district: 'Talaba' }, boundary);
    expect(applyAdministrativeBoundary(kept)).toBe(false);
    expect(kept.components.district).toBe('Talaba');
    const repeated = record({ locality: 'Bacoor', district: 'BACOOR' }, boundary);
    expect(applyAdministrativeBoundary(repeated)).toBe(true);
    expect(repeated.components.district).toBe('Molino III');
  });

  it('records English hints only when they differ and never copies the city into the district', () => {
    const thai = record({ locality: 'พระนคร' }, {
      district: { name: 'พระบรมมหาราชวัง', nameEn: 'Phraborom Maharatchawang', code: 'TH100101', dataset: 'tha-cod-ab' }
    });
    applyAdministrativeBoundary(thai);
    expect(thai.englishComponentHints.district).toBe('Phraborom Maharatchawang');
    const sameAsCity = record({ locality: 'Riyadh' }, { district: { name: 'riyadh', nameEn: '', code: '1', dataset: 'x' } });
    expect(applyAdministrativeBoundary(sameAsCity)).toBe(false);
    expect(sameAsCity.components.district).toBeUndefined();
    expect(applyAdministrativeBoundary(record({ locality: 'X' }, undefined))).toBe(false);
  });
});

describe('resolveGeofabrikPbfUrl', () => {
  const responses = (map) => async (url) => {
    const value = map[url];
    if (!value) throw new Error(`unexpected ${url}`);
    return value;
  };
  const redirect = (status, location) => `HTTP/1.1 ${status} Moved\r\nLocation: ${location}\r\n\r\n`;
  const ok = 'HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n';
  const latest = 'https://download.geofabrik.de/africa/nigeria-latest.osm.pbf';
  const dated = 'https://download.geofabrik.de/africa/nigeria-260929.osm.pbf';

  it('escapes a stale self-redirect to the trailing-slash form and settles on the dated file', async () => {
    await expect(resolveGeofabrikPbfUrl(latest, { head: responses({
      [latest]: redirect(301, `${latest}/`),
      [`${latest}/`]: redirect(302, `${dated}/`),
      [`${dated}/`]: ok
    }) })).resolves.toBe(dated);
    await expect(resolveGeofabrikPbfUrl(latest, { head: responses({
      [latest]: redirect(302, `${dated}/`), [`${dated}/`]: ok
    }) })).resolves.toBe(dated);
  });

  it('falls back to the replication state date when edge caches loop', async () => {
    const head = responses({
      [latest]: redirect(301, `${latest}/`), [`${latest}/`]: redirect(301, `${latest}/`),
      'https://download.geofabrik.de/africa/nigeria-260930.osm.pbf': 'HTTP/1.1 404 Not Found\r\n\r\n',
      [dated]: ok
    });
    const get = async (url) => {
      expect(url).toBe('https://download.geofabrik.de/africa/nigeria-updates/state.txt');
      return 'sequenceNumber=4917\ntimestamp=2026-09-30T20\\:22\\:51Z\n';
    };
    await expect(resolveGeofabrikPbfUrl(latest, { head, get })).resolves.toBe(dated);
  });

  it('probes the most recent daily extracts when the replication state times out', async () => {
    const head = responses({
      [latest]: redirect(301, `${latest}/`), [`${latest}/`]: redirect(301, `${latest}/`),
      'https://download.geofabrik.de/africa/nigeria-260928.osm.pbf': ok, [dated]: ok
    });
    const get = async () => { throw new Error('curl: (28) Operation timed out'); };
    const now = () => new Date('2026-10-01T12:00:00Z');
    await expect(resolveGeofabrikPbfUrl(latest, { head, get, now })).resolves.toBe(dated);
  });

  it('fails instead of retrying forever when neither redirects nor state resolve', async () => {
    const get = async () => '';
    await expect(resolveGeofabrikPbfUrl(latest, { get, head: responses({
      [latest]: redirect(301, `${latest}/`), [`${latest}/`]: redirect(301, latest)
    }) })).rejects.toThrow('redirect loop');
    await expect(resolveGeofabrikPbfUrl(latest, { get, head: responses({ [latest]: 'HTTP/1.1 503 Busy\r\n\r\n' }) }))
      .rejects.toThrow('(503)');
  });
});
