# KR 韩国地址生成策略

| 项目 | 核心内容 |
|---|---|
| 主源 | K-apt 官方共同住宅目录；韩国 Juso 道路名地址经 OpenAddresses 标准化归档；Geofabrik OSM 仅作补充 |
| 既有门牌级格式 / 邮编 | 道路名地址按 `<시/도> <시/군/구> <읍/면/동> <도로명> <건물번호> <5位邮编>`；K-apt 地番地址保留来源顺序；不创造栋、单元或室号 |
| 行政区 | Juso 的 `REGION/CITY/DISTRICT` 与坐标；K-apt 动态 SIDO 与 `bjdName`。缺层级、越界或冲突均拒绝发布 |
| 住宅子集证据 | K-apt 目录直接证明共同住宅；Juso 只证明地址存在，只有住宅子集必须与当前 Overture 明确住宅建筑几何相交 |
| 真实字段 / 生成字段 | K-apt 地番、小区名和行政字段及 Juso 门牌、道路、行政区、邮编和坐标均为来源字段；Geoapify 提供严格匹配的道路、实际门牌及已知邮编。生成字段：无，不补栋、单元或室号 |
| 坐标 / 去重 | 来源坐标统一为 WGS84 并通过韩国边界门禁；按 K-apt/Juso 稳定 ID、规范化地址和住宅建筑关系去重 |
| 发布门禁 | 接受真实街道级与已有门牌级地址；按实际精度检查来源、行政归属、语言和坐标。街道记录不强制门牌，不编造缺失字段；已有真实门牌保留，未知或歧义邮编留空；只有住宅子集要求独立住宅证据。 |
| 街道级格式 | `<시도> <시군구> <읍면동> <도로>`；`matchLevel=street`，门牌、楼栋、室号为空；可唯一确定的来源邮编保留，否则留空。 |
| 街道去重 / 验证 | 国家 + 规范行政层级 + 街道名，同一路段不同坐标、邮编或来源 ID 不增加条数；行政字段不使用最近目录点推断。 |
| 同步方式 | 自动初始化一次，读取 17 个 Juso 省级分片并处理 K-apt；Geoapify 额度或凭据恢复后从 checkpoint 续跑，完整扫描或来源耗尽后停止 |
| 既有门牌来源验证 / 排除 | 缺少国家契约所需行政层级、合法地番/道路或坐标的记录淘汰；未知邮编留空。Juso 只有住宅子集要求建筑相交。 |
| 策略版本 / 状态 / 更新 | 1.20 / 国家完成下限 30,000，Juso 地址存在 + 当前住宅建筑验证 + K-apt 安全部分增量发布 + 街道契约 street-v1 / 2026-09-13 |

- 默认国家完成数量下限 30,000；道/广域市、市郡区、街区单来源均衡采样上限 5,000/800/150，后台可覆盖。完成数量不是发布上限，严格记录可继续发布以满足覆盖和节点规则。规范化缓存身份包含来源有效上限和行政节点上限，提升配额后不复用旧缓存。

- K-apt 记录是小区级地番地址，不扩写为未提供的栋、单元或室号；内部复合市/区名按常见格式拆分。Juso 记录的门牌、道路、邮编和坐标均保留源值，不以附近地址补缺。
- 韩国常见地址格式仍由 `address-format.ts` 负责本地化展示；英文展示按拉丁顺序，韩文展示按道路/地番顺序，不把所有国家统一成“小区地址”。
- 大型 Juso 归档以有界候选堆流式扫描，跨成员重复地址只在候选阶段保留一次；同步进程使用跨进程租约。翻译回填使用独立连接池并可与同步并行，发布阶段使用短锁等待和事务校验，发生竞争时自动退避。
- 30,000 是国家完成下限而非产量承诺。`kapt-official-addresses-geoapify-streets-v7` 保留全部合格 K-apt 地番地址，未知邮编为空；Geoapify 的韩国、完整行政层及 15 米坐标门禁通过后可另产真实道路/门牌，不能把 읍/면/동/리 当道路或借用 K-apt 住宅证明。规范化缓存指纹包含 `geoapify-address-v2`；完成结果不重复请求，额度/失败不污染缓存。partial 快照保留真实原始候选并自动续跑，resolved 数与产出地址数分开，输出数量可大于候选数量。
- 本机桥的连接重置、超时和 JSON 解码错误最多退避重试 3 次；单条重试耗尽时跳过该条且不写缓存，连续 12 条失败才终止本轮。Broker 的短 QPS 间隔在当前任务内等待后继续；日额度、长冷却或凭据不可用时保存 checkpoint 并等待最早恢复时间。


默认同步生命周期为自动初始化一次；未完成的额度或 checkpoint 任务自动续跑，完整扫描或来源耗尽后停止，不按日/月重复执行。只有来源、上游版本、严格提取能力变化或管理员明确刷新才重新运行；周期元数据探测仅在显式启用时执行。

