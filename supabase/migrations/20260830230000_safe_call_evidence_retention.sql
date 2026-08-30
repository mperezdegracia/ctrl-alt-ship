BEGIN;

ALTER TABLE public.calls
  ADD COLUMN IF NOT EXISTS transcript_purged_at timestamptz,
  ADD COLUMN IF NOT EXISTS retention_checked_at timestamptz;

ALTER TABLE public.calls DROP CONSTRAINT IF EXISTS calls_recording_status_check;
ALTER TABLE public.calls
  ADD CONSTRAINT calls_recording_status_check CHECK
    (recording_status IN ('pending', 'in-progress', 'completed', 'absent', 'deleted', 'deletion_pending', 'failed'));

CREATE TABLE IF NOT EXISTS public.call_recordings (
  recording_sid text PRIMARY KEY CHECK (recording_sid ~ '^RE[0-9a-fA-F]{32}$'),
  call_id uuid NOT NULL REFERENCES public.calls(id),
  status text NOT NULL CHECK (status IN ('in-progress', 'completed', 'absent', 'failed')),
  deleted_at timestamptz,
  deletion_error text,
  last_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (deleted_at IS NULL OR status = 'completed'),
  CHECK (deleted_at IS NULL OR deletion_error IS NULL)
);
CREATE INDEX IF NOT EXISTS call_recordings_call_idx ON public.call_recordings(call_id, created_at, recording_sid);
CREATE INDEX IF NOT EXISTS call_recordings_pending_idx ON public.call_recordings(call_id, status, deleted_at)
  WHERE deleted_at IS NULL;
ALTER TABLE public.call_recordings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.call_recordings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.call_recordings TO service_role;

INSERT INTO public.call_recordings(recording_sid, call_id, status, deleted_at, created_at)
SELECT c.recording_sid,
       c.id,
       CASE c.recording_status
         WHEN 'pending' THEN 'in-progress'
         WHEN 'in-progress' THEN 'in-progress'
         WHEN 'deleted' THEN 'completed'
         WHEN 'deletion_pending' THEN 'completed'
         WHEN 'absent' THEN 'absent'
         WHEN 'failed' THEN 'failed'
         ELSE 'completed'
       END,
       NULL::timestamptz, -- Legacy deletion flags are not proof of a successful DELETE.
       c.created_at
FROM public.calls c
WHERE c.recording_sid IS NOT NULL
ON CONFLICT (recording_sid) DO NOTHING;

ALTER TABLE public.call_transcript_segments
  ALTER COLUMN content DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS content_deleted_at timestamptz;
ALTER TABLE public.call_transcript_segments DROP CONSTRAINT IF EXISTS call_transcript_segments_content_check;
ALTER TABLE public.call_transcript_segments
  ADD CONSTRAINT call_transcript_segments_content_tombstone_check CHECK (
    (content IS NOT NULL) <> (content_deleted_at IS NOT NULL)
  ),
  ADD CONSTRAINT call_transcript_segments_content_value_check CHECK (
    content IS NULL OR (btrim(content) <> '' AND char_length(content) <= 10000)
  );

