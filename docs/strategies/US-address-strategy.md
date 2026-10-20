# US 美国地址生成策略

| 项目 | 核心内容 |
|---|---|
| 主源 | Overture Maps addresses（全国分片 + 50 州与 DC 独立分片 `overture-usa-structures-<州>`）+ Geofabrik 美国 50 州、DC、Puerto Rico、US Virgin Islands 独立分片 |
| 既有门牌级格式 / 邮编 | `<house> <street>, <city>, <state> <ZIP>, US`；地址行使用源记录，不拼接虚构 Apt/Unit；源记录 ZIP/ZIP+4；仅接受 `\d{5}` 或 `\d{5}-\d{4}`，不自行推算 ZIP。只清洗格式，不创造或按邻近地址补齐 |
| 行政区 | Census TIGER/Line 与 Census Gazetteer 作为交叉核验候选；当前入库行政层级来自同步源字段与本地 catalog 反查。行政层级必须与坐标反查一致；冲突时保留源值在隔离区并拒绝发布。州代码保留在本地与英文版，中文版使用目录州名；属地 PR/VI/GU/AS/MP 使用固定名称（波多黎各、美属维尔京群岛等），城市字段只有州代码（如 `VI`）的记录不发布；PR、VI 等领地不在州目录中，下拉以领地名（如 Puerto Rico（PR）波多黎各）自成选项，不按同名城镇并入其他州 |
| 住宅子集证据 | OSM `building=house/apartments/...`、Overture buildings 明确住宅类别，或 FEMA/ORNL USA Structures 最近建筑（≤约 30 m）为 `OCC_CLS=Residential` 且 `PRIM_OCC` 为独栋、多户或活动房屋；没有证据只进隔离区，不进入住宅发布池。住宅证据必须来自明确建筑/用途字段，不能由地址存在推断 |
| 真实字段 / 生成字段 | 门牌、道路、城市、州代码、ZIP、可选单元和坐标均来自来源；生成字段：无，不拼接 Apt/Unit |
| 坐标 / 去重 | 来源坐标统一为 WGS84 并按美国本土及属地边界门禁；按来源 ID 和规范化地址 canonical hash 去重 |
| 街道级格式 | `<street>, <city>, <state code>, US`；`matchLevel=street`，门牌、楼栋、室号为空；可唯一确定的来源邮编保留，否则留空。 |
| 街道去重 / 验证 | 国家 + 规范行政层级 + 街道名，同一路段不同坐标、邮编或来源 ID 不增加条数；行政字段不使用最近目录点推断。 |
| 同步方式 | 自动初始化一次；各州/地区来源独立保存状态。显式来源探测发现 Overture 或 Geofabrik 版本变化时才构建新快照 |
| 既有门牌来源验证 / 排除 | 行政区冲突、缺真实道路或坐标越界的记录淘汰；未知 ZIP 留空，地址节点名称不作为住宅楼名，普通真实门牌不强制住宅用途。 |
| 策略版本 / 状态 / 更新 | 1.14 / 分州 Overture + USA Structures 住宅佐证 + 容量扩展 + address-structure-v1 + administrative-names-v19 + 热门优先 / 2026-10-20 |
共用规则（翻译、发布、生成、同步框架和结构门禁）见 [README.md](README.md)；本文件只记录本国差异。

- 默认国家完成数量下限 50,000；州、县市、地区单来源均衡采样上限 2,000/300/80，后台可覆盖；国家总量不是发布上限，行政区划与邮编目录保持完整。

## 既有来源街道提取（2026-09-08）

- Geofabrik `g70-streets` 提取来源命名道路及已有门牌，保留真实行政字段；道路点位于原始线几何，按国家/行政层/道路去重，不从最近目录点补行政区。街道邮编、楼栋、单元和住宅证据为空；非住宅门牌保留但不获得住宅用途。
- Overture `addresses-streets-residential-subset-v6` 保留来源街道和未匹配住宅建筑的真实门牌；仅实际相交且有明确住宅类别的门牌获得住宅证据，街道不得因落入建筑面而获得住宅用途。候选先去重再均衡采样；建筑分类失败保留地址事实，不伪造住宅证据。

- 单次上限（capacity-20261003）：overture（1 个分片）：单次上限 200,000；geofabrik（53 个分片）：单次上限 50,000。

## 分州 Overture + USA Structures（2026-10-03）

