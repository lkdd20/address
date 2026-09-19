import {
  useCallback, useEffect, useId, useMemo, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type SyntheticEvent
} from 'react';
import {
  Activity, ArrowDown, ArrowUp, Braces, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Database, Download, FlaskConical, Globe2, History, House, KeyRound, Languages,
  LayoutDashboard, ListOrdered, LogOut, MapPin, Maximize2, Pencil, Plus, Power, RefreshCw, RotateCcw, Save, Search, ShieldBan,
  ShieldCheck, Target, Trash2, TrendingUp, X
} from 'lucide-react';
import { generatedAdminErrors } from '../domain/admin-errors.generated';
import { generatedAdminText } from '../domain/admin-i18n.generated';
import { countryByCode, isCountryCode } from '../domain/countries';
import { localeDefinitions, localizedCountryName, pathForLocale } from '../domain/locales';
import type { CountryShortcutConfig, Locale, LocationOption, LocationShortcut } from '../domain/types';
import { useMapDialogFocus, WorldCoverageMap } from './WorldCoverageMap';
import type { OpenAICompatibleModel } from '../../server/credential-broker/openai-compatible.mjs';

type View = 'dashboard' | 'blacklist' | 'access' | 'providers' | 'addressData' | 'syncQueue' | 'syncHistory' | 'shortcuts' | 'tokens';
const adminViews = new Set<View>(['dashboard', 'blacklist', 'access', 'providers', 'addressData', 'syncQueue', 'syncHistory', 'shortcuts', 'tokens']);
const viewFromLocation = (): View => {
  if (typeof window === 'undefined') return 'dashboard';
  const value = new URL(window.location.href).searchParams.get('view') as View | null;
  return value && adminViews.has(value) ? value : 'dashboard';
};
export type AdminLocale = Locale;
interface SyncAdminProps { locale: Locale }
interface Credential {
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
interface CoverageLevelSummary { key: string; labelEn: string; labelZh: string; covered: number; qualified: number; total: number }
interface CoverageNode {
  key: string; countryCode: string; level: number; levelLabel: string; regionCode: string; regionName: string;
  residentialCount: number; totalCount: number; childCount: number; updatedAt: string;
  regionNameEn?: string; regionNameZh?: string; levelLabelEn?: string; levelLabelZh?: string; coverageLevels?: CoverageLevelSummary[];
}
interface DashboardMetrics {
  countryCount: number; residentialTotal: number; coveredLowest: number; totalLowest: number; coverageRate: number;
  todayUpdates: number; apiRequestsToday: number; databaseBytes: number; lastUpdatedAt: string | null; serviceHealthy: boolean;
}
interface DashboardData { nodes: CoverageNode[]; countries: CoverageNode[]; metrics: DashboardMetrics }
interface AmapBrowserStatus { configured: boolean; enabled: boolean; label: string; mask: string; securityMask: string; status: string; lastUsedAt: string | null; updatedAt: string | null }
interface MapSettings { google: { china: boolean; international: boolean }; amap: { china: boolean; international: boolean }; amapBrowser: AmapBrowserStatus }
interface TranslationRoute {
  id: string; provider: string; credentialId: string | null; label: string; priority: number; enabled: boolean;
  prompt: string; status: string; model: string; baseUrl: string; reasoningEffort: string; maxTokens: number | null;
  lastUsedAt: string | null; updatedAt: string;
}
interface TranslationSettings { googleTranslationEnabled: boolean; routes: TranslationRoute[] }
interface ProviderViewData { credentials?: Credential[]; maps?: MapSettings; translation?: TranslationSettings }
interface ApiTokenView { id: string; name: string; scopes: string[]; rate_limit_per_minute: number; expires_at: string | null; revoked_at: string | null; token_mask: string; token_revealable: boolean }
type Mutate = <T = unknown>(path: string, method: string, body?: unknown, success?: string) => Promise<T | undefined>;
type Reveal = (path: string) => Promise<Record<string, string>>;
type RequestData = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
interface BlacklistViewData { keywords: string[]; builtIn: Array<{ category: string; terms: string[] }> }
interface AdminCountryShortcutConfig extends CountryShortcutConfig { customized: boolean }
interface ChinaAreaOption { adcode: string; name: string }
interface ChinaAreaListData {
  items: Array<Record<string, unknown>>; total: number; page: number; pageSize: number;
  options: { provinces: ChinaAreaOption[]; cities: ChinaAreaOption[]; districts: ChinaAreaOption[] };
}
interface AddressDataSource {
  id: string; name: string; homepageUrl: string; activeDatasetCount: number; acceptedCount: number;
  activeCount: number; latestVersion: string | null; latestImportedAt: string | null;
}
interface AddressDataCountry {
  countryCode: string; enabled: boolean; currentCount: number; targetCount: number; deficit: number;
  levelLimits: number[]; minPerNode: number; coverageRatio: number; level1Min: number; level2Min: number;
  coverageLowestRatio: number | null; coverageLevel1Ratio: number | null; coverageLevel2Ratio: number | null;
  coverageActual: number; countMet: boolean; coverageMet: boolean;
  targetState: 'met' | 'below_target' | 'source_limited'; pruneCandidates: number;
  lowestCoverage: { level: number; covered: number; qualified: number; total: number; updatedAt: string | null } | null;
  sources: AddressDataSource[]; status: string; nextAttemptAt: string | null; lastSuccessfulAt: string | null; lastError: string | null;
}
interface AddressNodeTarget {
  key: string; parentKey: string; countryCode: string; level: number; regionCode: string; regionName: string;
  currentCount: number; defaultTarget: number; overrideTarget: number | null; targetCount: number;
  satisfied: boolean; deficit: number; excess: number; updatedAt: string;
}
interface SyncQueueGoalLevel {
  level: number; minimum: number; total: number; covered: number; qualified: number;
  coverageRatio: number | null; floorRatio: number | null;
}
interface SyncQueueRules {
  total: { current: number; target: number; met: boolean };
  administrativeCoverage: { actual: number; target: number; met: boolean; covered: number; total: number };
  regionalMinimums: {
    actual: number; target: number; met: boolean;
    lowest: SyncQueueGoalLevel | null; level1: SyncQueueGoalLevel | null; level2: SyncQueueGoalLevel | null;
    overrides: { satisfied: number; total: number; met: boolean };
  };
}
interface SyncQueueEntry {
  countryCode: string; state: 'running' | 'queued' | 'retry_wait' | 'cooldown_wait' | 'quota_wait' | 'scheduled_wait'
    | 'source_limited' | 'suspended' | 'no_source' | 'blocked' | 'failed' | 'done';
  position?: number | null; nextAttemptAt?: string | null; reason?: string | null;
  deficit: number; target: number; current: number; jobPhase?: string | null; engine?: string;
  unmetRules?: string[]; rules?: SyncQueueRules;
  eta?: { sampleCount: number; medianMs: number; p80Ms: number; estimatedCompletionAt?: string; remainingMedianMs?: number; remainingP80Ms?: number } | null;
}
interface SyncHistoryItem {
  id: string; kind: string; countryCode: string | null; sourceId: string; trigger: string; status: string;
  createdAt: string; startedAt: string | null; completedAt: string | null; heartbeatAt: string | null;
  deadlineAt: string | null; beforeCount: number | null; afterCount: number | null; netGrowth: number | null;
  beforeGoals?: SyncQueueRules | null; afterGoals?: SyncQueueRules | null;
  candidateCount?: number | null; acceptedCount?: number | null; rejectedCount?: number | null;
  rejectionReasons?: Record<string, number>;
  errorCode: string | null; errorMessage: string | null; failurePhase?: string | null;
}
interface SyncHistoryData {
  scheduler: { heartbeat_at?: string; last_planned_at?: string; active_run_id?: string | null } | null;
  countries?: string[];
  limit?: number; offset?: number; hasMore?: boolean; nextOffset?: number | null;
  items: SyncHistoryItem[];
}
interface SyncQueueData {
  available: boolean; generatedAt: string;
  job: { id: string; phase: string; trigger: string; shards: string[] } | null;
  entries: SyncQueueEntry[];
}

const baseAdminText = {
  'zh-CN': {
    labels: { dashboard: '仪表盘', blacklist: '地址黑名单', providers: '地图密钥', china: '中国同步', access: '访问与安全', tokens: '接口令牌' },
    providers: { amap: '高德地图', baidu: '百度地图', tencent: '腾讯地图', onemap: 'OneMap', youdao: '有道翻译', geoapify: 'Geoapify', 'google-geocoding': 'Google Geocoding', mappls: 'Mappls', 'openai-compatible': 'OpenAI 兼容接口' },
    brandName: '地址', brand: '管理系统', loginTitle: '管理员登录', password: '管理员密码', login: '登录', loggingIn: '登录中…', backGenerator: '返回生成器',
    bootstrap: '请先在服务器配置管理员初始密码并重启服务。', loading: '正在加载…', retry: '重新加载', logout: '退出登录', language: '英文',
    dashboardTitle: '地址数据总览', dashboardDescription: '全面掌握全球真实地址数据的分布与增长情况', totalResidential: '真实住宅总量', countriesCovered: '国家数', regionsCovered: '行政区覆盖率', qualifiedRegions: '今日更新', countryRanking: 'Top 国家排行', coverageDetails: '行政区覆盖明细', allCountries: '全部国家', region: '区域', level: '行政层级', residential: '真实住宅', children: '下级区域', administrativeCoverage: '行政区覆盖', qualifiedCoverage: '至少5条', updated: '更新数据', noSubregions: '暂无下级数据', noAddressData: '暂无地址数据', emptyDashboard: '当前数据库没有地址记录。导入或同步数据后，可继续下钻查看国家、省市和区县。',
    globalDistribution: '全球地址分布', rankByResidential: '按真实住宅总量', viewAllCountries: '全部国家', countryDataList: '国家数据列表', countryCountSuffix: '个国家', searchCountry: '搜索国家', continentFilter: '大洲筛选', allContinents: '全部大洲', asia: '亚洲', europe: '欧洲', northAmerica: '北美洲', southAmerica: '南美洲', africa: '非洲', oceania: '大洋洲', sortBy: '排序方式', sortResidentialDesc: '地址数量：从高到低', sortResidentialAsc: '地址数量：从低到高', sortCountryName: '国家名称', sortCoverageDesc: '行政区覆盖率', exportData: '导出数据', filter: '筛选', allData: '全部数据', coveredOnly: '仅有数据', uncoveredOnly: '仅无数据', country: '国家', coverageColumns: '行政区覆盖', operation: '操作', previous: '上一页', next: '下一页', apiRequestsToday: 'API 请求（今日）', databaseSize: '数据库大小', lastDataUpdate: '最后数据更新', systemStatus: '系统状态', runningNormally: '运行正常', administratorRole: '超级管理员', searchPlaceholder: '搜索国家、城市或邮编…', simplifiedChinese: '简体中文',
    blacklistTitle: '地址黑名单', blacklistDescription: '内置机构规则固定启用；可在下方追加全局排除关键词。', builtinRules: '内置排除规则', customKeywords: '自定义关键词', customKeywordHint: '一行一个关键词，匹配小区名、建筑名、街道或完整地址；最多 500 条。', blacklistSaved: '地址黑名单已保存', saveBlacklist: '保存黑名单', noCustomKeywords: '当前没有自定义关键词',
    accessTitle: '访问策略', accessDescription: '设置前端访问方式和管理员密码。', frontendPasswordEnabled: '启用前端访问密码', newFrontendPassword: '新前端密码', confirmFrontendPassword: '重复前端密码', newAdminPassword: '新管理员密码', confirmAdminPassword: '重复管理员密码', passwordSection: '密码设置', policySection: '访问控制', keepUnchanged: '留空则保持不变', saveSettings: '保存设置', settingsSaved: '访问设置已保存', passwordMismatch: '两次输入的密码不一致。', changeFrontendPassword: '修改前端密码', changeAdminPassword: '修改管理员密码', passwordDialogHint: '请输入新密码并再次确认；保存后输入内容会被清空。', passwordNew: '新密码', passwordConfirm: '重复确认', showPassword: '显示', hidePassword: '隐藏', savePassword: '保存密码',
    providersTitle: '地图密钥', providersDescription: '管理地图 API 凭据；密钥默认隐藏，仅按需显示。', addKey: '添加密钥', addMapKey: '添加地图密钥', provider: 'API 名称', optionalName: '名称（可选）', autoName: '留空自动命名', key: '密钥', cancel: '取消', save: '保存', keySaved: '地图密钥已保存', stop: '停用', enable: '启用', test: '测试', testSuccess: '密钥测试成功', remove: '删除', noKeys: '尚未添加地图密钥', quotaUsage: '额度', quotaDay: '每日', quotaMonth: '每月', quotaReset: '重置', quotaRemaining: '剩余', lastSuccess: '最近成功', quotaBaseline: '本月已有用量', quotaBaselineHint: '填写接入本项目之前在同一 Google 结算账户产生的 Geocoding 用量。', googleOfficialQuota: 'Google 官方免费用量：每个结算账户每月 10,000 次；项目自动同步默认最多使用 9,000 次。', googleSyncBudget: '自动同步月度预算',
    youdaoAppKey: '应用 ID（AppKey）', youdaoAppSecret: '应用密钥（AppSecret）', youdaoSaved: '有道翻译密钥已保存', youdaoConfigured: '已配置', youdaoNotConfigured: '未配置', openAIAdd: '添加 OpenAI 兼容接口', openAISaved: 'OpenAI 兼容翻译配置已保存', openAINotice: '仅调用兼容 OpenAI Chat Completions 的接口翻译地址组件。API Key 只在服务端加密保存；模型输出仍需通过数字、标识符和语言门禁。', openAIKey: 'API Key', openAIEndpoint: '接口地址', openAIModel: '模型', openAIReasoning: '推理档位', openAIReasoningNone: '关闭', openAIReasoningLow: '低', openAIReasoningMedium: '中', openAIMaxTokens: '输出预算', openAIFetchModels: '获取模型', openAIFetchingModels: '获取中', openAIModelFetchEmpty: '接口未返回可用模型', openAIModelFetchFailed: '模型获取失败', openAIPriority: '密钥优先级', openAIPrompt: '模型提示词', openAIPromptHint: '仅用于补充翻译风格；固定地址事实和 JSON 约束始终生效。', translationRoutingTitle: '翻译路由优先级', translationRoutingHint: '数字越小越优先；相同优先级按轮询使用，失败或额度等待会自动跳过。', translationRoute: '路由', translationPriority: '优先级', translationRouteEnabled: '启用', translationRouteSaved: '翻译路由已保存', translationTitle: '在线翻译', googleTranslationToggle: '启用谷歌翻译', translationSaved: '在线翻译设置已保存', geoapifyWorkerHint: '此处保存的 Geoapify Key 会用于韩国住宅地址同步和 API 查询，并按额度与冷却状态自动轮换。',
    mapDisplayTitle: '前端地图显示', mapChina: '中国地址', mapInternational: '国外地址', googleMap: '谷歌地图', amapMap: '高德地图', mapDisplaySaved: '地图显示设置已保存', mapDisplayHint: '关闭的平台不会在前端加载脚本、框架或发起地图请求。',
    amapBrowserTitle: '高德前端地图凭据', configureAmapBrowser: '配置凭据', editAmapBrowser: '修改凭据', amapBrowserDialog: '配置高德前端地图凭据', amapBrowserLabel: '凭据名称', amapBrowserPlaceholder: '高德前端地图', amapApiKey: 'JS API Key', amapSecurityCode: '安全密钥', amapBrowserSaved: '高德前端地图凭据已保存', amapBrowserRemoved: '高德前端地图凭据已删除', amapBrowserEmpty: '尚未配置高德前端地图凭据', amapBrowserSecurity: '用于在地址结果页加载高德 JavaScript 地图，与服务端地址同步使用的高德地图密钥相互独立。', replaceSecret: '留空则保留当前值', amapUpdated: '更新时间', amapLastUsed: '最近使用', confirmRemoveAmap: '确定删除高德前端地图凭据吗？',
    chinaTitle: '中国同步', chinaDescription: '查看合格住宅小区和行政区覆盖。', chinaTotal: '合格住宅小区', cities: '覆盖城市', districts: '覆盖区县', districtCoverage: '区县覆盖', province: '省级', city: '城市', district: '区县', currentCommunities: '当前小区', target: '基础目标', covered: '已覆盖', pending: '待补齐', noAreas: '暂无区县数据', allProvinces: '全部省级', allCities: '全部城市', allDistricts: '全部区县', pageSize: '每页数量', previousPage: '上一页', nextPage: '下一页', pageSummary: '第 {page} / {pages} 页，共 {total} 条',
    tokensTitle: '接口令牌', tokensDescription: '创建、查看、修改和撤销外部接口访问令牌。', addToken: '添加令牌', tokenDialog: '添加接口令牌', editTokenDialog: '修改接口令牌', tokenCreatedTitle: '令牌已创建', tokenCreatedHint: '令牌内容只在管理员会话内显示；请使用复制按钮保存。', name: '名称', tokenValue: '令牌内容', tokenValueHint: '留空时由服务端安全生成', generateToken: '生成令牌', perMinute: '每分钟请求数', prefix: '前缀', scopes: '权限范围', scopeRead: '读取', scopeGenerate: '生成', scopeAll: '全部', scopeHint: '当前接口支持读取和生成；选择全部可同时使用两项能力。', expires: '到期时间', neverExpires: '无限', lastUsed: '最近使用', create: '创建', update: '保存修改', tokenCreated: '令牌已创建', tokenUpdated: '令牌设置已更新', noTokens: '尚未创建接口令牌', revoked: '已撤销', valid: '有效', revoke: '撤销', edit: '编辑', tokenUnavailable: '仅可鉴权', confirmRevokeToken: '确定撤销这个令牌吗？',
    administrator: '管理员', statusLabel: '状态', actions: '操作', close: '关闭', showSecret: '显示', hideSecret: '隐藏', copySecret: '复制', copied: '已复制', revealFailed: '密钥读取失败，请重试。',
    status: { healthy: '正常', expired: '已过期', needs_review: '需检查', cooldown: '冷却中', quota_exhausted: '额度用尽', disabled: '已停用', succeeded: '已完成', failed: '失败' }
  },
  en: {
    labels: { dashboard: 'Dashboard', blacklist: 'Address Blacklist', providers: 'Map Keys', china: 'China Sync', access: 'Access & Security', tokens: 'API Tokens' },
    providers: { amap: 'AMap', baidu: 'Baidu Maps', tencent: 'Tencent Maps', onemap: 'OneMap', youdao: 'Youdao Translate', geoapify: 'Geoapify', 'google-geocoding': 'Google Geocoding', mappls: 'Mappls', 'openai-compatible': 'OpenAI-compatible' },
    brandName: 'ADDRESS', brand: 'Admin Console', loginTitle: 'Administrator sign in', password: 'Administrator password', login: 'Sign in', loggingIn: 'Signing in…', backGenerator: 'Back to generator',
    bootstrap: 'Set ADMIN_BOOTSTRAP_PASSWORD on the server and restart the service first.', loading: 'Loading…', retry: 'Reload', logout: 'Sign out', language: 'Chinese',
    dashboardTitle: 'Address Data Overview', dashboardDescription: 'Monitor the distribution and growth of verified global address data', totalResidential: 'Verified residences', countriesCovered: 'Countries', regionsCovered: 'Administrative coverage', qualifiedRegions: 'Updated today', countryRanking: 'Top countries', coverageDetails: 'Administrative coverage', allCountries: 'All countries', region: 'Region', level: 'Administrative level', residential: 'Verified residential', children: 'Child regions', administrativeCoverage: 'Administrative coverage', qualifiedCoverage: 'At least 5', updated: 'Updated', noSubregions: 'No child regions', noAddressData: 'No address data', emptyDashboard: 'This database has no address records yet. Import or sync data to drill into countries, regions, and districts.',
    globalDistribution: 'Global address distribution', rankByResidential: 'By verified residences', viewAllCountries: 'All countries', countryDataList: 'Country data', countryCountSuffix: 'countries', searchCountry: 'Search countries', continentFilter: 'Filter by continent', allContinents: 'All continents', asia: 'Asia', europe: 'Europe', northAmerica: 'North America', southAmerica: 'South America', africa: 'Africa', oceania: 'Oceania', sortBy: 'Sort countries', sortResidentialDesc: 'Addresses: high to low', sortResidentialAsc: 'Addresses: low to high', sortCountryName: 'Country name', sortCoverageDesc: 'Administrative coverage', exportData: 'Export data', filter: 'Filter', allData: 'All data', coveredOnly: 'With data', uncoveredOnly: 'Without data', country: 'Country', coverageColumns: 'Administrative coverage', operation: 'Action', previous: 'Previous', next: 'Next', apiRequestsToday: 'API requests today', databaseSize: 'Database size', lastDataUpdate: 'Last data update', systemStatus: 'System status', runningNormally: 'Operational', administratorRole: 'Super administrator', searchPlaceholder: 'Search countries, cities, or postcodes…', simplifiedChinese: 'Simplified Chinese',
    blacklistTitle: 'Address blacklist', blacklistDescription: 'Built-in institution rules remain enabled. Add global exclusion keywords below.', builtinRules: 'Built-in exclusion rules', customKeywords: 'Custom keywords', customKeywordHint: 'One keyword per line. Matches community, building, street, or complete address. Maximum 500.', blacklistSaved: 'Address blacklist saved', saveBlacklist: 'Save blacklist', noCustomKeywords: 'No custom keywords configured',
    accessTitle: 'Access policy', accessDescription: 'Configure frontend access and administrator passwords.', frontendPasswordEnabled: 'Require a frontend password', newFrontendPassword: 'New frontend password', confirmFrontendPassword: 'Confirm frontend password', newAdminPassword: 'New administrator password', confirmAdminPassword: 'Confirm administrator password', passwordSection: 'Password settings', policySection: 'Access controls', keepUnchanged: 'Leave blank to keep the current value', saveSettings: 'Save settings', settingsSaved: 'Access settings saved', passwordMismatch: 'The two password entries do not match.', changeFrontendPassword: 'Change frontend password', changeAdminPassword: 'Change administrator password', passwordDialogHint: 'Enter the new password twice. The fields are cleared after saving.', passwordNew: 'New password', passwordConfirm: 'Confirm password', showPassword: 'Show', hidePassword: 'Hide', savePassword: 'Save password',
    providersTitle: 'Map keys', providersDescription: 'Manage map credentials; values stay hidden until explicitly revealed.', addKey: 'Add key', addMapKey: 'Add map key', provider: 'Provider', optionalName: 'Name (optional)', autoName: 'Leave blank to name automatically', key: 'Key', cancel: 'Cancel', save: 'Save', keySaved: 'Map key saved', stop: 'Disable', enable: 'Enable', test: 'Test', testSuccess: 'Key test succeeded', remove: 'Delete', noKeys: 'No map keys configured', quotaUsage: 'Quota', quotaDay: 'Daily', quotaMonth: 'Monthly', quotaReset: 'Resets', quotaRemaining: 'remaining', lastSuccess: 'Last success', quotaBaseline: 'Usage before setup', quotaBaselineHint: 'Enter Geocoding usage already incurred this month under the same Google billing account.', googleOfficialQuota: 'Google free usage: 10,000 monthly events per billing account; automatic sync uses at most 9,000 by default.', googleSyncBudget: 'Monthly sync budget',
    youdaoAppKey: 'Application key', youdaoAppSecret: 'Application secret', youdaoSaved: 'Youdao credential saved', youdaoConfigured: 'Configured', youdaoNotConfigured: 'Not configured', openAIAdd: 'Add OpenAI-compatible endpoint', openAISaved: 'OpenAI-compatible translation saved', openAINotice: 'Only an OpenAI Chat Completions-compatible endpoint is used for address-component translation. The API key is encrypted server-side; model output still passes digit, identifier, and language gates.', openAIKey: 'API key', openAIEndpoint: 'Endpoint', openAIModel: 'Model', openAIReasoning: 'Reasoning', openAIReasoningNone: 'Off', openAIReasoningLow: 'Low', openAIReasoningMedium: 'Medium', openAIMaxTokens: 'Output budget', openAIFetchModels: 'Fetch models', openAIFetchingModels: 'Fetching', openAIModelFetchEmpty: 'The endpoint returned no usable models', openAIModelFetchFailed: 'Model discovery failed', openAIPriority: 'Key priority', openAIPrompt: 'Model prompt', openAIPromptHint: 'Use this only for translation style; fixed address facts and JSON constraints always apply.', translationRoutingTitle: 'Translation route priority', translationRoutingHint: 'Lower numbers run first; equal priorities rotate, and failed or quota-blocked routes are skipped.', translationRoute: 'Route', translationPriority: 'Priority', translationRouteEnabled: 'Enabled', translationRouteSaved: 'Translation routes saved', translationTitle: 'Online translation', googleTranslationToggle: 'Enable Google translation', translationSaved: 'Translation settings saved', geoapifyWorkerHint: 'Geoapify keys saved here are used for Korea residential synchronization and API lookups, with automatic quota and cooldown rotation.',
    mapDisplayTitle: 'Frontend map display', mapChina: 'China addresses', mapInternational: 'International addresses', googleMap: 'Google Maps', amapMap: 'AMap', mapDisplaySaved: 'Map display settings saved', mapDisplayHint: 'A disabled provider loads no frontend script or frame and sends no map request.',
    amapBrowserTitle: 'AMap frontend map credential', configureAmapBrowser: 'Configure credential', editAmapBrowser: 'Edit credential', amapBrowserDialog: 'Configure AMap frontend map credential', amapBrowserLabel: 'Credential name', amapBrowserPlaceholder: 'AMap frontend map', amapApiKey: 'JS API key', amapSecurityCode: 'Security code', amapBrowserSaved: 'AMap frontend map credential saved', amapBrowserRemoved: 'AMap frontend map credential deleted', amapBrowserEmpty: 'No AMap frontend map credential configured', amapBrowserSecurity: 'Used to render AMap on address result pages. It is separate from the AMap keys used for server-side address synchronization.', replaceSecret: 'Leave blank to retain the current value', amapUpdated: 'Updated', amapLastUsed: 'Last used', confirmRemoveAmap: 'Delete the AMap frontend map credential?',
    chinaTitle: 'China sync', chinaDescription: 'Review qualified residential communities and administrative coverage.', chinaTotal: 'Qualified residential communities', cities: 'Cities covered', districts: 'Districts covered', districtCoverage: 'District coverage', province: 'Province', city: 'City', district: 'District', currentCommunities: 'Current communities', target: 'Base target', covered: 'Covered', pending: 'Pending', noAreas: 'No district data', allProvinces: 'All provinces', allCities: 'All cities', allDistricts: 'All districts', pageSize: 'Rows per page', previousPage: 'Previous', nextPage: 'Next', pageSummary: 'Page {page} of {pages}, {total} total',
    tokensTitle: 'API tokens', tokensDescription: 'Create, view, edit, and revoke external API access tokens.', addToken: 'Add token', tokenDialog: 'Add API token', editTokenDialog: 'Edit API token', tokenCreatedTitle: 'Token created', tokenCreatedHint: 'The token stays inside this administrator session. Use Copy to save it.', name: 'Name', tokenValue: 'Token value', tokenValueHint: 'Leave blank to let the server generate one', generateToken: 'Generate token', perMinute: 'Requests per minute', prefix: 'Prefix', scopes: 'Scopes', scopeRead: 'Read', scopeGenerate: 'Generate', scopeAll: 'All', scopeHint: 'This API currently supports Read and Generate. Select All to enable both.', expires: 'Expires', neverExpires: 'Never', lastUsed: 'Last used', create: 'Create', update: 'Save changes', tokenCreated: 'Token created', tokenUpdated: 'Token settings updated', noTokens: 'No API tokens created', revoked: 'Revoked', valid: 'Active', revoke: 'Revoke', edit: 'Edit', tokenUnavailable: 'Authentication only', confirmRevokeToken: 'Revoke this token?',
    administrator: 'Administrator', statusLabel: 'Status', actions: 'Actions', close: 'Close', showSecret: 'Show', hideSecret: 'Hide', copySecret: 'Copy', copied: 'Copied', revealFailed: 'The credential could not be revealed. Try again.',
    status: { healthy: 'Healthy', expired: 'Expired', needs_review: 'Needs review', cooldown: 'Cooling down', quota_exhausted: 'Quota exhausted', disabled: 'Disabled', succeeded: 'Completed', failed: 'Failed' }
  }
} as const;

type DeepString<T> = T extends string ? string : { [Key in keyof T]: DeepString<T[Key]> };
export type AdminDictionary = DeepString<typeof baseAdminText.en>;
export const adminText = { ...baseAdminText, ...generatedAdminText } as unknown as Record<AdminLocale, AdminDictionary>;

const addressDataText: Record<AdminLocale, {
  nav: string; country: string; current: string; target: string; coverage: string; sources: string; status: string; nextRun: string;
  details: string; save: string; sync: string; syncing: string; enabled: string; sourceDetails: string; noSources: string;
  latestVersion: string; activeRecords: string; lastImport: string; lastSuccess: string; lastError: string; unlimitedWait: string;
  saved: string; syncStarted: string; qualified: string;
  targetMet: string; coverageGoal: string; minPerNodeLabel: string; level1MinLabel: string; level2MinLabel: string;
  lowestShort: string; level1Short: string; level2Short: string; prunable: string;
  nodeTargets: string; loadNodeTargets: string; searchNode: string; defaultTag: string; overrideTag: string;
  deficitChip: string; excessChip: string; metChip: string; clearOverride: string; loadMore: string; noNodes: string;
  nodeSaved: string; nodeCleared: string;
  queueTitle: string; queueQueued: string; queueAtTarget: string; queueEmpty: string; queueUnavailable: string; queueResetIn: string;
  policyErrors: Record<string, string>; states: Record<string, string>;
}> = {
  'zh-CN': { nav: '地址数据', country: '国家和地区', current: '当前有效数量', target: '最终目标', coverage: '最低行政区覆盖', sources: '数据来源', status: '同步状态', nextRun: '下一次执行', details: '详情', save: '保存设置', sync: '立即同步', syncing: '同步中', enabled: '启用此国家', sourceDetails: '数据来源', noSources: '尚无已导入数据源', latestVersion: '最新版本', activeRecords: '有效记录', lastImport: '最近导入', lastSuccess: '最近成功', lastError: '状态说明', unlimitedWait: '等待可用来源或凭据', saved: '国家数据设置已保存', syncStarted: '同步任务已提交', qualified: '至少 5 条', targetMet: '已达成', coverageGoal: '覆盖率目标', minPerNodeLabel: '最低层级每节点最少条数', level1MinLabel: '一级行政区最低条数', level2MinLabel: '二级行政区最低条数', lowestShort: '最低层级', level1Short: '一级', level2Short: '二级', prunable: '可精简 {count} 条', nodeTargets: '节点目标', loadNodeTargets: '加载节点目标', searchNode: '搜索节点名称', defaultTag: '默认', overrideTag: '自定义', deficitChip: '缺 {count}', excessChip: '超 {count}', metChip: '达标', clearOverride: '恢复默认', loadMore: '加载更多', noNodes: '暂无节点数据', nodeSaved: '节点目标已保存', nodeCleared: '已恢复默认目标', queueTitle: '同步队列', queueQueued: '排队中', queueAtTarget: '{count} 个国家已达标', queueEmpty: '当前没有待同步的国家', queueUnavailable: '无法连接同步控制服务', queueResetIn: '{time} 后重置', policyErrors: { INVALID_POLICY_TARGET: '最终目标数值无效', INVALID_POLICY_MIN_PER_NODE: '每节点最少条数须在 1 到 100 之间', INVALID_POLICY_COVERAGE_RATIO: '覆盖率目标须在 0% 到 100% 之间', INVALID_POLICY_LEVEL1_MIN: '一级行政区最低条数无效', INVALID_POLICY_LEVEL2_MIN: '二级行政区最低条数无效', INVALID_POLICY_NODE_TARGET: '节点目标须在 0 到 50000 之间' }, states: { disabled: '已停用', ready: '已达目标', below_target: '待补充', running: '同步中', cooldown_wait: '等待冷却', quota_wait: '等待额度重置', source_limited: '来源已达上限', failed: '同步失败', blocked: '需要处理' } },
  'zh-TW': { nav: '地址資料', country: '國家和地區', current: '目前有效數量', target: '最終目標', coverage: '最低行政區覆蓋', sources: '資料來源', status: '同步狀態', nextRun: '下次執行', details: '詳細資料', save: '儲存設定', sync: '立即同步', syncing: '同步中', enabled: '啟用此國家', sourceDetails: '資料來源', noSources: '尚無已匯入資料來源', latestVersion: '最新版本', activeRecords: '有效記錄', lastImport: '最近匯入', lastSuccess: '最近成功', lastError: '狀態說明', unlimitedWait: '等待可用來源或憑證', saved: '國家資料設定已儲存', syncStarted: '同步工作已提交', qualified: '至少 5 筆', targetMet: '已達成', coverageGoal: '覆蓋率目標', minPerNodeLabel: '最低層級每節點最少筆數', level1MinLabel: '一級行政區最低筆數', level2MinLabel: '二級行政區最低筆數', lowestShort: '最低層級', level1Short: '一級', level2Short: '二級', prunable: '可精簡 {count} 筆', nodeTargets: '節點目標', loadNodeTargets: '載入節點目標', searchNode: '搜尋節點名稱', defaultTag: '預設', overrideTag: '自訂', deficitChip: '缺 {count}', excessChip: '超 {count}', metChip: '達標', clearOverride: '恢復預設', loadMore: '載入更多', noNodes: '暫無節點資料', nodeSaved: '節點目標已儲存', nodeCleared: '已恢復預設目標', queueTitle: '同步佇列', queueQueued: '排隊中', queueAtTarget: '{count} 個國家已達標', queueEmpty: '目前沒有待同步的國家', queueUnavailable: '無法連接同步控制服務', queueResetIn: '{time} 後重設', policyErrors: { INVALID_POLICY_TARGET: '最終目標數值無效', INVALID_POLICY_MIN_PER_NODE: '每節點最少筆數須介於 1 到 100', INVALID_POLICY_COVERAGE_RATIO: '覆蓋率目標須介於 0% 到 100%', INVALID_POLICY_LEVEL1_MIN: '一級行政區最低筆數無效', INVALID_POLICY_LEVEL2_MIN: '二級行政區最低筆數無效', INVALID_POLICY_NODE_TARGET: '節點目標須介於 0 到 50000' }, states: { disabled: '已停用', ready: '已達目標', below_target: '待補充', running: '同步中', cooldown_wait: '等待冷卻', quota_wait: '等待額度重設', source_limited: '來源已達上限', failed: '同步失敗', blocked: '需要處理' } },
  en: { nav: 'Address Data', country: 'Country or region', current: 'Current valid records', target: 'Final target', coverage: 'Lowest-level coverage', sources: 'Sources', status: 'Sync status', nextRun: 'Next run', details: 'Details', save: 'Save settings', sync: 'Sync now', syncing: 'Syncing', enabled: 'Enable this country', sourceDetails: 'Data sources', noSources: 'No imported source yet', latestVersion: 'Latest version', activeRecords: 'Active records', lastImport: 'Last import', lastSuccess: 'Last success', lastError: 'Status detail', unlimitedWait: 'Waiting for a source or credential', saved: 'Country data settings saved', syncStarted: 'Sync job submitted', qualified: 'At least 5', targetMet: 'Goal met', coverageGoal: 'Coverage goal', minPerNodeLabel: 'Minimum per lowest-level node', level1MinLabel: 'Level 1 minimum', level2MinLabel: 'Level 2 minimum', lowestShort: 'Lowest', level1Short: 'Level 1', level2Short: 'Level 2', prunable: '{count} prunable', nodeTargets: 'Node targets', loadNodeTargets: 'Load node targets', searchNode: 'Search nodes', defaultTag: 'Default', overrideTag: 'Override', deficitChip: 'Short {count}', excessChip: 'Over {count}', metChip: 'Met', clearOverride: 'Reset to default', loadMore: 'Load more', noNodes: 'No node data', nodeSaved: 'Node target saved', nodeCleared: 'Node target reset', queueTitle: 'Sync queue', queueQueued: 'Queued', queueAtTarget: '{count} countries at target', queueEmpty: 'No countries are waiting to sync', queueUnavailable: 'The sync control service is unreachable', queueResetIn: 'resets in {time}', policyErrors: { INVALID_POLICY_TARGET: 'The final target is invalid.', INVALID_POLICY_MIN_PER_NODE: 'The minimum per node must be between 1 and 100.', INVALID_POLICY_COVERAGE_RATIO: 'The coverage goal must be between 0% and 100%.', INVALID_POLICY_LEVEL1_MIN: 'The level 1 minimum is invalid.', INVALID_POLICY_LEVEL2_MIN: 'The level 2 minimum is invalid.', INVALID_POLICY_NODE_TARGET: 'The node target must be between 0 and 50000.' }, states: { disabled: 'Disabled', ready: 'Target reached', below_target: 'Below target', running: 'Syncing', cooldown_wait: 'Cooling down', quota_wait: 'Waiting for quota reset', source_limited: 'Source limit reached', failed: 'Sync failed', blocked: 'Action required' } },
  ja: { nav: '住所データ', country: '国・地域', current: '現在の有効件数', target: '最終目標', coverage: '最下位行政区の網羅', sources: 'データソース', status: '同期状態', nextRun: '次回実行', details: '詳細', save: '設定を保存', sync: '今すぐ同期', syncing: '同期中', enabled: 'この国を有効化', sourceDetails: 'データソース', noSources: 'インポート済みソースなし', latestVersion: '最新バージョン', activeRecords: '有効レコード', lastImport: '最終インポート', lastSuccess: '最終成功', lastError: '状態詳細', unlimitedWait: '利用可能なソースまたは認証情報を待機中', saved: '国別データ設定を保存しました', syncStarted: '同期ジョブを送信しました', qualified: '5件以上', targetMet: '達成済み', coverageGoal: '網羅率目標', minPerNodeLabel: '最下位ノードあたり最少件数', level1MinLabel: '第1級行政区の最少件数', level2MinLabel: '第2級行政区の最少件数', lowestShort: '最下位', level1Short: '第1級', level2Short: '第2級', prunable: '削減候補 {count} 件', nodeTargets: 'ノード目標', loadNodeTargets: 'ノード目標を読み込む', searchNode: 'ノード名を検索', defaultTag: '既定', overrideTag: 'カスタム', deficitChip: '不足 {count}', excessChip: '超過 {count}', metChip: '達成', clearOverride: '既定に戻す', loadMore: 'さらに読み込む', noNodes: 'ノードデータなし', nodeSaved: 'ノード目標を保存しました', nodeCleared: '既定の目標に戻しました', queueTitle: '同期キュー', queueQueued: '待機中', queueAtTarget: '{count} か国が目標達成', queueEmpty: '同期待ちの国はありません', queueUnavailable: '同期制御サービスに接続できません', queueResetIn: 'あと {time} でリセット', policyErrors: { INVALID_POLICY_TARGET: '最終目標の値が無効です', INVALID_POLICY_MIN_PER_NODE: 'ノードあたり最少件数は 1〜100 で指定してください', INVALID_POLICY_COVERAGE_RATIO: '網羅率目標は 0%〜100% で指定してください', INVALID_POLICY_LEVEL1_MIN: '第1級行政区の最少件数が無効です', INVALID_POLICY_LEVEL2_MIN: '第2級行政区の最少件数が無効です', INVALID_POLICY_NODE_TARGET: 'ノード目標は 0〜50000 で指定してください' }, states: { disabled: '無効', ready: '目標達成', below_target: '目標未達', running: '同期中', cooldown_wait: 'クールダウン中', quota_wait: 'クォータのリセット待ち', source_limited: 'ソース上限', failed: '同期失敗', blocked: '対応が必要' } },
  ko: { nav: '주소 데이터', country: '국가 또는 지역', current: '현재 유효 건수', target: '최종 목표', coverage: '최하위 행정구역 범위', sources: '데이터 원본', status: '동기화 상태', nextRun: '다음 실행', details: '상세', save: '설정 저장', sync: '지금 동기화', syncing: '동기화 중', enabled: '이 국가 사용', sourceDetails: '데이터 원본', noSources: '가져온 원본 없음', latestVersion: '최신 버전', activeRecords: '유효 레코드', lastImport: '최근 가져오기', lastSuccess: '최근 성공', lastError: '상태 설명', unlimitedWait: '사용 가능한 원본 또는 자격 증명 대기 중', saved: '국가 데이터 설정을 저장했습니다', syncStarted: '동기화 작업을 제출했습니다', qualified: '5개 이상', targetMet: '달성됨', coverageGoal: '커버리지 목표', minPerNodeLabel: '최하위 노드당 최소 건수', level1MinLabel: '1급 행정구역 최소 건수', level2MinLabel: '2급 행정구역 최소 건수', lowestShort: '최하위', level1Short: '1급', level2Short: '2급', prunable: '정리 가능 {count}건', nodeTargets: '노드 목표', loadNodeTargets: '노드 목표 불러오기', searchNode: '노드 이름 검색', defaultTag: '기본', overrideTag: '사용자 지정', deficitChip: '부족 {count}', excessChip: '초과 {count}', metChip: '달성', clearOverride: '기본값 복원', loadMore: '더 불러오기', noNodes: '노드 데이터 없음', nodeSaved: '노드 목표를 저장했습니다', nodeCleared: '기본 목표로 복원했습니다', queueTitle: '동기화 대기열', queueQueued: '대기 중', queueAtTarget: '{count}개 국가 목표 달성', queueEmpty: '동기화 대기 중인 국가가 없습니다', queueUnavailable: '동기화 제어 서비스에 연결할 수 없습니다', queueResetIn: '{time} 후 재설정', policyErrors: { INVALID_POLICY_TARGET: '최종 목표 값이 잘못되었습니다', INVALID_POLICY_MIN_PER_NODE: '노드당 최소 건수는 1~100 사이여야 합니다', INVALID_POLICY_COVERAGE_RATIO: '커버리지 목표는 0%~100% 사이여야 합니다', INVALID_POLICY_LEVEL1_MIN: '1급 행정구역 최소 건수가 잘못되었습니다', INVALID_POLICY_LEVEL2_MIN: '2급 행정구역 최소 건수가 잘못되었습니다', INVALID_POLICY_NODE_TARGET: '노드 목표는 0~50000 사이여야 합니다' }, states: { disabled: '사용 안 함', ready: '목표 달성', below_target: '목표 미달', running: '동기화 중', cooldown_wait: '대기 중', quota_wait: '할당량 초기화 대기', source_limited: '원본 한도 도달', failed: '동기화 실패', blocked: '조치 필요' } },
  de: { nav: 'Adressdaten', country: 'Land oder Region', current: 'Aktuell gültig', target: 'Endziel', coverage: 'Abdeckung der untersten Ebene', sources: 'Datenquellen', status: 'Synchronisierungsstatus', nextRun: 'Nächster Lauf', details: 'Details', save: 'Einstellungen speichern', sync: 'Jetzt synchronisieren', syncing: 'Synchronisierung läuft', enabled: 'Dieses Land aktivieren', sourceDetails: 'Datenquellen', noSources: 'Noch keine importierte Quelle', latestVersion: 'Neueste Version', activeRecords: 'Aktive Datensätze', lastImport: 'Letzter Import', lastSuccess: 'Letzter Erfolg', lastError: 'Statusdetails', unlimitedWait: 'Warten auf Quelle oder Zugangsdaten', saved: 'Ländereinstellungen gespeichert', syncStarted: 'Synchronisierungsauftrag übermittelt', qualified: 'Mindestens 5', targetMet: 'Ziel erreicht', coverageGoal: 'Abdeckungsziel', minPerNodeLabel: 'Minimum pro Knoten der untersten Ebene', level1MinLabel: 'Minimum Ebene 1', level2MinLabel: 'Minimum Ebene 2', lowestShort: 'Unterste Ebene', level1Short: 'Ebene 1', level2Short: 'Ebene 2', prunable: '{count} kürzbar', nodeTargets: 'Knotenziele', loadNodeTargets: 'Knotenziele laden', searchNode: 'Knoten suchen', defaultTag: 'Standard', overrideTag: 'Angepasst', deficitChip: 'Fehlt {count}', excessChip: 'Über {count}', metChip: 'Erreicht', clearOverride: 'Auf Standard zurücksetzen', loadMore: 'Mehr laden', noNodes: 'Keine Knotendaten', nodeSaved: 'Knotenziel gespeichert', nodeCleared: 'Knotenziel zurückgesetzt', queueTitle: 'Sync-Warteschlange', queueQueued: 'In Warteschlange', queueAtTarget: '{count} Länder am Ziel', queueEmpty: 'Keine Länder warten auf Synchronisierung', queueUnavailable: 'Der Sync-Steuerdienst ist nicht erreichbar', queueResetIn: 'Reset in {time}', policyErrors: { INVALID_POLICY_TARGET: 'Das Endziel ist ungültig.', INVALID_POLICY_MIN_PER_NODE: 'Das Minimum pro Knoten muss zwischen 1 und 100 liegen.', INVALID_POLICY_COVERAGE_RATIO: 'Das Abdeckungsziel muss zwischen 0 % und 100 % liegen.', INVALID_POLICY_LEVEL1_MIN: 'Das Minimum für Ebene 1 ist ungültig.', INVALID_POLICY_LEVEL2_MIN: 'Das Minimum für Ebene 2 ist ungültig.', INVALID_POLICY_NODE_TARGET: 'Das Knotenziel muss zwischen 0 und 50000 liegen.' }, states: { disabled: 'Deaktiviert', ready: 'Ziel erreicht', below_target: 'Unter Ziel', running: 'Synchronisierung läuft', cooldown_wait: 'Abkühlzeit', quota_wait: 'Warten auf Kontingent', source_limited: 'Quellenlimit erreicht', failed: 'Synchronisierung fehlgeschlagen', blocked: 'Aktion erforderlich' } },
  fr: { nav: 'Données d’adresse', country: 'Pays ou région', current: 'Enregistrements valides', target: 'Objectif final', coverage: 'Couverture du niveau inférieur', sources: 'Sources', status: 'État de synchronisation', nextRun: 'Prochaine exécution', details: 'Détails', save: 'Enregistrer', sync: 'Synchroniser', syncing: 'Synchronisation', enabled: 'Activer ce pays', sourceDetails: 'Sources de données', noSources: 'Aucune source importée', latestVersion: 'Dernière version', activeRecords: 'Enregistrements actifs', lastImport: 'Dernier import', lastSuccess: 'Dernier succès', lastError: 'Détail de l’état', unlimitedWait: 'En attente d’une source ou d’un identifiant', saved: 'Paramètres du pays enregistrés', syncStarted: 'Tâche de synchronisation envoyée', qualified: 'Au moins 5', targetMet: 'Objectif atteint', coverageGoal: 'Objectif de couverture', minPerNodeLabel: 'Minimum par nœud du niveau le plus bas', level1MinLabel: 'Minimum niveau 1', level2MinLabel: 'Minimum niveau 2', lowestShort: 'Niveau le plus bas', level1Short: 'Niveau 1', level2Short: 'Niveau 2', prunable: '{count} réductibles', nodeTargets: 'Objectifs de nœud', loadNodeTargets: 'Charger les objectifs de nœud', searchNode: 'Rechercher un nœud', defaultTag: 'Défaut', overrideTag: 'Personnalisé', deficitChip: 'Manque {count}', excessChip: 'Surplus {count}', metChip: 'Atteint', clearOverride: 'Rétablir la valeur par défaut', loadMore: 'Charger plus', noNodes: 'Aucune donnée de nœud', nodeSaved: 'Objectif de nœud enregistré', nodeCleared: 'Objectif de nœud rétabli', queueTitle: 'File de synchronisation', queueQueued: 'En attente', queueAtTarget: '{count} pays à l’objectif', queueEmpty: 'Aucun pays en attente de synchronisation', queueUnavailable: 'Le service de contrôle de synchronisation est injoignable', queueResetIn: 'réinitialisation dans {time}', policyErrors: { INVALID_POLICY_TARGET: 'L’objectif final est invalide.', INVALID_POLICY_MIN_PER_NODE: 'Le minimum par nœud doit être compris entre 1 et 100.', INVALID_POLICY_COVERAGE_RATIO: 'L’objectif de couverture doit être compris entre 0 % et 100 %.', INVALID_POLICY_LEVEL1_MIN: 'Le minimum du niveau 1 est invalide.', INVALID_POLICY_LEVEL2_MIN: 'Le minimum du niveau 2 est invalide.', INVALID_POLICY_NODE_TARGET: 'L’objectif de nœud doit être compris entre 0 et 50000.' }, states: { disabled: 'Désactivé', ready: 'Objectif atteint', below_target: 'Sous l’objectif', running: 'Synchronisation', cooldown_wait: 'Temporisation', quota_wait: 'Attente du quota', source_limited: 'Limite de source atteinte', failed: 'Échec', blocked: 'Action requise' } },
  es: { nav: 'Datos de direcciones', country: 'País o región', current: 'Registros válidos', target: 'Objetivo final', coverage: 'Cobertura del nivel inferior', sources: 'Fuentes', status: 'Estado de sincronización', nextRun: 'Próxima ejecución', details: 'Detalles', save: 'Guardar ajustes', sync: 'Sincronizar ahora', syncing: 'Sincronizando', enabled: 'Activar este país', sourceDetails: 'Fuentes de datos', noSources: 'No hay fuentes importadas', latestVersion: 'Última versión', activeRecords: 'Registros activos', lastImport: 'Última importación', lastSuccess: 'Último éxito', lastError: 'Detalle del estado', unlimitedWait: 'Esperando una fuente o credencial', saved: 'Ajustes del país guardados', syncStarted: 'Tarea de sincronización enviada', qualified: 'Al menos 5', targetMet: 'Objetivo cumplido', coverageGoal: 'Objetivo de cobertura', minPerNodeLabel: 'Mínimo por nodo del nivel más bajo', level1MinLabel: 'Mínimo del nivel 1', level2MinLabel: 'Mínimo del nivel 2', lowestShort: 'Nivel más bajo', level1Short: 'Nivel 1', level2Short: 'Nivel 2', prunable: '{count} recortables', nodeTargets: 'Objetivos por nodo', loadNodeTargets: 'Cargar objetivos por nodo', searchNode: 'Buscar nodo', defaultTag: 'Predeterminado', overrideTag: 'Personalizado', deficitChip: 'Faltan {count}', excessChip: 'Exceso {count}', metChip: 'Cumplido', clearOverride: 'Restablecer valor predeterminado', loadMore: 'Cargar más', noNodes: 'Sin datos de nodos', nodeSaved: 'Objetivo de nodo guardado', nodeCleared: 'Objetivo de nodo restablecido', queueTitle: 'Cola de sincronización', queueQueued: 'En cola', queueAtTarget: '{count} países en el objetivo', queueEmpty: 'Ningún país pendiente de sincronizar', queueUnavailable: 'El servicio de control de sincronización no está disponible', queueResetIn: 'se restablece en {time}', policyErrors: { INVALID_POLICY_TARGET: 'El objetivo final no es válido.', INVALID_POLICY_MIN_PER_NODE: 'El mínimo por nodo debe estar entre 1 y 100.', INVALID_POLICY_COVERAGE_RATIO: 'El objetivo de cobertura debe estar entre 0 % y 100 %.', INVALID_POLICY_LEVEL1_MIN: 'El mínimo del nivel 1 no es válido.', INVALID_POLICY_LEVEL2_MIN: 'El mínimo del nivel 2 no es válido.', INVALID_POLICY_NODE_TARGET: 'El objetivo del nodo debe estar entre 0 y 50000.' }, states: { disabled: 'Desactivado', ready: 'Objetivo alcanzado', below_target: 'Por debajo del objetivo', running: 'Sincronizando', cooldown_wait: 'En espera', quota_wait: 'Esperando restablecimiento de cuota', source_limited: 'Límite de fuente alcanzado', failed: 'Error de sincronización', blocked: 'Requiere acción' } },
  pt: { nav: 'Dados de endereços', country: 'País ou região', current: 'Registros válidos', target: 'Meta final', coverage: 'Cobertura do nível inferior', sources: 'Fontes', status: 'Estado da sincronização', nextRun: 'Próxima execução', details: 'Detalhes', save: 'Salvar configurações', sync: 'Sincronizar agora', syncing: 'Sincronizando', enabled: 'Ativar este país', sourceDetails: 'Fontes de dados', noSources: 'Nenhuma fonte importada', latestVersion: 'Versão mais recente', activeRecords: 'Registros ativos', lastImport: 'Última importação', lastSuccess: 'Último sucesso', lastError: 'Detalhe do estado', unlimitedWait: 'Aguardando fonte ou credencial', saved: 'Configurações do país salvas', syncStarted: 'Tarefa de sincronização enviada', qualified: 'Pelo menos 5', targetMet: 'Meta atingida', coverageGoal: 'Meta de cobertura', minPerNodeLabel: 'Mínimo por nó do nível mais baixo', level1MinLabel: 'Mínimo do nível 1', level2MinLabel: 'Mínimo do nível 2', lowestShort: 'Nível mais baixo', level1Short: 'Nível 1', level2Short: 'Nível 2', prunable: '{count} redutíveis', nodeTargets: 'Metas por nó', loadNodeTargets: 'Carregar metas por nó', searchNode: 'Pesquisar nó', defaultTag: 'Padrão', overrideTag: 'Personalizado', deficitChip: 'Faltam {count}', excessChip: 'Excesso {count}', metChip: 'Atingida', clearOverride: 'Restaurar padrão', loadMore: 'Carregar mais', noNodes: 'Sem dados de nós', nodeSaved: 'Meta do nó salva', nodeCleared: 'Meta do nó restaurada', queueTitle: 'Fila de sincronização', queueQueued: 'Na fila', queueAtTarget: '{count} países na meta', queueEmpty: 'Nenhum país aguardando sincronização', queueUnavailable: 'O serviço de controle de sincronização está inacessível', queueResetIn: 'redefine em {time}', policyErrors: { INVALID_POLICY_TARGET: 'A meta final é inválida.', INVALID_POLICY_MIN_PER_NODE: 'O mínimo por nó deve estar entre 1 e 100.', INVALID_POLICY_COVERAGE_RATIO: 'A meta de cobertura deve estar entre 0% e 100%.', INVALID_POLICY_LEVEL1_MIN: 'O mínimo do nível 1 é inválido.', INVALID_POLICY_LEVEL2_MIN: 'O mínimo do nível 2 é inválido.', INVALID_POLICY_NODE_TARGET: 'A meta do nó deve estar entre 0 e 50000.' }, states: { disabled: 'Desativado', ready: 'Meta atingida', below_target: 'Abaixo da meta', running: 'Sincronizando', cooldown_wait: 'Em espera', quota_wait: 'Aguardando redefinição da cota', source_limited: 'Limite da fonte atingido', failed: 'Falha na sincronização', blocked: 'Ação necessária' } }
};

const shortcutText = (locale: AdminLocale) => locale === 'zh-CN' || locale === 'zh-TW' ? {
  nav: '快捷区域',
  country: '国家和地区', customized: '已自定义', defaults: '使用默认值', specialTitle: '特殊区域标题',
  adminAreas: '热门行政区', cities: '热门城市', specialAreas: '特殊区域', type: '类型', region: '行政区', city: '城市', postcode: '邮编',
  choose: '搜索并选择', selected: '已选择 {count} 个', loading: '正在加载', noOptions: '没有匹配项', available: '{count} 个地址',
  save: '保存配置', reset: '恢复默认', saved: '快捷区域配置已保存', resetDone: '已恢复默认配置',
  moveUp: '上移', moveDown: '下移', remove: '删除', confirmReset: '确定恢复这个国家的默认快捷区域吗？'
} : {
  nav: 'Quick Locations',
  country: 'Country or region', customized: 'Customized', defaults: 'Using defaults', specialTitle: 'Special area title',
  adminAreas: 'Popular administrative areas', cities: 'Popular cities', specialAreas: 'Special areas', type: 'Type', region: 'Region', city: 'City', postcode: 'Postcode',
  choose: 'Search and select', selected: '{count} selected', loading: 'Loading', noOptions: 'No matches', available: '{count} addresses',
  save: 'Save configuration', reset: 'Restore defaults', saved: 'Quick locations saved', resetDone: 'Default configuration restored',
  moveUp: 'Move up', moveDown: 'Move down', remove: 'Delete', confirmReset: 'Restore the default quick locations for this country?'
};

const syncHistoryBase = {
  nav: 'Sync history', title: 'Sync history', schedulerActive: 'Scheduler active', schedulerIdle: 'Scheduler idle',
  lastHeartbeat: 'Last heartbeat', country: 'Country or region', allCountries: 'All countries', status: 'Status',
  source: 'Source', period: 'Time period', duration: 'Duration', growth: 'Address growth', trigger: 'Trigger',
  details: 'Details', empty: 'No synchronization history', queued: 'Queued', running: 'Running', succeeded: 'Execution succeeded',
  failed: 'Failed', paused_quota: 'Paused for quota', needs_review: 'Needs review', cancelled: 'Not executed', previous: 'Previous', next: 'Next',
  candidates: 'Candidates', qualityPassed: 'Quality passed', rejected: 'Rejected', coveredNodes: 'Covered nodes', qualifiedNodes: 'Qualified nodes'
};
const syncHistoryText = Object.fromEntries((Object.keys(addressDataText) as AdminLocale[]).map((locale) => [locale, {
  ...syncHistoryBase,
  ...(locale === 'zh-CN' ? {
    nav: '同步历史', title: '同步历史', schedulerActive: '调度器运行中', schedulerIdle: '调度器未运行',
    lastHeartbeat: '最近心跳', country: '国家和地区', allCountries: '全部国家', status: '状态', source: '数据来源',
    period: '占用时间段', duration: '持续时间', growth: '总量净增', trigger: '触发方式', details: '结果说明',
    empty: '暂无同步历史', queued: '排队中', running: '同步中', succeeded: '执行成功', failed: '失败',
    paused_quota: '等待额度', needs_review: '需要检查', cancelled: '未执行', previous: '上一页', next: '下一页',
    candidates: '候选', qualityPassed: '质量通过', rejected: '拒绝', coveredNodes: '覆盖节点', qualifiedNodes: '达标节点'
  } : locale === 'zh-TW' ? {
    nav: '同步歷史', title: '同步歷史', schedulerActive: '排程器執行中', schedulerIdle: '排程器未執行',
    lastHeartbeat: '最近心跳', country: '國家和地區', allCountries: '全部國家', status: '狀態', source: '資料來源',
    period: '佔用時段', duration: '持續時間', growth: '總量淨增', trigger: '觸發方式', details: '結果說明',
    empty: '暫無同步歷史', queued: '排隊中', running: '同步中', succeeded: '執行成功', failed: '失敗',
    paused_quota: '等待額度', needs_review: '需要檢查', cancelled: '未執行', previous: '上一頁', next: '下一頁',
    candidates: '候選', qualityPassed: '品質通過', rejected: '拒絕', coveredNodes: '覆蓋節點', qualifiedNodes: '達標節點'
  } : {})
}])) as Record<AdminLocale, typeof syncHistoryBase>;

const labelsFor = (locale: AdminLocale): Record<View, string> => ({
  dashboard: adminText[locale].labels.dashboard,
  blacklist: adminText[locale].labels.blacklist,
  providers: adminText[locale].labels.providers,
  addressData: addressDataText[locale].nav,
  syncQueue: addressDataText[locale].queueTitle,
  syncHistory: syncHistoryText[locale].nav,
  shortcuts: shortcutText(locale).nav,
  access: adminText[locale].labels.access,
  tokens: adminText[locale].labels.tokens
});
const viewIcons = { dashboard: LayoutDashboard, blacklist: ShieldBan, providers: KeyRound, addressData: RefreshCw, syncQueue: ListOrdered, syncHistory: History, shortcuts: MapPin, access: ShieldCheck, tokens: Braces } as const;
const providerLabel = (locale: AdminLocale, provider: string): string => {
  if (provider === 'deepl') return 'DeepL API Free';
  if (locale === 'zh-CN' || locale === 'en') return adminText[locale].providers[provider as keyof typeof adminText['zh-CN']['providers']] || provider;
  if (locale === 'zh-TW') {
    const names: Record<string, string> = { amap: '高德地圖', baidu: '百度地圖', tencent: '騰訊地圖', onemap: 'OneMap', geoapify: 'Geoapify', 'google-geocoding': 'Google Geocoding', mappls: 'Mappls', 'openai-compatible': 'OpenAI 相容介面' };
    return names[provider] || provider;
  }
  return adminText.en.providers[provider as keyof typeof adminText['zh-CN']['providers']] || provider;
};
const credentialDisplayLabel = (locale: AdminLocale, label: string): string => ({
  AMAP_API_KEY: providerLabel(locale, 'amap'),
  BAIDU_API_KEY: providerLabel(locale, 'baidu'),
  TENCENT_API_KEY: providerLabel(locale, 'tencent'),
  ONEMAP_ACCESS_TOKEN: providerLabel(locale, 'onemap'),
  YOUDAO_APP_KEY: adminText[locale].providers.youdao,
  GEOAPIFY_API_KEY: providerLabel(locale, 'geoapify'),
  GOOGLE_GEOCODING_API_KEY: providerLabel(locale, 'google-geocoding'),
  MAPPLS_API_KEY: providerLabel(locale, 'mappls'),
  OPENAI_COMPATIBLE_MODEL: providerLabel(locale, 'openai-compatible'),
  AMAP_JS_API_KEY: adminText[locale].amapBrowserTitle
} as Record<string, string>)[label] || label;
const interpolate = (value: string, replacements: Record<string, string | number>): string => Object.entries(replacements).reduce((result, [key, replacement]) => result.replace(`{${key}}`, String(replacement)), value);
const dateTime = (value: unknown, locale: AdminLocale) => value ? new Date(String(value)).toLocaleString(locale, { hour12: false }) : '-';
const dateInputValue = (value: unknown): string => {
  if (!value) return '';
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const generateTokenValue = (): string => {
  const bytes = new Uint8Array(24);
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  let encoded = '';
  for (const byte of bytes) encoded += String.fromCharCode(byte);
  return `addr_${btoa(encoded).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`;
};
export const baseAdminErrorText = {
    'zh-CN': { UNAUTHORIZED: '登录状态已失效，请重新登录', INVALID_CREDENTIALS: '管理员密码错误', LOGIN_RATE_LIMITED: '登录尝试过多，请稍后再试', PASSWORD_LENGTH: '密码长度必须为 10 至 512 个字符', PASSWORD_CONFIRM_MISMATCH: '两次输入的密码不一致', FRONTEND_PASSWORD_REQUIRED: '启用前端访问密码时必须先设置密码', TOKEN_NAME_REQUIRED: '请输入令牌名称', INVALID_TOKEN_RATE_LIMIT: '令牌限速设置无效', INVALID_TOKEN_VALUE: '令牌内容长度或格式无效', INVALID_TOKEN_SCOPES: '令牌权限无效', INVALID_TOKEN_EXPIRY: '令牌到期时间无效', TOKEN_ALREADY_EXISTS: '令牌内容已经存在', API_TOKEN_NOT_FOUND: '令牌不存在', API_TOKEN_SECRET_UNAVAILABLE: '该令牌仅保留鉴权信息', NO_AVAILABLE_KEY: '请先添加至少一个未过期的可用凭据', PROVIDER_TEST_FAILED: '服务凭据测试失败', INVALID_USER_KEY: '服务凭据无效', CHINA_SYNC_BUSY: '已有中国同步任务正在运行', CREDENTIAL_NOT_FOUND: '服务凭据不存在', INVALID_PROVIDER_CREDENTIAL: '服务凭据配置无效', INVALID_MAP_DISPLAY_CONFIG: '地图显示设置无效', INVALID_BROWSER_MAP_CREDENTIAL: '高德 Web 端密钥配置无效', BROWSER_MAP_CREDENTIAL_EXISTS: '高德 Web 端密钥已存在', BROWSER_MAP_CREDENTIAL_NOT_FOUND: '高德 Web 端密钥不存在', INVALID_COUNTRY_SHORTCUTS: '快捷区域配置无效，请检查名称、匹配值和类型', DUPLICATE_COUNTRY_SHORTCUT: '同一分组内存在重复的快捷区域', AREACITY_DATA_EMPTY: '行政区划数据为空', INVALID_AREACITY_CSV: '行政区划逗号分隔文件格式无效', AREACITY_SOURCE_OUTSIDE_DATA_ROOT: '行政区划文件必须位于本地数据目录内' },
    en: { UNAUTHORIZED: 'Your session has expired. Sign in again.', INVALID_CREDENTIALS: 'The administrator password is incorrect.', LOGIN_RATE_LIMITED: 'Too many sign-in attempts. Try again later.', PASSWORD_LENGTH: 'Password length must be 10 to 512 characters.', PASSWORD_CONFIRM_MISMATCH: 'The two password entries do not match.', FRONTEND_PASSWORD_REQUIRED: 'Set a frontend password before enabling this option.', TOKEN_NAME_REQUIRED: 'Enter a token name.', INVALID_TOKEN_RATE_LIMIT: 'The token rate limit is invalid.', INVALID_TOKEN_VALUE: 'The token value has an invalid length or format.', INVALID_TOKEN_SCOPES: 'The token scopes are invalid.', INVALID_TOKEN_EXPIRY: 'The token expiry is invalid.', TOKEN_ALREADY_EXISTS: 'That token value already exists.', API_TOKEN_NOT_FOUND: 'The token was not found.', API_TOKEN_SECRET_UNAVAILABLE: 'This token only retains authentication data.', NO_AVAILABLE_KEY: 'Add at least one enabled, non-expired credential.', PROVIDER_TEST_FAILED: 'The credential test failed.', INVALID_USER_KEY: 'The service credential is invalid.', CHINA_SYNC_BUSY: 'A China sync task is already running.', CREDENTIAL_NOT_FOUND: 'The service credential was not found.', INVALID_PROVIDER_CREDENTIAL: 'The credential configuration is invalid.', INVALID_MAP_DISPLAY_CONFIG: 'The map display configuration is invalid.', INVALID_BROWSER_MAP_CREDENTIAL: 'The AMap Web credential is invalid.', BROWSER_MAP_CREDENTIAL_EXISTS: 'An AMap Web credential already exists.', BROWSER_MAP_CREDENTIAL_NOT_FOUND: 'The AMap Web credential was not found.', INVALID_COUNTRY_SHORTCUTS: 'The quick-location configuration is invalid. Check labels, match values, and types.', DUPLICATE_COUNTRY_SHORTCUT: 'A quick-location group contains duplicate entries.', AREACITY_DATA_EMPTY: 'The AreaCity data is empty.', INVALID_AREACITY_CSV: 'The AreaCity CSV format is invalid.', AREACITY_SOURCE_OUTSIDE_DATA_ROOT: 'The AreaCity file must be inside the local data directory.' }
} as const;
type AdminErrorCode = keyof typeof baseAdminErrorText.en;
export const adminErrorText = { ...baseAdminErrorText, ...generatedAdminErrors } as unknown as Record<AdminLocale, Record<AdminErrorCode, string>>;
export const errorMessage = (value: unknown, locale: AdminLocale = 'zh-CN'): string => {
  const code = value instanceof Error ? value.message : String(value);
  if (code === 'ADMIN_PASSWORD_CHANGE_REQUIRED') {
    return locale === 'zh-CN' || locale === 'zh-TW'
      ? '使用其他管理员功能前必须先修改默认密码'
      : 'Change the default password before using other administrator features.';
  }
  const fallback = locale === 'zh-CN' || locale === 'zh-TW' ? baseAdminErrorText['zh-CN'] : baseAdminErrorText.en;
  return adminErrorText[locale][code as AdminErrorCode] || fallback[code as AdminErrorCode] || code;
};
const cookie = (name: string): string => document.cookie.split('; ').find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) || '';
const coverageLevels: Record<AdminLocale, Record<string, string[]>> = {
  'zh-CN': {
    CN: ['国家', '省级', '地级市', '区县', '街道乡镇'], US: ['国家', '州', '城市', '区县'], CA: ['国家', '省', '城市', '区域'],
    JP: ['国家', '都道府县', '市区町村', '地区'], GB: ['国家', '构成国或地区', '城市', '区域'], default: ['国家', '一级行政区', '城市', '区县', '下级区域']
  },
  en: {
    CN: ['Country', 'Province-level', 'Prefecture-level city', 'District or county', 'Township'], US: ['Country', 'State', 'City', 'County'], CA: ['Country', 'Province', 'City', 'Region'],
    JP: ['Country', 'Prefecture', 'Municipality', 'District'], GB: ['Country', 'Constituent country or region', 'City', 'Region'], default: ['Country', 'First-level division', 'City', 'District', 'Child region']
  },
  'zh-TW': {
    CN: ['國家', '省級', '地級市', '區縣', '街道鄉鎮'], US: ['國家', '州', '城市', '郡縣'], CA: ['國家', '省', '城市', '區域'],
    JP: ['國家', '都道府縣', '市區町村', '地區'], GB: ['國家', '構成國或地區', '城市', '區域'], default: ['國家', '一級行政區', '城市', '區縣', '下級區域']
  },
  ja: {
    CN: ['国', '省級', '地級市', '区・県', '郷・鎮'], US: ['国', '州', '市', '郡'], CA: ['国', '州', '市', '地域'],
    JP: ['国', '都道府県', '市区町村', '地区'], GB: ['国', '構成国・地域', '市', '地域'], default: ['国', '第1級行政区画', '市', '地区', '下位地域']
  },
  ko: {
    CN: ['국가', '성급', '지급시', '구·현', '향·진'], US: ['국가', '주', '도시', '카운티'], CA: ['국가', '주', '도시', '지역'],
    JP: ['국가', '도도부현', '시구정촌', '지구'], GB: ['국가', '구성국·지역', '도시', '지역'], default: ['국가', '1급 행정구역', '도시', '지구', '하위 지역']
  },
  de: {
    CN: ['Land', 'Provinzebene', 'Bezirksstadt', 'Kreis', 'Gemeinde'], US: ['Land', 'Bundesstaat', 'Stadt', 'County'], CA: ['Land', 'Provinz', 'Stadt', 'Region'],
    JP: ['Land', 'Präfektur', 'Gemeinde', 'Bezirk'], GB: ['Land', 'Landesteil oder Region', 'Stadt', 'Region'], default: ['Land', 'Verwaltungsebene 1', 'Stadt', 'Bezirk', 'Unterregion']
  },
  fr: {
    CN: ['Pays', 'Niveau provincial', 'Ville-préfecture', 'District ou comté', 'Canton'], US: ['Pays', 'État', 'Ville', 'Comté'], CA: ['Pays', 'Province', 'Ville', 'Région'],
    JP: ['Pays', 'Préfecture', 'Municipalité', 'District'], GB: ['Pays', 'Nation constitutive ou région', 'Ville', 'Région'], default: ['Pays', 'Division de premier niveau', 'Ville', 'District', 'Sous-région']
  },
  es: {
    CN: ['País', 'Nivel provincial', 'Ciudad-prefectura', 'Distrito o condado', 'Municipio'], US: ['País', 'Estado', 'Ciudad', 'Condado'], CA: ['País', 'Provincia', 'Ciudad', 'Región'],
    JP: ['País', 'Prefectura', 'Municipio', 'Distrito'], GB: ['País', 'Nación constituyente o región', 'Ciudad', 'Región'], default: ['País', 'División de primer nivel', 'Ciudad', 'Distrito', 'Subregión']
  },
  pt: {
    CN: ['País', 'Nível provincial', 'Cidade-prefeitura', 'Distrito ou condado', 'Município'], US: ['País', 'Estado', 'Cidade', 'Condado'], CA: ['País', 'Província', 'Cidade', 'Região'],
    JP: ['País', 'Prefeitura', 'Município', 'Distrito'], GB: ['País', 'Nação constituinte ou região', 'Cidade', 'Região'], default: ['País', 'Divisão de primeiro nível', 'Cidade', 'Distrito', 'Sub-região']
  }
};
const usesChineseSource = (locale: AdminLocale): boolean => locale === 'zh-CN' || locale === 'zh-TW';
const coverageLevelName = (node: CoverageNode, locale: AdminLocale): string => {
  const translated = coverageLevels[locale][node.countryCode]?.[node.level] || coverageLevels[locale].default[node.level];
  if (locale === 'en') return node.levelLabelEn || node.levelLabel || translated || adminText[locale].region;
  if (usesChineseSource(locale)) return node.levelLabelZh || translated || node.levelLabel || adminText[locale].region;
  return translated || node.levelLabelEn || node.levelLabel || adminText[locale].region;
};
const coverageRegionName = (node: CoverageNode, locale: AdminLocale): string => {
  if (node.level !== 0 || !isCountryCode(node.countryCode)) return (usesChineseSource(locale) ? node.regionNameZh : node.regionNameEn) || node.regionName;
  return localizedCountryName(node.countryCode, locale, countryByCode.get(node.countryCode)?.name.en || node.regionName);
};

function LocaleMenu({ locale, change, className = '' }: { locale: Locale; change: (locale: Locale) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const active = localeDefinitions.find((definition) => definition.code === locale) || localeDefinitions[0];
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { setOpen(false); root.current?.querySelector<HTMLButtonElement>('.locale-menu-trigger')?.focus(); return; }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    if (!open) { setOpen(true); return; }
    const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') || [])];
    const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
    buttons[(current + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  };
  return <div ref={root} className={`locale-menu ${className}`} onKeyDown={keyDown}>
    <button type="button" className="locale-menu-trigger" aria-label="Language" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <Languages size={15} /><span>{active.label}</span><ChevronDown size={14} />
    </button>
    {open && <div className="locale-menu-options" role="listbox" aria-label="Language">
      {localeDefinitions.map((definition) => <button type="button" role="option" aria-selected={definition.code === locale} className={definition.code === locale ? 'active' : ''} key={definition.code} onClick={() => { setOpen(false); change(definition.code); }}>{definition.label}</button>)}
    </div>}
  </div>;
}

export default function SyncAdmin({ locale: pageLocale }: SyncAdminProps) {
  const locale = pageLocale;
  const t = adminText[locale];
  const [authenticated, setAuthenticated] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionRetry, setSessionRetry] = useState(0);
  const [initialized, setInitialized] = useState(true);
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false);
  const [password, setPassword] = useState('');
  const [view, setView] = useState<View>('dashboard');
  const [dataByView, setDataByView] = useState<Partial<Record<View, unknown>>>({});
  const [loadingView, setLoadingView] = useState<View | null>(null);
  const [mutating, setMutating] = useState(false);
  const mutationPending = useRef(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const loginPending = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [coverageTrail, setCoverageTrail] = useState<CoverageNode[]>([]);
  const loadIds = useRef<Record<View, number>>({ dashboard: 0, blacklist: 0, access: 0, providers: 0, addressData: 0, syncQueue: 0, syncHistory: 0, shortcuts: 0, tokens: 0 });
  const loadControllers = useRef<Partial<Record<View, AbortController>>>({});
  const viewRef = useRef<View>('dashboard');
  const coverageParent = useRef('');

  const changeLocale = (next: Locale) => {
    const target = pathForLocale(window.location.pathname, next);
    window.location.assign(`${target}${window.location.search}${window.location.hash}`);
  };

  useEffect(() => {
    document.documentElement.lang = pageLocale;
  }, [pageLocale]);

  const request = useCallback(async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
    const csrf = cookie('address_admin_csrf');
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
    const response = await fetch(`/admin/api${path}`, {
      ...options,
      signal,
      cache: 'no-store',
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...options.headers },
      credentials: 'same-origin'
    });
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { data?: T; error?: string; detail?: string };
    if (response.status === 401) setAuthenticated(false);
    if (!response.ok) throw new Error(errorMessage(body.detail || body.error || `HTTP ${response.status}`, locale));
    return body.data as T;
  }, [locale]);

