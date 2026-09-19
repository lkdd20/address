# CN 中国地址生成策略

| 项目 | 核心内容 |
|---|---|
| 主源 | AreaCity/StatsGov 行政区版本 + 高德、百度、腾讯 WebService 严格住宅小区 POI。高德 `120302` 是首选主源；百度、腾讯用于补充独有合格小区。 |
| 格式 / 邮编 | `省市区县街道/道路门牌小区名称 + 室内字段 + 六位邮编`；小区、道路门牌、邮编和坐标真实或来自官方目录映射。只为中国合成 `1-3栋、1-3单元、2-6楼、01-04室`，并标记 `synthetic`；缺少官方区县邮编目录值的候选不发布。 |
| 行政区 | AreaCity 主源，民政部版本页对照；省/市/区县/街道层级和法定后缀必须一致。 |
| 住宅证据 | 高德候选必须是 `typecode=120302`，`adcode` 与目标区县一致，并带可投递的数字门牌地址。 |
| 真实字段 / 生成字段 | 省、市、区县、小区名、道路门牌和平台坐标为来源真实字段；仅栋、单元、楼层和室号为生成字段并标记 `synthetic` |
| 坐标 / 去重 | 平台坐标统一保存为 WGS84；按平台 POI ID、规范化道路门牌、小区名、行政代码和近坐标合并重复候选 |
| 发布门禁 | 质量高于数量。只发布大陆 31 个省级行政区内的记录，并要求可确定拆分的末尾数字门牌。原生道路和小区名称不得混入外文；`A区`、`B座`、`F组团` 等地址构件标识除外。严格高德 L1 可发布；百度/腾讯还必须通过住宅分类、住宅名称、行政区、坐标和黑名单门禁。关键字段缺失或门牌后仍有不确定文本即淘汰；已验证记录不因固定天数自动失效。 |
| 同步频率 | AreaCity 发布新版时更新行政区；POI 按免费额度分页补齐；短暂限流按平台返回时间恢复，周期额度在重置后自动续跑。每个行政查询窗口高德最多 8 页、百度和腾讯最多 10 页，单页拒绝不终止后续分页。Broker 在同一额度账本内原子预留请求并轮换全部可用 Key。候选永久保存，发布层可由合格候选重建。 |
| 验证 / 排除 | 任一平台的严格住宅候选可作为 L1；多平台同名、近坐标且门牌一致时升为 L2/L3。门牌或行政区冲突不合并；不使用旧 OSM 中国住宅池。 |
| 策略版本 / 状态 / 更新 | 2.10 / 高德 `community-poi-v9-amap-compatible`，百度/腾讯 `community-poi-v7` + 共享凭据额度 Broker / 2026-09-13 |

## 查询与额度

