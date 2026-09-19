# API Key 配置

[English](API_KEYS.md) · [简体中文](API_KEYS.zh-CN.md) · [繁體中文](API_KEYS.zh-TW.md)

在“后台 → 服务凭据”添加凭据。同一平台可以添加多组凭据，系统会自动轮换。

| 平台 | 对应国家或功能 | 后台配置名称 |
|---|---|---|
| 高德 WebService | 中国地址同步 | 高德地图 |
| 百度地图 | 中国地址同步 | 百度地图 |
| 腾讯位置服务 | 中国地址同步 | 腾讯地图 |
| Mappls Reverse Geocoding | 印度地址补全 | Mappls |
| OneMap | 新加坡地址同步 | OneMap |
| Geoapify Reverse Geocoding | 韩国地址与邮编补全 | Geoapify |
| Google Geocoding | 支持的低数量国家真实街道与门牌补全 | Google Geocoding |
| 有道文本翻译 | 地址翻译 | 有道翻译 |
| DeepL API Free | 支持自定义路由优先级的地址翻译 | DeepL Free |
| OpenAI 兼容 Chat Completions | 使用可配置模型翻译地址 | OpenAI 兼容接口 |
| 高德 JavaScript API | 中国前端地图 | 高德前端地图 |

## 高德 WebService

