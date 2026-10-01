# 開發指南

[English](DEVELOPMENT.md) · [简体中文](DEVELOPMENT.zh-CN.md) · 繁體中文

本文面向需要修改原始碼或貢獻程式碼的開發者。只想部署使用，請看[部署文件](DEPLOYMENT.zh-TW.md)。

## 架構

```text
瀏覽器
  └─ Astro 靜態頁面 + React（WebUI、管理後臺）
       └─ Hono API（/api/v1、/admin/api）
            ├─ PostgreSQL：地址池、行政目錄、控制資料
            ├─ credential-broker：服務商金鑰加密、輪換與額度
            └─ sync：排程、ETL（DuckDB / pyosmium）、校驗與原子釋出
```

- 國家快照先在候選區校驗，通過後才在事務中替換線上資料；失敗不影響舊資料。
- 同步程序把佇列快照寫入資料庫，管理後臺直接讀取，同步程序繁忙時後臺也能正常顯示。
- 地圖顯示與地址校驗相互獨立；高德 JS 安全金鑰只在服務端通過 `/_AMapService` 代理使用。

## 目錄

| 路徑 | 內容 |
|---|---|
| `src/pages/` | Astro 路由（多語言 WebUI、API 文件、管理後臺） |
| `src/components/` | React 元件；`SyncAdmin.tsx` 是後臺外殼 |
| `src/components/admin/` | 後臺各頁面：`dashboard`、`sync`（地址資料工作區）、`providers`、`security`、`shortcuts`，以及共享 `ui`、`text`、`locale-text`、`types` |
| `src/domain/` | 國家後設資料、生成、格式化、本地化、翻譯提示詞 |
| `src/styles/` | `global.css`（WebUI）、`admin.css`（後臺設計 Token 與元件） |
| `server/api/` | 公開 API、資料倉儲、外部服務適配 |
| `server/control/` | 後臺 API、鑑權、令牌、憑據儲存、Schema |
| `server/credential-broker/` | 金鑰代理與各服務商適配 |
| `server/sync/` | 資料來源適配、ETL、佇列、釋出 |
| `server/database/` | PostgreSQL 連線與遷移 |
| `scripts/` | 目錄生成、資料校驗、線上驗收指令碼 |
| `ops/` | Compose 部署、藍綠切換、備份恢復指令碼 |
| `tests/` | Vitest 單元/整合測試與 Playwright 端到端測試 |
| `docs/strategies/` | 每個國家的地址生成策略 |

## 本地執行

需要 Node.js 24+。只有執行資料同步時才需要 Python 3.10+（`pip install -r server/sync/requirements.txt`，並用 `PYTHON_BIN` 指向該直譯器）。

```bash
git clone https://github.com/daimon3332/address.git
cd address
cp .env.example .env      # 至少填寫 POSTGRES_URL
npm ci
npm run db:migrate
npm run dev               # http://127.0.0.1:8787
```

需要熱更新前端時，分別執行 `npm run dev:api` 和 `npm run dev:web`（Astro 開發伺服器在 `4321`，並把 `/api` 代理到 Hono）。

新建的資料庫只有表結構。要在本地生成地址，先匯入行政目錄，再匯入一個小國家：

```bash
npm run data:catalog && npm run data:catalog:import
npm run data:address-pool:etl -- --manual --shard SG
```

常規開發不需要任何第三方 API Key。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | 構建 WebUI 並以監聽模式執行 API |
| `npm test` | Vitest 測試（使用 pg-mem 和小型夾具，不需要真實資料庫） |
| `npm run check` | Astro 診斷與 TypeScript 檢查 |
| `npm run build` | 生產構建 |
| `npm run check:public` | 檢查忽略規則、必需檔案和金鑰形態 |
| `npm run test:admin-e2e` | 管理後臺端到端測試（Playwright） |
| `npm run test:ui-e2e` | WebUI 穩定性與佈局測試 |
| `npm run db:migrate` | 建立或遷移資料庫 |
| `npm run sync:serve` | 本地運行同步排程器 |

## 修改指南

**公開 API**：路由與校驗寫在 `server/api/index.ts`，資料庫訪問放在 `server/api/repositories/`，外部請求放在 `server/api/services/` 並設定超時。響應統一為 `{ data }` 或 `{ error: { code, message } }`，同時更新 `src/domain/api-contract.ts` 中的 OpenAPI 描述和三語 [API 文件](API.zh-TW.md)。

**管理後臺**：頁面放在 `src/components/admin/`，文案加到 `text.ts` 或 `locale-text.ts`（9 種語言都要補），樣式只使用 `admin.css` 中的 Token。確認操作使用 `useConfirm`，彈窗使用 `Dialog`，輪詢使用 `usePolling`。

**資料庫**：控制庫 Schema 變更在 `server/database/postgres.mjs` 中新增版本化遷移，不要修改已釋出的遷移。

**國家或資料來源**：需要同時更新國家後設資料、地址格式、郵遞區號規則、來源分片、測試和 `docs/strategies/` 中對應國家的策略文件。地址欄位只能來自資料來源，缺失值保持為空；合成測試資料必須與地址來源明確分開。

## 提交前檢查

```bash
npm test
npm run check
npm run build
npm run check:public
git diff --check
```

CI 還會檢查 Shell 語法並編譯 Python 檔案。改動後臺介面時，再執行 `npm run test:admin-e2e` 和 `npm run test:ui-e2e`。

不要提交真實憑據、資料庫、日誌、執行狀態或包含私密資料的截圖；英文、簡體中文、繁體中文文件需同步更新。