- 高德 Broker 优先使用 POI 2.0 `/v5/place/text`，按 AreaCity 的 6 位区县 `adcode` 查询，固定 `types=120302`、`city_limit=true`、`page_size=25`、`show_fields=business`；兼容性回退的每次 HTTP 请求分别计费。直连及管理员测试使用 `/v3/place/text`，`offset=25`，不隐式发出第二次请求。高德最多读取 8 页；百度和腾讯单页 20 条，按返回行政区严格过滤。
- 适配器通过的每条 POI 先写入 `cn_ingest_candidates`，记录规范字段、目标区县、策略版本、判定和拒绝原因；不保存原始响应或凭据。发布表清理不级联删除候选，空发布层会从当前规则仍合格的候选重建。
- 同步分别记录原始条数和合格候选数；原始非空但候选为零时将该页记为已扫描并继续下一页，直到空页、重复页或提供商分页上限。当前能力版本的旧 `adapter_rejected_all` checkpoint 自动从下一页恢复；只有完成整个有限分页窗口才视为该窗口已扫描。checkpoint 按提供商保存能力版本，高德 POI 2.0 只重开高德的未达标行政查询窗口，百度和腾讯的 v7 终止状态不受影响。
- Broker 的网络、认证、QPS 与周期额度结果分别进入失败或等待状态；网络失败不会伪装为额度耗尽。中国 Worker 使用同步任务硬超时。同一执行能力与凭据配置发生相同零进展失败时，前两次分别退避 5、10 分钟，连续第 3 次停止；历史记录保留重试状态，进程重启不重置。执行能力或凭据配置变化后自动重新评估，退避期间不阻塞其他国家。
- 每个 WebService Key 默认是独立额度；同一个 Key 的日/月窗口同时生效，任一窗口耗尽即轮换。高德个人认证基础搜索默认每月 `5,000` 次、`3 QPS`；百度个人地点检索默认每日 `100` 次、`3 QPS`；腾讯初始默认每日 `10,000` 次、`5 QPS`。实际周期和上限以响应头及用户控制台为准。
- 腾讯返回 `X-Limit` 时显示平台实时已用量与上限；高德、百度响应不提供剩余额度时显示本地统计，并由平台超限错误校正状态。
- 后台显示各额度窗口的已用、上限、剩余、统计来源和重置时间；新增、修改或启用 Key 会唤醒同步。高德 `10003` 按北京时间次日零点恢复，`10004` 只冷却到下一分钟，`40000` 归入月/套餐额度而不是无效 Key；百度与腾讯日额度按北京时间日界线管理，平台响应提供的实际时间优先。
- 每个 Key 独立记录额度、QPS、冷却和重置时间；当前 Key 失败后立即排除本轮并尝试下一个。全部 Key 均不可用时，调度器等待其中最早的冷却或额度重置时间，不设置平台级全局不可用状态。
- 生产与隔离测试栈通过内部白名单 Broker 共用 Key 轮换和日/月额度计数；测试栈只持有独立客户端令牌，不能读取原始 Key，也不连接生产地址库或同步历史。测试额度未显式配置时拒绝请求，生产请求始终优先。
- 高德先请求 v5；v5 返回非 JSON 兼容性响应时，Broker 自动切换官方 v3 等价查询并在当前进程内保留兼容选择。每个 HTTP 请求分别预留额度，回退仍遵守 Key 轮换与 QPS；v3 也返回非 JSON 时结束本次请求并进入有限失败退避，不将该响应误报为额度耗尽或无效 Key。
- 国家总量是完成下限，不是 active 地址硬上限。为满足省、市、区县覆盖和单节点目标，合格地址可以远超国家总量；来源容量、单节点容量和质量门禁仍然有效。配额只约束地址，不裁剪 AreaCity 行政区或邮编目录。

## 凭据边界

- `AMAP_API_KEY`：仅服务端 WebService 同步，可在后台添加多个并按免费预算轮换。
- `AMAP_JS_API_KEY`：独立浏览器 Key；公开站点启用高德时会在网络请求中可见，必须设置正式域名白名单，不与同步 Key 复用。
- `AMAP_JS_SECURITY_CODE`：仅在服务器以 AES-GCM 密文保存，只由 `/_AMapService` 代理使用。
- Security Code、同步 Key 和其他 Token 不进入前端、Git 或日志；示例值全部是空值或占位符；VPS 运行配置权限为 `600`。


统一证据等级、配额、自动同步与来源验证见 [数据源与自动同步方案](../data-sources.md)；运行参考见 [CN DOCX](CN-China-address-generation-and-key-rotation.docx)。
## 覆盖与保留

- 官方行政区目录定义覆盖分母；CN 完成判定只纳入省级代码前缀 `11-65` 的中国大陆节点，港澳台不进入 CN 分母。只有关联到官方节点的严格住宅地址计入分子。
- 国家当前数量以通过发布门禁的 `cn_communities_v2` 住宅小区去重数为准；普通 `address_pool` 中国地址仅服务非住宅模式，不覆盖住宅同步目标和后台统计。
- 中国同步结束（含额度暂停和失败）、启动唤醒及行政目录更新时，只刷新中国派生统计，不扫描或重写其他国家。一次严格发布快照同时生成国家、省、市、区县数量，并保留官方目录中的零地址节点；统计在单个事务内发布。
- 统计刷新单条 SQL 最长 30 秒、锁等待最长 2 秒；临时超时、锁冲突或事务冲突最多尝试 3 次，间隔 250、500 毫秒。最终失败写入 `china.coverage.refresh_failed` 审计及脱敏日志，不把它计作来源失败或因此重跑来源。正常启动自动修复遗留统计；不重置 checkpoint、来源能力版本、耗尽状态或凭据额度。
- 每个有合格数据的最低行政区先均衡保留 5 条，再轮询分配额外记录；国家目标是完成下限，节点、省市和覆盖规则可以推动总量继续增长。
- 已有合格地址不因达到国家总量而自动缩减；只有明确的单节点裁剪规则会停用该节点超额记录。
- 每次国家快照发布后自动重建住宅覆盖；生成器只展示至少有 1 条可发布住宅地址的官方区域。