CREATE OR REPLACE FUNCTION public.reject_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_call_transcript_tombstone()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE expires_at timestamptz;
BEGIN
  IF (to_jsonb(NEW) - 'content' - 'content_deleted_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'content' - 'content_deleted_at') THEN
    RAISE EXCEPTION 'transcript metadata is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.content_deleted_at IS NOT NULL THEN
    IF NEW.content IS NOT NULL OR NEW.content_deleted_at IS DISTINCT FROM OLD.content_deleted_at THEN
      RAISE EXCEPTION 'transcript tombstone cannot be restored' USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.content IS DISTINCT FROM OLD.content OR NEW.content_deleted_at IS DISTINCT FROM OLD.content_deleted_at THEN
    SELECT c.evidence_expires_at INTO expires_at FROM public.calls c WHERE c.id = OLD.call_id FOR UPDATE;
    IF expires_at IS NULL OR expires_at > now()
       OR NEW.content IS NOT NULL OR NEW.content_deleted_at IS NULL THEN
      RAISE EXCEPTION 'transcript content may only be tombstoned after expiry' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tombstone_late_transcript()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE expired boolean;
BEGIN
  SELECT c.evidence_expires_at <= now() INTO expired
  FROM public.calls c WHERE c.id = NEW.call_id FOR UPDATE;
  IF NEW.content IS NULL OR NEW.content_deleted_at IS NOT NULL THEN
    IF NOT coalesce(expired, false) THEN
      RAISE EXCEPTION 'transcript tombstone is only valid after expiry' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF coalesce(expired, false) THEN
    NEW.content := NULL;
    NEW.content_deleted_at := coalesce(NEW.content_deleted_at, now());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS call_transcript_segments_append_only ON public.call_transcript_segments;
CREATE TRIGGER call_transcript_segments_tombstone_guard
BEFORE UPDATE ON public.call_transcript_segments
FOR EACH ROW EXECUTE FUNCTION public.guard_call_transcript_tombstone();
CREATE TRIGGER call_transcript_segments_delete_guard
BEFORE DELETE ON public.call_transcript_segments
FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();
CREATE TRIGGER call_transcript_segments_late_insert
BEFORE INSERT ON public.call_transcript_segments
FOR EACH ROW EXECUTE FUNCTION public.tombstone_late_transcript();

CREATE OR REPLACE FUNCTION public.sync_call_recording_aggregate(p_call_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c calls%ROWTYPE; live_completed boolean; live_progress boolean; has_deleted boolean;
  has_absent boolean; has_failed boolean; next_status text;
BEGIN
  SELECT * INTO c FROM public.calls WHERE id = p_call_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'call not found' USING ERRCODE = 'P0002'; END IF;
  SELECT coalesce(bool_or(status='completed' AND deleted_at IS NULL),false),
    coalesce(bool_or(status='in-progress' AND deleted_at IS NULL),false),
    coalesce(bool_or(deleted_at IS NOT NULL),false),
    coalesce(bool_or(status='absent'),false), coalesce(bool_or(status='failed'),false)
  INTO live_completed,live_progress,has_deleted,has_absent,has_failed
  FROM public.call_recordings WHERE call_id=p_call_id;
  next_status := CASE
    WHEN c.evidence_expires_at <= now() AND (live_completed OR live_progress) THEN 'deletion_pending'
    WHEN live_completed THEN 'completed'
    WHEN live_progress THEN 'in-progress'
    WHEN has_deleted THEN 'deleted'
    WHEN has_failed THEN 'failed'
    WHEN has_absent THEN 'absent'
    ELSE c.recording_status END;
  UPDATE public.calls SET recording_status=next_status,
    recording_url=CASE WHEN c.evidence_expires_at <= now() THEN NULL ELSE recording_url END,
    recording_completed_at=CASE WHEN live_completed THEN coalesce(recording_completed_at,now()) ELSE recording_completed_at END
  WHERE id=p_call_id;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_call_recording_aggregate(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_call_recording_status(
  p_twilio_call_sid text, p_recording_sid text, p_status text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c calls%ROWTYPE; r call_recordings%ROWTYPE; expired boolean;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('in-progress', 'completed', 'absent', 'failed')
     OR p_twilio_call_sid IS NULL OR p_twilio_call_sid !~ '^CA[0-9a-fA-F]{32}$'
     OR (p_recording_sid IS NOT NULL AND p_recording_sid !~ '^RE[0-9a-fA-F]{32}$')
     OR (p_status IN ('in-progress', 'completed') AND p_recording_sid IS NULL) THEN
    RAISE EXCEPTION 'invalid recording callback' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO c FROM public.calls WHERE twilio_call_sid = p_twilio_call_sid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'call not found' USING ERRCODE = 'P0002'; END IF;
  expired := c.evidence_expires_at <= now();
  IF p_recording_sid IS NULL THEN
    IF c.recording_status NOT IN ('completed','deleted') AND NOT EXISTS (
      SELECT 1 FROM public.call_recordings WHERE call_id=c.id
    ) THEN
      UPDATE public.calls SET recording_status = p_status WHERE id = c.id;
    END IF;
    PERFORM public.sync_call_recording_aggregate(c.id);
    RETURN jsonb_build_object('persisted', true, 'expired', expired);
  END IF;
  SELECT * INTO r FROM public.call_recordings WHERE recording_sid = p_recording_sid FOR UPDATE;
  IF FOUND AND r.call_id <> c.id THEN RAISE EXCEPTION 'recording belongs to another call' USING ERRCODE = '23514'; END IF;
  IF FOUND THEN
    IF r.deleted_at IS NOT NULL THEN
      PERFORM public.sync_call_recording_aggregate(c.id);
      RETURN jsonb_build_object('persisted', true, 'expired', expired);
    END IF;
    IF r.deleted_at IS NULL AND NOT (r.status = 'completed' AND p_status = 'in-progress') THEN
      UPDATE public.call_recordings SET status = p_status
      WHERE recording_sid = p_recording_sid AND NOT (r.status = 'completed');
    END IF;
  ELSE
    INSERT INTO public.call_recordings(recording_sid, call_id, status)
    VALUES (p_recording_sid, c.id, p_status);
  END IF;
  UPDATE public.calls SET recording_sid = coalesce(recording_sid, p_recording_sid) WHERE id = c.id;
  PERFORM public.sync_call_recording_aggregate(c.id);
  RETURN jsonb_build_object('persisted', true, 'expired', expired);
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_call_evidence_retention(p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE x calls%ROWTYPE; result jsonb := '[]'::jsonb; recordings jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN RAISE EXCEPTION 'invalid limit' USING ERRCODE = '22023'; END IF;
  FOR x IN
    SELECT c.* FROM public.calls c
    WHERE c.evidence_expires_at <= now()
      AND (c.retention_checked_at IS NULL OR c.retention_checked_at < now() - interval '5 minutes')
      AND (c.transcript_purged_at IS NULL
           OR EXISTS (SELECT 1 FROM public.call_transcript_segments s WHERE s.call_id = c.id AND s.content IS NOT NULL)
           OR EXISTS (SELECT 1 FROM public.call_recordings r WHERE r.call_id = c.id AND r.deleted_at IS NULL AND r.status = 'completed'))
    ORDER BY c.retention_checked_at NULLS FIRST, c.evidence_expires_at, c.id
    FOR UPDATE SKIP LOCKED LIMIT p_limit
  LOOP
    UPDATE public.calls SET retention_checked_at = now() WHERE id = x.id;
    SELECT coalesce(jsonb_agg(jsonb_build_object('recording_sid', r.recording_sid) ORDER BY r.recording_sid), '[]'::jsonb)
      INTO recordings FROM public.call_recordings r
      WHERE r.call_id = x.id AND r.deleted_at IS NULL AND r.status = 'completed';
    result := result || jsonb_build_array(jsonb_build_object(
      'call_id', x.id, 'transcript_pending', x.transcript_purged_at IS NULL OR EXISTS (
        SELECT 1 FROM public.call_transcript_segments s WHERE s.call_id=x.id AND s.content IS NOT NULL),
      'recordings', recordings));
  END LOOP;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_expired_call_transcripts(p_call_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_call_id uuid;
BEGIN
  FOR v_call_id IN SELECT c.id FROM public.calls c WHERE c.id = ANY(coalesce(p_call_ids, '{}'::uuid[])) ORDER BY c.id LOOP
    PERFORM 1 FROM public.calls WHERE id = v_call_id AND evidence_expires_at <= now() FOR UPDATE;
    IF FOUND THEN
      UPDATE public.call_transcript_segments
      SET content = NULL, content_deleted_at = now()
      WHERE call_transcript_segments.call_id = v_call_id
        AND content IS NOT NULL;
      UPDATE public.calls SET transcript_purged_at = coalesce(transcript_purged_at, now()) WHERE id = v_call_id;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_call_recording_deletion(
  p_call_id uuid, p_recording_sid text, p_error text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c calls%ROWTYPE; r call_recordings%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.calls WHERE id = p_call_id FOR UPDATE;
  IF NOT FOUND OR c.evidence_expires_at > now() THEN RAISE EXCEPTION 'expired call not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO r FROM public.call_recordings WHERE recording_sid = p_recording_sid AND call_id = p_call_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'recording not found' USING ERRCODE = 'P0002'; END IF;
  IF r.status <> 'completed' AND r.deleted_at IS NULL THEN
    RAISE EXCEPTION 'recording is not completed' USING ERRCODE = '23514';
  END IF;
  IF r.deleted_at IS NULL THEN
    IF p_error IS NULL THEN
      UPDATE public.call_recordings SET deleted_at = now(), deletion_error = NULL, last_attempt_at = now() WHERE recording_sid = p_recording_sid;
    ELSE
      UPDATE public.call_recordings SET deletion_error = left(p_error, 1000), last_attempt_at = now() WHERE recording_sid = p_recording_sid;
    END IF;
  END IF;
  UPDATE public.calls SET recording_sid = coalesce(recording_sid, p_recording_sid), recording_url = NULL WHERE id = p_call_id;
  PERFORM public.sync_call_recording_aggregate(p_call_id);
  RETURN jsonb_build_object('persisted', true);
END;
$$;

REVOKE ALL ON FUNCTION public.record_call_recording_status(text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_call_evidence_retention(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purge_expired_call_transcripts(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_call_recording_deletion(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_call_recording_status(text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_call_evidence_retention(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_expired_call_transcripts(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_call_recording_deletion(uuid,text,text) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
