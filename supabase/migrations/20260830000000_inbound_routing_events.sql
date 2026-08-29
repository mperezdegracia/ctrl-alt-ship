ALTER TABLE events DROP CONSTRAINT events_operation_scope_check;

ALTER TABLE events
  ADD CONSTRAINT events_operation_scope_check CHECK (
    operation_id IS NOT NULL
    OR (type = 'call.rejected' AND call_id IS NULL AND commitment_id IS NULL)
    OR (type = 'call.routed' AND call_id IS NOT NULL AND commitment_id IS NULL)
  );

CREATE OR REPLACE FUNCTION validate_event_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.call_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM calls
       WHERE id = NEW.call_id AND operation_id IS NOT DISTINCT FROM NEW.operation_id
     ))
     OR (NEW.commitment_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM commitments WHERE id = NEW.commitment_id AND operation_id = NEW.operation_id
     )) THEN
    RAISE EXCEPTION 'event references another operation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