## 运行时随机生成

- 公开普通生成直接在 PostgreSQL 完整合格范围选择：支持连续生成序号的未筛选国家池按序号等概率选择，筛选范围使用有界循环索引窗口；不使用固定子集或固定顺序。
- 每次按 seed 在有界候选窗口内执行独立偏移，再按主键读取完整地址与证据；API 不把完整地址池加载到进程内存，也不执行全表随机排序。
- 省、市、区简称与全称分别使用等值随机索引窗口，每个别名组合最多取 16 条，再按相同哈希和 ID 顺序合并为 16 条；不足时沿用原有环绕补齐。最多 8 个组合，保留全部别名和原有确定性选择；坐标附近查询不变，不修改来源能力版本或质量门禁。
- 未传入 seed 时由服务器为每个请求生成新 UUID；相同显式 seed 在同一数据库快照中可复现。数据库提交后，新 worker 快照全部就绪才原子替换旧快照。
- 入库和旧社区读取统一规范 `provider_address`：只移除由至少两个结构化行政字段精确组成的重复前缀，并删除 `西北方向120米` 等导航距离片段；正常道路名不做模糊裁剪。生成读取时只把来源地址末尾可验证的 `数字/字母 + 号` 门牌拆入 `houseNumber`，道路保留在 `street`，完整原文地址顺序不变，不生成门牌。

## 多规则达标与覆盖模式（2026-08-02）

- 完成条件 = 总量目标 AND 最低行政层覆盖率/每节点最低数 AND 省级保底 AND 市级保底 AND 所有单节点目标；任一启用规则未达标都保持未完成并继续调度。
- CN 默认：目标 40,000、每区县最低 5、省级保底 800、市级保底 60、覆盖率 100%；四个直辖市节点的代码预设均为 2,000。已有用户节点配置保留，不以默认值覆盖。
- 覆盖模式：总量达标但其他规则未达时，仅同步未达标区县（含未达省/市保底的下属区县，按缺口降序），已覆盖节点整体跳过以节约配额；不存在 `目标 × 1.2` 上限。
- 裁剪：节点数量超过其单独目标时，按 source_count/验证等级从弱到强停用超额社区并写审计（china.communities.prune）。
- 只有每个已配置且启用的提供商都完成每个未达标区县及其乡镇查询窗口的有限分页后，才显示未完成、`source_limited`（`coverage_sources_exhausted`）并停止入队；单页质量拒绝、单个 Key 额度耗尽、QPS 冷却或其他提供商等待额度都不是来源耗尽。修改目标不会解除耗尽状态，导入版本或来源版本变化后才重新评估。
- 日/月额度或 QPS 冷却不是来源耗尽：状态保留未来重置时间，到期自动唤醒。中国目标未完成时拥有最高调度优先级，普通国家等待中国运行或进入未来额度等待窗口后再启动。
- 默认同步生命周期为自动初始化一次；未完成的额度或 checkpoint 任务自动续跑，三重目标完成或所有来源耗尽后停止，不按日/月重复执行。已耗尽窗口仅在对应来源、上游版本或严格提取能力变化后重新评估；管理员唤醒不绕过执行资格和额度门禁。
- 同步在独立 worker 线程执行，与 API 事件循环隔离。
- 生产同步初始化保留真实 readiness；启动健康检查宽限 3 分钟，成功后继续每 15 秒检查、单次 5 秒超时及 8 次失败上限，不提前报就绪。中国仍沿用现有本地翻译与住宅地址契约，不进入非中国在线翻译补全队列。
- 短 Broker QPS 等待在同一页内有限重试，最多 3 次；超过等待范围保留断点。每次暂停记录结束时间，原始候选、接受、拒绝原因、重复、插入和发布净增长分别统计；旧历史缺失值不编造。
- 中国英文使用专名音译和英文地址类型词，复合镇街按层级排序，弄巷编号保留为 Lane；Pinyin 独立从中文字段生成，不复用英文类型词。省/市/区/邮编筛选使用等值候选及复合随机索引，保留完整池随机读取。
- 后台同步队列使用独立页面，不与“地址数据”配置页混排；每个国家分别展示国家总量、行政区覆盖和层级/节点最低数量三组进度及未达原因。
- 前端筛选：省/市/区三级选项统一由 cn_communities_v2 生成（带市后缀容错与去重），选项值即社区规范名。
- 中国省份可用性由一次发布社区聚合生成，位置请求按国家、住宅模式、层级、搜索词和父级 ID 完整隔离并短时缓存；父级变化立即清空下级选项。
- 旧的前 500 条候选窗口已停用；中国与其他国家共用完整合格范围随机索引，选中小区后才按主键聚合来源证据。
- 启动校准按来源表一次分组计算有效来源数，仅更新等级实际变化的小区，避免随数据规模增长产生逐小区重复扫描和无效全表写入。
- API 先监听端口，再异步刷新中国派生统计并唤醒自动调度；实际同步仍在独立 worker 中执行。目标表为空时由同步服务执行一次目标初始化及来源校准，不靠管理员访问状态接口修复统计。

