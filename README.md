# CrewMesh — Hack4Hack Crew Hiring Challenge 2026 (PS1)

**Problem Statement:** PS1 — Race-proof team formation at scale  
**Current Implementation Status:** Phase 1 (Foundation, Database Invariants, Authentication Foundation & Reproducible Local Setup)

---

## 1. Architecture Overview

CrewMesh is structured as a strict TypeScript npm-workspaces monorepo:

```text
crewmesh/
  apps/
    api/                 # Fastify + pg + Argon2id + Zod backend API
    web/                 # React + TypeScript + Vite frontend shell
  packages/
    shared/              # Shared DTO contracts and canonical normalizers
  infra/
    postgres/            # Docker PostgreSQL initialization scripts
  scripts/               # CLI healthcheck and verification utilities
  docker-compose.yml     # Local PostgreSQL 16 service with persistent volume
  .env.example           # Placeholder environment configuration
```

### Non-Negotiable Database Invariants Enforced in `001_initial_schema.up.sql`

1. **One Team Per Participant Per Hackathon:** `team_members` enforces `UNIQUE (hackathon_id, user_id)`.
2. **Team Size Bounds & Forming/Ready Status:** `teams` enforces `CHECK (member_count >= 1 AND member_count <= max_team_size)` and `CHECK ((member_count < min_team_size AND status = 'forming') OR (member_count >= min_team_size AND status = 'ready'))`.
3. **Single Leader Per Team:** Partial unique index `idx_team_members_one_leader_per_team` on `team_members (team_id) WHERE role = 'leader'`.
4. **Single Pending Request Per Applicant/Team:** Partial unique index `idx_join_requests_one_pending_per_team_user` on `join_requests (team_id, user_id) WHERE status = 'pending'`.
5. **Hashed Secrets Only:** `users.password_hash` enforces Argon2id format (`$argon2id$%`); `sessions.token_hash`, `sessions.csrf_token_hash`, and `invite_codes.token_hash` enforce 64-char SHA-256 hex format. Plaintext tokens are never persisted or logged.
6. **Scoped Idempotency Keys:** `idempotency_keys` enforces `UNIQUE (actor_user_id, operation, idempotency_key)` bound to a SHA-256 `request_hash`.
7. **Durable Audit & Outbox History Across Team Deletion:** `audit_log` and `outbox_events` store `team_id` without a cascading foreign key so team deletion preserves full audit history.

---

## 2. Local Setup & Exact Commands

### Prerequisites

- Node.js `>= 18.18.0` and npm `>= 9.0.0`
- Docker & Docker Compose (for local PostgreSQL 16)

### Step 1 — Environment Configuration

```bash
cp .env.example .env
```

### Step 2 — Install Dependencies

```bash
npm install
```

### Step 3 — Start Local PostgreSQL via Docker Compose

```bash
docker compose up -d
docker compose ps
```

The container automatically provisions both `crewmesh_dev` and `crewmesh_test` databases via `infra/postgres/init-test-db.sql`.

### Step 4 — Apply Versioned SQL Migrations & Seed Hack4Hack 2026

```bash
npm run db:migrate
npm run db:seed
```

To inspect migration status or roll back the latest migration in non-production environments:

```bash
npm run db:migrate:status --workspace=@crewmesh/api
npm run db:migrate:down
```

### Step 5 — Start API and Web Servers

In Terminal 1 (Fastify API on `http://localhost:3001`):

```bash
npm run dev:api
```

In Terminal 2 (Vite React Web App on `http://localhost:5173`, proxying `/api`, `/health`, `/ready` to `http://localhost:3001`):

```bash
npm run dev:web
```

### Step 6 — Verify Health, Lint, Type-Check, Build, and Tests

```bash
# Check /health and /ready against running API
npm run healthcheck

# Run ESLint, TypeScript type-check, and workspace builds
npm run lint
npm run typecheck
npm run build

# Run PostgreSQL integration test suite (requires running PostgreSQL with crewmesh_test DB)
npm test
```
