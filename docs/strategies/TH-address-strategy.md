# TH 泰国地址生成策略

| 项目 | 核心内容 |
|---|---|
| 主源 | DPT 官方建筑图层 `dptc_bldg/MapServer/2` + Geofabrik `thailand`；两个来源独立保存版本、耗尽和失败状态 |
| 既有门牌级格式 / 邮编 | `<house> <road>, <tambon>, <amphoe>, <province> <postcode>, TH`；原生字段必须为泰文，邮编严格为 5 位数字。只清洗格式，不创造或按邻近地址补齐 |
| 行政区 | DPT `BL_TAMBOL → district`、`BL_AMPHOE → locality/postal_city`、`BL_CHANGWAT → admin1`；OSM `addr:subdistrict / addr:district / addr:province` 使用同一层级。DOPA 官方目录只做行政名称与坐标核验，不生成住宅门牌；admin1 错别字或带编号（如 จังหหวัด ชลบุรี、36 เชียงใหม่）按坐标多边形改为目录省名（administrative-names-v15） |
| 住宅子集证据 | DPT 仅接受明确住宅分类：`BL_CLASS17` 住宅、`BL_CLASS18/20/54` 集合住宅或公寓、`BL_CLASS22` 宿舍；OSM 仅接受明确住宅建筑标签。地址存在本身不构成住宅证据 |
| 街道级格式 | `<road>, <tambon>, <amphoe>, <province>, TH`；`matchLevel=street`，门牌、楼栋、室号为空；可唯一确定的来源邮编保留，否则留空。 |
| 街道去重 / 验证 | 国家 + 规范行政层级 + 街道名，同一路段不同坐标、邮编或来源 ID 不增加条数；行政字段不使用最近目录点推断。 |
| 同步方式 | 自动初始化一次；DPT 自动分页并保存 checkpoint。完整扫描或来源耗尽后停止；显式来源探测发现 DPT 编辑版本或 Geofabrik 版本变化时才构建新快照 |
| 既有官方住宅适配器 / 排除 | DPT 必须同时具有稳定 `BL_ID`、数字门牌、道路、Tambon、Amphoe、Province、5 位邮编、泰文行政与道路字段及泰国境内坐标；polygon 转 WGS84 点后仍须通过边界检查。任一缺失、冲突、重复或非住宅分类均拒绝。DOPA 公开数据不生成住宅门牌；Bangkok CSV 仍须独立完成字段和容量验证 |
| 策略版本 / 状态 / 更新 | 1.15 / DPT 严格住宅建筑自动同步 + Geofabrik 补充 + 街道契约 street-v1 + address-structure-v1 + administrative-names-v15 / 2026-10-14 |
共用规则（翻译、发布、生成、同步框架和结构门禁）见 [README.md](README.md)；本文件只记录本国差异。

- 默认国家完成数量下限 10,000；府、县、区单来源均衡采样上限 1,200/250/60，后台可覆盖；国家总量不是发布上限，行政区划与邮编目录保持完整。

- OSM 独立地址点仅在精确落入明确住宅建筑面时获得住宅用途证据；不使用附近建筑、同街道或邻近坐标推断。
- DPT polygon 请求转换为 WGS84（EPSG:4326），由适配器计算代表点；坐标必须位于泰国边界范围。稳定去重键由门牌、道路、Tambon、Amphoe、Province 和邮编组成，来源记录 ID 使用 `BL_ID`。
- DPT 来源版本由图层编辑时间、严格字段完整记录 ID 集及 `BL_UPDATED_DATE` 共同确定。未完成 checkpoint 位于受保护的来源状态目录，成功或版本变化后由适配器定向清除；超时且游标前进时作为可恢复 partial 进入统一防空转策略。
- DPT 官方图层：<https://bcbgis.dpt.go.th/arcgis/rest/services/DPTC_BCB_UAT/dptc_bldg/MapServer/2>。
- DOPA 依据：<https://www.bora.dopa.go.th/bora-web-portal>、<https://www.bora.dopa.go.th/app-thaid>。

- 发布校验与数量口径（2026-09-06）：必填字段和中英文版本未就绪的记录不计入生成、国家总量或行政覆盖。历史记录自动复核，淘汰后刷新来源数量、生成索引和覆盖统计；索引切换在同一事务完成。

## Google 真实地址补全

