# CrewMesh

**Find your people. Build your team.**  
*Hack4Hack Crew Hiring Challenge 2026 — Problem Statement 1 (PS1): Race-proof team formation at scale*

> **Live Production Deployment**: [crewmesh.onrender.com](https://crewmesh.onrender.com) · **Readiness Probe**: [/ready](https://crewmesh.onrender.com/ready) · **Health Check**: [/healthz](https://crewmesh.onrender.com/healthz) · **Source Repository**: [github.com/mohamad-shafeez/CrewMesh](https://github.com/mohamad-shafeez/CrewMesh)

---

## 1. Why CrewMesh Exists (Problem Statement 1)

During high-concurrency hackathon launches, hundreds of participants simultaneously create teams, send join requests, redeem invitation codes, and accept members into the last open seat on a team. Application-layer "read-then-write" checks fail under burst concurrency.

**CrewMesh** pushes every membership, capacity, leadership, and event-ordering guarantee directly into **PostgreSQL 16 constraints, `DEFERRABLE INITIALLY DEFERRED` constraint triggers, deterministic row-level lock ordering (`FOR SHARE` / `FOR UPDATE`), and an advisory-locked transactional outbox (`pg_advisory_xact_lock`)**, paired with an explainable skill and IANA time-zone recommendation engine (`crewmesh-match-v1`) and a single-origin React 18 interface.

| Concurrency Failure Mode | What Breaks in Naive Apps | How CrewMesh Prevents It in PostgreSQL 16 |
| :--- | :--- | :--- |
| **Last-Seat Overbooking** | Two leaders/requests pass `member_count < max_team_size` simultaneously and push the team over capacity. | `SELECT ... FOR UPDATE` on `teams` + `CHECK (member_count BETWEEN 1 AND max_team_size)` + deferred commit-time trigger verifying `member_count = COUNT(team_members)`. |
| **Split-Brain Multi-Team Membership** | A participant is accepted into Team A and Team B in parallel transactions. | `acceptJoinRequestTx` locks `hackathon_participants` `FOR UPDATE` before `join_requests`, backed by `UNIQUE (hackathon_id, user_id)` on `team_members` and automatic sibling request cancellation. |
| **Orphaned or Leaderless Teams** | Leader departure or concurrent removals leave `0` leaders or `2` leaders. | Partial unique index `idx_team_members_single_leader` (`WHERE role = 'leader'`) + deferred trigger `trg_enforce_team_integrity` enforcing exactly one leader at `COMMIT`. |
| **Out-of-Order or Leaked Live Events** | SSE notifications fire before commit, arrive out of sequence, or leak private applicant/invite fields. | `outbox_events` sequence allocation is serialized under `pg_advisory_xact_lock(842026002)` at commit boundary, dispatched via `LISTEN/NOTIFY` with strict per-event public field allowlists. |

---

## 2. Live Deployment & Production Architecture

CrewMesh runs in production under a unified single-origin architecture so `HttpOnly; Secure; SameSite=Lax` session cookies, HMAC-SHA256 CSRF `Origin` validation, and native `EventSource` SSE streams operate without cross-origin preflight overhead.

| Layer | Production Stack | Live Endpoint / Configuration |
| :--- | :--- | :--- |
| **Web & API Runtime** | Fastify 4 + React 18 SPA (`SERVE_WEB_DIST=true`, `TRUST_PROXY=true`) on [Render](https://render.com/docs/free) (`Singapore`) | [https://crewmesh.onrender.com](https://crewmesh.onrender.com) |
| **Database Engine** | [Neon PostgreSQL 16](https://neon.com/pricing) (`AWS ap-southeast-1`, Direct TLS connection with pooling disabled for `LISTEN/NOTIFY`) | Migrations `001`–`007` applied; `hack4hack-crew-2026` seeded |
| **Database Readiness** | Live `SELECT 1` + latency probe | [https://crewmesh.onrender.com/ready](https://crewmesh.onrender.com/ready) |
| **Liveness Probe** | Zero-DB process health check (monitored via [UptimeRobot](https://uptimerobot.com/)) | [https://crewmesh.onrender.com/healthz](https://crewmesh.onrender.com/healthz) |

```text
Browser (React 18 + Vite 5 SPA + Native EventSource)
   │  Same-Origin HTTPS (Cookie: crewmesh_session + X-CSRF-Token + Idempotency-Key)
   ▼
Fastify 4 API Server (@crewmesh/api)
   ├── Mutating Routes (/api/v1/teams, /join-requests, /invites)
   │     └── PostgreSQL 16 Transaction (withTransaction)
   │           1. Lock idempotency_keys (FOR UPDATE)
   │           2. Lock teams (FOR UPDATE)
   │           3. Lock hackathon_participants (FOR SHARE / FOR UPDATE)
   │           4. Mutate team_members / join_requests / invite_codes
   │           5. Acquire pg_advisory_xact_lock(842026002) -> Insert outbox_events + audit_log
   │           6. COMMIT -> Deferred triggers validate invariants -> pg_notify('crewmesh_outbox')
   │
   └── Real-Time SSE Dispatcher (/api/v1/hackathons/:slug/events & /teams/:teamId/events)
         └── Dedicated PG LISTEN Connection + 500-Row Paginated Catch-Up Replay + Allowlist Projection
```

---

## 3. Core Engineering Capabilities

- **Race-Proof Team Lifecycle (`apps/api/src/services/team-service.ts`)**:
  - Teams require `2`–`5` members (`min_team_size = 2`, `max_team_size = 5`). Teams below minimum capacity persist as `'forming'` and automatically transition to `'ready'` once `member_count >= min_team_size` (with `isFull: true` when `member_count = max_team_size`).
  - Every join path—whether via public board join request or 8-character cryptographic invitation code—creates a pending join request requiring explicit team leader approval.
  - If the sole remaining member leaves a team, the team is cleanly dissolved in the same transaction; if a leader leaves a multi-member team, leadership must be transferred first.
- **Explainable Teammate Matching (`crewmesh-match-v1`)**:
  - Scores candidate teams and participants deterministically (`55%` skill coverage + `30%` IANA time-zone compatibility + `15%` role & availability alignment) without opaque black-box embeddings.
  - Computes real UTC offset deltas from validated IANA time zones (e.g., `Asia/Kolkata`, `America/New_York`) and returns human-readable match reasons plus structured breakdown percentages.
- **Defense-in-Depth Security (`apps/api/src/security/`)**:
  - **Argon2id** password hashing (`memoryCost: 19456 KiB`, `timeCost: 2`, `parallelism: 1`).
  - **Opaque 256-bit sessions** stored as SHA-256 digests in PostgreSQL (`sessions.token_hash`), never raw tokens.
  - **Stateless HMAC-SHA256 CSRF tokens** bound to the session hash and verified with `crypto.timingSafeEqual` alongside strict `Origin` header validation.
  - **Transactional Idempotency (`Idempotency-Key`)** with SHA-256 canonical payload fingerprinting so network retries never duplicate mutations.

---

## 4. Verification & Execution Status Matrix

To maintain strict engineering transparency, the matrix below separates what is **implemented in source**, what was **executed in the isolated local sandbox**, what is **wired in GitHub Actions CI**, and what is **live in production**:

| Subsystem / Verification Suite | Implementation Status | Local Sandbox Status | CI / Production Status | Evidence & Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Monorepo AST & Architecture Verification (`npm run verify:sandbox`)** | **Implemented** | **Executed & Passed (`62 / 62` `.ts`/`.tsx` files)** | Verified in repo | Transpiles all 62 TypeScript/TSX modules and validates migrations `001`–`007`, routes, and shared Zod schemas. |
| **Isolated Unit & Invariant Suite (`npm run test:unit:sandbox`)** | **Implemented** | **Executed & Passed (`57 / 57` tests across Batches 1–9)** | Runs in [GitHub Actions CI](https://github.com/mohamad-shafeez/CrewMesh/actions) | Executes real production TypeScript modules via `scripts/ts-loader.mjs` (Argon2id, CSRF, cursors, recursive metadata sanitization, SSE allowlist projection, `> 500`-event SSE replay, `crewmesh-match-v1` scoring, 10k/2k scale generator, and SSL config). |
| **ESLint Script & Test Linting (`npm run lint:scripts`)** | **Implemented** | **Executed & Passed (`0` errors, `0` warnings)** | Full `npm run lint` in CI | Uses `espree` for `.js`/`.mjs` and `@typescript-eslint/parser` for `.ts`/`.tsx` without silent fallback. |
| **Root `package-lock.json` & `npm ci`** | **Implemented** | Generated & verified (`320` packages) | **Executed in CI & Render Build** | Committed to [CrewMesh `main`](https://github.com/mohamad-shafeez/CrewMesh) and verified via `npm ci --include=dev`. |
| **TypeScript `tsc --noEmit` & Production Build (`npm run build`)** | **Implemented** | Verified via AST loader locally | **Executed & Passed on Render & CI** | Builds `@crewmesh/shared`, `@crewmesh/api`, and `@crewmesh/web` production bundles cleanly. |
| **PostgreSQL 16 Integration & Hardening (`npm run test:integration`, `npm run test:hardening`)** | **Implemented** | Requires PostgreSQL 16 daemon | Configured in `.github/workflows/ci.yml` (`postgres:16-alpine`) | Covers `phase1`, `batch2`, `batch3.sse`, `batch5.suggestions`, `scale-seed`, and `batch7.hardening` integration suites. |
| **50-Way Last-Seat & Invite Race Suite (`npm run test:race`)** | **Implemented** | Requires PostgreSQL 16 daemon | Configured in `.github/workflows/ci.yml` | Fires 50 barrier-synchronized transactions against 1 remaining team slot; asserts `1` winner (`200`) and `49` deterministic `409` rejections. |
| **Playwright Desktop & Mobile E2E (`npm run test:e2e`)** | **Implemented** | Requires Chromium + PostgreSQL 16 | Configured in `.github/workflows/ci.yml` | Tests registration, team creation, invite redemption, leader approval, live SSE updates, and `360px`/`390px` mobile viewports. |
| **10k Participant / 2k Team Scale Seed & 100-VU k6 Benchmark (`npm run db:seed:scale`, `npm run bench:board:k6`)** | **Implemented** | Generator verified in memory (`57/57` unit tests) | Configured in `.github/workflows/ci.yml` (`scale-and-k6-benchmark`) | **Target**: `p(95) < 200 ms`, error rate `< 1%` at `100` VUs for `60s` (`apps/api/load/board.k6.js`). |
| **Live Production Deployment** | **Deployed & Live** | N/A | **Live at [crewmesh.onrender.com](https://crewmesh.onrender.com)** | Hosted on Render (Free Web Service) + Neon PostgreSQL 16 (Singapore) with migrations `001`–`007` and `hack4hack-crew-2026` seeded. |

---

## 5. Database Invariants & Deterministic Lock Hierarchy

CrewMesh enforces seven sequential SQL migrations (`apps/api/migrations/001` through `007`):

1. **`001_initial_schema.{up,down}.sql`**: Creates `users`, `sessions`, `hackathons`, `teams`, `team_members`, `join_requests`, `invite_codes`, `idempotency_keys`, `audit_log`, `outbox_events`, and `rate_limit_buckets`. Enforces `UNIQUE (hackathon_id, user_id)` on `team_members` so a participant can never belong to two teams in the same hackathon.
2. **`002_team_engine_and_integrity.{up,down}.sql`**: Adds `DEFERRABLE INITIALLY DEFERRED` constraint triggers verifying at `COMMIT` time that every surviving team has `member_count = COUNT(team_members)`, `1 <= member_count <= max_team_size`, and **exactly one** member with `role = 'leader'`.
3. **`003_nullable_deadline_and_outbox_notify.{up,down}.sql`**: Makes `hackathons.registration_deadline` nullable and adds `AFTER INSERT ON outbox_events` trigger issuing `pg_notify('crewmesh_outbox', ...)`.
4. **`004_suggestions_and_preferences.{up,down}.sql`**: Adds `desired_skills TEXT[]` and `looking_for_members BOOLEAN` to `teams` with GIN and composite keyset indexes.
5. **`005_scale_performance_and_timezone_provenance.{up,down}.sql`**: Adds `users.timezone_confirmed_at`, creates `hackathon_participants`, drops duplicate indexes from `004`, and creates covering keyset pagination indexes for the 2,000-team board.
6. **`006_outbox_commit_order_and_participant_fk.{up,down}.sql`**: Serializes `outbox_events.id` allocation under `pg_advisory_xact_lock(842026002)` so outbox sequence IDs strictly match transaction commit order, and adds composite foreign keys from `teams`, `team_members`, and `join_requests` to `hackathon_participants(hackathon_id, user_id)`.
7. **`007_strict_outbox_id_and_rate_limit_cleanup.{up,down}.sql`**: Rejects any caller-supplied `NEW.id IS NOT NULL` on `outbox_events` with `ERRCODE = '23514'` so sequence serialization cannot be bypassed.

### Canonical Lock Order (`docs/transaction-lock-order.md`)
Every mutating transaction acquires row and advisory locks in strict order to prevent deadlocks:
1. `idempotency_keys` (`FOR UPDATE`)
2. `teams` (`FOR UPDATE`)
3. `hackathon_participants` (`FOR SHARE` for team/request/invite creation; `FOR UPDATE` in `acceptJoinRequestTx` before locking `join_requests` to serialize cross-team acceptances of the same applicant)
4. `invite_codes` / `join_requests` / `team_members` (`FOR UPDATE`)
5. `pg_advisory_xact_lock(842026002)` (allocated inside `BEFORE INSERT ON outbox_events`)

---

## 6. Repository Structure

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

## 7. Local Setup, Build & Verification Commands

### Prerequisites
- **Node.js** `>= 18.18.0` (Node 20 LTS recommended) and **npm** `>= 9.0.0`
- **PostgreSQL 16** (`docker compose up -d postgres` or local PostgreSQL 16 instance)

### Step-by-Step Clean-Checkout Commands
```bash
# 1. Install deterministic dependencies from package-lock.json
npm ci

# 2. Copy environment configuration and start PostgreSQL 16
cp .env.example .env
docker compose up -d postgres

# 3. Apply migrations 001..007 and seed the Hack4Hack 2026 event
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
