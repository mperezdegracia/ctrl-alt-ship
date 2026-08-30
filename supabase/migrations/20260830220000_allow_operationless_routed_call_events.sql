-- An accepted inbound call is intentionally operation-less until the caller
-- chooses or creates an operation. Its initial call.routed event must retain
-- that same NULL operation context.
BEGIN;

CREATE OR REPLACE FUNCTION public.validate_event_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.call_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.calls
    WHERE id = NEW.call_id
      AND operation_id IS NOT DISTINCT FROM NEW.operation_id
  ) THEN
    RAISE EXCEPTION 'event references another operation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