- 数据源：既有 Geofabrik OSM 住宅建筑、来源地址及命名道路种子；Google 返回实际道路、门牌、行政区与坐标，住宅用途只能来自独立 OSM 建筑证据。
- 调度：优先查询官方目录中零覆盖、未达最低数量和一级/二级数量不足的节点。目录中心点仅用于种子排序；最终行政归属仍由 Google 响应通过官方目录与坐标门禁后确定。
- 真实字段：Google Geocoding v4 的门牌、道路、行政区、可唯一确认的邮编、WGS84 坐标和 Place ID；同响应补齐只接受国家及已有父级一致、候选值唯一的行政字段。无生成地址字段。
- 同步：配置 Google Geocoding 凭据后按有界批次执行。checkpoint 按适配器版本、上游 PBF 版本和提取策略隔离；连续批次没有总量、覆盖或节点进展时标记来源已达上限，凭据或额度等待不会误判为耗尽。
- 门禁：逐条检查同响应的 route/street_address/premise/subpremise，国家、行政层、本国语言和种子几何均须匹配；坐标位于住宅 polygon 内或距种子点不超过 15 米。street 没有门牌/住宅证据；真实门牌保留，未知或歧义邮编留空。
- 去重：门牌保留来源稳定身份；街道按国家、规范行政层与道路名去重，恢复时从已有规范化输出重建去重集合。所有实际 HTTP dispatch 计入预算，失败与 Key 轮换不能绕过额度。
- 适配器版本：`osm-address-street-google-geocoding-v9`；2026-09-08。

## 既有来源街道提取（2026-09-08）

- Geofabrik `g70-streets` 提取来源命名道路及已有门牌，保留真实行政字段；道路点位于原始线几何，按国家/行政层/道路去重，不从最近目录点补行政区。街道邮编、楼栋、单元和住宅证据为空；非住宅门牌保留但不获得住宅用途。

## 城市级契约与行政边界补全（2026-10-01）

- 必填行政层级降为“一级行政区（如适用）+ 城市”，district 改为可选：来源有值时保留，缺失时用官方/开放行政边界按坐标补全，补不到则留空，不再整条拒绝。街道和门牌仍必须来自来源，坐标、国家边界、语言和邮编门禁不变。
- 边界数据：Royal Thai Survey Department COD-AB（OCHA HDX，CC BY-IGO）：ADM3 ตำบล/แขวง（泰文名）→ district，ADM2 อำเภอ/เขต → locality。
- 补全规则：只填补来源为空的 district，或与城市同名的 district；来源已有值不覆盖；坐标不落在任何边界内则不补；城市只在来源与目录补全后仍为空时用边界补。边界名称直接取自数据集，不翻译反推。
- Geofabrik、Overture、OpenAddresses 三类批量来源的能力指纹附加本国边界版本，仅这些来源因能力变化重新执行一次；其他来源的耗尽状态不受影响。

## Google 结果与城市级字段（2026-10-02）

- 适配器版本 `osm-address-street-google-geocoding-v10-city-level`（Mappls 为 `osm-source-address-street-mappls-reverse-v5-city-level`）。
- Google 结果落在 OSM 种子建筑外或 15 米外时，不再以 `geometry_mismatch` 丢弃：作为 Google 自身坐标的真实地址发布，`property_type=unknown`，不借用 OSM 住宅证据；只有落在种子建筑内的结果才标记住宅。
- 住宅结果只要求门牌、道路及城市级行政字段（府、区）；区县和邮编来源有值时保留，缺失、冲突或格式无效时留空，不淘汰地址。
- 通用规则：中国以外无法验证的邮编留空，本地数字（阿拉伯-印度、泰文）先转为 ASCII。

- 单次上限（capacity-20261003）：thailand-dpt-residential（1 个分片）：单次上限 100,000；google-residential-enrichment（1 个分片）：API 来源，上限保持 10000，不增加付费或额度消耗；geofabrik（1 个分片）：单次上限 200,000。

- 来源缺少邮编时按顺序推断，且只在结果唯一时填写，冲突一律留空：
  1. GeoNames 邮编目录中同一一级行政区下该城市或区县只对应一个邮编，且目录坐标在约 30 km 内（CC BY 4.0）；
  2. 同一城市约 1 km 范围内至少 3 条来源自带邮编的地址邮编一致（推断出的邮编不参与投票）。

## 目录本地名核验（2026-10-11）

- 目录本地名修正：省级 2 条、城市 6 条（已存地址由 catalog-native-addresses-v2 一次性改写）。

- 一级行政区多边形：纠正与坐标冲突或无法识别的来源区域，并排除境外坐标。
