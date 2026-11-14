# CrewMesh

**Find your people. Build your team.**  
*Hack4Hack Crew Hiring Challenge 2026 — Problem Statement 1 (PS1): Race-proof team formation at scale*

---

## 1. Overview & Problem Statement

During high-concurrency hackathon launches, hundreds of participants simultaneously create teams, send join requests, redeem invitation codes, and accept members into the last open seat on a team. Naive read-then-write application logic suffers from:
- **Last-seat overbooking** (`member_count > max_team_size` when two requests are accepted concurrently).
- **Split-brain multi-team membership** (a participant gets accepted into Team A and Team B simultaneously).
- **Orphaned or leaderless teams** when a leader leaves or the final member departs.
- **Out-of-order or leaked real-time events** when SSE notifications fire outside database commit order or include private applicant/invite fields.

**CrewMesh** solves PS1 by pushing core invariants into **PostgreSQL 16 constraints, deferred constraint triggers, deterministic row-level lock ordering (`FOR SHARE` / `FOR UPDATE`), and a serialized transactional outbox (`pg_advisory_xact_lock`)**, paired with an explainable skill + IANA time-zone teammate recommendation engine (`crewmesh-match-v1`) and a responsive React 18 interface.

---

## 2. Verification & Execution Status Matrix

In accordance with strict engineering honesty, the table below distinguishes between what is **implemented in source**, what has been **executed and verified locally in the sandbox**, what is **wired for PostgreSQL 16 / GitHub Actions execution**, and what remains **blocked locally due to offline container constraints**:

| Subsystem / Verification Suite | Implementation Status | Local Sandbox Execution Status | PostgreSQL 16 / Browser / k6 Status | Details & Evidence |
| :--- | :--- | :--- | :--- | :--- |
| **Monorepo Source & AST Verification (`npm run verify:sandbox`)** | **Implemented** | **Executed & Passed (`62 / 62` `.ts`/`.tsx` files)** | N/A | Transpiles all 62 TypeScript/TSX modules and verifies migrations `001`–`007`, routes, and schemas. |
| **Isolated Unit & Invariant Suite (`npm run test:unit:sandbox`)** | **Implemented** | **Executed & Passed (`57 / 57` tests across Batches 1–9)** | Configured in CI | All 9 unit test files (`phase1` through `batch9`) load and execute the real production TypeScript modules via `scripts/ts-loader.mjs` (cryptography, CSRF, cursors, recursive metadata sanitization, SSE allowlist projections, multi-page SSE replay `> 500` events, subscriber error recovery, `crewmesh-match-v1` scoring, 10k/2k deterministic dataset generation, and SSL config). |
| **ESLint Script & Test Linting (`npm run lint:scripts`)** | **Implemented** | **Executed & Passed (`0` errors, `0` warnings)** | Configured in CI (`npm run lint`) | `.eslintrc.js` uses ESLint's built-in `espree` parser for `.js`/`.mjs` files and `@typescript-eslint/parser` for `.ts`/`.tsx` files (without silent optional-parser fallback). Full `.ts`/`.tsx` linting (`npm run lint`) requires `npm ci` to install `@typescript-eslint/parser`. |
| **Root `package-lock.json` & `npm ci`** | **Blocked Offline** | **`NOT RUN` (`ENOTCACHED` on `--offline`; `EAI_AGAIN registry.npmjs.org` online)** | Enforced in `.github/workflows/ci.yml` | Outbound internet access is disabled and no cached npm metadata exists in the container (`~/.npm` has no `_cacache`), so a registry-resolved `package-lock.json` was not fabricated. CI enforces `package-lock.json` presence and `npm ci`. |
| **TypeScript `tsc --noEmit` & Production Build (`npm run typecheck`, `npm run build`)** | **Implemented** | **`NOT RUN` locally (requires `npm ci` binaries `tsc` & `vite`)** | Configured in `.github/workflows/ci.yml` | Workspace scripts and `prebuild`/`pretypecheck` hooks build `@crewmesh/shared` declarations before `@crewmesh/api` and `@crewmesh/web`. |
| **PostgreSQL Integration & Hardening (`npm run test:integration`, `npm run test:hardening`)** | **Implemented** | **`NOT RUN` locally (no local PostgreSQL 16 daemon)** | Configured in `.github/workflows/ci.yml` (`postgres:16-alpine`) | Covers `phase1.integration.test.ts`, `batch2.integration.test.ts`, `batch3.sse.integration.test.ts`, `batch5.suggestions.integration.test.ts`, `scale-seed.integration.test.ts`, and `batch7.hardening.integration.test.ts`. |
| **50-Way Last-Seat & Invite Race Suite (`npm run test:race`)** | **Implemented** | **`NOT RUN` locally (no local PostgreSQL 16 daemon)** | Configured in `.github/workflows/ci.yml` | Fires 50 barrier-synchronized transactions against 1 remaining team slot; asserts exactly `1` winner (`200`) and `49` deterministic `409` rejections. |
| **Playwright Desktop & Mobile E2E (`npm run test:e2e`)** | **Implemented** | **`NOT RUN` locally (no Chromium + PostgreSQL daemon)** | Configured in `.github/workflows/ci.yml` | Tests full registration, team creation, invite redemption, leader approval, live SSE updates, and `360px`/`390px` mobile viewports (`apps/web/e2e/crewmesh.spec.ts`). |
| **10k Participant / 2k Team Scale Seed & 100-VU k6 Benchmark (`npm run db:seed:scale`, `npm run bench:board:k6`)** | **Implemented** | **Dataset generator verified in memory (`57/57` unit tests); live DB/k6 `NOT RUN` locally** | Configured in `.github/workflows/ci.yml` (`scale-and-k6-benchmark`) | **Benchmark Target**: `p(95) < 200 ms`, error rate `< 1%` at `100` VUs for `60s`. **Actual Live Benchmark Result**: `NOT RUN` locally (pending execution in a networked PostgreSQL 16 + Grafana k6 runner; no synthetic numbers fabricated). |
| **Live Production Deployment** | **Pre-Deployment Validated** | **Not Deployed** | Same-origin Fastify + Vite SPA ready (`SERVE_WEB_DIST=true`) | Documented in `docs/deployment-architecture.md`. |

