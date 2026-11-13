# CrewMesh — Workspace Script Matrix (Batch 09 Audit)

This document catalogs every npm script declared across the root workspace (`package.json`), `@crewmesh/shared` (`packages/shared/package.json`), `@crewmesh/api` (`apps/api/package.json`), and `@crewmesh/web` (`apps/web/package.json`).

## 1. Root Workspace (`package.json`)

| Script Name | Command | Working Directory | Dependencies / Prerequisites | Used by CI (`.github/workflows/ci.yml`) | Works on Clean Checkout (`npm ci`) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `npm run build` | `npm run build --workspace=@crewmesh/shared && npm run build --workspace=@crewmesh/api && npm run build --workspace=@crewmesh/web` | Repo root (`/`) | `typescript`, `vite`, `@vitejs/plugin-react` | Yes (`verify-and-test`) | Yes — builds `@crewmesh/shared` (`dist/index.js` + `dist/index.d.ts`) first before building API and Web |
| `npm run dev:api` | `npm run dev --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `tsx`, running PostgreSQL (`DATABASE_URL`) | No (local dev) | Yes (after `npm ci` + `.env` + PostgreSQL) |
| `npm run dev:web` | `npm run dev --workspace=@crewmesh/web` | Repo root (`/`) -> `apps/web` | `vite` | No (local dev) | Yes (after `npm ci`) |
| `npm run lint` | `eslint "packages/*/src/**/*.{ts,tsx}" "apps/*/src/**/*.{ts,tsx}" "apps/*/test/**/*.{ts,mjs}" "apps/web/e2e/**/*.ts" "scripts/*.mjs"` | Repo root (`/`) | `eslint`, `@typescript-eslint/parser` or `@babel/eslint-parser` + `@babel/preset-typescript` | Yes (`verify-and-test`) | Yes — verified `0` errors, `0` warnings across all workspaces and scripts |
| `npm run typecheck` | `npm run build --workspace=@crewmesh/shared && npm run typecheck --workspace=@crewmesh/shared && npm run typecheck --workspace=@crewmesh/api && npm run typecheck --workspace=@crewmesh/web` | Repo root (`/`) | `typescript` (`tsc`) | Yes (`verify-and-test`) | Yes — emits `@crewmesh/shared` declarations first, then runs `tsc --noEmit` on every workspace without `--if-present` skipping |
| `npm run test` | `npm run build --workspace=@crewmesh/shared && npm run test --workspace=@crewmesh/api && npm run test --workspace=@crewmesh/web` | Repo root (`/`) | `vitest`, `typescript`, running PostgreSQL (`TEST_DATABASE_URL`) | No (umbrella script; CI runs granular steps) | Yes (requires PostgreSQL 16 for API integration tests) |
| `npm run test:integration` | `npm run build --workspace=@crewmesh/shared && npm run test:integration --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `vitest`, running PostgreSQL 16 (`TEST_DATABASE_URL`) | Yes (`verify-and-test`) | Yes (requires PostgreSQL 16) |
| `npm run test:race` | `npm run build --workspace=@crewmesh/shared && npm run test:race --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `vitest`, running PostgreSQL 16 (`TEST_DATABASE_URL`) | Yes (`verify-and-test`) | Yes (requires PostgreSQL 16) |
| `npm run test:sse` | `npm run build --workspace=@crewmesh/shared && npm run test:sse --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `vitest`, running PostgreSQL 16 (`TEST_DATABASE_URL`) | Covered inside `test:integration` | Yes (requires PostgreSQL 16) |
| `npm run test:suggestions` | `npm run build --workspace=@crewmesh/shared && npm run test:suggestions --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `vitest`, running PostgreSQL 16 (`TEST_DATABASE_URL`) | Covered inside `test:integration` | Yes (requires PostgreSQL 16) |
| `npm run test:scale` | `npm run build --workspace=@crewmesh/shared && npm run test:scale --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `vitest`, isolated `*_loadtest` PostgreSQL 16 (`CREWMESH_ALLOW_SCALE_SEED=true`) | Yes (`scale-and-k6-benchmark`) | Yes (requires PostgreSQL 16 `*_loadtest` DB) |
| `npm run test:hardening` | `npm run build --workspace=@crewmesh/shared && npm run test:hardening --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `vitest`, running PostgreSQL 16 (`TEST_DATABASE_URL`) | Yes (`verify-and-test`) | Yes (requires PostgreSQL 16) |
| `npm run test:e2e` | `npm run test:e2e --workspace=@crewmesh/web` | Repo root (`/`) -> `apps/web` | `@playwright/test`, Chromium browser, running API + Web servers | Yes (`verify-and-test`) | Yes (requires Chromium + running API/Web) |
| `npm run test:unit:sandbox` | `node --test apps/api/test/phase1.unit.test.mjs ... apps/api/test/batch9.unit.test.mjs` | Repo root (`/`) | Node.js `>=18.18.0`, declared `typescript` or `@babel/core` via `scripts/ts-loader.mjs` | Yes (`verify-and-test`) | Yes — executes `57/57` unit tests in `< 4s` without PostgreSQL |
| `npm run verify:sandbox` | `node scripts/verify-sandbox.mjs` | Repo root (`/`) | Node.js `>=18.18.0`, `scripts/ts-loader.mjs` | Optional static verification helper | Yes — transpiles and audits all `62` `.ts`/`.tsx` source/test files |
| `npm run db:migrate` | `npm run db:migrate --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `tsx`, `pg`, PostgreSQL 16 | Yes (`verify-and-test` & `scale-and-k6-benchmark`) | Yes (requires PostgreSQL 16) |
| `npm run db:migrate:down` | `npm run db:migrate:down --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `tsx`, `pg`, PostgreSQL 16 | Yes (`verify-and-test`) | Yes (requires PostgreSQL 16) |
| `npm run db:migrate:status` | `npm run db:migrate:status --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `tsx`, `pg`, PostgreSQL 16 | Diagnostic CLI | Yes (requires PostgreSQL 16) |
| `npm run db:seed` | `npm run db:seed --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `tsx`, `pg`, PostgreSQL 16 | Yes (`verify-and-test` & `scale-and-k6-benchmark`) | Yes (requires PostgreSQL 16) |
| `npm run db:seed:scale` | `npm run db:seed:scale --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `tsx`, `pg`, PostgreSQL 16 `*_loadtest` DB (`CREWMESH_ALLOW_SCALE_SEED=true`) | Yes (`scale-and-k6-benchmark`) | Yes (requires PostgreSQL 16 `*_loadtest` DB) |
| `npm run bench:board:k6` | `k6 run apps/api/load/board.k6.js` | Repo root (`/`) | Grafana `k6` binary, running API server seeded with scale dataset | Yes (`scale-and-k6-benchmark`) | Yes (requires `k6` binary + running API) |
| `npm run healthcheck` | `node scripts/healthcheck.mjs` | Repo root (`/`) | Node.js `>=18.18.0` (`fetch`), running API server | Diagnostic CLI | Yes (against running API server) |

