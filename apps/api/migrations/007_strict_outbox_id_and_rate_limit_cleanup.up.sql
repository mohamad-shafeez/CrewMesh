-- ============================================================================
-- CrewMesh — Migration 007: Strict Outbox ID Enforcement (No Caller-Supplied
-- Bypass) & Rate-Limit Expired Bucket Indexing
-- ============================================================================
-- 1. Fixes Batch 08 Section 5.3:
--    In Migration 006, `allocate_serialized_outbox_id()` only assigned `NEW.id`
--    when `NEW.id IS NULL`, meaning a privileged caller supplying an explicit
--    `id` in `INSERT INTO outbox_events (id, ...)` could bypass sequence
--    serialization.
--    This migration updates `allocate_serialized_outbox_id()` to reject any
--    caller-supplied non-null `id` (`ERRCODE = 'check_violation'`) and always
--    assign `NEW.id := nextval('outbox_events_id_seq')` inside the transaction-
--    level advisory lock `pg_advisory_xact_lock(842026002)`.
-- ============================================================================

CREATE OR REPLACE FUNCTION allocate_serialized_outbox_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS NOT NULL THEN
    RAISE EXCEPTION 'Explicit outbox_events.id insertion (%) is forbidden; id must be allocated by trg_outbox_events_serialize_id', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Acquire transaction-level advisory lock BEFORE calling nextval() so no
  -- concurrent transaction can allocate a higher sequence number and commit
  -- ahead of an uncommitted lower sequence number.
  PERFORM pg_advisory_xact_lock(842026002);

  NEW.id := nextval('outbox_events_id_seq');
  RETURN NEW;
END;
$$;
