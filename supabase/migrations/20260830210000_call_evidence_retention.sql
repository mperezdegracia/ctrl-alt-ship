BEGIN;

ALTER TABLE public.calls
  ADD COLUMN recording_sid text UNIQUE,
  ADD COLUMN recording_status text NOT NULL DEFAULT 'pending'
    CHECK (recording_status IN ('pending', 'completed', 'absent', 'deleted', 'failed')),
  ADD COLUMN recording_completed_at timestamptz,
  ADD COLUMN evidence_expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days');

CREATE INDEX calls_evidence_expiry_idx ON public.calls(evidence_expires_at)
  WHERE evidence_expires_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.reject_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'call_transcript_segments'
     AND current_setting('app.evidence_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_expired_call_transcripts(p_call_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_call_ids IS NULL THEN RETURN; END IF;
  PERFORM set_config('app.evidence_purge', 'on', true);
  DELETE FROM public.call_transcript_segments
  WHERE call_id = ANY(p_call_ids) AND recorded_at < now() - interval '90 days';
END;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_call_transcripts(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_call_transcripts(uuid[]) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