  const reveal = useCallback(async (path: string): Promise<Record<string, string>> => {
    return request<Record<string, string>>(path, { method: 'POST' });
  }, [request]);

  const load = useCallback(async (selected: View, clearMessages = true, background = false): Promise<boolean> => {
    const id = ++loadIds.current[selected];
    loadControllers.current[selected]?.abort();
    const controller = new AbortController();
    loadControllers.current[selected] = controller;
    if (!background) { setLoadingView(selected); setError(''); }
    if (clearMessages) setNotice('');
    try {
      const paths: Record<View, string> = {
        dashboard: `/dashboard/overview${coverageParent.current ? `?parent=${encodeURIComponent(coverageParent.current)}` : ''}`,
        blacklist: '/settings/blacklist', access: '/settings/access', providers: '/providers', addressData: '/address-data', syncQueue: '/sync/queue', syncHistory: '/sync/history', shortcuts: '/settings/country-shortcuts', tokens: '/tokens'
      };
      if (selected === 'providers') {
        const parts = [['credentials', '/providers'], ['maps', '/settings/maps'], ['translation', '/settings/translation']] as const;
        const results = await Promise.allSettled(parts.map(async ([key, path]) => {
          const value = await request(path, { signal: controller.signal });
          if (id === loadIds.current[selected] && !controller.signal.aborted) {
            setDataByView((values) => ({ ...values, providers: { ...(values.providers as ProviderViewData), [key]: value } }));
          }
        }));
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        return !controller.signal.aborted;
      }
      const result = await request(paths[selected], { signal: controller.signal });
      if (id === loadIds.current[selected]) setDataByView((values) => ({ ...values, [selected]: result }));
      return true;
    } catch (value) {
      if (controller.signal.aborted) return false;
      if (id === loadIds.current[selected] && selected === viewRef.current) setError(errorMessage(value, locale));
      return false;
    } finally {
      if (loadControllers.current[selected] === controller) delete loadControllers.current[selected];
      if (id === loadIds.current[selected] && !background) setLoadingView((value) => value === selected ? null : value);
    }
  }, [request, locale]);

