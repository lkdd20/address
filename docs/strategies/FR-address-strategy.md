# FR 法国地址生成策略

| 项目 | 核心内容 |
|---|---|
| 主源 | Overture Maps addresses + Geofabrik 法国区域独立分片；CSTB BDNB `2026-02.a` 的 Creuse（23）、Gironde（33）、Rhone（69）和 Paris（75）通过 BAN 地址键提供独立官方住宅证据 |
| 既有门牌级格式 / 邮编 | `<number> <street>, <postcode> <commune>, FR`；地址补充（bis/ter）仅保留源值；源记录；格式门禁 5 位数字。只清洗格式，不创造或按邻近地址补齐 |
| 行政区 | INSEE/IGN ADMIN EXPRESS 作为候选核验；当前源字段与 catalog 反查。行政层级必须与坐标反查一致；冲突时保留源值在隔离区并拒绝发布 |
| 住宅子集证据 | 明确住宅建筑用途证据；BDNB 仅接受 `usage_principal_bdnb_open` 为 `Résidentiel individuel` 或 `Résidentiel collectif` 的建筑，并要求 BAN 关联 `fiabilite >= 17`。BAN 地址存在本身不等于住宅 |
| 真实字段 / 生成字段 | BDNB/BAN 的门牌、道路、commune、邮编、住宅用途和建筑关联字段及地图来源地址字段均为真实字段；生成字段：无 |
| 坐标 / 去重 | BDNB EPSG:2154 坐标转换为 WGS84；地图来源统一为 WGS84。按 BDNB/BAN 关联键、来源 ID 和规范化地址去重 |
| 街道级格式 | `<street>, <commune>, FR`；`matchLevel=street`，门牌、楼栋、室号为空；可唯一确定的来源邮编保留，否则留空。 |
| 街道去重 / 验证 | 国家 + 规范行政层级 + 街道名，同一路段不同坐标、邮编或来源 ID 不增加条数；行政字段不使用最近目录点推断。 |
| 同步方式 | 自动初始化一次；显式来源探测发现 BDNB millésime 或地图来源版本变化时才重建。各 département 独立保存状态，新快照失败不影响已有 active 数据 |
| 既有官方住宅适配器 / 排除 | 既有 BDNB 住宅适配器要求门牌、道路、5 位邮编、INSEE commune、合法坐标与住宅证据，只接受 BAN 地址并将 EPSG:2154 转为 WGS84；海外区域使用离散坐标范围，禁止跨洋矩形误收 |
| 策略版本 / 状态 / 更新 | 1.13 / BDNB 多 département 严格住宅关联 + 解除旧区域容量截断 + 多规则完成下限 + 街道契约 street-v1 + address-structure-v1 / 2026-10-11 |
共用规则（翻译、发布、生成、同步框架和结构门禁）见 [README.md](README.md)；本文件只记录本国差异。

- 默认国家完成数量下限为 80,000，不是发布上限；大区、市镇、区采样上限为 80,000/1,500/300，后台可覆盖。每个 BDNB département 分片最多采样 50,000 条，严格门禁容量不足时不得降低可靠度阈值补数量。适配器能力版本 `bdnb-ban-fiabilite17-v2` 使此前被旧大区采样上限截断的合格集合重新接受自动评估；各 département 的版本、失败和来源耗尽状态相互独立。

## BDNB 字段与联接

- `batiment_groupe_synthese_propriete_usage.csv`：`batiment_groupe_id`、`usage_principal_bdnb_open` 提供住宅类型。
- `rel_batiment_groupe_adresse.csv`：以 `batiment_groupe_id` 关联住宅建筑，并仅保留 `fiabilite >= 17` 的 `cle_interop_adr`。
- `adresse.csv`：以 `cle_interop_adr` 关联 BAN 门牌、道路、邮编、INSEE commune 和 EPSG:2154 地址点。
- 同一 BAN 地址关联多个住宅建筑时，稳定选择可靠度最高的建筑；可靠度相同按建筑 ID 稳定选择。地址点、行政区和邮编不从邻近建筑推断。

## 既有来源街道提取（2026-09-08）

- Geofabrik `g70-streets` 提取来源命名道路及已有门牌，保留真实行政字段；道路点位于原始线几何，按国家/行政层/道路去重，不从最近目录点补行政区。街道邮编、楼栋、单元和住宅证据为空；非住宅门牌保留但不获得住宅用途。
- Overture `addresses-streets-residential-subset-v6` 保留来源街道和未匹配住宅建筑的真实门牌；仅实际相交且有明确住宅类别的门牌获得住宅证据，街道不得因落入建筑面而获得住宅用途。候选先去重再均衡采样；建筑分类失败保留地址事实，不伪造住宅证据。

- 单次上限（capacity-20261003）：overture（1 个分片）：单次上限 200,000；france-bdnb-residential（4 个分片）：单次上限 200,000；geofabrik（27 个分片）：单次上限 50,000。

- 来源缺少邮编时按顺序推断，且只在结果唯一时填写，冲突一律留空：
  1. GeoNames 邮编目录中同一一级行政区下该城市或区县只对应一个邮编，且目录坐标在约 30 km 内（CC BY 4.0）；
  2. 同一城市约 1 km 范围内至少 3 条来源自带邮编的地址邮编一致（推断出的邮编不参与投票）。

## 目录本地名核验（2026-10-11）

- 目录本地名修正：省级 5 条、城市 35 条（已存地址由 catalog-native-addresses-v2 一次性改写）。

- 一级行政区多边形：目录层级与多边形不一致，仅排除境外坐标，不改写来源区域。
