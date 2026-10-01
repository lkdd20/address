import type { CountryShortcutConfig, Locale } from '../../domain/types';

export type View = 'dashboard' | 'blacklist' | 'access' | 'providers' | 'addressData' | 'syncHistory' | 'shortcuts' | 'tokens';
export const adminViews = new Set<View>(['dashboard', 'blacklist', 'access', 'providers', 'addressData', 'syncHistory', 'shortcuts', 'tokens']);
export type AdminLocale = Locale;
export interface Credential {
  id: string; provider: string; label: string; mask: string; enabled: boolean; status: string; expiresAt?: string;
  fieldMasks?: { appKey: string; appSecret: string };
  openAICompatible?: { apiKeyMask: string; baseUrl: string; model: string; reasoningEffort: string; maxTokens: number };
  translationRouteId?: string; translationPriority?: number; translationRouteEnabled?: boolean; translationPrompt?: string;
  quotaService: string; quotaPeriod: 'day' | 'month'; quotaUsed: number; quotaLimit: number; quotaRemaining: number;
  officialQuotaLimit?: number; quotaBaseline?: number;
  characterQuota?: { used: number; limit: number; remaining: number; providerUsed: number; providerLimit: number; observedAt: string | null; resetAt: string | null };
  quotaResetAt: string; quotaUsageSource: 'provider' | 'local'; providerReportedAt?: string | null; lastSuccessAt?: string;
  quotaWindows?: Array<{ service: string; period: 'day' | 'month'; used: number; limit: number; remaining: number; resetAt: string; usageSource: 'provider' | 'local'; exhausted: boolean }>;
}
export interface CoverageLevelSummary { key: string; labelEn: string; labelZh: string; covered: number; qualified: number; total: number }
export interface CoverageNode {
  key: string; countryCode: string; level: number; levelLabel: string; regionCode: string; regionName: string;
  residentialCount: number; totalCount: number; childCount: number; updatedAt: string;
  regionNameEn?: string; regionNameZh?: string; levelLabelEn?: string; levelLabelZh?: string; coverageLevels?: CoverageLevelSummary[];
}
export interface SystemStatus {
  todayGrowth: number; apiRequestsToday: number; databaseBytes: number; lastUpdatedAt: string | null; schedulerHeartbeatAt: string | null;
  databaseHealthy: boolean; schedulerHealthy: boolean; serviceHealthy: boolean;
}
export interface DashboardMetrics extends SystemStatus {
  countryCount: number; addressTotal: number; residentialTotal: number; coveredLowest: number; totalLowest: number; coverageRate: number;
}
export interface DashboardData { nodes: CoverageNode[]; countries: CoverageNode[]; metrics: DashboardMetrics }
export interface AmapBrowserStatus { configured: boolean; enabled: boolean; label: string; mask: string; securityMask: string; status: string; lastUsedAt: string | null; updatedAt: string | null }
export interface MapSettings { google: { china: boolean; international: boolean }; amap: { china: boolean; international: boolean }; amapBrowser: AmapBrowserStatus }
export interface TranslationRoute {
  id: string; provider: string; credentialId: string | null; label: string; priority: number; enabled: boolean;
  prompt: string; status: string; model: string; baseUrl: string; reasoningEffort: string; maxTokens: number | null;
  lastUsedAt: string | null; updatedAt: string;
}
export interface TranslationSettings { googleTranslationEnabled: boolean; routes: TranslationRoute[] }
export interface ProviderViewData { credentials?: Credential[]; maps?: MapSettings; translation?: TranslationSettings }
export interface ApiTokenView { id: string; name: string; scopes: string[]; rate_limit_per_minute: number; expires_at: string | null; revoked_at: string | null; token_mask: string; token_revealable: boolean }
export type Mutate = <T = unknown>(path: string, method: string, body?: unknown, success?: string) => Promise<T | undefined>;
export type Reveal = (path: string) => Promise<Record<string, string>>;
export type RequestData = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
export interface BlacklistViewData { keywords: string[]; builtIn: Array<{ category: string; terms: string[] }> }
export interface AdminCountryShortcutConfig extends CountryShortcutConfig { customized: boolean }
export interface ChinaAreaOption { adcode: string; name: string }
export interface ChinaAreaListData {
  items: Array<Record<string, unknown>>; total: number; page: number; pageSize: number;
  options: { provinces: ChinaAreaOption[]; cities: ChinaAreaOption[]; districts: ChinaAreaOption[] };
}
export interface AddressDataSource {
  id: string; name: string; homepageUrl: string; activeDatasetCount: number; acceptedCount: number;
  activeCount: number; latestVersion: string | null; latestImportedAt: string | null;
}
export interface AddressDataCountry {
  countryCode: string; enabled: boolean; currentCount: number; targetCount: number; deficit: number;
  levelLimits: number[]; minPerNode: number; coverageRatio: number; level1Min: number; level2Min: number;
  coverageLowestRatio: number | null; coverageLevel1Ratio: number | null; coverageLevel2Ratio: number | null;
  coverageActual: number; countMet: boolean; coverageMet: boolean;
  targetState: 'met' | 'below_target' | 'source_limited'; pruneCandidates: number;
  lowestCoverage: { level: number; covered: number; qualified: number; total: number; updatedAt: string | null } | null;
  sources: AddressDataSource[]; status: string; nextAttemptAt: string | null; lastSuccessfulAt: string | null; lastError: string | null;
}
export interface AddressNodeTarget {
  key: string; parentKey: string; countryCode: string; level: number; regionCode: string; regionName: string;
  currentCount: number; defaultTarget: number; overrideTarget: number | null; targetCount: number;
  satisfied: boolean; deficit: number; excess: number; updatedAt: string;
}
export interface SyncQueueGoalLevel {
  level: number; minimum: number; total: number; covered: number; qualified: number;
  coverageRatio: number | null; floorRatio: number | null;
}
export interface SyncQueueRules {
  total: { current: number; target: number; met: boolean };
  administrativeCoverage: { actual: number; target: number; met: boolean; covered: number; total: number };
  regionalMinimums: {
    actual: number; target: number; met: boolean;
    lowest: SyncQueueGoalLevel | null; level1: SyncQueueGoalLevel | null; level2: SyncQueueGoalLevel | null;
    overrides: { satisfied: number; total: number; met: boolean };
  };
}
export interface SyncQueueEntry {
  countryCode: string; state: 'running' | 'queued' | 'retry_wait' | 'cooldown_wait' | 'quota_wait' | 'scheduled_wait'
    | 'source_limited' | 'suspended' | 'no_source' | 'blocked' | 'failed' | 'done';
  position?: number | null; nextAttemptAt?: string | null; reason?: string | null;
  deficit: number; target: number; current: number; jobPhase?: string | null; engine?: string;
  unmetRules?: string[]; rules?: SyncQueueRules;
  eta?: { sampleCount: number; medianMs: number; p80Ms: number; estimatedCompletionAt?: string; remainingMedianMs?: number; remainingP80Ms?: number } | null;
}
export interface SyncHistoryItem {
  id: string; kind: string; countryCode: string | null; sourceId: string; trigger: string; status: string;
  createdAt: string; startedAt: string | null; completedAt: string | null; heartbeatAt: string | null;
  deadlineAt: string | null; beforeCount: number | null; afterCount: number | null; netGrowth: number | null;
  beforeGoals?: SyncQueueRules | null; afterGoals?: SyncQueueRules | null;
  candidateCount?: number | null; acceptedCount?: number | null; rejectedCount?: number | null;
  rejectionReasons?: Record<string, number>;
  errorCode: string | null; errorMessage: string | null; failurePhase?: string | null;
}
export interface SyncHistoryData {
  scheduler: { heartbeat_at?: string; last_planned_at?: string; active_run_id?: string | null } | null;
  countries?: string[];
  limit?: number; offset?: number; hasMore?: boolean; nextOffset?: number | null;
  items: SyncHistoryItem[];
}
export interface AddressDataWorkspace { countries: AddressDataCountry[]; queue: SyncQueueData | null }
export interface SyncQueueData {
  available: boolean; generatedAt: string | null;
  job: { id: string; phase: string; trigger: string; shards: string[] } | null;
  entries: SyncQueueEntry[];
}