## 2. Shared Workspace (`packages/shared/package.json`)

| Script Name | Command | Working Directory | Dependencies | Used by CI | Works on Clean Checkout |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `build` | `tsc -p tsconfig.json` | `packages/shared` | `typescript` | Yes | Yes — emits `dist/index.js` and `dist/index.d.ts` |
| `typecheck` | `tsc -p tsconfig.json --noEmit` | `packages/shared` | `typescript` | Yes | Yes |

## 3. API Workspace (`apps/api/package.json`)

| Script Name | Command | Working Directory | Dependencies | Used by CI | Works on Clean Checkout |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `dev` | `tsx watch src/server.ts` | `apps/api` | `tsx`, PostgreSQL | No | Yes |
| `prebuild` | `npm --prefix ../../packages/shared run build` | `apps/api` | `typescript` | Automatic hook | Yes — guarantees `@crewmesh/shared` declarations exist before `apps/api` builds |
| `build` | `tsc -p tsconfig.json` | `apps/api` | `typescript`, `@crewmesh/shared` | Yes | Yes — emits `apps/api/dist/server.js` |
| `start` | `node dist/server.js` | `apps/api` | Built `dist/server.js`, PostgreSQL | Yes | Yes (after `npm run build`) |
| `pretypecheck` | `npm --prefix ../../packages/shared run build` | `apps/api` | `typescript` | Automatic hook | Yes — guarantees `@crewmesh/shared` declarations exist before `tsc --noEmit` |
| `typecheck` | `tsc -p tsconfig.json --noEmit` | `apps/api` | `typescript`, `@crewmesh/shared` | Yes | Yes |
| `test` | `vitest run` | `apps/api` | `vitest`, PostgreSQL | Via root `test` | Yes (requires PostgreSQL 16) |
| `test:integration` | `vitest run test/phase1.integration.test.ts test/batch2.integration.test.ts test/batch3.sse.integration.test.ts test/batch5.suggestions.integration.test.ts test/scale/scale-seed.integration.test.ts test/batch7.hardening.integration.test.ts` | `apps/api` | `vitest`, PostgreSQL 16 | Yes | Yes (requires PostgreSQL 16) |
| `test:race` | `vitest run test/batch2.race.test.ts` | `apps/api` | `vitest`, PostgreSQL 16 | Yes | Yes (requires PostgreSQL 16) |
| `test:sse` | `vitest run test/batch3.sse.integration.test.ts` | `apps/api` | `vitest`, PostgreSQL 16 | Via `test:integration` | Yes (requires PostgreSQL 16) |
| `test:suggestions` | `vitest run test/batch5.suggestions.integration.test.ts` | `apps/api` | `vitest`, PostgreSQL 16 | Via `test:integration` | Yes (requires PostgreSQL 16) |
| `test:scale` | `vitest run test/scale/scale-seed.integration.test.ts` | `apps/api` | `vitest`, PostgreSQL 16 `*_loadtest` DB | Yes | Yes (requires PostgreSQL 16 `*_loadtest` DB) |
| `test:hardening` | `vitest run test/batch7.hardening.integration.test.ts` | `apps/api` | `vitest`, PostgreSQL 16 | Yes | Yes (requires PostgreSQL 16) |
| `test:unit` | `node --test test/phase1.unit.test.mjs ... test/batch9.unit.test.mjs` | `apps/api` | Node.js `>=18.18.0`, `scripts/ts-loader.mjs` | Via `test:unit:sandbox` | Yes |
| `db:migrate` | `tsx src/db/migrate.ts up` | `apps/api` | `tsx`, PostgreSQL 16 | Yes | Yes |
| `db:migrate:down` | `tsx src/db/migrate.ts down` | `apps/api` | `tsx`, PostgreSQL 16 | Yes | Yes |
| `db:migrate:status` | `tsx src/db/migrate.ts status` | `apps/api` | `tsx`, PostgreSQL 16 | Diagnostic | Yes |
| `db:seed` | `tsx src/db/seed.ts` | `apps/api` | `tsx`, PostgreSQL 16 | Yes | Yes |
| `db:seed:scale` | `tsx src/db/seed-scale.ts` | `apps/api` | `tsx`, PostgreSQL 16 `*_loadtest` DB | Yes | Yes |