---

## 3. Repository Structure

```text
CrewMesh/
├── .env.example                      # Documented environment template (zero secrets)
├── .eslintrc.js                      # Monorepo ESLint configuration (.ts, .tsx, .mjs)
├── .github/workflows/ci.yml          # GitHub Actions workflow (PostgreSQL 16, Playwright, k6)
├── docker-compose.yml                # Local PostgreSQL 16 service definition
├── package.json                      # Root npm workspace manifest & scripts
├── packages/
│   └── shared/                       # @crewmesh/shared — Zod DTO schemas, canonical JSON, types
├── apps/
│   ├── api/                          # @crewmesh/api — Fastify 4 + PostgreSQL 16 backend
│   │   ├── migrations/               # SQL migrations 001..007 (.up.sql & .down.sql)
│   │   ├── load/board.k6.js          # Grafana k6 100-VU board load test (scenario-tagged metrics)
│   │   ├── src/
│   │   │   ├── config/env.ts         # Fail-fast Zod environment & production safety validator
│   │   │   ├── db/                   # Pool (with TLS support), migration CLI, seed & 10k/2k scale seeder
│   │   │   ├── plugins/              # Session hydration, security headers, structured error envelope
│   │   │   ├── routes/               # /health, /healthz, /ready, auth, teams, join-requests, invites, SSE
│   │   │   ├── security/             # Argon2id, SHA-256 sessions, HMAC CSRF, PostgreSQL rate limiter
│   │   │   └── services/             # Team engine, join requests, invites, SSE dispatcher, suggestions
│   │   └── test/                     # Unit (.mjs) + PostgreSQL integration & 50-way race (.ts) suites
│   └── web/                          # @crewmesh/web — React 18 + Vite 5 frontend
│       ├── e2e/crewmesh.spec.ts      # Playwright desktop & mobile E2E test suite
│       └── src/                      # Pages, components, SSE hooks, and logical idempotency client
├── docs/
│   ├── deployment-architecture.md    # Same-origin production validation & zero-cost hosting guide
│   ├── transaction-lock-order.md     # Deterministic PostgreSQL lock hierarchy
│   └── workspace-script-matrix.md    # Complete audit of all npm scripts across workspaces
├── infra/postgres/
│   └── init-test-db.sql              # Docker initialization script for crewmesh_test & crewmesh_loadtest
├── reports/load-test/
│   └── benchmark-environment.md      # k6 benchmark target, dataset specification & status
└── scripts/
    ├── healthcheck.mjs               # CLI health & readiness probe
    ├── ts-loader.mjs                 # Portable TypeScript/TSX loader for isolated Node unit tests
    └── verify-sandbox.mjs            # Static AST & architecture verifier across all 62 .ts/.tsx files
```

---

## 4. Database Invariants & Deterministic Lock Hierarchy

