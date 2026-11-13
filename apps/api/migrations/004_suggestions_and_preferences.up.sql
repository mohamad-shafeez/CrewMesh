-- ============================================================================
-- CrewMesh — Migration 004: Teammate Suggestions Rate-Limit Scope & Indexes
-- ============================================================================
-- 1. Expands rate_limit_buckets_scope_chk to allow 'suggestions_user' so
--    GET /api/v1/teams/:teamId/suggestions is rate-limited in PostgreSQL.
-- 2. Adds composite anti-join indexes on team_members and join_requests to
--    support fast candidate eligibility filtering at 10,000-user scale.
-- ============================================================================

ALTER TABLE rate_limit_buckets
  DROP CONSTRAINT IF EXISTS rate_limit_buckets_scope_chk;

ALTER TABLE rate_limit_buckets
  ADD CONSTRAINT rate_limit_buckets_scope_chk
  CHECK (scope IN ('auth_ip', 'auth_email', 'invite_ip', 'invite_user', 'suggestions_user'));

CREATE INDEX IF NOT EXISTS idx_team_members_hackathon_user_lookup
  ON team_members (hackathon_id, user_id);

CREATE INDEX IF NOT EXISTS idx_join_requests_team_pending_user_lookup
  ON join_requests (team_id, user_id)
  WHERE status = 'pending';
