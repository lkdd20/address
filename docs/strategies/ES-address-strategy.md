# ES 西班牙地址生成策略

| 项目 | 核心内容 |
|---|---|
| 主源 | Dirección General del Catastro INSPIRE（Madrid 28900、Salamanca 37900、Albarracín 44009）+ Overture Maps addresses + Geofabrik Spain OSM 日更快照 |
| 既有门牌级格式 / 邮编 | `<street> <house>, <postcode> <municipality>, <province>, ES`；楼梯/门号仅保留真实字段；源记录；格式门禁 5 位数字。只清洗格式，不创造或按邻近地址补齐 |
| 行政区 | INE/IGN 行政边界作为候选核验；当前源字段与 catalog 反查。行政层级必须与坐标反查一致；冲突时保留源值在隔离区并拒绝发布 |
| 住宅子集证据 | Catastro BU `currentUse=1_residential` 且 `numberOfDwellings>0`，通过 14 位 referencia catastral 与 AD 地址稳定关联；其他源仍须具备明确住宅建筑/用途证据 |
| 真实字段 / 生成字段 | Catastro AD 的门牌、道路、市镇、邮编、语言和建筑关联键及其他来源地址字段均为真实字段；生成字段：无 |
| 坐标 / 去重 | Catastro EPSG:25830 坐标确定性转换为 WGS84；其他来源统一为 WGS84。按 referencia catastral/来源 ID 和规范化地址去重 |
| 街道级格式 | `<street>, <municipality>, <autonomous community>, ES`；`matchLevel=street`，门牌、楼栋、室号为空；可唯一确定的来源邮编保留，否则留空。 |
| 街道去重 / 验证 | 国家 + 规范行政层级 + 街道名，同一路段不同坐标、邮编或来源 ID 不增加条数；行政字段不使用最近目录点推断。 |
| 同步方式 | 自动初始化一次；显式来源探测发现 Catastro municipality ATOM 包或其他上游版本变化时才重建。新快照原子切换，失败保留上一 active 快照 |
| 既有官方住宅适配器 / 排除 | Catastro AD 门牌、道路、5 位邮编、`esp` 语言、municipality admin unit 和 EPSG:25830 坐标均必填，坐标确定性转换为 WGS84；邮编前两位只作一致性检查，不能反推地址。 |
| 策略版本 / 状态 / 更新 | 1.15 / Catastro 住宅建筑与地址稳定关联 + 解除旧区域容量截断 + 严格多规则完成下限 + 街道契约 street-v1 + address-structure-v1 + administrative-names-v19 + 热门优先 / 2026-10-20 |
共用规则（翻译、发布、生成、同步框架和结构门禁）见 [README.md](README.md)；本文件只记录本国差异。

- admin1 所属自治区与 Overture 一级行政区多边形不一致时（如 Jaraíz de la Vera 记为 Salamanca），按邮编前两位（INE 省份编号）改为多边形自治区内的省份，邮编给不出时改为自治区；同一自治区内邮编与最近目录城市一致指向另一省份时改为该省。目录中 Badajoz 的上级改为 Extremadura。
- 默认国家完成数量目标 80,000；它只是完成下限，不是发布上限。自治区、市镇、区采样上限为 80,000/70,000/300，允许完整接纳 Madrid 严格住宅候选。Catastro 三个已审计分片最多选择 80,500 条严格候选；行政区划与邮编目录保持完整。适配器能力版本 `inspire-residential-join-v2` 使此前被旧自治区采样上限截断的合格集合重新接受自动评估。

- 行政目录修订 4（2026-09-13）：按现有 ES 类型/代码将 Asturias 省（O）、Cantabria 省（S）、La Rioja 省（LO）分别关联 AS、CB、RI 自治区，修复自指父节点和路径；保留原 ID、城市、邮编和零节点。迁移与目录生成共用规则，缺失/歧义父节点或环路拒绝处理，不靠同名猜测。依据：[INE 自治区—省对应表](https://www.ine.es/daco/daco42/codmun/cod_ccaa_provincia.htm)及[省目录](https://www.ine.es/daco/daco42/codmun/cod_provincia.htm)。

## 既有来源街道提取（2026-09-08）

- Geofabrik `g70-streets` 提取来源命名道路及已有门牌，保留真实行政字段；道路点位于原始线几何，按国家/行政层/道路去重，不从最近目录点补行政区。街道楼栋、单元和住宅证据为空，邮编须经导入后推断唯一确定，否则不发布（2026-10-26）；非住宅门牌保留但不获得住宅用途。
- Overture `addresses-streets-residential-subset-v6` 保留来源街道和未匹配住宅建筑的真实门牌；仅实际相交且有明确住宅类别的门牌获得住宅证据，街道不得因落入建筑面而获得住宅用途。候选先去重再均衡采样；建筑分类失败保留地址事实，不伪造住宅证据。

- 单次上限（capacity-20261003）：overture（1 个分片）：单次上限 200,000；spain-catastro-residential（3 个分片）：单次上限 200,000/30,000/2,000；geofabrik（1 个分片）：单次上限 200,000。

- 来源缺少邮编时按顺序推断，且只在结果唯一时填写，冲突一律留空：
  1. GeoNames 邮编目录中同一一级行政区下该城市或区县只对应一个邮编，且目录坐标在约 30 km 内（CC BY 4.0）；
  2. 同一城市约 1 km 范围内至少 3 条来源自带邮编的地址邮编一致（推断出的邮编不参与投票）。

## 目录本地名核验（2026-10-11）

- 目录本地名修正：省级 7 条、城市 1964 条（已存地址由 catalog-native-addresses-v2 一次性改写）。

- 一级行政区多边形：目录层级与多边形不一致，仅排除境外坐标，不改写来源区域。

## 热门城市与热门地区优先（2026-10-19）

- Overture 导出改为热门优先配额（详见共用规则）：先统计各“一级行政区+城市”的地址数，每个城市保底 10 条，热门城市的都市圈（按名称或中心坐标半径归圈）补到每圈共 30,000 条，其余预算按目录人口平方根加权；按记录 ID 哈希切片抽样，预算增大只追加不替换。适配器修订为 `addresses-streets-residential-subset-v8-popular-ranks`（v8 起导出每行写明热门分层与排名，导入先按排名取热门都市圈配额，剩余名额再按保底、一级行政区下限和均衡规则分配，2026-10-25），所有 Overture 分片按新能力重新评估。