## 直管行政层级（2026-09-08）

- AreaCity/StatsGov `2025.251231.260403` 中，东莞、中山、儋州、嘉峪关及所列省直管县级节点存在同名市/区县占位层级。质量例外限定到该版本的大陆省份+城市组合；发布仍要求当前目录存在对应同名父子关系，不接受任意行政重复。
- 保留原始 locality/district，不编造区县；中文、英文和 Pinyin 展示中的同名行政层只输出一次。住宅、六位邮编、坐标、语言和来源门禁不变。

## 在线翻译与统计一致性（2026-09-13）

- 中国不进入非中国翻译补全队列；展示 API 的共享翻译链优先复用合格本地变体和缓存，在线路由按管理员定义的优先级数值从小到大执行，同优先级轮询，并跳过不可用、冷却中、额度耗尽或失败的路由；新建 OpenAI 兼容路由默认排在 DeepL、有道和 Google 之前，不改变住宅来源与语言门禁。
- DeepL 仅使用 `api-free.deepl.com` 和 Free Key，不切换 Pro。每次先查账户额度，按 Unicode 码点原子预留字符；账户上限与所有启用 Key 的项目上限取最低值，共享持久账本，响应不明不退额度。用量查询可能延迟；外部应用用量不受本项目控制，Free 官方硬上限兜底。
- DeepL 默认项目上限为 500,000 字符，可在后台自定义，实际仍受账户额度约束；后台测试只查用量，不翻译。仅供应商可信周期可触发清零；没有周期日期时不按月初、重启或换 Key 重置。限速、鉴权和额度等待不等于地址来源耗尽。
- 有道按量收费，未启用凭据时不调用；Google 使用免密钥网页接口，非 Cloud Translation 计费 API，可能限流或不可用，不承诺永久、无限免费。
- 独立刷新区域统计时，先在事务内按发布相同顺序锁定地址、证据、索引和统计表，再读取及发布结果，避免并发回填被旧统计覆盖；官方目录的零地址节点保留。

## 生成筛选与管理边界（2026-09-13）

- 生成和快捷选择仅展示已发布住宅社区中有可用地址的选项，零项在分页前排除；管理覆盖树与完成判定仍保留完整官方目录的零地址节点。
- 城市、行政区名称/代码/ID 与生成使用同一条件；层级边界兼容路径尾斜杠，精确筛选不依赖目录中心坐标。共用邮编不隐式限定代表城市；按发布版本失效缓存，不重复扫描原始证据。真实地址坐标、来源、语言和住宅证据门禁不降低。
- 城市 ID 筛选（2026-09-13，运行时筛选修订 2）：目录缺少城市时，生成接口接受已发布社区选项的合成城市 ID，并保留明确省份范围；合成 ID 必须为有效 UTF-8 且不能与国家或城市文本冲突。仅传数字省市 ID 时先解析规范名称再检索社区，不丢掉筛选条件或跨范围替代；不改变目录覆盖分母、社区发布门禁、来源或同步断点。

## Shared translation recovery revision 4 (2026-09-13)

- Cached API translations preserve postal, house, unit and administrative identifiers and semantic-field numbers. Equivalent decimal scripts and explicit CJK address ordinals are compared by value; changed digits and leading zeros are rejected.
- Canonical administrative translations require a unique catalog identity within the verified region, never a population-based same-name guess. Native source facts and source execution fingerprints are unchanged.

