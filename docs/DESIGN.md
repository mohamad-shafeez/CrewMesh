# CrewMesh Design Doc (PS1: Race-proof team formation)

**Author:** Mohamad Shafeez · **Live:** https://crewmesh.onrender.com · **Code:** https://github.com/mohamad-shafeez/CrewMesh

## 1. Goal

Teams of 2 to 5 people for a 10,000-person hackathon. Correctness comes first: when hundreds of people act at the same second, the last seat goes to exactly one person, nobody ends up on two teams, and a retried request never repeats itself.

## 2. Data model

- `users`, `hackathons`, `hackathon_participants` (who is registered for which event)
- `teams` (name, desired skills, `member_count`, status `forming` or `ready`)
- `team_members` (one row per person, role `leader` or `member`)
- `join_requests` (source `board` or `invite_code`; status pending, accepted, declined, cancelled, expired)
- `invite_codes` (SHA-256 hash only, expiry, max uses)
- `sessions`, `idempotency_keys`, `rate_limit_buckets`
- `audit_log` (who, what, when, in the same transaction as the change) and `outbox_events` (live events)

## 3. How races are prevented

The database is the referee; the application never relies on "read the count, then write".

1. **Row lock.** Each change locks the team row with `SELECT ... FOR UPDATE`, so competing requests for the same seat run one at a time.
2. **Constraints.** `UNIQUE (hackathon_id, user_id)` on `team_members` allows one team per person. A unique index allows one leader per team. A `CHECK` keeps `member_count` within the team's bounds.
3. **Deferred triggers.** At COMMIT, constraint triggers re-verify that `member_count` equals the real member count, there is exactly one leader, and the team is within bounds. A bug in application code cannot commit a bad state.
4. **Fixed lock order** (idempotency key, team, participant, request or member rows, outbox) so transactions cannot deadlock.
5. **Cross-team accepts.** Accepting a request also locks the applicant's participant row, so two leaders cannot take the same person at once.

**Proof:** the CI test fires 50 simultaneous accepts for one remaining seat and asserts 1 success and 49 `TEAM_FULL` results; another fires 20 invite redemptions against `maxUses = 3` and asserts exactly 3.

## 4. Idempotency

Mutating requests carry an `Idempotency-Key`. The key and a SHA-256 fingerprint of the canonical payload are stored for 24 hours. A retry replays the stored result; the same key with a different payload returns `409 IDEMPOTENCY_KEY_REUSED`.

## 5. Real-time

Events are written to `outbox_events` in the same transaction as the change, so a rolled-back change never emits an event. An advisory lock assigns event ids in commit order. After commit, `NOTIFY` wakes a dispatcher that streams Server-Sent Events. Reconnecting clients send `Last-Event-ID` and get missed events replayed, in order.

## 6. Security

Argon2id passwords (64 MiB, 3 passes, parallelism 4); opaque session tokens stored as SHA-256; HMAC CSRF tokens with strict `Origin` checks; leader-only actions enforced on the server; 256-bit hashed invite codes that expire; per-IP and per-user rate limits in PostgreSQL; every input validated with Zod.

## 7. Teammate suggestions

Score = 70% skill coverage (missing team skills the candidate fills) + 30% time-zone compatibility (UTC offset difference from validated IANA zones). The API returns the breakdown and readable reasons, so the ranking is explainable and deterministic.

## 8. Performance

Board reads use keyset pagination with covering indexes. A seed script creates 10,000 participants and 2,000 teams, with every count asserted in SQL. CI runs k6 with 100 concurrent users for 60 seconds and enforces p95 under 200 ms; Run #19 (uncached) passed at **p95 `160.21 ms` / `163.09 ms`** (`700.96 req/s`, `0.0000%` errors), and Run #21 (with a 2-second mutation-invalidated board page cache and in-flight request coalescing in `team-service.ts`) passed at **p95 `103.68 ms`** (`p50 `33.62 ms``, `1,845.71 req/s`, `129,265` requests, `0.0000%` errors, `100.00%` checks).

## 9. Trade-offs

- **One PostgreSQL as the source of truth** over a queue or distributed lock: simpler and provably correct, but the database is the scaling limit (fine for 10,000 participants).
- **Leader approval on every join** over auto-join: safer for team quality, one extra step for users.
- **PostgreSQL rate limiter** over Redis: no extra service, shared across instances, a little more load on the database.
- **SSE over WebSockets:** one-way updates are all that is needed, and it works through proxies without extra setup.
- **Free-tier hosting:** the live demo has cold starts.

## 10. With one more week

1. A chaos test that kills the server mid-join and proves nothing is corrupted.
2. Optimistic UI with rollback on conflict.
3. Metrics and tracing (request latency, lock wait time).
4. A k6 scenario for the write path: join and accept under sustained load.
5. A Docker Compose file that starts the full stack with one command.
