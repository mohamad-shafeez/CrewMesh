# CrewMesh — Workspace Script Matrix (Batch 10 Final Audit)

This document catalogs every npm script declared across the root workspace (`package.json`), `@crewmesh/shared` (`packages/shared/package.json`), `@crewmesh/api` (`apps/api/package.json`), and `@crewmesh/web` (`apps/web/package.json`).

## 1. Root Workspace (`package.json`)

| Script Name | Command | Working Directory | Dependencies / Prerequisites | Used by CI (`.github/workflows/ci.yml`) | Clean-Checkout Behavior |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `npm run build` | `npm run build --workspace=@crewmesh/shared && npm run build --workspace=@crewmesh/api && npm run build --workspace=@crewmesh/web` | Repo root (`/`) | `typescript`, `vite`, `@vitejs/plugin-react` | Yes (`verify-and-test`) | Builds `@crewmesh/shared` (`dist/index.js` + `dist/index.d.ts`) first before building API and Web (requires `npm ci`) |
| `npm run dev:api` | `npm run dev --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `tsx`, running PostgreSQL (`DATABASE_URL`) | No (local dev) | Runs after `npm ci` + `.env` + PostgreSQL |
| `npm run dev:web` | `npm run dev --workspace=@crewmesh/web` | Repo root (`/`) -> `apps/web` | `vite` | No (local dev) | Runs after `npm ci` |
| `npm run lint` | `eslint "packages/*/src/**/*.{ts,tsx}" "apps/*/src/**/*.{ts,tsx}" "apps/*/test/**/*.{ts,mjs}" "apps/web/e2e/**/*.ts" "scripts/*.mjs"` | Repo root (`/`) | `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin` | Yes (`verify-and-test`) | Requires `npm ci` to install `@typescript-eslint/parser` in `node_modules` (no silent fallback to OS parser) |
| `npm run lint:scripts` | `eslint "scripts/*.mjs" "apps/api/test/*.mjs"` | Repo root (`/`) | `eslint` (built-in `espree` parser) | Local / offline verification | Verified `0` errors, `0` warnings across all `.mjs` scripts and unit tests |
| `npm run typecheck` | `npm run build --workspace=@crewmesh/shared && npm run typecheck --workspace=@crewmesh/shared && npm run typecheck --workspace=@crewmesh/api && npm run typecheck --workspace=@crewmesh/web` | Repo root (`/`) | `typescript` (`tsc`) | Yes (`verify-and-test`) | Emits `@crewmesh/shared` declarations first, then runs `tsc --noEmit` on every workspace without `--if-present` skipping (requires `npm ci`) |
| `npm run test` | `npm run build --workspace=@crewmesh/shared && npm run test --workspace=@crewmesh/api && npm run test --workspace=@crewmesh/web` | Repo root (`/`) | `vitest`, `typescript`, running PostgreSQL (`TEST_DATABASE_URL`) | Umbrella script | Requires `npm ci` + PostgreSQL 16 |
| `npm run test:integration` | `npm run build --workspace=@crewmesh/shared && npm run test:integration --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `vitest`, running PostgreSQL 16 (`TEST_DATABASE_URL`) | Yes (`verify-and-test`) | Requires `npm ci` + PostgreSQL 16 |
| `npm run test:race` | `npm run build --workspace=@crewmesh/shared && npm run test:race --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `vitest`, running PostgreSQL 16 (`TEST_DATABASE_URL`) | Yes (`verify-and-test`) | Requires `npm ci` + PostgreSQL 16 |
| `npm run test:sse` | `npm run build --workspace=@crewmesh/shared && npm run test:sse --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `vitest`, running PostgreSQL 16 (`TEST_DATABASE_URL`) | Covered inside `test:integration` | Requires `npm ci` + PostgreSQL 16 |
| `npm run test:suggestions` | `npm run build --workspace=@crewmesh/shared && npm run test:suggestions --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `vitest`, running PostgreSQL 16 (`TEST_DATABASE_URL`) | Covered inside `test:integration` | Requires `npm ci` + PostgreSQL 16 |
| `npm run test:scale` | `npm run build --workspace=@crewmesh/shared && npm run test:scale --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `vitest`, isolated `*_loadtest` PostgreSQL 16 (`CREWMESH_ALLOW_SCALE_SEED=true`) | Yes (`scale-and-k6-benchmark`) | Requires `npm ci` + PostgreSQL 16 `*_loadtest` DB |
| `npm run test:hardening` | `npm run build --workspace=@crewmesh/shared && npm run test:hardening --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `vitest`, running PostgreSQL 16 (`TEST_DATABASE_URL`) | Yes (`verify-and-test`) | Requires `npm ci` + PostgreSQL 16 |
| `npm run test:e2e` | `npm run test:e2e --workspace=@crewmesh/web` | Repo root (`/`) -> `apps/web` | `@playwright/test`, Chromium browser, running API + Web servers | Yes (`verify-and-test`) | Requires `npm ci` + Chromium + running API/Web |
| `npm run test:unit:sandbox` | `node --test apps/api/test/phase1.unit.test.mjs ... apps/api/test/batch9.unit.test.mjs` | Repo root (`/`) | Node.js `>=18.18.0`, declared `typescript` or `@babel/core` via `scripts/ts-loader.mjs` | Yes (`verify-and-test`) | Executes `57/57` unit tests exercising production `.ts` modules without PostgreSQL |
| `npm run verify:sandbox` | `node scripts/verify-sandbox.mjs` | Repo root (`/`) | Node.js `>=18.18.0`, `scripts/ts-loader.mjs` | Static transpilation verifier | Transpiles and audits all `62` `.ts`/`.tsx` source/test files |
| `npm run db:migrate` | `npm run db:migrate --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `tsx`, `pg`, PostgreSQL 16 | Yes (`verify-and-test` & `scale-and-k6-benchmark`) | Requires `npm ci` + PostgreSQL 16 |
| `npm run db:migrate:down` | `npm run db:migrate:down --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `tsx`, `pg`, PostgreSQL 16 | Yes (`verify-and-test`) | Requires `npm ci` + PostgreSQL 16 |
| `npm run db:migrate:status` | `npm run db:migrate:status --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `tsx`, `pg`, PostgreSQL 16 | Diagnostic CLI | Requires `npm ci` + PostgreSQL 16 |
| `npm run db:seed` | `npm run db:seed --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `tsx`, `pg`, PostgreSQL 16 | Yes (`verify-and-test` & `scale-and-k6-benchmark`) | Requires `npm ci` + PostgreSQL 16 |
| `npm run db:seed:scale` | `npm run db:seed:scale --workspace=@crewmesh/api` | Repo root (`/`) -> `apps/api` | `tsx`, `pg`, PostgreSQL 16 `*_loadtest` DB (`CREWMESH_ALLOW_SCALE_SEED=true`) | Yes (`scale-and-k6-benchmark`) | Requires `npm ci` + PostgreSQL 16 `*_loadtest` DB |
| `npm run bench:board:k6` | `k6 run apps/api/load/board.k6.js` | Repo root (`/`) | Grafana `k6` binary, running API server seeded with scale dataset | Yes (`scale-and-k6-benchmark`) | Requires `k6` binary + running API |
| `npm run healthcheck` | `node scripts/healthcheck.mjs` | Repo root (`/`) | Node.js `>=18.18.0` (`fetch`), running API server | Diagnostic CLI | Runs against running API server |

## 2. Shared Workspace (`packages/shared/package.json`)

| Script Name | Command | Working Directory | Declared Dependencies | Used by CI | Clean-Checkout Behavior |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `build` | `tsc -p tsconfig.json` | `packages/shared` | `devDependencies.typescript` (`^5.5.4`) | Yes | Emits `dist/index.js` and `dist/index.d.ts` |
| `typecheck` | `tsc -p tsconfig.json --noEmit` | `packages/shared` | `devDependencies.typescript` (`^5.5.4`) | Yes | Validates shared types |

## 3. API Workspace (`apps/api/package.json`)

| Script Name | Command | Working Directory | Declared Dependencies | Used by CI | Clean-Checkout Behavior |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `dev` | `tsx watch src/server.ts` | `apps/api` | `tsx`, PostgreSQL | No | Local development watcher |
| `prebuild` | `npm --prefix ../../packages/shared run build` | `apps/api` | `typescript` | Automatic hook | Guarantees `@crewmesh/shared` declarations exist before `apps/api` builds |
| `build` | `tsc -p tsconfig.json` | `apps/api` | `typescript`, `@crewmesh/shared` | Yes | Emits `apps/api/dist/server.js` |
| `start` | `node dist/server.js` | `apps/api` | Built `dist/server.js`, PostgreSQL | Yes | Runs compiled Fastify server |
| `pretypecheck` | `npm --prefix ../../packages/shared run build` | `apps/api` | `typescript` | Automatic hook | Guarantees `@crewmesh/shared` declarations exist before `tsc --noEmit` |
| `typecheck` | `tsc -p tsconfig.json --noEmit` | `apps/api` | `typescript`, `@crewmesh/shared` | Yes | Validates API types |
| `test` | `vitest run` | `apps/api` | `vitest`, PostgreSQL | Via root `test` | Runs all `.test.ts` suites |
| `test:integration` | `vitest run test/phase1.integration.test.ts test/batch2.integration.test.ts test/batch3.sse.integration.test.ts test/batch5.suggestions.integration.test.ts test/scale/scale-seed.integration.test.ts test/batch7.hardening.integration.test.ts` | `apps/api` | `vitest`, PostgreSQL 16 | Yes | Runs PostgreSQL integration suites |
| `test:race` | `vitest run test/batch2.race.test.ts` | `apps/api` | `vitest`, PostgreSQL 16 | Yes | Runs 50-way last-seat & invite race tests |
| `test:sse` | `vitest run test/batch3.sse.integration.test.ts` | `apps/api` | `vitest`, PostgreSQL 16 | Via `test:integration` | Runs durable SSE outbox tests |
| `test:suggestions` | `vitest run test/batch5.suggestions.integration.test.ts` | `apps/api` | `vitest`, PostgreSQL 16 | Via `test:integration` | Runs `crewmesh-match-v1` DB tests |
| `test:scale` | `vitest run test/scale/scale-seed.integration.test.ts` | `apps/api` | `vitest`, PostgreSQL 16 `*_loadtest` DB | Yes | Runs 10k/2k scale seeder integration tests |
| `test:hardening` | `vitest run test/batch7.hardening.integration.test.ts` | `apps/api` | `vitest`, PostgreSQL 16 | Yes | Runs Batch 7/8 concurrency & security hardening tests |
| `test:unit` | `node --test test/phase1.unit.test.mjs ... test/batch9.unit.test.mjs` | `apps/api` | Node.js `>=18.18.0`, `scripts/ts-loader.mjs` | Via `test:unit:sandbox` | Runs all 57 isolated unit tests |
| `db:migrate` | `tsx src/db/migrate.ts up` | `apps/api` | `tsx`, PostgreSQL 16 | Yes | Applies migrations `001`–`007` |
| `db:migrate:down` | `tsx src/db/migrate.ts down` | `apps/api` | `tsx`, PostgreSQL 16 | Yes | Rolls back latest migration |
| `db:migrate:status` | `tsx src/db/migrate.ts status` | `apps/api` | `tsx`, PostgreSQL 16 | Diagnostic | Prints applied vs pending migrations |
| `db:seed` | `tsx src/db/seed.ts` | `apps/api` | `tsx`, PostgreSQL 16 | Yes | Seeds Hack4Hack 2026 event |
| `db:seed:scale` | `tsx src/db/seed-scale.ts` | `apps/api` | `tsx`, PostgreSQL 16 `*_loadtest` DB | Yes | Seeds 10,000 participants & 2,000 teams |

## 4. Web Workspace (`apps/web/package.json`)

| Script Name | Command | Working Directory | Declared Dependencies | Used by CI | Clean-Checkout Behavior |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `dev` | `vite` | `apps/web` | `vite`, `@vitejs/plugin-react` | No | Local Vite dev server |
| `prebuild` | `npm --prefix ../../packages/shared run build` | `apps/web` | `typescript` | Automatic hook | Guarantees `@crewmesh/shared` declarations and JS bundle exist before Vite build |
| `build` | `tsc -p tsconfig.json --noEmit && vite build` | `apps/web` | `typescript`, `vite`, `@crewmesh/shared` | Yes | Emits `apps/web/dist/index.html` and hashed assets |
| `preview` | `vite preview --port 5173` | `apps/web` | `vite`, built `apps/web/dist` | Yes (`verify-and-test`) | Proxies `/api`, `/health`, `/healthz`, and `/ready` to `http://127.0.0.1:3001` |
| `pretypecheck` | `npm --prefix ../../packages/shared run build` | `apps/web` | `typescript` | Automatic hook | Guarantees `@crewmesh/shared` declarations exist before `tsc --noEmit` |
| `typecheck` | `tsc -p tsconfig.json --noEmit` | `apps/web` | `typescript`, `@crewmesh/shared` | Yes | Validates React/TSX types |
| `test` | `vitest run` | `apps/web` | `vitest` | Yes (`verify-and-test`) | Runs `apps/web/src/App.test.tsx` |
| `test:e2e` | `playwright test` | `apps/web` | `@playwright/test`, Chromium | Yes (`verify-and-test`) | Runs desktop & mobile Playwright E2E suite |
