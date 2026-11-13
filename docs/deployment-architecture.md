# CrewMesh — Pre-Deployment Validation & Free Same-Origin Production Architecture

## 1. Same-Origin Production Architecture (`SERVE_WEB_DIST=true` / `NODE_ENV=production`)

CrewMesh is architected to run in production as a **single unified same-origin web service** where the Fastify backend (`apps/api/dist/server.js`) serves both the `/api/v1/*` REST + SSE endpoints and the compiled Vite SPA (`apps/web/dist`):

1. **Single Public HTTPS Origin (`APP_ORIGIN=https://<your-domain>`)**:
   - Eliminates cross-site cookie restrictions: the opaque session cookie (`crewmesh_session`) uses `HttpOnly; SameSite=Lax; Path=/; Secure`, which browsers send on same-origin `fetch(..., { credentials: 'include' })` and native `EventSource('/api/v1/teams/:teamId/events')` connections without requiring fragile third-party cookie exemptions (`SameSite=None`).
   - Enforces strict CSRF `Origin` verification (`apps/api/src/security/csrf.ts`): in `NODE_ENV=production`, `isAllowedOrigin` accepts **only** exact matches against `APP_ORIGIN` and rejects forged `Host` headers.
   - Serves hashed Vite static assets (`/assets/*`) with `Cache-Control: public, max-age=31536000, immutable` and routes all non-`/api/*` `GET`/`HEAD` requests to `apps/web/dist/index.html` with `Cache-Control: no-cache` for client-side SPA routing (`/`, `/login`, `/register`, `/profile`, `/board`, `/teams/new`, `/teams/:teamId`).

## 2. Backend Production Checklist

| Requirement | Implementation Location | Production Behavior |
| :--- | :--- | :--- |
| **Production `NODE_ENV`** | `apps/api/src/config/env.ts` | Validates `NODE_ENV=production`; rejects placeholder `CSRF_SECRET` values and rejects `crewmesh_local_dev_password` in `DATABASE_URL`. |
| **Port & Host Binding** | `apps/api/src/server.ts`, `env.ts` | Binds to `HOST=0.0.0.0` and dynamic `PORT` injected by container/PaaS platforms (default `3001`). |
| **Secure Session Cookies** | `apps/api/src/plugins/auth-session.ts`, `routes/auth.ts` | Sets `HttpOnly; SameSite=Lax; Path=/; Secure` automatically whenever `NODE_ENV === 'production'`. |
| **Strict CSRF & Origin Guard** | `apps/api/src/security/csrf.ts` | Requires matching `Origin`/`Referer` (`APP_ORIGIN`) and constant-time HMAC-SHA256 `X-CSRF-Token` verification on all state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`). |
| **PostgreSQL TLS / SSL** | `apps/api/src/db/pool.ts`, `sse-dispatcher.ts` | `resolvePgSslOptions(env.DATABASE_SSL, connectionString)` configures TLS on both the main `pg.Pool` and the dedicated `LISTEN/NOTIFY` `pg.Client` (`disable`, `require`, or `verify-full`). |
| **Database Connection Pool** | `apps/api/src/db/pool.ts` | Configurable `DB_POOL_MAX` (`2..200`, default `25`), `idleTimeoutMillis: 30_000`, `connectionTimeoutMillis: 5_000`. |
| **Migration & Seed Strategy** | `apps/api/src/db/migrate.ts`, `seed.ts` | Advisory-locked (`pg_advisory_lock(842026001)`) transactional migrations `001`–`007` (`npm run db:migrate`) followed by idempotent hackathon seeding (`npm run db:seed`). |
| **Health & Readiness Probes** | `apps/api/src/routes/health.ts` | `GET /health` & `GET /healthz` return HTTP `200` liveness; `GET /ready` executes `SELECT NOW()` against PostgreSQL and returns HTTP `200` when ready or HTTP `503` when unreachable. |
| **Graceful Shutdown** | `apps/api/src/server.ts`, `routes/events.ts` | Traps `SIGINT` and `SIGTERM`, closes all active SSE streams and the `LISTEN/NOTIFY` client via `app.close()`, drains the PostgreSQL pool via `closeDbPool()`, and exits cleanly. |
| **SSE Reverse-Proxy Headers** | `apps/api/src/routes/events.ts` | Sends `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, and `X-Accel-Buffering: no`, with 15-second `: heartbeat` comments to prevent idle proxy timeouts. |

## 3. Frontend Production Checklist

- **Zero Hardcoded Localhost URLs**: All API calls in `apps/web/src/api/*.ts` and SSE hooks (`useBoardEvents.ts`, `useTeamEvents.ts`) use relative paths (`/api/v1/...`), working identically behind Vite's dev/preview proxy in development and Fastify's same-origin handler in production.
- **No Hardcoded Test Credentials or Secrets**: Verified zero embedded secrets, API keys, or hardcoded test accounts in `apps/web/src`.
- **Idempotency & Error Recovery**: Client-side logical action idempotency manager (`getOrCreateIdempotencyKey`) preserves the same `Idempotency-Key` across network retries of identical payloads and rotates keys when form inputs change.

## 4. Recommended Zero-Cost Deployment Target (For Final Deployment Stage)

When deployment is authorized (outside Batch 09):
- **Database**: Free managed PostgreSQL 16 instance (e.g., Neon Free Tier or Render Free PostgreSQL) with `DATABASE_SSL=require`.
- **Application Runtime**: Single free Web Service (e.g., Render Free Web Service or Koyeb Free Web Service) running:
  - **Build Command**: `npm ci && npm run build`
  - **Pre-Deploy / Start Command**: `npm run db:migrate && npm run db:seed && NODE_ENV=production SERVE_WEB_DIST=true npm run start --workspace=@crewmesh/api`
