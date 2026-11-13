# CrewMesh — Race-Proof Team Formation at Scale

> *"Find your people. Build your team."*  
> Built for **Hack4Hack Crew Hiring Challenge 2026 — Problem Statement 1 (PS1): Race-proof team formation at scale** (Submission deadline: May 25, 2026).

---

## 1. Product Overview
**CrewMesh** is a full-stack, PostgreSQL-enforced team formation and teammate-intelligence platform designed for high-concurrency hackathons. It guarantees that even under intense simultaneous load (such as 50 concurrent leader acceptances competing for a single remaining seat, or two leaders simultaneously accepting the same participant into two different teams), team capacity bounds, single-leader invariants, and one-team-per-participant-per-hackathon constraints are never violated.

## 2. Hack4Hack PS1 Problem Statement
Hackathon team formation routinely breaks under concurrent user actions:
- Multiple team leaders accepting the same applicant at the same millisecond.
- Dozens of join requests or invite redemptions competing for the final seat on a team.
- Network retries duplicating team creation, join requests, or membership changes.
- Disconnected clients missing real-time board or team inbox updates.

CrewMesh solves PS1 at the **PostgreSQL storage and transaction layer**, combining row-level locks (`FOR UPDATE` / `FOR SHARE`), `DEFERRABLE INITIALLY DEFERRED` constraint triggers, payload-bound idempotency keys, serialized transactional outbox events (`pg_advisory_xact_lock`), and an explainable skill + IANA time-zone recommendation engine (`crewmesh-match-v1`).

## 3. Feature List
1. **Argon2id Authentication & Session Security**: Registration with atomic hackathon enrollment, login with session rotation, `HttpOnly; SameSite=Lax` opaque 256-bit sessions (SHA-256 hashed in PostgreSQL), constant-time `X-CSRF-Token` verification, and dual IP + SHA-256 email rate limiting.
2. **Race-Proof Team Creation & Keyset-Paginated Discovery Board**: Zero-`OFFSET` `(created_at DESC, id DESC)` keyset pagination with status (`forming` / `ready`), capacity (`hasCapacity`), recruiting (`lookingForMembers`), GIN skill (`desired_skills @> ARRAY[skill]`), and search filters, plus batched single-query member hydration.
3. **Serialized Join-Request Inbox & Leader Approval**: Board join requests and 256-bit invitation redemptions both create `pending` join requests requiring explicit leader approval.
4. **Deterministic Leadership Succession & Last-Member Team Deletion**: When a leader leaves a multi-member team, the earliest-joined remaining member (`ORDER BY joined_at ASC, user_id ASC`) is atomically promoted to `leader`; when the final remaining member leaves, the team is deleted while `audit_log` and `outbox_events` history survives intact.
5. **Durable Real-Time SSE Streams**: Public board SSE (`GET /api/v1/hackathons/:hackathonId/events`) and authenticated private team SSE (`GET /api/v1/teams/:teamId/events`) with `BigInt`-safe `Last-Event-ID` multi-page replay, listener drop auto-recovery, and immediate stream termination on member removal.
6. **Explainable Teammate Intelligence (`crewmesh-match-v1`)**: Leader-only recommendations (`GET /api/v1/teams/:teamId/suggestions`) combining `70%` unmet desired skill coverage and `30%` DST-aware circular 24-hour IANA UTC-offset proximity, plus transactional team skill preference updates (`PATCH /api/v1/teams/:teamId/preferences`).
7. **10,000-Participant / 2,000-Team Scale Seeder & 100-VU Grafana k6 Benchmark**: Deterministic bulk `UNNEST` seeder (`npm run db:seed:scale`) with strict `_loadtest` database safety guards and Grafana k6 load test (`apps/api/load/board.k6.js`).

## 4. Architecture
```text
crewmesh/
├── packages/
│   └── shared/                 # Shared TypeScript DTOs, error codes, normalization & canonical JSON helpers
├── apps/
│   ├── api/                    # Fastify 4 + PostgreSQL (pg) backend API & SSE server
│   │   ├── migrations/         # Versioned SQL migrations 001..007 (.up.sql & .down.sql)
│   │   ├── src/
│   │   │   ├── config/         # Environment validation (Zod)
│   │   │   ├── db/             # Pool, migration runner, hackathon seeder & 10k/2k scale seeder
│   │   │   ├── plugins/        # Session hydration, security headers & structured error handler
│   │   │   ├── routes/         # health, auth, teams, join-requests, invites, events
│   │   │   ├── security/       # Argon2id, CSPRNG tokens, CSRF & PostgreSQL rate limiter
│   │   │   └── services/       # team, join-request, invite, suggestion, idempotency, audit/outbox, sse
│   │   ├── load/               # Grafana k6 100-VU board benchmark (board.k6.js)
│   │   └── test/               # Unit (.mjs) and PostgreSQL integration/race/SSE/scale suites (.ts)
│   └── web/                    # React 18 + Vite 5 SPA (Colorion light-botanical design system)
│       ├── src/                # Pages, components, SSE hooks, API client & CSS tokens
│       └── e2e/                # Playwright Chromium desktop & 360px mobile E2E suite
├── docs/
│   └── transaction-lock-order.md
├── infra/postgres/             # Docker entrypoint creating crewmesh_test and crewmesh_loadtest
└── scripts/                    # Portable TS loader, AST verifier & healthcheck scripts
```

