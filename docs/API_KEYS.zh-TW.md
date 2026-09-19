# API Key 設定

[English](API_KEYS.md) · [简体中文](API_KEYS.zh-CN.md) · [繁體中文](API_KEYS.zh-TW.md)

在「後台 → 服務憑據」新增憑據。同一平台可新增多組憑據，系統會自動輪換。

| 平台 | 對應國家或功能 | 後台設定名稱 |
|---|---|---|
| 高德 WebService | 中國地址同步 | 高德地圖 |
| 百度地圖 | 中國地址同步 | 百度地圖 |
| 騰訊位置服務 | 中國地址同步 | 騰訊地圖 |
| Mappls Reverse Geocoding | 印度地址補全 | Mappls |
| OneMap | 新加坡地址同步 | OneMap |
| Geoapify Reverse Geocoding | 韓國位址與郵遞區號補全 | Geoapify |
| Google Geocoding | 支援的低數量國家真實街道與門牌補全 | Google Geocoding |
| 有道文字翻譯 | 地址翻譯 | 有道翻譯 |
| DeepL API Free | 支援自訂路由優先級的地址翻譯 | DeepL Free |
| OpenAI 相容 Chat Completions | 使用可設定模型翻譯地址 | OpenAI 相容介面 |
| 高德 JavaScript API | 中國前端地圖 | 高德前端地圖 |

## 高德 WebService

