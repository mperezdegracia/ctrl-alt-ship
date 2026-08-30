BEGIN;

-- A quote is the durable statement that later justifies an automatic booking.
-- Keep the evidence at that statement, not as a retrospective call-wide range.
ALTER TABLE public.quotes
  ADD COLUMN evidence_start_segment_id uuid REFERENCES public.call_transcript_segments(id),
  ADD COLUMN evidence_end_segment_id uuid REFERENCES public.call_transcript_segments(id);

CREATE TABLE public.provider_quote_evidence_staging (
  call_id uuid NOT NULL REFERENCES public.calls(id),
  tool_call_id text NOT NULL CHECK (btrim(tool_call_id) <> ''),
  segment_id uuid NOT NULL REFERENCES public.call_transcript_segments(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (call_id, tool_call_id)
);
ALTER TABLE public.provider_quote_evidence_staging ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.provider_quote_evidence_staging FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.stage_provider_quote_evidence(
  p_call_id uuid,
  p_realtime_call_id text,
  p_provider_id uuid,
  p_tool_call_id text,
  p_segment_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE existing_segment_id uuid;
BEGIN
  IF p_tool_call_id IS NULL OR btrim(p_tool_call_id) = '' OR p_segment_id IS NULL THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
  END IF;

  -- The segment is selected by the server when Realtime finishes the provider's
  -- audio item; model arguments never choose evidence.
  PERFORM 1
  FROM public.calls c
  JOIN public.call_transcript_segments s ON s.id = p_segment_id AND s.call_id = c.id
  WHERE c.id = p_call_id
    AND c.realtime_call_id = p_realtime_call_id
    AND c.provider_id = p_provider_id
    AND c.persona = 'provider'
    AND c.direction = 'outbound'
    AND s.speaker = 'caller'
    AND s.content IS NOT NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'P0001'; END IF;

  SELECT segment_id INTO existing_segment_id
  FROM public.provider_quote_evidence_staging
  WHERE call_id = p_call_id AND tool_call_id = p_tool_call_id;
  IF FOUND THEN
    IF existing_segment_id IS DISTINCT FROM p_segment_id THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN;
  END IF;

  INSERT INTO public.provider_quote_evidence_staging(call_id, tool_call_id, segment_id)
  VALUES (p_call_id, p_tool_call_id, p_segment_id);
END;
$$;

-- execute_provider_quote_tool creates quote.received before it records the
-- command receipt. Bind that command's staged segment to precisely that quote.
CREATE OR REPLACE FUNCTION public.attach_provider_quote_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE evidence_segment_id uuid; quote_id uuid;
BEGIN
  IF NEW.tool_name <> 'create_quote' THEN RETURN NEW; END IF;

  SELECT segment_id INTO evidence_segment_id
  FROM public.provider_quote_evidence_staging
  WHERE call_id = NEW.call_id AND tool_call_id = NEW.tool_call_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT (e.payload->>'quote_id')::uuid INTO quote_id
  FROM public.events e
  WHERE e.call_id = NEW.call_id
    AND e.type = 'quote.received'
    AND e.payload ? 'quote_id'
  ORDER BY e.occurred_at DESC, e.id DESC
  LIMIT 1;
  IF quote_id IS NULL THEN
    RAISE EXCEPTION 'quote evidence has no quote receipt' USING ERRCODE = '23514';
  END IF;

  UPDATE public.quotes
  SET evidence_start_segment_id = evidence_segment_id,
      evidence_end_segment_id = evidence_segment_id
  WHERE id = quote_id
    AND evidence_start_segment_id IS NULL
    AND evidence_end_segment_id IS NULL;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tool_command_receipts_attach_provider_quote_evidence
AFTER INSERT ON public.tool_command_receipts
FOR EACH ROW EXECUTE FUNCTION public.attach_provider_quote_evidence();

-- Automatic selection carries the quoted statement forward. Existing booking
-- validation then guarantees the segment belongs to the selected source call.
CREATE OR REPLACE FUNCTION public.assign_booking_quote_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE quote_call_id uuid; start_segment_id uuid; end_segment_id uuid;
BEGIN
  IF NEW.quote_id IS NULL
     OR NEW.evidence_start_segment_id IS NOT NULL
     OR NEW.evidence_end_segment_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT e.call_id, q.evidence_start_segment_id, q.evidence_end_segment_id
  INTO quote_call_id, start_segment_id, end_segment_id
  FROM public.quotes q
  JOIN public.events e ON e.type = 'quote.received'
    AND e.payload->>'quote_id' = q.id::text
  WHERE q.id = NEW.quote_id
  ORDER BY e.occurred_at DESC, e.id DESC
  LIMIT 1;

  IF start_segment_id IS NULL OR end_segment_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.source_call_id IS NOT NULL AND NEW.source_call_id <> quote_call_id THEN RETURN NEW; END IF;

  NEW.source_call_id := coalesce(NEW.source_call_id, quote_call_id);
  NEW.evidence_start_segment_id := start_segment_id;
  NEW.evidence_end_segment_id := end_segment_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bookings_assign_quote_evidence
BEFORE INSERT ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.assign_booking_quote_evidence();

REVOKE ALL ON FUNCTION public.stage_provider_quote_evidence(uuid, text, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stage_provider_quote_evidence(uuid, text, uuid, text, uuid)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
