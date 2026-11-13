# CrewMesh — Transaction Lock-Order & Concurrency Architecture (Batch 07 Audit)

## 1. Global Lock Acquisition Hierarchy
Every state-changing membership, join-request, invitation, and preference mutation executes inside a single PostgreSQL `READ COMMITTED` transaction (`BEGIN ... COMMIT / ROLLBACK`) managed by `executeIdempotentMutation` (`apps/api/src/services/idempotency-service.ts`).

To prevent deadlocks across concurrent operations targeting overlapping entities, all transactions acquire row-level and advisory locks in the following strict hierarchy:

1. **Layer 1 — Idempotency Scope Lock (`idempotency_keys`)**:
   - `INSERT INTO idempotency_keys (actor_user_id, operation, idempotency_key, ...) ON CONFLICT (actor_user_id, operation, idempotency_key) DO UPDATE SET locked_at = idempotency_keys.locked_at`
   - Serializes concurrent retries of the exact same `(actor_user_id, operation, idempotency_key)` before any domain table is locked.
2. **Layer 2 — Target Team Row Lock (`teams`)**:
   - `SELECT ... FROM teams WHERE id = $1 FOR UPDATE` (`lockTeamByIdOrThrow`)
   - Acquired **first** in every team-scoped mutation (`createJoinRequestTx`, `acceptJoinRequestTx`, `declineJoinRequestTx`, `createInviteCodeTx`, `revokeInviteCodeTx`, `redeemInviteCodeTx`, `removeMemberTx`, `leaveTeamTx`, `updateTeamPreferencesTx`).
   - Even in `redeemInviteCodeTx` (where only the raw invite code is supplied by the caller), `invite_codes` is first read without a lock to resolve `team_id`, then `teams` is locked `FOR UPDATE` **before** `invite_codes` is locked `FOR UPDATE`.
3. **Layer 3 — Hackathon Participant Eligibility Lock (`hackathon_participants`)**:
   - `SELECT status FROM hackathon_participants WHERE hackathon_id = $1 AND user_id = $2 FOR KEY SHARE` (`requireActiveHackathonParticipantTx`)
   - Prevents concurrent withdrawal/disqualification or deletion of the participant's event registration while a seat or join request is being created.
4. **Layer 4 — Secondary Child Entity Locks (`join_requests` / `invite_codes` / `team_members`)**:
   - `acceptJoinRequestTx` & `declineJoinRequestTx`: `SELECT ... FROM join_requests WHERE id = $1 FOR UPDATE`
   - `redeemInviteCodeTx` & `revokeInviteCodeTx`: `SELECT ... FROM invite_codes WHERE id = $1 FOR UPDATE`
   - `removeMemberTx` & `leaveTeamTx`: `SELECT ... FROM team_members WHERE team_id = $1 ... ORDER BY joined_at ASC, user_id ASC FOR UPDATE`
5. **Layer 5 — Outbox Commit-Order Serialization Lock (`pg_advisory_xact_lock(842026002)`)**:
   - Acquired at the **very end** of the transaction inside the `BEFORE INSERT` trigger `trg_outbox_events_serialize_id` on `outbox_events` immediately prior to `SET CONSTRAINTS ALL IMMEDIATE` and `COMMIT`.
   - Because every mutation writes its outbox event as its final SQL statement before committing, no domain row lock (`teams`, `join_requests`, `invite_codes`, `team_members`) is ever requested *after* acquiring `pg_advisory_xact_lock(842026002)`, eliminating lock-order inversions between domain locks and the outbox sequence lock.

---

## 2. Operation-by-Operation Lock Trace

