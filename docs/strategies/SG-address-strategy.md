# SG 新加坡地址生成策略

| 项目 | 核心内容 |
|---|---|
| 主源 | HDB Property Information + HDB Existing Building；OneMap 精确补齐；Geofabrik OSM 作为补充 |
| 既有门牌级格式 / 邮编 | `<BLK_NO> <ROAD_NAME>, Singapore <POSTAL>`；HDB 真实楼栋号、道路、来源支持的 6 位邮编和 WGS84 建筑坐标；缺邮编记录保留但不发布，不生成门牌或邮编 |
| 行政区 | `Singapore` + HDB `bldg_contract_town` 官方城镇；未知代码拒绝发布。OneMap 同道路结果保留实际坐标/门牌，API-only 地址行政层只使用新加坡，不继承 HDB 城镇；歧义邮编留空；admin1 既非 Singapore 也非目录区名（如 OSM 误填的東京都）时改为 Singapore / 新加坡（administrative-names-v19） |
| 住宅子集证据 | Property Information 必须同时满足 `residential=Y`、`total_dwelling_units>0`；Existing Building 或 OneMap 提供地址存在、邮编和坐标证据，OneMap 本身不证明住宅用途 |
| 真实字段 / 生成字段 | HDB 楼栋、道路、HDB 城镇、住宅单元数及 OneMap 匹配的道路、真实门牌、已知邮编和坐标均为来源字段；生成字段：无，不生成门牌或邮编 |
| 坐标 / 去重 | OneMap/HDB 坐标统一为 WGS84；按 HDB 楼栋 ID、规范化楼栋号+道路去重；空邮编不合并不同道路 |
| 街道级格式 | `<ROAD_NAME>, Singapore <POSTAL>`；`matchLevel=street`，门牌、楼栋、室号为空，邮编必须为来源可唯一确定的六位数字。 |
| 街道去重 / 验证 | 国家 + 规范行政层级 + 街道名，同一路段不同坐标、邮编或来源 ID 不增加条数；行政字段不使用最近目录点推断。 |
| 同步频率 | 首次初始化自动运行；完成或来源耗尽后停止，不按日/月重复同步。只有新增来源、上游版本或适配器提取能力变化，以及管理员明确刷新时才重新执行。OneMap 只通过共享 Credential Broker 调用，按 `1 QPS` 节流；每轮最多发出 500 次实际 HTTP 请求（包括轮换和重试），逻辑查询数单独统计并保存 checkpoint，短时限速在同一任务内有限重试，真实额度、凭据或网络暂不可用时恢复后自动续跑。 |
| 既有门牌来源验证 / 排除 | HDB 属性与建筑必须一对一匹配；OneMap 结果必须满足规范化道路名和实际坐标门禁，保留真实楼栋号，无号时为 street；无效/歧义邮编的地址不发布。 |
| 策略版本 / 状态 / 更新 | 2.11 / HDB 双表 + OneMap 分批限速续跑 + 一次性初始化 + 多规则完成下限 + 街道契约 street-v1 + address-structure-v1 + administrative-names-v19（仅城市字段门禁） + 热门优先 / 2026-10-20 |
共用规则（翻译、发布、生成、同步框架和结构门禁）见 [README.md](README.md)；本文件只记录本国差异。

- 默认国家完成数量下限 12,000；既有来源层级单来源均衡采样上限 12,000/1,000/100，后台可覆盖。完成数量不是发布上限，严格记录可继续发布以满足覆盖和节点规则。

- HDB 双表优先一对一连接，住宅与非住宅真实门牌均可保留；只有 residential=Y 且住宅单元数大于零才声明住宅。OneMap 逐条保留匹配道路的结构化结果，仅同真实楼栋可复用 HDB 住宅证据；API-only 道路/门牌用途为 unknown。按规范道路+门牌去重，空邮编不会合并不同道路。
- 2026-09-13 邮编门禁调整：迁移自动重建合格索引，将已有缺邮编记录标记为未发布而非删除，重新计算总量、覆盖和节点完成状态。来源版本、适配器能力指纹、checkpoint 与耗尽状态均不变；不能以规则变化为由重新抓取已耗尽来源。
- `zh-CN` 道路、城镇或国家字段至少一个必须包含汉字；历史纯英文占位变体在自动翻译回填完成前不进入生成池，回填完成后无需人工干预即可恢复发布。