  useEffect(() => () => Object.values(loadControllers.current).forEach((controller) => controller?.abort()), []);

  useEffect(() => {
    const controller = new AbortController();
    void request<{ initialized: boolean }>('/status', { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setInitialized(Boolean(value.initialized)); })
      .catch((value) => { if (!controller.signal.aborted) setError(errorMessage(value, locale)); });
    void request<{ authenticated: boolean; passwordChangeRequired?: boolean }>('/session', { signal: controller.signal }).then((body) => {
      if (controller.signal.aborted) return;
      const forceChange = Boolean(body.passwordChangeRequired);
      const selected: View = forceChange ? 'access' : viewFromLocation();
      viewRef.current = selected;
      setView(selected);
      const active = Boolean(body.authenticated);
      setAuthenticated(active);
      setPasswordChangeRequired(active && forceChange);
      if (active) void load(selected);
    }).catch((value) => { if (!controller.signal.aborted) setError(errorMessage(value, locale)); })
      .finally(() => { if (!controller.signal.aborted) setSessionReady(true); });
    return () => controller.abort();
  }, [load, locale, request, sessionRetry]);

  const selectView = useCallback((selected: View, history: 'push' | 'none' = 'push') => {
    if (passwordChangeRequired && selected !== 'access') return;
    if (selected !== viewRef.current) loadControllers.current[viewRef.current]?.abort();
    if (selected === 'dashboard') {
      coverageParent.current = ''; setCoverageTrail([]);
      setDataByView((values) => ({ ...values, dashboard: undefined }));
    }
    viewRef.current = selected; setView(selected);
    if (history === 'push') {
      const url = new URL(window.location.href);
      if (selected === 'dashboard') url.searchParams.delete('view');
      else url.searchParams.set('view', selected);
      window.history.pushState({}, '', url);
    }
    void load(selected);
  }, [load, passwordChangeRequired]);

