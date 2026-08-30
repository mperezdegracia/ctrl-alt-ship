-- Bookings are the immutable reservation history. Operations own the one
-- mutable pointer to the booking that is currently in force.
BEGIN;

ALTER TABLE public.operations
  ADD COLUMN current_booking_id uuid REFERENCES public.bookings(id);

UPDATE public.operations o
SET current_booking_id = (
  SELECT b.id
  FROM public.bookings b
  WHERE b.operation_id = o.id AND b.status IN ('pending', 'confirmed')
  ORDER BY b.created_at DESC
  LIMIT 1
);

ALTER TABLE public.bookings
  ADD COLUMN source_call_id uuid REFERENCES public.calls(id),
  ADD COLUMN evidence_start_segment_id uuid REFERENCES public.call_transcript_segments(id),
  ADD COLUMN evidence_end_segment_id uuid REFERENCES public.call_transcript_segments(id);

CREATE OR REPLACE FUNCTION public.validate_booking_evidence()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.source_call_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.calls c WHERE c.id = NEW.source_call_id AND c.operation_id = NEW.operation_id
  ) THEN RAISE EXCEPTION 'booking source call belongs to another operation' USING ERRCODE = '23514'; END IF;
  IF (NEW.evidence_start_segment_id IS NULL) <> (NEW.evidence_end_segment_id IS NULL) THEN
    RAISE EXCEPTION 'booking evidence range is incomplete' USING ERRCODE = '23514';
  END IF;
  IF NEW.evidence_start_segment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.call_transcript_segments first_segment
    JOIN public.call_transcript_segments last_segment ON last_segment.id = NEW.evidence_end_segment_id
    WHERE first_segment.id = NEW.evidence_start_segment_id
      AND first_segment.call_id = last_segment.call_id
      AND first_segment.call_id = NEW.source_call_id
  ) THEN RAISE EXCEPTION 'booking evidence must belong to its source call' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bookings_validate_evidence
BEFORE INSERT OR UPDATE OF operation_id, source_call_id, evidence_start_segment_id, evidence_end_segment_id
ON public.bookings FOR EACH ROW EXECUTE FUNCTION public.validate_booking_evidence();

-- Compatibility bridge for the existing selection and cancellation RPCs. The
-- pointer, rather than a query over booking status, is the read model used by
-- the dashboard. The follow-up booking-write RPC migration can then remove
-- the legacy status columns without changing readers.
CREATE OR REPLACE FUNCTION public.sync_current_booking()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status IN ('pending', 'confirmed') THEN
    UPDATE public.operations SET current_booking_id = NEW.id WHERE id = NEW.operation_id;
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'cancelled' AND OLD.status <> 'cancelled' THEN
    UPDATE public.operations SET current_booking_id = NULL
    WHERE id = NEW.operation_id AND current_booking_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bookings_sync_current_booking
AFTER INSERT OR UPDATE OF status ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.sync_current_booking();

ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_operation_scope_check;
ALTER TABLE public.events DROP COLUMN commitment_id;
DROP TABLE public.commitments;
DROP TYPE public.commitment_type;

CREATE OR REPLACE FUNCTION public.validate_event_context()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.call_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.calls WHERE id = NEW.call_id AND operation_id = NEW.operation_id
  ) THEN RAISE EXCEPTION 'event references another operation' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE public.events
  ADD CONSTRAINT events_operation_scope_check CHECK (
    operation_id IS NOT NULL
    OR (type = 'call.rejected' AND call_id IS NULL)
    OR (type = 'call.routed' AND call_id IS NOT NULL)
  );

NOTIFY pgrst, 'reload schema';
COMMIT;
