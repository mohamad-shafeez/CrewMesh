# CrewMesh — Batch 06 Scale & k6 Load-Test Benchmark Environment

## 1. Benchmark Target & Configuration
- **Target Endpoint**: `GET /api/v1/hackathons/hack4hack-crew-2026/teams`
- **Load Generator**: Grafana k6 (`apps/api/load/board.k6.js`)
- **Warm-Up Phase**: `20` VUs for `10s` (`board_warmup`)
- **Measured Phase**: `100` concurrent virtual users (`constant-vus`) for `60s` (`board_load`)
- **Thresholds Enforced by k6**:
  - `http_req_duration{scenario:board_load}: ['p(95)<200']`
  - `http_req_failed{scenario:board_load}: ['rate<0.01']`
  - `checks{scenario:board_load}: ['rate>0.99']`

## 2. Seeded Benchmark Dataset (`npm run db:seed:scale`)
- **Seeder Module**: `apps/api/src/db/seed-scale.ts`
- **Database Isolation Requirements**:
  - `NODE_ENV !== 'production'`
  - `CREWMESH_ALLOW_SCALE_SEED=true`
  - PostgreSQL `current_database()` must end with `_loadtest` (e.g., `crewmesh_loadtest`)
  - Reserved synthetic participant email domain: `@crewmesh.invalid` (`loadtest-00001@crewmesh.invalid` .. `loadtest-10000@crewmesh.invalid`)
- **Dataset Counts**:
  - **Participants (`users` + `hackathon_participants`)**: `10,000`
  - **Teams (`teams`)**: `2,000` (`500` size-2, `500` size-3, `500` size-4, `500` size-5)
  - **Team Memberships (`team_members`)**: `7,000` (`2,000` leaders + `5,000` members)
  - **Unassigned Eligible Participants**: `3,000`
  - **Open-Capacity Recruiting Teams**: `1,500` (`looking_for_members = TRUE`)
  - **Full-Capacity Teams**: `500` (`member_count = 5`, `looking_for_members = FALSE`)

## 3. Execution Status in Current Sandbox Container
- **Status**: `NOT RUN` locally inside this sandbox VM container because outbound network access (`EAI_AGAIN`), local PostgreSQL 16 server binaries (`postgres`/`initdb`), Docker (`docker`), and the `k6` binary are not installed in the sandbox environment.
- **Automated CI Execution**: Wired in `.github/workflows/ci.yml` (`scale-and-k6-benchmark` job), which provisions `postgres:16-alpine`, creates `crewmesh_loadtest`, runs migrations `001`–`005`, runs `npm run db:seed:scale` (generating `reports/load-test/database-counts.json` and `reports/load-test/board-explain-plan.json`), starts the production Fastify server, runs `k6 run apps/api/load/board.k6.js` (generating `reports/load-test/k6-summary.json` and `reports/load-test/k6-summary.txt`), and uploads all artifacts.
- **No Fabricated Reports**: In accordance with Batch 06 Rules 5, 6, 8, 16, and 17, `k6-summary.json`, `k6-summary.txt`, `database-counts.json`, and `board-explain-plan.json` are generated exclusively by real PostgreSQL and k6 execution and are never pre-populated with synthetic numbers.