  useEffect(() => {
    const restore = () => {
      const selected = viewFromLocation();
      if (selected !== viewRef.current) selectView(selected, 'none');
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [selectView]);

  const addressDataRunning = ((dataByView.addressData || []) as AddressDataCountry[]).some((country) => country.status === 'running');
  useEffect(() => {
    if (!authenticated || view !== 'addressData' || !addressDataRunning) return;
    let cancelled = false;
    let timer: number;
    const poll = () => { timer = window.setTimeout(async () => {
      if (!loadControllers.current.addressData) await load('addressData', false, true);
      if (!cancelled) poll();
    }, 10_000); };
    poll();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [addressDataRunning, authenticated, load, view]);

  const login = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loginPending.current) return;
    loginPending.current = true;
    setLoginBusy(true); setError('');
    try {
      const body = await request<{ passwordChangeRequired?: boolean }>('/login', { method: 'POST', body: JSON.stringify({ password }) });
      const forceChange = Boolean(body.passwordChangeRequired);
      const selected: View = forceChange ? 'access' : viewRef.current;
      setAuthenticated(true); setPasswordChangeRequired(forceChange); setPassword('');
      viewRef.current = selected; setView(selected);
      setTimeout(() => void load(selected), 0);
    } catch (value) { setError(errorMessage(value, locale)); }
    finally { loginPending.current = false; setLoginBusy(false); }
  };

  const mutate: Mutate = async <T,>(path: string, method: string, body?: unknown, success = locale === 'zh-CN' ? '操作已完成' : 'Operation completed'): Promise<T | undefined> => {
    if (mutationPending.current) return undefined;
    mutationPending.current = true;
    const selected = viewRef.current;
    loadIds.current[selected] += 1;
    loadControllers.current[selected]?.abort();
    setLoadingView(null);
    setMutating(true); setError(''); setNotice('');
    try {
      const result = await request<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (path === '/settings/access' && result && typeof result === 'object' && 'passwordChangeRequired' in result) {
        setPasswordChangeRequired(Boolean((result as { passwordChangeRequired?: boolean }).passwordChangeRequired));
      }
      setDataByView((values) => {
        const providers = values.providers as ProviderViewData | undefined;
        const credentialId = /^\/providers\/([^/]+)$/.exec(path)?.[1];
        const tokenId = /^\/tokens\/([^/]+)$/.exec(path)?.[1];
        if (credentialId && providers) {
          const patch = body as { label?: string; enabled?: boolean } | undefined;
          return { ...values, providers: { ...providers, credentials: (providers.credentials || []).flatMap((item) => {
            if (item.id !== credentialId) return [item];
            if (method === 'DELETE') return [];
            return [{ ...item, ...(patch?.label !== undefined ? { label: patch.label } : {}),
              ...(patch?.enabled !== undefined ? { enabled: patch.enabled, status: patch.enabled ? (item.status === 'disabled' ? 'healthy' : item.status) : 'disabled' } : {}) }];
          }) } };
        }
        if (tokenId && method === 'DELETE') return { ...values, tokens: ((values.tokens || []) as ApiTokenView[]).filter((item) => item.id !== tokenId) };
        if (tokenId && method === 'PUT') return { ...values, tokens: result };
        if (path === '/settings/maps') return { ...values, providers: { ...providers, maps: result } };
        if (path === '/settings/translation') return { ...values, providers: { ...providers, translation: result } };
        if (path === '/maps/amap-browser') return { ...values, providers: { ...providers, maps: { ...providers?.maps, amapBrowser: result } } };
        if (path.startsWith('/settings/country-shortcuts/')) return { ...values, shortcuts: ((values.shortcuts || []) as AdminCountryShortcutConfig[]).map((item) => item.countryCode === path.split('/').at(-1) ? result : item) };
        if (path === '/settings/access') return { ...values, access: result };
        if (path === '/settings/blacklist') return { ...values, blacklist: { ...(values.blacklist as BlacklistViewData), ...(result as Pick<BlacklistViewData, 'keywords'>) } };
        return values;
      });
      if (selected === viewRef.current) setNotice(success);
      void load(selected, false, true);
      return result;
    } catch (value) {
      if (selected === viewRef.current) setError(errorMessage(value, locale));
      return undefined;
    }
    finally { mutationPending.current = false; setMutating(false); }
  };

  if (!sessionReady) return <main className="admin-login"><div className="admin-loading" role="status"><span className="loading-dot" />{t.loading}</div></main>;

  if (!authenticated) return <main className="admin-login">
    <form onSubmit={login}>
      <div className="admin-login-toolbar"><p>{t.brandName}{locale === 'zh-CN' ? '' : ' '}{t.brand}</p><LocaleMenu locale={pageLocale} change={changeLocale} className="locale-toggle" /></div>
      <h1>{t.loginTitle}</h1>
      {!initialized && <div className="admin-warning">{t.bootstrap}</div>}
      <label><span>{t.password}</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <button disabled={loginBusy || !password}>{loginBusy ? t.loggingIn : t.login}</button>
      {error && <div className="admin-error admin-error-action" role="alert"><span>{error}</span>
        <button type="button" disabled={loginBusy} onClick={() => { setError(''); setSessionReady(false); setSessionRetry((value) => value + 1); }}>{t.retry}</button>
      </div>}
      <a href={`/${pageLocale}/`}>{t.backGenerator}</a>
    </form>
  </main>;

  const openCoverage = (node: CoverageNode) => {
    if (!node.childCount) return;
    coverageParent.current = node.key;
    setCoverageTrail((trail) => node.level === 0 ? [node] : [...trail, node]);
    setDataByView((values) => ({ ...values, dashboard: undefined }));
    void load('dashboard');
  };
  const returnCoverage = (index: number) => {
    const trail = coverageTrail.slice(0, index + 1);
    coverageParent.current = index < 0 ? '' : trail[index].key;
    setCoverageTrail(trail);
    setDataByView((values) => ({ ...values, dashboard: undefined }));
    void load('dashboard');
  };
  const logout = async () => {
    try { await request('/logout', { method: 'POST' }); location.reload(); }
    catch (value) { setError(errorMessage(value, locale)); }
  };
  const data = dataByView[view];
  const dashboardSnapshot = dataByView.dashboard as DashboardData | undefined;

  return <div className="admin-shell">
    <aside className="admin-sidebar">
      <div className="admin-brand"><span className="brand-mark"><MapPin size={25} strokeWidth={2.5} /></span><b>{t.brandName}</b><span>{t.brand}</span></div>
      <nav>{(Object.keys(labelsFor(locale)) as View[]).filter((item) => !passwordChangeRequired || item === 'access').map((item) => {
        const Icon = viewIcons[item];
        return <button type="button" key={item} className={view === item ? 'active' : ''} onClick={() => selectView(item)}><span className="nav-icon" aria-hidden="true"><Icon size={17} /></span><span>{labelsFor(locale)[item]}</span></button>;
      })}</nav>
      <SidebarStatus metrics={dashboardSnapshot?.metrics} locale={locale} />
    </aside>
    <main className="admin-content">
      <header className="admin-topbar">
        <div className="topbar-heading"><h1>{view === 'dashboard' ? t.dashboardTitle : labelsFor(locale)[view]}</h1>{view === 'dashboard' && <p>{t.dashboardDescription}</p>}</div>
        <div className="admin-topbar-actions">
          <LocaleMenu locale={pageLocale} change={changeLocale} className="language-control" />
          <a className="topbar-control generator-link" href={`/${pageLocale}/`}>{t.backGenerator}</a>
          <span className="admin-identity"><b>A</b><strong>{t.administrator}</strong></span>
          <button className="icon-action danger-control" title={t.logout} aria-label={t.logout} onClick={() => void logout()}><LogOut size={17} /></button>
        </div>
      </header>
      {error && <div className="admin-error admin-error-action" role="alert"><span>{error}</span><button disabled={mutating || loadingView === view} onClick={() => void load(view)}>{t.retry}</button></div>}
      {notice && <div className="admin-notice">{notice}</div>}
      {data === undefined ? (view === 'dashboard' ? <DashboardLoading label={t.loading} /> : <div className="admin-loading" role="status"><span className="loading-dot" />{t.loading}</div>) : <AdminView locale={locale} view={view} data={data} busy={mutating} mutate={mutate} reveal={reveal} request={request}
        coverageTrail={coverageTrail} openCoverage={openCoverage} returnCoverage={returnCoverage} />}
      {data !== undefined && loadingView === view && <div className="admin-refreshing" role="status" aria-label={t.loading}><span className="loading-dot" /></div>}
    </main>
  </div>;
}

function AdminView({ locale, view, data, busy, mutate, reveal, request, coverageTrail, openCoverage, returnCoverage }: {
  locale: AdminLocale; view: View; data: unknown; busy: boolean; mutate: Mutate; reveal: Reveal; request: RequestData;
  coverageTrail: CoverageNode[]; openCoverage: (node: CoverageNode) => void; returnCoverage: (index: number) => void;
}) {
  const t = adminText[locale];
  const [providerDialog, setProviderDialog] = useState<'create' | Credential | null>(null);
  const [youdaoDialog, setYoudaoDialog] = useState<'create' | Credential | null>(null);
  const [openAICompatibleDialog, setOpenAICompatibleDialog] = useState<'create' | Credential | null>(null);
  const [newProvider, setNewProvider] = useState('amap');
  const [amapBrowserDialog, setAmapBrowserDialog] = useState(false);
  const [tokenEditor, setTokenEditor] = useState<{ mode: 'create' | 'edit'; value?: ApiTokenView } | null>(null);
  const [tokenSecret, setTokenSecret] = useState<string | null>(null);
  if (view === 'dashboard') {
    return <Dashboard value={data as DashboardData} locale={locale} coverageTrail={coverageTrail} openCoverage={openCoverage} returnCoverage={returnCoverage} />;
  }
  if (view === 'access') {
    const value = data as { frontendPasswordEnabled?: boolean } | undefined;
    return <Panel title={t.accessTitle}><AccessSettingsForm value={value} locale={locale} busy={busy} mutate={mutate} /></Panel>;
  }
  if (view === 'blacklist') {
    return <BlacklistSettings value={data as BlacklistViewData} locale={locale} busy={busy} mutate={mutate} />;
  }
  if (view === 'providers') {
    const value = data as ProviderViewData;
    const credentials = (value.credentials || []).filter((credential) => !['deepl', 'youdao', 'openai-compatible'].includes(credential.provider))
      .slice().sort((left, right) => left.provider.localeCompare(right.provider) || left.label.localeCompare(right.label));
    const youdaoCredentials = (value.credentials || []).filter((credential) => credential.provider === 'youdao')
      .slice().sort((left, right) => left.label.localeCompare(right.label));
    const openAICompatibleCredentials = (value.credentials || []).filter((credential) => credential.provider === 'openai-compatible')
      .slice().sort((left, right) => left.label.localeCompare(right.label));
    const maps = value.maps;
    return <>{maps && <><MapDisplayPanel value={maps} locale={locale} busy={busy} mutate={mutate} openAmapBrowser={() => setAmapBrowserDialog(true)} />
      <Panel title={t.amapBrowserTitle} actions={<button type="button" className="primary-action" onClick={() => setAmapBrowserDialog(true)}>{maps.amapBrowser.configured ? t.editAmapBrowser : t.configureAmapBrowser}</button>}>
        <AmapBrowserSummary value={maps.amapBrowser} locale={locale} busy={busy} mutate={mutate} reveal={reveal} openEditor={() => setAmapBrowserDialog(true)} />
      </Panel></>}
      <ProviderCredentialsPanel values={credentials} locale={locale} reveal={reveal} busy={busy} mutate={mutate} openEditor={setProviderDialog} openProvider={(provider) => { setNewProvider(provider); setProviderDialog('create'); }} />
      {value.translation && <TranslationSettingsPanel value={value.translation} credentials={youdaoCredentials} deeplCredentials={(value.credentials || []).filter((item) => item.provider === 'deepl')} openAICompatibleCredentials={openAICompatibleCredentials} locale={locale} busy={busy} mutate={mutate} reveal={reveal} openEditor={setYoudaoDialog} openDeepL={(item) => { setNewProvider('deepl'); setProviderDialog(item); }} openOpenAICompatible={setOpenAICompatibleDialog} />}
      {amapBrowserDialog && maps && <AmapBrowserDialog value={maps.amapBrowser} locale={locale} busy={busy} mutate={mutate} close={() => setAmapBrowserDialog(false)} />}
      {youdaoDialog && <YoudaoCredentialDialog value={youdaoDialog === 'create' ? undefined : youdaoDialog} locale={locale} busy={busy} mutate={mutate} close={() => setYoudaoDialog(null)} />}
      {openAICompatibleDialog && <OpenAICompatibleCredentialDialog value={openAICompatibleDialog === 'create' ? undefined : openAICompatibleDialog} locale={locale} busy={busy} mutate={mutate} close={() => setOpenAICompatibleDialog(null)} />}
      {providerDialog && <ProviderCredentialDialog value={providerDialog === 'create' ? undefined : providerDialog} initialProvider={newProvider} locale={locale} busy={busy} mutate={mutate} close={() => setProviderDialog(null)} />}</>;
  }
  if (view === 'addressData') {
    return <AddressDataSettings values={data as AddressDataCountry[]} locale={locale} busy={busy} mutate={mutate} request={request} />;
  }
  if (view === 'syncQueue') {
    return <SyncQueuePanel initialData={data as SyncQueueData} locale={locale} request={request} />;
  }
  if (view === 'syncHistory') {
    return <SyncHistoryPanel initialData={data as SyncHistoryData} locale={locale} request={request} />;
  }
  if (view === 'shortcuts') {
    return <CountryShortcutSettings values={data as AdminCountryShortcutConfig[]} locale={locale} busy={busy} mutate={mutate} request={request} />;
  }
  if (view === 'tokens') {
    const tokens = ((data || []) as ApiTokenView[]).filter((token) => !token.revoked_at);
    return <><Panel title={t.tokensTitle} actions={<button className="primary-action" onClick={() => setTokenEditor({ mode: 'create' })}>+ {t.addToken}</button>}>
      <TokenTable values={tokens} locale={locale} reveal={reveal} edit={(value) => setTokenEditor({ mode: 'edit', value })} revoke={(id) => {
        if (window.confirm(t.confirmRevokeToken)) void mutate(`/tokens/${id}`, 'DELETE', undefined, t.revoked);
      }} />
    </Panel>{tokenEditor && <TokenEditorDialog mode={tokenEditor.mode} value={tokenEditor.value} locale={locale} busy={busy} mutate={mutate} close={() => setTokenEditor(null)} created={(value) => { setTokenEditor(null); setTokenSecret(value); }} />}{tokenSecret && <TokenSecretDialog value={tokenSecret} locale={locale} close={() => setTokenSecret(null)} />}</>;
  }
  return null;
}

const credentialRemovalPrompt = (locale: AdminLocale, label: string): string => ({
  en: `Delete map credential "${label}"?`, 'zh-CN': `确定删除地图密钥“${label}”吗？`, 'zh-TW': `確定刪除地圖金鑰「${label}」嗎？`,
  ja: `地図認証情報「${label}」を削除しますか？`, ko: `지도 자격 증명 "${label}"을(를) 삭제하시겠습니까?`,
  de: `Karten-Zugangsdaten "${label}" loeschen?`, fr: `Supprimer l'identifiant cartographique « ${label} » ?`,
  es: `¿Eliminar la credencial de mapas "${label}"?`, pt: `Excluir a credencial de mapa "${label}"?`
})[locale];

function DashboardLoading({ label }: { label: string }) {
  return <div className="dashboard-loading" role="status" aria-label={label}>
    <div className="dashboard-loading-metrics">{[0, 1, 2, 3].map((value) => <span key={value} />)}</div>
    <div className="dashboard-loading-panel"><i /><i /><i /><i /><i /></div>
  </div>;
}

const formatBytes = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index < 2 ? 0 : 1)} ${units[index]}`;
};

function SidebarStatus({ metrics, locale }: { metrics?: DashboardMetrics; locale: AdminLocale }) {
  const t = adminText[locale];
  return <section className="admin-sidebar-status">
    <div><span className={`status-indicator ${metrics?.serviceHealthy ? 'healthy' : ''}`} /><span>{t.systemStatus}</span><strong>{metrics?.serviceHealthy ? t.runningNormally : '-'}</strong></div>
    <div><Activity size={14} /><span>{t.apiRequestsToday}</span><strong>{metrics ? metrics.apiRequestsToday.toLocaleString() : '-'}</strong></div>
    <div><Database size={14} /><span>{t.databaseSize}</span><strong>{metrics ? formatBytes(metrics.databaseBytes) : '-'}</strong></div>
    <div><CalendarDays size={14} /><span>{t.lastDataUpdate}</span><strong>{metrics?.lastUpdatedAt ? dateTime(metrics.lastUpdatedAt, locale) : '-'}</strong></div>
  </section>;
}

function WorldDistributionMap({ countries, selected, locale, open, expanded = false }: {
  countries: CoverageNode[]; selected?: CoverageNode; locale: AdminLocale; open: (node: CoverageNode) => void; expanded?: boolean;
}) {
  return <WorldCoverageMap
    countries={countries}
    selected={selected}
    label={(country) => coverageRegionName(country, locale)}
    ariaLabel={selected ? coverageRegionName(selected, locale) : adminText[locale].globalDistribution}
    onSelect={open}
    expanded={expanded}
    mapText={{ loading: adminText[locale].loading, retry: adminText[locale].retry,
      error: locale === 'zh-CN' ? '地图加载失败，仍可使用数据列表。' : 'The map could not load. You can still use the data list.' }}
  />;
}

function ExpandedMapDialog({ countries, selected, locale, open, close }: {
  countries: CoverageNode[]; selected?: CoverageNode; locale: AdminLocale; open: (node: CoverageNode) => void; close: () => void;
}) {
  const root = useMapDialogFocus(true, close);
  const title = selected ? coverageRegionName(selected, locale) : adminText[locale].globalDistribution;
  return <div className="map-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}><section ref={root} tabIndex={-1} className="map-dialog" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button type="button" className="icon-button" title={adminText[locale].close} aria-label={adminText[locale].close} onClick={close}><X size={18} /></button></header><WorldDistributionMap countries={countries} selected={selected} locale={locale} open={open} expanded /></section></div>;
}

function DashboardMetric({ label, value, icon: Icon, tone }: { label: string; value: string; icon: typeof Globe2; tone: string }) {
  return <article className="dashboard-kpi"><span className={`dashboard-kpi-icon ${tone}`}><Icon size={20} /></span><div><small>{label}</small><strong>{value}</strong></div><TrendingUp className="dashboard-kpi-trend" size={42} aria-hidden="true" /></article>;
}

type MajorContinent = 'all' | 'asia' | 'europe' | 'north-america' | 'south-america' | 'africa' | 'oceania';
type CountrySortMode = 'residential-desc' | 'residential-asc' | 'country-name' | 'coverage-desc';
const majorContinentByGroup: Record<string, Exclude<MajorContinent, 'all'>> = {
  'east-asia': 'asia', 'southeast-asia': 'asia', 'south-asia': 'asia', 'middle-east': 'asia',
  europe: 'europe', 'north-america': 'north-america', 'south-america': 'south-america', africa: 'africa', oceania: 'oceania'
};
const countryCoverageRatio = (node: CoverageNode): number => {
  const levels = node.coverageLevels || [];
  const total = levels.reduce((sum, level) => sum + level.total, 0);
  return total ? levels.reduce((sum, level) => sum + level.covered, 0) / total : 0;
};

function Dashboard({ value, locale, coverageTrail, openCoverage, returnCoverage }: {
  value: DashboardData; locale: AdminLocale; coverageTrail: CoverageNode[];
  openCoverage: (node: CoverageNode) => void; returnCoverage: (index: number) => void;
}) {
  const t = adminText[locale];
  const [page, setPage] = useState(1);
  const [localSearch, setLocalSearch] = useState('');
  const [continent, setContinent] = useState<MajorContinent>('all');
  const [sortMode, setSortMode] = useState<CountrySortMode>('residential-desc');
  const [mapExpanded, setMapExpanded] = useState(false);
  const selectedCountry = coverageTrail[0];
  const root = !coverageTrail.length;
  const query = root ? localSearch.trim().toLocaleLowerCase() : '';
  const filtered = useMemo(() => value.nodes.filter((node) => {
    const meta = isCountryCode(node.countryCode) ? countryByCode.get(node.countryCode) : undefined;
    if (continent !== 'all' && (!meta || majorContinentByGroup[meta.group] !== continent)) return false;
    if (!query) return true;
    return [node.countryCode, node.regionName, node.regionNameEn, node.regionNameZh].filter(Boolean)
      .some((item) => String(item).toLocaleLowerCase().includes(query));
  }).sort((left, right) => {
    if (sortMode === 'residential-asc') return left.residentialCount - right.residentialCount || left.countryCode.localeCompare(right.countryCode);
    if (sortMode === 'country-name') return coverageRegionName(left, locale).localeCompare(coverageRegionName(right, locale), locale === 'zh-CN' ? 'zh-CN' : 'en');
    if (sortMode === 'coverage-desc') return countryCoverageRatio(right) - countryCoverageRatio(left) || right.residentialCount - left.residentialCount;
    return right.residentialCount - left.residentialCount || left.countryCode.localeCompare(right.countryCode);
  }), [continent, locale, query, sortMode, value.nodes]);
  useEffect(() => setPage(1), [continent, query, sortMode, value.nodes]);
  const pageSize = 8;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visible = root ? filtered : filtered.slice((page - 1) * pageSize, page * pageSize);
  return <div className="dashboard-page">
    {root && <section className="dashboard-kpis">
      <DashboardMetric label={t.countriesCovered} value={value.metrics.countryCount.toLocaleString()} icon={Globe2} tone="blue" />
      <DashboardMetric label={t.totalResidential} value={value.metrics.residentialTotal.toLocaleString()} icon={House} tone="green" />
      <DashboardMetric label={t.regionsCovered} value={`${(value.metrics.coverageRate * 100).toFixed(1)}%`} icon={Target} tone="amber" />
      <DashboardMetric label={t.qualifiedRegions} value={value.metrics.todayUpdates.toLocaleString()} icon={RefreshCw} tone="violet" />
    </section>}
    <div className="coverage-breadcrumb dashboard-breadcrumb"><button onClick={() => returnCoverage(-1)}>{t.allCountries}</button>{coverageTrail.map((node, index) => <span key={node.key}>/<button onClick={() => returnCoverage(index)}>{coverageRegionName(node, locale)}</button></span>)}</div>
    <section className="dashboard-map-row">
      <article className="dashboard-card map-card"><header><div><h2>{selectedCountry ? coverageRegionName(selectedCountry, locale) : t.globalDistribution}</h2></div><button type="button" className="map-expand-button" title={locale === 'zh-CN' ? '展开地图' : 'Expand map'} aria-label={locale === 'zh-CN' ? '展开地图' : 'Expand map'} onClick={() => setMapExpanded(true)}><Maximize2 size={17} /></button></header><WorldDistributionMap countries={value.countries} selected={selectedCountry} locale={locale} open={openCoverage} /></article>
    </section>
    <section className="dashboard-card country-data-table"><header><div><h2>{root ? t.countryDataList : coverageRegionName(coverageTrail.at(-1)!, locale)}</h2></div>{root && <div className="country-table-tools"><label className="country-search"><Search size={14} /><input value={localSearch} onChange={(event) => setLocalSearch(event.target.value)} placeholder={t.searchCountry} /></label><select aria-label={t.sortBy} value={sortMode} onChange={(event) => setSortMode(event.target.value as CountrySortMode)}><option value="residential-desc">{t.sortResidentialDesc}</option><option value="residential-asc">{t.sortResidentialAsc}</option><option value="country-name">{t.sortCountryName}</option><option value="coverage-desc">{t.sortCoverageDesc}</option></select><select aria-label={t.continentFilter} value={continent} onChange={(event) => setContinent(event.target.value as MajorContinent)}><option value="all">{t.allContinents}</option><option value="asia">{t.asia}</option><option value="europe">{t.europe}</option><option value="north-america">{t.northAmerica}</option><option value="south-america">{t.southAmerica}</option><option value="africa">{t.africa}</option><option value="oceania">{t.oceania}</option></select></div>}</header>
      {root ? <CountryCoverageTable values={visible} open={openCoverage} locale={locale} /> : <CoverageTable values={visible} open={openCoverage} locale={locale} />}
      {!root && <div className="table-pagination"><span>{page} / {pages}</span><div><button disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>{t.previous}</button><button disabled={page >= pages} onClick={() => setPage((current) => current + 1)}>{t.next}</button></div></div>}
    </section>{mapExpanded && <ExpandedMapDialog countries={value.countries} selected={selectedCountry} locale={locale} open={openCoverage} close={() => setMapExpanded(false)} />}
  </div>;
}

const blacklistCategoryLabels: Record<AdminLocale, Record<string, string>> = {
  'zh-CN': {
    government: '政府机构', military_law_justice: '军事与司法', education_research: '教育与科研',
    healthcare_care: '医疗与照护', finance: '金融机构', fire_utilities: '消防与公共设施',
    transport_logistics: '交通与物流', religious_funeral_public: '宗教与公共场馆',
    hospitality_commercial_industrial: '住宿、商业与工业'
  },
  en: {
    government: 'Government', military_law_justice: 'Military and justice', education_research: 'Education and research',
    healthcare_care: 'Healthcare and care', finance: 'Finance', fire_utilities: 'Fire and utilities',
    transport_logistics: 'Transport and logistics', religious_funeral_public: 'Religious and public venues',
    hospitality_commercial_industrial: 'Hospitality, commercial, and industrial'
  },
  'zh-TW': {
    government: '政府機構', military_law_justice: '軍事與司法', education_research: '教育與研究',
    healthcare_care: '醫療與照護', finance: '金融機構', fire_utilities: '消防與公共設施',
    transport_logistics: '交通與物流', religious_funeral_public: '宗教與公共場館',
    hospitality_commercial_industrial: '住宿、商業與工業'
  },
  ja: {
    government: '政府機関', military_law_justice: '軍事・司法', education_research: '教育・研究',
    healthcare_care: '医療・介護', finance: '金融機関', fire_utilities: '消防・公共設備',
    transport_logistics: '交通・物流', religious_funeral_public: '宗教・公共施設',
    hospitality_commercial_industrial: '宿泊・商業・工業'
  },
  ko: {
    government: '정부 기관', military_law_justice: '군사 및 사법', education_research: '교육 및 연구',
    healthcare_care: '의료 및 돌봄', finance: '금융 기관', fire_utilities: '소방 및 공공시설',
    transport_logistics: '교통 및 물류', religious_funeral_public: '종교 및 공공시설',
    hospitality_commercial_industrial: '숙박, 상업 및 산업'
  },
  de: {
    government: 'Behörden', military_law_justice: 'Militär und Justiz', education_research: 'Bildung und Forschung',
    healthcare_care: 'Gesundheit und Pflege', finance: 'Finanzwesen', fire_utilities: 'Feuerwehr und Versorgung',
    transport_logistics: 'Verkehr und Logistik', religious_funeral_public: 'Religiöse und öffentliche Einrichtungen',
    hospitality_commercial_industrial: 'Gastgewerbe, Handel und Industrie'
  },
  fr: {
    government: 'Administrations', military_law_justice: 'Armée et justice', education_research: 'Éducation et recherche',
    healthcare_care: 'Santé et soins', finance: 'Finance', fire_utilities: 'Pompiers et services publics',
    transport_logistics: 'Transport et logistique', religious_funeral_public: 'Lieux religieux et publics',
    hospitality_commercial_industrial: 'Hébergement, commerce et industrie'
  },
  es: {
    government: 'Organismos públicos', military_law_justice: 'Ejército y justicia', education_research: 'Educación e investigación',
    healthcare_care: 'Sanidad y cuidados', finance: 'Finanzas', fire_utilities: 'Bomberos y servicios públicos',
    transport_logistics: 'Transporte y logística', religious_funeral_public: 'Centros religiosos y públicos',
    hospitality_commercial_industrial: 'Hostelería, comercio e industria'
  },
  pt: {
    government: 'Órgãos públicos', military_law_justice: 'Forças armadas e justiça', education_research: 'Educação e pesquisa',
    healthcare_care: 'Saúde e cuidados', finance: 'Finanças', fire_utilities: 'Bombeiros e serviços públicos',
    transport_logistics: 'Transportes e logística', religious_funeral_public: 'Locais religiosos e públicos',
    hospitality_commercial_industrial: 'Hotelaria, comércio e indústria'
  }
};

function BlacklistSettings({ value, locale, busy, mutate }: { value: BlacklistViewData; locale: AdminLocale; busy: boolean; mutate: Mutate }) {
  const t = adminText[locale];
  const [keywords, setKeywords] = useState(value.keywords.join('\n'));
  const serverKeywords = useRef(value.keywords.join('\n'));
  useEffect(() => {
    const previous = serverKeywords.current;
    serverKeywords.current = value.keywords.join('\n');
    setKeywords((current) => current === previous ? serverKeywords.current : current);
  }, [value.keywords.join('\n')]);
  return <Panel title={t.blacklistTitle}>
    <div className="blacklist-settings">
      <p>{t.blacklistDescription}</p>
      <section><h3>{t.builtinRules}</h3><div className="blacklist-rule-list">{value.builtIn.map((rule) => <details key={rule.category}>
        <summary>{blacklistCategoryLabels[locale][rule.category] || rule.category}<span>{rule.terms.length}</span></summary>
        <p>{rule.terms.join(' · ')}</p>
      </details>)}</div></section>
      <form onSubmit={async (event) => {
        event.preventDefault();
        const values = keywords.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
        const result = await mutate<Pick<BlacklistViewData, 'keywords'>>('/settings/blacklist', 'PUT', { keywords: values }, t.blacklistSaved);
        if (result) setKeywords((current) => current === keywords ? result.keywords.join('\n') : current);
      }}><label><span>{t.customKeywords}</span><textarea value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder={t.noCustomKeywords} /></label><small>{t.customKeywordHint}</small><button className="primary-action" disabled={busy}>{t.saveBlacklist}</button></form>
    </div>
  </Panel>;
}

function AccessSettingsForm({ value, locale, busy, mutate }: { value?: { frontendPasswordEnabled?: boolean; passwordChangeRequired?: boolean }; locale: AdminLocale; busy: boolean; mutate: Mutate }) {
  const t = adminText[locale];
  const [passwordDialog, setPasswordDialog] = useState<'frontend' | 'admin' | null>(null);
  return <><form className="admin-form" onSubmit={async (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await mutate('/settings/access', 'PUT', { frontendPasswordEnabled: values.get('frontendPasswordEnabled') === 'on' }, t.settingsSaved);
  }}>
    {value?.passwordChangeRequired && <div className="admin-warning" role="alert">{locale === 'zh-CN' || locale === 'zh-TW' ? '当前使用默认管理员密码。请先修改管理员密码。' : 'The default administrator password is active. Change it before continuing.'}</div>}
    <div className="setting-group"><h3>{t.policySection}</h3><label className="check"><input name="frontendPasswordEnabled" type="checkbox" defaultChecked={value?.frontendPasswordEnabled} />{t.frontendPasswordEnabled}</label></div>
    <div className="setting-group"><h3>{t.passwordSection}</h3><div className="password-action-list"><div className="password-action-row"><div><strong>{t.newFrontendPassword}</strong><small>{t.keepUnchanged}</small></div><button type="button" disabled={busy} onClick={() => setPasswordDialog('frontend')}>{t.changeFrontendPassword}</button></div><div className="password-action-row"><div><strong>{t.newAdminPassword}</strong><small>{t.keepUnchanged}</small></div><button type="button" disabled={busy} onClick={() => setPasswordDialog('admin')}>{t.changeAdminPassword}</button></div></div></div>
    <button className="primary-action form-submit" disabled={busy}>{t.saveSettings}</button>
  </form>{passwordDialog && <PasswordDialog kind={passwordDialog} locale={locale} busy={busy} mutate={mutate} close={() => setPasswordDialog(null)} />}</>;
}

function PasswordDialog({ kind, locale, busy, mutate, close }: { kind: 'frontend' | 'admin'; locale: AdminLocale; busy: boolean; mutate: Mutate; close: () => void }) {
  const t = adminText[locale];
  const [showNew, setShowNew] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [formError, setFormError] = useState('');
  const title = kind === 'frontend' ? t.changeFrontendPassword : t.changeAdminPassword;
  return <Dialog title={title} close={close} locale={locale}><form className="dialog-form" onSubmit={async (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const password = String(values.get('password') || '');
    const confirmation = String(values.get('confirmation') || '');
    if (password !== confirmation) { setFormError(t.passwordMismatch); return; }
    setFormError('');
    const body = kind === 'frontend'
      ? { frontendPassword: password, frontendPasswordConfirmation: confirmation }
      : { adminPassword: password, adminPasswordConfirmation: confirmation };
    if (await mutate('/settings/access', 'PUT', body, t.settingsSaved)) close();
  }}>
    <p className="dialog-hint">{t.passwordDialogHint}</p>
    <SecretInput label={t.passwordNew} name="password" visible={showNew} toggle={() => setShowNew((current) => !current)} locale={locale} required />
    <SecretInput label={t.passwordConfirm} name="confirmation" visible={showConfirmation} toggle={() => setShowConfirmation((current) => !current)} locale={locale} required />
    {formError && <p className="field-error" role="alert">{formError}</p>}
    <div className="dialog-actions"><button type="button" onClick={close}>{t.cancel}</button><button className="primary-action" disabled={busy}>{t.savePassword}</button></div>
  </form></Dialog>;
}

function SecretInput({ label, name, visible, toggle, locale, required = false, value, onChange }: { label: string; name: string; visible: boolean; toggle: () => void; locale: AdminLocale; required?: boolean; value?: string; onChange?: (value: string) => void }) {
  const t = adminText[locale];
  return <label className="secret-input-field"><span>{label}</span><div><input name={name} type={visible ? 'text' : 'password'} minLength={10} required={required} autoComplete="new-password" value={value} onChange={onChange ? (event) => onChange(event.target.value) : undefined} /><button type="button" className="inline-toggle" onClick={toggle}>{visible ? t.hidePassword : t.showPassword}</button></div></label>;
}

const scopesForForm = (scopes: string[] | undefined): string[] => {
  if (!scopes?.length || scopes.includes('*')) return ['read', 'generate'];
  return scopes.filter((scope) => scope === 'read' || scope === 'generate');
};
const scopesForApi = (scopes: string[]): string[] => scopes.includes('read') && scopes.includes('generate') ? ['*'] : scopes.length ? scopes : ['*'];

function ScopePicker({ locale, value, onChange }: { locale: AdminLocale; value: string[]; onChange: (value: string[]) => void }) {
  const t = adminText[locale];
  const toggle = (scope: 'read' | 'generate', enabled: boolean) => {
    const next = new Set(value);
    if (enabled) next.add(scope); else next.delete(scope);
    onChange([...next]);
  };
  const all = value.includes('read') && value.includes('generate');
  return <fieldset className="scope-picker"><legend>{t.scopes}</legend><div className="scope-options"><label className="check"><input type="checkbox" checked={all} onChange={(event) => onChange(event.target.checked ? ['read', 'generate'] : [])} />{t.scopeAll}</label><label className="check"><input type="checkbox" checked={value.includes('read')} onChange={(event) => toggle('read', event.target.checked)} />{t.scopeRead}</label><label className="check"><input type="checkbox" checked={value.includes('generate')} onChange={(event) => toggle('generate', event.target.checked)} />{t.scopeGenerate}</label></div><small>{t.scopeHint}</small></fieldset>;
}

function TokenEditorDialog({ mode, value, locale, busy, mutate, close, created }: { mode: 'create' | 'edit'; value?: ApiTokenView; locale: AdminLocale; busy: boolean; mutate: Mutate; close: () => void; created: (token: string) => void }) {
  const t = adminText[locale];
  const [name, setName] = useState(value?.name || '');
  const [tokenValue, setTokenValue] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [rateLimit, setRateLimit] = useState(String(value?.rate_limit_per_minute || 60));
  const [expiresAt, setExpiresAt] = useState(dateInputValue(value?.expires_at));
  const [scopes, setScopes] = useState(scopesForForm(value?.scopes));
  const isCreate = mode === 'create';
  return <Dialog title={isCreate ? t.tokenDialog : t.editTokenDialog} close={close} locale={locale}><form className="dialog-form token-editor-form" onSubmit={async (event) => {
    event.preventDefault();
    const expiry = expiresAt ? new Date(expiresAt).toISOString() : null;
    const body = isCreate
      ? { name: name.trim(), token: tokenValue.trim() || undefined, scopes: scopesForApi(scopes), rateLimit: Number(rateLimit), expiresAt: expiry }
      : { scopes: scopesForApi(scopes), rateLimit: Number(rateLimit), expiresAt: expiry };
    const result = await mutate<{ id: string; token?: string }>(isCreate ? '/tokens' : `/tokens/${value?.id}`, isCreate ? 'POST' : 'PUT', body, isCreate ? '' : t.tokenUpdated);
    if (!result) return;
    if (isCreate) created(String(result.token || '')); else close();
  }}>
    {isCreate ? <label><span>{t.name}</span><input name="name" value={name} required onChange={(event) => setName(event.target.value)} /></label> : <div className="dialog-readonly"><span>{t.name}</span><b>{value?.name}</b></div>}
    {isCreate && <label className="secret-input-field"><span>{t.tokenValue}</span><div><input name="token" type={showToken ? 'text' : 'password'} value={tokenValue} placeholder={t.tokenValueHint} autoComplete="off" onChange={(event) => setTokenValue(event.target.value)} /><button type="button" className="inline-toggle" onClick={() => setShowToken((current) => !current)}>{showToken ? t.hidePassword : t.showPassword}</button></div><small>{t.tokenValueHint}</small></label>}
    {isCreate && <button type="button" className="secondary-action generate-token-button" onClick={() => { setTokenValue(generateTokenValue()); setShowToken(true); }}>{t.generateToken}</button>}
    <ScopePicker locale={locale} value={scopes} onChange={setScopes} />
    <label><span>{t.perMinute}</span><input name="rateLimit" type="number" min="1" max="100000" required value={rateLimit} onChange={(event) => setRateLimit(event.target.value)} /></label>
    <label><span>{t.expires}</span><input name="expiresAt" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /><small>{t.neverExpires}</small></label>
    <div className="dialog-actions"><button type="button" onClick={close}>{t.cancel}</button><button className="primary-action" disabled={busy}>{isCreate ? t.create : t.update}</button></div>
  </form></Dialog>;
}

function TokenSecretDialog({ value, locale, close }: { value: string; locale: AdminLocale; close: () => void }) {
  const t = adminText[locale];
  const [visible, setVisible] = useState(true);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1600); } catch { setCopied(false); }
  };
  return <Dialog title={t.tokenCreatedTitle} close={close} locale={locale}><div className="token-secret-dialog"><p>{t.tokenCreatedHint}</p><code>{visible ? value : '••••••••••••'}</code><div className="secret-actions"><button type="button" className="compact-action" onClick={() => setVisible((current) => !current)}>{visible ? t.hideSecret : t.showSecret}</button><button type="button" className="compact-action" onClick={() => void copy()}>{copied ? t.copied : t.copySecret}</button></div><div className="dialog-actions"><button type="button" className="primary-action" onClick={close}>{t.close}</button></div></div></Dialog>;
}

function MapDisplayPanel({ value, locale, busy, mutate, openAmapBrowser }: { value: MapSettings; locale: AdminLocale; busy: boolean; mutate: Mutate; openAmapBrowser: () => void }) {
  const t = adminText[locale];
  const amapReady = value.amapBrowser.configured && value.amapBrowser.enabled;
  const [config, setConfig] = useState(() => ({ google: { ...value.google }, amap: amapReady ? { ...value.amap } : { china: false, international: false } }));
  useEffect(() => setConfig({ google: { ...value.google }, amap: amapReady ? { ...value.amap } : { china: false, international: false } }), [
    value.google.china, value.google.international, value.amap.china, value.amap.international, amapReady
  ]);
  const toggle = (provider: 'google' | 'amap', scope: 'china' | 'international', enabled: boolean) =>
    setConfig((current) => ({ ...current, [provider]: { ...current[provider], [scope]: enabled } }));
  return <Panel title={t.mapDisplayTitle}><form className="map-display-form" onSubmit={async (event) => {
    event.preventDefault();
    await mutate('/settings/maps', 'PUT', config, t.mapDisplaySaved);
  }}>
    <div className="map-display-grid">
      <span />
      <b>{t.mapChina}</b>
      <b>{t.mapInternational}</b>
      <strong>{t.googleMap}</strong>
      <label className="switch-field"><input name="googleChina" type="checkbox" checked={config.google.china} onChange={(event) => toggle('google', 'china', event.target.checked)} /><span /></label>
      <label className="switch-field"><input name="googleInternational" type="checkbox" checked={config.google.international} onChange={(event) => toggle('google', 'international', event.target.checked)} /><span /></label>
      <strong>{t.amapMap}</strong>
      <label className={`switch-field${amapReady ? '' : ' is-disabled'}`}><input name="amapChina" type="checkbox" checked={config.amap.china} disabled={!amapReady || busy} onChange={(event) => toggle('amap', 'china', event.target.checked)} /><span /></label>
      <label className={`switch-field${amapReady ? '' : ' is-disabled'}`}><input name="amapInternational" type="checkbox" checked={config.amap.international} disabled={!amapReady || busy} onChange={(event) => toggle('amap', 'international', event.target.checked)} /><span /></label>
    </div>
    {!amapReady && <div className="map-prerequisite"><div><KeyRound size={17} aria-hidden="true" /><span><strong>{t.amapBrowserEmpty}</strong><small>{t.amapBrowserSecurity}</small></span></div><button type="button" className="secondary-action" onClick={openAmapBrowser}>{t.configureAmapBrowser}</button></div>}
    <div className="panel-footer"><p>{t.mapDisplayHint}</p><button className="primary-action" disabled={busy}>{t.saveSettings}</button></div>
  </form></Panel>;
}

function AmapBrowserSummary({ value, locale, busy, mutate, reveal, openEditor }: { value: AmapBrowserStatus; locale: AdminLocale; busy: boolean; mutate: Mutate; reveal: Reveal; openEditor: () => void }) {
  const t = adminText[locale];
  if (!value.configured) return <article className="amap-browser-empty"><div><span className="credential-type-badge">{t.mapDisplayTitle}</span><strong>{t.amapBrowserTitle}</strong><small>{t.amapBrowserSecurity}</small></div><span className="badge disabled">{t.youdaoNotConfigured}</span><button type="button" className="secondary-action" onClick={openEditor}>{t.configureAmapBrowser}</button></article>;
  return <article className="provider-key-row amap-browser-row">
    <div className="provider-key-identity"><span className="credential-type-badge">{t.mapDisplayTitle}</span><strong>{credentialDisplayLabel(locale, value.label)}</strong><small>{t.amapBrowserSecurity}</small></div>
    <div className="amap-browser-secrets"><div><span>{t.amapApiKey}</span><SecretCell mask={value.mask} locale={locale} reveal={reveal} path="/maps/amap-browser/reveal" field="apiKey" /></div><div><span>{t.amapSecurityCode}</span><SecretCell mask={value.securityMask || '••••'} locale={locale} reveal={reveal} path="/maps/amap-browser/reveal" field="securityCode" /></div></div>
    <div className="provider-key-status"><span className={`badge ${value.status}`}>{t.status[value.status as keyof typeof t.status] || value.status}</span><small>{t.amapLastUsed}: {dateTime(value.lastUsedAt, locale)}</small><small>{t.amapUpdated}: {dateTime(value.updatedAt, locale)}</small></div>
    <div className="row-actions provider-key-actions"><button type="button" className="provider-action" title={t.edit} aria-label={t.edit} disabled={busy} onClick={openEditor}><Pencil size={14} aria-hidden="true" /></button><button type="button" className="provider-action" title={value.enabled ? t.stop : t.enable} aria-label={value.enabled ? t.stop : t.enable} disabled={busy} onClick={() => void mutate('/maps/amap-browser', 'PUT', { enabled: !value.enabled }, value.enabled ? t.stop : t.enable)}><Power size={14} aria-hidden="true" /></button><button type="button" className="provider-action danger" title={t.remove} aria-label={t.remove} disabled={busy} onClick={() => {
      if (window.confirm(t.confirmRemoveAmap)) void mutate('/maps/amap-browser', 'DELETE', undefined, t.amapBrowserRemoved);
    }}><Trash2 size={14} aria-hidden="true" /></button></div>
  </article>;
}

function AmapBrowserDialog({ value, locale, busy, mutate, close }: { value: AmapBrowserStatus; locale: AdminLocale; busy: boolean; mutate: Mutate; close: () => void }) {
  const t = adminText[locale];
  return <Dialog title={t.amapBrowserDialog} close={close} locale={locale}><form className="dialog-form" onSubmit={async (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const apiKey = String(values.get('apiKey') || '').trim();
    const securityCode = String(values.get('securityCode') || '').trim();
    const body = {
      label: String(values.get('label') || '').trim(), enabled: values.get('enabled') === 'on',
      ...(apiKey ? { apiKey } : {}), ...(securityCode ? { securityCode } : {})
    };
    const result = await mutate('/maps/amap-browser', value.configured ? 'PUT' : 'POST', body, t.amapBrowserSaved);
    if (result) close();
  }}>
    <label><span>{t.amapBrowserLabel}</span><input name="label" defaultValue={value.label} placeholder={t.amapBrowserPlaceholder} /></label>
    <label><span>{t.amapApiKey}</span><input name="apiKey" type="password" required={!value.configured} autoComplete="new-password" placeholder={value.configured ? t.replaceSecret : ''} /></label>
    <label><span>{t.amapSecurityCode}</span><input name="securityCode" type="password" required={!value.configured} autoComplete="new-password" placeholder={value.configured ? t.replaceSecret : ''} /></label>
    <label className="check"><input name="enabled" type="checkbox" defaultChecked={value.configured ? value.enabled : true} />{t.enable}</label>
    <p className="security-note">{t.amapBrowserSecurity}</p>
    <div className="dialog-actions"><button type="button" onClick={close}>{t.cancel}</button><button className="primary-action" disabled={busy}>{t.save}</button></div>
  </form></Dialog>;
}

const providerQuotaDefaults: Record<string, number> = {
  amap: 5_000, baidu: 100, tencent: 10_000, onemap: 100_000_000,
  deepl: 500_000, youdao: 100_000, geoapify: 3_000, 'google-geocoding': 9_000, mappls: 1_000, 'openai-compatible': 1_000
};
const providerQuotaPeriods: Record<string, 'day' | 'month'> = {
  amap: 'month', baidu: 'day', tencent: 'day', onemap: 'day', geoapify: 'day',
  deepl: 'month', youdao: 'month', 'google-geocoding': 'month', mappls: 'day', 'openai-compatible': 'day'
};
const googleQuotaText = (locale: AdminLocale) => locale === 'zh-CN'
  ? { budget: '自动同步月度预算', baseline: '本月已有用量', hint: '填写接入本项目之前在同一 Google 结算账户产生的 Geocoding 用量。', official: 'Google 官方免费用量：每个结算账户每月 10,000 次；项目自动同步默认最多使用 9,000 次。' }
  : locale === 'zh-TW'
    ? { budget: '自動同步月度預算', baseline: '本月已有用量', hint: '填寫接入本專案之前在同一 Google 結算帳戶產生的 Geocoding 用量。', official: 'Google 官方免費用量：每個結算帳戶每月 10,000 次；專案自動同步預設最多使用 9,000 次。' }
    : { budget: 'Monthly sync budget', baseline: 'Usage before setup', hint: 'Enter Geocoding usage already incurred this month under the same Google billing account.', official: 'Google free usage: 10,000 monthly events per billing account; automatic sync uses at most 9,000 by default.' };

const translationCostText = (locale: AdminLocale) => locale === 'zh-CN'
  ? {
    google: '优先使用缓存；在线服务按下方配置的优先级执行。OpenAI 兼容接口按你配置的供应商计费；谷歌是免密钥网页接口（非 Cloud Translation 计费 API），可能限流或不可用。',
    youdao: '有道按量收费，试用额度用完后可能扣费，测试和自动翻译也可能产生费用。项目限额不代表供应商免费额度；若不接受费用，请勿添加或启用凭据。'
  }
  : locale === 'zh-TW'
    ? {
      google: '優先使用快取；線上服務依下方設定的優先順序執行。OpenAI 相容介面按你設定的供應商計費；Google 是免密鑰網頁介面（非 Cloud Translation 計費 API），可能限流或無法使用。',
      youdao: '有道按量收費，試用額度用完後可能扣費，測試和自動翻譯也可能產生費用。專案限額不代表供應商免費額度；若不接受費用，請勿新增或啟用憑據。'
    }
    : {
      google: 'Cache first; online services follow the priorities configured below. OpenAI-compatible usage follows your configured provider billing; Google uses the keyless web interface, not the billed Cloud Translation API, and may rate-limit or be unavailable.',
      youdao: 'Youdao is usage-based and may charge after trial credits run out, including tests and automatic translation. Project limits are not free-credit guarantees. Do not add or enable credentials unless you accept the charges.'
    };

const deeplText = (locale: AdminLocale) => locale === 'zh-CN'
  ? { notice: '仅支持 DeepL API Free，不切换付费版。以账户实际额度和项目上限中较小者为准；所有 DeepL 密钥共用项目字符账本。测试按钮只查询额度，不消耗翻译字符。', budget: '字符使用上限（当前额度周期）', characters: '字符', provider: '账户已用 / 上限', observed: '额度查询时间', unknown: '尚未查询额度', reset: '供应商未提供重置日期，不按月初清零。', add: '添加 DeepL 密钥' }
  : locale === 'zh-TW'
    ? { notice: '僅支援 DeepL API Free，不切換付費版。以帳戶實際額度和專案上限中較小者為準；所有 DeepL 金鑰共用專案字元帳本。測試按鈕僅查詢額度，不消耗翻譯字元。', budget: '字元使用上限（目前額度週期）', characters: '字元', provider: '帳戶已用 / 上限', observed: '額度查詢時間', unknown: '尚未查詢額度', reset: '供應商未提供重置日期，不按月初歸零。', add: '新增 DeepL 金鑰' }
    : { notice: 'DeepL API Free only; never switches to Pro. The lower of the account allowance and project cap applies. All DeepL keys share one project character ledger. The test button checks usage without translating.', budget: 'Character cap (current quota period)', characters: 'characters', provider: 'Account used / limit', observed: 'Usage checked', unknown: 'Usage not checked', reset: 'Provider reset date unavailable; usage is not cleared at calendar month boundaries.', add: 'Add DeepL key' };

const openAIText = (locale: AdminLocale) => {
  const value = adminText[locale];
  const fallback = adminText.en;
  return {
    add: value.openAIAdd || fallback.openAIAdd,
    saved: value.openAISaved || fallback.openAISaved,
    notice: value.openAINotice || fallback.openAINotice,
    key: value.openAIKey || fallback.openAIKey,
    endpoint: value.openAIEndpoint || fallback.openAIEndpoint,
    model: value.openAIModel || fallback.openAIModel,
    reasoning: value.openAIReasoning || fallback.openAIReasoning,
    none: value.openAIReasoningNone || fallback.openAIReasoningNone,
    low: value.openAIReasoningLow || fallback.openAIReasoningLow,
    medium: value.openAIReasoningMedium || fallback.openAIReasoningMedium,
    maxTokens: value.openAIMaxTokens || fallback.openAIMaxTokens,
    fetchModels: value.openAIFetchModels || fallback.openAIFetchModels,
    fetchingModels: value.openAIFetchingModels || fallback.openAIFetchingModels,
    modelsEmpty: value.openAIModelFetchEmpty || fallback.openAIModelFetchEmpty,
    modelsFailed: value.openAIModelFetchFailed || fallback.openAIModelFetchFailed,
    priority: value.openAIPriority || fallback.openAIPriority,
    prompt: value.openAIPrompt || fallback.openAIPrompt,
    promptHint: value.openAIPromptHint || fallback.openAIPromptHint,
    routingTitle: value.translationRoutingTitle || fallback.translationRoutingTitle,
    routingHint: value.translationRoutingHint || fallback.translationRoutingHint,
    route: value.translationRoute || fallback.translationRoute,
    routePriority: value.translationPriority || fallback.translationPriority,
    routeEnabled: value.translationRouteEnabled || fallback.translationRouteEnabled,
    routeSaved: value.translationRouteSaved || fallback.translationRouteSaved
  };
};

function TranslationSettingsPanel({ value, credentials, deeplCredentials, openAICompatibleCredentials, locale, busy, mutate, reveal, openEditor, openDeepL, openOpenAICompatible }: {
  value: TranslationSettings; credentials: Credential[]; locale: AdminLocale; busy: boolean; mutate: Mutate; reveal: Reveal;
  deeplCredentials: Credential[]; openAICompatibleCredentials: Credential[]; openDeepL: (value: 'create' | Credential) => void;
  openOpenAICompatible: (value: 'create' | Credential) => void;
  openEditor: (value: 'create' | Credential) => void;
}) {
  const t = adminText[locale];
  const cost = translationCostText(locale);
  const openAI = openAIText(locale);
  const googleRoute = value.routes?.find((route) => route.provider === 'google');
  const googleEnabled = value.googleTranslationEnabled && googleRoute?.enabled !== false;
  const [googlePriority, setGooglePriority] = useState(String(googleRoute?.priority ?? 40));
  useEffect(() => setGooglePriority(String(googleRoute?.priority ?? 40)), [googleRoute?.priority]);
  return <Panel title={t.translationTitle}>
    <div className="translation-settings">
      <div className="translation-toggle-row"><strong>{t.googleTranslationToggle}</strong><button type="button" className="toggle-switch" role="switch" aria-label={t.googleTranslationToggle} aria-checked={googleEnabled} disabled={busy}
        onClick={() => void mutate('/settings/translation', 'PUT', { googleTranslationEnabled: !googleEnabled }, t.translationSaved)}><span aria-hidden="true" /></button></div>
      <p className="security-note translation-notice">{cost.google}</p>
      <form className="translation-google-priority admin-form" onSubmit={async (event) => {
        event.preventDefault();
        await mutate('/settings/translation/routes', 'PUT', { routes: [{ id: 'google', priority: Number(googlePriority) }] }, t.translationSaved);
      }}><label><span>{openAI.routePriority}</span><input name="googleTranslationPriority" type="number" min="1" max="10000" required value={googlePriority} onChange={(event) => setGooglePriority(event.target.value)} /></label><button type="submit" className="secondary-action" disabled={busy}>{t.save}</button><small>{openAI.routingHint}</small></form>
      <section className="translation-provider deepl-provider">
        <header className="translation-provider-header"><div className="translation-provider-title"><span className="provider-group-icon" aria-hidden="true"><Languages size={18} /></span><div><h3>DeepL API Free</h3><span className="provider-key-count">{providerCredentialCount(locale, deeplCredentials.length)}</span></div></div><button type="button" className="secondary-action" disabled={busy} onClick={() => openDeepL('create')}><Plus size={14} aria-hidden="true" />{deeplText(locale).add}</button></header>
        <p className="security-note translation-notice">{deeplText(locale).notice}</p>
        {deeplCredentials.length ? <div className="provider-key-list">{deeplCredentials.map((credential) => <CredentialRowCompact key={credential.id} item={credential} locale={locale} reveal={reveal} actions={(item) => <>
          <button type="button" className="provider-action" aria-label={t.edit} title={t.edit} disabled={busy} onClick={() => openDeepL(item)}><Pencil size={14} /></button>
          <button type="button" className="provider-action" aria-label={item.enabled ? t.stop : t.enable} title={item.enabled ? t.stop : t.enable} disabled={busy} onClick={() => void mutate(`/providers/${item.id}`, 'PUT', { enabled: !item.enabled }, t.keySaved)}><Power size={14} /></button>
          <button type="button" className="provider-action" aria-label={t.test} title={t.test} disabled={busy || !item.enabled} onClick={() => void mutate(`/providers/${item.id}/test`, 'POST', undefined, t.testSuccess)}><FlaskConical size={14} /></button>
          <button type="button" className="provider-action danger" aria-label={t.remove} title={t.remove} disabled={busy} onClick={() => { if (window.confirm(credentialRemovalPrompt(locale, item.label))) void mutate(`/providers/${item.id}`, 'DELETE', undefined, t.remove); }}><Trash2 size={14} /></button>
        </>} />)}</div> : <div className="provider-empty-state translation-empty-state"><KeyRound size={15} aria-hidden="true" /><span>{t.youdaoNotConfigured}</span></div>}
      </section>
      <section className="translation-provider">
        <header className="translation-provider-header"><div className="translation-provider-title"><span className="provider-group-icon" aria-hidden="true"><Languages size={18} /></span><div><h3>{t.providers.youdao}</h3><span className={`provider-key-count${credentials.length ? '' : ' is-empty'}`}>{providerCredentialCount(locale, credentials.length)}</span></div></div><button type="button" className="secondary-action" disabled={busy} onClick={() => openEditor('create')}><Plus size={14} aria-hidden="true" />{t.addKey}</button></header>
        <p className="security-note translation-notice">{cost.youdao}</p>
        {credentials.length ? <div className="provider-key-list youdao-key-list">{credentials.map((credential) => <CredentialRowCompact key={credential.id} item={credential} locale={locale} reveal={reveal} revealPath={`/providers/${credential.id}/reveal-fields`} secrets={[
          { label: t.youdaoAppKey, mask: credential.fieldMasks?.appKey || credential.mask, field: 'appKey' },
          { label: t.youdaoAppSecret, mask: credential.fieldMasks?.appSecret || credential.mask, field: 'appSecret' }
        ]} actions={(item) => <><button type="button" className="provider-action" title={t.edit} aria-label={t.edit} disabled={busy} onClick={() => openEditor(item)}><Pencil size={14} aria-hidden="true" /></button><button type="button" className="provider-action" title={item.enabled ? t.stop : t.enable} aria-label={item.enabled ? t.stop : t.enable} disabled={busy} onClick={() => void mutate(`/providers/${item.id}`, 'PUT', { enabled: !item.enabled }, item.enabled ? t.stop : t.enable)}><Power size={14} aria-hidden="true" /></button><button type="button" className="provider-action" title={t.test} aria-label={t.test} disabled={busy} onClick={() => void mutate(`/providers/${item.id}/test`, 'POST', undefined, t.testSuccess)}><FlaskConical size={14} aria-hidden="true" /></button><button type="button" className="provider-action danger" title={t.remove} aria-label={t.remove} disabled={busy} onClick={() => { if (window.confirm(credentialRemovalPrompt(locale, item.label))) void mutate(`/providers/${item.id}`, 'DELETE', undefined, t.remove); }}><Trash2 size={14} aria-hidden="true" /></button></>} />)}</div> : <div className="provider-empty-state translation-empty-state"><KeyRound size={15} aria-hidden="true" /><span>{t.youdaoNotConfigured}</span></div>}
      </section>
      <section className="translation-provider openai-provider">
        <header className="translation-provider-header"><div className="translation-provider-title"><span className="provider-group-icon" aria-hidden="true"><Languages size={18} /></span><div><h3>{providerLabel(locale, 'openai-compatible')}</h3><span className={`provider-key-count${openAICompatibleCredentials.length ? '' : ' is-empty'}`}>{providerCredentialCount(locale, openAICompatibleCredentials.length)}</span></div></div><button type="button" className="secondary-action" disabled={busy} onClick={() => openOpenAICompatible('create')}><Plus size={14} aria-hidden="true" />{openAI.add}</button></header>
        <p className="security-note translation-notice">{openAI.notice}</p>
        {openAICompatibleCredentials.length ? <div className="provider-key-list">{openAICompatibleCredentials.map((credential) => <CredentialRowCompact key={credential.id} item={credential} locale={locale} reveal={reveal} revealPath={`/providers/${credential.id}/reveal-fields`} secrets={[{ label: openAI.key, mask: credential.openAICompatible?.apiKeyMask || credential.mask, field: 'apiKey' }]} actions={(item) => <><button type="button" className="provider-action" title={t.edit} aria-label={t.edit} disabled={busy} onClick={() => openOpenAICompatible(item)}><Pencil size={14} /></button><button type="button" className="provider-action" title={item.enabled ? t.stop : t.enable} aria-label={item.enabled ? t.stop : t.enable} disabled={busy} onClick={() => void mutate(`/providers/${item.id}`, 'PUT', { enabled: !item.enabled }, item.enabled ? t.stop : t.enable)}><Power size={14} /></button><button type="button" className="provider-action" title={t.test} aria-label={t.test} disabled={busy} onClick={() => void mutate(`/providers/${item.id}/test`, 'POST', undefined, t.testSuccess)}><FlaskConical size={14} /></button><button type="button" className="provider-action danger" title={t.remove} aria-label={t.remove} disabled={busy} onClick={() => { if (window.confirm(credentialRemovalPrompt(locale, item.label))) void mutate(`/providers/${item.id}`, 'DELETE', undefined, t.remove); }}><Trash2 size={14} /></button></>} />)}</div> : <div className="provider-empty-state translation-empty-state"><KeyRound size={15} aria-hidden="true" /><span>{t.youdaoNotConfigured}</span></div>}
      </section>
    </div>
  </Panel>;
}

function YoudaoCredentialDialog({ value, locale, busy, mutate, close }: {
  value?: Credential; locale: AdminLocale; busy: boolean; mutate: Mutate; close: () => void;
}) {
  const t = adminText[locale];
  const creating = !value;
  const [label, setLabel] = useState(value?.label || '');
  const [appKey, setAppKey] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [visibleKey, setVisibleKey] = useState(false);
  const [visibleSecret, setVisibleSecret] = useState(false);
  const [quotaLimit, setQuotaLimit] = useState(String(value?.quotaLimit || providerQuotaDefaults.youdao));
  const [quotaPeriod, setQuotaPeriod] = useState<'day' | 'month'>(value?.quotaPeriod || 'month');
  const [translationPriority, setTranslationPriority] = useState(String(value?.translationPriority ?? 30));
  const [enabled, setEnabled] = useState(value?.enabled ?? true);
  return <Dialog title={creating ? t.addKey : t.edit} close={close} locale={locale}><form className="dialog-form" onSubmit={async (event) => {
    event.preventDefault();
    const key = appKey.trim();
    const secret = appSecret.trim();
    if (creating ? (!key || !secret) : Boolean(key) !== Boolean(secret)) return;
    const body = {
      provider: 'youdao', label: label.trim() || `${t.providers.youdao} ${t.key}`,
      ...(key && secret ? { secret: JSON.stringify({ appKey: key, appSecret: secret }) } : {}),
      quotaLimit: Number(quotaLimit), quotaPeriod, translationPriority: Number(translationPriority), enabled
    };
    const result = await mutate(creating ? '/providers' : `/providers/${value.id}`, creating ? 'POST' : 'PUT', body, t.youdaoSaved);
    if (result) close();
  }}>
    <p className="security-note translation-notice">{translationCostText(locale).youdao}</p>
    <label><span>{t.name}</span><input name="label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t.autoName} /></label>
    <label className="secret-input-field"><span>{t.youdaoAppKey}</span><div><input name="youdaoAppKey" type={visibleKey ? 'text' : 'password'} value={appKey} required={creating || Boolean(appSecret)} autoComplete="new-password" placeholder={creating ? '' : t.replaceSecret} onChange={(event) => setAppKey(event.target.value)} /><button type="button" className="inline-toggle" onClick={() => setVisibleKey((current) => !current)}>{visibleKey ? t.hideSecret : t.showSecret}</button></div></label>
    <label className="secret-input-field"><span>{t.youdaoAppSecret}</span><div><input name="youdaoAppSecret" type={visibleSecret ? 'text' : 'password'} value={appSecret} required={creating || Boolean(appKey)} autoComplete="new-password" placeholder={creating ? '' : t.replaceSecret} onChange={(event) => setAppSecret(event.target.value)} /><button type="button" className="inline-toggle" onClick={() => setVisibleSecret((current) => !current)}>{visibleSecret ? t.hideSecret : t.showSecret}</button></div></label>
    <label><span>{t.quotaUsage}</span><input name="quotaLimit" type="number" min="1" max="100000000" required value={quotaLimit} onChange={(event) => setQuotaLimit(event.target.value)} /></label>
    <label><span>{t.quotaReset}</span><select name="quotaPeriod" value={quotaPeriod} onChange={(event) => setQuotaPeriod(event.target.value as 'day' | 'month')}><option value="day">{t.quotaDay}</option><option value="month">{t.quotaMonth}</option></select></label>
    <label><span>{openAIText(locale).priority}</span><input name="translationPriority" type="number" min="1" max="10000" required value={translationPriority} onChange={(event) => setTranslationPriority(event.target.value)} /></label>
    <label className="check"><input name="enabled" type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{t.enable}</label>
    <div className="dialog-actions"><button type="button" onClick={close}>{t.cancel}</button><button className="primary-action" disabled={busy}>{t.save}</button></div>
  </form></Dialog>;
}

const supportsChatCompletions = (model: OpenAICompatibleModel) => !model.supportedEndpoints
  || model.supportedEndpoints.some((endpoint) => endpoint.endsWith('/chat/completions'));

function TranslationModelPicker({ value, models, locale, fetching, fetchDisabled, onChange, onFetch }: {
  value: string; models: OpenAICompatibleModel[]; locale: AdminLocale; fetching: boolean; fetchDisabled: boolean;
  onChange: (value: string) => void; onFetch: () => void;
}) {
  const text = openAIText(locale);
  const labels = locale === 'zh-CN'
    ? { all: '查看全部模型', empty: '没有匹配项，可直接输入模型名称', unavailable: '不支持 Chat Completions', count: '个模型', blocked: '个不兼容', hint: '从列表选择，或直接输入模型名称。' }
    : locale === 'zh-TW'
      ? { all: '查看全部模型', empty: '沒有符合項目，可直接輸入模型名稱', unavailable: '不支援 Chat Completions', count: '個模型', blocked: '個不相容', hint: '從清單選取，或直接輸入模型名稱。' }
      : { all: 'Show all models', empty: 'No matches. You can enter a model ID directly.', unavailable: 'Chat Completions unsupported', count: 'models', blocked: 'incompatible', hint: 'Choose from the list or enter a model ID.' };
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const visible = models.filter((item) => item.id.toLowerCase().includes(query.trim().toLowerCase()));
  const incompatible = models.filter((item) => !supportsChatCompletions(item)).length;
  useEffect(() => {
    setOpen(models.length > 0); setQuery(''); setActive(-1);
    if (models.length && root.current?.contains(document.activeElement)) input.current?.focus();
  }, [models]);
  useEffect(() => {
    if (open && active >= 0) document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, id]);
  const choose = (item: OpenAICompatibleModel) => {
    if (!supportsChatCompletions(item)) return;
    onChange(item.id); setOpen(false); setQuery(''); setActive(-1); input.current?.focus();
  };
  const showAll = () => { setQuery(''); setActive(-1); setOpen(true); input.current?.focus(); };
  const keyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && models.length) {
      event.preventDefault();
      const items = open ? visible : models;
      const choices = items.map((item, index) => supportsChatCompletions(item) ? index : -1).filter((index) => index >= 0);
      const current = open ? choices.indexOf(active) : -1;
      const next = current < 0 ? event.key === 'ArrowDown' ? 0 : choices.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
      if (!open) setQuery('');
      setOpen(true); setActive(choices[next] ?? -1);
    } else if (event.key === 'Enter' && open) {
      event.preventDefault();
      if (visible[active]) choose(visible[active]); else setOpen(false);
    }
  };
  return <div className="model-picker-field"><label htmlFor={id}><span>{text.model}</span></label>
    <div ref={root} className="model-picker" onKeyDown={(event) => {
      if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
    }} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}>
      <div className="model-picker-controls"><div className="model-picker-input">
        <input ref={input} id={id} name="model" required autoComplete="off" role="combobox" aria-autocomplete="list"
          aria-expanded={open && models.length > 0} aria-controls={`${id}-list`} aria-describedby={`${id}-hint`}
          aria-activedescendant={open && active >= 0 ? `${id}-option-${active}` : undefined} value={value}
          onClick={() => { if (models.length) showAll(); }} onKeyDown={keyDown}
          onChange={(event) => { onChange(event.target.value); setQuery(event.target.value); setActive(-1); setOpen(models.length > 0); }} />
        {models.length > 0 && <button type="button" className="model-picker-toggle" aria-label={labels.all}
          aria-expanded={open} aria-controls={`${id}-list`} onClick={() => open ? setOpen(false) : showAll()}><ChevronDown size={16} aria-hidden="true" /></button>}
      </div><button type="button" className="model-fetch-button" title={fetching ? text.fetchingModels : text.fetchModels}
        aria-label={fetching ? text.fetchingModels : text.fetchModels} aria-busy={fetching} disabled={fetchDisabled} onClick={onFetch}>
        {fetching ? <RefreshCw size={18} className="is-spinning" aria-hidden="true" /> : <Download size={18} aria-hidden="true" />}
      </button></div>
      {open && models.length > 0 && <div className="model-picker-dropdown">
        <div className="model-picker-count">{visible.length} / {models.length} {labels.count}{incompatible > 0 && ` · ${incompatible} ${labels.blocked}`}</div>
        <div id={`${id}-list`} role="listbox" aria-label={text.model} className="model-picker-options">
          {visible.map((item, index) => <div key={item.id} id={`${id}-option-${index}`} role="option"
            aria-selected={item.id === value} aria-disabled={!supportsChatCompletions(item)}
            className={`model-picker-option${active === index ? ' is-active' : ''}`}
            onMouseDown={(event) => event.preventDefault()} onClick={() => choose(item)}>
            <span><span className="model-picker-name">{item.id}</span>{!supportsChatCompletions(item) && <small>{labels.unavailable}{item.supportedEndpoints?.length ? ` · ${item.supportedEndpoints.join(', ')}` : ''}</small>}</span>
            {item.id === value && <Check size={16} aria-hidden="true" />}
          </div>)}
        </div>{!visible.length && <p className="model-picker-empty" role="status">{labels.empty}</p>}
      </div>}
    </div><small id={`${id}-hint`} role="status">{fetching ? text.fetchingModels : models.length ? `${models.length} ${labels.count} · ${labels.hint}` : labels.hint}</small>
  </div>;
}

function OpenAICompatibleCredentialDialog({ value, locale, busy, mutate, close }: {
  value?: Credential; locale: AdminLocale; busy: boolean; mutate: Mutate; close: () => void;
}) {
  const t = adminText[locale];
  const text = openAIText(locale);
  const creating = !value;
  const [label, setLabel] = useState(value?.label || '');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(value?.openAICompatible?.baseUrl || '');
  const [model, setModel] = useState(value?.openAICompatible?.model || '');
  const currentModel = useRef(model);
  currentModel.current = model;
  const savedEffort = value?.openAICompatible?.reasoningEffort;
  const [reasoningEffort, setReasoningEffort] = useState(savedEffort && savedEffort !== 'default' ? savedEffort : 'low');
  const [maxTokens, setMaxTokens] = useState(String(value?.openAICompatible?.maxTokens || 8192));
  const [translationPriority, setTranslationPriority] = useState(String(value?.translationPriority ?? 10));
  const [translationPrompt, setTranslationPrompt] = useState(value?.translationPrompt || '');
  const [models, setModels] = useState<OpenAICompatibleModel[]>([]);
  const modelFetchSequence = useRef(0);
  const reasoningListId = useId();
  const selectedModel = models.find((item) => item.id === model);
  const modelCompatible = !selectedModel || supportsChatCompletions(selectedModel);
  const selectModel = (id: string, available = models) => {
    setModel(id);
    const efforts = available.find((item) => item.id === id)?.reasoningEfforts?.filter((effort) => effort !== 'default');
    setReasoningEffort(efforts?.length && !efforts.includes('low') ? efforts[0] : 'low');
  };
  const capabilityText = locale === 'zh-CN'
    ? { unknown: '接口未提供思考强度列表。项目默认发送 low，可按供应商文档修改；这不代表供应商的默认值。', known: '候选值来自该模型的接口元数据，所填值将随请求发送。', incompatible: '不支持 Chat Completions', endpoint: '填写包含 API 路径前缀的基础地址（如 /v1），或完整的 /chat/completions、/models 地址。' }
    : locale === 'zh-TW'
      ? { unknown: '介面未提供思考強度清單。專案預設傳送 low，可依供應商文件修改；這不代表供應商的預設值。', known: '候選值來自模型的介面中繼資料，填入的值會隨請求傳送。', incompatible: '不支援 Chat Completions', endpoint: '填入含 API 路徑前綴的基礎網址（如 /v1），或完整的 /chat/completions、/models 網址。' }
      : { unknown: 'The endpoint did not advertise reasoning levels. This project sends low initially; adjust it using the provider documentation. This is not the provider default.', known: 'Suggestions come from this model’s API metadata. The entered value is sent with requests.', incompatible: 'Chat Completions unsupported', endpoint: 'Enter the API base URL including its path prefix (such as /v1), or the full /chat/completions or /models URL.' };
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelFetchState, setModelFetchState] = useState<'idle' | 'empty' | 'error'>('idle');
  const [visible, setVisible] = useState(false);
  const [quotaLimit, setQuotaLimit] = useState(String(value?.quotaLimit || providerQuotaDefaults['openai-compatible']));
  const [enabled, setEnabled] = useState(value?.enabled ?? true);
  const invalidateModels = () => { modelFetchSequence.current++; setFetchingModels(false); setModels([]); setModelFetchState('idle'); };
  const fetchModels = async () => {
    const sequence = ++modelFetchSequence.current;
    setFetchingModels(true); setModels([]);
    try {
      const result = await mutate<{ models?: OpenAICompatibleModel[]; baseUrl?: string }>('/providers/openai-compatible/models', 'POST', {
        ...(value ? { credentialId: value.id } : {}), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        baseUrl: baseUrl.trim()
      }, '');
      if (sequence !== modelFetchSequence.current) return;
      if (result?.baseUrl) setBaseUrl(result.baseUrl);
      const available = result?.models || [];
      setModels(available);
      if (!currentModel.current.trim()) selectModel(available.find(supportsChatCompletions)?.id || '', available);
      setModelFetchState(result ? (available.length ? 'idle' : 'empty') : 'error');
    } finally { if (sequence === modelFetchSequence.current) setFetchingModels(false); }
  };
  return <Dialog title={creating ? text.add : t.edit} close={close} locale={locale}><form className="dialog-form" onSubmit={async (event) => {
    event.preventDefault();
    if (!modelCompatible) return;
    const key = apiKey.trim();
    const body = {
      provider: 'openai-compatible', label: label.trim() || `${providerLabel(locale, 'openai-compatible')} ${t.key}`,
      ...(key ? { apiKey: key } : {}), baseUrl: baseUrl.trim(), model: model.trim(), reasoningEffort,
      maxTokens: Number(maxTokens), translationPriority: Number(translationPriority), translationPrompt: translationPrompt.trim(),
      quotaLimit: Number(quotaLimit), quotaPeriod: 'day', enabled
    };
    const result = await mutate(creating ? '/providers' : `/providers/${value.id}`, creating ? 'POST' : 'PUT', body, text.saved);
    if (result) close();
  }}>
    <p className="security-note translation-notice">{text.notice}</p>
    <label><span>{t.name}</span><input name="label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t.autoName} /></label>
    <label className="secret-input-field"><span>{text.key}</span><div><input name="apiKey" type={visible ? 'text' : 'password'} value={apiKey} required={creating} autoComplete="new-password" placeholder={creating ? '' : value?.openAICompatible?.apiKeyMask || t.replaceSecret} onChange={(event) => { setApiKey(event.target.value); invalidateModels(); }} /><button type="button" className="inline-toggle" onClick={() => setVisible((current) => !current)}>{visible ? t.hideSecret : t.showSecret}</button></div></label>
    <label><span>{text.endpoint}</span><input name="baseUrl" type="url" required value={baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => { setBaseUrl(event.target.value); invalidateModels(); }} /><small>{capabilityText.endpoint}</small></label>
    <TranslationModelPicker value={model} models={models} locale={locale} fetching={fetchingModels}
      fetchDisabled={busy || fetchingModels || !baseUrl.trim() || creating && !apiKey.trim()}
      onChange={selectModel} onFetch={() => void fetchModels()} />
    {!modelCompatible && <p className="field-error" role="alert">{capabilityText.incompatible}</p>}
    {modelFetchState === 'empty' && <p className="field-error" role="status">{text.modelsEmpty}</p>}
    {modelFetchState === 'error' && <p className="field-error" role="alert">{text.modelsFailed}</p>}
    <label><span>{text.reasoning}</span><input name="reasoningEffort" list={reasoningListId} required pattern={'[a-z][a-z0-9_\\-]{0,31}'} value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)} /><datalist id={reasoningListId}>{selectedModel?.reasoningEfforts?.filter((effort) => effort !== 'default').map((effort) => <option key={effort} value={effort} />)}</datalist><small>{selectedModel?.reasoningEfforts ? capabilityText.known : capabilityText.unknown}</small></label>
    <label><span>{text.maxTokens}</span><input name="maxTokens" type="number" min="1024" max="32768" step="1" required value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} /></label>
    <label><span>{text.priority}</span><input name="translationPriority" type="number" min="1" max="10000" step="1" required value={translationPriority} onChange={(event) => setTranslationPriority(event.target.value)} /></label>
    <label><span>{text.prompt}</span><textarea name="translationPrompt" maxLength={4000} value={translationPrompt} onChange={(event) => setTranslationPrompt(event.target.value)} /><small>{text.promptHint}</small></label>
    <label><span>{t.quotaUsage}</span><input name="quotaLimit" type="number" min="1" max="100000000" required value={quotaLimit} onChange={(event) => setQuotaLimit(event.target.value)} /></label>
    <label className="check"><input name="enabled" type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{t.enable}</label>
    <div className="dialog-actions"><button type="button" onClick={close}>{t.cancel}</button><button className="primary-action" disabled={busy}>{t.save}</button></div>
  </form></Dialog>;
}

function ProviderCredentialDialog({ value, initialProvider = 'amap', locale, busy, mutate, close }: {
  value?: Credential; initialProvider?: string; locale: AdminLocale; busy: boolean; mutate: Mutate; close: () => void;
}) {
  const t = adminText[locale];
  const googleQuota = googleQuotaText(locale);
  const [provider, setProvider] = useState(value?.provider || initialProvider);
  const [label, setLabel] = useState(value?.label || '');
  const [secret, setSecret] = useState('');
  const [visible, setVisible] = useState(false);
  const [quotaLimit, setQuotaLimit] = useState(String(value?.quotaLimit || providerQuotaDefaults[initialProvider] || providerQuotaDefaults.amap));
  const [quotaPeriod, setQuotaPeriod] = useState<'day' | 'month'>(value?.quotaPeriod || 'month');
  const [quotaUsedBaseline, setQuotaUsedBaseline] = useState(String(value?.quotaBaseline || 0));
  const [translationPriority, setTranslationPriority] = useState(String(value?.translationPriority ?? 20));
  const [enabled, setEnabled] = useState(value?.enabled ?? true);
  const creating = !value;
  const changeProvider = (next: string) => {
    setProvider(next);
    setQuotaLimit(String(providerQuotaDefaults[next] || 100));
    setQuotaPeriod(providerQuotaPeriods[next] || 'day');
    setQuotaUsedBaseline('0');
  };
  return <Dialog title={creating ? provider === 'deepl' ? deeplText(locale).add : t.addMapKey : t.edit} close={close} locale={locale}><form className="dialog-form" onSubmit={async (event) => {
    event.preventDefault();
    const secretValue = secret.trim();
    const body = {
      provider,
      label: label.trim() || `${providerLabel(locale, provider)} ${t.key}`,
      ...(secretValue ? { secret: secretValue } : {}),
      quotaLimit: Number(quotaLimit), quotaPeriod,
      ...(provider === 'deepl' ? { translationPriority: Number(translationPriority) } : {}),
      ...(provider === 'google-geocoding' ? { quotaUsedBaseline: Number(quotaUsedBaseline) } : {}), enabled
    };
    const result = await mutate(creating ? '/providers' : `/providers/${value.id}`, creating ? 'POST' : 'PUT', body, t.keySaved);
    if (result) close();
  }}>
    {provider === 'deepl' ? <p className="security-note">{deeplText(locale).notice}</p> : <label><span>{t.provider}</span><select name="provider" value={provider} disabled={!creating} onChange={(event) => changeProvider(event.target.value)}><option value="amap">{providerLabel(locale, 'amap')}</option><option value="baidu">{providerLabel(locale, 'baidu')}</option><option value="tencent">{providerLabel(locale, 'tencent')}</option><option value="onemap">{providerLabel(locale, 'onemap')}</option><option value="geoapify">{providerLabel(locale, 'geoapify')}</option><option value="google-geocoding">{providerLabel(locale, 'google-geocoding')}</option><option value="mappls">{providerLabel(locale, 'mappls')}</option>{!creating && !['amap', 'baidu', 'tencent', 'onemap', 'geoapify', 'google-geocoding', 'mappls'].includes(provider) && <option value={provider}>{providerLabel(locale, provider)}</option>}</select></label>}
    <label><span>{t.name}</span><input name="label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t.autoName} /></label>
    <label className="secret-input-field"><span>{t.key}</span><div><input name="secret" type={visible ? 'text' : 'password'} value={secret} required={creating} autoComplete="new-password" placeholder={creating ? '' : t.replaceSecret} onChange={(event) => setSecret(event.target.value)} /><button type="button" className="inline-toggle" onClick={() => setVisible((current) => !current)}>{visible ? t.hideSecret : t.showSecret}</button></div></label>
    {provider === 'geoapify' && <p className="security-note">{t.geoapifyWorkerHint}</p>}
    {provider === 'google-geocoding' && <p className="security-note">{googleQuota.official}</p>}
    <label><span>{provider === 'deepl' ? deeplText(locale).budget : provider === 'google-geocoding' ? googleQuota.budget : t.quotaUsage}</span><input name="quotaLimit" type="number" min="1" max="100000000" required value={quotaLimit} onChange={(event) => setQuotaLimit(event.target.value)} /></label>
    {provider === 'deepl' ? <p className="security-note">{deeplText(locale).reset}</p> : <label><span>{t.quotaReset}</span><select name="quotaPeriod" value={quotaPeriod} onChange={(event) => setQuotaPeriod(event.target.value as 'day' | 'month')}><option value="day">{t.quotaDay}</option><option value="month">{t.quotaMonth}</option></select></label>}
    {provider === 'google-geocoding' && <label><span>{googleQuota.baseline}</span><input name="quotaUsedBaseline" type="number" min="0" max={quotaLimit || '9000'} required value={quotaUsedBaseline} onChange={(event) => setQuotaUsedBaseline(event.target.value)} /><small>{googleQuota.hint}</small></label>}
    {provider === 'deepl' && <label><span>{openAIText(locale).priority}</span><input name="translationPriority" type="number" min="1" max="10000" required value={translationPriority} onChange={(event) => setTranslationPriority(event.target.value)} /><small>{openAIText(locale).routingHint}</small></label>}
    <label className="check"><input name="enabled" type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{t.enable}</label>
    <div className="dialog-actions"><button type="button" onClick={close}>{t.cancel}</button><button className="primary-action" disabled={busy}>{t.save}</button></div>
  </form></Dialog>;
}

function SecretCell({ mask, locale, reveal, path, field }: { mask: string; locale: AdminLocale; reveal: Reveal; path: string; field: string }) {
  const t = adminText[locale];
  const [value, setValue] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const copyTimer = useRef<number | undefined>(undefined);
  const requestId = useRef(0);
  const clear = useCallback(() => {
    requestId.current += 1;
    if (timer.current) window.clearTimeout(timer.current);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    timer.current = undefined;
    copyTimer.current = undefined;
    setValue(''); setVisible(false); setCopied(false); setError(false); setBusy(false);
  }, []);
  useEffect(() => { clear(); }, [clear, locale, mask, path, field]);
  useEffect(() => {
    const onVisibility = () => { if (document.hidden) clear(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { document.removeEventListener('visibilitychange', onVisibility); clear(); };
  }, [clear]);
  const toggle = async () => {
    setError(false);
    if (visible) { clear(); return; }
    if (document.hidden) return;
    const id = ++requestId.current;
    setBusy(true);
    try {
      const result = await reveal(path);
      if (id !== requestId.current || document.hidden) return;
      const secret = String(result[field] || '');
      if (!secret) throw new Error('EMPTY_SECRET');
      setValue(secret); setVisible(true);
      timer.current = window.setTimeout(clear, 30_000);
    } catch { if (id === requestId.current) setError(true); }
    finally { if (id === requestId.current) setBusy(false); }
  };
  const copy = async () => {
    if (!value) return;
    const id = requestId.current;
    try {
      await navigator.clipboard.writeText(value);
      if (id !== requestId.current) return;
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch { if (id === requestId.current) setError(true); }
  };
  return <div className="secret-cell"><code>{visible ? value : mask}</code><div className="secret-actions"><button type="button" className="compact-action" disabled={busy} onClick={() => void toggle()}>{busy ? '…' : visible ? t.hideSecret : t.showSecret}</button>{visible && <button type="button" className="compact-action" onClick={() => void copy()}>{copied ? t.copied : t.copySecret}</button>}</div>{error && <small className="field-error">{t.revealFailed}</small>}</div>;
}

const Panel = ({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) => <section className="admin-panel"><header><h2>{title}</h2>{actions}</header>{children}</section>;
const EmptyState = ({ icon: Icon, text }: { icon: typeof Globe2; text: string }) => <div className="empty-hint"><span className="empty-hint-icon" aria-hidden="true"><Icon size={19} /></span><p>{text}</p></div>;
const usagePercent = (used: number, limit: number): number => limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
function Dialog({ title, close, locale, children, className = '' }: { title: string; close: () => void; locale: AdminLocale; children: ReactNode; className?: string }) {
  const root = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  const titleId = useId();
  useEffect(() => { closeRef.current = close; }, [close]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => [...(root.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])];
    window.setTimeout(() => (focusable()[0] || root.current)?.focus(), 0);
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const values = focusable();
      if (!values.length) { event.preventDefault(); root.current?.focus(); return; }
      const first = values[0];
      const last = values[values.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keyDown);
    return () => {
      document.removeEventListener('keydown', keyDown);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return <div className="dialog-backdrop" role="presentation"><section ref={root} className={`admin-dialog ${className}`.trim()} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><header><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" title={adminText[locale].close} aria-label={adminText[locale].close} onClick={close}><X aria-hidden="true" /></button></header>{children}</section></div>;
}
const scopeLabel = (scope: string, locale: AdminLocale): string => ({ read: locale === 'zh-CN' ? '读取' : 'Read', generate: locale === 'zh-CN' ? '生成' : 'Generate', '*': locale === 'zh-CN' ? '全部' : 'All' } as Record<string, string>)[scope] || scope;
const continentLabel = (group: string, locale: AdminLocale): string => {
  const t = adminText[locale];
  const labels: Record<string, string> = {
    'north-america': t.northAmerica,
    europe: t.europe,
    'east-asia': t.asia,
    'southeast-asia': t.asia,
    'south-asia': t.asia,
    'middle-east': t.asia,
    oceania: t.oceania,
    'south-america': t.southAmerica,
    africa: t.africa
  };
  return labels[group] || group;
};
const CountryCoverageTable = ({ values, open, locale }: { values: CoverageNode[]; open: (value: CoverageNode) => void; locale: AdminLocale }) => {
  const headings = locale === 'zh-CN'
    ? { country: '国家', region: '区域', total: '真实住宅总量', coverage: '行政区覆盖', first: '第一级', second: '第二级', third: '第三级' }
    : { country: 'Country', region: 'Region', total: 'Verified residences', coverage: 'Administrative coverage', first: 'Level 1', second: 'Level 2', third: 'Level 3' };
  return <div className="table-scroll"><table className="country-coverage-table"><thead><tr><th rowSpan={2}>{headings.country}</th><th rowSpan={2}>{headings.region}</th><th rowSpan={2}>{headings.total}</th><th colSpan={3}>{headings.coverage}</th></tr><tr><th>{headings.first}</th><th>{headings.second}</th><th>{headings.third}</th></tr></thead><tbody>{values.map((item) => {
    const countryCode = item.countryCode.toUpperCase();
    const meta = isCountryCode(countryCode) ? countryByCode.get(countryCode) : undefined;
    const levels = item.coverageLevels || [];
    return <tr key={item.key}><td><button className="country-name-button" disabled={!item.childCount} onClick={() => open(item)}><img className="country-flag" src={`https://flagcdn.com/24x18/${countryCode.toLowerCase()}.png`} width="24" height="18" alt="" loading="lazy" /><strong>{coverageRegionName(item, locale)}</strong></button></td><td>{meta ? continentLabel(meta.group, locale) : '-'}</td><td className="numeric-cell">{item.residentialCount.toLocaleString()}</td>{[0, 1, 2].map((index) => {
      const level = levels[index];
      return <td key={index}>{level ? <span className="coverage-value"><small>{locale === 'zh-CN' ? level.labelZh : level.labelEn}</small><b>{level.covered.toLocaleString()} / {level.total.toLocaleString()}</b></span> : '-'}</td>;
    })}</tr>;
  })}</tbody></table>{!values.length && <p className="admin-empty">{adminText[locale].noSubregions}</p>}</div>;
};
const CoverageTable = ({ values, open, locale }: { values: CoverageNode[]; open: (value: CoverageNode) => void; locale: AdminLocale }) => {
  const t = adminText[locale];
  return <div className="table-scroll"><table><thead><tr><th>{t.region}</th><th>{t.level}</th><th>{t.residential}</th><th>{t.administrativeCoverage}</th></tr></thead><tbody>{values.map((item) => <tr key={item.key}>
    <td><button className="drill-button" disabled={!item.childCount} title={!item.childCount ? t.noSubregions : undefined} onClick={() => open(item)}>{coverageRegionName(item, locale)}</button>{!item.totalCount && <span className="coverage-empty-tag">{t.noAddressData}</span>}</td>
    <td>{coverageLevelName(item, locale)}</td><td>{item.residentialCount.toLocaleString()}</td>
    <td>{item.coverageLevels?.length ? <div className="coverage-ratios">{item.coverageLevels.map((level) => <span key={level.key} title={`${t.qualifiedCoverage}: ${level.qualified.toLocaleString()} / ${level.total.toLocaleString()}`}><b>{locale === 'zh-CN' ? level.labelZh : level.labelEn}</b>{level.covered.toLocaleString()} / {level.total.toLocaleString()}</span>)}</div> : item.childCount.toLocaleString()}</td>
  </tr>)}</tbody></table>{!values.length && <p className="admin-empty">{t.noSubregions}</p>}</div>;
};
const providerCredentialOrder = ['amap', 'baidu', 'tencent', 'onemap', 'geoapify', 'google-geocoding', 'mappls'] as const;
const providerCredentialCount = (locale: AdminLocale, count: number): string => {
  if (locale === 'zh-CN') return `${count} 个密钥`;
  if (locale === 'zh-TW') return `${count} 個金鑰`;
  return `${count} ${count === 1 ? 'key' : 'keys'}`;
};
interface CredentialSecretField { label: string; mask: string; field: string }
const CredentialRowCompact = ({ item, locale, reveal, actions, secrets, revealPath }: {
  item: Credential; locale: AdminLocale; reveal: Reveal; actions: (value: Credential) => ReactNode; secrets?: CredentialSecretField[]; revealPath?: string;
}) => {
  const t = adminText[locale];
  const openAI = item.openAICompatible ? openAIText(locale) : undefined;
  const secretFields = secrets || [{ label: t.key, mask: item.mask, field: 'secret' }];
  const windows = item.quotaWindows?.length ? item.quotaWindows : [{
    service: item.quotaService, period: item.quotaPeriod, used: item.quotaUsed, limit: item.quotaLimit,
    remaining: item.quotaRemaining, resetAt: item.quotaResetAt, usageSource: item.quotaUsageSource, exhausted: item.quotaUsed >= item.quotaLimit
  }];
  return <article className="provider-key-row">
    <div className="provider-key-name"><span>{t.name}</span><strong>{credentialDisplayLabel(locale, item.label)}</strong>{item.translationPriority !== undefined && <small>{openAIText(locale).routePriority}: {item.translationPriority}</small>}{item.openAICompatible && openAI && <small className="provider-key-config"><span>{openAI.endpoint}: {item.openAICompatible.baseUrl}</span><span>{openAI.model}: {item.openAICompatible.model}</span></small>}</div>
    <div className={`provider-key-secrets${secretFields.length > 1 ? ' is-paired' : ''}`}>{secretFields.map((secret) => <div className="provider-key-secret" key={secret.field}><span>{secret.label}</span><SecretCell mask={secret.mask} locale={locale} reveal={reveal} path={revealPath || `/providers/${item.id}/reveal`} field={secret.field} /></div>)}</div>
    <div className="provider-key-status"><span className={`badge ${item.status}`}>{t.status[item.status as keyof typeof t.status] || item.status}</span>{item.expiresAt && <small>{dateTime(item.expiresAt, locale)}</small>}<small>{t.lastSuccess}: {dateTime(item.lastSuccessAt, locale)}</small></div>
    <div className="quota-cell">{item.characterQuota ? <div className="quota-window">
      <b>{item.characterQuota.used.toLocaleString(locale)} / {item.characterQuota.limit.toLocaleString(locale)} {deeplText(locale).characters}</b>
      <small>{deeplText(locale).budget}: {item.quotaLimit.toLocaleString(locale)}</small>
      <small>{deeplText(locale).provider}: {item.characterQuota.providerUsed.toLocaleString(locale)} / {item.characterQuota.providerLimit.toLocaleString(locale)}</small>
      <small>{item.characterQuota.observedAt ? `${deeplText(locale).observed}: ${dateTime(item.characterQuota.observedAt, locale)}` : deeplText(locale).unknown}</small>
      <small>{item.characterQuota.resetAt ? dateTime(item.characterQuota.resetAt, locale) : deeplText(locale).reset}</small>
    </div> : windows.map((window) => <div className="quota-window" key={`${window.service}-${window.period}`}>
      <b>{window.used.toLocaleString(locale)}/{window.limit.toLocaleString(locale)} {window.period === 'month' ? t.quotaMonth : t.quotaDay}</b>
      <span className={`quota-bar${usagePercent(window.used, window.limit) >= 100 ? ' full' : usagePercent(window.used, window.limit) >= 80 ? ' high' : ''}`}><i style={{ width: `${usagePercent(window.used, window.limit)}%` }} /></span>
      <small>{window.remaining.toLocaleString(locale)} {t.quotaRemaining}</small>
      <small>{t.quotaReset} {dateTime(window.resetAt, locale)}</small>
    </div>)}</div>
    <div className="row-actions provider-key-actions">{actions(item)}</div>
  </article>;
};
const ProviderCredentialsPanel = ({ values, locale, reveal, busy, mutate, openEditor, openProvider }: { values: Credential[]; locale: AdminLocale; reveal: Reveal; busy: boolean; mutate: Mutate; openEditor: (value: Credential) => void; openProvider: (provider: string) => void }) => {
  const t = adminText[locale];
  return <Panel title={t.providersTitle}><div className="provider-groups">{providerCredentialOrder.map((provider) => {
    const items = values.filter((credential) => credential.provider === provider);
    return <section className="provider-group" key={provider}>
      <header className="provider-group-header"><div className="provider-group-title"><span className="provider-group-icon" aria-hidden="true"><KeyRound size={18} /></span><div><h3>{providerLabel(locale, provider)}</h3><span className={`provider-key-count${items.length ? '' : ' is-empty'}`}>{providerCredentialCount(locale, items.length)}</span></div></div><button type="button" className="secondary-action" disabled={busy} onClick={() => openProvider(provider)}><Plus size={14} aria-hidden="true" />{t.addKey}</button></header>
      {items.length ? <div className="provider-key-list">{items.map((item) => <CredentialRowCompact key={item.id} item={item} locale={locale} reveal={reveal} actions={(credential) => <><button type="button" className="provider-action" title={t.edit} aria-label={t.edit} disabled={busy} onClick={() => openEditor(credential)}><Pencil size={14} aria-hidden="true" /></button><button type="button" className="provider-action" title={credential.enabled ? t.stop : t.enable} aria-label={credential.enabled ? t.stop : t.enable} disabled={busy} onClick={() => void mutate(`/providers/${credential.id}`, 'PUT', { enabled: !credential.enabled }, credential.enabled ? t.stop : t.enable)}><Power size={14} aria-hidden="true" /></button><button type="button" className="provider-action" title={t.test} aria-label={t.test} disabled={busy} onClick={() => void mutate(`/providers/${credential.id}/test`, 'POST', undefined, t.testSuccess)}><FlaskConical size={14} aria-hidden="true" /></button><button type="button" className="provider-action danger" title={t.remove} aria-label={t.remove} disabled={busy} onClick={() => { if (window.confirm(credentialRemovalPrompt(locale, credential.label))) void mutate(`/providers/${credential.id}`, 'DELETE', undefined, t.remove); }}><Trash2 size={14} aria-hidden="true" /></button></>} />)}</div> : <div className="provider-empty-state"><KeyRound size={15} aria-hidden="true" /><span>{t.noKeys}</span></div>}
    </section>;
  })}</div></Panel>;
};
function ChinaAreaCoverage({ locale, request }: { locale: AdminLocale; request: RequestData }) {
  const t = adminText[locale];
  const [provinceAdcode, setProvinceAdcode] = useState('');
  const [cityAdcode, setCityAdcode] = useState('');
  const [districtAdcode, setDistrictAdcode] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState<ChinaAreaListData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const parameters = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (provinceAdcode) parameters.set('provinceAdcode', provinceAdcode);
    if (cityAdcode) parameters.set('cityAdcode', cityAdcode);
    if (districtAdcode) parameters.set('districtAdcode', districtAdcode);
    setLoading(true); setError('');
    void request<ChinaAreaListData>(`/china/areas?${parameters}`, { signal: controller.signal })
      .then((value) => {
        const pages = Math.max(1, Math.ceil(value.total / value.pageSize));
        if (page > pages) { setPage(pages); return; }
        setData(value);
      })
      .catch((value) => { if (!controller.signal.aborted) setError(errorMessage(value, locale)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [request, locale, provinceAdcode, cityAdcode, districtAdcode, page, pageSize]);
  const pages = Math.max(1, Math.ceil((data?.total || 0) / (data?.pageSize || pageSize)));
  const changeProvince = (value: string) => { setProvinceAdcode(value); setCityAdcode(''); setDistrictAdcode(''); setPage(1); };
  const changeCity = (value: string) => { setCityAdcode(value); setDistrictAdcode(''); setPage(1); };
  return <>
    <div className="coverage-filters">
      <label><span>{t.province}</span><select value={provinceAdcode} onChange={(event) => changeProvince(event.target.value)}><option value="">{t.allProvinces}</option>{data?.options.provinces.map((item) => <option key={item.adcode} value={item.adcode}>{item.name}</option>)}</select></label>
      <label><span>{t.city}</span><select value={cityAdcode} disabled={!provinceAdcode} onChange={(event) => changeCity(event.target.value)}><option value="">{t.allCities}</option>{data?.options.cities.map((item) => <option key={item.adcode} value={item.adcode}>{item.name}</option>)}</select></label>
      <label><span>{t.district}</span><select value={districtAdcode} disabled={!cityAdcode} onChange={(event) => { setDistrictAdcode(event.target.value); setPage(1); }}><option value="">{t.allDistricts}</option>{data?.options.districts.map((item) => <option key={item.adcode} value={item.adcode}>{item.name}</option>)}</select></label>
      <label><span>{t.pageSize}</span><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>{[25, 50, 100].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
    </div>
    {error && <div className="table-error" role="alert">{error}</div>}
    <div className={`table-scroll coverage-table${loading ? ' is-loading' : ''}`}><table><thead><tr><th>{t.province}</th><th>{t.city}</th><th>{t.district}</th><th>{t.currentCommunities}</th><th>{t.target}</th><th>{t.statusLabel}</th></tr></thead><tbody>{(data?.items || []).map((item) => { const current = Number(item.current_count || 0); const target = Number(item.target_count || 5); return <tr key={String(item.district_adcode)}><td>{String(item.province)}</td><td>{String(item.city)}</td><td>{String(item.district)}</td><td>{current.toLocaleString()}</td><td>{target.toLocaleString()}</td><td><span className={`badge ${current >= target ? 'succeeded' : ''}`}>{current >= target ? t.covered : t.pending}</span></td></tr>; })}</tbody></table>{!loading && !data?.items.length && <EmptyState icon={MapPin} text={t.noAreas} />}</div>
    <div className="table-pagination"><span>{interpolate(t.pageSummary, { page, pages, total: data?.total || 0 })}</span><div><button disabled={loading || page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>{t.previousPage}</button><button disabled={loading || page >= pages} onClick={() => setPage((value) => Math.min(pages, value + 1))}>{t.nextPage}</button></div></div>
  </>;
}

const remainingTime = (value: string | null | undefined, now = Date.now()): string => {
  const target = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(target)) return '';
  const minutes = Math.ceil(Math.max(0, target - now) / 60_000);
  if (minutes < 1) return '<1m';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes % 60}m`;
};
const syncQueueRuleText: Record<AdminLocale, {
  total: string; coverage: string; minimums: string; met: string; unmet: string;
  lowest: string; level1: string; level2: string; overrides: string; unmetPrefix: string;
}> = {
  'zh-CN': { total: '国家总量', coverage: '行政区覆盖', minimums: '层级/节点最低数量', met: '已达标', unmet: '未达标', lowest: '最低层级', level1: '省级/一级', level2: '市级/二级', overrides: '自定义节点', unmetPrefix: '未达' },
  'zh-TW': { total: '國家總量', coverage: '行政區覆蓋', minimums: '層級/節點最低數量', met: '已達標', unmet: '未達標', lowest: '最低層級', level1: '省級/一級', level2: '市級/二級', overrides: '自訂節點', unmetPrefix: '未達' },
  en: { total: 'Country total', coverage: 'Admin coverage', minimums: 'Level/node minimums', met: 'Met', unmet: 'Unmet', lowest: 'Lowest level', level1: 'Level 1', level2: 'Level 2', overrides: 'Node overrides', unmetPrefix: 'Unmet' },
  ja: { total: '国別総数', coverage: '行政区カバー率', minimums: '階層・ノード最低数', met: '達成', unmet: '未達', lowest: '最下位', level1: '第1階層', level2: '第2階層', overrides: '個別ノード', unmetPrefix: '未達' },
  ko: { total: '국가 총계', coverage: '행정구역 커버리지', minimums: '단계/노드 최소 수', met: '달성', unmet: '미달', lowest: '최하위', level1: '1단계', level2: '2단계', overrides: '개별 노드', unmetPrefix: '미달' },
  de: { total: 'Landessumme', coverage: 'Verwaltungsabdeckung', minimums: 'Ebenen-/Knotenminimum', met: 'Erfüllt', unmet: 'Offen', lowest: 'Unterste Ebene', level1: 'Ebene 1', level2: 'Ebene 2', overrides: 'Knotenziele', unmetPrefix: 'Offen' },
  fr: { total: 'Total du pays', coverage: 'Couverture administrative', minimums: 'Minimums niveau/nœud', met: 'Atteint', unmet: 'Non atteint', lowest: 'Niveau inférieur', level1: 'Niveau 1', level2: 'Niveau 2', overrides: 'Objectifs de nœud', unmetPrefix: 'Non atteint' },
  es: { total: 'Total del país', coverage: 'Cobertura administrativa', minimums: 'Mínimos de nivel/nodo', met: 'Cumplido', unmet: 'Pendiente', lowest: 'Nivel inferior', level1: 'Nivel 1', level2: 'Nivel 2', overrides: 'Objetivos de nodo', unmetPrefix: 'Pendiente' },
  pt: { total: 'Total do país', coverage: 'Cobertura administrativa', minimums: 'Mínimos de nível/nó', met: 'Atingido', unmet: 'Pendente', lowest: 'Nível inferior', level1: 'Nível 1', level2: 'Nível 2', overrides: 'Metas de nó', unmetPrefix: 'Pendente' }
};
const queueStateRank: Record<SyncQueueEntry['state'], number> = {
  running: 0, queued: 1, retry_wait: 2, cooldown_wait: 3, quota_wait: 4, blocked: 5,
  scheduled_wait: 6, suspended: 7, failed: 8, source_limited: 9, no_source: 10, done: 11
};
const queueBadgeClass: Record<SyncQueueEntry['state'], string> = {
  running: 'running', queued: 'below_target', retry_wait: 'cooldown_wait', cooldown_wait: 'cooldown_wait', quota_wait: 'quota_wait',
  scheduled_wait: 'below_target', source_limited: 'source_limited', suspended: 'failed', no_source: 'source_limited',
  blocked: 'blocked', failed: 'failed', done: 'ready'
};
const queueExtraStateText = (locale: AdminLocale) => locale === 'zh-CN' ? {
  retry_wait: '等待重试', scheduled_wait: '等待下次检查', suspended: '重试已暂停', no_source: '没有可执行来源'
} : locale === 'zh-TW' ? {
  retry_wait: '等待重試', scheduled_wait: '等待下次檢查', suspended: '重試已暫停', no_source: '沒有可執行來源'
} : {
  retry_wait: 'Waiting to retry', scheduled_wait: 'Waiting for next check', suspended: 'Retries suspended', no_source: 'No runnable source'
};
const queueReasonText = (reason: string | null | undefined, locale: AdminLocale): string => {
  if (!reason) return '';
  if (reason.startsWith('missing_api_key:')) {
    const provider = reason.slice('missing_api_key:'.length);
    const name = provider === 'geoapify' ? 'GEOAPIFY_API_KEY'
      : provider === 'mappls' ? 'MAPPLS_API_KEY'
        : provider === 'china_maps' ? 'AMAP_API_KEY / BAIDU_API_KEY / TENCENT_API_KEY' : provider;
    if (locale === 'zh-CN') return provider === 'china_maps' ? `至少配置一个中国地图 API Key：${name}` : `缺少 API Key：${name}`;
    if (locale === 'zh-TW') return provider === 'china_maps' ? `至少設定一個中國地圖 API Key：${name}` : `缺少 API Key：${name}`;
    return provider === 'china_maps' ? `Configure at least one China map API key: ${name}` : `Missing API key: ${name}`;
  }
  if (reason.startsWith('api_key_needs_review:') || reason.startsWith('api_key_disabled:')) {
    const provider = reason.split(':')[1] || '';
    const name = provider === 'geoapify' ? 'GEOAPIFY_API_KEY' : provider === 'mappls' ? 'MAPPLS_API_KEY' : provider;
    return locale.startsWith('zh') ? `API Key 不可用，请在地图密钥中检查：${name}` : `API key unavailable; review it under Map Keys: ${name}`;
  }
  if (reason.startsWith('api_key_expired:')) {
    const provider = reason.slice('api_key_expired:'.length);
    const name = provider === 'onemap' ? 'ONEMAP_ACCESS_TOKEN' : provider;
    return locale.startsWith('zh') ? `API Key 已过期，请在地图密钥中更新：${name}` : `API key expired; update it under Map Keys: ${name}`;
  }
  if (reason.startsWith('credential_import_pending:')) {
    const provider = reason.split(':')[1] || '';
    const name = provider === 'geoapify' ? 'GEOAPIFY_API_KEY' : provider === 'mappls' ? 'MAPPLS_API_KEY' : provider;
    return locale.startsWith('zh') ? `正在导入环境变量中的 API Key：${name}` : `Importing API key from the environment: ${name}`;
  }
  if (reason.startsWith('missing_source_configuration:')) {
    const name = reason.slice('missing_source_configuration:'.length);
    return locale.startsWith('zh') ? `缺少数据源配置：${name}` : `Missing source configuration: ${name}`;
  }
  return reason;
};

function SyncQueuePanel({ initialData, locale, request }: { initialData: SyncQueueData; locale: AdminLocale; request: RequestData }) {
  const text = addressDataText[locale];
  const ruleText = syncQueueRuleText[locale];
  const t = adminText[locale];
  const [data, setData] = useState<SyncQueueData | null>(initialData);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      try {
        const value = await request<SyncQueueData>('/sync/queue', { signal: controller.signal });
        if (!controller.signal.aborted) { setData(value); setFailed(false); }
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
      if (!controller.signal.aborted) timer = window.setTimeout(() => void poll(), 10_000);
    };
    timer = window.setTimeout(() => void poll(), 10_000);
    return () => { controller.abort(); if (timer) window.clearTimeout(timer); };
  }, [request]);
  const entries = data?.entries || [];
  const visible = [...entries].sort((left, right) =>
    (Number(left.countryCode !== 'CN') - Number(right.countryCode !== 'CN'))
    || (queueStateRank[left.state] - queueStateRank[right.state])
    || ((left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER))
    || left.countryCode.localeCompare(right.countryCode));
  const doneCount = entries.filter((entry) => entry.state === 'done').length;
  const stateLabel = (entry: SyncQueueEntry): string => {
    if (entry.state === 'queued') return text.queueQueued;
    const extras = queueExtraStateText(locale);
    if (entry.state in extras) return extras[entry.state as keyof typeof extras];
    return text.states[entry.state as keyof typeof text.states] || entry.state;
  };
  const rulesFor = (entry: SyncQueueEntry): SyncQueueRules => {
    if (entry.rules) return entry.rules;
    const administrativeCoverageMet = !entry.unmetRules?.some((rule) => ['coverage', 'administrative_coverage'].includes(rule));
    const regionalMinimumsMet = !entry.unmetRules?.some((rule) => ['coverage', 'node_overrides', 'regional_minimums'].includes(rule));
    return {
      total: { current: entry.current, target: entry.target, met: entry.current >= entry.target },
      administrativeCoverage: { actual: administrativeCoverageMet ? 1 : 0, target: 1, met: administrativeCoverageMet, covered: 0, total: 0 },
      regionalMinimums: {
        actual: regionalMinimumsMet ? 1 : 0, target: 1, met: regionalMinimumsMet,
        lowest: null, level1: null, level2: null, overrides: { satisfied: 0, total: 0, met: true }
      }
    };
  };
  const unmetLabels = (entry: SyncQueueEntry): string[] => {
    const rules = rulesFor(entry);
    return [
      !rules.total.met ? ruleText.total : '',
      !rules.administrativeCoverage.met ? ruleText.coverage : '',
      !rules.regionalMinimums.met ? ruleText.minimums : ''
    ].filter(Boolean);
  };
  const etaNote = (entry: SyncQueueEntry): string => {
    if (!entry.eta) return '';
    const median = Math.max(1, Math.ceil((entry.eta.remainingMedianMs ?? entry.eta.medianMs) / 60_000));
    const p80 = Math.max(median, Math.ceil((entry.eta.remainingP80Ms ?? entry.eta.p80Ms) / 60_000));
    const prefix = locale.startsWith('zh') ? '预计' : 'ETA';
    return `${prefix} P50 ${median}m · P80 ${p80}m · n=${entry.eta.sampleCount}`;
  };
  const note = (entry: SyncQueueEntry): string => {
    if (entry.state === 'running') return [entry.jobPhase || data?.job?.phase || '', etaNote(entry)].filter(Boolean).join(' · ');
    if (entry.state === 'queued') {
      const parts: string[] = [];
      if (entry.position) parts.push(`#${entry.position}`);
      if (entry.deficit > 0) parts.push(interpolate(text.deficitChip, { count: entry.deficit.toLocaleString(locale) }));
      const unmet = unmetLabels(entry);
      if (unmet.length) parts.push(`${ruleText.unmetPrefix}: ${unmet.join(locale.startsWith('zh') ? '、' : ', ')}`);
      if (entry.nextAttemptAt) parts.push(interpolate(text.queueResetIn, { time: remainingTime(entry.nextAttemptAt) }));
      if (entry.eta) parts.push(etaNote(entry));
      return parts.join(' · ');
    }
    if (entry.state === 'quota_wait') {
      return [queueReasonText(entry.reason, locale), entry.nextAttemptAt ? interpolate(text.queueResetIn, { time: remainingTime(entry.nextAttemptAt) }) : '']
        .filter(Boolean).join(' · ');
    }
    if (['retry_wait', 'cooldown_wait', 'scheduled_wait'].includes(entry.state)) {
      const retry = entry.nextAttemptAt ? `${remainingTime(entry.nextAttemptAt)} ${locale.startsWith('zh') ? '后重试' : 'until retry'}` : '';
      return [queueReasonText(entry.reason, locale), retry].filter(Boolean).join(' · ');
    }
    return queueReasonText(entry.reason, locale);
  };
  return <section className="admin-panel sync-queue-panel">
    <header><h2>{text.queueTitle}</h2>{data && <small>{dateTime(data.generatedAt, locale)}</small>}</header>
    {(failed || (data && !data.available)) && <p className="queue-unavailable">{text.queueUnavailable}</p>}
    {!data && !failed && <div className="admin-loading" role="status"><span className="loading-dot" />{t.loading}</div>}
    {data && data.job && !visible.some((entry) => entry.state === 'running')
      && <p className="queue-job-note">{text.states.running} · {data.job.id} · {data.job.phase}</p>}
    {data && (visible.length ? <div className="table-scroll"><table>
      <thead><tr><th>{text.status}</th><th>{text.country}</th><th>{ruleText.total}</th><th>{ruleText.coverage}</th><th>{ruleText.minimums}</th><th>{text.lastError}</th></tr></thead>
      <tbody>{visible.map((entry) => {
        const name = isCountryCode(entry.countryCode)
          ? localizedCountryName(entry.countryCode, locale, entry.countryCode)
          : entry.countryCode;
        const rules = rulesFor(entry);
        const minimumLevels = ([
          [ruleText.lowest, rules.regionalMinimums.lowest],
          [ruleText.level1, rules.regionalMinimums.level1],
          [ruleText.level2, rules.regionalMinimums.level2]
        ] as Array<[string, SyncQueueGoalLevel | null]>).filter((value): value is [string, SyncQueueGoalLevel] => Boolean(value[1]));
        return <tr key={entry.countryCode} className={`queue-row ${entry.state}`} data-country={entry.countryCode}>
          <td><span className={`badge address-data-status ${queueBadgeClass[entry.state]}`}>{stateLabel(entry)}</span></td>
          <td><span className="country-cell">{isCountryCode(entry.countryCode) && <img className="country-flag" src={`https://flagcdn.com/24x18/${entry.countryCode.toLowerCase()}.png`} width="24" height="18" alt="" loading="lazy" />}<span className="country-cell-name"><strong>{name}</strong><small className="country-code">{entry.countryCode}</small></span></span></td>
          <td><div className="queue-rule-cell"><div><strong>{rules.total.current.toLocaleString(locale)} / {rules.total.target.toLocaleString(locale)}</strong><span className={`badge target-state ${rules.total.met ? 'met' : 'below_target'}`}>{rules.total.met ? ruleText.met : ruleText.unmet}</span></div></div></td>
          <td><div className="queue-rule-cell"><div><strong>{Math.round(rules.administrativeCoverage.actual * 100)}% / {Math.round(rules.administrativeCoverage.target * 100)}%</strong><span className={`badge target-state ${rules.administrativeCoverage.met ? 'met' : 'below_target'}`}>{rules.administrativeCoverage.met ? ruleText.met : ruleText.unmet}</span></div><small>{rules.administrativeCoverage.covered.toLocaleString(locale)} / {rules.administrativeCoverage.total.toLocaleString(locale)}</small></div></td>
          <td><div className="queue-rule-cell queue-minimum-cell"><div><strong>{Math.round(rules.regionalMinimums.actual * 100)}% / {Math.round(rules.regionalMinimums.target * 100)}%</strong><span className={`badge target-state ${rules.regionalMinimums.met ? 'met' : 'below_target'}`}>{rules.regionalMinimums.met ? ruleText.met : ruleText.unmet}</span></div>{minimumLevels.map(([label, level]) => <small key={label}>{label}: {level.qualified.toLocaleString(locale)} / {level.total.toLocaleString(locale)} · ≥{level.minimum.toLocaleString(locale)}</small>)}{rules.regionalMinimums.overrides.total > 0 && <small>{ruleText.overrides}: {rules.regionalMinimums.overrides.satisfied.toLocaleString(locale)} / {rules.regionalMinimums.overrides.total.toLocaleString(locale)}</small>}</div></td>
          <td>{note(entry)}</td>
        </tr>;
      })}</tbody>
    </table></div> : <p className="admin-empty">{text.queueEmpty}</p>)}
    {data && doneCount > 0 && <small className="queue-done-note">{interpolate(text.queueAtTarget, { count: doneCount })}</small>}
  </section>;
}

