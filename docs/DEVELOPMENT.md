# Development

English · [简体中文](DEVELOPMENT.zh-CN.md) · [繁體中文](DEVELOPMENT.zh-TW.md)

This guide is for developers who change the source code. To deploy and use Address, see the [deployment guide](DEPLOYMENT.md).

## Architecture

```text
Browser
  └─ Astro static pages + React (WebUI, admin console)
       └─ Hono API (/api/v1, /admin/api)
            ├─ PostgreSQL: address pool, administrative catalog, control data
            ├─ credential-broker: provider-key encryption, rotation, and quotas
            └─ sync: scheduling, ETL (DuckDB / pyosmium), validation, atomic publishing
```

- Country snapshots are validated in a staging area and swap in within a transaction only when they pass; a failed candidate never affects live data.
- The sync process writes its queue snapshot to the database, so the admin console stays responsive while sync is busy.
- Map display is independent of address validation; the AMap JS security secret is used only server-side through the `/_AMapService` proxy.

## Layout

| Path | Contents |
|---|---|
| `src/pages/` | Astro routes (localized WebUI, API docs, admin console) |
| `src/components/` | React components; `SyncAdmin.tsx` is the admin shell |
| `src/components/admin/` | Admin views: `dashboard`, `sync` (address data workspace), `providers`, `security`, `shortcuts`, plus shared `ui`, `text`, `locale-text`, and `types` |
| `src/domain/` | Country metadata, generation, formatting, localization, translation prompt |
| `src/styles/` | `global.css` (WebUI) and `admin.css` (admin design tokens and components) |
| `server/api/` | Public API, repositories, external service adapters |
| `server/control/` | Admin API, authentication, tokens, credential storage, schema |
| `server/credential-broker/` | Key broker and provider adapters |
| `server/sync/` | Source adapters, ETL, queue, publishing |
| `server/database/` | PostgreSQL connection and migrations |
| `scripts/` | Catalog generation, data validation, live acceptance scripts |
| `ops/` | Compose deployment, blue/green switch, backup and restore scripts |
| `tests/` | Vitest unit/integration tests and Playwright end-to-end tests |
| `docs/strategies/` | Per-country address generation strategies |

## Run locally

Requires Node.js 24+. Python 3.10+ is needed only to run data sync (`pip install -r server/sync/requirements.txt`, then point `PYTHON_BIN` at that interpreter).

```bash
git clone https://github.com/daimon3332/address.git
cd address
cp .env.example .env      # set at least POSTGRES_URL
npm ci
npm run db:migrate
npm run dev               # http://127.0.0.1:8787
```

For hot reload, run `npm run dev:api` and `npm run dev:web` side by side (the Astro dev server on `4321` proxies `/api` to Hono).

A new database contains only the schema. To generate addresses locally, import the administrative catalog and then a small country:

```bash
npm run data:catalog && npm run data:catalog:import
npm run data:address-pool:etl -- --manual --shard SG
```

Day-to-day development needs no third-party API keys.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Build the WebUI and run the API in watch mode |
| `npm test` | Vitest suite (uses pg-mem and small fixtures; no real database needed) |
| `npm run check` | Astro diagnostics and TypeScript |
| `npm run build` | Production build |
| `npm run check:public` | Ignore rules, required files, and secret patterns |
| `npm run test:admin-e2e` | Admin console end-to-end tests (Playwright) |
| `npm run test:ui-e2e` | WebUI reliability and layout tests |
| `npm run db:migrate` | Create or migrate the database |
| `npm run sync:serve` | Run the sync scheduler locally |

## Making changes

**Public API**: routes and validation live in `server/api/index.ts`, database access in `server/api/repositories/`, and outbound requests in `server/api/services/` with explicit timeouts. Responses are always `{ data }` or `{ error: { code, message } }`. Update the OpenAPI description in `src/domain/api-contract.ts` and the [API docs](API.md) in all three languages.

**Admin console**: views go in `src/components/admin/`, strings in `text.ts` or `locale-text.ts` (all 9 languages), and styles use only the tokens in `admin.css`. Use `useConfirm` for confirmations, `Dialog` for dialogs, and `usePolling` for polling.

**Database**: add a versioned migration for control schema changes in `server/database/postgres.mjs`; never edit a released migration.

**Countries and sources**: update country metadata, address format, postcode rules, source shards, tests, and the country's strategy in `docs/strategies/` together. Address fields must come from a source and stay empty when missing; synthetic test data must stay clearly separate from source data.

## Before you commit

```bash
npm test
npm run check
npm run build
npm run check:public
git diff --check
```

CI also checks shell syntax and compiles the Python files. For admin UI changes, also run `npm run test:admin-e2e` and `npm run test:ui-e2e`.

Never commit real credentials, databases, logs, runtime state, or screenshots with private data, and keep the English, Simplified Chinese, and Traditional Chinese docs in sync.
