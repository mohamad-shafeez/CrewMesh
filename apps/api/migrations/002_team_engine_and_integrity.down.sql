-- ============================================================================
-- CrewMesh — Migration 002 Down: Rollback Integrity Triggers & Batch 2 Columns
-- ============================================================================

DROP TRIGGER IF EXISTS trg_team_members_verify_integrity ON team_members;
DROP TRIGGER IF EXISTS trg_teams_verify_integrity ON teams;
DROP FUNCTION IF EXISTS verify_team_membership_integrity();

DROP INDEX IF EXISTS idx_join_requests_team_created_id;
DROP INDEX IF EXISTS idx_teams_hackathon_created_id;

ALTER TABLE audit_log
  DROP COLUMN IF EXISTS request_id;

ALTER TABLE idempotency_keys
  DROP COLUMN IF EXISTS locked_at,
  DROP COLUMN IF EXISTS completed_at;
