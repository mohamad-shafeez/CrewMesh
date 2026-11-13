-- ============================================================================
-- CrewMesh — Migration 003: Nullable Hackathon Registration Deadline &
-- Durable Outbox LISTEN/NOTIFY Wake-Up Trigger
-- ============================================================================
-- 1. Allows hackathons.registration_deadline to be NULL when no explicit
--    event registration cutoff has been supplied (removing invented deadlines).
-- 2. Clears any previously seeded fallback deadline on hack4hack-crew-2026.
-- 3. Adds notify_outbox_event() trigger on outbox_events so committed outbox
--    rows emit a lightweight pg_notify('crewmesh_outbox', ...) wake-up signal
--    containing only identifiers (id, hackathonId, teamId, scope), never secrets.
-- ============================================================================

ALTER TABLE hackathons
  ALTER COLUMN registration_deadline DROP NOT NULL;

UPDATE hackathons
SET
  registration_deadline = NULL,
  updated_at = NOW()
WHERE slug = 'hack4hack-crew-2026'
  AND registration_deadline IN (
    '2026-11-15T23:59:00+05:30'::timestamptz,
    '2027-12-31T23:59:59Z'::timestamptz
  );

CREATE OR REPLACE FUNCTION notify_outbox_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify(
    'crewmesh_outbox',
    json_build_object(
      'id', NEW.id::text,
      'hackathonId', NEW.hackathon_id::text,
      'teamId', CASE WHEN NEW.team_id IS NULL THEN NULL ELSE NEW.team_id::text END,
      'scope', NEW.scope,
      'eventType', NEW.event_type
    )::text
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_outbox_events_notify ON outbox_events;
CREATE TRIGGER trg_outbox_events_notify
  AFTER INSERT ON outbox_events
  FOR EACH ROW
  EXECUTE FUNCTION notify_outbox_event();
