-- ============================================================================
-- CrewMesh — Migration 006: Serialized Outbox Commit-Order Guarantee &
-- Database-Enforced Hackathon Participant Foreign Keys
-- ============================================================================
-- 1. Fixes DEFECT-01 (P0): Durable Outbox Sequence vs. Commit-Order Inversion.
--    - Drops the pre-trigger column DEFAULT on `outbox_events.id` so `nextval()`
--      is never evaluated before acquiring the outbox serialization lock.
--    - Adds `BEFORE INSERT` trigger `trg_outbox_events_serialize_id` which
--      acquires `pg_advisory_xact_lock(842026002)` FIRST and only then assigns
--      `NEW.id := nextval('outbox_events_id_seq')`.
--    - Guarantees that committed `outbox_events.id` values strictly match
--      transaction commit visibility order so `WHERE id > lastSeenId` never
--      skips an earlier-allocated, later-committed outbox event.
-- 2. Fixes DEFECT-03 (P0): Database-Level Participant Eligibility Foreign Keys.
--    - Backfills any missing `hackathon_participants` records for existing
--      `team_members` and `join_requests` rows.
--    - Adds composite foreign keys `team_members_participant_fk` and
--      `join_requests_participant_fk` referencing
--      `hackathon_participants (hackathon_id, user_id) ON DELETE RESTRICT`.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Backfill and enforce composite foreign keys to `hackathon_participants`
-- ----------------------------------------------------------------------------
INSERT INTO hackathon_participants (hackathon_id, user_id, status, registered_at)
SELECT DISTINCT tm.hackathon_id, tm.user_id, 'registered', tm.joined_at
FROM team_members tm
ON CONFLICT (hackathon_id, user_id) DO NOTHING;

INSERT INTO hackathon_participants (hackathon_id, user_id, status, registered_at)
SELECT DISTINCT jr.hackathon_id, jr.user_id, 'registered', jr.created_at
FROM join_requests jr
ON CONFLICT (hackathon_id, user_id) DO NOTHING;

ALTER TABLE team_members
  DROP CONSTRAINT IF EXISTS team_members_participant_fk;

ALTER TABLE team_members
  ADD CONSTRAINT team_members_participant_fk
  FOREIGN KEY (hackathon_id, user_id)
  REFERENCES hackathon_participants(hackathon_id, user_id)
  ON DELETE RESTRICT;

ALTER TABLE join_requests
  DROP CONSTRAINT IF EXISTS join_requests_participant_fk;

ALTER TABLE join_requests
  ADD CONSTRAINT join_requests_participant_fk
  FOREIGN KEY (hackathon_id, user_id)
  REFERENCES hackathon_participants(hackathon_id, user_id)
  ON DELETE RESTRICT;

-- ----------------------------------------------------------------------------
-- 2. Serialized outbox ID allocation in commit order
-- ----------------------------------------------------------------------------
ALTER TABLE outbox_events
  ALTER COLUMN id DROP DEFAULT;

CREATE OR REPLACE FUNCTION allocate_serialized_outbox_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Acquire transaction-level advisory lock BEFORE calling nextval() so no
  -- concurrent transaction can allocate a higher sequence number and commit
  -- ahead of an uncommitted lower sequence number.
  PERFORM pg_advisory_xact_lock(842026002);

  IF NEW.id IS NULL THEN
    NEW.id := nextval('outbox_events_id_seq');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_outbox_events_serialize_id ON outbox_events;
CREATE TRIGGER trg_outbox_events_serialize_id
  BEFORE INSERT ON outbox_events
  FOR EACH ROW
  EXECUTE FUNCTION allocate_serialized_outbox_id();
