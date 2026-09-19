import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Database } from '../database/database.mjs';
import { findNonResidentialMatch } from '../../src/domain/non-residential.mjs';
import { matchesCustomBlacklist } from '../lib/custom-blacklist.mjs';
import type { ControlStore, ProviderName, ProviderQuotaObservation } from '../control/store';
import { refreshAddressCoverage } from '../control/coverage';
import {
  chinaCommunityPublicationClause,
  chinaFreshTimestampClause
} from '../api/repositories/china-community';
import { distanceMeters } from './coordinates';
import { CredentialBrokerClient } from '../credential-broker/client.mjs';
import {
  fetchBrokerCommunities, providerFetcher, ProviderRequestError,
  type ChinaCredentialBroker, type CommunityCandidate, type ProviderPage
} from './providers';
import { isChinaDeliveryAddress, normalizeChinaProviderAddress } from './quality';
import { canonicalPolicyNodeKey, getCountryPolicy, type CountryPolicy } from '../sync/address-policy.mjs';

export const initialChinaCities = [
  '北京市', '天津市', '上海市', '重庆市', '石家庄市', '太原市', '呼和浩特市', '沈阳市', '长春市', '哈尔滨市',
  '南京市', '杭州市', '合肥市', '福州市', '南昌市', '济南市', '郑州市', '武汉市', '长沙市', '广州市',
  '南宁市', '海口市', '成都市', '贵阳市', '昆明市', '拉萨市', '西安市', '兰州市', '西宁市', '银川市',
  '乌鲁木齐市', '深圳市', '厦门市', '青岛市', '大连市', '宁波市', '苏州市', '唐山市', '无锡市', '佛山市',
  '东莞市', '珠海市', '泉州市'
];

const normalizedName = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('zh-CN')
  .replace(/[·•・\s()（）【】\[\]_-]/gu, '').replace(/(?:小区|社区|花园|公寓|家园|住宅区)$/u, '');
const normalizedAddress = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('zh-CN')
  .replace(/[\s,，。．·•・()（）【】\[\]_-]/gu, '');
const normalizeChinaPostcodeName = (value: string): string => value.normalize('NFKC')
  .replace(/(?:特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区|自治州|地区|省|市|区|县|盟|旗|街道|镇|乡)$/u, '')
  .replace(/[^\p{L}\p{N}]/gu, '').toLocaleLowerCase('zh-CN');
const comparableAdmin = (value: string): string => value.normalize('NFKC').replace(/[省市区县]$/u, '');
const addressRoads = (value: string): string[] => [...value.matchAll(/([\p{L}\p{N}]{2,}?(?:大道|大街|公路|路|街|巷|道|弄))/gu)]
  .map((match) => match[1]);
const premiseNumbers = (value: string): string[] => [...value.normalize('NFKC')
  .matchAll(/(?:大道|大街|公路|路|街|巷|道|弄)([0-9]+(?:(?:弄|巷)[0-9]+)?(?:[-之][0-9]+)?(?:号|號)(?:院)?)/gu)]
  .map((match) => match[1].replace(/號/gu, '号').replace(/院$/u, ''));
const roadsAgree = (left: string[], right: string[]): boolean => left.some((leftRoad) => right.some((rightRoad) =>
  leftRoad === rightRoad || (Math.min(leftRoad.length, rightRoad.length) >= 3
    && (leftRoad.endsWith(rightRoad) || rightRoad.endsWith(leftRoad)))));
const addressesAgree = (left: string, right: string): boolean => {
  const normalizedLeft = normalizedAddress(left);
  const normalizedRight = normalizedAddress(right);
  if (!normalizedLeft || !normalizedRight) return false;
  const leftPremises = premiseNumbers(left);
  const rightPremises = premiseNumbers(right);
  if (leftPremises.length || rightPremises.length) {
    if (!leftPremises.length || !rightPremises.length) return false;
    const rightPremiseSet = new Set(rightPremises);
    if (!leftPremises.some((premise) => rightPremiseSet.has(premise))) return false;
  }
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return true;
  return roadsAgree(addressRoads(normalizedLeft), addressRoads(normalizedRight));
};
const providerResidentialTypeValid = (candidate: CommunityCandidate): boolean => candidate.provider === 'amap'
  ? candidate.typecode === '120302'
  : /(?:住宅|小区|公寓|家园|花园|新村|嘉园|名苑|家属院)/u.test(candidate.typecode);
const nowIso = (): string => new Date().toISOString();
const providerQuotaTimezoneOffsetMinutes = 480;
// China map providers reset their daily request quotas at UTC+8 midnight.
export const nextProviderQuotaBoundary = (now = new Date()): Date => {
  const offsetMs = providerQuotaTimezoneOffsetMinutes * 60_000;
  const shifted = new Date(now.getTime() + offsetMs);
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCDate(shifted.getUTCDate() + 1);
  return new Date(shifted.getTime() - offsetMs);
};
const coverageProviderPriority: ProviderName[] = ['amap', 'tencent', 'baidu'];
// Provider search APIs cap a query window at 200 records. The page counts
// below use each provider's documented maximum page size without fetching a
// duplicate tail page.
export const maxPagesForProvider = (provider: ProviderName): number => provider === 'amap' ? 8 : 10;
const candidateYieldInterval = 25;
const targetYieldInterval = 50;
const maxAreaCityBytes = 128 * 1024 * 1024;
const checkpointStrategyVersions: Record<ProviderName, string> = {
  amap: 'community-poi-v9-amap-compatible',
  baidu: 'community-poi-v7',
  tencent: 'community-poi-v7'
};
const checkpointStrategyVersion = (provider: string): string =>
  checkpointStrategyVersions[provider as ProviderName] || 'community-poi-v7';
const credentialPacingMaxWaitMs = 1_100;
const chinaWorkerLeaseId = 'china-sync';
const chinaWorkerLeaseDurationMs = 60_000;
const chinaWorkerLeaseHeartbeatMs = 20_000;
const chinaWorkerShutdownGraceMs = 95 * 60_000;
const chinaExecutionRevision = 'china-runtime-v3-amap-compatibility';
const mainlandProvincePrefixes = [
  '11', '12', '13', '14', '15', '21', '22', '23', '31', '32', '33', '34', '35', '36', '37',
  '41', '42', '43', '44', '45', '46', '50', '51', '52', '53', '54', '61', '62', '63', '64', '65'
];
const mainlandProvinceSql = mainlandProvincePrefixes.map((prefix) => `'${prefix}'`).join(',');
// AreaCity splits direct municipalities into pseudo-cities (重庆城区/重庆郊县) while providers
// return the municipality name itself; match on the target province in that case.
const communityAreaMatch = (community = 'community', target = 'target'): string =>
  `${community}.district=${target}.district AND (${community}.city=${target}.city
    OR (${community}.city=${target}.province AND ${community}.province=${target}.province))`;

interface AreaNode {
  id?: string | number;
  code?: string | number;
  ext_id?: string | number;
  pid?: string | number;
  parent_id?: string | number;
  name?: string;
  level?: string | number;
  longitude?: number | string;
  latitude?: number | string;
  geo?: string;
  children?: AreaNode[];
  child?: AreaNode[];
}

interface AreaRow {
  adcode: string;
  parent: string | null;
  level: string;
  name: string;
  path: string;
  longitude: number | null;
  latitude: number | null;
}

export interface ChinaAreaListQuery {
  provinceAdcode?: string;
  cityAdcode?: string;
  districtAdcode?: string;
  page?: number;
  pageSize?: number;
}

export interface ChinaAreaOption { adcode: string; name: string }
export interface ChinaAreaListResult {
  items: Array<Record<string, unknown>>;
  total: number;
  page: number;
  pageSize: number;
  options: { provinces: ChinaAreaOption[]; cities: ChinaAreaOption[]; districts: ChinaAreaOption[] };
}

export interface SyncTarget {
  id: string;
  province: string;
  city: string;
  district: string;
  query: string;
  targetCount: number;
}

export interface ChinaWorkerConfig {
  postgresUrl: string;
  masterKey: Buffer;
  credentialBroker?: { url: string; token: string };
}

interface ChinaPostcodeRow {
  code: string;
  locality_name: string;
  region_name: string;
  region_native_name: string;
  region_zh_name: string;
  latitude: number | null;
  longitude: number | null;
}

export interface ChinaWorkerData {
  postgresUrl: string;
  masterKey: Uint8Array;
  credentialBroker?: { url: string; token: string };
  dataRoot: string;
  runId: string;
  targets: SyncTarget[];
  providers: ProviderName[];
}

export type ChinaWorkerMessage =
  | { type: 'progress'; progress: Record<string, unknown> }
  | { type: 'done'; syncState: string; waitReason: string };

interface ChinaAreaRow {
  adcode: string;
  province: string;
  city: string;
  district: string;
  count: number;
}

const utf8Hex = (value: string): string => Buffer.from(value, 'utf8').toString('hex');

const candidateFromIngestRow = (row: Record<string, unknown>): CommunityCandidate => ({
  provider: String(row.provider) as ProviderName,
  providerPoiId: String(row.provider_poi_id),
  name: String(row.name),
  address: String(row.address),
  province: String(row.province),
  city: String(row.city),
  district: String(row.district),
  township: String(row.township),
  longitude: Number(row.longitude),
  latitude: Number(row.latitude),
  rawLongitude: Number(row.raw_longitude),
  rawLatitude: Number(row.raw_latitude),
  rawCrs: String(row.raw_crs) as CommunityCandidate['rawCrs'],
  responseHash: String(row.response_hash),
  typecode: String(row.typecode),
  adcode: String(row.adcode)
});

export const chinaNodeScope = (nodeKey: string): Record<string, string> | null => {
  const parts = nodeKey.split(':');
  const decode = (hexValue: string): string => Buffer.from(hexValue, 'hex').toString('utf8');
  if (parts[0] !== 'CN') return null;
  if (parts[1] === 'a1' && parts.length === 3) return { province: decode(parts[2]) };
  if (parts[1] === 'loc' && parts.length === 4) return { province: decode(parts[2]), city: decode(parts[3]) };
  if (parts[1] === 'dist' && parts.length === 5) {
    return { province: decode(parts[2]), city: decode(parts[3]), district: decode(parts[4]) };
  }
  return null;
};

interface CoverageNodeState { count: number; target: number }

export class ChinaCoverageTracker {
  private readonly districts = new Map<string, CoverageNodeState & { province: string; cityKey: string }>();
  private readonly cities = new Map<string, CoverageNodeState>();
  private readonly provinces = new Map<string, CoverageNodeState>();
  private readonly coverageRatio: number;
  private satisfiedDistricts = 0;
  private satisfiedCities = 0;
  private satisfiedProvinces = 0;
  private constrainedDistricts = 0;
  private constrainedCities = 0;
  private constrainedProvinces = 0;

  constructor(
    rows: ChinaAreaRow[],
    policy: { minPerNode: number; coverageRatio: number; level1Min: number; level2Min: number },
    overrides: Map<string, number>
  ) {
    this.coverageRatio = policy.coverageRatio;
    overrides = new Map([...overrides].map(([key, target]) => [canonicalPolicyNodeKey(key), target]));
    for (const row of rows) {
      const cityKey = `${row.province}|${row.city}`;
      if (!this.provinces.has(row.province)) {
        this.provinces.set(row.province, { count: 0, target: overrides.get(`CN:a1:${utf8Hex(row.province)}`) ?? policy.level1Min });
      }
      if (!this.cities.has(cityKey)) {
        this.cities.set(cityKey, {
          count: 0, target: overrides.get(`CN:loc:${utf8Hex(row.province)}:${utf8Hex(row.city)}`) ?? policy.level2Min
        });
      }
      this.provinces.get(row.province)!.count += row.count;
      this.cities.get(cityKey)!.count += row.count;
      this.districts.set(row.adcode, {
        province: row.province, cityKey, count: row.count,
        target: overrides.get(`CN:dist:${utf8Hex(row.province)}:${utf8Hex(row.city)}:${utf8Hex(row.district)}`) ?? policy.minPerNode
      });
    }
    const satisfied = (node: CoverageNodeState): boolean => node.target <= 0 || node.count >= node.target;
    for (const node of this.districts.values()) {
      if (node.target > 0) this.constrainedDistricts += 1;
      if (satisfied(node)) this.satisfiedDistricts += 1;
    }
    for (const node of this.cities.values()) {
      if (node.target > 0) this.constrainedCities += 1;
      if (satisfied(node)) this.satisfiedCities += 1;
    }
    for (const node of this.provinces.values()) {
      if (node.target > 0) this.constrainedProvinces += 1;
      if (satisfied(node)) this.satisfiedProvinces += 1;
    }
  }