CrewMesh enforces seven sequential migrations (`apps/api/migrations/001` through `007`):
1. **`001_initial_schema.{up,down}.sql`**: Creates `users`, `sessions`, `hackathons`, `teams`, `team_members`, `join_requests`, `invite_codes`, `idempotency_keys`, `audit_log`, `outbox_events`, and `rate_limit_buckets`. Persisted `teams.status` values are `'forming'` (`member_count < min_team_size`) and `'ready'` (`member_count >= min_team_size`), while team fullness is represented via `member_count = max_team_size` (`isFull: true` in API responses). Enforces `UNIQUE (hackathon_id, user_id)` on `team_members` so a participant can never belong to two teams in the same hackathon.
2. **`002_team_engine_and_integrity.{up,down}.sql`**: Adds `DEFERRABLE INITIALLY DEFERRED` constraint triggers verifying at `COMMIT` time that every surviving team has `member_count = COUNT(team_members)`, `1 <= member_count <= max_team_size`, and **exactly one** member with `role = 'leader'`.
3. **`003_nullable_deadline_and_outbox_notify.{up,down}.sql`**: Makes `hackathons.registration_deadline` nullable and adds `AFTER INSERT ON outbox_events` trigger issuing `pg_notify('crewmesh_outbox', ...)`.
4. **`004_suggestions_and_preferences.{up,down}.sql`**: Adds `desired_skills TEXT[]` and `looking_for_members BOOLEAN` to `teams` with GIN and composite keyset indexes.
5. **`005_scale_performance_and_timezone_provenance.{up,down}.sql`**: Adds `users.timezone_confirmed_at`, creates `hackathon_participants`, drops duplicate indexes from `004`, and creates covering keyset pagination indexes for the 2,000-team board.
6. **`006_outbox_commit_order_and_participant_fk.{up,down}.sql`**: Serializes `outbox_events.id` allocation under `pg_advisory_xact_lock(842026002)` so outbox sequence IDs strictly match transaction commit order, and adds composite foreign keys from `teams`, `team_members`, and `join_requests` to `hackathon_participants(hackathon_id, user_id)`.
7. **`007_strict_outbox_id_and_rate_limit_cleanup.{up,down}.sql`**: Rejects any caller-supplied `NEW.id IS NOT NULL` on `outbox_events` with `ERRCODE = '23514'` so sequence serialization cannot be bypassed.

### Canonical Lock Order (`docs/transaction-lock-order.md`)
Every mutating transaction acquires row and advisory locks in strict order:
1. `idempotency_keys` (`FOR UPDATE`)
2. `teams` (`FOR UPDATE`)
3. `hackathon_participants` (`FOR SHARE` for team/request/invite creation; `FOR UPDATE` in `acceptJoinRequestTx` before locking `join_requests` to serialize cross-team acceptances of the same applicant without deadlocks)
4. `invite_codes` / `join_requests` / `team_members` (`FOR UPDATE`)
5. `pg_advisory_xact_lock(842026002)` (allocated inside `BEFORE INSERT ON outbox_events`)

---

## 5. Local Setup, Build & Verification Commands

### Prerequisites (Full Stack)
- **Node.js** `>= 18.18.0` (Node 20 LTS recommended) and **npm** `>= 9.0.0`
- **PostgreSQL 16** (`docker compose up -d postgres` or local PostgreSQL 16 service)

### Step-by-Step Clean-Checkout Commands
```bash
# 1. Generate lockfile if absent in a network-enabled environment, then install via npm ci
npm install --package-lock-only
npm ci

# 2. Copy environment configuration and start PostgreSQL 16
cp .env.example .env
docker compose up -d postgres

# 3. Apply migrations 001..007 and seed Hack4Hack 2026 event
npm run db:migrate
npm run db:seed

# 4. Run ESLint, TypeScript typechecking, and production builds
npm run lint
npm run typecheck
npm run build

# 5. Run unit, PostgreSQL integration, 50-way race, hardening, and E2E suites
npm run test:unit:sandbox
npm run test:integration
npm run test:race
npm run test:hardening
npm run test:e2e
```

### Scale Seeding (`10,000` Participants / `2,000` Teams) & k6 Benchmark
```bash
# Seed isolated crewmesh_loadtest database (requires CREWMESH_ALLOW_SCALE_SEED=true and *_loadtest DB name)
DATABASE_URL=postgresql://crewmesh:crewmesh_local_dev_password@localhost:5432/crewmesh_loadtest \
  CREWMESH_ALLOW_SCALE_SEED=true \
  npm run db:seed:scale

# Run Grafana k6 100-VU 60s board load test
npm run bench:board:k6
```