统一证据等级、许可、配额与 VPS 边界见 [数据源与自动同步方案](../data-sources.md)。策略变化时同步更新本文件、实现与测试。

## 自动翻译恢复（2026-09-13）

- 原文恢复门禁修订 3（2026-09-13）：翻译恢复的基础资格仅检查原文的非住宅和自定义排除词，损坏的目标语言版本不阻断修复；发布前仍检查所有语言、地址事实和来源。仅旧基础契约拒绝按此能力版本重新评估一次，真实原文拒绝及未变化的供应商失败继续停止，不清空尝试、来源或额度状态。

- DeepL 仅使用 `api-free.deepl.com` 和 Free Key，不切换 Pro。每次先查账户额度，按 Unicode 码点原子预留字符；账户上限与所有启用 Key 的项目上限取最低值，共享持久账本，响应不明不退额度。用量查询可能延迟；外部应用用量不受本项目控制，Free 官方硬上限兜底。
- DeepL 默认项目上限为 500,000 字符，可在后台自定义，实际仍受账户额度约束；后台测试只查用量，不翻译。仅供应商可信周期可触发清零；没有周期日期时不按月初、重启或换 Key 重置。限速、鉴权和额度等待不等于地址来源耗尽。

- Google 使用免密钥网页接口，非 Cloud Translation 计费 API，可能限流或不可用；不承诺永久、无限免费。有道为可选付费降级，没有启用凭据时不调用；测试同样可能收费，项目限额不代表供应商免费额度。
- 每批最多发布一个国家，其他已翻译国家保留缓存并延期，不消耗失败次数。同一发布事务内仅对本批变更地址执行完整来源、地址和语言门禁，再从已验证索引重排全国连续序号并刷新计数；未变更地址不重复扫描来源证据。全量来源导入仍执行完整重建，门禁不降低。
- 批次默认 180 秒硬超时；超时或取消仍持久化收尾进度，已提交国家不回退。派发前中断、429/额度等待、短锁竞争和跨国延期不扣失败次数；已派发但响应丢失保守计次。真实请求失败、发布语句超时或事务冲突按指数退避，记录最多 3 次；达到上限后须地址输入或服务配置变化才重评，不清空历史失败。
- 生产同步初始化保留真实 readiness；启动健康检查宽限 3 分钟，成功后继续每 15 秒检查、单次 5 秒超时及 8 次失败上限，不提前报就绪。

- 复用后台翻译配置；有效缓存优先，在线路由按管理员定义的优先级数值从小到大执行，同优先级轮询，并跳过不可用、冷却中、额度耗尽或失败的路由；新建 OpenAI 兼容路由默认排在 DeepL、有道和 Google 之前。所有 DeepL 入口必须通过 Credential Broker。`TRANSLATION_BACKFILL_YOUDAO_DAILY_CHARACTERS` 每日最多 10,000 字符，不代表实际费用或账户额度。
- 优先街道，再处理其他非中国地址；仅恢复当前授权来源有效、基础契约合格且因 `publication-validation:` 退役的记录。只翻译语义字段，保留原文、门牌、单元、邮编、坐标和来源时间，组件与整行地址同步写回。
- 进度、输入版本和有限重试持久化到 PostgreSQL；同步繁忙时仍以独立连接池运行，发布锁竞争时退避。完整校验通过后在同一事务恢复地址、生成索引及统计；失败或来源撤销的记录保持未发布，不重置来源队列、checkpoint 或耗尽状态。

## 覆盖与保留

- 覆盖映射修订 3（2026-09-13）：按真实目录 ID 区分同名节点，名称不是唯一身份；明确省区之外的同名城市不得覆盖原归属，不按人口或最近坐标猜测。先匹配完整名称和代码，再使用该国家的行政词缀与简繁等价形式，歧义保留未映射；台湾县、市由目录类型区分。后台下钻保留零地址城市和真实层级，不影响生成筛选隐藏零项。
- 翻译配置恢复修订 2（2026-09-13）：服务配置真正变化后，终态记录由有界待评估查询自动重评，不等待全池游标绕回；已经合法发布的记录校验通过后仅纠正陈旧恢复状态，保留尝试次数且不重发供应商请求。同一输入的真实终态仍停止，基础契约拒绝、来源耗尽和配额账本不被清零。

- 独立刷新区域统计时，先在事务内按发布相同顺序锁定地址、证据、索引和统计表，再读取及发布结果，避免并发回填被旧统计覆盖；官方目录的零地址节点保留。

- 官方行政区目录定义覆盖分母；关联到官方节点的合格街道及门牌地址计入分子，住宅子集单独统计。
- 每个有合格数据的最低行政区先满足每节点、省市和单节点目标，再轮询分配额外记录；国家总量是完成下限，节点规则可推动总量继续增长，来源或分片容量仍是技术硬限制。
- 每次国家快照发布后自动重建总地址覆盖和住宅子集覆盖；无合格数据的区域显示零覆盖，不能作为可生成选项。
- 同步进程启动时仅修复发布池、索引、后台和同步计数有差异的派生统计；不重抓来源、不重置验证断点或解除耗尽/额度等待。


