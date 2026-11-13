-- ============================================================================
-- CrewMesh — Migration 003 Down: Rollback Outbox Trigger & Nullable Deadline
-- ============================================================================

DROP TRIGGER IF EXISTS trg_outbox_events_notify ON outbox_events;
DROP FUNCTION IF EXISTS notify_outbox_event();

UPDATE hackathons
SET registration_deadline = COALESCE(registration_deadline, NOW() + INTERVAL '365 days')
WHERE registration_deadline IS NULL;

ALTER TABLE hackathons
  ALTER COLUMN registration_deadline SET NOT NULL;