## 4. Web Workspace (`apps/web/package.json`)

| Script Name | Command | Working Directory | Dependencies | Used by CI | Works on Clean Checkout |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `dev` | `vite` | `apps/web` | `vite`, `@vitejs/plugin-react` | No | Yes |
| `prebuild` | `npm --prefix ../../packages/shared run build` | `apps/web` | `typescript` | Automatic hook | Yes — guarantees `@crewmesh/shared` declarations and JS bundle exist before Vite build |
| `build` | `tsc -p tsconfig.json --noEmit && vite build` | `apps/web` | `typescript`, `vite`, `@crewmesh/shared` | Yes | Yes — emits `apps/web/dist/index.html` and hashed assets |
| `preview` | `vite preview --port 5173` | `apps/web` | `vite`, built `apps/web/dist` | Yes (`verify-and-test`) | Yes — proxies `/api`, `/health`, `/healthz`, and `/ready` to `http://127.0.0.1:3001` |
| `pretypecheck` | `npm --prefix ../../packages/shared run build` | `apps/web` | `typescript` | Automatic hook | Yes — guarantees `@crewmesh/shared` declarations exist before `tsc --noEmit` |
| `typecheck` | `tsc -p tsconfig.json --noEmit` | `apps/web` | `typescript`, `@crewmesh/shared` | Yes | Yes |
| `test` | `vitest run` | `apps/web` | `vitest` | Yes (`verify-and-test`) | Yes — runs `apps/web/src/App.test.tsx` |
| `test:e2e` | `playwright test` | `apps/web` | `@playwright/test`, Chromium | Yes (`verify-and-test`) | Yes (requires Chromium + running API/Web) |
