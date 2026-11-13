-- ============================================================================
-- CrewMesh — Migration 002: Team Engine Integrity Triggers, Idempotency & Indexes
-- ============================================================================
-- 1. Extends idempotency_keys with completed_at and locked_at timestamps.
-- 2. Extends audit_log with request_id for end-to-end request correlation.
-- 3. Adds DEFERRABLE INITIALLY DEFERRED PostgreSQL constraint triggers on
--    `teams` and `team_members` that enforce at transaction commit / check time:
--    - teams.member_count strictly equals COUNT(*) FROM team_members
--    - Every existing team has EXACTLY ONE leader in team_members
--    - teams.leader_user_id matches the single leader in team_members
--    - teams.status ('forming' vs 'ready') matches member_count vs min_team_size
-- 4. Adds keyset pagination indexes for board and leader join-request inbox queries.
-- ============================================================================

ALTER TABLE idempotency_keys
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS request_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_teams_hackathon_created_id
  ON teams (hackathon_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_join_requests_team_created_id
  ON join_requests (team_id, created_at ASC, id ASC);

-- ----------------------------------------------------------------------------
-- Database-level membership & single-leader consistency verification function
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION verify_team_membership_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_team_id UUID;
  v_team RECORD;
  v_actual_count INTEGER;
  v_leader_count INTEGER;
  v_actual_leader_id UUID;
  v_expected_status TEXT;
BEGIN
  IF TG_TABLE_NAME = 'teams' THEN
    v_team_id := COALESCE(NEW.id, OLD.id);
  ELSE
    v_team_id := COALESCE(NEW.team_id, OLD.team_id);
  END IF;

  SELECT id, hackathon_id, leader_user_id, status, member_count, min_team_size, max_team_size
  INTO v_team
  FROM teams
  WHERE id = v_team_id;

  -- If the team row was deleted (e.g. last member left), ensure no orphan team_members exist
  IF NOT FOUND THEN
    SELECT COUNT(*)::int INTO v_actual_count
    FROM team_members
    WHERE team_id = v_team_id;

    IF v_actual_count > 0 THEN
      RAISE EXCEPTION 'Orphan team_members rows (%) remain for deleted team %', v_actual_count, v_team_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;

  SELECT
    COUNT(*)::int,
    COUNT(*) FILTER (WHERE role = 'leader')::int,
    MAX(user_id::text) FILTER (WHERE role = 'leader')::uuid
  INTO
    v_actual_count,
    v_leader_count,
    v_actual_leader_id
  FROM team_members
  WHERE team_id = v_team_id;

  IF v_actual_count < 1 OR v_actual_count > v_team.max_team_size THEN
    RAISE EXCEPTION 'Team % actual member count (%) violates bounds [1, %]',
      v_team_id, v_actual_count, v_team.max_team_size
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_team.member_count <> v_actual_count THEN
    RAISE EXCEPTION 'Team % stored member_count (%) disagrees with actual team_members count (%)',
      v_team_id, v_team.member_count, v_actual_count
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_leader_count <> 1 THEN
    RAISE EXCEPTION 'Team % must have exactly 1 leader in team_members, found %',
      v_team_id, v_leader_count
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_actual_leader_id IS DISTINCT FROM v_team.leader_user_id THEN
    RAISE EXCEPTION 'Team % leader_user_id (%) does not match team_members leader (%)',
      v_team_id, v_team.leader_user_id, v_actual_leader_id
      USING ERRCODE = 'check_violation';
  END IF;

  v_expected_status := CASE
    WHEN v_actual_count >= v_team.min_team_size THEN 'ready'
    ELSE 'forming'
  END;

  IF v_team.status <> v_expected_status THEN
    RAISE EXCEPTION 'Team % status (%) disagrees with expected status (%) for count % / min %',
      v_team_id, v_team.status, v_expected_status, v_actual_count, v_team.min_team_size
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_teams_verify_integrity ON teams;
CREATE CONSTRAINT TRIGGER trg_teams_verify_integrity
  AFTER INSERT OR UPDATE ON teams
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION verify_team_membership_integrity();

DROP TRIGGER IF EXISTS trg_team_members_verify_integrity ON team_members;
CREATE CONSTRAINT TRIGGER trg_team_members_verify_integrity
  AFTER INSERT OR UPDATE OR DELETE ON team_members
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION verify_team_membership_integrity();