  get size(): number { return this.districts.size; }

  record(adcode: string, inserted: number): void {
    const district = this.districts.get(adcode);
    if (!district || !inserted) return;
    const bump = (node: CoverageNodeState, onSatisfied: () => void): void => {
      if (node.target > 0 && node.count < node.target && node.count + inserted >= node.target) onSatisfied();
      node.count += inserted;
    };
    bump(district, () => { this.satisfiedDistricts += 1; });
    bump(this.cities.get(district.cityKey)!, () => { this.satisfiedCities += 1; });
    bump(this.provinces.get(district.province)!, () => { this.satisfiedProvinces += 1; });
  }

  needsSync(adcode: string): boolean {
    const district = this.districts.get(adcode);
    if (!district) return true;
    if (district.target > 0 && district.count < district.target) return true;
    const city = this.cities.get(district.cityKey)!;
    if (city.target > 0 && city.count < city.target) return true;
    const province = this.provinces.get(district.province)!;
    return province.target > 0 && province.count < province.target;
  }

  deficit(adcode: string): number {
    const district = this.districts.get(adcode);
    if (!district) return 0;
    const city = this.cities.get(district.cityKey)!;
    const province = this.provinces.get(district.province)!;
    return Math.max(0, district.target - district.count)
      + Math.max(0, city.target - city.count)
      + Math.max(0, province.target - province.count);
  }

  ratio(): number {
    const parts: number[] = [];
    if (this.constrainedDistricts && this.districts.size) parts.push(this.satisfiedDistricts / this.districts.size);
    if (this.constrainedCities && this.cities.size) parts.push(this.satisfiedCities / this.cities.size);
    if (this.constrainedProvinces && this.provinces.size) parts.push(this.satisfiedProvinces / this.provinces.size);
    return parts.length ? Math.min(...parts) : 1;
  }

  met(): boolean {
    return !this.districts.size || this.ratio() >= this.coverageRatio;
  }

  uncovered(): string[] {
    return [...this.districts.keys()].filter((adcode) => this.needsSync(adcode));
  }
}

const csvRecords = (text: string): string[][] => {
  const records: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { value += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') { row.push(value); value = ''; }
    else if (character === '\n') { row.push(value.replace(/\r$/u, '')); records.push(row); row = []; value = ''; }
    else value += character;
  }
  if (value || row.length) { row.push(value.replace(/\r$/u, '')); records.push(row); }
  return records;
};

export class ChinaDataService {
  private running = false;
  private starting = false;
  private continuationTimer: NodeJS.Timeout | undefined;
  private leaseHeartbeatTimer: NodeJS.Timeout | undefined;
  private activeWorker: Worker | undefined;
  private workerCompletion: Promise<void> | undefined;
  private resolveWorkerCompletion: (() => void) | undefined;
  private executionPromise: Promise<void> | undefined;
  private lastProgress: Record<string, unknown> | null = null;
  private closed = false;
  private syncState: 'ready' | 'below_target' | 'cooldown_wait' | 'quota_wait' | 'source_limited' | 'blocked' = 'below_target';
  private nextAttemptAt: string | null = null;
  private waitReason = '';
  private statusSnapshot: { expiresAt: number; promise: Promise<Record<string, unknown>> } | undefined;
  private postcodeCatalogPromise: Promise<ChinaPostcodeRow[]> | undefined;
  private postcodeIndexPromise: Promise<Map<string, ChinaPostcodeRow[]>> | undefined;
  private readonly credentialBroker: ChinaCredentialBroker | null;
  private readonly leaseOwnerToken = randomUUID();
  private leaseHeld = false;

  constructor(
    private readonly addressDb: Database,
    private readonly control: ControlStore,
    private readonly dataRoot = resolve('data'),
    private readonly workerConfig?: ChinaWorkerConfig
  ) {
    this.credentialBroker = workerConfig?.credentialBroker
      ? new CredentialBrokerClient(workerConfig.credentialBroker) as ChinaCredentialBroker
      : null;
  }

  private async chinaPostcodeCatalog(): Promise<ChinaPostcodeRow[]> {
    if (!this.postcodeCatalogPromise) {
      this.postcodeCatalogPromise = this.addressDb.prepare(`SELECT p.code,p.locality_name,
          COALESCE(r.name,'') AS region_name,COALESCE(r.native_name,'') AS region_native_name,
          COALESCE(r.zh_name,'') AS region_zh_name,p.latitude,p.longitude
        FROM catalog_postcodes p LEFT JOIN catalog_regions r ON r.id=p.region_id
        WHERE p.country_code='CN' AND p.code ~ '^[0-9]{6}$'`).all<ChinaPostcodeRow>()
        .then((result) => result.results || []).catch(() => []);
    }
    return this.postcodeCatalogPromise;
  }

  private async chinaPostcodeIndex(): Promise<Map<string, ChinaPostcodeRow[]>> {
    if (!this.postcodeIndexPromise) {
      this.postcodeIndexPromise = this.chinaPostcodeCatalog().then((catalog) => {
        const index = new Map<string, ChinaPostcodeRow[]>();
        for (const row of catalog) {
          const region = normalizeChinaPostcodeName([row.region_zh_name, row.region_native_name, row.region_name].find(Boolean) || '');
          const locality = normalizeChinaPostcodeName(row.locality_name);
          if (!region || !locality) continue;
          const key = `${region}\u0000${locality}`;
          const values = index.get(key) || [];
          values.push(row);
          index.set(key, values);
        }
        return index;
      }).catch(() => new Map<string, ChinaPostcodeRow[]>());
    }
    return this.postcodeIndexPromise;
  }

  private resolveChinaPostcode(candidate: CommunityCandidate, catalog: ChinaPostcodeRow[], index?: Map<string, ChinaPostcodeRow[]>): string {
    const province = normalizeChinaPostcodeName(candidate.province);
    if (!province) return '';
    const localityNames = [candidate.township, candidate.district, candidate.city].map(normalizeChinaPostcodeName).filter(Boolean);
    const scoped = index ? [] : catalog.filter((row) => {
      const region = normalizeChinaPostcodeName([row.region_zh_name, row.region_native_name, row.region_name].find(Boolean) || '');
      return region === province;
    });
    const matches = localityNames.map((name) => index
      ? index.get(`${province}\u0000${name}`) || []
      : scoped.filter((row) => normalizeChinaPostcodeName(row.locality_name) === name))
      .find((rows) => rows.length) || [];
    if (!matches.length) return '';
    const uniqueCodes = [...new Set(matches.map((row) => row.code))];
    if (uniqueCodes.length === 1) return uniqueCodes[0];
    if (!Number.isFinite(candidate.latitude) || !Number.isFinite(candidate.longitude)) return '';
    if (matches.some((row) => !Number.isFinite(row.latitude) || !Number.isFinite(row.longitude))) return '';
    const nearbyCodes = [...new Set(matches.filter((row) =>
      distanceMeters(
        { latitude: candidate.latitude, longitude: candidate.longitude },
        { latitude: Number(row.latitude), longitude: Number(row.longitude) }
      ) <= 8_000)
      .map((row) => row.code))];
    return nearbyCodes.length === 1 ? nearbyCodes[0] : '';
  }

  private async enrichMissingPostcodes(limit = 100_000): Promise<number> {
    const catalog = await this.chinaPostcodeCatalog();
    if (!catalog.length) return 0;
    const index = await this.chinaPostcodeIndex();
    const rows = (await this.addressDb.prepare(`SELECT id,province,city,district,township,latitude,longitude
      FROM cn_communities_v2 WHERE postcode='' OR postcode IS NULL ORDER BY updated_at LIMIT ?`).bind(limit).all<Record<string, unknown>>()).results;
    let updated = 0;
    const writeBatch = async (batch: Array<[string, string]>): Promise<void> => {
      if (!batch.length) return;
      const values = batch.map(() => '(?,?)').join(',');
      await this.addressDb.prepare(`UPDATE cn_communities_v2 AS community
        SET postcode=source.postcode,updated_at=?
        FROM (VALUES ${values}) AS source(id,postcode)
        WHERE community.id=source.id AND (community.postcode='' OR community.postcode IS NULL)`)
        .bind(nowIso(), ...batch.flat()).run();
    };
    let batch: Array<[string, string]> = [];
    for (const row of rows) {
      const postcode = this.resolveChinaPostcode({
        provider: 'amap', providerPoiId: String(row.id), name: '', address: '', province: String(row.province),
        city: String(row.city), district: String(row.district), township: String(row.township || ''),
        latitude: Number(row.latitude), longitude: Number(row.longitude), rawLatitude: Number(row.latitude), rawLongitude: Number(row.longitude),
        rawCrs: 'GCJ-02', responseHash: '', typecode: '120302', adcode: ''
      }, catalog, index);
      if (!postcode) continue;
      batch.push([String(row.id), postcode]);
      if (batch.length >= 500) {
        const size = batch.length;
        await writeBatch(batch);
        updated += size;
        batch = [];
      }
    }
    const size = batch.length;
    await writeBatch(batch);
    updated += size;
    return updated;
  }

  private async credentialState(names: ProviderName[] = coverageProviderPriority): Promise<{
    configured: boolean; eligible: boolean; reason: string; nextAvailableAt: string | null;
    providers: ProviderName[]; configuredProviders: ProviderName[];
  }> {
    if (!this.credentialBroker) {
      const providers = (await this.control.availableProviders()).filter((provider) => names.includes(provider));
      const [availability, ...providerAvailability] = await Promise.all([
        this.control.credentialAvailability(names),
        ...names.map((provider) => this.control.credentialAvailability([provider]))
      ]);
      const configuredProviders = names.filter((_, index) => providerAvailability[index].configured);
      return { ...availability, providers, configuredProviders };
    }
    try {
      const statuses = await this.credentialBroker.availability(names);
      const providers = names.filter((provider) => statuses[provider]?.available);
      const configuredProviders = names.filter((provider) => statuses[provider]?.known
        && !String(statuses[provider]?.reason || '').startsWith('api_key_disabled:'));
      const nextWaiting = names.map((provider) => statuses[provider])
        .filter((status) => status?.nextResetAt && Number.isFinite(Date.parse(status.nextResetAt)))
        .sort((left, right) => Date.parse(left.nextResetAt!) - Date.parse(right.nextResetAt!))[0];
      const nextAvailableAt = nextWaiting?.nextResetAt || null;
      const configured = names.some((provider) => statuses[provider]?.known);
      const reason = providers.length ? 'ready' : nextWaiting?.waitState === 'quota_wait' ? 'quota'
        : nextWaiting?.waitState === 'cooldown_wait' ? 'cooldown'
          : names.map((provider) => statuses[provider]?.reason).find(Boolean) || 'blocked';
      return { configured, eligible: providers.length > 0, reason, nextAvailableAt, providers, configuredProviders };
    } catch {
      return {
        configured: true, eligible: false, reason: 'credential_broker_unavailable', nextAvailableAt: null,
        providers: [], configuredProviders: []
      };
    }
  }

  private async persistRuntimeState(goalState: 'complete' | 'incomplete' | 'disabled'): Promise<void> {
    await this.addressDb.prepare(`INSERT INTO sync_country_runtime(
        country_code,goal_state,execution_state,next_attempt_at,reason,updated_at
      ) VALUES ('CN',?,?,?,?,?)
      ON CONFLICT(country_code) DO UPDATE SET goal_state=excluded.goal_state,
        execution_state=excluded.execution_state,next_attempt_at=excluded.next_attempt_at,
        reason=excluded.reason,updated_at=excluded.updated_at`)
      .bind(goalState, this.running ? 'running' : this.syncState, this.nextAttemptAt, this.waitReason || null, nowIso()).run();
  }

  private markSchedulingFailure(reason = 'SYNC_SCHEDULER_FAILED'): void {
    this.syncState = 'blocked';
    this.nextAttemptAt = null;
    this.waitReason = reason;
    void this.persistRuntimeState('incomplete').catch(() => undefined);
  }

  private async executionFingerprint(providers: ProviderName[]): Promise<string> {
    return createHash('sha256').update(JSON.stringify([
      chinaExecutionRevision, checkpointStrategyVersions,
      await this.control.credentialConfigurationRevision(providers)
    ])).digest('hex');
  }

