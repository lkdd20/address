# HK 中国香港地址生成策略

| 项目 | 核心内容 |
|---|---|
| 主源 | 香港房屋委员会公共租住房屋单位数据 + Digital Policy Office Address Lookup Service（ALS）；香港屋宇署楼宇资料及楼龄纪录 |
| 既有门牌级格式 / 邮编 | `<单位/楼层>, <楼宇>, <门牌> <街道>, <地点>, <18区>, <香港島/九龍/新界>, Hong Kong`；香港没有通用邮编，canonical postcode 保持空值，`999077` 不得入库。 |
| 行政区 | `admin1=地域` 仅允许香港島、九龍、新界；`locality=行政区` 仅允许官方 18 区；`district=地点`。金鐘属于地点，葵青區属于行政区，不得跨层复用；区与地域归属不一致的记录拒绝发布。 |
| 语言 | 原始语言固定为 `zh-HK`，组件和完整地址使用繁体中文；英文单独存入 `en`，简体中文单独存入 `zh-CN`。双语源在导入时拆分，旧记录读取时以简体变体转繁体纠正，不把英文作为原始语言 |
| 住宅子集证据 | 公屋单位由房委会库存直接证明；私人楼宇只接受屋宇署 `Residential/Composite` 且建筑类型为 `Tower` 的记录，不把 podium、商业、工业或其他用途作为住宅 |
| 真实字段 / 生成字段 | 单位/楼层、楼宇、门牌、街道、地点、18 区、地域和坐标来自房委会、ALS 或屋宇署；生成字段：无 |
| 坐标 / 去重 | 官方坐标统一为 WGS84 并通过香港边界门禁；按官方楼宇/单位 ID 和规范化双语门牌地址去重 |
| 街道级格式 | `<三大地域><十八区><街道>`；`matchLevel=street`，门牌、楼栋、室号为空；香港没有通用邮编，postcode 始终留空。 |
| 街道去重 / 验证 | 国家 + 规范行政层级 + 街道名，同一路段不同坐标、邮编或来源 ID 不增加条数；行政字段不使用最近目录点推断。 |
| 同步方式 | 屋宇署年度快照直接导出；房委会季度数据按楼宇去重查询 ALS，并缓存官方门牌、街道和楼宇坐标。新快照通过门禁后原子切换，失败保留上一 active 快照 |
| 既有官方住宅适配器 / 排除 | 仅保留 `Residential/Composite` Tower、官方 18 区、唯一双语街道门牌和香港范围坐标；房委会记录必须与 ALS 精确匹配。 |
| 策略版本 / 状态 / 更新 | 2.8 / 官方 3 地域和 18 区共享目录 + 独立行政派生 + 街道契约 street-v1 + address-structure-v1 + administrative-names-v9（仅城市字段门禁） / 2026-10-13 |
共用规则（翻译、发布、生成、同步框架和结构门禁）见 [README.md](README.md)；本文件只记录本国差异。

- 默认国家完成数量下限 20,000；地域、行政区、地点单来源均衡采样上限 10,000/2,000/300，后台可覆盖；国家总量不是发布上限，行政区划目录保持完整。规范化缓存身份包含有效记录上限和行政节点上限，提升配额后不会复用旧的 10,000 条缓存。

- 房委会与 ALS 只在中文屋邨名、楼宇名和区名完全一致且结果唯一时合并；ALS 楼宇坐标与房委会屋邨坐标偏差超过 0.02 度时淘汰。

- 屋宇署完整地址中的剩余文本不推断为楼宇名；仅保存官方完整地址供审计。楼宇名、楼层和单位只由房委会与 ALS 精确匹配结果提供。

- 同一官方记录含多个街道门牌，或中英文街道无法唯一对应同一门牌号时直接淘汰，不任意选择其中一个入口。

- 官方来源：[房委会公共租住房屋库存](https://data.gov.hk/en-data/dataset/hk-housing-emms-emms-housing-stock)、[ALS](https://data.gov.hk/en-data/dataset/hk-dpo-als_01-als)、[屋宇署楼宇资料及楼龄纪录](https://data.gov.hk/en-data/dataset/hk-bd-opendata-building-information)。DATA.GOV.HK 数据条款要求在再分发时保留来源署名和免责声明。

## 既有来源街道提取（2026-09-08）

- Geofabrik `g70-streets` 提取来源命名道路及已有门牌，保留真实行政字段；道路点位于原始线几何，按国家/行政层/道路去重，不从最近目录点补行政区。街道邮编、楼栋、单元和住宅证据为空；非住宅门牌保留但不获得住宅用途。
- Overture `addresses-streets-residential-subset-v6` 保留来源街道和未匹配住宅建筑的真实门牌；仅实际相交且有明确住宅类别的门牌获得住宅证据，街道不得因落入建筑面而获得住宅用途。候选先去重再均衡采样；建筑分类失败保留地址事实，不伪造住宅证据。

## Administrative projection revision 1 (2026-09-13)

- A unique recognized official district supplies its parent geographic region. Conflicting explicit regions/districts, including native administrative codes, are rejected; unrecognized nonempty parent labels stay unresolved. Country-level Hong Kong alone is not an island assignment. Independently versioned derived IDs/labels are shared by generation, filters and both coverage paths; source fields are not overwritten. Stale input hashes disable the derivation.
- Legacy district labels in `admin1` and the existing source catalog's 18 aliases (`HWC`, `KKT`, etc.) are district evidence, not region codes. They must agree with the independently recognized locality district; conflicting codes/names and unrecognized neighborhoods remain excluded. The explicit alias table was checked against [Countries States Cities Database](https://raw.githubusercontent.com/dr5hn/countries-states-cities-database/master/json/states.json) on 2026-09-13; parent membership follows [Home Affairs Department](https://www.had.gov.hk/en/18_districts/my_map.htm), reviewed 2026-01-21. No nearest-place inference or address source rerun is involved.
- Native Han counterparts are recovered per semantic field, preserving numeric identities. Latin source text is retained when no valid counterpart exists and remains unpublished under the native-script contract; it is not erased and mislabeled as a missing street.

- 单次上限（capacity-20261003）：overture（1 个分片）：单次上限 200,000；hong-kong-residential（1 个分片）：单次上限 100,000；geofabrik（1 个分片）：单次上限 200,000。

- 本国邮编精细到街道或楼栋（或不使用邮编），不按区域或邻近地址推断；来源缺失时保持留空。

## 屋宇署来源发现（2026-10-10）

- 屋宇署数据集在 DATA.GOV.HK 更换了资源 ID，旧资源页返回 404，自 2026-08-17 起同步失败。发现改用 CKAN `package_show?id=hk-bd-opendata-building-information`：取状态为 active、下载地址为 `static.csdi.gov.hk/.../csv` 的资源，资源 `metadata_modified` 日期作为来源版本。数据集 ID 不变时，资源再次替换无需改代码；字段映射、住宅门禁和导出版本不变。