1. 開啟[高德開發者控制台](https://console.amap.com/dev/index)。
2. 依[官方指南](https://lbs.amap.com/api/webservice/create-project-and-key)建立應用與 **WebService** Key。
3. 設定伺服器 IP 限制，在「高德地圖」下新增 Key。

## 百度地圖

1. 開啟[百度地圖 API 控制台](https://lbsyun.baidu.com/apiconsole/key)。
2. 建立「服務端」應用並開通地點搜尋 Web API。
3. 設定伺服器 IP 限制，在「百度地圖」下新增 AK。

## 騰訊位置服務

1. 開啟[騰訊位置服務控制台](https://lbs.qq.com/dev/console/application/mine)。
2. 建立應用並開通 **WebService API**。
3. 設定伺服器 IP 或簽名限制，在「騰訊地圖」下新增 Key。

## Mappls Reverse Geocoding

1. 在 [Mappls 控制台](https://auth.mappls.com/console/)建立應用。
2. 開通 **Reverse Geocoding API**，從 credentials 區域複製靜態 Key。
3. 設定伺服器 IP 限制，在「Mappls」下新增 Key。

介接方式以 [Mappls Reverse Geocoding 官方文件](https://developer.mappls.com/documentation/sdk/rest-apis/mappls-maps-reverse-geocoding-rest-api-example/Readme/)為準。

## OneMap

1. 註冊 [OneMap API](https://www.onemap.gov.sg/apidocs/register)。
2. 透過[認證介面](https://www.onemap.gov.sg/apidocs/authentication)產生 Access Token。
3. 在「OneMap」下新增 Token，並在三天有效期結束前替換。

## Geoapify

1. 在 [Geoapify MyProjects](https://myprojects.geoapify.com/)建立專案。
2. 複製專案 API Key。
3. 在「Geoapify」下新增 Key。

參見[反向地理編碼官方文件](https://apidocs.geoapify.com/docs/geocoding/reverse-geocoding/)。

## Google Geocoding

1. 建立或選擇 Google Cloud 專案並連結結算帳戶。
2. 依[官方設定指南](https://developers.google.com/maps/documentation/geocoding/get-api-key)開通 **Geocoding API**。
3. 建立伺服器 Key，限制到 Geocoding API 與部署伺服器 IP，在「Google Geocoding」下新增。

專案使用 Geocoding API v4，不需要 Places API。

## DeepL API Free

在「線上翻譯 → DeepL Free」新增以 `:fx` 結尾的免費 Key，自訂專案字元上限，再點選「測試」查詢額度，不消耗翻譯字元。預設上限為 500,000，但最終同時受帳戶實際額度約束。僅允許 `https://api-free.deepl.com`，拒絕 Pro Key 和付費端點。

API 與同步共用加密憑據 Broker 和持久 Unicode 字元帳本；帳戶額度與所有啟用 DeepL Key 的設定上限取最低值。翻譯前原子預留字元，回應遺失不退回；重啟、換 Key 或本地月份變化不會重設累計值。用量查詢和翻譯合計兩次上游請求，均遵守 QPS 限制。

[官方用量](https://developers.deepl.com/docs/admin/retrieving-usage-data)可能延遲數分鐘，[Free 用量回應](https://developers.deepl.com/api-reference/usage-and-quota/check-usage-and-limits)可能不含計費週期日期。沒有可信新週期時，本地帳本不會自動歸零，可能提前降級。相同帳戶的外部應用不受本專案控制，Free 官方硬上限是最後保障；不能透過清空帳本繞過等待。

## 有道文字翻譯

**付費服務：** 有道按用量計費，試用額度可能有限；用完後，測試和自動翻譯都可能扣除帳戶餘額。專案配額及補全字元預算只是內部限額，不保證呼叫處於供應商免費額度內。啟用前請核對[有道官方計費說明](https://ai.youdao.com/DOCSIRMA/html/trans/price/plwbfy/index.html)和帳戶狀態；不接受費用時，請勿設定或啟用憑據。

1. 註冊[有道智雲](https://ai.youdao.com/)。
2. 建立應用並開通文字翻譯。
3. 在「線上翻譯」中新增應用 ID 與應用密鑰。

每條設定保存一組 ID/密鑰，支援新增多組。

翻譯優先檢查合格本地變體和快取，然後按優先級數值由小到大嘗試已啟用的線上路由；同優先級使用輪詢，不可用、冷卻中、額度耗盡或失敗的路由會被跳過。新建 OpenAI 相容路由預設排在 DeepL、有道和已啟用的免密鑰 Google 網頁翻譯之前，但管理員可以修改每條路由的優先級。Google 不是 Cloud Translation 計費 API，可能限流或無法使用，不保證永久、無限免費。不接受付費供應商費用時，請保持未設定或停用。

## OpenAI 相容 Chat Completions

在「線上翻譯」中填寫端點和 API Key，取得即時模型清單後選擇支援 Chat Completions 的模型，不預設固定模型。支援完整的 `/chat/completions` 或 `/models` URL，保留自訂 API 路徑前綴；基礎網址須包含供應商 API 前綴（如 `/v1`）。保留介面宣告的協定限制和思考強度，完整下拉清單顯示介面回傳的全部模型，不相容模型顯示原因並停用選取；展開時不依已儲存值篩選，輸入時可搜尋。介面未提供思考強度時明確提示，並允許填入供應商文件支援的值；專案預設明確傳送 `low`，舊設定的 `default` 也依 `low` 處理，其他明確值原樣傳送。切換模型時，若介面提供的強度不含 `low`，則採用介面宣告的首個強度。這不代表供應商在省略參數時預設使用 `low`。預設專案上限為每日 1,000 次、每秒 1 次，可按部署情況調整。

服務端發送非串流 Chat Completions 請求，並使用只翻譯地址元件的嚴格 JSON 提示詞。輸入值會被視為不可信地址資料，而不是指令。返回結果必須保留數字和識別碼，並通過現有語言和發佈門禁後才會快取或發佈。API Key 在控制資料庫中加密保存，普通憑據清單不會返回；點選「測試」只執行小型合成請求並報告成功狀態和結果數量。

遠端服務只接受 HTTPS；明文 HTTP 僅允許 localhost。啟用前請確認供應商的資料處理、服務條款和模型計費方式。

## 高德 JavaScript API

1. 在高德控制台另行建立 **JavaScript API** Key 與安全密鑰。
2. 將 Key 限制到正式網域。
3. 在「高德前端地圖」中新增兩個值。

不要與高德 WebService Key 共用。

翻譯優先級在每個 API Key 的編輯框設定，DeepL、有道、OpenAI 相容金鑰互相獨立；舊方式優先級只作首次遷移預設值。Google 網頁翻譯沒有 Key，優先級放在其開關旁。獨立優先級面板已移除。模型輸入框旁可取得即時清單，也可直接輸入模型名稱；成功取得後會填入實際 API 前綴。固定提示詞以品質優先，要求嚴格 JSON、一一對應及保留數字識別碼。

首次匯入啟用線上翻譯時，同樣依各 Key 的優先級調度並透過代理計量。地址欄位修正後，舊顯示譯文快取自動失效。模型取得支援秒數與 HTTP 日期形式的 Retry-After。試用或新用戶獎勵不保證週期續期；DeepL 一次性獎勵不會由本地自動補充。