## 5. Non-Negotiable Database Invariants
Enforced directly in PostgreSQL across migrations `001`–`007`:
- **One Team Per Participant Per Hackathon**: `CONSTRAINT team_members_one_team_per_hackathon_unique UNIQUE (hackathon_id, user_id)`
- **Valid Event Registration**: `team_members_participant_fk` and `join_requests_participant_fk` referencing `hackathon_participants (hackathon_id, user_id) ON DELETE RESTRICT`
- **Team Size & Status Consistency**: `teams_member_count_bounds_chk` (`1 <= member_count <= max_team_size`) and `teams_status_min_size_consistency_chk` (`forming` when `< min_team_size`, `ready` when `>= min_team_size`)
- **Single Leader & Exact Counter Triggers**: `DEFERRABLE INITIALLY DEFERRED` constraint triggers `trg_teams_verify_integrity` and `trg_team_members_verify_integrity` verify at commit time that `teams.member_count == COUNT(team_members)` and every existing team has `COUNT(*) FILTER (WHERE role = 'leader') == 1` matching `teams.leader_user_id`.
- **One Pending Join Request Per User Per Team**: `CREATE UNIQUE INDEX idx_join_requests_one_pending_per_team_user ON join_requests (team_id, user_id) WHERE status = 'pending'`
- **Audit & Outbox Survival**: `audit_log` and `outbox_events` store `team_id` without a cascading foreign key so deletion of a team by its last departing member never erases audit or outbox history.

## 6. Transaction Design & Lock Hierarchy
All mutating operations acquire locks in a strict global order (documented in `docs/transaction-lock-order.md`):
1. `idempotency_keys` (`INSERT ... ON CONFLICT (actor_user_id, operation, idempotency_key) DO UPDATE`)
2. `teams` (`SELECT ... FROM teams WHERE id = $1 FOR UPDATE`)
3. `hackathon_participants` (`SELECT status FROM hackathon_participants WHERE hackathon_id = $1 AND user_id = $2 FOR SHARE` — conflicts with `FOR NO KEY UPDATE` status changes to `'withdrawn'` or `'disqualified'`)
4. Child entity lock (`join_requests FOR UPDATE` / `invite_codes FOR UPDATE` / `team_members ORDER BY joined_at ASC, user_id ASC FOR UPDATE`)
5. Outbox serialization lock (`pg_advisory_xact_lock(842026002)` inside `trg_outbox_events_serialize_id`)

## 7. Idempotency
Every state-changing endpoint (`POST`, `PATCH`, `DELETE` on teams, join requests, and invites) requires an `Idempotency-Key` header (`8..128` printable ASCII characters). Keys are scoped to `(actor_user_id, operation, idempotency_key)` and bound to a canonical SHA-256 request hash (`canonicalJsonStringify`). Retrying with the same key and payload replays the original HTTP status and body (`X-Idempotent-Replay: true`); reusing the same key with a different payload returns `409 IDEMPOTENCY_KEY_REUSED`.

## 8. Durable Outbox & Real-Time SSE
- **Commit-Order Serialization (Migrations `006` & `007`)**: `trg_outbox_events_serialize_id` rejects any caller-supplied `outbox_events.id` and acquires `pg_advisory_xact_lock(842026002)` before calling `nextval('outbox_events_id_seq')`, ensuring sequence allocation order strictly equals transaction commit order.
- **Atomic Subscriber Registration & Multi-Page Replay**: `OutboxSseDispatcher` synchronizes `registerSubscriber` and `drainNewOutboxEvents` through an exclusive async queue (`runExclusive`), paginates `Last-Event-ID` replay in 250-row batches (`> 500` events supported) with SQL-level role filtering, and isolates per-subscriber transient errors with automatic catch-up recovery.

## 9. Invitation Approval Workflow
Invitation codes use 256 bits of CSPRNG entropy (`generateOpaqueToken(32)`). Only `sha256Hex(code)` (`token_hash`) and an 8-character `token_prefix` are stored in PostgreSQL. Redeeming an invitation (`POST /api/v1/invites/redeem`) verifies `hackathon_participants` eligibility (`FOR SHARE`), team capacity, expiration, revocation, and `use_count < max_uses`, atomically increments `use_count`, and creates a `pending` join request (`source = 'invite_code'`) for leader approval—never bypassing leader review.