  private async deferFailedRun(fingerprint: string): Promise<boolean> {
    const runs = await this.control.runs(3, 'china-communities');
    const latest = runs[0];
    if (!latest) return false;
    let failures = 0;
    for (const run of runs) {
      if (run.status !== 'failed' || (run.target as Record<string, unknown>)?.executionFingerprint !== fingerprint
        || Number((run.progress as Record<string, unknown>)?.accepted || 0) > 0
        || run.error_code !== latest.error_code || run.error_message !== latest.error_message) break;
      failures += 1;
    }
    if (!failures) return false;
    const retryAt = Date.parse(String(latest.updated_at)) + 5 * 60_000 * 2 ** (failures - 1);
    if (failures < 3 && retryAt <= Date.now()) return false;
    this.syncState = failures >= 3 ? 'blocked' : 'cooldown_wait';
    this.waitReason = `${failures >= 3 ? 'retry_suspended' : 'retry_backoff'}:${latest.error_code || 'CHINA_SYNC_FAILURE'}`;
    if (this.continuationTimer) clearTimeout(this.continuationTimer);
    this.continuationTimer = undefined;
    this.nextAttemptAt = null;
    if (failures < 3) this.armContinuation(new Date(retryAt));
    await this.persistRuntimeState('incomplete');
    return true;
  }

  private async acquireWorkerLease(): Promise<boolean> {
    const heartbeatAt = nowIso();
    const expiresAt = new Date(Date.parse(heartbeatAt) + chinaWorkerLeaseDurationMs).toISOString();
    const lease = await this.addressDb.prepare(`INSERT INTO sync_worker_leases(
        worker_id,owner_token,heartbeat_at,expires_at,updated_at
      ) VALUES (?,?,?,?,?)
      ON CONFLICT(worker_id) DO UPDATE SET owner_token=excluded.owner_token,
        heartbeat_at=excluded.heartbeat_at,expires_at=excluded.expires_at,updated_at=excluded.updated_at
      WHERE sync_worker_leases.expires_at<=excluded.heartbeat_at
        OR sync_worker_leases.owner_token=excluded.owner_token
      RETURNING owner_token,expires_at`)
      .bind(chinaWorkerLeaseId, this.leaseOwnerToken, heartbeatAt, expiresAt, heartbeatAt)
      .first<{ owner_token: string; expires_at: string }>();
    this.leaseHeld = lease?.owner_token === this.leaseOwnerToken;
    if (this.leaseHeld) return true;
    const current = await this.addressDb.prepare('SELECT expires_at FROM sync_worker_leases WHERE worker_id=?')
      .bind(chinaWorkerLeaseId).first<{ expires_at: string }>();
    this.armLeaseRetry(current?.expires_at || new Date(Date.now() + chinaWorkerLeaseHeartbeatMs).toISOString());
    return false;
  }

  private armLeaseRetry(expiresAt: string): void {
    const dueAt = Math.max(Date.now() + 1_000, Date.parse(expiresAt) || 0);
    this.nextAttemptAt = new Date(dueAt).toISOString();
    if (this.continuationTimer) clearTimeout(this.continuationTimer);
    this.continuationTimer = setTimeout(() => {
      this.continuationTimer = undefined;
      void this.start().catch((error) => {
        if (error instanceof Error && error.message === 'CHINA_SYNC_STANDBY') return;
        if (!(error instanceof Error) || !['CHINA_SYNC_BUSY', 'CHINA_SYNC_RETRY_WAIT', 'NO_AVAILABLE_KEY', 'NO_PENDING_SOURCE'].includes(error.message)) {
          this.markSchedulingFailure(error instanceof Error ? error.message : 'SYNC_START_FAILED');
        }
        void this.scheduleContinuation().catch(() => this.markSchedulingFailure());
      });
    }, Math.max(250, dueAt - Date.now()));
    this.continuationTimer.unref?.();
  }

  private startLeaseHeartbeat(): void {
    if (!this.leaseHeld || this.leaseHeartbeatTimer) return;
    this.leaseHeartbeatTimer = setInterval(() => {
      void this.renewWorkerLease().catch(() => this.stopAfterLeaseLoss());
    }, chinaWorkerLeaseHeartbeatMs);
    this.leaseHeartbeatTimer.unref?.();
  }

  private async renewWorkerLease(): Promise<void> {
    if (!this.leaseHeld) return;
    const heartbeatAt = nowIso();
    const expiresAt = new Date(Date.parse(heartbeatAt) + chinaWorkerLeaseDurationMs).toISOString();
    const renewed = await this.addressDb.prepare(`UPDATE sync_worker_leases SET heartbeat_at=?,expires_at=?,updated_at=?
      WHERE worker_id=? AND owner_token=? RETURNING owner_token`)
      .bind(heartbeatAt, expiresAt, heartbeatAt, chinaWorkerLeaseId, this.leaseOwnerToken)
      .first<{ owner_token: string }>();
    if (renewed?.owner_token !== this.leaseOwnerToken) {
      this.leaseHeld = false;
      this.stopAfterLeaseLoss();
    }
  }

  private stopAfterLeaseLoss(): void {
    if (this.leaseHeartbeatTimer) clearInterval(this.leaseHeartbeatTimer);
    this.leaseHeartbeatTimer = undefined;
    this.activeWorker?.postMessage({ type: 'stop' });
  }

  private async releaseWorkerLease(): Promise<void> {
    if (this.leaseHeartbeatTimer) clearInterval(this.leaseHeartbeatTimer);
    this.leaseHeartbeatTimer = undefined;
    if (!this.leaseHeld) return;
    this.leaseHeld = false;
    await this.addressDb.prepare('DELETE FROM sync_worker_leases WHERE worker_id=? AND owner_token=?')
      .bind(chinaWorkerLeaseId, this.leaseOwnerToken).run();
  }

