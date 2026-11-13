-- ============================================================================
-- CrewMesh — Migration 004 Down: Rollback Suggestion Scope & Indexes
-- ============================================================================

DROP INDEX IF EXISTS idx_join_requests_team_pending_user_lookup;
DROP INDEX IF EXISTS idx_team_members_hackathon_user_lookup;

DELETE FROM rate_limit_buckets WHERE scope = 'suggestions_user';

ALTER TABLE rate_limit_buckets
  DROP CONSTRAINT IF EXISTS rate_limit_buckets_scope_chk;

ALTER TABLE rate_limit_buckets
  ADD CONSTRAINT rate_limit_buckets_scope_chk
  CHECK (scope IN ('auth_ip', 'auth_email', 'invite_ip', 'invite_user'));
