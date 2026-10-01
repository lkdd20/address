# API Key 配置

[English](API_KEYS.md) · 简体中文 · [繁體中文](API_KEYS.zh-TW.md)

**所有第三方密钥都是可选的。** 不配置任何密钥时，Address 只使用官方登记和开放地图等无需授权的数据源。下列密钥用于扩充特定国家的数据、启用在线翻译或在网页上显示高德地图。

所有密钥都在管理后台 **集成 → 地图密钥** 页面中添加，加密保存在数据库里，列表中只显示掩码。

## 一览

| 平台 | 用途 | 后台位置 |
|---|---|---|
| [高德 WebService](#高德-webservice) | 中国地址同步 | 地图密钥 → 高德地图 |
| [百度地图](#百度地图) | 中国地址同步 | 地图密钥 → 百度地图 |
| [腾讯位置服务](#腾讯位置服务) | 中国地址同步 | 地图密钥 → 腾讯地图 |
| [Google Geocoding](#google-geocoding) | 为数据较少的国家补全街道与门牌 | 地图密钥 → Google Geocoding |
| [Geoapify](#geoapify) | 韩国地址与邮编补全 | 地图密钥 → Geoapify |
| [Mappls](#mappls) | 印度地址补全 | 地图密钥 → Mappls |
| [OneMap](#onemap) | 新加坡地址同步 | 地图密钥 → OneMap |
| [DeepL API Free](#deepl-api-free) | 地址翻译 | 在线翻译 → DeepL |
| [有道文本翻译](#有道文本翻译) | 地址翻译（付费） | 在线翻译 → 有道翻译 |
| [OpenAI 兼容接口](#openai-兼容接口) | 用任意 Chat Completions 模型翻译地址 | 在线翻译 → OpenAI 兼容接口 |
| [高德 JavaScript API](#高德-javascript-api) | 在网页上显示高德地图 | 高德前端地图凭据 |

**多个密钥自动轮换。** 同一平台可以添加多个密钥：某个密钥失败时会先冷却，系统改用其他密钥；全部不可用时，等待最早恢复的那个。每个密钥都可以单独设置额度上限。

## 地图与地理编码

### 高德 WebService

1. 打开[高德开发者控制台](https://console.amap.com/dev/index)，按[官方指南](https://lbs.amap.com/api/webservice/create-project-and-key)创建应用和 **Web 服务** Key；
2. 限制为服务器 IP；
3. 在“高德地图”下添加。

### 百度地图

1. 在[百度地图 API 控制台](https://lbsyun.baidu.com/apiconsole/key)创建 **服务端** 应用，开通地点检索；
2. 限制为服务器 IP；
3. 在“百度地图”下添加 AK。

### 腾讯位置服务

1. 在[腾讯位置服务控制台](https://lbs.qq.com/dev/console/application/mine)创建应用，开通 **WebServiceAPI**；
2. 配置服务器 IP 或签名校验；
3. 在“腾讯地图”下添加。

### Google Geocoding

1. 在 Google Cloud 创建项目并绑定结算账户；
2. 按[官方指南](https://developers.google.com/maps/documentation/geocoding/get-api-key)开通 **Geocoding API**，创建仅限 Geocoding API 和服务器 IP 的 Key；
3. 在“Google Geocoding”下添加。

项目使用 Geocoding API v4，不需要 Places API。Google 为每个结算账户提供每月 10,000 次免费调用，项目默认最多使用 9,000 次；若同一结算账户在本项目之外已有用量，可在密钥设置中填写“本月已有用量”。

### Geoapify

在 [Geoapify MyProjects](https://myprojects.geoapify.com/) 创建项目，复制 API Key，在“Geoapify”下添加。参考[反向地理编码文档](https://apidocs.geoapify.com/docs/geocoding/reverse-geocoding/)。

### Mappls

在 [Mappls 控制台](https://auth.mappls.com/console/)创建应用，开通 **Reverse Geocoding API**，复制静态 Key，限制服务器 IP 后在“Mappls”下添加。

### OneMap

在 [OneMap](https://www.onemap.gov.sg/apidocs/register) 注册，通过[认证接口](https://www.onemap.gov.sg/apidocs/authentication)生成 Access Token，在“OneMap”下添加。Token 有效期为 3 天，过期前需要替换。

### 高德 JavaScript API

用于在网页结果页上显示高德地图，与上面的 WebService Key **不能共用**：

1. 在高德控制台单独创建 **Web 端（JS API）** Key 和安全密钥；
2. 将 Key 限制为你的正式域名；
3. 在“高德前端地图凭据”中填写 Key 和安全密钥。

安全密钥只保存在服务端，通过同源代理 `/_AMapService` 使用，不会出现在浏览器中。地图的显示开关在同一页面的“前端地图显示”中设置。

## 在线翻译

翻译的执行顺序是：

1. 先使用已有的合格译文和缓存；
2. 再按**优先级数值从小到大**尝试已启用的在线服务，相同优先级轮流使用；
3. 不可用、冷却中或额度用尽的服务会被自动跳过。

每个翻译密钥在自己的编辑框中设置优先级。Google 网页翻译不需要密钥，优先级设置在它的开关旁边；它不是付费的 Cloud Translation API，可能被限流，不保证一直可用。

译文必须原样保留门牌、单元、邮编等数字标识，并通过语言校验后才会被缓存和展示。

### DeepL API Free

在“DeepL”下添加以 `:fx` 结尾的免费版 Key，并设置项目字符上限（默认 500,000）。点击“测试”只查询额度，不消耗字符。

- 只允许 `https://api-free.deepl.com`，付费版 Key 和端点会被拒绝；
- 所有 DeepL Key 共用一个字符账本，实际可用量取账户额度和项目上限中较小的一个；
- DeepL 的用量统计可能延迟几分钟，免费版接口不返回计费周期，因此本地账本不会自动清零。

### 有道文本翻译

> **付费服务。** 有道按用量计费，试用额度用完后，测试和自动翻译都会产生费用。项目中设置的额度只是内部限制，不代表处于免费额度内。不接受费用时请不要添加或启用。

在[有道智云](https://ai.youdao.com/)创建应用并开通文本翻译，在“有道翻译”下填写应用 ID 和应用密钥。计费说明见[官方价格页](https://ai.youdao.com/DOCSIRMA/html/trans/price/plwbfy/index.html)。

### OpenAI 兼容接口

可以接入任何兼容 OpenAI **Chat Completions** 格式的服务（如 DeepSeek、Gemini 代理、OpenRouter 等）。

**添加步骤**

1. 在“OpenAI 兼容接口”中点击添加，填写接口地址和 API Key；
2. 点击模型输入框旁的按钮获取模型列表并选择模型，也可以直接输入模型名称；
3. 保存后点击“测试”确认可用。

额度默认为“无限额度”；需要限制每日请求数时取消勾选并填写上限。

**接口地址**：填前缀或完整地址都可以，下方会实时显示实际请求地址。

| 填写 | 实际请求 |
|---|---|
| `https://api.example.com/v1` | `https://api.example.com/v1/chat/completions` |
| `https://api.example.com/v1/chat/completions` | 原样使用 |
| `https://api.example.com`（无版本号） | 保存时自动探测，通常为 `…/v1/chat/completions` |

远程地址必须使用 HTTPS；HTTP 只允许 `localhost`。

**提示词**：新建时会预填内置的默认提示词，留空同样使用默认值，修改后可一键恢复。它只用来调整翻译风格；“只输出 JSON、条数一致、保留数字”等规则由系统固定附加，无法被覆盖。

**思考强度**：默认发送 `low`。推理模型响应较慢，单次翻译请求（含排队）最长等待 120 秒。如果模型列表提供了支持的档位，会自动选择合适的值；否则可以按供应商文档填写。

**测试**：点击“测试”会打开过程窗口，逐步显示：

- 实际请求地址、模型与参数；
- HTTP 状态和耗时；
- 结束原因、Token 用量和模型回复；
- 失败时供应商返回的错误信息（API Key 已遮罩）。

测试分两种模式：发送 `"hi"` 的连通性测试，以及地址翻译样例测试。被标记为“需检查”的凭据仍然可以测试，测试通过后会恢复可用；模型输出格式不对不会让凭据被标记为需检查。

## 安全建议

- 服务端 Key 一律限制为服务器 IP，网页地图 Key 一律限制为域名；
- 不要把任何 Key 写进仓库、截图或日志；
- 备份数据库时一并保存 `data/secrets/config_master_key`，否则无法解密已保存的密钥。