const syncHistoryStatusClass = (status: string): string => {
  if (status === 'succeeded') return 'ready';
  if (status === 'running') return 'running';
  if (status === 'cancelled') return 'source_limited';
  if (['queued', 'paused_quota'].includes(status)) return 'quota_wait';
  if (status === 'needs_review') return 'below_target';
  return 'failed';
};

const durationLabel = (startedAt: string | null, completedAt: string | null, locale: AdminLocale): string => {
  if (!startedAt) return '-';
  const started = Date.parse(startedAt);
  const ended = completedAt ? Date.parse(completedAt) : Date.now();
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return '-';
  const seconds = Math.max(0, Math.round((ended - started) / 1000));
  if (seconds < 60) return locale.startsWith('zh') ? `${seconds} 秒` : `${seconds}s`;
  const minutes = Math.floor(seconds / 60); const rest = seconds % 60;
  if (minutes < 60) return locale.startsWith('zh') ? `${minutes} 分 ${rest} 秒` : `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60); const remainingMinutes = minutes % 60;
  return locale.startsWith('zh') ? `${hours} 小时 ${remainingMinutes} 分` : `${hours}h ${remainingMinutes}m`;
};

const finiteGoalValue = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export const syncHistoryGoalChange = (item: SyncHistoryItem, locale: AdminLocale): string => {
  const before = item.beforeGoals; const after = item.afterGoals;
  if (!before || !after) return '';
  const text = syncHistoryText[locale];
  const changes: string[] = [];
  const beforeCovered = finiteGoalValue(before.administrativeCoverage?.covered);
  const afterCovered = finiteGoalValue(after.administrativeCoverage?.covered);
  if (beforeCovered !== null && afterCovered !== null) {
    const covered = afterCovered - beforeCovered;
    if (covered) changes.push(`${text.coveredNodes} ${covered > 0 ? '+' : ''}${covered}`);
  }
  const beforeQualified = finiteGoalValue(before.regionalMinimums?.lowest?.qualified);
  const afterQualified = finiteGoalValue(after.regionalMinimums?.lowest?.qualified);
  if (beforeQualified !== null && afterQualified !== null) {
    const qualified = afterQualified - beforeQualified;
    if (qualified) changes.push(`${text.qualifiedNodes} ${qualified > 0 ? '+' : ''}${qualified}`);
  }
  return changes.join(' · ');
};

export const syncHistoryResultDetail = (item: SyncHistoryItem, locale: AdminLocale): string => {
  if (item.errorMessage || item.errorCode) return [item.failurePhase, item.errorMessage || item.errorCode].filter(Boolean).join(' · ');
  const text = syncHistoryText[locale];
  const parts: string[] = [];
  if (item.candidateCount !== null && item.candidateCount !== undefined) parts.push(`${text.candidates} ${item.candidateCount.toLocaleString(locale)}`);
  if (item.acceptedCount !== null && item.acceptedCount !== undefined) parts.push(`${text.qualityPassed} ${item.acceptedCount.toLocaleString(locale)}`);
  if (item.rejectedCount !== null && item.rejectedCount !== undefined) parts.push(`${text.rejected} ${item.rejectedCount.toLocaleString(locale)}`);
  const goals = syncHistoryGoalChange(item, locale); if (goals) parts.push(goals);
  return parts.join(' · ');
};

function SyncHistoryPanel({ initialData, locale, request }: { initialData: SyncHistoryData; locale: AdminLocale; request: RequestData }) {
  const text = syncHistoryText[locale];
  const [data, setData] = useState<SyncHistoryData>(initialData);
  const [country, setCountry] = useState('');
  const [offset, setOffset] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setData(initialData); setOffset(0);
  }, [initialData]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      try {
        const params = new URLSearchParams({ limit: String(data.limit || 100), offset: String(offset) });
        if (country) params.set('country', country);
        const query = `?${params.toString()}`;
        const value = await request<SyncHistoryData>(`/sync/history${query}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setData(value); setFailed(false); }
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
      if (!controller.signal.aborted) timer = window.setTimeout(() => void poll(), 15_000);
    };
    void poll();
    return () => { controller.abort(); if (timer) window.clearTimeout(timer); };
  }, [country, data.limit, offset, request]);
  const countries = [...new Set([
    ...(initialData.countries || []), ...(data.countries || []),
    ...data.items.map((item) => item.countryCode).filter((value): value is string => Boolean(value))
  ])].sort();
  const statusLabel = (status: string): string => text[status as keyof typeof text] || status;
  return <section className="admin-panel sync-history-panel">
    <header><h2>{text.title}</h2><div className="sync-history-toolbar">
      <label><span className="sr-only">{text.country}</span><select value={country} onChange={(event) => { setCountry(event.target.value); setOffset(0); }}>
        <option value="">{text.allCountries}</option>{countries.map((code) => <option key={code} value={code}>{isCountryCode(code) ? localizedCountryName(code, locale, code) : code}</option>)}
      </select></label>
    </div></header>
    <div className="sync-history-summary"><span className={`badge address-data-status ${data.scheduler?.active_run_id ? 'running' : 'ready'}`}>{data.scheduler?.active_run_id ? text.schedulerActive : text.schedulerIdle}</span><span>{text.lastHeartbeat}: {dateTime(data.scheduler?.heartbeat_at, locale)}</span>{failed && <span className="queue-unavailable">{addressDataText[locale].queueUnavailable}</span>}</div>
    {data.items.length ? <div className="table-scroll"><table className="sync-history-table"><thead><tr><th>{text.status}</th><th>{text.country}</th><th>{text.source}</th><th>{text.period}</th><th>{text.duration}</th><th>{text.growth}</th><th>{text.details}</th></tr></thead><tbody>{data.items.map((item, index) => {
      const name = item.countryCode && isCountryCode(item.countryCode) ? localizedCountryName(item.countryCode, locale, item.countryCode) : item.countryCode || '-';
      const ended = item.completedAt || new Date().toISOString();
      return <tr key={`${item.id}-${item.countryCode || ''}-${item.sourceId}-${index}`}>
        <td><span className={`badge address-data-status ${syncHistoryStatusClass(item.status)}`}>{statusLabel(item.status)}</span></td>
        <td><span className="country-cell-name"><strong>{name}</strong>{item.countryCode && <small className="country-code">{item.countryCode}</small>}</span></td>
        <td>{item.sourceId || (item.kind.startsWith('china') ? 'China map providers' : '-')}</td>
        <td><span className="history-period">{dateTime(item.startedAt || item.createdAt, locale)}<b>→</b>{dateTime(ended, locale)}</span></td>
        <td>{durationLabel(item.startedAt, item.completedAt, locale)}</td>
        <td className={(item.netGrowth || 0) > 0 ? 'history-growth-positive' : ''}>{item.netGrowth === null ? '-' : <>{item.netGrowth > 0 ? '+' : ''}{item.netGrowth.toLocaleString(locale)}</>}</td>
        <td title={syncHistoryResultDetail(item, locale)}>{syncHistoryResultDetail(item, locale) || '-'}</td>
      </tr>;
    })}</tbody></table></div> : <p className="admin-empty">{text.empty}</p>}
    {(offset > 0 || data.hasMore) && <footer className="sync-history-pagination">
      <button type="button" className="icon-button" title={text.previous} aria-label={text.previous} disabled={offset <= 0} onClick={() => setOffset(Math.max(0, offset - (data.limit || 100)))}><ChevronLeft size={16} /></button>
      <span>{Math.floor(offset / (data.limit || 100)) + 1}</span>
      <button type="button" className="icon-button" title={text.next} aria-label={text.next} disabled={!data.hasMore} onClick={() => setOffset(data.nextOffset ?? offset + (data.limit || 100))}><ChevronRight size={16} /></button>
    </footer>}
  </section>;
}