## 运行时随机生成

- 语言门禁一致性（2026-09-08）：发布统计、生成索引和候选 SQL 与读取层共享中英文语义字段的脚本规则，逐项检查街道、楼名和行政名称，排除混入目标语言不允许文字的记录；中文仍须含汉字。门牌、单元和邮编标识不参加此脚本检查；原文、来源能力版本和额度不变，待翻译记录不得计入可发布数量。

- 公开普通生成直接在 PostgreSQL 完整合格范围选择：支持连续生成序号的未筛选国家池按序号等概率选择，筛选范围使用有界循环索引窗口；不使用固定子集或固定顺序。
- 每次按 seed 在有界候选窗口内执行独立偏移，再按主键读取完整地址与证据；API 不把完整地址池加载到进程内存，也不执行全表随机排序。
- 未传入 seed 时由服务器为每个请求生成新 UUID；相同显式 seed 在同一数据库快照中可复现。数据库提交后，新 worker 快照全部就绪才原子替换旧快照。

## 既有来源街道提取（2026-09-08）

- Geofabrik `g70-streets` 提取来源命名道路及已有门牌，保留真实行政字段；道路点位于原始线几何，按国家/行政层/道路去重，不从最近目录点补行政区。街道邮编、楼栋、单元和住宅证据为空；非住宅门牌保留但不获得住宅用途。
- Juso/OpenAddresses `archive-address-streets-v3` 保留真实街道、门牌与来源行政字段，未知邮编留空，跨成员及道路采样点去重；Overture 建筑匹配仅用于住宅子集。

- Geoapify 地址存在证据使用其提供商 URL 与稳定记录 ID，组合数据集保留 K-apt、Geoapify 及底层开放数据许可/署名；住宅证据单独归属 K-apt。缓存不保存原始响应和密钥。

## 生成筛选与管理边界（2026-09-13）

- 生成和快捷选择仅展示经过完整发布门禁的生成索引中有可用地址的选项，零项在分页前排除；管理覆盖树与完成判定仍保留完整官方目录的零地址节点。
- 城市、行政区名称/代码/ID 与生成使用同一条件；层级边界兼容路径尾斜杠，精确筛选不依赖目录中心坐标。共用邮编不隐式限定代表城市；按发布版本失效缓存，不重复扫描原始证据。真实地址坐标、来源、语言和住宅证据门禁不降低。
- 完整邮编筛选（2026-09-13，运行时筛选修订 2）：以生成索引中的真实完整码为准，目录仅补充已存在的标签与 ID；目录只含前缀或缺项时仍可按完整码选择，不制造目录 ID 或行政归属。文本码精确校验发布索引与所选省市，未知、前缀或退役码不匹配；空格/大小写规范化，原有 ID 兼容，翻译与来源指纹不变。

## Shared translation recovery revision 4 (2026-09-13)

- Cached API translations preserve postal, house, unit and administrative identifiers and semantic-field numbers. Equivalent decimal scripts and explicit CJK address ordinals are compared by value; changed digits and leading zeros are rejected.
- Canonical administrative translations require a unique catalog identity within the verified region, never a population-based same-name guess. Native source facts and source execution fingerprints are unchanged.
- Non-China recovery checks cached/canonical fields before bounded provider requests. Failed translations receive a paged cache-only reevaluation; unchanged publication failures retain their retry limit. Recovery diagnostics reuse source/publication predicates and store reason, language and field only, not addresses or credentials.
- When a provider alters a numeric or alphanumeric street/building token, recovery translates only the text spans and restores the source identifiers; all language, numeric, identifier, use-evidence and blacklist gates still apply. Provider cooldowns cannot trigger another dispatch to that provider in the same batch. Priority remains cache first, then enabled routes in administrator-defined ascending priority with round-robin among ties; unavailable, cooling-down, quota-exhausted and failed routes are skipped. New OpenAI-compatible routes default ahead of DeepL, Youdao and Google; character reservations and source-exhaustion states are not reset.

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
- Catalog minimums honor explicit node targets. An overridden node without coverage counts as zero and remains unmet; official zero-address nodes stay in the coverage denominator.
- Initial online import translation follows enabled per-key priorities and pins each broker dispatch to its credential. Caller environment, fetch implementation and cancellation propagate to localization; deferred localization remains the default.
- Display translation caches include source component contents, country and native language. Corrected components invalidate old cache entries; unchanged inputs reuse validated translations. Numeric and HTTP-date Retry-After values are respected.
- Existing source, administrative, coordinate, identifier, language and publication gates remain enforced. DeepL credit accounting is unchanged; no periodic refill is introduced for one-time rewards.
