# API Key 配置

[English](API_KEYS.md) · [简体中文](API_KEYS.zh-CN.md) · 繁體中文

**所有第三方金鑰都是可選的。** 不配置任何金鑰時，Address 只使用官方登記和開放地圖等無需授權的資料來源。下列金鑰用於擴充特定國家的資料、啟用線上翻譯或在網頁上顯示高德地圖。

所有金鑰都在管理後臺 **整合 → 地圖金鑰** 頁面中新增，加密儲存在資料庫裡，列表中只顯示掩碼。

## 一覽

| 平臺 | 用途 | 後臺位置 |
|---|---|---|
| [高德 WebService](#高德-webservice) | 中國地址同步 | 地圖金鑰 → 高德地圖 |
| [百度地圖](#百度地圖) | 中國地址同步 | 地圖金鑰 → 百度地圖 |
| [騰訊位置服務](#騰訊位置服務) | 中國地址同步 | 地圖金鑰 → 騰訊地圖 |
| [Google Geocoding](#google-geocoding) | 為資料較少的國家補全街道與門牌 | 地圖金鑰 → Google Geocoding |
| [Geoapify](#geoapify) | 韓國地址與郵遞區號補全 | 地圖金鑰 → Geoapify |
| [Mappls](#mappls) | 印度地址補全 | 地圖金鑰 → Mappls |
| [OneMap](#onemap) | 新加坡地址同步 | 地圖金鑰 → OneMap |
| [DeepL API Free](#deepl-api-free) | 地址翻譯 | 線上翻譯 → DeepL |
| [有道文本翻譯](#有道文本翻譯) | 地址翻譯（付費） | 線上翻譯 → 有道翻譯 |
| [OpenAI 相容介面](#openai-相容介面) | 用任意 Chat Completions 模型翻譯地址 | 線上翻譯 → OpenAI 相容介面 |
| [高德 JavaScript API](#高德-javascript-api) | 在網頁上顯示高德地圖 | 高德前端地圖憑據 |

**多個金鑰自動輪換。** 同一平臺可以新增多個金鑰：某個金鑰失敗時會先冷卻，系統改用其他金鑰；全部不可用時，等待最早恢復的那個。每個金鑰都可以單獨設定額度上限。

## 地圖與地理編碼

### 高德 WebService

1. 開啟[高德開發者控制台](https://console.amap.com/dev/index)，按[官方指南](https://lbs.amap.com/api/webservice/create-project-and-key)建立應用和 **Web 服務** Key；
2. 限制為伺服器 IP；
3. 在「高德地圖」下新增。

### 百度地圖

1. 在[百度地圖 API 控制台](https://lbsyun.baidu.com/apiconsole/key)建立 **服務端** 應用，開通地點檢索；
2. 限制為伺服器 IP；
3. 在「百度地圖」下新增 AK。

### 騰訊位置服務

1. 在[騰訊位置服務控制台](https://lbs.qq.com/dev/console/application/mine)建立應用，開通 **WebServiceAPI**；
2. 配置伺服器 IP 或簽名校驗；
3. 在「騰訊地圖」下新增。

### Google Geocoding

1. 在 Google Cloud 建立專案並繫結結算賬戶；
2. 按[官方指南](https://developers.google.com/maps/documentation/geocoding/get-api-key)開通 **Geocoding API**，建立僅限 Geocoding API 和伺服器 IP 的 Key；
3. 在「Google Geocoding」下新增。

專案使用 Geocoding API v4，不需要 Places API。Google 為每個結算賬戶提供每月 10,000 次免費呼叫，專案預設最多使用 9,000 次；若同一結算賬戶在本專案之外已有用量，可在金鑰設定中填寫「本月已有用量」。

### Geoapify

在 [Geoapify MyProjects](https://myprojects.geoapify.com/) 建立專案，複製 API Key，在「Geoapify」下新增。參考[反向地理編碼文件](https://apidocs.geoapify.com/docs/geocoding/reverse-geocoding/)。

### Mappls

在 [Mappls 控制台](https://auth.mappls.com/console/)建立應用，開通 **Reverse Geocoding API**，複製靜態 Key，限制伺服器 IP 後在「Mappls」下新增。

### OneMap

在 [OneMap](https://www.onemap.gov.sg/apidocs/register) 註冊，通過[認證介面](https://www.onemap.gov.sg/apidocs/authentication)生成 Access Token，在「OneMap」下新增。Token 有效期為 3 天，過期前需要替換。

### 高德 JavaScript API

用於在網頁結果頁上顯示高德地圖，與上面的 WebService Key **不能共用**：

1. 在高德控制台單獨建立 **Web 端（JS API）** Key 和安全金鑰；
2. 將 Key 限制為你的正式域名；
3. 在「高德前端地圖憑據」中填寫 Key 和安全金鑰。

安全金鑰只儲存在服務端，通過同源代理 `/_AMapService` 使用，不會出現在瀏覽器中。地圖的顯示開關在同一頁面的「前端地圖顯示」中設定。

## 線上翻譯

翻譯的執行順序是：

1. 先使用已有的合格譯文和快取；
2. 再按**優先順序數值從小到大**嘗試已啟用的線上服務，相同優先順序輪流使用；
3. 不可用、冷卻中或額度用盡的服務會被自動跳過。

每個翻譯金鑰在自己的編輯框中設定優先順序。Google 網頁翻譯不需要金鑰，優先順序設定在它的開關旁邊；它不是付費的 Cloud Translation API，可能被限流，不保證一直可用。

譯文必須原樣保留門牌、單元、郵遞區號等數字標識，並通過語言校驗後才會被快取和展示。

### DeepL API Free

在「DeepL」下新增以 `:fx` 結尾的免費版 Key，並設定專案字元上限（預設 500,000）。點選「測試」只查詢額度，不消耗字元。

- 只允許 `https://api-free.deepl.com`，付費版 Key 和端點會被拒絕；
- 所有 DeepL Key 共用一個字元賬本，實際可用量取賬戶額度和專案上限中較小的一個；
- DeepL 的用量統計可能延遲幾分鐘，免費版介面不返回計費週期，因此本地賬本不會自動清零。

### 有道文本翻譯

> **付費服務。** 有道按用量計費，試用額度用完後，測試和自動翻譯都會產生費用。專案中設定的額度只是內部限制，不代表處於免費額度內。不接受費用時請不要新增或啟用。

在[有道智雲](https://ai.youdao.com/)建立應用並開通文本翻譯，在「有道翻譯」下填寫應用 ID 和應用金鑰。計費說明見[官方價格頁](https://ai.youdao.com/DOCSIRMA/html/trans/price/plwbfy/index.html)。

### OpenAI 相容介面

可以接入任何相容 OpenAI **Chat Completions** 格式的服務（如 DeepSeek、Gemini 代理、OpenRouter 等）。

**新增步驟**

1. 在「OpenAI 相容介面」中點選新增，填寫介面地址和 API Key；
2. 點選模型輸入框旁的按鈕獲取模型列表並選擇模型，也可以直接輸入模型名稱；
3. 儲存後點擊「測試」確認可用。

額度預設為「無限額度」；需要限制每日請求數時取消勾選並填寫上限。

**介面地址**：填字首或完整地址都可以，下方會即時顯示實際請求地址。

| 填寫 | 實際請求 |
|---|---|
| `https://api.example.com/v1` | `https://api.example.com/v1/chat/completions` |
| `https://api.example.com/v1/chat/completions` | 原樣使用 |
| `https://api.example.com`（無版本號） | 儲存時自動探測，通常為 `…/v1/chat/completions` |

遠端地址必須使用 HTTPS；HTTP 只允許 `localhost`。

**提示詞**：新建時會預填內建的預設提示詞，留空同樣使用預設值，修改後可一鍵恢復。它只用來調整翻譯風格；「只輸出 JSON、條數一致、保留數字」等規則由系統固定附加，無法被覆蓋。

**思考強度**：預設傳送 `low`。推理模型響應較慢，單次翻譯請求（含排隊）最長等待 120 秒。如果模型列表提供了支援的檔位，會自動選擇合適的值；否則可以按供應商文件填寫。

**測試**：點選「測試」會開啟過程視窗，逐步顯示：

- 實際請求地址、模型與參數；
- HTTP 狀態和耗時；
- 結束原因、Token 用量和模型回覆；
- 失敗時供應商返回的錯誤資訊（API Key 已遮罩）。

測試分兩種模式：傳送 `"hi"` 的連通性測試，以及地址翻譯樣例測試。被標記為「需檢查」的憑據仍然可以測試，測試通過後會恢復可用；模型輸出格式不對不會讓憑據被標記為需檢查。

## 安全建議

- 服務端 Key 一律限制為伺服器 IP，網頁地圖 Key 一律限制為域名；
- 不要把任何 Key 寫進倉庫、截圖或日誌；
- 備份資料庫時一併儲存 `data/secrets/config_master_key`，否則無法解密已儲存的金鑰。
