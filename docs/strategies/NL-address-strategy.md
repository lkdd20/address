# NL 荷兰地址生成策略

| 项目 | 核心内容 |
|---|---|
| 主源 | Kadaster BAG `verblijfsobject`（PDOK OGC Features API）+ Overture Maps addresses |
| 真实字段 / 坐标系 | BAG `identificatie`、门牌号/字母/附加号、道路、邮编、居住地、省、用途、状态与 Point 坐标均为源字段；API 输出 CRS84/WGS84。生成字段仅限可逆格式组合，不创造地址组件 |
| 既有门牌级格式 / 邮编 | `<street> <house><letter>-<addition>, <postcode> <city>, NL`；缺失的 letter/addition 保持空；格式门禁 `\d{4}\s?[A-Z]{2}`。只清洗格式，不按邻近地址补齐 |
| 行政区 | CBS/PDOK 行政区与 BAG 作为候选核验；当前源字段与 catalog 反查。行政层级必须与坐标反查一致；冲突时保留源值在隔离区并拒绝发布 |
| admin1 派生 | BAG 直接使用 `provincie_naam` 并与 12 省目录核验；Overture 的非省级 `address_levels` 仍按坐标锚定目录省份。无法锚定或与坐标冲突即拒绝，严禁发明行政区 |
| 住宅子集证据 | BAG 仅接受用途严格等于 `woonfunctie`、状态为 `Verblijfsobject in gebruik`、`geconstateerd=N`，且主地址、道路和居住地均为有效状态的对象；混合商业/住宅用途也拒绝。Overture 仅在住宅子集要求明确住宅建筑/用途证据；邮编不能替代住宅证据 |
| 街道级格式 | `<street>, <locality>, NL`；`matchLevel=street`，门牌、楼栋、室号为空；可唯一确定的来源邮编保留，否则留空。 |
| 街道去重 / 验证 | 国家 + 规范行政层级 + 街道名，同一路段不同坐标、邮编或来源 ID 不增加条数；行政字段不使用最近目录点推断。 |
| 同步方式 | 初始化按邮编/城市坐标分散 bbox，覆盖优先轮询所有地理种子第一页，再按官方 `rel=next` cursor 进入后续页；每个种子最多 2 页，单页大小按候选上限和种子数自动分配。每页保存原子 checkpoint，按 BAG ID 去重，成功后清除候选和 checkpoint。请求中断可恢复，最终快照通过门禁后原子发布 |
| 既有门牌去重 / 验证 | BAG `identificatie` 先去重，再按国家规范化地址与坐标生成 canonical hash；门牌、道路、居住地、省、邮编或坐标缺一即淘汰。门牌字母/附加号只保留源值，不能随机生成 |
| 策略版本 / 状态 / 更新 | 2.10 / BAG 严格在用住宅初始化 + Overture 补充 + 街道契约 street-v1 + address-structure-v1 + administrative-names-v19 + 热门优先 / 2026-10-20 |
共用规则（翻译、发布、生成、同步框架和结构门禁）见 [README.md](README.md)；本文件只记录本国差异。

- 默认 active 目标 50,000；省、市镇、区单来源均衡采样上限 5,000/700/120，省级最低 1,000，后台可覆盖；数量目标不得降低任何质量门禁。

## 既有来源街道提取（2026-09-08）

- Overture `addresses-streets-residential-subset-v6` 保留来源街道和未匹配住宅建筑的真实门牌；仅实际相交且有明确住宅类别的门牌获得住宅证据，街道不得因落入建筑面而获得住宅用途。候选先去重再均衡采样；建筑分类失败保留地址事实，不伪造住宅证据。

- 单次上限（capacity-20261003）：overture（1 个分片）：单次上限 200,000；pdok-bag（1 个分片）：单次上限 200,000。

- 本国邮编精细到街道或楼栋（或不使用邮编），不按区域或邻近地址推断；来源缺失时保持留空。

## PDOK 元数据格式（2026-10-10）

- PDOK OGC API 把集合更新时间放在顶层 `updated`（不再位于 self 链接），旧逻辑自 2026-10-07 起报 `SOURCE_METADATA_INVALID`。发现先读顶层 `updated`，兼容旧位置；来源版本仍为更新日期加适配器修订号，严格门禁不变。

## 目录本地名核验（2026-10-11）

- 目录本地名修正：省级 1 条、城市 197 条（已存地址由 catalog-native-addresses-v2 一次性改写）。

- 一级行政区多边形：纠正与坐标冲突或无法识别的来源区域，并排除境外坐标。

## 热门城市与热门地区优先（2026-10-19）

- Overture 导出改为热门优先配额（详见共用规则）：先统计各“一级行政区+城市”的地址数，每个城市保底 10 条，热门城市的都市圈（按名称或中心坐标半径归圈）补到每圈共 30,000 条，其余预算按目录人口平方根加权；按记录 ID 哈希切片抽样，预算增大只追加不替换。适配器修订为 `addresses-streets-residential-subset-v7-popular-cities`，所有 Overture 分片按新能力重新评估。
- 荷兰 Overture（BAG）地址没有城市名，城市在导入时按边界补全，因此不按城市名配额，而按地址密度抽样（2026-10-19 生产试跑：20,000 条结果的来源城市字段全为空）。
