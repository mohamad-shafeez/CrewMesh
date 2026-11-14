-- ============================================================================
-- CrewMesh — Migration 005 Down: Rollback Scale & Time-Zone Provenance Changes
-- ============================================================================

DROP INDEX IF EXISTS idx_teams_hackathon_created_id_cursor;
DROP INDEX IF EXISTS idx_teams_hackathon_open_capacity_cursor;

DROP TABLE IF EXISTS hackathon_participants;

CREATE INDEX IF NOT EXISTS idx_join_requests_team_pending_user_lookup
  ON join_requests (team_id, user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_team_members_hackathon_user_lookup
  ON team_members (hackathon_id, user_id);

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_timezone_provenance_chk;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_timezone_length_chk;

UPDATE users
SET timezone = 'UTC'
WHERE timezone IS NULL;

ALTER TABLE users
  ALTER COLUMN timezone SET DEFAULT 'UTC',
  ALTER COLUMN timezone SET NOT NULL;

ALTER TABLE users
  ADD CONSTRAINT users_timezone_length_chk CHECK (
    length(btrim(timezone)) BETWEEN 2 AND 64
  );

ALTER TABLE users
  DROP COLUMN IF EXISTS timezone_confirmed_at;