- 来源只提供国家级 `Singapore` 而无确定地区时，仅计入国家总量，不通过同名目录城市推断为 `Central Singapore`；行政覆盖保留未映射，不能借邮编、最近点或人口猜测归属。

## 既有来源街道提取（2026-09-08）

- Geofabrik `g70-streets` 提取来源命名道路及已有门牌，保留真实行政字段；道路点位于原始线几何，按国家/行政层/道路去重，不从最近目录点补行政区。街道楼栋、单元和住宅证据为空，邮编须经导入后推断唯一确定，否则不发布（2026-10-26）；非住宅门牌保留但不获得住宅用途。

- 适配器 `hdb-property-address-onemap-streets-v6`、规范化缓存能力 `onemap-address-v2`；组合来源保留 HDB/OneMap 的适用许可和署名，API 地址证据与 HDB 住宅证据分开。额度或本轮 HTTP 预算耗尽自动保存 checkpoint，不改写官方重置时间。
- Broker 回执丢失或缺少请求计数时，本轮停止新的上游请求；无法确认的 `onemapRequestCount` 为 null，不当作零消耗继续重试。Broker 保存结果失败仍返回实际已发 HTTP 次数。

## Administrative projection revision 1 (2026-09-13)

- `locality` retains the physical HDB town; `postal_locality=Singapore` is a postal label, not evidence that the town is missing. Coverage prefers the physical locality for SG; other countries keep their own field roles (including US postal locality).
- CDC districts, HDB towns, URA planning areas and electoral divisions are distinct namespaces. Source-backed explicit CDC identity is projected independently with catalog IDs, reference version, input hash and evidence method. Source and native codes/names must agree; a recognized code cannot override a conflicting or unrecognized district label. Unknown/ambiguous membership stays unresolved; the catalog city named Singapore must not assign the whole country to Central Singapore.
- The official current CDC constituency table and ELD map page were checked, but a current machine-readable, licensed boundary artifact was not obtained. No 2020 boundary, same-name town crosswalk, nearest-point or postal-prefix approximation is adopted. Missing postcodes remain excluded unless an exact authorized source association is verified; a same street/block with conflicting coordinates is not sufficient.

- 本地数字先转 ASCII；无法验证的邮编置空后按新加坡必填 6 位邮编规则拒绝，不再报告为 invalid_postcode。

- 单次上限（capacity-20261003）：overture（1 个分片）：单次上限 200,000；singapore-hdb（1 个分片）：API 来源，上限保持 12000，不增加付费或额度消耗；geofabrik（1 个分片）：单次上限 200,000。

- 本国邮编精细到街道或楼栋（或不使用邮编），不按区域或邻近地址推断；来源缺失时保持留空。

## 目录本地名核验（2026-10-11）

- 目录本地名修正：省级 0 条、城市 9 条（已存地址由 catalog-native-addresses-v2 一次性改写）。

## 热门城市与热门地区优先（2026-10-19）

- Overture 导出改为热门优先配额（详见共用规则）：先统计各“一级行政区+城市”的地址数，每个城市保底 10 条，热门城市的都市圈（按名称或中心坐标半径归圈）补到每圈共 30,000 条，其余预算按目录人口平方根加权；按记录 ID 哈希切片抽样，预算增大只追加不替换。适配器修订为 `addresses-streets-residential-subset-v8-popular-ranks`（v8 起导出每行写明热门分层与排名，导入先按排名取热门都市圈配额，剩余名额再按保底、一级行政区下限和均衡规则分配，2026-10-25），所有 Overture 分片按新能力重新评估。