  private async refreshCoverage(): Promise<void> {
    for (let attempts = 1; attempts <= 3; attempts += 1) {
      try {
        await refreshAddressCoverage(this.addressDb, { chinaOnly: true });
        await this.addressDb.prepare(`INSERT INTO address_pool_revisions(kind,version) VALUES ('generation:CN',?)
          ON CONFLICT(kind) DO UPDATE SET version=excluded.version`).bind(randomUUID()).run();
        return;
      } catch (error) {
        const code = String((error as { code?: string })?.code || 'COVERAGE_REFRESH_FAILED');
        if (attempts < 3 && ['57014', '55P03', '40001', '40P01'].includes(code)) {
          await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempts - 1)));
          continue;
        }
        console.error('[china-sync] coverage refresh failed', code);
        await this.control.audit('system', 'china.coverage.refresh_failed', 'CN', { code, attempts }).catch(() => undefined);
        return;
      }
    }
  }

  async initializeTargets(options: { scheduleContinuation?: boolean } = {}): Promise<void> {
    const now = nowIso();
    await this.addressDb.batch(initialChinaCities.map((city, index) => this.addressDb.prepare(`INSERT INTO cn_sync_targets(
      city,province,priority,enabled,target_count,updated_at) VALUES (?,?,?,1,?,?)
      ON CONFLICT (city) DO NOTHING`).bind(city, '', index + 1, index < 31 ? 800 : 500, now)));
    await this.refreshAreaTargets();
    await this.rebuildPublishedCommunitiesFromCandidates();
    if (!this.workerConfig) await this.reprocessRejectedMismatches();
    await this.reconcileCommunityVerification();
    await this.refreshCoverage();
    if (options.scheduleContinuation !== false) {
      void this.scheduleContinuation(1_000).catch(() => this.markSchedulingFailure());
    }
  }

  private async rebuildPublishedCommunitiesFromCandidates(): Promise<void> {
    const publishedRows = Number(await this.addressDb.prepare('SELECT COUNT(*) AS total FROM cn_communities_v2').first('total') || 0);
    if (publishedRows) return;
    const acceptedRows = Number(await this.addressDb.prepare("SELECT COUNT(*) AS total FROM cn_ingest_candidates WHERE decision='accepted'")
      .first('total') || 0);
    if (!acceptedRows) return;
    const baselineTarget = (await getCountryPolicy(this.addressDb, 'CN')).minPerNode;
    let provider = '';
    let providerPoiId = '';
    for (;;) {
      const rows = (await this.addressDb.prepare(`SELECT provider,provider_poi_id,target_adcode,name,address,province,city,district,
        township,longitude,latitude,raw_longitude,raw_latitude,raw_crs,response_hash,typecode,adcode
        FROM cn_ingest_candidates WHERE decision='accepted'
          AND (provider>? OR (provider=? AND provider_poi_id>?))
        ORDER BY provider,provider_poi_id LIMIT 500`).bind(provider, provider, providerPoiId)
        .all<Record<string, unknown>>()).results;
      if (!rows.length) break;
      for (const row of rows) {
        const candidate = candidateFromIngestRow(row);
        await this.processCandidate(candidate, {
          id: String(row.target_adcode), province: candidate.province, city: candidate.city,
          district: candidate.district, query: `${candidate.city}${candidate.district}`, targetCount: baselineTarget
        });
      }
      const last = rows.at(-1)!;
      provider = String(last.provider);
      providerPoiId = String(last.provider_poi_id);
    }
  }

  private async reprocessRejectedMismatches(): Promise<void> {
    // Candidates rejected only for the municipality pseudo-city mismatch are recoverable
    // without spending any provider quota; replay them through the acceptance pipeline.
    let provider = '';
    let providerPoiId = '';
    for (;;) {
      const rows = (await this.addressDb.prepare(`SELECT provider,provider_poi_id,target_adcode,name,address,province,city,district,
        township,longitude,latitude,raw_longitude,raw_latitude,raw_crs,response_hash,typecode,adcode
        FROM cn_ingest_candidates WHERE decision='rejected' AND rejection_reason='administrative_mismatch'
          AND (provider>? OR (provider=? AND provider_poi_id>?))
        ORDER BY provider,provider_poi_id LIMIT 500`).bind(provider, provider, providerPoiId)
        .all<Record<string, unknown>>()).results;
      if (!rows.length) break;
      for (const row of rows) {
        const candidate = candidateFromIngestRow(row);
        await this.processCandidate(candidate, {
          id: String(row.target_adcode), province: candidate.province, city: candidate.city,
          district: candidate.district, query: `${candidate.city}${candidate.district}`, targetCount: 0
        });
      }
      const last = rows.at(-1)!;
      provider = String(last.provider);
      providerPoiId = String(last.provider_poi_id);
    }
  }

  private async reconcileCommunityVerification(): Promise<void> {
    await this.addressDb.prepare(`UPDATE cn_communities_v2 SET
      source_count=GREATEST(1,source_counts.fresh_count),
      verification_level=CASE WHEN source_counts.fresh_count>=3 THEN 'L3'
        WHEN source_counts.fresh_count>=2 THEN 'L2' ELSE 'L1' END,
      updated_at=?
    FROM (
      SELECT source.community_id,
        COUNT(DISTINCT CASE WHEN ${chinaFreshTimestampClause('source.last_seen_at')} THEN source.provider END) AS fresh_count
      FROM cn_community_sources source GROUP BY source.community_id
    ) source_counts WHERE source_counts.community_id=cn_communities_v2.id
      AND (cn_communities_v2.source_count<>GREATEST(1,source_counts.fresh_count)
        OR cn_communities_v2.verification_level<>CASE WHEN source_counts.fresh_count>=3 THEN 'L3'
          WHEN source_counts.fresh_count>=2 THEN 'L2' ELSE 'L1' END)`).bind(nowIso()).run();
  }

  private async refreshAreaTargets(): Promise<void> {
    const baselineTarget = (await getCountryPolicy(this.addressDb, 'CN')).minPerNode;
    await this.addressDb.prepare(`UPDATE cn_sync_area_targets SET enabled=0,updated_at=?
      WHERE substr(adcode,1,2) NOT IN (${mainlandProvinceSql})`).bind(nowIso()).run();
    const areas = (await this.addressDb.prepare(`SELECT adcode,parent_adcode,level,name FROM cn_admin_areas
      WHERE level IN ('province','city','district')`).all<{
      adcode: string; parent_adcode: string | null; level: string; name: string;
    }>()).results;
    const byAdcode = new Map(areas.map((area) => [area.adcode, area]));
    const targets = areas.flatMap((district) => {
      if (district.level !== 'district') return [];
      const city = district.parent_adcode ? byAdcode.get(district.parent_adcode) : undefined;
      const province = city?.parent_adcode ? byAdcode.get(city.parent_adcode) : undefined;
      if (!city || !province || !mainlandProvincePrefixes.includes(province.adcode.slice(0, 2))) return [];
      return [[district.adcode, province.name, city.name, district.name, `${city.name}${district.name}`,
        baselineTarget, Number(district.adcode), 1, nowIso()]];
    });
    for (let offset = 0; offset < targets.length; offset += 500) {
      const chunk = targets.slice(offset, offset + 500);
      await this.addressDb.prepare(`INSERT INTO cn_sync_area_targets(
        adcode,province,city,district,query,target_count,priority,enabled,updated_at) VALUES
        ${chunk.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')}
        ON CONFLICT(adcode) DO UPDATE SET province=excluded.province,city=excluded.city,district=excluded.district,
          query=excluded.query,target_count=CASE WHEN cn_sync_area_targets.target_count=10 THEN excluded.target_count
            ELSE cn_sync_area_targets.target_count END,priority=excluded.priority,enabled=1,updated_at=excluded.updated_at`)
        .bind(...chunk.flat()).run();
    }
  }

  private async loadStatusSnapshot(): Promise<Record<string, unknown>> {
    const counts = await this.addressDb.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN source_count>=2 THEN 1 ELSE 0 END),0) AS cross_verified,
      COUNT(DISTINCT city) AS cities FROM cn_communities_v2 community
      WHERE ${chinaCommunityPublicationClause('community')}`).first<Record<string, unknown>>();
    const publishedCount = Number(counts?.total || 0);
    // Keep the durable country projection aligned with the exact same
    // publication query used by the API and generator.
    await this.addressDb.prepare(`UPDATE sync_country_state
      SET address_count=?,residential_count=?,updated_at=?
      WHERE country_code='CN' AND (address_count<>? OR residential_count<>?)`)
      .bind(publishedCount, publishedCount, nowIso(), publishedCount, publishedCount).run();
    let coverage = await this.addressDb.prepare(`SELECT COUNT(*) AS districts_total,
      SUM(CASE WHEN current_count>=target_count THEN 1 ELSE 0 END) AS districts_covered,
      SUM(GREATEST(target_count-current_count,0)) AS communities_needed FROM (
        SELECT target.adcode,target.target_count,COUNT(community.id) AS current_count
        FROM cn_sync_area_targets target LEFT JOIN cn_communities_v2 community
          ON ${communityAreaMatch()}
          AND ${chinaCommunityPublicationClause('community')}
        WHERE target.enabled=1 GROUP BY target.adcode,target.target_count
      ) coverage_counts`).first<Record<string, unknown>>();
    const usingFallback = Number(coverage?.districts_total || 0) === 0;
    if (usingFallback) {
      coverage = await this.addressDb.prepare(`SELECT COUNT(*) AS districts_total,
        SUM(CASE WHEN current_count>=5 THEN 1 ELSE 0 END) AS districts_covered,
        GREATEST(COUNT(*)*5-COALESCE(SUM(current_count),0),0) AS communities_needed FROM (
          SELECT target.city,COUNT(community.id) AS current_count FROM cn_sync_targets target
          LEFT JOIN cn_communities_v2 community ON community.city=target.city
            AND ${chinaCommunityPublicationClause('community')}
          WHERE target.enabled=1 GROUP BY target.city
        ) coverage_counts`).first<Record<string, unknown>>();
    }
    return { ...counts, coverage, usingFallback };
  }

  async status(): Promise<Record<string, unknown>> {
    if (!this.statusSnapshot || this.statusSnapshot.expiresAt <= Date.now()) {
      const promise = this.loadStatusSnapshot();
      this.statusSnapshot = { expiresAt: Number.POSITIVE_INFINITY, promise };
      void promise.then(() => {
        if (this.statusSnapshot?.promise === promise) this.statusSnapshot.expiresAt = Date.now() + 3_000;
      }, () => {
        if (this.statusSnapshot?.promise === promise) this.statusSnapshot = undefined;
      });
    }
    const aggregate = await this.statusSnapshot.promise;
    return {
      ...aggregate, running: this.running,
      syncState: this.running ? 'running' : this.syncState,
      nextAttemptAt: this.nextAttemptAt,
      waitReason: this.waitReason,
      progress: this.lastProgress
    };
  }

  async listAreas(query: ChinaAreaListQuery = {}): Promise<ChinaAreaListResult> {
    const page = Math.max(1, Math.trunc(query.page || 1));
    const pageSize = Math.max(1, Math.min(100, Math.trunc(query.pageSize || 25)));
    const filters: string[] = ['target.enabled=1'];
    const bindings: string[] = [];
    if (query.provinceAdcode) { filters.push('province.adcode=?'); bindings.push(query.provinceAdcode); }
    if (query.cityAdcode) { filters.push('city.adcode=?'); bindings.push(query.cityAdcode); }
    if (query.districtAdcode) { filters.push('district.adcode=?'); bindings.push(query.districtAdcode); }
    const where = filters.join(' AND ');
    const hierarchy = `FROM cn_sync_area_targets target
      JOIN cn_admin_areas district ON district.adcode=target.adcode AND district.level='district'
      JOIN cn_admin_areas city ON city.adcode=district.parent_adcode AND city.level='city'
      JOIN cn_admin_areas province ON province.adcode=city.parent_adcode AND province.level='province'`;
    const total = Number(await this.addressDb.prepare(`SELECT COUNT(*) AS total ${hierarchy} WHERE ${where}`)
      .bind(...bindings).first<number>('total') || 0);
    const itemRows = (await this.addressDb.prepare(`SELECT target.province,target.city,target.adcode AS district_adcode,target.district,
      target.target_count,COUNT(community.id) AS current_count ${hierarchy}
      LEFT JOIN cn_communities_v2 community ON community.province=target.province
        AND ${communityAreaMatch()}
        AND ${chinaCommunityPublicationClause('community')}
      WHERE ${where} GROUP BY target.adcode,target.province,target.city,target.district,target.target_count,target.priority
      ORDER BY current_count,target.priority,district.adcode LIMIT ? OFFSET ?`)
      .bind(...bindings, pageSize, (page - 1) * pageSize).all<Record<string, unknown>>()).results;
    const adminRows = (await this.addressDb.prepare(`SELECT adcode,parent_adcode FROM cn_admin_areas
      WHERE level IN ('city','district')`).all<{ adcode: string; parent_adcode: string }>()).results;
    const parentByAdcode = new Map(adminRows.map((row) => [row.adcode, row.parent_adcode]));
    const items = itemRows.map((row) => {
      const districtAdcode = String(row.district_adcode);
      const cityAdcode = parentByAdcode.get(districtAdcode) || '';
      return { ...row, city_adcode: cityAdcode, province_adcode: parentByAdcode.get(cityAdcode) || '' };
    });
    const provinces = (await this.addressDb.prepare(`SELECT adcode,name FROM cn_admin_areas
      WHERE level='province' AND substr(adcode,1,2) IN (${mainlandProvinceSql}) ORDER BY adcode`)
      .all<ChinaAreaOption>()).results;
    const cities = query.provinceAdcode ? (await this.addressDb.prepare(`SELECT adcode,name FROM cn_admin_areas
      WHERE level='city' AND parent_adcode=? ORDER BY adcode`).bind(query.provinceAdcode).all<ChinaAreaOption>()).results : [];
    const districts = query.cityAdcode ? (await this.addressDb.prepare(`SELECT adcode,name FROM cn_admin_areas
      WHERE level='district' AND parent_adcode=? ORDER BY adcode`).bind(query.cityAdcode).all<ChinaAreaOption>()).results : [];
    return { items, total, page, pageSize, options: { provinces, cities, districts } };
  }

  async start(_input: { cities?: string[]; providers?: ProviderName[]; maxPages?: number } = {}): Promise<string> {
    if (this.running || this.starting) throw new Error('CHINA_SYNC_BUSY');
    this.starting = true;
    try {
    if (this.continuationTimer) clearTimeout(this.continuationTimer);
    this.continuationTimer = undefined;
    const credentialState = await this.credentialState();
    const executionFingerprint = await this.executionFingerprint(credentialState.configuredProviders);
    if (await this.deferFailedRun(executionFingerprint)) throw new Error('CHINA_SYNC_RETRY_WAIT');
    await this.refreshAreaTargets();
    await this.enrichMissingPostcodes();
    const rows = (await this.addressDb.prepare(`SELECT target.adcode AS id,target.province,target.city,target.district,target.query,
      target.target_count FROM cn_sync_area_targets target LEFT JOIN cn_communities_v2 community
      ON ${communityAreaMatch()}
      AND ${chinaCommunityPublicationClause('community')}
      WHERE target.enabled=1 GROUP BY target.adcode,target.province,target.city,target.district,target.query,
        target.target_count,target.priority ORDER BY COUNT(community.id),target.priority`).all<Record<string, unknown>>()).results;
    const targets: SyncTarget[] = rows.map((row) => ({
      id: String(row.id), province: String(row.province), city: String(row.city), district: String(row.district),
      query: String(row.query), targetCount: Number(row.target_count)
    }));
    if (!targets.length) {
      const baselineTarget = (await getCountryPolicy(this.addressDb, 'CN')).minPerNode;
      targets.push(...initialChinaCities.map((city) => ({
        id: city, province: '', city, district: '', query: city, targetCount: baselineTarget
      })));
    }
    const policy = await getCountryPolicy(this.addressDb, 'CN');
    const remainingAreas = await this.remainingSyncAreaIds(policy, targets.map((target) => target.id));
    const pendingProviders = await this.providersWithPendingWindows(remainingAreas, credentialState.configuredProviders);
    if (credentialState.configuredProviders.length && !pendingProviders.length) {
      this.syncState = 'source_limited';
      this.nextAttemptAt = null;
      this.waitReason = await this.publishedCommunityCount() >= policy.targetCount
        ? 'coverage_sources_exhausted' : 'validated_sources_exhausted';
      await this.persistRuntimeState('incomplete');
      throw new Error('NO_PENDING_SOURCE');
    }
    const providers = credentialState.providers.filter((provider) => pendingProviders.includes(provider));
    if (!providers.length) {
      await this.scheduleContinuation();
      throw new Error('NO_AVAILABLE_KEY');
    }
    if (!await this.acquireWorkerLease()) throw new Error('CHINA_SYNC_STANDBY');
    const runId = await this.control.createRun('china-communities', {
      mode: 'automatic', targets: targets.length, providers, executionFingerprint
    });
    this.running = true;
    this.startLeaseHeartbeat();
    this.syncState = 'below_target';
    this.nextAttemptAt = null;
    this.waitReason = '';
    await this.persistRuntimeState('incomplete');
    if (this.workerConfig) {
      try {
        this.launchWorker(runId, targets, providers);
      } catch (error) {
        this.running = false;
        await this.releaseWorkerLease().catch(() => undefined);
        this.markSchedulingFailure('CHINA_SYNC_WORKER');
        await this.control.updateRun(runId, 'failed', {}, {
          code: 'CHINA_SYNC_WORKER', message: error instanceof Error ? error.message : String(error)
        }).catch(() => undefined);
        throw error;
      }
    } else {
      const execution = this.execute(runId, targets, providers).finally(async () => {
        this.running = false;
        await this.releaseWorkerLease().catch(() => undefined);
        void this.scheduleContinuation().catch(() => this.markSchedulingFailure());
      });
      this.executionPromise = execution;
      void execution.catch((error) => console.error('[china-sync] detached execution failed', error));
    }
    return runId;
    } finally {
      this.starting = false;
    }
  }

  async runSync(runId: string, targets: SyncTarget[], providers: ProviderName[]): Promise<{ syncState: string; waitReason: string }> {
    await this.reprocessRejectedMismatches().catch(() => undefined);
    await this.execute(runId, targets, providers);
    return { syncState: this.syncState, waitReason: this.waitReason };
  }

  private launchWorker(runId: string, targets: SyncTarget[], providers: ProviderName[]): void {
    const config = this.workerConfig!;
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      execArgv: ['--import', 'tsx'],
      workerData: {
        postgresUrl: config.postgresUrl,
        masterKey: config.masterKey,
        credentialBroker: config.credentialBroker,
        dataRoot: this.dataRoot,
        runId, targets, providers
      } satisfies ChinaWorkerData
    });
    this.activeWorker = worker;
    this.workerCompletion = new Promise((resolve) => { this.resolveWorkerCompletion = resolve; });
    let completed = false;
    let settled = false;
    let timedOut = false;
    const configuredTimeout = Number.parseInt(process.env.SYNC_JOB_TIMEOUT_MS || '', 10);
    const workerTimeoutMs = Number.isFinite(configuredTimeout)
      ? Math.max(60_000, Math.min(configuredTimeout, 24 * 60 * 60_000)) : 90 * 60_000;
    let hardTimeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      void worker.terminate().catch(() => undefined);
      settle('CHINA_SYNC_JOB_TIMEOUT');
    }, workerTimeoutMs);
    hardTimeout.unref?.();
    worker.on('message', (message: ChinaWorkerMessage) => {
      if (message?.type === 'progress') this.lastProgress = message.progress;
      else if (message?.type === 'done') {
        completed = true;
        if (message.syncState === 'source_limited') {
          this.syncState = 'source_limited';
          this.waitReason = message.waitReason || 'validated_sources_exhausted';
        }
      }
    });
    const settle = (failure?: string): void => {
      if (settled) return;
      settled = true;
      if (hardTimeout) clearTimeout(hardTimeout);
      hardTimeout = undefined;
      if (this.activeWorker === worker) this.activeWorker = undefined;
      this.running = false;
      void this.releaseWorkerLease().catch(() => undefined).then(() => {
        this.resolveWorkerCompletion?.();
        this.resolveWorkerCompletion = undefined;
        if (this.closed) return;
        const markFailed = failure
          ? this.control.updateRun(runId, 'failed', {}, { code: 'CHINA_SYNC_WORKER', message: failure }).catch(() => undefined)
          : Promise.resolve();
        void markFailed.then(() => this.scheduleContinuation()).catch(() => this.markSchedulingFailure());
      });
    };
    worker.once('error', (error) => {
      void worker.terminate().catch(() => undefined);
      settle(error instanceof Error ? error.message : String(error));
    });
    worker.once('exit', (code) => settle(timedOut ? 'CHINA_SYNC_JOB_TIMEOUT'
      : completed || code === 0 ? undefined : `CHINA_SYNC_WORKER_EXIT_${code}`));
  }

  async wake(delayMs = 0): Promise<void> {
    await this.refreshCoverage();
    this.syncState = 'below_target';
    this.nextAttemptAt = null;
    this.waitReason = '';
    await this.scheduleContinuation(delayMs);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.continuationTimer) clearTimeout(this.continuationTimer);
    this.continuationTimer = undefined;
    const worker = this.activeWorker;
    if (!worker) {
      await this.executionPromise?.catch(() => undefined);
      await this.releaseWorkerLease().catch(() => undefined);
      return;
    }
    worker.postMessage({ type: 'stop' });
    const grace = setTimeout(() => { void worker.terminate().catch(() => undefined); }, chinaWorkerShutdownGraceMs);
    grace.unref?.();
    worker.once('exit', () => clearTimeout(grace));
    await this.workerCompletion;
  }

  private async scheduleContinuation(minimumDelayMs = 1_000): Promise<void> {
    if (this.closed || this.running) return;
    const policy = await getCountryPolicy(this.addressDb, 'CN');
    const completion = policy.enabled ? await this.completionState(policy) : 'met';
    if (!policy.enabled || completion === 'met') {
      this.syncState = 'ready';
      this.nextAttemptAt = null;
      this.waitReason = '';
      if (this.continuationTimer) clearTimeout(this.continuationTimer);
      this.continuationTimer = undefined;
      await this.persistRuntimeState(policy.enabled ? 'complete' : 'disabled');
      return;
    }
    if (this.syncState === 'source_limited') {
      this.nextAttemptAt = null;
      if (this.continuationTimer) clearTimeout(this.continuationTimer);
      this.continuationTimer = undefined;
      await this.persistRuntimeState('incomplete');
      return;
    }
    const fullAvailability = await this.credentialState();
    const remainingAreas = await this.remainingSyncAreaIds(policy);
    const pendingProviders = await this.providersWithPendingWindows(remainingAreas, fullAvailability.configuredProviders);
    if (remainingAreas.length && fullAvailability.configuredProviders.length && !pendingProviders.length) {
      this.syncState = 'source_limited';
      this.waitReason = await this.publishedCommunityCount() >= policy.targetCount
        ? 'coverage_sources_exhausted' : 'validated_sources_exhausted';
      this.nextAttemptAt = null;
      await this.persistRuntimeState('incomplete');
      return;
    }
    const availability = pendingProviders.length ? await this.credentialState(pendingProviders) : fullAvailability;
    if (!availability.configured || availability.reason === 'blocked') {
      this.syncState = 'blocked';
      this.waitReason = availability.reason;
      this.nextAttemptAt = null;
      await this.persistRuntimeState('incomplete');
      return;
    }
    if (availability.eligible && await this.deferFailedRun(await this.executionFingerprint(fullAvailability.configuredProviders))) return;
    const dueAt = availability.eligible
      ? new Date(Date.now() + Math.max(0, minimumDelayMs))
      : availability.nextAvailableAt ? new Date(availability.nextAvailableAt) : null;
    if (!dueAt || !Number.isFinite(dueAt.getTime())) {
      this.syncState = availability.reason === 'quota' ? 'quota_wait' : 'blocked';
      this.waitReason = availability.reason;
      this.nextAttemptAt = null;
      await this.persistRuntimeState('incomplete');
      return;
    }
    this.syncState = availability.reason === 'quota' ? 'quota_wait'
      : availability.reason === 'cooldown' ? 'cooldown_wait' : 'below_target';
    this.waitReason = availability.reason;
    this.armContinuation(dueAt);
    await this.persistRuntimeState('incomplete');
  }

  private armContinuation(dueAt: Date): void {
    this.nextAttemptAt = dueAt.toISOString();
    if (this.continuationTimer) clearTimeout(this.continuationTimer);
    this.continuationTimer = setTimeout(() => {
      this.continuationTimer = undefined;
      void this.start().catch((error) => {
        if (error instanceof Error && error.message === 'CHINA_SYNC_STANDBY') return;
        if (!(error instanceof Error) || !['CHINA_SYNC_BUSY', 'CHINA_SYNC_RETRY_WAIT', 'NO_AVAILABLE_KEY', 'NO_PENDING_SOURCE'].includes(error.message)) {
          this.markSchedulingFailure(error instanceof Error ? error.message : 'SYNC_START_FAILED');
        }
        void this.scheduleContinuation().catch(() => this.markSchedulingFailure());
      });
    }, Math.max(250, dueAt.getTime() - Date.now()));
    this.continuationTimer.unref?.();
  }

  private async execute(runId: string, targets: SyncTarget[], providers: ProviderName[]): Promise<void> {
    let accepted = 0;
    let requests = 0;
    let adapterRejectedPages = 0;
    let rawCount = 0;
    let acceptedCount = 0;
    let rejectedCount = 0;
    let duplicateCount = 0;
    let beforeCount: number | null = null;
    const rejectionReasons: Record<string, number> = {};
    const reject = (reason: string, count = 1): void => {
      if (count <= 0) return;
      rejectedCount += count;
      rejectionReasons[reason] = (rejectionReasons[reason] || 0) + count;
    };
    const recordPage = (result: ProviderPage): void => {
      rawCount += result.rawCount;
      reject('adapter_rejected', result.rawCount - result.candidates.length);
    };
    const updateRun = async (status: string, progress: Record<string, unknown>, error?: { code: string; message: string }): Promise<void> => {
      const afterCount = status === 'running' ? null : await this.publishedCommunityCount().catch(() => null);
      await this.control.updateRun(runId, status, { ...progress, beforeCount, afterCount,
        netGrowth: beforeCount !== null && afterCount !== null ? afterCount - beforeCount : null,
        candidateCount: rawCount, acceptedCount, rejectedCount, rejectionReasons,
        metrics: { rawCount, duplicateCount, insertedCount: accepted,
          unprocessedCount: rawCount - acceptedCount - rejectedCount }
      }, error);
    };
    const unavailable = new Set<ProviderName>();
    const paused = new Set<ProviderName>();
    const markUnavailable = async (provider: ProviderName, checkpointKey: string): Promise<void> => {
      unavailable.add(provider);
      if (await this.checkpointStatus(provider, checkpointKey) === 'paused') paused.add(provider);
    };
    try {
      const policy = await getCountryPolicy(this.addressDb, 'CN');
      beforeCount = await this.publishedCommunityCount();
      if (!policy.enabled) {
        await updateRun('succeeded', { phase: 'disabled', accepted, requests, targets: 0, providers: 0 });
        return;
      }
      const countryTarget = policy.targetCount;
      // In-memory counters replace per-page COUNT queries and reduce database round trips.
      // so repeated counting over cn_communities_v2 starves the event loop.
      let publishedCount = await this.publishedCommunityCount();
      const tracker = await this.coverageTracker(policy);
      const targetCounts = new Map<string, number>();
      let processedCandidates = 0;
      let targetIterations = 0;
      const countMet = () => publishedCount >= countryTarget;
      const quotaReached = () => countMet() && tracker.met();
      const coverageSkipped = (target: SyncTarget) => countMet() && !tracker.needsSync(target.id);
      if (countMet() && !tracker.met()) {
        targets = [...targets].sort((left, right) => tracker.deficit(right.id) - tracker.deficit(left.id));
        providers = coverageProviderPriority.filter((provider) => providers.includes(provider));
      }
      const yieldEventLoop = () => new Promise((resolveYield) => setImmediate(resolveYield));
      const currentTargetCount = async (target: SyncTarget): Promise<number> => {
        const known = targetCounts.get(target.id);
        if (known !== undefined) return known;
        const initial = await this.targetCount(target);
        targetCounts.set(target.id, initial);
        return initial;
      };
      const processCandidates = async (candidates: CommunityCandidate[], target: SyncTarget): Promise<void> => {
        let current = await currentTargetCount(target);
        for (const candidate of candidates) {
          if (quotaReached()) break;
          const inserted = await this.processCandidate(candidate, target, (reason, inserted) => {
            if (reason) reject(reason);
            else {
              acceptedCount += 1;
              if (!inserted) duplicateCount += 1;
            }
          });
          accepted += inserted;
          publishedCount += inserted;
          current += inserted;
          targetCounts.set(target.id, current);
          tracker.record(target.id, inserted);
          processedCandidates += 1;
          if (processedCandidates % candidateYieldInterval === 0) await yieldEventLoop();
        }
      };
      const districtWindowTerminal = async (provider: ProviderName, districtAdcode: string): Promise<boolean> => {
        const maxPages = maxPagesForProvider(provider);
        return await this.resumePage(provider, districtAdcode, maxPages) > maxPages;
      };
      const townshipQueue = async (provider: ProviderName, districtAdcode: string): Promise<Array<{ adcode: string; name: string; page: number }>> => {
        const townships = (await this.addressDb.prepare(`SELECT adcode,name FROM cn_admin_areas
          WHERE parent_adcode=? AND level='township' ORDER BY adcode`).bind(districtAdcode)
          .all<{ adcode: string; name: string }>()).results;
        const queue: Array<{ adcode: string; name: string; page: number }> = [];
        const maxPages = maxPagesForProvider(provider);
        for (const township of townships) {
          const page = await this.resumePage(provider, String(township.adcode), maxPages);
          if (page <= maxPages) queue.push({ adcode: String(township.adcode), name: String(township.name), page });
        }
        return queue;
      };
      // A terminal district window subdivides into per-township keyword queries, each with its
      // own resumable checkpoint keyed by the township adcode; townships advance round-robin so
      // the high-yield first pages of every township are fetched before any deep page.
      const processTownshipRounds = async (provider: ProviderName, target: SyncTarget, phase: 'baseline' | 'enrichment'): Promise<void> => {
        const maxPages = maxPagesForProvider(provider);
        const queue = await townshipQueue(provider, target.id);
        while (queue.length) {
          for (let index = 0; index < queue.length;) {
            if (quotaReached() || (countMet() && !tracker.needsSync(target.id))) return;
            const entry = queue[index];
            const previousPageSignature = await this.checkpointPageSignature(provider, entry.adcode);
            const result = await this.fetchPage(provider, target, entry.page, accepted, async () => { requests += 1; }, entry.adcode, entry.name);
            if (!result) {
              await markUnavailable(provider, entry.adcode);
              return;
            }
            recordPage(result);
            if (result.rawCount === 0) {
              await this.writeCheckpoint(provider, entry.adcode, entry.page, 'exhausted', accepted, '', result.pageSignature);
              queue.splice(index, 1);
              continue;
            }
            if (previousPageSignature && previousPageSignature === result.pageSignature) {
              await this.writeCheckpoint(provider, entry.adcode, entry.page, 'exhausted', accepted,
                'repeated_page_signature', result.pageSignature);
              queue.splice(index, 1);
              continue;
            }
            if (!result.candidates.length) {
              adapterRejectedPages += 1;
              await this.writeCheckpoint(provider, entry.adcode, entry.page + 1, phase, accepted,
                `adapter_rejected_all:raw_count=${result.rawCount}`, result.pageSignature);
              entry.page += 1;
              if (entry.page > maxPages) queue.splice(index, 1);
              else index += 1;
              continue;
            }
            await processCandidates(result.candidates, target);
            await this.writeCheckpoint(provider, entry.adcode, entry.page + 1, phase, accepted, '', result.pageSignature);
            await updateRun('running', { phase, accepted, requests, target: `${target.query}${entry.name}`, provider, page: entry.page });
            entry.page += 1;
            if (entry.page > maxPages) {
              queue.splice(index, 1);
              continue;
            }
            index += 1;
          }
        }
      };
      await updateRun('running', { phase: 'baseline', accepted, requests, target: '', provider: '', page: 0 });
      for (const target of targets) {
        targetIterations += 1;
        if (targetIterations % targetYieldInterval === 0) await yieldEventLoop();
        if (quotaReached()) break;
        if (coverageSkipped(target)) continue;
        for (const provider of providers) {
          const maxPages = maxPagesForProvider(provider);
          if (quotaReached()) break;
          if (unavailable.has(provider)) continue;
          const firstPage = await this.resumePage(provider, target.id, maxPages);
          for (let page = firstPage; page <= maxPages; page += 1) {
            const previousPageSignature = await this.checkpointPageSignature(provider, target.id);
            const result = await this.fetchPage(provider, target, page, accepted, async () => { requests += 1; });
            if (!result) {
              await markUnavailable(provider, target.id);
              break;
            }
            recordPage(result);
            if (result.rawCount === 0) {
              await this.writeCheckpoint(provider, target.id, page, 'exhausted', accepted, '', result.pageSignature);
              break;
            }
            if (previousPageSignature && previousPageSignature === result.pageSignature) {
              await this.writeCheckpoint(provider, target.id, page, 'exhausted', accepted,
                'repeated_page_signature', result.pageSignature);
              break;
            }
            if (!result.candidates.length) {
              adapterRejectedPages += 1;
              await this.writeCheckpoint(provider, target.id, page + 1, 'baseline', accepted,
                `adapter_rejected_all:raw_count=${result.rawCount}`, result.pageSignature);
              continue;
            }
            await processCandidates(result.candidates, target);
            await this.writeCheckpoint(provider, target.id, page + 1, 'baseline', accepted, '', result.pageSignature);
            await updateRun('running', { phase: 'baseline', accepted, requests, target: target.query, provider, page });
            if (quotaReached()) break;
            if (await currentTargetCount(target) >= target.targetCount) break;
          }
          if (!unavailable.has(provider) && !quotaReached()
            && await currentTargetCount(target) < target.targetCount
            && await districtWindowTerminal(provider, target.id)) {
            await processTownshipRounds(provider, target, 'baseline');
          }
        }
        if (unavailable.size === providers.length) {
          const status = paused.size === providers.length ? 'paused_quota' : 'failed';
          await updateRun(status, { phase: 'baseline', accepted, requests, target: target.query },
            status === 'failed' ? { code: 'CHINA_SYNC_SOURCE_FAILURE', message: 'All configured China sources failed for this run' } : undefined);
          return;
        }
      }
      if (await this.baselineComplete()) await this.retireLegacyChinaResidential();
      await updateRun('running', { phase: 'enrichment', accepted, requests, target: '', provider: '', page: 0 });
      for (const target of targets) {
        targetIterations += 1;
        if (targetIterations % targetYieldInterval === 0) await yieldEventLoop();
        if (quotaReached()) break;
        if (coverageSkipped(target)) continue;
        for (const provider of providers) {
          const maxPages = maxPagesForProvider(provider);
          if (quotaReached()) break;
          if (unavailable.has(provider)) continue;
          const firstPage = await this.resumePage(provider, target.id, maxPages);
          for (let page = firstPage; page <= maxPages; page += 1) {
            const previousPageSignature = await this.checkpointPageSignature(provider, target.id);
            const result = await this.fetchPage(provider, target, page, accepted, async () => { requests += 1; });
            if (!result) { await markUnavailable(provider, target.id); break; }
            recordPage(result);
            if (result.rawCount === 0) {
              await this.writeCheckpoint(provider, target.id, page, 'exhausted', accepted, '', result.pageSignature);
              break;
            }
            if (previousPageSignature && previousPageSignature === result.pageSignature) {
              await this.writeCheckpoint(provider, target.id, page, 'exhausted', accepted,
                'repeated_page_signature', result.pageSignature);
              break;
            }
            if (!result.candidates.length) {
              adapterRejectedPages += 1;
              await this.writeCheckpoint(provider, target.id, page + 1, 'enrichment', accepted,
                `adapter_rejected_all:raw_count=${result.rawCount}`, result.pageSignature);
              continue;
            }
            await processCandidates(result.candidates, target);
            await this.writeCheckpoint(provider, target.id, page + 1, 'enrichment', accepted, '', result.pageSignature);
            await updateRun('running', { phase: 'enrichment', accepted, requests, target: target.query, provider, page });
            if (quotaReached()) break;
          }
          if (!unavailable.has(provider) && !quotaReached()
            && (!countMet() || tracker.needsSync(target.id))
            && await districtWindowTerminal(provider, target.id)) {
            await processTownshipRounds(provider, target, 'enrichment');
          }
        }
        if (unavailable.size === providers.length) {
          const status = paused.size === providers.length ? 'paused_quota' : 'failed';
          await updateRun(status, { phase: 'enrichment', accepted, requests, target: target.query },
            status === 'failed' ? { code: 'CHINA_SYNC_SOURCE_FAILURE', message: 'All configured China sources failed for this run' } : undefined);
          return;
        }
      }
      await updateRun(adapterRejectedPages ? 'needs_review' : 'succeeded', {
        phase: 'complete', accepted, requests, targets: targets.length, providers: providers.length, adapterRejectedPages,
        published: publishedCount
      });
      const configuredProviders = (await this.credentialState()).configuredProviders;
      const remainingAreas = countMet() ? tracker.uncovered() : targets.map((target) => target.id);
      if (!quotaReached() && await this.coverageSourcesExhausted(remainingAreas, configuredProviders)) {
        this.syncState = 'source_limited';
        this.waitReason = countMet() ? 'coverage_sources_exhausted' : 'validated_sources_exhausted';
      }
    } catch (error) {
      await updateRun('failed', { accepted, requests }, {
        code: String((error as { code?: string })?.code || (error instanceof Error ? error.name : 'SYNC_ERROR')),
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      await this.refreshCoverage();
    }
  }

  private async publishedCommunityCount(): Promise<number> {
    return Number(await this.addressDb.prepare(`SELECT COUNT(*) AS total FROM cn_communities_v2 community
      WHERE ${chinaCommunityPublicationClause('community')}`).first('total') || 0);
  }

  private async targetCount(target: SyncTarget): Promise<number> {
    return Number(await this.addressDb.prepare(`SELECT COUNT(*) AS total FROM cn_communities_v2 community
      WHERE (community.city=? OR (?<>'' AND community.city=? AND community.province=?)) AND (?='' OR community.district=?)
      AND ${chinaCommunityPublicationClause('community')}`)
      .bind(target.city, target.province, target.province, target.province, target.district, target.district)
      .first('total') || 0);
  }

  private async uncoveredTargetCount(): Promise<number> {
    const rows = (await this.addressDb.prepare(`SELECT target.target_count,COUNT(community.id) AS current_count
      FROM cn_sync_area_targets target LEFT JOIN cn_communities_v2 community
      ON ${communityAreaMatch()}
      AND ${chinaCommunityPublicationClause('community')}
      WHERE target.enabled=1 GROUP BY target.adcode,target.target_count
    `).all<{ target_count: number; current_count: number }>()).results;
    return rows.filter((row) => Number(row.current_count) < Number(row.target_count)).length;
  }

  private async areaPublishedCounts(): Promise<ChinaAreaRow[]> {
    const rows = (await this.addressDb.prepare(`SELECT target.adcode AS adcode,target.province,target.city,target.district,
      COUNT(community.id) AS current_count
      FROM cn_sync_area_targets target LEFT JOIN cn_communities_v2 community
      ON ${communityAreaMatch()}
      AND ${chinaCommunityPublicationClause('community')}
      WHERE target.enabled=1 GROUP BY target.adcode,target.province,target.city,target.district`)
      .all<Record<string, unknown>>()).results;
    return rows.map((row) => ({
      adcode: String(row.adcode), province: String(row.province || ''), city: String(row.city || ''),
      district: String(row.district || ''), count: Number(row.current_count || 0)
    }));
  }

  private async chinaNodeOverrides(): Promise<Map<string, number>> {
    const rows = (await this.addressDb.prepare(`SELECT node_key,min_count FROM sync_node_overrides
      WHERE country_code='CN' AND min_count IS NOT NULL`).all<{ node_key: string; min_count: number }>()).results;
    return new Map(rows.map((row) => [String(row.node_key), Number(row.min_count)]));
  }

  private async coverageTracker(policy: CountryPolicy): Promise<ChinaCoverageTracker> {
    return new ChinaCoverageTracker(await this.areaPublishedCounts(), policy, await this.chinaNodeOverrides());
  }

  private async completionState(policy: CountryPolicy): Promise<'incomplete' | 'met'> {
    const published = await this.publishedCommunityCount();
    if (published < policy.targetCount) return 'incomplete';
    return (await this.coverageTracker(policy)).met() ? 'met' : 'incomplete';
  }

  private async remainingSyncAreaIds(policy: CountryPolicy, fallback: string[] = []): Promise<string[]> {
    const targetIds = (await this.addressDb.prepare(`SELECT adcode FROM cn_sync_area_targets
      WHERE enabled=1 ORDER BY priority,adcode`).all<{ adcode: string }>()).results.map((row) => String(row.adcode));
    const areas = targetIds.length ? targetIds : fallback;
    if (await this.publishedCommunityCount() < policy.targetCount) return areas;
    return (await this.coverageTracker(policy)).uncovered();
  }

  private async coverageSourcesExhausted(uncoveredAreas: string[], providers: ProviderName[]): Promise<boolean> {
    if (!uncoveredAreas.length || !providers.length) return false;
    return (await this.providersWithPendingWindows(uncoveredAreas, providers)).length === 0;
  }

  private async providersWithPendingWindows(areas: string[], providers: ProviderName[]): Promise<ProviderName[]> {
    const remaining = [...new Set(areas.filter(Boolean))];
    if (!remaining.length || !providers.length) return [];
    const placeholders = remaining.map(() => '?').join(',');
    const knownTargets = Number(await this.addressDb.prepare(`SELECT COUNT(*) AS total FROM cn_sync_area_targets
      WHERE enabled=1 AND adcode IN (${placeholders})`).bind(...remaining).first('total') || 0);
    if (!knownTargets) return providers;
    const pending = await Promise.all(providers.map(async (provider) => {
      const maxPages = maxPagesForProvider(provider);
      const value = await this.addressDb.prepare(`SELECT 1 AS pending FROM cn_sync_area_targets target
          LEFT JOIN cn_sync_checkpoints checkpoint ON checkpoint.city=target.adcode
            AND checkpoint.provider=? AND checkpoint.strategy_version=?
          WHERE target.enabled=1 AND target.adcode IN (${placeholders}) AND (checkpoint.city IS NULL OR NOT (
            checkpoint.status='exhausted' OR checkpoint.page>?
            OR (checkpoint.status='adapter_rejected_all' AND checkpoint.page>=?)
          ))
          UNION ALL
          SELECT 1 FROM cn_admin_areas township
          JOIN cn_sync_area_targets target ON target.adcode=township.parent_adcode AND target.enabled=1
          LEFT JOIN cn_sync_checkpoints checkpoint ON checkpoint.city=township.adcode
            AND checkpoint.provider=? AND checkpoint.strategy_version=?
          WHERE target.adcode IN (${placeholders}) AND township.level='township'
            AND (checkpoint.city IS NULL OR NOT (
            checkpoint.status='exhausted' OR checkpoint.page>?
            OR (checkpoint.status='adapter_rejected_all' AND checkpoint.page>=?)
          ))
          LIMIT 1
        `)
        .bind(provider, checkpointStrategyVersion(provider), ...remaining, maxPages, maxPages,
          provider, checkpointStrategyVersion(provider), ...remaining, maxPages, maxPages)
        .first('pending');
      return value ? provider : null;
    }));
    return pending.filter((provider): provider is ProviderName => provider !== null);
  }

  private async baselineComplete(): Promise<boolean> {
    const targets = Number(await this.addressDb.prepare('SELECT COUNT(*) AS total FROM cn_sync_area_targets WHERE enabled=1').first('total') || 0);
    return targets > 0 && await this.uncoveredTargetCount() === 0;
  }

  private async retireLegacyChinaResidential(): Promise<void> {
    await this.addressDb.prepare(`UPDATE address_pool SET active=0,retired_at=? WHERE country_code='CN' AND active=1
      AND property_type IN ('residential','apartment')`).bind(nowIso()).run();
  }

  private async checkpointPageSignature(provider: ProviderName, city: string): Promise<string> {
    const checkpoint = await this.addressDb.prepare(`SELECT page_signature FROM cn_sync_checkpoints
      WHERE provider=? AND city=? AND strategy_version=?`)
      .bind(provider, city, checkpointStrategyVersion(provider)).first<{ page_signature?: string }>();
    return String(checkpoint?.page_signature || '');
  }

  private async checkpointStatus(provider: ProviderName, city: string): Promise<string> {
    const checkpoint = await this.addressDb.prepare(`SELECT status FROM cn_sync_checkpoints
      WHERE provider=? AND city=?`).bind(provider, city).first<{ status?: string }>();
    return String(checkpoint?.status || 'failed');
  }

  private async resumePage(provider: ProviderName, city: string, maxPages: number): Promise<number> {
    const checkpoint = await this.addressDb.prepare(`SELECT page,status,strategy_version FROM cn_sync_checkpoints
      WHERE provider=? AND city=?`).bind(provider, city).first<{ page: number; status: string; strategy_version: string }>();
    if (!checkpoint) return 1;
    if (checkpoint.strategy_version !== checkpointStrategyVersion(provider)) return 1;
    if (checkpoint.status === 'exhausted') return maxPages + 1;
    if (checkpoint.status === 'adapter_rejected_all') {
      return Math.max(1, Math.min(maxPages + 1, Math.trunc(checkpoint.page || 1) + 1));
    }
    return Math.max(1, Math.min(maxPages + 1, Math.trunc(checkpoint.page || 1)));
  }

  private async fetchPage(
    provider: ProviderName,
    target: SyncTarget,
    page: number,
    accepted: number,
    requested: () => Promise<void>,
    checkpointKey = '',
    subdivision = ''
  ): Promise<ProviderPage | null> {
    const key = checkpointKey || target.id;
    let lastError = '';
    const region = provider === 'amap' && /^\d{6}$/u.test(target.id) ? target.id : target.query;
    if (this.credentialBroker) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const result = await fetchBrokerCommunities(provider, region, page, this.credentialBroker, subdivision);
          await requested();
          return result;
        } catch (error) {
          await requested();
          lastError = error instanceof Error ? error.message : String(error);
          const brokerCode = String((error as { code?: string })?.code || '');
          const retryAt = Date.parse(String((error as { retryAt?: string })?.retryAt || ''));
          const waitMs = retryAt - Date.now();
          if (brokerCode === 'SOURCE_RATE_LIMITED' && attempt < 2 && Number.isFinite(waitMs)
            && waitMs <= credentialPacingMaxWaitMs) {
            await new Promise((resolveWait) => setTimeout(resolveWait, Math.max(1, waitMs)));
            continue;
          }
          const waitForCredential = ['SOURCE_CREDENTIAL_UNAVAILABLE', 'SOURCE_CREDENTIAL_EXPIRED',
            'SOURCE_QUOTA_UNAVAILABLE', 'SOURCE_RATE_LIMITED'].includes(brokerCode);
          await this.writeCheckpoint(provider, key, page, waitForCredential ? 'paused' : 'failed',
            accepted, lastError);
          return null;
        }
      }
      return null;
    }
    const attemptedCredentialIds = new Set<string>();
    let lastOutcome: ProviderRequestError['outcome'] | null = null;
    while (true) {
      const credential = await this.control.acquireCredential(provider, { excludeIds: attemptedCredentialIds });
      if (!credential) {
        if (!attemptedCredentialIds.size) {
          const availability = await this.control.credentialAvailability([provider]);
          if (availability.eligible) continue;
          const waitMs = availability.nextAvailableAt ? Date.parse(availability.nextAvailableAt) - Date.now() : Number.NaN;
          if (availability.reason === 'cooldown' && Number.isFinite(waitMs) && waitMs <= credentialPacingMaxWaitMs) {
            await new Promise((resolveWait) => setTimeout(resolveWait, Math.max(1, waitMs)));
            continue;
          }
        }
        const terminalStatus = lastOutcome && !['qps', 'quota', 'auth'].includes(lastOutcome)
          ? 'failed' : 'paused';
        await this.writeCheckpoint(provider, key, page, terminalStatus, accepted, lastError);
        return null;
      }
      attemptedCredentialIds.add(credential.id);
      try {
        let quotaObservation: ProviderQuotaObservation | undefined;
        const result = await providerFetcher[provider](region, page, credential.secret, fetch, (value) => { quotaObservation = value; }, subdivision);
        await requested();
        await this.control.reportCredential(credential.id, 'success', quotaObservation);
        return result;
      } catch (error) {
        await requested();
        const outcome = error instanceof ProviderRequestError ? error.outcome : 'network';
        lastOutcome = outcome;
        lastError = error instanceof Error ? error.message : String(error);
        await this.control.reportCredential(credential.id, outcome, error instanceof ProviderRequestError
          ? { retryAt: error.retryAt, period: error.quotaPeriod } : undefined);
        await this.writeCheckpoint(provider, key, page, 'failed', accepted, lastError);
      }
    }
  }

  private async writeCheckpoint(provider: string, city: string, page: number, status: string, accepted: number, error = '', pageSignature = ''): Promise<void> {
    await this.addressDb.prepare(`INSERT INTO cn_sync_checkpoints(provider,city,page,status,accepted_count,last_error,page_signature,updated_at,strategy_version)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(provider,city) DO UPDATE SET page=excluded.page,status=excluded.status,
      accepted_count=excluded.accepted_count,last_error=excluded.last_error,updated_at=excluded.updated_at,
      page_signature=CASE WHEN excluded.page_signature IS NULL
        AND cn_sync_checkpoints.strategy_version=excluded.strategy_version
        THEN cn_sync_checkpoints.page_signature ELSE excluded.page_signature END,
      strategy_version=excluded.strategy_version`)
      .bind(provider, city, page, status, accepted, error.slice(0, 500) || null, pageSignature || null,
        nowIso(), checkpointStrategyVersion(provider)).run();
  }

  private async hierarchyValid(candidate: CommunityCandidate, target?: SyncTarget): Promise<boolean> {
    if (target?.city && comparableAdmin(candidate.city) !== comparableAdmin(target.city)
      && comparableAdmin(candidate.city) !== comparableAdmin(target.province)) return false;
    if (target?.district && comparableAdmin(candidate.district) !== comparableAdmin(target.district)) return false;
    if (!candidate.province || !candidate.city || !candidate.district || !candidate.address) return false;
    const count = await this.addressDb.prepare('SELECT COUNT(*) AS total FROM cn_admin_areas').first<number>('total');
    if (!count) return true;
    const province = await this.addressDb.prepare("SELECT adcode FROM cn_admin_areas WHERE level='province' AND name IN (?,?) LIMIT 1")
      .bind(candidate.province, candidate.province.replace(/省$/u, '')).first<{ adcode: string }>();
    if (!province) return false;
    const city = await this.addressDb.prepare("SELECT adcode FROM cn_admin_areas WHERE level='city' AND parent_adcode=? AND name IN (?,?) LIMIT 1")
      .bind(province.adcode, candidate.city, candidate.city.replace(/市$/u, '')).first<{ adcode: string }>();
    if (!city) {
      // Direct municipalities report the province name as the city while AreaCity splits them
      // into pseudo-cities; accept when the district exists under any city of that province.
      if (comparableAdmin(candidate.city) !== comparableAdmin(candidate.province)) return false;
      if (!candidate.district) return false;
      const municipalDistrict = await this.addressDb.prepare(`SELECT district.adcode FROM cn_admin_areas district
        JOIN cn_admin_areas city ON city.adcode=district.parent_adcode AND city.level='city' AND city.parent_adcode=?
        WHERE district.level='district' AND district.name IN (?,?) LIMIT 1`)
        .bind(province.adcode, candidate.district, candidate.district.replace(/[区县]$/u, '')).first<{ adcode: string }>();
      return Boolean(municipalDistrict);
    }
    if (!candidate.district) return true;
    const district = await this.addressDb.prepare(`SELECT adcode FROM cn_admin_areas WHERE level='district' AND parent_adcode=?
      AND name IN (?,?) LIMIT 1`).bind(city.adcode, candidate.district, candidate.district.replace(/[区县]$/u, '')).first<{ adcode: string }>();
    return Boolean(district);
  }

  private async persistCandidate(
    candidate: CommunityCandidate,
    targetAdcode: string,
    decision: 'pending' | 'accepted' | 'rejected',
    rejectionReason = ''
  ): Promise<void> {
    const now = nowIso();
    await this.addressDb.prepare(`INSERT INTO cn_ingest_candidates(provider,provider_poi_id,target_adcode,name,address,province,
      city,district,township,longitude,latitude,raw_longitude,raw_latitude,raw_crs,typecode,adcode,response_hash,decision,
      rejection_reason,strategy_version,first_seen_at,last_seen_at,postcode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(provider,provider_poi_id) DO UPDATE SET target_adcode=excluded.target_adcode,name=excluded.name,
      address=excluded.address,province=excluded.province,city=excluded.city,district=excluded.district,
      township=excluded.township,longitude=excluded.longitude,latitude=excluded.latitude,
      raw_longitude=excluded.raw_longitude,raw_latitude=excluded.raw_latitude,raw_crs=excluded.raw_crs,
      typecode=excluded.typecode,adcode=excluded.adcode,response_hash=excluded.response_hash,decision=excluded.decision,
      rejection_reason=excluded.rejection_reason,strategy_version=excluded.strategy_version,last_seen_at=excluded.last_seen_at,
      postcode=excluded.postcode`).bind(
      candidate.provider, candidate.providerPoiId, targetAdcode, candidate.name, candidate.address, candidate.province,
      candidate.city, candidate.district, candidate.township, candidate.longitude, candidate.latitude,
      candidate.rawLongitude, candidate.rawLatitude, candidate.rawCrs, candidate.typecode, candidate.adcode,
      candidate.responseHash, decision, rejectionReason, checkpointStrategyVersion(candidate.provider), now, now, candidate.postcode || ''
    ).run();
  }

  private async candidateRejectionReason(candidate: CommunityCandidate, target?: SyncTarget): Promise<string> {
    if (!candidate.name) return 'missing_name';
    if (!providerResidentialTypeValid(candidate)) return 'non_residential_provider_type';
    if (!candidate.province || !candidate.city || !candidate.district) return 'missing_administrative_area';
    if ((await this.chinaPostcodeCatalog()).length && !/^\d{6}$/u.test(candidate.postcode || '')) return 'missing_postcode';
    if (!Number.isFinite(candidate.latitude) || !Number.isFinite(candidate.longitude)) return 'invalid_coordinates';
    if (!isChinaDeliveryAddress(candidate.address)) return 'invalid_delivery_address';
    const nonResidential = findNonResidentialMatch({
      countryCode: 'CN', buildingName: candidate.name, formattedAddress: candidate.address
    });
    if (nonResidential.excluded) return `non_residential_${nonResidential.category}`;
    if (matchesCustomBlacklist([candidate.name, candidate.address, candidate.province, candidate.city, candidate.district])) {
      return 'custom_blacklist';
    }
    if (!await this.hierarchyValid(candidate, target)) return 'administrative_mismatch';
    return '';
  }

  private async processCandidate(candidate: CommunityCandidate, target?: SyncTarget, recordDecision?: (reason: string, inserted: number) => void): Promise<number> {
    candidate = { ...candidate, address: normalizeChinaProviderAddress(candidate.address, candidate) };
    if (!/^\d{6}$/u.test(candidate.postcode || '')) {
      candidate = { ...candidate, postcode: this.resolveChinaPostcode(candidate, await this.chinaPostcodeCatalog()) };
    }
    const targetAdcode = target?.id || candidate.adcode;
    await this.persistCandidate(candidate, targetAdcode, 'pending');
    const rejectionReason = await this.candidateRejectionReason(candidate, target);
    if (rejectionReason) {
      await this.persistCandidate(candidate, targetAdcode, 'rejected', rejectionReason);
      recordDecision?.(rejectionReason, 0);
      return 0;
    }
    const inserted = await this.addressDb.transaction(async () => {
      await this.persistCandidate(candidate, targetAdcode, 'accepted');
      const inserted = await this.upsertCandidate(candidate);
      await this.addressDb.prepare(`UPDATE cn_community_sources SET accepted_strategy_version=?
        WHERE provider=? AND provider_poi_id=?`).bind(checkpointStrategyVersion(candidate.provider), candidate.provider, candidate.providerPoiId).run();
      return inserted;
    });
    recordDecision?.('', inserted);
    return inserted;
  }

  private async refreshCommunityVerification(communityId: string, lastSeenAt: string | null): Promise<void> {
    const freshSources = Number(await this.addressDb.prepare(`SELECT COUNT(DISTINCT provider) AS total
      FROM cn_community_sources WHERE community_id=? AND ${chinaFreshTimestampClause('last_seen_at')}`)
      .bind(communityId).first<number>('total') || 0);
    const sourceCount = Math.max(1, freshSources);
    const verificationLevel = sourceCount >= 3 ? 'L3' : sourceCount >= 2 ? 'L2' : 'L1';
    await this.addressDb.prepare(`UPDATE cn_communities_v2 SET
      source_count=?,verification_level=?,
      last_seen_at=COALESCE(?,last_seen_at),updated_at=? WHERE id=?`)
      .bind(sourceCount, verificationLevel, lastSeenAt, nowIso(), communityId).run();
  }

  private async upsertCandidate(candidate: CommunityCandidate): Promise<number> {
    const address = normalizeChinaProviderAddress(candidate.address, candidate);
    const postcodeRequired = (await this.chinaPostcodeCatalog()).length > 0;
    if (!candidate.name || !providerResidentialTypeValid(candidate) || !isChinaDeliveryAddress(address) || !candidate.province || !candidate.city || !candidate.district
      || (postcodeRequired && !/^\d{6}$/u.test(candidate.postcode || ''))
      || !Number.isFinite(candidate.latitude) || !Number.isFinite(candidate.longitude)
      || findNonResidentialMatch({ countryCode: 'CN', buildingName: candidate.name, formattedAddress: address }).excluded
      || matchesCustomBlacklist([candidate.name, address, candidate.province, candidate.city, candidate.district])) return 0;
    candidate = { ...candidate, address };
    if (!await this.hierarchyValid(candidate)) return 0;
    const existingSource = await this.addressDb.prepare(`SELECT source.community_id,community.provider_address
      FROM cn_community_sources source JOIN cn_communities_v2 community ON community.id=source.community_id
      WHERE source.provider=? AND source.provider_poi_id=?`)
      .bind(candidate.provider, candidate.providerPoiId).first<{ community_id: string; provider_address: string }>();
    const now = nowIso();
    if (existingSource && addressesAgree(candidate.address, existingSource.provider_address)) {
      await this.addressDb.prepare(`UPDATE cn_community_sources SET raw_name=?,raw_address=?,raw_longitude=?,raw_latitude=?,
        response_hash=?,last_seen_at=? WHERE provider=? AND provider_poi_id=?`).bind(
        candidate.name, candidate.address, candidate.rawLongitude, candidate.rawLatitude, candidate.responseHash, now,
        candidate.provider, candidate.providerPoiId
      ).run();
      await this.addressDb.prepare('UPDATE cn_communities_v2 SET postcode=COALESCE(NULLIF(?,\'\'),postcode),updated_at=? WHERE id=?')
        .bind(candidate.postcode || '', now, existingSource.community_id).run();
      await this.refreshCommunityVerification(existingSource.community_id, now);
      return 0;
    }
    const normalized = normalizedName(candidate.name);
    const matches = (await this.addressDb.prepare(`SELECT id,latitude,longitude,provider_address FROM cn_communities_v2
      WHERE city=? AND district=? AND normalized_name=? AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ? LIMIT 20`)
      .bind(candidate.city, candidate.district, normalized, candidate.latitude - 0.004, candidate.latitude + 0.004,
        candidate.longitude - 0.004, candidate.longitude + 0.004)
      .all<{ id: string; latitude: number; longitude: number; provider_address: string }>()).results;
    const matched = matches.find((value) => {
      if (distanceMeters(candidate, value) > 300) return false;
      // Missing premise numbers do not confirm a numbered address, and
      // conflicting premise numbers always represent separate candidates.
      return addressesAgree(candidate.address, value.provider_address);
    });
    const communityId = matched?.id || randomUUID();
    if (!matched) {
      await this.addressDb.prepare(`INSERT INTO cn_communities_v2(id,canonical_name,normalized_name,province,city,district,township,
        provider_address,postcode,longitude,latitude,verification_level,source_count,first_seen_at,last_seen_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'L1',1,?,?,?)`).bind(
        communityId, candidate.name, normalized, candidate.province, candidate.city, candidate.district, candidate.township,
        candidate.address, candidate.postcode || '', candidate.longitude, candidate.latitude, now, now, now
      ).run();
    }
    if (existingSource) {
      await this.addressDb.prepare(`UPDATE cn_community_sources SET community_id=?,raw_name=?,raw_address=?,raw_longitude=?,raw_latitude=?,
        raw_crs=?,response_hash=?,last_seen_at=? WHERE provider=? AND provider_poi_id=?`).bind(
        communityId, candidate.name, candidate.address, candidate.rawLongitude, candidate.rawLatitude,
        candidate.rawCrs, candidate.responseHash, now, candidate.provider, candidate.providerPoiId
      ).run();
      await this.refreshCommunityVerification(existingSource.community_id, null);
      const remainingSources = Number(await this.addressDb.prepare(`SELECT COUNT(*) AS total
        FROM cn_community_sources WHERE community_id=?`).bind(existingSource.community_id).first<number>('total') || 0);
      if (!remainingSources) {
        await this.addressDb.prepare('DELETE FROM cn_communities_v2 WHERE id=?').bind(existingSource.community_id).run();
      }
    } else {
      await this.addressDb.prepare(`INSERT INTO cn_community_sources(provider,provider_poi_id,community_id,raw_name,raw_address,
        raw_longitude,raw_latitude,raw_crs,response_hash,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
        candidate.provider, candidate.providerPoiId, communityId, candidate.name, candidate.address,
        candidate.rawLongitude, candidate.rawLatitude, candidate.rawCrs, candidate.responseHash, now, now
      ).run();
    }
    await this.addressDb.prepare('UPDATE cn_communities_v2 SET postcode=COALESCE(NULLIF(?,\'\'),postcode),updated_at=? WHERE id=?')
      .bind(candidate.postcode || '', now, communityId).run();
    await this.refreshCommunityVerification(communityId, now);
    return matched ? 0 : 1;
  }

  async importAreaCity(source: string, version: string): Promise<number> {
    const text = await this.readAreaCitySource(source);
    const rows = this.parseAreaCity(text);
    if (!rows.length) throw new Error('AREACITY_DATA_EMPTY');
    const sourceVersion = version.trim().slice(0, 80);
    if (!sourceVersion) throw new Error('INVALID_AREACITY_VERSION');
    await this.addressDb.transaction(async (transaction) => {
      for (const level of ['township', 'district', 'city', 'province']) {
        await transaction.prepare('DELETE FROM cn_admin_areas WHERE level=?').bind(level).run();
      }
      for (let offset = 0; offset < rows.length; offset += 500) {
        await transaction.batch(rows.slice(offset, offset + 500).map((row) => transaction.prepare(`INSERT INTO cn_admin_areas(
          adcode,parent_adcode,level,name,full_path,longitude,latitude,source_version,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(
          row.adcode, row.parent, row.level, row.name, row.path, row.longitude, row.latitude, sourceVersion, nowIso()
        )));
      }
    });
    await this.refreshAreaTargets();
    await refreshAddressCoverage(this.addressDb, { chinaOnly: true });
    await this.control.audit('admin', 'areacity.import', sourceVersion, { records: rows.length, checksum: createHash('sha256').update(text).digest('hex') });
    return rows.length;
  }

  private parseAreaCity(text: string): AreaRow[] {
    const normalized = text.replace(/^\uFEFF/u, '').trim();
    if (!normalized.startsWith('[') && !normalized.startsWith('{')) return this.parseAreaCityCsv(normalized);
    const payload = JSON.parse(normalized) as AreaNode[] | { data?: AreaNode[] };
    const roots = Array.isArray(payload) ? payload : payload.data || [];
    const rows: AreaRow[] = [];
    const visit = (node: AreaNode, parent: string | null, names: string[], depth: number): void => {
      const adcode = String(node.code ?? node.ext_id ?? node.id ?? '').trim();
      const name = String(node.name || '').trim();
      if (!adcode || !name) return;
      const levels = ['province', 'city', 'district', 'township'];
      const level = typeof node.level === 'string' && levels.includes(node.level) ? node.level : levels[Math.min(depth, 3)];
      const geo = String(node.geo || '').split(',').map(Number);
      const longitude = Number.isFinite(Number(node.longitude)) ? Number(node.longitude) : Number.isFinite(geo[0]) ? geo[0] : null;
      const latitude = Number.isFinite(Number(node.latitude)) ? Number(node.latitude) : Number.isFinite(geo[1]) ? geo[1] : null;
      const path = [...names, name];
      rows.push({ adcode, parent, level, name, path: path.join('/'), longitude, latitude });
      for (const child of node.children || node.child || []) visit(child, adcode, path, depth + 1);
    };
    roots.forEach((root) => visit(root, null, [], 0));
    return rows;
  }

  private parseAreaCityCsv(text: string): AreaRow[] {
    const records = csvRecords(text);
    const headers = (records.shift() || []).map((value) => value.trim().toLowerCase());
    const column = (name: string): number => headers.indexOf(name);
    const idColumn = column('id');
    const parentColumn = column('pid') >= 0 ? column('pid') : column('parent_id');
    const depthColumn = column('deep') >= 0 ? column('deep') : column('level');
    const nameColumn = column('ext_name') >= 0 ? column('ext_name') : column('name');
    if (idColumn < 0 || depthColumn < 0 || nameColumn < 0) throw new Error('INVALID_AREACITY_CSV');
    const levels = ['province', 'city', 'district', 'township'];
    const ancestors: Array<{ id: string; name: string }> = [];
    const rows: AreaRow[] = [];
    for (const record of records) {
      const adcode = String(record[idColumn] || '').trim();
      const name = String(record[nameColumn] || '').trim();
      const depth = Number(record[depthColumn]);
      if (!adcode || !name || !Number.isInteger(depth) || depth < 0 || depth > 3) continue;
      const parentValue = parentColumn >= 0 ? String(record[parentColumn] || '').trim() : '';
      const explicitParent = parentValue === '0' ? '' : parentValue;
      const parent = explicitParent || (depth > 0 ? ancestors[depth - 1]?.id || null : null);
      ancestors.length = depth;
      ancestors[depth] = { id: adcode, name };
      rows.push({
        adcode, parent, level: levels[depth], name,
        path: [...ancestors.slice(0, depth).map((entry) => entry.name), name].join('/'),
        longitude: null, latitude: null
      });
    }
    return rows;
  }

  private async readAreaCitySource(source: string): Promise<string> {
    if (/^https:\/\//iu.test(source)) {
      const response = await fetch(source, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`AREACITY_HTTP_${response.status}`);
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > maxAreaCityBytes) throw new Error('AREACITY_DATA_TOO_LARGE');
      const text = await response.text();
      if (Buffer.byteLength(text) > maxAreaCityBytes) throw new Error('AREACITY_DATA_TOO_LARGE');
      return text;
    }
    if (/^[a-z][a-z\d+.-]*:\/\//iu.test(source)) throw new Error('AREACITY_SOURCE_PROTOCOL');
    const root = resolve(this.dataRoot);
    const path = resolve(root, source);
    const relation = relative(root, path);
    if (!relation || relation.startsWith('..') || isAbsolute(relation)) throw new Error('AREACITY_SOURCE_PATH');
    if ((await stat(path)).size > maxAreaCityBytes) throw new Error('AREACITY_DATA_TOO_LARGE');
    return readFile(path, 'utf8');
  }
}
