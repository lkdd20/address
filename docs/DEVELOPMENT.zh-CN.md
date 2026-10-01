# 开发指南

[English](DEVELOPMENT.md) · 简体中文 · [繁體中文](DEVELOPMENT.zh-TW.md)

本文面向需要修改源码或贡献代码的开发者。只想部署使用，请看[部署文档](DEPLOYMENT.zh-CN.md)。

## 架构

```text
浏览器
  └─ Astro 静态页面 + React（WebUI、管理后台）
       └─ Hono API（/api/v1、/admin/api）
            ├─ PostgreSQL：地址池、行政目录、控制数据
            ├─ credential-broker：服务商密钥加密、轮换与额度
            └─ sync：调度、ETL（DuckDB / pyosmium）、校验与原子发布
```

- 国家快照先在候选区校验，通过后才在事务中替换线上数据；失败不影响旧数据。
- 同步进程把队列快照写入数据库，管理后台直接读取，同步进程繁忙时后台也能正常显示。
- 地图显示与地址校验相互独立；高德 JS 安全密钥只在服务端通过 `/_AMapService` 代理使用。

## 目录

| 路径 | 内容 |
|---|---|
| `src/pages/` | Astro 路由（多语言 WebUI、API 文档、管理后台） |
| `src/components/` | React 组件；`SyncAdmin.tsx` 是后台外壳 |
| `src/components/admin/` | 后台各页面：`dashboard`、`sync`（地址数据工作区）、`providers`、`security`、`shortcuts`，以及共享 `ui`、`text`、`locale-text`、`types` |
| `src/domain/` | 国家元数据、生成、格式化、本地化、翻译提示词 |
| `src/styles/` | `global.css`（WebUI）、`admin.css`（后台设计 Token 与组件） |
| `server/api/` | 公开 API、数据仓库、外部服务适配 |
| `server/control/` | 后台 API、鉴权、令牌、凭据存储、Schema |
| `server/credential-broker/` | 密钥代理与各服务商适配 |
| `server/sync/` | 数据源适配、ETL、队列、发布 |
| `server/database/` | PostgreSQL 连接与迁移 |
| `scripts/` | 目录生成、数据校验、线上验收脚本 |
| `ops/` | Compose 部署、蓝绿切换、备份恢复脚本 |
| `tests/` | Vitest 单元/集成测试与 Playwright 端到端测试 |
| `docs/strategies/` | 每个国家的地址生成策略 |

## 本地运行

需要 Node.js 24+。只有运行数据同步时才需要 Python 3.10+（`pip install -r server/sync/requirements.txt`，并用 `PYTHON_BIN` 指向该解释器）。

```bash
git clone https://github.com/daimon3332/address.git
cd address
cp .env.example .env      # 至少填写 POSTGRES_URL
npm ci
npm run db:migrate
npm run dev               # http://127.0.0.1:8787
```

需要热更新前端时，分别运行 `npm run dev:api` 和 `npm run dev:web`（Astro 开发服务器在 `4321`，并把 `/api` 代理到 Hono）。

新建的数据库只有表结构。要在本地生成地址，先导入行政目录，再导入一个小国家：

```bash
npm run data:catalog && npm run data:catalog:import
npm run data:address-pool:etl -- --manual --shard SG
```

常规开发不需要任何第三方 API Key。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | 构建 WebUI 并以监听模式运行 API |
| `npm test` | Vitest 测试（使用 pg-mem 和小型夹具，不需要真实数据库） |
| `npm run check` | Astro 诊断与 TypeScript 检查 |
| `npm run build` | 生产构建 |
| `npm run check:public` | 检查忽略规则、必需文件和密钥形态 |
| `npm run test:admin-e2e` | 管理后台端到端测试（Playwright） |
| `npm run test:ui-e2e` | WebUI 稳定性与布局测试 |
| `npm run db:migrate` | 创建或迁移数据库 |
| `npm run sync:serve` | 本地运行同步调度器 |

## 修改指南

**公开 API**：路由与校验写在 `server/api/index.ts`，数据库访问放在 `server/api/repositories/`，外部请求放在 `server/api/services/` 并设置超时。响应统一为 `{ data }` 或 `{ error: { code, message } }`，同时更新 `src/domain/api-contract.ts` 中的 OpenAPI 描述和三语 [API 文档](API.zh-CN.md)。

**管理后台**：页面放在 `src/components/admin/`，文案加到 `text.ts` 或 `locale-text.ts`（9 种语言都要补），样式只使用 `admin.css` 中的 Token。确认操作使用 `useConfirm`，弹窗使用 `Dialog`，轮询使用 `usePolling`。

**数据库**：控制库 Schema 变更在 `server/database/postgres.mjs` 中新增版本化迁移，不要修改已发布的迁移。

**国家或数据源**：需要同时更新国家元数据、地址格式、邮编规则、来源分片、测试和 `docs/strategies/` 中对应国家的策略文档。地址字段只能来自数据源，缺失值保持为空；合成测试资料必须与地址来源明确分开。

## 提交前检查

```bash
npm test
npm run check
npm run build
npm run check:public
git diff --check
```

CI 还会检查 Shell 语法并编译 Python 文件。改动后台界面时，再运行 `npm run test:admin-e2e` 和 `npm run test:ui-e2e`。

不要提交真实凭据、数据库、日志、运行状态或包含私密数据的截图；英文、简体中文、繁体中文文档需同步更新。
