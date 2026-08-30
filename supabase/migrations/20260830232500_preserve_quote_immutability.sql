BEGIN;

-- Forward repair: a deployed version of 20260830232200 updated the quote from
-- attach_provider_quote_evidence, which fails with 55000 (quotes is append-only).
-- Replacing that historical file does not repair databases that already ran it.
-- Keep quotes_append_only intact: create_quote inserts each new price version;
-- its transcript evidence is inserted separately in the same transaction.
CREATE TABLE IF NOT EXISTS public.quote_transcript_evidence (
  quote_id uuid PRIMARY KEY REFERENCES public.quotes(id),
  source_call_id uuid NOT NULL REFERENCES public.calls(id),
  evidence_start_segment_id uuid NOT NULL REFERENCES public.call_transcript_segments(id),
  evidence_end_segment_id uuid NOT NULL REFERENCES public.call_transcript_segments(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (evidence_start_segment_id = evidence_end_segment_id)
);
ALTER TABLE public.quote_transcript_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.quote_transcript_evidence FROM PUBLIC, anon, authenticated, service_role;

-- An earlier deployed revision stored evidence columns on quotes. Preserve any
-- valid historical links without updating or dropping those legacy columns.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='quotes' AND column_name='evidence_start_segment_id')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
      AND table_name='quotes' AND column_name='evidence_end_segment_id') THEN
    EXECUTE $backfill$
      INSERT INTO public.quote_transcript_evidence(
        quote_id, source_call_id, evidence_start_segment_id, evidence_end_segment_id)
      SELECT q.id, s.call_id, s.id, s.id
      FROM public.quotes q
      JOIN public.call_transcript_segments s ON s.id=q.evidence_start_segment_id
      JOIN public.calls c ON c.id=s.call_id
      JOIN public.quote_requests qr ON qr.id=q.quote_request_id
      WHERE q.evidence_end_segment_id=s.id AND s.speaker='caller'
        AND c.provider_id=qr.provider_id AND c.operation_id=qr.operation_id
        AND EXISTS (SELECT 1 FROM public.events e WHERE e.call_id=c.id
          AND e.type='quote.received' AND e.payload->>'quote_id'=q.id::text)
      ON CONFLICT (quote_id) DO NOTHING
    $backfill$;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.attach_provider_quote_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE evidence_segment_id uuid; target_quote_id uuid;
BEGIN
  IF NEW.tool_name <> 'create_quote' THEN RETURN NEW; END IF;

  SELECT segment_id INTO evidence_segment_id
  FROM public.provider_quote_evidence_staging
  WHERE call_id = NEW.call_id AND tool_call_id = NEW.tool_call_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT (e.payload->>'quote_id')::uuid INTO target_quote_id
  FROM public.events e
  WHERE e.call_id = NEW.call_id
    AND e.type = 'quote.received'
    AND e.payload ? 'quote_id'
    AND e.payload->>'operation_reference' = NEW.result->>'operation_reference'
    AND e.payload->>'quote_version' = NEW.result->>'quote_version';
  IF target_quote_id IS NULL THEN
    RAISE EXCEPTION 'quote evidence has no quote receipt' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.quote_transcript_evidence(
    quote_id, source_call_id, evidence_start_segment_id, evidence_end_segment_id
  ) VALUES (target_quote_id, NEW.call_id, evidence_segment_id, evidence_segment_id)
  ON CONFLICT (quote_id) DO NOTHING;
  RETURN NEW;
END;
$$;

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

  SELECT qte.source_call_id, qte.evidence_start_segment_id, qte.evidence_end_segment_id
  INTO quote_call_id, start_segment_id, end_segment_id
  FROM public.quote_transcript_evidence qte
  WHERE qte.quote_id = NEW.quote_id;

  IF start_segment_id IS NULL OR end_segment_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.source_call_id IS NOT NULL AND NEW.source_call_id <> quote_call_id THEN RETURN NEW; END IF;

  NEW.source_call_id := coalesce(NEW.source_call_id, quote_call_id);
  NEW.evidence_start_segment_id := start_segment_id;
  NEW.evidence_end_segment_id := end_segment_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quote_transcript_evidence_append_only ON public.quote_transcript_evidence;
CREATE TRIGGER quote_transcript_evidence_append_only
BEFORE UPDATE OR DELETE ON public.quote_transcript_evidence
FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

REVOKE ALL ON FUNCTION public.attach_provider_quote_evidence(), public.assign_booking_quote_evidence()
  FROM PUBLIC, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
