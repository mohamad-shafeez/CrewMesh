-- ============================================================================
-- CrewMesh — Migration 006 Down: Rollback Serialized Outbox Trigger & Participant FKs
-- ============================================================================

DROP TRIGGER IF EXISTS trg_outbox_events_serialize_id ON outbox_events;
DROP FUNCTION IF EXISTS allocate_serialized_outbox_id();

ALTER TABLE outbox_events
  ALTER COLUMN id SET DEFAULT nextval('outbox_events_id_seq');

ALTER TABLE join_requests
  DROP CONSTRAINT IF EXISTS join_requests_participant_fk;

ALTER TABLE team_members
  DROP CONSTRAINT IF EXISTS team_members_participant_fk;