function CountryShortcutSettings({ values, locale, busy, mutate, request }: {
  values: AdminCountryShortcutConfig[]; locale: AdminLocale; busy: boolean; mutate: Mutate; request: RequestData;
}) {
  const text = shortcutText(locale);
  const sorted = values.slice().sort((left, right) => {
    const leftName = isCountryCode(left.countryCode) ? localizedCountryName(left.countryCode, locale, left.countryCode) : left.countryCode;
    const rightName = isCountryCode(right.countryCode) ? localizedCountryName(right.countryCode, locale, right.countryCode) : right.countryCode;
    return leftName.localeCompare(rightName, locale);
  });
  const initialCode = sorted.some((value) => value.countryCode === 'US') ? 'US' : sorted[0]?.countryCode || '';
  const [selectedCode, setSelectedCode] = useState<string>(initialCode);
  const selected = sorted.find((value) => value.countryCode === selectedCode) || sorted[0];
  useEffect(() => {
    if (!sorted.some((value) => value.countryCode === selectedCode)) setSelectedCode(initialCode);
  }, [initialCode, selectedCode, sorted]);
  if (!selected) return <div className="admin-empty">{text.defaults}</div>;
  return <section className="shortcut-settings-page">
    <header className="shortcut-settings-heading">
      <label><span>{text.country}</span><select value={selected.countryCode} onChange={(event) => setSelectedCode(event.target.value)}>
        {sorted.map((value) => <option key={value.countryCode} value={value.countryCode}>{isCountryCode(value.countryCode) ? localizedCountryName(value.countryCode, locale, value.countryCode) : value.countryCode}</option>)}
      </select></label>
    </header>
    <CountryShortcutEditor key={selected.countryCode} value={selected} locale={locale} busy={busy} mutate={mutate} request={request} />
  </section>;
}