| Operation | Route | Lock Sequence inside Transaction | Final Database Integrity Guards |
|---|---|---|---|
| **Create Team** | `POST /api/v1/hackathons/:hackathonId/teams` | `idempotency_keys (DO UPDATE)` → `hackathon_participants (FOR KEY SHARE)` → `INSERT teams` → `INSERT team_members` → `pg_advisory_xact_lock(842026002)` | `teams_hackathon_name_unique`, `team_members_one_team_per_hackathon_unique`, `trg_teams_verify_integrity` |
| **Create Join Request** | `POST /api/v1/teams/:teamId/join-requests` | `idempotency_keys` → `teams (FOR UPDATE)` → `hackathon_participants (FOR KEY SHARE)` → `INSERT join_requests` → `pg_advisory_xact_lock(842026002)` | `idx_join_requests_one_pending_per_team_user`, `join_requests_participant_fk` |
| **Redeem Invite Code** | `POST /api/v1/invites/redeem` | `idempotency_keys` → `teams (FOR UPDATE)` → `hackathon_participants (FOR KEY SHARE)` → `invite_codes (FOR UPDATE)` → `INSERT join_requests` → `UPDATE invite_codes` → `pg_advisory_xact_lock(842026002)` | `invite_codes_uses_chk`, `idx_join_requests_one_pending_per_team_user` |
| **Accept Join Request** | `POST /api/v1/join-requests/:requestId/accept` | `idempotency_keys` → `teams (FOR UPDATE)` → `join_requests (FOR UPDATE)` → `hackathon_participants (FOR KEY SHARE)` → `INSERT team_members` → `UPDATE teams` → `UPDATE join_requests` → `pg_advisory_xact_lock(842026002)` | `team_members_one_team_per_hackathon_unique`, `teams_member_count_bounds_chk`, `trg_team_members_verify_integrity` |
| **Decline Join Request** | `POST /api/v1/join-requests/:requestId/decline` | `idempotency_keys` → `teams (FOR UPDATE)` → `join_requests (FOR UPDATE)` → `pg_advisory_xact_lock(842026002)` | `join_requests_status_chk` |
| **Remove Member** | `DELETE /api/v1/teams/:teamId/members/:memberUserId` | `idempotency_keys` → `teams (FOR UPDATE)` → `team_members (FOR UPDATE)` → `DELETE team_members` → `UPDATE teams` → `pg_advisory_xact_lock(842026002)` | `trg_teams_verify_integrity`, `trg_team_members_verify_integrity` |
| **Leave Team / Succession / Delete** | `POST /api/v1/teams/:teamId/leave` | `idempotency_keys` → `teams (FOR UPDATE)` → `team_members (ORDER BY joined_at ASC, user_id ASC FOR UPDATE)` → `DELETE/UPDATE` → `pg_advisory_xact_lock(842026002)` | `idx_team_members_one_leader_per_team`, `trg_teams_verify_integrity` |
| **Update Team Preferences** | `PATCH /api/v1/teams/:teamId/preferences` | `idempotency_keys` → `teams (FOR UPDATE)` → `UPDATE teams` → `pg_advisory_xact_lock(842026002)` | `teams_desired_skills_max_chk` |

---

## 3. Cross-Team Same-Participant Concurrency Protection
When the same participant `U` has pending join requests on **Team A** and **Team B** in the same hackathon and both team leaders click **Accept** simultaneously:
1. Transaction 1 locks `Team A` (`FOR UPDATE`) and Transaction 2 locks `Team B` (`FOR UPDATE`).
2. Both transactions execute `INSERT INTO team_members (team_id, hackathon_id, user_id, role) VALUES (..., U, 'member')`.
3. PostgreSQL's unique B-tree index `team_members_one_team_per_hackathon_unique ON team_members (hackathon_id, user_id)` serializes the two index insertions:
   - The first transaction to insert `(hackathon_id, U)` acquires the unique index tuple lock, updates its team's `member_count`, cancels the user's other pending join requests in the same hackathon, and commits (`200 OK`).
   - The second transaction blocks on the uncommitted unique index tuple until the first transaction commits, then immediately receives PostgreSQL error `23505 (unique_violation)` on `team_members_one_team_per_hackathon_unique`, which `addMemberToLockedTeamTx` catches and translates into `409 ALREADY_IN_TEAM`, rolling back the second transaction cleanly with zero counter drift and zero orphan outbox events.
