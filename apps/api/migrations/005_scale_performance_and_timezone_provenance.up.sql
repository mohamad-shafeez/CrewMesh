-- ============================================================================
-- CrewMesh — Migration 005: Time-Zone Provenance, Redundant Index Removal,
-- Hackathon Participant Eligibility & Board Scale Indexing
-- ============================================================================
-- 1. Time-Zone Provenance Correction:
--    - Adds `users.timezone_confirmed_at TIMESTAMPTZ NULL`.
--    - Drops `NOT NULL` and `DEFAULT 'UTC'` on `users.timezone` so accounts
--      created without an explicitly confirmed time zone store `NULL` rather
--      than masquerading as confirmed UTC participants.
--    - Clears legacy unconfirmed `'UTC'` defaults (`timezone = NULL`) while
--      preserving explicitly chosen non-UTC IANA zones with provenance timestamps.
--    - Adds `users_timezone_provenance_chk` enforcing that `timezone` and
--      `timezone_confirmed_at` are either both NULL or both NOT NULL.
-- 2. Redundant Index Removal (Audit of Migrations 001–004):
--    - Drops `idx_team_members_hackathon_user_lookup` (added in 004), which
--      duplicated the unique constraint index `team_members_one_team_per_hackathon_unique`
--      on `team_members (hackathon_id, user_id)`.
--    - Drops `idx_join_requests_team_pending_user_lookup` (added in 004), which
--      duplicated the partial unique index `idx_join_requests_one_pending_per_team_user`
--      on `join_requests (team_id, user_id) WHERE status = 'pending'`.
-- 3. Hackathon Participant Eligibility (`hackathon_participants`):
--    - Explicitly tracks which users are registered participants in a given
--      hackathon so unrelated platform accounts are never recommended.
-- 4. Board Open-Capacity Partial Index:
--    - Adds `idx_teams_hackathon_open_capacity_cursor` to accelerate board
--      queries filtering by `hasCapacity=true` (`member_count < max_team_size`).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Time-zone provenance on `users`
-- ----------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS timezone_confirmed_at TIMESTAMPTZ NULL;

ALTER TABLE users
  ALTER COLUMN timezone DROP DEFAULT,
  ALTER COLUMN timezone DROP NOT NULL;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_timezone_length_chk;

-- Legacy records with 'UTC' and no confirmation timestamp cannot be proven
-- to have been explicitly chosen by the participant; mark them unconfirmed (NULL).
UPDATE users
SET
  timezone = NULL,
  timezone_confirmed_at = NULL
WHERE timezone = 'UTC'
  AND timezone_confirmed_at IS NULL;

-- Existing records with an explicit non-UTC IANA time zone were explicitly set
-- by the participant; backfill their confirmation timestamp from updated_at/created_at.
UPDATE users
SET
  timezone_confirmed_at = COALESCE(updated_at, created_at, NOW())
WHERE timezone IS NOT NULL
  AND timezone <> 'UTC'
  AND timezone_confirmed_at IS NULL;

ALTER TABLE users
  ADD CONSTRAINT users_timezone_length_chk CHECK (
    timezone IS NULL OR length(btrim(timezone)) BETWEEN 2 AND 64
  );

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_timezone_provenance_chk;

ALTER TABLE users
  ADD CONSTRAINT users_timezone_provenance_chk CHECK (
    (timezone IS NULL AND timezone_confirmed_at IS NULL)
    OR (timezone IS NOT NULL AND timezone_confirmed_at IS NOT NULL)
  );

-- ----------------------------------------------------------------------------
-- 2. Drop redundant duplicate indexes introduced in Migration 004
--    (Unique indexes `team_members_one_team_per_hackathon_unique` and
--     `idx_join_requests_one_pending_per_team_user` remain intact)
-- ----------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_team_members_hackathon_user_lookup;
DROP INDEX IF EXISTS idx_join_requests_team_pending_user_lookup;

-- ----------------------------------------------------------------------------
-- 3. Explicit hackathon participant registration (`hackathon_participants`)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hackathon_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id UUID NOT NULL REFERENCES hackathons(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'registered',
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT hackathon_participants_hackathon_user_unique
    UNIQUE (hackathon_id, user_id),
  CONSTRAINT hackathon_participants_status_chk
    CHECK (status IN ('registered', 'withdrawn', 'disqualified'))
);

CREATE INDEX IF NOT EXISTS idx_hackathon_participants_hackathon_status_user
  ON hackathon_participants (hackathon_id, status, user_id);

CREATE INDEX IF NOT EXISTS idx_hackathon_participants_user_id
  ON hackathon_participants (user_id);

-- Backfill existing team members and join-request applicants into hackathon_participants
INSERT INTO hackathon_participants (hackathon_id, user_id, status, registered_at)
SELECT DISTINCT tm.hackathon_id, tm.user_id, 'registered', tm.joined_at
FROM team_members tm
ON CONFLICT (hackathon_id, user_id) DO NOTHING;

INSERT INTO hackathon_participants (hackathon_id, user_id, status, registered_at)
SELECT DISTINCT jr.hackathon_id, jr.user_id, 'registered', jr.created_at
FROM join_requests jr
ON CONFLICT (hackathon_id, user_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 4. Partial index for open-capacity board filtering (`hasCapacity = true`)
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_teams_hackathon_open_capacity_cursor
  ON teams (hackathon_id, created_at DESC, id DESC)
  WHERE member_count < max_team_size;

CREATE INDEX IF NOT EXISTS idx_teams_hackathon_created_id_cursor
  ON teams (hackathon_id, created_at DESC, id DESC);
