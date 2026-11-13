-- ============================================================================
-- CrewMesh — Migration 007 Down: Restore Migration 006 allocate_serialized_outbox_id
-- ============================================================================

CREATE OR REPLACE FUNCTION allocate_serialized_outbox_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(842026002);

  IF NEW.id IS NULL THEN
    NEW.id := nextval('outbox_events_id_seq');
  END IF;

  RETURN NEW;
END;
$$;