1. 打开[高德开发者控制台](https://console.amap.com/dev/index)。
2. 按[官方指南](https://lbs.amap.com/api/webservice/create-project-and-key)创建应用和 **WebService** Key。
3. 配置服务器 IP 限制，在“高德地图”下添加 Key。

## 百度地图

1. 打开[百度地图 API 控制台](https://lbsyun.baidu.com/apiconsole/key)。
2. 创建“服务端”应用并开通地点检索 Web API。
3. 配置服务器 IP 限制，在“百度地图”下添加 AK。

## 腾讯位置服务

1. 打开[腾讯位置服务控制台](https://lbs.qq.com/dev/console/application/mine)。
2. 创建应用并开通 **WebService API**。
3. 配置服务器 IP 或签名限制，在“腾讯地图”下添加 Key。

## Mappls Reverse Geocoding

1. 在 [Mappls 控制台](https://auth.mappls.com/console/)创建应用。
2. 开通 **Reverse Geocoding API**，从 credentials 区域复制静态 Key。
3. 配置服务器 IP 限制，在“Mappls”下添加 Key。

接口以 [Mappls Reverse Geocoding 官方文档](https://developer.mappls.com/documentation/sdk/rest-apis/mappls-maps-reverse-geocoding-rest-api-example/Readme/)为准。

## OneMap

1. 注册 [OneMap API](https://www.onemap.gov.sg/apidocs/register)。
2. 通过[认证接口](https://www.onemap.gov.sg/apidocs/authentication)生成 Access Token。
3. 在“OneMap”下添加 Token，并在三天有效期结束前替换。

## Geoapify

1. 在 [Geoapify MyProjects](https://myprojects.geoapify.com/)创建项目。
2. 复制项目 API Key。
3. 在“Geoapify”下添加 Key。

参见[反向地理编码官方文档](https://apidocs.geoapify.com/docs/geocoding/reverse-geocoding/)。

## Google Geocoding

1. 创建或选择 Google Cloud 项目并关联结算账户。
2. 按[官方配置指南](https://developers.google.com/maps/documentation/geocoding/get-api-key)开通 **Geocoding API**。
3. 创建服务端 Key，将它限制到 Geocoding API 和部署服务器 IP，在“Google Geocoding”下添加。

项目使用 Geocoding API v4，不需要 Places API。

## DeepL API Free

在“在线翻译 → DeepL Free”添加以 `:fx` 结尾的免费 Key，自定义项目字符上限，再点击“测试”查询额度，不消耗翻译字符。默认上限为 500,000，但最终同时受账户实际额度约束。仅允许 `https://api-free.deepl.com`，拒绝 Pro Key 和付费端点。

API 与同步共用加密凭据 Broker 和持久 Unicode 字符账本；账户额度与所有启用 DeepL Key 的配置上限取最低值。翻译前原子预留字符，响应丢失不退回；重启、换 Key 或本地月份变化不会重置累计值。用量查询和翻译合计两次上游请求，均遵守 QPS 限制。

[官方用量](https://developers.deepl.com/docs/admin/retrieving-usage-data)可能延迟数分钟，[Free 用量响应](https://developers.deepl.com/api-reference/usage-and-quota/check-usage-and-limits)可能不含计费周期日期。没有可信新周期时，本地账本不会自动清零，可能提前降级。相同账户的外部应用不受本项目控制，Free 官方硬上限是最后保障；不能通过清空账本绕过等待。

## 有道文本翻译

**付费服务：** 有道按用量计费，试用额度可能有限；用完后，测试和自动翻译都可能扣除账户余额。项目配额及补全字符预算只是内部限额，不保证调用处于供应商免费额度内。启用前请核对[有道官方计费说明](https://ai.youdao.com/DOCSIRMA/html/trans/price/plwbfy/index.html)和账户状态；不接受费用时，请勿配置或启用凭据。

1. 注册[有道智云](https://ai.youdao.com/)。
2. 创建应用并开通文本翻译。
3. 在“在线翻译”中添加应用 ID 和应用密钥。

每条配置保存一组 ID/密钥，支持添加多组。

翻译优先检查合格本地变体和缓存，然后按优先级数值从小到大尝试已启用的在线路由；同优先级使用轮询，不可用、冷却中、额度耗尽或失败的路由会被跳过。新建 OpenAI 兼容路由默认排在 DeepL、有道和已启用的免密钥谷歌网页翻译之前，但管理员可以修改每条路由的优先级。谷歌不是 Google Cloud Translation 计费 API，可能限流或不可用，不保证永久、无限免费。不接受付费供应商费用时，请保持未配置或停用。

## OpenAI 兼容 Chat Completions

在“在线翻译”中填写接口地址和 API Key，获取实时模型列表后选择支持 Chat Completions 的模型，不预设固定模型。支持完整的 `/chat/completions` 或 `/models` 地址，保留自定义 API 路径前缀；基础地址须包含供应商 API 前缀（如 `/v1`）。保留接口声明的协议限制和思考强度，完整下拉列表展示接口返回的全部模型，不兼容模型显示原因并禁用选择；展开时不按已保存值过滤，输入时可搜索。接口未提供思考强度时明确提示，并允许填写供应商文档支持的值；项目默认显式发送 `low`，旧配置中的 `default` 也按 `low` 处理，其他显式值原样发送。切换模型时，若接口提供的档位不包含 `low`，则优先采用接口声明的首个档位。这不代表供应商在省略参数时默认使用 `low`。默认项目上限为每天 1,000 次、每秒 1 次，可按部署情况调整。

服务端发送非流式 Chat Completions 请求，并使用只翻译地址组件的严格 JSON 提示词。输入值会被当作不可信地址数据，而不是指令。返回结果必须保留数字和标识符，并通过现有语言和发布门禁后才会缓存或发布。API Key 在控制数据库中加密保存，普通凭据列表不会返回；点击“测试”只执行小型合成请求并报告成功状态和结果数量。

远程服务只接受 HTTPS；明文 HTTP 仅允许 localhost。启用前请确认供应商的数据处理、服务条款和模型计费方式。

## 高德 JavaScript API

1. 在高德控制台单独创建 **JavaScript API** Key 和安全密钥。
2. 将 Key 限制到正式域名。
3. 在“高德前端地图”中添加两个值。

不要与高德 WebService Key 共用。

翻译优先级在每个 API Key 的编辑框中设置，DeepL、有道、OpenAI 兼容密钥互相独立；旧方式优先级只作为首次迁移默认值。Google 网页翻译没有 Key，优先级放在其开关旁。独立优先级面板已移除。模型输入框旁可获取实时列表，也可直接输入模型名称；获取成功会回填实际 API 前缀。固定提示词以质量优先，要求严格 JSON、一一对应和数字标识符保留。

首次导入启用在线翻译时，同样按每个 Key 的优先级调度并通过代理记账。地址字段修正后，旧展示译文缓存自动失效。模型获取支持秒数和 HTTP 日期形式的 Retry-After。试用或新用户奖励不保证周期续期；DeepL 一次性奖励不会被本地自动补充。