type ShortcutListKey = 'adminShortcuts' | 'popularCities' | 'specialAreas';
type ShortcutCatalogField = 'region' | 'city' | 'postcode';
interface ShortcutOptionPage { options: LocationOption[]; total: number; nextCursor?: string }

const shortcutLabel = (item: LocationShortcut, locale: AdminLocale): string =>
  usesChineseSource(locale) ? item.label['zh-CN'] || item.label.en : item.label.en || item.label['zh-CN'];

const shortcutOptionLabel = (item: LocationOption, locale: AdminLocale): string => usesChineseSource(locale)
  ? item.zhCN || item.native || item.en || item.value
  : item.en || item.value || item.label;

function ShortcutPicker({ countryCode, field, items, locale, request, add }: {
  countryCode: string; field: ShortcutCatalogField; items: LocationShortcut[];
  locale: AdminLocale; request: RequestData; add: (item: LocationShortcut) => void;
}) {
  const text = shortcutText(locale);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<LocationOption[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState('');
  const [previous, setPrevious] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [retry, setRetry] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setOptions([]); setActiveIndex(-1);
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ field, q: query, cursor });
      void request<ShortcutOptionPage>(`/settings/country-shortcuts/${countryCode}/options?${params}`, { signal: controller.signal })
        .then((value) => {
          if (controller.signal.aborted) return;
          setOptions((value.options || []).filter((option) => option.availableCount !== 0));
          setTotal(value.total || 0); setNextCursor(value.nextCursor);
        })
        .catch((error) => { if (!controller.signal.aborted) setError(errorMessage(error, locale)); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [countryCode, field, open, query, cursor, retry, request, locale]);
  useEffect(() => { setCursor(''); setPrevious([]); setNextCursor(undefined); }, [countryCode, field]);
  useEffect(() => {
    if (open && activeIndex >= 0) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [id, open, activeIndex]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const selected = new Set(items.map((item) => `${item.type}:${item.value.toLocaleLowerCase()}`));
  const unavailable = (option: LocationOption) => Boolean(option.disabled || selected.has(`${field}:${(field === 'region' && option.regionCode ? option.regionCode : option.value).toLocaleLowerCase()}`));
  const choose = (option: LocationOption) => {
    const type: LocationShortcut['type'] = field;
    const value = field === 'region' && option.regionCode ? option.regionCode : option.value;
    if (selected.has(`${type}:${value.toLocaleLowerCase()}`)) return;
    add({
      label: { en: option.en || option.value, 'zh-CN': option.zhCN || option.native || option.en || option.value },
      value,
      type
    });
    setQuery('');
    setCursor(''); setPrevious([]);
    setOpen(false);
  };
  const keyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return; }
    if (event.key === 'Enter' && open) { event.preventDefault(); if (options[activeIndex] && !unavailable(options[activeIndex])) choose(options[activeIndex]); return; }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault(); setOpen(true);
    for (let index = activeIndex + (event.key === 'ArrowDown' ? 1 : -1); index >= 0 && index < options.length; index += event.key === 'ArrowDown' ? 1 : -1) {
      if (!unavailable(options[index])) { setActiveIndex(index); break; }
    }
  };
  return <div className="shortcut-picker" ref={root} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <div className={`shortcut-picker-control ${open ? 'open' : ''}`}>
      <Search size={15} aria-hidden="true" />
      <input role="combobox" aria-label={text.choose} aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list"
        aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
        placeholder={text.choose} value={query} onFocus={() => setOpen(true)} onKeyDown={keyDown}
        onChange={(event) => { setQuery(event.target.value); setCursor(''); setPrevious([]); setOpen(true); }} />
      <button type="button" aria-label={text.choose} aria-expanded={open} onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen((value) => !value)}><ChevronDown size={15} /></button>
    </div>
    {open && <div className="shortcut-picker-popup">
      <div className="shortcut-picker-options" id={`${id}-list`} role="listbox" aria-label={text.choose} aria-busy={loading}>
      {options.map((option, index) => {
        const disabled = unavailable(option);
        return <button id={`${id}-option-${index}`} type="button" role="option" tabIndex={-1} aria-selected={disabled} disabled={disabled}
          className={activeIndex === index ? 'active' : ''} key={option.id || option.value} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(option)}>
          <span>{shortcutOptionLabel(option, locale)}</span>
          {option.availableCount !== undefined && <small>{interpolate(text.available, { count: option.availableCount.toLocaleString(locale) })}</small>}
        </button>;
      })}</div>
      {loading ? <p role="status">{text.loading}</p> : error ? <div className="shortcut-picker-error" role="alert"><span>{error}</span>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => setRetry((value) => value + 1)}>{adminText[locale].retry}</button>
      </div> : !options.length && <p>{text.noOptions}</p>}
      <div className="shortcut-picker-status"><span>{options.length ? `${Number(cursor) + 1}–${Number(cursor) + options.length}` : 0} / {total.toLocaleString(locale)}</span>
        {previous.length > 0 && <button type="button" disabled={loading} onMouseDown={(event) => event.preventDefault()} onClick={() => {
          setCursor(previous[previous.length - 1]); setPrevious((values) => values.slice(0, -1));
        }}>{syncHistoryText[locale].previous}</button>}
        {nextCursor && !error && <button type="button" disabled={loading} onMouseDown={(event) => event.preventDefault()} onClick={() => {
          setPrevious((values) => [...values, cursor]); setCursor(nextCursor);
        }}>{syncHistoryText[locale].next}</button>}
      </div>
    </div>}
  </div>;
}