- 导入去重：同一数据集中解析到同一地址行的后续记录按重复拒绝，保证每条地址仅一条主证据。
- 数据源：Overture addresses 最新发布按州分片读取（州 bbox 选资产，`address_levels[1]` 等于州代码过滤），地址、门牌、城市、州、ZIP、坐标均来自 Overture 原记录（主要为 USDOT NAD 与州县公开地址），不插值、不推算门牌。
- 住宅佐证：每州读取 FEMA/ORNL USA Structures 当期州 FileGDB。来源为公开 S3 列表 `https://fema-femadata.s3.amazonaws.com/?list-type=2&prefix=Partners/ORNL/USA_Structures/`（原下载页已跳转为无直链页面），按州目录选取日期最新且日期合法的 `DeliverableYYYYMMDD<州>.zip` 或 `<州>_Structures_YYYYMMDD.zip`，文件名日期作为来源版本。地址点约 30 m 内最近建筑的 `OCC_CLS=Residential` 且 `PRIM_OCC` 属于 Single Family Dwelling / Multi - Family Dwelling / Manufactured Home 时标为住宅（多户为 apartment），证据为该建筑 UUID；最近建筑为非住宅、无建筑或其他住宅子类（临时住宿、宿舍、养老院）时作为普通真实地址发布，不声称住宅。
- 选择：全州地址先完成佐证，再按住宅优先、各城市轮流（hash 稳定顺序）选取，单次上限 200,000 且受存储份额约束；邻近地址随上限增长自然补入。
- 版本：数据集版本为 `<Overture 发布>+usa-structures-<交付日期>`，能力指纹 `usa-structures-nearest-30m-v1` / `state-partition-locality-round-robin-v1`；任一变化才重新运行该州。
- 许可与风险：USA Structures 由联邦机构公开发布，未见明示许可证；占用分类部分来自宗地数据与模型，交付日期 2023–2025，新建或拆除建筑可能未反映。原始 ZIP 与解压文件在导出后删除，不入库。
- 2026-10-03 只读探测（Mississippi）：Overture 门牌地址 1,153,547；建筑内住宅 440,231，最近 30 m 内住宅 373,041，最近为非住宅 141,392，30 m 内无建筑 198,883。

- 来源缺少邮编时按顺序推断，且只在结果唯一时填写，冲突一律留空：
  1. 坐标落在且仅落在一个邮政区多边形内：美国人口普查局 TIGER/Line 2020 ZCTA5（公有领域；ZCTA 近似 USPS 邮编，个别乡村地址可能不同）；
  2. GeoNames 邮编目录中同一一级行政区下该城市或区县只对应一个邮编，且目录坐标在约 30 km 内（CC BY 4.0）；
  3. 同一城市约 1 km 范围内至少 3 条来源自带邮编的地址邮编一致（推断出的邮编不参与投票）。

## 缺少州档案（2026-10-10）

- USA Structures 列表中缺少某州档案时，该州不再使整次美国同步失败：记录警告，地址照常导入，住宅佐证回退到 Overture Buildings；没有住宅证据的地址仍只作普通真实地址发布。

## 目录本地名核验（2026-10-11）

- 目录本地名修正：省级 3 条、城市 1119 条（已存地址由 catalog-native-addresses-v2 一次性改写）。

- 一级行政区多边形：纠正与坐标冲突或无法识别的来源区域，并排除境外坐标。

## 热门城市与热门地区优先（2026-10-19）

- Overture 导出改为热门优先配额（详见共用规则）：先统计各“一级行政区+城市”的地址数，每个城市保底 10 条，热门城市的都市圈（按名称或中心坐标半径归圈）补到每圈共 30,000 条，其余预算按目录人口平方根加权；按记录 ID 哈希切片抽样，预算增大只追加不替换。适配器修订为 `addresses-streets-residential-subset-v7-popular-cities`，所有 Overture 分片按新能力重新评估。
- 热门州分片优先调度并提高上限（优先级/上限）：CA 1/150,000、TX 2/120,000、FL 3/100,000、NY 4/120,000、WA 5/60,000、IL 6/60,000、MA 7/50,000、NJ 8/50,000、PA 9/50,000、GA 10/50,000、VA 11/40,000、NV 12/40,000；AL、AR、AZ 保持已导入的 50,000，其余州上限 20,000。分州采样标识改为 `state-partition-popular-city-weighted-v2`。纽约市地址按邮政惯例以行政区（Manhattan、Brooklyn、Queens、The Bronx、Staten Island）为城市，城市搜索“New York / New York City / NYC / 纽约”返回这五个区。热门城市快捷入口按目录人口最多的同名城市解析（Houston 取得州）。
