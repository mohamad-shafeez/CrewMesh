# CrewMesh — Scale & k6 Load-Test Benchmark Environment (Batches 06–09)

## 1. Benchmark Target & Configuration
- **Target Endpoint**: `GET /api/v1/hackathons/hack4hack-crew-2026/teams`
- **Load Generator**: Grafana k6 (`apps/api/load/board.k6.js`)
- **Warm-Up Phase**: `20` VUs for `10s` (`board_warmup`)
- **Measured Phase**: `100` concurrent virtual users (`constant-vus`) for `60s` (`board_load`, `startTime: '10s'`)
- **Thresholds Enforced by k6**:
  - `http_req_duration{scenario:board_load}: ['p(95)<200']`
  - `http_req_failed{scenario:board_load}: ['rate<0.01']`
  - `checks{scenario:board_load}: ['rate>0.99']`
- **Scenario-Tagged Summary Isolation (Batch 08/09)**:
  - `handleSummary()` reads `data.metrics['http_reqs{scenario:board_load}']` first so setup-phase login/board warm-up requests do not inflate the reported `board_load_http_reqs` count, while also recording `total_http_reqs_including_setup` separately.

## 2. Seeded Benchmark Dataset (`npm run db:seed:scale`)
- **Seeder Module**: `apps/api/src/db/seed-scale.ts`
- **Database Isolation Requirements**:
  - `NODE_ENV !== 'production'`
  - `CREWMESH_ALLOW_SCALE_SEED=true`
  - PostgreSQL `current_database()` must end with `_loadtest` (e.g., `crewmesh_loadtest`)
  - Reserved synthetic participant email domain: `@crewmesh.invalid` (`loadtest-00001@crewmesh.invalid` .. `loadtest-10000@crewmesh.invalid`)
- **Exact Verified Dataset Counts (`assertExactScaleCountsSnapshot`)**:
  - **Participants (`users` + `hackathon_participants`)**: `10,000`
  - **Teams (`teams`)**: `2,000` (SQL-verified exact distribution: `500` size-2, `500` size-3, `500` size-4, `500` size-5)
  - **Team Memberships (`team_members`)**: `7,000` (`2,000` leaders + `5,000` members)
  - **Unassigned Eligible Participants**: `3,000`
  - **Open-Capacity Recruiting Teams**: `1,500` (`looking_for_members = TRUE`)
  - **Full-Capacity Teams**: `500` (`member_count = 5`, `looking_for_members = FALSE`, `status = 'full'`)

## 3. Execution Status vs. Benchmark Target
- **Benchmark Target**: `p(95) < 200 ms`, error rate `< 1%`, check pass rate `> 99%` under `100` concurrent virtual users for `60s` against `10,000` participants and `2,000` teams.
- **Deterministic Dataset & Safety Guard Unit Verification (`batch6.unit.test.mjs`, `batch8.unit.test.mjs`, `batch9.unit.test.mjs`)**: **Executed & Passed locally** (`10,000` users, `2,000` teams, `7,000` memberships, exact `500` per size `2..5` verified in memory in `~850 ms`).
- **Live PostgreSQL & k6 Execution Status in Current Sandbox Container**: **`NOT RUN` locally** inside this sandbox VM container because outbound network access (`EAI_AGAIN`), local PostgreSQL 16 server binaries (`postgres`/`initdb`), Docker (`docker`), and the `k6` binary are not installed in the sandbox environment.
- **Automated CI Execution**: Wired in `.github/workflows/ci.yml` (`scale-and-k6-benchmark` job), which provisions `postgres:16-alpine`, creates `crewmesh_loadtest`, runs migrations `001`–`007`, runs `npm run db:seed:scale` (generating `reports/load-test/database-counts.json` and `reports/load-test/board-explain-plan.json`), starts the production Fastify server, runs `npm run bench:board:k6` twice (generating `reports/load-test/k6-summary.json` and `reports/load-test/k6-summary.txt`), and uploads all artifacts.
- **No Fabricated Reports**: `k6-summary.json`, `k6-summary.txt`, `database-counts.json`, and `board-explain-plan.json` are generated exclusively by real PostgreSQL and k6 execution and are never pre-populated with synthetic numbers.