function CountryShortcutEditor({ value, locale, busy, mutate, request }: {
  value: AdminCountryShortcutConfig; locale: AdminLocale; busy: boolean; mutate: Mutate; request: RequestData;
}) {
  const text = shortcutText(locale);
  const editable = (source: AdminCountryShortcutConfig): CountryShortcutConfig => ({
    countryCode: source.countryCode,
    popularCities: structuredClone(source.popularCities),
    adminShortcuts: structuredClone(source.adminShortcuts),
    specialAreaTitle: { ...source.specialAreaTitle },
    specialAreas: structuredClone(source.specialAreas)
  });
  const [draft, setDraft] = useState<CountryShortcutConfig>(() => editable(value));
  const serverDraft = useRef(JSON.stringify(editable(value)));
  const [specialType, setSpecialType] = useState<ShortcutCatalogField>(() => {
    const type = value.specialAreas[0]?.type;
    return type === 'city' || type === 'postcode' ? type : 'region';
  });
  useEffect(() => {
    const previous = serverDraft.current;
    serverDraft.current = JSON.stringify(editable(value));
    setDraft((current) => current.countryCode !== value.countryCode || JSON.stringify(current) === previous ? editable(value) : current);
  }, [value]);
  const addItem = (section: ShortcutListKey, item: LocationShortcut) => setDraft((current) => ({ ...current, [section]: [...current[section], item] }));
  const removeItem = (section: ShortcutListKey, index: number) => {
    setDraft((current) => ({ ...current, [section]: current[section].filter((_, itemIndex) => itemIndex !== index) }));
  };
  const moveItem = (section: ShortcutListKey, index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= draft[section].length) return;
    setDraft((current) => {
      const items = [...current[section]];
      [items[index], items[target]] = [items[target], items[index]];
      return { ...current, [section]: items };
    });
  };
  const renderList = (section: ShortcutListKey, title: string, field: ShortcutCatalogField) => <section className="shortcut-editor-section">
    <header><h3>{title}</h3><span>{interpolate(text.selected, { count: draft[section].length })}</span></header>
    <ShortcutPicker countryCode={value.countryCode} field={field} items={draft[section]} locale={locale} request={request} add={(item) => addItem(section, item)} />
    <div className="shortcut-editor-list">{draft[section].map((item, index) => <div className="shortcut-editor-row" key={`${section}-${index}`}>
      <strong>{shortcutLabel(item, locale)}</strong>
      <span className="shortcut-row-actions">
        <button type="button" className="icon-action" title={text.moveUp} aria-label={text.moveUp} disabled={index === 0} onClick={() => moveItem(section, index, -1)}><ArrowUp size={14} /></button>
        <button type="button" className="icon-action" title={text.moveDown} aria-label={text.moveDown} disabled={index === draft[section].length - 1} onClick={() => moveItem(section, index, 1)}><ArrowDown size={14} /></button>
        <button type="button" className="icon-action danger-control" title={text.remove} aria-label={text.remove} onClick={() => removeItem(section, index)}><Trash2 size={14} /></button>
      </span>
    </div>)}</div>
  </section>;
  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitted = JSON.stringify(draft);
    const result = await mutate<AdminCountryShortcutConfig>(`/settings/country-shortcuts/${value.countryCode}`, 'PUT', draft, text.saved);
    if (result) setDraft((current) => JSON.stringify(current) === submitted ? editable(result) : current);
  };
  const reset = async () => {
    if (!window.confirm(text.confirmReset)) return;
    const result = await mutate<AdminCountryShortcutConfig>(`/settings/country-shortcuts/${value.countryCode}`, 'DELETE', undefined, text.resetDone);
    if (result) setDraft(editable(result));
  };
  return <form className="shortcut-editor" onSubmit={save}>
    <div className="shortcut-editor-toolbar">
      <div className="shortcut-editor-status"><strong>{isCountryCode(value.countryCode) ? localizedCountryName(value.countryCode, locale, value.countryCode) : value.countryCode}</strong><span className={`badge ${value.customized ? 'customized' : ''}`}>{value.customized ? text.customized : text.defaults}</span></div>
      <div className="shortcut-editor-actions"><button type="button" className="secondary-action" disabled={busy || !value.customized} onClick={() => void reset()}><RotateCcw size={15} />{text.reset}</button><button className="primary-action" disabled={busy}><Save size={15} />{text.save}</button></div>
    </div>
    <section className="shortcut-editor-section special-title-editor"><header><h3>{text.specialTitle}</h3></header><div>
      <input required aria-label={text.specialTitle} value={usesChineseSource(locale) ? draft.specialAreaTitle['zh-CN'] : draft.specialAreaTitle.en} onChange={(event) => setDraft((current) => ({ ...current, specialAreaTitle: { ...current.specialAreaTitle, [usesChineseSource(locale) ? 'zh-CN' : 'en']: event.target.value } }))} />
    </div></section>
    {renderList('adminShortcuts', text.adminAreas, 'region')}
    {renderList('popularCities', text.cities, 'city')}
    <section className="shortcut-special-type"><label><span>{text.type}</span><select value={specialType} onChange={(event) => setSpecialType(event.target.value as ShortcutCatalogField)}><option value="region">{text.region}</option><option value="city">{text.city}</option><option value="postcode">{text.postcode}</option></select></label></section>
    {renderList('specialAreas', text.specialAreas, specialType)}
  </form>;
}

function AddressDataSettings({ values, locale, busy, mutate, request }: {
  values: AddressDataCountry[]; locale: AdminLocale; busy: boolean; mutate: Mutate; request: RequestData;
}) {
  const text = addressDataText[locale];
  const [selectedCode, setSelectedCode] = useState('');
  const selected = values.find((country) => country.countryCode === selectedCode);
  const stateLabel = (status: string) => text.states[status] || status;
  return <section className="address-data-page">
    <div className="table-scroll address-data-table"><table><thead><tr><th>{text.country}</th><th>{text.current}</th><th>{text.target}</th><th>{text.coverage}</th><th>{text.sources}</th><th>{text.status}</th><th>{text.nextRun}</th><th><span className="sr-only">{text.details}</span></th></tr></thead><tbody>{values.map((country) => {
      const name = isCountryCode(country.countryCode)
        ? localizedCountryName(country.countryCode, locale, country.countryCode)
        : country.countryCode;
      const coverage = country.lowestCoverage;
      const targetStateLabel = country.targetState === 'met' ? text.targetMet
        : country.targetState === 'source_limited' ? text.states.source_limited : text.states.below_target;
      const ratioParts: string[] = [];
      if (country.coverageLowestRatio !== null) ratioParts.push(`${text.lowestShort} ${Math.round(country.coverageLowestRatio * 100)}%`);
      if (country.coverageLevel1Ratio !== null) ratioParts.push(`${text.level1Short} ${Math.round(country.coverageLevel1Ratio * 100)}%`);
      if (country.coverageLevel2Ratio !== null) ratioParts.push(`${text.level2Short} ${Math.round(country.coverageLevel2Ratio * 100)}%`);
      return <tr key={country.countryCode}>
        <td><span className="country-cell">{isCountryCode(country.countryCode) && <img className="country-flag" src={`https://flagcdn.com/24x18/${country.countryCode.toLowerCase()}.png`} width="24" height="18" alt="" loading="lazy" />}<span className="country-cell-name"><strong>{name}</strong><small className="country-code">{country.countryCode}</small></span></span></td>
        <td className="numeric-cell"><div className="count-progress"><strong>{country.currentCount.toLocaleString(locale)}</strong><span className="progress-track" aria-hidden="true"><i style={{ width: `${usagePercent(country.currentCount, country.targetCount)}%` }} /></span></div></td>
        <td className="numeric-cell">{country.targetCount.toLocaleString(locale)}</td>
        <td><div className="coverage-cell" title={`${text.coverageGoal} ${Math.round(country.coverageRatio * 100)}%${coverage ? ` · ${coverage.qualified.toLocaleString(locale)} / ${coverage.total.toLocaleString(locale)} ${text.qualified}` : ''}`}>
          <div className="coverage-cell-head"><span className={`badge target-state ${country.targetState}`}>{targetStateLabel}</span><strong>{Math.round(country.coverageActual * 100)}%</strong></div>
          <span className="progress-track coverage-progress" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.round(country.coverageActual * 100))}%` }} /><b style={{ left: `calc(${Math.min(100, Math.round(country.coverageRatio * 100))}% - 1px)` }} /></span>
          {ratioParts.length > 0 && <small>{ratioParts.join(' · ')}</small>}
          {country.pruneCandidates > 0 && <small className="prune-hint">{interpolate(text.prunable, { count: country.pruneCandidates.toLocaleString(locale) })}</small>}
        </div></td>
        <td><span className="source-summary">{country.sources.length ? country.sources.slice(0, 2).map((source) => source.name).join(', ') : text.noSources}{country.sources.length > 2 ? ` +${country.sources.length - 2}` : ''}</span></td>
        <td><span className={`badge address-data-status ${country.status}`}>{stateLabel(country.status)}</span></td>
        <td>{country.nextAttemptAt ? dateTime(country.nextAttemptAt, locale) : country.status === 'ready' || country.status === 'disabled' || country.status === 'source_limited' ? '-' : text.unlimitedWait}</td>
        <td className="row-actions"><button type="button" onClick={() => setSelectedCode(country.countryCode)}>{text.details}</button></td>
      </tr>;
    })}</tbody></table></div>
    {selected && <AddressDataDialog value={selected} locale={locale} busy={busy} mutate={mutate} request={request} close={() => setSelectedCode('')} />}
  </section>;
}

function AddressDataDialog({ value, locale, busy, mutate, request, close }: {
  value: AddressDataCountry; locale: AdminLocale; busy: boolean; mutate: Mutate; request: RequestData; close: () => void;
}) {
  const text = addressDataText[locale];
  const [enabled, setEnabled] = useState(value.enabled);
  const [target, setTarget] = useState(String(value.targetCount));
  const [minPerNode, setMinPerNode] = useState(String(value.minPerNode));
  const [coveragePercent, setCoveragePercent] = useState(String(Math.round(value.coverageRatio * 100)));
  const [level1Min, setLevel1Min] = useState(String(value.level1Min));
  const [level2Min, setLevel2Min] = useState(String(value.level2Min));
  const [policyError, setPolicyError] = useState('');
  const [saving, setSaving] = useState(false);
  const countryName = isCountryCode(value.countryCode)
    ? localizedCountryName(value.countryCode, locale, value.countryCode)
    : value.countryCode;
  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPolicyError(''); setSaving(true);
    try {
      await request(`/sync/policies/countries/${value.countryCode}`, { method: 'PUT', body: JSON.stringify({
        enabled, targetCount: Number(target),
        level1Limit: value.levelLimits[0], level2Limit: value.levelLimits[1],
        level3Limit: value.levelLimits[2], level4Limit: value.levelLimits[3],
        minPerNode: Number(minPerNode), coverageRatio: Number(coveragePercent) / 100,
        level1Min: Number(level1Min), level2Min: Number(level2Min)
      }) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setPolicyError(text.policyErrors[detail] || detail);
      setSaving(false);
      return;
    }
    setSaving(false);
    await mutate('/address-data', 'GET', undefined, text.saved);
    close();
  };
  const sync = async () => {
    const result = await mutate(`/address-data/${value.countryCode}/sync`, 'POST', undefined, text.syncStarted);
    if (result) close();
  };
  return <Dialog title={`${countryName} · ${text.details}`} close={close} locale={locale} className="address-data-dialog">
    <form className="dialog-form address-data-form" onSubmit={save}>
      <div className="address-data-summary"><div><span>{text.current}</span><strong>{value.currentCount.toLocaleString(locale)}</strong></div><div><span>{text.lastSuccess}</span><strong>{dateTime(value.lastSuccessfulAt, locale)}</strong></div></div>
      <div className="policy-grid">
        <label><span>{text.target}</span><input name="targetCount" type="number" min="1" max="2000000" required value={target} onChange={(event) => setTarget(event.target.value)} /></label>
        <label><span>{text.minPerNodeLabel}</span><input name="minPerNode" type="number" min="1" max="100" required value={minPerNode} onChange={(event) => setMinPerNode(event.target.value)} /></label>
        <label><span>{text.coverageGoal}</span><div className="percent-input"><input name="coveragePercent" type="number" min="0" max="100" step="1" required value={coveragePercent} onChange={(event) => setCoveragePercent(event.target.value)} /><b>%</b></div></label>
        <label><span>{text.level1MinLabel}</span><input name="level1Min" type="number" min="0" max="50000" required value={level1Min} onChange={(event) => setLevel1Min(event.target.value)} /></label>
        <label><span>{text.level2MinLabel}</span><input name="level2Min" type="number" min="0" max="50000" required value={level2Min} onChange={(event) => setLevel2Min(event.target.value)} /></label>
      </div>
      <label className="check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />{text.enabled}</label>
      {policyError && <p className="field-error" role="alert">{policyError}</p>}
      <AddressNodeTargets countryCode={value.countryCode} locale={locale} request={request} />
      <section className="address-source-list"><h3>{text.sourceDetails}</h3>{value.sources.length ? value.sources.map((source) => <article key={source.id}>
        <div><a href={source.homepageUrl} target="_blank" rel="noreferrer">{source.name}</a><small>{source.id}</small></div>
        <dl><div><dt>{text.activeRecords}</dt><dd>{source.activeCount.toLocaleString(locale)}</dd></div><div><dt>{text.latestVersion}</dt><dd>{source.latestVersion || '-'}</dd></div><div><dt>{text.lastImport}</dt><dd>{dateTime(source.latestImportedAt, locale)}</dd></div></dl>
      </article>) : <EmptyState icon={Database} text={text.noSources} />}</section>
      {value.lastError && <div className="address-data-message"><strong>{text.lastError}</strong><span>{queueReasonText(value.lastError, locale)}</span></div>}
      {value.countryCode === 'CN' && <section className="china-area-detail"><h3>{adminText[locale].districtCoverage}</h3><ChinaAreaCoverage locale={locale} request={request} /></section>}
      <div className="dialog-actions split-actions"><button type="button" className="secondary-action" disabled={busy || !enabled || value.status === 'running'} onClick={() => void sync()}>{value.status === 'running' ? text.syncing : text.sync}</button><div><button type="button" onClick={close}>{adminText[locale].cancel}</button><button className="primary-action" disabled={busy || saving}>{text.save}</button></div></div>
    </form>
  </Dialog>;
}

function AddressNodeTargets({ countryCode, locale, request }: { countryCode: string; locale: AdminLocale; request: RequestData }) {
  const text = addressDataText[locale];
  const t = adminText[locale];
  const [nodes, setNodes] = useState<AddressNodeTarget[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [panelError, setPanelError] = useState('');
  const [panelNotice, setPanelNotice] = useState('');
  const [levelTab, setLevelTab] = useState(0);
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(100);
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null);
  const [rowBusy, setRowBusy] = useState('');
  const levelName = (level: number): string =>
    coverageLevels[locale][countryCode]?.[level] || coverageLevels[locale].default[level] || `L${level}`;
  const levels = useMemo(() => [...new Set((nodes || []).map((node) => node.level))].sort((left, right) => left - right), [nodes]);
  const query = search.trim().toLocaleLowerCase();
  const filtered = useMemo(() => (nodes || []).filter((node) => node.level === levelTab
    && (!query || node.regionName.toLocaleLowerCase().includes(query) || node.regionCode.toLocaleLowerCase().includes(query))), [nodes, levelTab, query]);
  const visible = filtered.slice(0, visibleCount);
  const loadNodes = async () => {
    setLoading(true); setPanelError('');
    try {
      const result = await request<AddressNodeTarget[]>(`/sync/policies/countries/${countryCode}/nodes`);
      setNodes(result || []);
      const first = [...new Set((result || []).map((node) => node.level))].sort((left, right) => left - right)[0];
      setLevelTab(first ?? 0);
    } catch (error) { setPanelError(errorMessage(error, locale)); }
    finally { setLoading(false); }
  };
  const applyOverride = (key: string, minCount: number | null) => setNodes((current) => (current || []).map((node) => {
    if (node.key !== key) return node;
    const targetCount = minCount ?? node.defaultTarget;
    return { ...node, overrideTarget: minCount, targetCount,
      satisfied: targetCount <= 0 || node.currentCount >= targetCount,
      deficit: Math.max(0, targetCount - node.currentCount),
      excess: minCount === null ? 0 : Math.max(0, node.currentCount - minCount) };
  }));
  const saveOverride = async (node: AddressNodeTarget, rawValue: string) => {
    setRowBusy(node.key); setPanelError(''); setPanelNotice('');
    try {
      await request(`/sync/policies/countries/${countryCode}/nodes/${encodeURIComponent(node.key)}`, {
        method: 'PUT', body: JSON.stringify({ minCount: Number(rawValue) })
      });
      applyOverride(node.key, Number(rawValue));
      setEditing(null); setPanelNotice(text.nodeSaved);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setPanelError(text.policyErrors[detail] || detail);
    } finally { setRowBusy(''); }
  };
  const clearOverride = async (node: AddressNodeTarget) => {
    setRowBusy(node.key); setPanelError(''); setPanelNotice('');
    try {
      await request(`/sync/policies/countries/${countryCode}/nodes/${encodeURIComponent(node.key)}`, { method: 'DELETE' });
      applyOverride(node.key, null);
      setPanelNotice(text.nodeCleared);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setPanelError(text.policyErrors[detail] || detail);
    } finally { setRowBusy(''); }
  };
  if (nodes === null) return <section className="node-targets">
    <h3>{text.nodeTargets}</h3>
    <div><button type="button" className="secondary-action" disabled={loading} onClick={() => void loadNodes()}>{loading ? t.loading : text.loadNodeTargets}</button></div>
    {panelError && <p className="field-error" role="alert">{panelError}</p>}
  </section>;
  return <section className="node-targets">
    <h3>{text.nodeTargets}</h3>
    <div className="node-targets-toolbar">
      <div className="node-level-tabs">{levels.map((level) => <button type="button" key={level} className={level === levelTab ? 'active' : ''} onClick={() => { setLevelTab(level); setVisibleCount(100); setEditing(null); }}>{levelName(level)} · {(nodes || []).filter((node) => node.level === level).length.toLocaleString(locale)}</button>)}</div>
      <label className="node-search"><Search size={13} /><input value={search} onChange={(event) => { setSearch(event.target.value); setVisibleCount(100); }} placeholder={text.searchNode} /></label>
    </div>
    {panelError && <p className="field-error" role="alert">{panelError}</p>}
    {panelNotice && <p className="node-panel-notice" role="status">{panelNotice}</p>}
    <div className="table-scroll node-target-table"><table><thead><tr><th>{t.region}</th><th>{text.current}</th><th>{text.target}</th><th>{t.statusLabel}</th><th>{t.actions}</th></tr></thead><tbody>{visible.map((node) => {
      const isEditing = editing?.key === node.key;
      return <tr key={node.key}>
        <td>{node.regionName}</td>
        <td className="numeric-cell">{node.currentCount.toLocaleString(locale)}</td>
        <td>{isEditing ? <span className="node-inline-edit">
          <input type="number" min="0" max="50000" autoFocus value={editing?.value ?? ''}
            onChange={(event) => setEditing({ key: node.key, value: event.target.value })}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void saveOverride(node, editing?.value ?? ''); } }} />
          <button type="button" className="compact-action" disabled={rowBusy === node.key} onClick={() => void saveOverride(node, editing?.value ?? '')}>{t.save}</button>
          <button type="button" className="compact-action" onClick={() => setEditing(null)}>{t.cancel}</button>
        </span> : <><strong>{node.targetCount.toLocaleString(locale)}</strong><span className={`target-source-tag ${node.overrideTarget === null ? 'default' : 'override'}`}>{node.overrideTarget === null ? text.defaultTag : text.overrideTag}</span></>}</td>
        <td>{node.deficit > 0 ? <span className="node-chip deficit">{interpolate(text.deficitChip, { count: node.deficit.toLocaleString(locale) })}</span>
          : node.excess > 0 ? <span className="node-chip excess">{interpolate(text.excessChip, { count: node.excess.toLocaleString(locale) })}</span>
            : <span className="node-chip met">{text.metChip}</span>}</td>
        <td className="row-actions">
          <button type="button" disabled={rowBusy === node.key || isEditing} onClick={() => setEditing({ key: node.key, value: String(node.targetCount) })}>{t.edit}</button>
          {node.overrideTarget !== null && <button type="button" disabled={rowBusy === node.key} onClick={() => void clearOverride(node)}>{text.clearOverride}</button>}
        </td>
      </tr>;
    })}</tbody></table>{!filtered.length && <p className="admin-empty">{text.noNodes}</p>}</div>
    {filtered.length > visibleCount && <button type="button" className="secondary-action node-load-more" onClick={() => setVisibleCount((count) => count + 100)}>{text.loadMore} ({visible.length.toLocaleString(locale)}/{filtered.length.toLocaleString(locale)})</button>}
  </section>;
}
const TokenTable = ({ values, locale, reveal, edit, revoke }: { values: ApiTokenView[]; locale: AdminLocale; reveal: Reveal; edit: (value: ApiTokenView) => void; revoke: (id: string) => void }) => { const t = adminText[locale]; return <div className="table-scroll"><table><thead><tr><th>{t.name}</th><th>{t.tokenValue}</th><th>{t.scopes}</th><th>{t.perMinute}</th><th>{t.expires}</th><th>{t.actions}</th></tr></thead><tbody>{values.map((item) => <tr key={item.id}><td>{item.name}</td><td>{item.token_revealable ? <SecretCell mask={item.token_mask} locale={locale} reveal={reveal} path={`/tokens/${item.id}/reveal`} field="token" /> : <span className="token-unavailable">{t.tokenUnavailable}</span>}</td><td>{item.scopes.map((scope) => scopeLabel(String(scope), locale)).join(locale === 'zh-CN' ? '、' : ', ')}</td><td>{item.rate_limit_per_minute.toLocaleString()}</td><td>{item.expires_at ? dateTime(item.expires_at, locale) : t.neverExpires}</td><td className="row-actions"><button type="button" disabled={Boolean(item.revoked_at)} onClick={() => edit(item)}>{t.edit}</button><button type="button" className="danger" disabled={Boolean(item.revoked_at)} onClick={() => revoke(item.id)}>{item.revoked_at ? t.revoked : t.revoke}</button></td></tr>)}</tbody></table>{!values.length && <EmptyState icon={Braces} text={t.noTokens} />}</div>; };