## Shared publication/index consistency revision 5 (2026-09-18)

- The generation index is a candidate accelerator, not publication authority. Every selected row is revalidated against current quality, expiry, country, residential evidence and requested administrative/postcode/search filters before return; stale rows are skipped. Startup consistency compares current source IDs with active index IDs, so equal counts with different membership trigger repair.
- Published coverage is calculated from the freshly rebuilt active generation index; `residential_count` uses current evidence-backed `residential_ready`, and all grouped counts use distinct address IDs. Date-only expiry remains valid through the end of that UTC date. Shared GET generation text and ID inputs are bounded and reject control characters without relaxing country-specific source, language, coordinate or evidence gates.


## Translation recovery and provider compatibility revision 6 (2026-09-19)

- Recoverable source records remain stored when translation is unavailable. Discovery, due retries and cache-only reevaluation take bounded turns, so repeatedly cooling providers cannot monopolize recovery. Unchanged deterministic failures retain finite retries; effective provider configuration changes permit reevaluation without resetting source exhaustion or quota ledgers.
- Elapsed credential cooldowns become executable automatically; the broker still enforces live quotas. Repaired non-China records pass the full contract before transactional publication, index and count updates. China retains its existing residential contract.
- Model discovery preserves advertised endpoint and reasoning capabilities. No model is hardcoded; missing reasoning metadata is reported as unknown. The project explicitly sends low reasoning by default, including legacy default settings; advertised levels take precedence on model selection if low is unavailable. Provider omission defaults are not assumed. Prompts affect translation style only, never source facts.
- Numeric repair translates text spans and restores original numeric/alphanumeric tokens, including ordinal identifiers and leading zeros. Publication reads reject changed translated identifiers; date-only expiry remains valid through its UTC date. Source fields, coordinates, administrative identity and source execution fingerprints are unchanged.

- A separate cache-only scan runs automatically even when online providers are disabled or cooling down. It has its own persisted cursor, preserves failure history for unrepaired records, consumes no translation requests, and republishes only fully validated cached/canonical results. Scoped catch-up uses the same bounded code path, never manual queue/checkpoint edits.
- Recovery reads source evidence and prior recovery state in bounded groups; administrative name lookup uses indexed aliases while preserving ambiguous-name rejection. Publication rereads every candidate under the existing transaction locks before changing data.
- Cache catch-up fetches translations per bounded source group and computes all affected dataset totals in one grouped query, avoiding repeated evidence-table scans during publication.
- Recovery workers share a PostgreSQL advisory lease. A competing batch waits without dispatching requests, moving cursors or charging attempts; connection closure releases the lease after interruption. Publication still performs its own source fingerprint and contract checks inside the transaction.

## Per-key translation routing revision 7 (2026-09-19)

- OpenAI-compatible, DeepL and Youdao priorities belong to individual credentials. Legacy provider settings seed per-key routes once; dispatch pins the selected credential in both live requests and automatic recovery. Equal priorities rotate; one failed key does not disable sibling keys. Keyless Google retains one independently configurable route.
- The quality-first AI prompt preserves JSON cardinality, digits and identifiers. Model discovery resolves custom API prefixes and supports manual model IDs. All source, language, coordinate, administrative and publication gates remain unchanged.

## Policy and translation consistency revision 8 (2026-09-19)

- Administrative policy keys use lowercase UTF-8 hex, matching PostgreSQL coverage keys. Legacy aliases are normalized transactionally; canonical settings and explicit clears take precedence. Source exhaustion states and stored address facts are preserved.
- The China coverage tracker uses the same canonical keys and accepts legacy aliases when planning provincial, city and district deficits.
- Catalog minimums honor explicit node targets. An overridden node without coverage counts as zero and remains unmet; official zero-address nodes stay in the coverage denominator.
- Initial online import translation follows enabled per-key priorities and pins each broker dispatch to its credential. Caller environment, fetch implementation and cancellation propagate to localization; deferred localization remains the default.
- Display translation caches include source component contents, country and native language. Corrected components invalidate old cache entries; unchanged inputs reuse validated translations. Numeric and HTTP-date Retry-After values are respected.
- Existing source, administrative, coordinate, identifier, language and publication gates remain enforced. DeepL credit accounting is unchanged; no periodic refill is introduced for one-time rewards.