## 10. Explainable Teammate Recommendation Algorithm (`crewmesh-match-v1`)
- **Weights**: `70%` complementary unmet desired skill coverage + `30%` IANA time-zone UTC-offset proximity.
- **Skill Score**: $|K_c \cap U| / |U| \times 100$ where $U = D \setminus \bigcup_{m \in M} S_m$. Returns `null` when the team has no declared desired skills (`no_team_desired_skills`) or when existing members already cover all desired skills (`all_desired_skills_covered`).
- **Time-Zone Score**: Evaluates valid confirmed IANA time zones at a single PostgreSQL reference timestamp (`SELECT NOW()`) via `Intl.DateTimeFormat`, computing circular 24-hour distance $d = \min(|o_c - o_m| \bmod 1440, 1440 - (|o_c - o_m| \bmod 1440)) \in [0, 720]$ and pairwise score $100 \times (1 - d/720)$.
- **Tie-Breaking**: `overallScore DESC`, `skillScore DESC NULLS LAST`, `timezoneScore DESC NULLS LAST`, `userId ASC`.

## 11. Time-Zone Provenance
Migration `005` removed the implicit `'UTC'` default on `users.timezone` and added `users.timezone_confirmed_at TIMESTAMPTZ NULL` with `CHECK ((timezone IS NULL AND timezone_confirmed_at IS NULL) OR (timezone IS NOT NULL AND timezone_confirmed_at IS NOT NULL))`. Unconfirmed time zones are stored and projected as `null` and never fabricated as `UTC`.

## 12. Scale Test Methodology (`10,000` Participants / `2,000` Teams)
`npm run db:seed:scale` (`apps/api/src/db/seed-scale.ts`) seeds an isolated `*_loadtest` database using bulk parameterized `UNNEST` statements:
- `10,000` participants (`loadtest-00001@crewmesh.invalid` .. `loadtest-10000@crewmesh.invalid`) in `users` and `hackathon_participants`
- `2,000` teams (`500` size-2, `500` size-3, `500` size-4, `500` size-5 = `7,000` `team_members` rows; `1,500` open-capacity teams, `500` full teams)
- `3,000` unassigned eligible participants (`7,001..10,000`)

## 13. Load-Test Target
`apps/api/load/board.k6.js` runs a `10s` warm-up (`20` VUs) followed by a `60s` constant-concurrency measurement phase (`100` VUs, `scenario:board_load`) against `GET /api/v1/hackathons/hack4hack-crew-2026/teams`, enforcing `http_req_duration{scenario:board_load}: ['p(95)<200']` and `http_req_failed{scenario:board_load}: ['rate<0.01']`.

## 14. Local Setup & 15. Environment Configuration
1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Start PostgreSQL 16 via Docker Compose (creates `crewmesh_dev`, `crewmesh_test`, and `crewmesh_loadtest`):
   ```bash
   docker compose up -d
   ```
3. Install dependencies, run migrations, seed the event, and start the servers:
   ```bash
   npm ci
   npm run db:migrate
   npm run db:seed
   npm run dev:api
   npm run dev:web
   ```
   When running in single-origin production mode (`NODE_ENV=production` or `SERVE_WEB_DIST=true` after `npm run build`), the Fastify server on `PORT` (default `3001`) also serves `apps/web/dist` directly so cookies (`SameSite=Lax`), CSRF `Origin` checks, and SSE streams operate on one origin.

## 16. Migration Commands
- Apply pending migrations (`001`–`007`): `npm run db:migrate`
- Roll back latest migration (non-production only): `npm run db:migrate:down`
- Inspect applied migrations and SHA-256 checksums: `npm run db:migrate:status --workspace=@crewmesh/api`

## 17. Tests & 18. CI Workflow
- Sandbox / Isolated Unit & Invariant Suite (52 tests): `npm run test:unit:sandbox`
- PostgreSQL Integration Suite (Batches 1–8): `npm run test:integration --workspace=@crewmesh/api`
- 50-Way Last-Seat & 20-Way Invite Race Suite: `npm run test:race --workspace=@crewmesh/api`
- Playwright Desktop & `360px` Mobile E2E Suite: `npm run test:e2e`
- Scale Seeding & k6 Benchmark: `CREWMESH_ALLOW_SCALE_SEED=true DATABASE_URL=.../crewmesh_loadtest npm run db:seed:scale && npm run bench:board:k6`
- All stages are wired in `.github/workflows/ci.yml` (`push`, `pull_request`, and manual `workflow_dispatch`).

## 19. Security Principles
- Recursive case-normalized secret & PII sanitization (`sanitizeEventMetadata`) across objects, nested objects, arrays of objects, and nested arrays.
- Explicit event-type allowlist projections on both public board and private team SSE streams.
- Dual `auth_ip` and SHA-256 `auth_email` login throttling with bounded `FOR UPDATE SKIP LOCKED` expired bucket cleanup.

## 20. Known Limitations & 21. Current Verification Status
- **Time-Zone Proximity**: `crewmesh-match-v1` evaluates current UTC-offset distance at the server evaluation timestamp, which estimates geographical/time-zone proximity rather than proving overlapping individual working hours.
- **Verification Status**: All 52 unit and invariant tests (`npm run test:unit:sandbox`), ESLint checks, and 62-file TypeScript/TSX AST transpilation checks (`node scripts/verify-sandbox.mjs`) have been executed and passed locally. Live PostgreSQL (`vitest`), Playwright browser E2E, and Grafana `k6` 100-VU benchmarks are wired in `.github/workflows/ci.yml` and marked `NOT RUN` locally in the offline build container.
