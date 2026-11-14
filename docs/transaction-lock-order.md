# CrewMesh — Transaction Lock-Order & Concurrency Architecture

## 1. Global Lock Acquisition Hierarchy
Every state-changing membership, join-request, invitation, and preference mutation executes inside a single PostgreSQL `READ COMMITTED` transaction (`BEGIN ... COMMIT / ROLLBACK`) managed by `executeIdempotentMutation` (`apps/api/src/services/idempotency-service.ts`).

To prevent deadlocks across concurrent operations targeting overlapping entities (including cross-team concurrent acceptances of the same participant), all transactions acquire row-level and advisory locks in the following strict hierarchy:

1. **Layer 1 — Idempotency Scope Lock (`idempotency_keys`)**:
   - `INSERT INTO idempotency_keys (actor_user_id, operation, idempotency_key, ...) ON CONFLICT (actor_user_id, operation, idempotency_key) DO UPDATE SET locked_at = idempotency_keys.locked_at`
   - Serializes concurrent retries of the exact same `(actor_user_id, operation, idempotency_key)` before any domain table is locked.
2. **Layer 2 — Target Team Row Lock (`teams`)**:
   - `SELECT ... FROM teams WHERE id = $1 FOR UPDATE` (`lockTeamByIdOrThrow`)
   - Acquired **first** in every team-scoped mutation (`createJoinRequestTx`, `acceptJoinRequestTx`, `declineJoinRequestTx`, `createInviteCodeTx`, `revokeInviteCodeTx`, `redeemInviteCodeTx`, `removeMemberTx`, `leaveTeamTx`, `updateTeamPreferencesTx`).
3. **Layer 3 — Hackathon Participant Eligibility & Serialization Lock (`hackathon_participants`)**:
   - `SELECT status FROM hackathon_participants WHERE hackathon_id = $1 AND user_id = $2 FOR SHARE` (`requireActiveHackathonParticipantTx`) for team creation, join request creation, and invite redemption.
   - `SELECT status FROM hackathon_participants WHERE hackathon_id = $1 AND user_id = $2 FOR UPDATE` (`lockActiveHackathonParticipantForUpdateTx`) in `acceptJoinRequestTx`, acquired **before** locking `join_requests` so two leaders accepting the same applicant into different teams serialize on the applicant's `hackathon_participants` row before either holds a lock on a `join_requests` row.
   - Both `FOR SHARE` and `FOR UPDATE` conflict with concurrent `UPDATE hackathon_participants SET status = 'withdrawn' | 'disqualified'` statements.
4. **Layer 4 — Secondary Child Entity Locks (`join_requests` / `invite_codes` / `team_members`)**:
   - `acceptJoinRequestTx` & `declineJoinRequestTx`: `SELECT ... FROM join_requests WHERE id = $1 FOR UPDATE`
   - `redeemInviteCodeTx` & `revokeInviteCodeTx`: `SELECT ... FROM invite_codes WHERE id = $1 FOR UPDATE`
   - `removeMemberTx` & `leaveTeamTx`: `SELECT ... FROM team_members WHERE team_id = $1 ... ORDER BY joined_at ASC, user_id ASC FOR UPDATE`
5. **Layer 5 — Outbox Commit-Order Serialization Lock (`pg_advisory_xact_lock(842026002)`)**:
   - Acquired at the **very end** of the transaction inside the `BEFORE INSERT` trigger `trg_outbox_events_serialize_id` on `outbox_events` immediately prior to `SET CONSTRAINTS ALL IMMEDIATE` and `COMMIT`.
   - Rejects any caller-supplied `NEW.id IS NOT NULL` (Migration `007`) so sequence allocation order strictly equals transaction commit order.

---

## 2. Operation-by-Operation Lock Trace

| Operation | Route | Lock Sequence inside Transaction | Final Database Integrity Guards |
|---|---|---|---|
| **Create Team** | `POST /api/v1/hackathons/:hackathonId/teams` | `idempotency_keys (DO UPDATE)` → `hackathon_participants (FOR SHARE)` → `INSERT teams` → `INSERT team_members` → `pg_advisory_xact_lock(842026002)` | `teams_hackathon_name_unique`, `team_members_one_team_per_hackathon_unique`, `trg_teams_verify_integrity` |
| **Create Join Request** | `POST /api/v1/teams/:teamId/join-requests` | `idempotency_keys` → `teams (FOR UPDATE)` → `hackathon_participants (FOR SHARE)` → `INSERT join_requests` → `pg_advisory_xact_lock(842026002)` | `idx_join_requests_one_pending_per_team_user`, `join_requests_participant_fk` |
| **Redeem Invite Code** | `POST /api/v1/invites/redeem` | `idempotency_keys` → `teams (FOR UPDATE)` → `hackathon_participants (FOR SHARE)` → `invite_codes (FOR UPDATE)` → `INSERT join_requests` → `UPDATE invite_codes` → `pg_advisory_xact_lock(842026002)` | `invite_codes_uses_chk`, `idx_join_requests_one_pending_per_team_user` |
| **Accept Join Request** | `POST /api/v1/teams/:teamId/join-requests/:requestId/accept` | `idempotency_keys` → `teams (FOR UPDATE)` → `hackathon_participants (FOR UPDATE)` → `join_requests (FOR UPDATE)` → `INSERT team_members` → `UPDATE teams` → `UPDATE join_requests` → `pg_advisory_xact_lock(842026002)` | `team_members_one_team_per_hackathon_unique`, `teams_member_count_bounds_chk`, `trg_team_members_verify_integrity` |
| **Decline Join Request** | `POST /api/v1/teams/:teamId/join-requests/:requestId/decline` | `idempotency_keys` → `teams (FOR UPDATE)` → `join_requests (FOR UPDATE)` → `pg_advisory_xact_lock(842026002)` | `join_requests_status_chk` |
| **Remove Member** | `DELETE /api/v1/teams/:teamId/members/:memberUserId` | `idempotency_keys` → `teams (FOR UPDATE)` → `team_members (FOR UPDATE)` → `DELETE team_members` → `UPDATE teams` → `pg_advisory_xact_lock(842026002)` | `trg_teams_verify_integrity`, `trg_team_members_verify_integrity` |
| **Leave Team / Succession / Delete** | `POST /api/v1/teams/:teamId/leave` | `idempotency_keys` → `teams (FOR UPDATE)` → `team_members (ORDER BY joined_at ASC, user_id ASC FOR UPDATE)` → `DELETE/UPDATE` → `pg_advisory_xact_lock(842026002)` | `idx_team_members_one_leader_per_team`, `trg_teams_verify_integrity` |
| **Update Team Preferences** | `PATCH /api/v1/teams/:teamId/preferences` | `idempotency_keys` → `teams (FOR UPDATE)` → `UPDATE teams` → `pg_advisory_xact_lock(842026002)` | `teams_desired_skills_max_chk` |
