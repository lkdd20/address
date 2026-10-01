import { localeText } from './locale-text';
import { Braces, History, KeyRound, LayoutDashboard, ListOrdered, MapPin, RefreshCw, ShieldBan, ShieldCheck } from 'lucide-react';
import { generatedAdminErrors } from '../../domain/admin-errors.generated';
import { generatedAdminText } from '../../domain/admin-i18n.generated';
import { countryByCode, isCountryCode } from '../../domain/countries';
import { localizedCountryName } from '../../domain/locales';
import type { AdminLocale, CoverageNode, SyncHistoryItem, SyncQueueEntry, View } from './types';

export const baseAdminText = {
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
export type DeepString<T> = T extends string ? string : { [Key in keyof T]: DeepString<T[Key]> };
export type AdminDictionary = DeepString<typeof baseAdminText.en>;
export const adminText = { ...baseAdminText, ...generatedAdminText } as unknown as Record<AdminLocale, AdminDictionary>;
export const addressDataText: Record<AdminLocale, {
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
export const shortcutText = (locale: AdminLocale) => localeText[locale].shortcut;
export const syncHistoryBase = localeText.en.history;
export const syncHistoryText = Object.fromEntries((Object.keys(localeText) as AdminLocale[]).map((locale) => [locale, localeText[locale].history])) as Record<AdminLocale, typeof syncHistoryBase>;
export const labelsFor = (locale: AdminLocale): Record<View, string> => ({
  dashboard: adminText[locale].labels.dashboard,
  blacklist: adminText[locale].labels.blacklist,
  providers: adminText[locale].labels.providers,
  addressData: addressDataText[locale].nav,
  syncHistory: syncHistoryText[locale].nav,
  shortcuts: shortcutText(locale).nav,
  access: adminText[locale].labels.access,
  tokens: adminText[locale].labels.tokens
});
export type NavGroup = 'overview' | 'data' | 'integrations' | 'security';
export const navGroups: Array<{ id: NavGroup; views: View[] }> = [
  { id: 'overview', views: ['dashboard'] },
  { id: 'data', views: ['addressData', 'syncHistory', 'shortcuts', 'blacklist'] },
  { id: 'integrations', views: ['providers'] },
  { id: 'security', views: ['access', 'tokens'] }
];
export const shellText: Record<AdminLocale, Record<NavGroup | 'collapse' | 'expand' | 'menu' | 'refresh', string>> = {
  'zh-CN': { overview: '概览', data: '数据', integrations: '集成', security: '安全', collapse: '收起侧栏', expand: '展开侧栏', menu: '打开菜单', refresh: '刷新' },
  'zh-TW': { overview: '概覽', data: '資料', integrations: '整合', security: '安全', collapse: '收合側欄', expand: '展開側欄', menu: '開啟選單', refresh: '重新整理' },
  en: { overview: 'Overview', data: 'Data', integrations: 'Integrations', security: 'Security', collapse: 'Collapse sidebar', expand: 'Expand sidebar', menu: 'Open menu', refresh: 'Refresh' },
  ja: { overview: '概要', data: 'データ', integrations: '連携', security: 'セキュリティ', collapse: 'サイドバーを折りたたむ', expand: 'サイドバーを展開', menu: 'メニューを開く', refresh: '更新' },
  ko: { overview: '개요', data: '데이터', integrations: '연동', security: '보안', collapse: '사이드바 접기', expand: '사이드바 펼치기', menu: '메뉴 열기', refresh: '새로 고침' },
  de: { overview: 'Übersicht', data: 'Daten', integrations: 'Integrationen', security: 'Sicherheit', collapse: 'Seitenleiste einklappen', expand: 'Seitenleiste ausklappen', menu: 'Menü öffnen', refresh: 'Aktualisieren' },
  fr: { overview: 'Vue d’ensemble', data: 'Données', integrations: 'Intégrations', security: 'Sécurité', collapse: 'Réduire la barre latérale', expand: 'Déployer la barre latérale', menu: 'Ouvrir le menu', refresh: 'Actualiser' },
  es: { overview: 'Resumen', data: 'Datos', integrations: 'Integraciones', security: 'Seguridad', collapse: 'Contraer barra lateral', expand: 'Expandir barra lateral', menu: 'Abrir menú', refresh: 'Actualizar' },
  pt: { overview: 'Visão geral', data: 'Dados', integrations: 'Integrações', security: 'Segurança', collapse: 'Recolher barra lateral', expand: 'Expandir barra lateral', menu: 'Abrir menu', refresh: 'Atualizar' }
};
export const sidebarStorageKey = 'address-admin-sidebar-collapsed';
export const viewIcons = { dashboard: LayoutDashboard, blacklist: ShieldBan, providers: KeyRound, addressData: RefreshCw, syncHistory: History, shortcuts: MapPin, access: ShieldCheck, tokens: Braces } as const;
export const providerLabel = (locale: AdminLocale, provider: string): string => {
  if (provider === 'deepl') return 'DeepL API Free';
  if (locale === 'zh-CN' || locale === 'en') return adminText[locale].providers[provider as keyof typeof adminText['zh-CN']['providers']] || provider;
  if (locale === 'zh-TW') {
    const names: Record<string, string> = { amap: '高德地圖', baidu: '百度地圖', tencent: '騰訊地圖', onemap: 'OneMap', geoapify: 'Geoapify', 'google-geocoding': 'Google Geocoding', mappls: 'Mappls', 'openai-compatible': 'OpenAI 相容介面' };
    return names[provider] || provider;
  }
  return adminText.en.providers[provider as keyof typeof adminText['zh-CN']['providers']] || provider;
};
export const credentialDisplayLabel = (locale: AdminLocale, label: string): string => ({
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
export const interpolate = (value: string, replacements: Record<string, string | number>): string => Object.entries(replacements).reduce((result, [key, replacement]) => result.replace(`{${key}}`, String(replacement)), value);
export const dateTime = (value: unknown, locale: AdminLocale) => value ? new Date(String(value)).toLocaleString(locale, { hour12: false }) : '-';
export const dateInputValue = (value: unknown): string => {
  if (!value) return '';
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
export const generateTokenValue = (): string => {
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
export type AdminErrorCode = keyof typeof baseAdminErrorText.en;
export const adminErrorText = { ...baseAdminErrorText, ...generatedAdminErrors } as unknown as Record<AdminLocale, Record<AdminErrorCode, string>>;
export const errorMessage = (value: unknown, locale: AdminLocale = 'zh-CN'): string => {
  const code = value instanceof Error ? value.message : String(value);
  if (code === 'ADMIN_PASSWORD_CHANGE_REQUIRED') return localeText[locale].ui.passwordChangeRequired;
  const fallback = locale === 'zh-CN' || locale === 'zh-TW' ? baseAdminErrorText['zh-CN'] : baseAdminErrorText.en;
  return adminErrorText[locale][code as AdminErrorCode] || fallback[code as AdminErrorCode] || code;
};
export const coverageLevels: Record<AdminLocale, Record<string, string[]>> = {
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
export const flagSrc = (countryCode: string): string => `/flags/${countryCode.toLowerCase()}.svg`;
export const usesChineseSource = (locale: AdminLocale): boolean => locale === 'zh-CN' || locale === 'zh-TW';
export const coverageLevelName = (node: CoverageNode, locale: AdminLocale): string => {
  const translated = coverageLevels[locale][node.countryCode]?.[node.level] || coverageLevels[locale].default[node.level];
  if (locale === 'en') return node.levelLabelEn || node.levelLabel || translated || adminText[locale].region;
  if (usesChineseSource(locale)) return node.levelLabelZh || translated || node.levelLabel || adminText[locale].region;
  return translated || node.levelLabelEn || node.levelLabel || adminText[locale].region;
};
export const coverageRegionName = (node: CoverageNode, locale: AdminLocale): string => {
  if (node.level !== 0 || !isCountryCode(node.countryCode)) return (usesChineseSource(locale) ? node.regionNameZh : node.regionNameEn) || node.regionName;
  return localizedCountryName(node.countryCode, locale, countryByCode.get(node.countryCode)?.name.en || node.regionName);
};
export const credentialRemovalPrompt = (locale: AdminLocale, label: string): string => ({
  en: `Delete map credential "${label}"?`, 'zh-CN': `确定删除地图密钥“${label}”吗？`, 'zh-TW': `確定刪除地圖金鑰「${label}」嗎？`,
  ja: `地図認証情報「${label}」を削除しますか？`, ko: `지도 자격 증명 "${label}"을(를) 삭제하시겠습니까?`,
  de: `Karten-Zugangsdaten "${label}" löschen?`, fr: `Supprimer l'identifiant cartographique « ${label} » ?`,
  es: `¿Eliminar la credencial de mapas "${label}"?`, pt: `Excluir a credencial de mapa "${label}"?`
})[locale];
export const formatBytes = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index < 2 ? 0 : 1)} ${units[index]}`;
};
export const blacklistCategoryLabels: Record<AdminLocale, Record<string, string>> = {
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
export const providerQuotaDefaults: Record<string, number> = {
  amap: 5_000, baidu: 100, tencent: 10_000, onemap: 100_000_000,
  deepl: 500_000, youdao: 100_000, geoapify: 3_000, 'google-geocoding': 9_000, mappls: 1_000, 'openai-compatible': 100_000_000
};
export const UNLIMITED_QUOTA = 100_000_000;
export const providerQuotaPeriods: Record<string, 'day' | 'month'> = {
  amap: 'month', baidu: 'day', tencent: 'day', onemap: 'day', geoapify: 'day',
  deepl: 'month', youdao: 'month', 'google-geocoding': 'month', mappls: 'day', 'openai-compatible': 'day'
};
export const googleQuotaText = (locale: AdminLocale) => localeText[locale].googleQuota;
export const translationCostText = (locale: AdminLocale) => localeText[locale].translationCost;
export const deeplText = (locale: AdminLocale) => localeText[locale].deepl;
export const openAIText = (locale: AdminLocale) => {
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
export const usagePercent = (used: number, limit: number): number => limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
export const scopeLabel = (scope: string, locale: AdminLocale): string => ({ read: adminText[locale].scopeRead, generate: adminText[locale].scopeGenerate, '*': adminText[locale].scopeAll } as Record<string, string>)[scope] || scope;
export const continentLabel = (group: string, locale: AdminLocale): string => {
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
export const providerCredentialCount = (locale: AdminLocale, count: number): string =>
  count === 1 ? localeText[locale].ui.keyCountOne : interpolate(localeText[locale].ui.keyCount, { count });
export const remainingTime = (value: string | null | undefined, now = Date.now()): string => {
  const target = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(target)) return '';
  const minutes = Math.ceil(Math.max(0, target - now) / 60_000);
  if (minutes < 1) return '<1m';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes % 60}m`;
};
export const syncQueueRuleText: Record<AdminLocale, {
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
export const queueStateRank: Record<SyncQueueEntry['state'], number> = {
  running: 0, queued: 1, retry_wait: 2, cooldown_wait: 3, quota_wait: 4, blocked: 5,
  scheduled_wait: 6, suspended: 7, failed: 8, source_limited: 9, no_source: 10, done: 11
};
export const queueBadgeClass: Record<SyncQueueEntry['state'], string> = {
  running: 'running', queued: 'below_target', retry_wait: 'cooldown_wait', cooldown_wait: 'cooldown_wait', quota_wait: 'quota_wait',
  scheduled_wait: 'below_target', source_limited: 'source_limited', suspended: 'failed', no_source: 'source_limited',
  blocked: 'blocked', failed: 'failed', done: 'ready'
};
export const queueExtraStateText = (locale: AdminLocale) => localeText[locale].queueStates;
export const queueReasonText = (reason: string | null | undefined, locale: AdminLocale): string => {
  if (!reason) return '';
  const text = localeText[locale].reasons;
  const keyName = (provider: string) => ({
    geoapify: 'GEOAPIFY_API_KEY', mappls: 'MAPPLS_API_KEY', onemap: 'ONEMAP_ACCESS_TOKEN',
    china_maps: 'AMAP_API_KEY / BAIDU_API_KEY / TENCENT_API_KEY'
  } as Record<string, string>)[provider] || provider;
  const [code, detail = ''] = reason.split(/:(.*)/su);
  if (code === 'missing_api_key') return interpolate(detail === 'china_maps' ? text.missingChinaKeys : text.missingKey, { name: keyName(detail) });
  if (code === 'api_key_needs_review' || code === 'api_key_disabled') return interpolate(text.keyUnavailable, { name: keyName(detail.split(':')[0]) });
  if (code === 'api_key_expired') return interpolate(text.keyExpired, { name: keyName(detail) });
  if (code === 'credential_import_pending') return interpolate(text.importingKey, { name: keyName(detail.split(':')[0]) });
  if (code === 'missing_source_configuration') return interpolate(text.missingSource, { name: detail });
  if (reason in text) return text[reason as keyof typeof text];
  if (code in text) return detail ? `${text[code as keyof typeof text]} · ${detail}` : text[code as keyof typeof text];
  if (providerQuotaPeriods[reason]) return interpolate(localeText[locale].ui.quotaWaitFor, { provider: providerLabel(locale, reason) });
  return reason;
};
export const syncHistoryStatusClass = (status: string): string => {
  if (status === 'succeeded') return 'ready';
  if (status === 'running') return 'running';
  if (status === 'cancelled') return 'source_limited';
  if (['queued', 'paused_quota'].includes(status)) return 'quota_wait';
  if (status === 'needs_review') return 'below_target';
  return 'failed';
};
export const durationLabel = (startedAt: string | null, completedAt: string | null, locale: AdminLocale): string => {
  if (!startedAt) return '-';
  const started = Date.parse(startedAt);
  const ended = completedAt ? Date.parse(completedAt) : Date.now();
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return '-';
  const text = localeText[locale].ui;
  const seconds = Math.max(0, Math.round((ended - started) / 1000));
  if (seconds < 60) return interpolate(text.seconds, { s: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return interpolate(text.minutes, { m: minutes, s: seconds % 60 });
  return interpolate(text.hours, { h: Math.floor(minutes / 60), m: minutes % 60 });
};
export const finiteGoalValue = (value: unknown): number | null => {
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
