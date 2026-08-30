-- DB-108..111: durable provider attempts, callback ordering and no-answer retries.
BEGIN;

ALTER TABLE public.calls
  ADD COLUMN IF NOT EXISTS outbound_attempt integer CHECK (outbound_attempt IS NULL OR outbound_attempt BETWEEN 1 AND 3),
  ADD COLUMN IF NOT EXISTS dispatch_state text CHECK (dispatch_state IS NULL OR dispatch_state IN ('prepared','dispatching','accepted','unknown','failed')),
  ADD COLUMN IF NOT EXISTS raw_twilio_status text,
  ADD COLUMN IF NOT EXISTS last_callback_sequence integer,
  ADD COLUMN IF NOT EXISTS last_callback_at timestamptz,
  ADD COLUMN IF NOT EXISTS answered_at timestamptz,
  ADD COLUMN IF NOT EXISTS dispatch_started_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS calls_request_attempt_unique ON public.calls(quote_request_id,outbound_attempt)
  WHERE quote_request_id IS NOT NULL AND outbound_attempt IS NOT NULL;
CREATE INDEX IF NOT EXISTS calls_request_status_idx ON public.calls(quote_request_id,raw_twilio_status);
CREATE INDEX IF NOT EXISTS outbox_provider_claim_idx ON public.outbox(available_at,created_at)
  WHERE job_type='contact_provider' AND status IN ('pending','processing');

CREATE OR REPLACE FUNCTION public.validate_provider_attempt_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.outbound_attempt IS DISTINCT FROM OLD.outbound_attempt THEN
    RAISE EXCEPTION 'call_attempt_is_immutable' USING ERRCODE='P0001';
  END IF;
  -- Historical rows may remain uncorrelated; new attempts must be durable.
  IF TG_OP='INSERT' AND NEW.persona='provider' AND NEW.direction='outbound'
    AND (NEW.quote_request_id IS NULL OR NEW.outbound_attempt IS NULL OR NEW.dispatch_state IS DISTINCT FROM 'prepared') THEN
    RAISE EXCEPTION 'durable_outbound_attempt_required' USING ERRCODE='P0001';
  END IF;
  IF NEW.outbound_attempt IS NOT NULL AND (NEW.persona<>'provider' OR NEW.direction<>'outbound') THEN
    RAISE EXCEPTION 'invalid_call_attempt_scope' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER calls_validate_provider_attempt_scope BEFORE INSERT OR UPDATE ON public.calls
  FOR EACH ROW EXECUTE FUNCTION public.validate_provider_attempt_scope();

CREATE OR REPLACE FUNCTION public.claim_next_provider_contact_v2()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  candidate public.outbox%ROWTYPE;
  j public.outbox%ROWTYPE;
  q public.quote_requests%ROWTYPE;
  op public.operations%ROWTYPE;
  r public.sourcing_rounds%ROWTYPE;
  c public.calls%ROWTYPE;
  p public.providers%ROWTYPE;
  purpose_value text; payload_call_text text;
  attempt_value integer;
  payload_call_id uuid;
  token uuid;
  i integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('provider-contact-dispatch-rate',0));
  FOR candidate IN
    SELECT o.* FROM public.outbox o
    WHERE o.job_type='contact_provider' AND o.available_at<=clock_timestamp()
      AND (o.status='pending' OR (o.status='processing' AND o.locked_until IS NOT NULL AND o.locked_until<=clock_timestamp()))
    ORDER BY o.available_at,o.created_at,o.id LIMIT 20
  LOOP
    i:=i+1;
    SELECT * INTO q FROM public.quote_requests WHERE id=candidate.quote_request_id;
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT * INTO op FROM public.operations WHERE id=q.operation_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    purpose_value:=candidate.payload->>'purpose';
    attempt_value:=CASE WHEN candidate.payload->>'attempt' ~ '^[1-3]$' THEN (candidate.payload->>'attempt')::integer ELSE NULL END;
    IF purpose_value IS NULL OR attempt_value IS NULL THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM public.calls prior WHERE prior.quote_request_id=q.id AND prior.answered_at IS NOT NULL) THEN CONTINUE; END IF;
    payload_call_text:=NULLIF(candidate.payload->>'call_id','');
    IF payload_call_text IS NOT NULL AND payload_call_text !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN CONTINUE; END IF;
    payload_call_id:=payload_call_text::uuid;
    IF payload_call_id IS NOT NULL THEN
      SELECT * INTO c FROM public.calls WHERE id=payload_call_id FOR UPDATE;
      IF NOT FOUND OR c.quote_request_id IS DISTINCT FROM q.id OR c.outbound_attempt IS DISTINCT FROM attempt_value THEN CONTINUE; END IF;
      IF c.dispatch_state IS DISTINCT FROM 'prepared' THEN CONTINUE; END IF;
    ELSE
      SELECT * INTO c FROM public.calls WHERE quote_request_id=q.id AND outbound_attempt=attempt_value FOR UPDATE;
      IF FOUND THEN CONTINUE; END IF;
    END IF;
    SELECT * INTO r FROM public.sourcing_rounds WHERE id=q.round_id FOR UPDATE;
    SELECT * INTO q FROM public.quote_requests WHERE id=q.id FOR UPDATE;
    IF NOT FOUND OR r.id IS NULL OR r.status<>'active'::public.sourcing_round_status
      OR q.status NOT IN ('queued','contacted') OR q.expires_at<=clock_timestamp() OR q.mandate_id IS DISTINCT FROM op.current_mandate_id
      OR op.status NOT IN ('sourcing','quotes_received') OR op.mandate_confirmation_required IS TRUE
      OR NOT ((purpose_value='booking_replacement' AND r.kind='replacement'::public.sourcing_round_kind)
        OR (purpose_value='renegotiation' AND r.kind='renegotiation'::public.sourcing_round_kind)
        OR (purpose_value='quote_request' AND r.kind='initial'::public.sourcing_round_kind)) THEN CONTINUE; END IF;
    SELECT * INTO p FROM public.providers WHERE id=q.provider_id AND active;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF (SELECT count(*) FROM public.calls x WHERE x.operation_id=op.id AND x.direction='outbound'
      AND x.dispatch_state IN ('dispatching','accepted','unknown')
      AND (x.raw_twilio_status IS NULL OR x.raw_twilio_status NOT IN ('completed','busy','failed','no-answer','canceled')))>=2
      OR EXISTS (SELECT 1 FROM public.calls x WHERE x.direction='outbound'
        AND x.dispatch_started_at>clock_timestamp()-interval '1 second') THEN CONTINUE; END IF;
    SELECT * INTO j FROM public.outbox WHERE id=candidate.id
      AND (status='pending' OR (status='processing' AND locked_until IS NOT NULL AND locked_until<=clock_timestamp())) FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF j.quote_request_id IS DISTINCT FROM q.id OR j.operation_id IS DISTINCT FROM op.id
      OR j.available_at>clock_timestamp() OR j.payload->>'call_id' IS DISTINCT FROM payload_call_text
      OR (j.payload->>'purpose') IS DISTINCT FROM purpose_value
      OR (j.payload->>'attempt') IS DISTINCT FROM candidate.payload->>'attempt'
      OR (j.payload->>'round_id') IS DISTINCT FROM q.round_id::text THEN CONTINUE; END IF;
    IF c.id IS NULL THEN
      INSERT INTO public.calls(operation_id,provider_id,twilio_call_sid,realtime_call_id,persona,direction,provider_intent,purpose,quote_request_id,outbound_attempt,dispatch_state)
        VALUES(q.operation_id,q.provider_id,NULL,NULL,'provider','outbound','quote',purpose_value,q.id,attempt_value,'prepared') RETURNING * INTO c;
    END IF;
    token:=gen_random_uuid();
    UPDATE public.outbox SET status='processing',attempts=attempts+1,lock_token=token,
      locked_until=clock_timestamp()+interval '2 minutes',payload=payload||jsonb_build_object('call_id',c.id,'lock_token',token)
      WHERE id=j.id;
    RETURN jsonb_build_object('outbox_id',j.id,'call_id',c.id,'lock_token',token,'operation_id',q.operation_id,
      'round_id',q.round_id,'quote_request_id',q.id,'provider_id',q.provider_id,'provider_phone',p.phone,
      'purpose',purpose_value,'attempt',attempt_value);
  END LOOP;
  RETURN NULL;
END; $$;

CREATE OR REPLACE FUNCTION public.begin_provider_contact(p_outbox_id uuid,p_call_id uuid,p_lock_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  j public.outbox%ROWTYPE;
  c public.calls%ROWTYPE;
  q public.quote_requests%ROWTYPE;
  op public.operations%ROWTYPE;
  r public.sourcing_rounds%ROWTYPE;
  p public.providers%ROWTYPE;
  purpose_value text;
  attempt_value integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('provider-contact-dispatch-rate',0));
  SELECT * INTO j FROM public.outbox WHERE id=p_outbox_id AND lock_token=p_lock_token;
  SELECT * INTO c FROM public.calls WHERE id=p_call_id;
  IF NOT FOUND OR c.operation_id IS NULL OR c.quote_request_id IS NULL THEN RETURN jsonb_build_object('should_dial',false); END IF;
  SELECT * INTO op FROM public.operations WHERE id=c.operation_id FOR UPDATE;
  SELECT * INTO c FROM public.calls WHERE id=p_call_id FOR UPDATE;
  SELECT * INTO r FROM public.sourcing_rounds WHERE id=(SELECT round_id FROM public.quote_requests WHERE id=c.quote_request_id) FOR UPDATE;
  SELECT * INTO q FROM public.quote_requests WHERE id=c.quote_request_id FOR UPDATE;
  SELECT * INTO p FROM public.providers WHERE id=c.provider_id AND active;
  SELECT * INTO j FROM public.outbox WHERE id=p_outbox_id AND lock_token=p_lock_token AND status='processing' FOR UPDATE;
  IF j.id IS NULL OR q.id IS NULL OR r.id IS NULL OR op.id IS NULL OR p.id IS NULL THEN RETURN jsonb_build_object('should_dial',false); END IF;
  purpose_value:=j.payload->>'purpose';
  attempt_value:=CASE WHEN j.payload->>'attempt' ~ '^[1-3]$' THEN (j.payload->>'attempt')::integer ELSE NULL END;
  IF j.locked_until IS NULL OR j.locked_until<=clock_timestamp() OR j.available_at>clock_timestamp()
    OR j.job_type<>'contact_provider' OR j.payload->>'round_id' IS DISTINCT FROM r.id::text
    OR r.operation_id IS DISTINCT FROM op.id OR r.mandate_id IS DISTINCT FROM op.current_mandate_id
    OR c.outcome<>'active' OR c.provider_tools_completed_at IS NOT NULL
    OR EXISTS (SELECT 1 FROM public.calls prior WHERE prior.quote_request_id=q.id AND prior.answered_at IS NOT NULL)
    OR j.payload->>'call_id' IS DISTINCT FROM c.id::text OR j.operation_id IS DISTINCT FROM op.id
    OR j.quote_request_id IS DISTINCT FROM q.id OR c.operation_id IS DISTINCT FROM op.id
    OR c.quote_request_id IS DISTINCT FROM q.id OR c.provider_id IS DISTINCT FROM q.provider_id
    OR c.direction<>'outbound' OR c.persona<>'provider' OR c.provider_intent<>'quote'
    OR c.purpose IS DISTINCT FROM purpose_value OR c.outbound_attempt IS DISTINCT FROM attempt_value
    OR purpose_value IS NULL OR attempt_value IS NULL OR q.status NOT IN ('queued','contacted')
    OR q.mandate_id IS DISTINCT FROM op.current_mandate_id OR op.status NOT IN ('sourcing','quotes_received')
    OR op.mandate_confirmation_required IS TRUE OR q.expires_at<=clock_timestamp()
    OR r.status IS DISTINCT FROM 'active'::public.sourcing_round_status
    OR NOT ((purpose_value='booking_replacement' AND r.kind='replacement'::public.sourcing_round_kind)
      OR (purpose_value='renegotiation' AND r.kind='renegotiation'::public.sourcing_round_kind)
      OR (purpose_value='quote_request' AND r.kind='initial'::public.sourcing_round_kind))
    OR c.dispatch_state IS DISTINCT FROM 'prepared' THEN RETURN jsonb_build_object('should_dial',false); END IF;
  IF (SELECT count(*) FROM public.calls x WHERE x.operation_id=op.id AND x.direction='outbound'
      AND x.dispatch_state IN ('dispatching','accepted','unknown')
      AND (x.raw_twilio_status IS NULL OR x.raw_twilio_status NOT IN ('completed','busy','failed','no-answer','canceled')))>=2
    OR EXISTS (SELECT 1 FROM public.calls x WHERE x.direction='outbound'
      AND x.dispatch_started_at>clock_timestamp()-interval '1 second') THEN
    UPDATE public.outbox SET status='pending',locked_until=NULL,available_at=clock_timestamp()+interval '1 second'
      WHERE id=j.id;
    RETURN jsonb_build_object('should_dial',false);
  END IF;
  UPDATE public.calls SET dispatch_state='dispatching',dispatch_started_at=clock_timestamp() WHERE id=c.id;
  RETURN jsonb_build_object('should_dial',true);
END; $$;

CREATE OR REPLACE FUNCTION public.finish_provider_contact_v2(
  p_outbox_id uuid,p_call_id uuid,p_lock_token uuid,p_twilio_call_sid text,p_error text,p_error_kind text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.calls%ROWTYPE; j public.outbox%ROWTYPE; op public.operations%ROWTYPE;
  qr public.quote_requests%ROWTYPE; sr public.sourcing_rounds%ROWTYPE; next_state text;
BEGIN
  IF (p_twilio_call_sid IS NOT NULL AND (p_twilio_call_sid !~ '^CA[0-9a-fA-F]{32}$'
      OR p_error IS NOT NULL OR p_error_kind IS NOT NULL))
    OR (p_twilio_call_sid IS NULL AND (p_error IS NULL OR btrim(p_error)=''
      OR p_error_kind IS NULL OR p_error_kind NOT IN ('definite','ambiguous'))) THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO c FROM public.calls WHERE id=p_call_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE='P0001'; END IF;
  SELECT * INTO op FROM public.operations WHERE id=c.operation_id FOR UPDATE;
  SELECT * INTO c FROM public.calls WHERE id=p_call_id FOR UPDATE;
  SELECT * INTO sr FROM public.sourcing_rounds WHERE id=(SELECT round_id FROM public.quote_requests WHERE id=c.quote_request_id) FOR UPDATE;
  SELECT * INTO qr FROM public.quote_requests WHERE id=c.quote_request_id FOR UPDATE;
  SELECT * INTO j FROM public.outbox WHERE id=p_outbox_id AND lock_token=p_lock_token FOR UPDATE;
  IF j.id IS NULL OR qr.id IS NULL OR sr.id IS NULL OR c.persona<>'provider' OR c.direction<>'outbound'
    OR j.job_type<>'contact_provider' OR j.operation_id IS DISTINCT FROM c.operation_id
    OR j.quote_request_id IS DISTINCT FROM c.quote_request_id OR j.payload->>'call_id' IS DISTINCT FROM c.id::text
    OR j.payload->>'attempt' IS DISTINCT FROM c.outbound_attempt::text
    OR c.dispatch_state IS NULL OR c.dispatch_state='prepared' THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE='P0001';
  END IF;
  IF p_twilio_call_sid IS NOT NULL THEN
    IF c.twilio_call_sid IS NOT NULL AND c.twilio_call_sid<>p_twilio_call_sid THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';
    END IF;
    next_state:=CASE WHEN c.dispatch_state IN ('unknown','failed') AND sr.status<>'active'
      THEN c.dispatch_state ELSE 'accepted' END;
    UPDATE public.calls SET twilio_call_sid=coalesce(twilio_call_sid,p_twilio_call_sid),
      dispatch_state=next_state WHERE id=c.id;
    UPDATE public.sourcing_rounds SET first_dispatched_at=coalesce(first_dispatched_at,clock_timestamp()) WHERE id=sr.id;
    UPDATE public.quote_requests SET dispatched_at=coalesce(dispatched_at,clock_timestamp()),
      status=CASE WHEN status='queued' THEN 'contacted'::public.quote_request_status ELSE status END WHERE id=qr.id;
  ELSE
    -- A callback is stronger evidence than a local POST error.
    next_state:=CASE WHEN c.twilio_call_sid IS NOT NULL OR c.raw_twilio_status IS NOT NULL THEN c.dispatch_state
      WHEN c.dispatch_state IN ('unknown','failed') THEN c.dispatch_state
      WHEN p_error_kind='ambiguous' THEN 'unknown' ELSE 'failed' END;
    UPDATE public.calls SET dispatch_state=next_state,
      outcome=CASE WHEN next_state='failed' AND outcome='active' THEN 'failed'::public.call_outcome ELSE outcome END
      WHERE id=c.id;
  END IF;
  -- Retain the token and exact call binding for idempotent persistence retries.
  UPDATE public.outbox SET status='processed',processed_at=coalesce(processed_at,clock_timestamp()),
    locked_until=NULL,last_error_code=CASE WHEN p_error IS NOT NULL THEN left(p_error,500) ELSE last_error_code END WHERE id=j.id;
  RETURN jsonb_build_object('dispatch_state',next_state,'persisted',true);
END; $$;

CREATE OR REPLACE FUNCTION public.record_provider_call_status(p_call_id uuid,p_twilio_call_sid text,p_status text,p_sequence integer,p_event_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.calls%ROWTYPE; q public.quote_requests%ROWTYPE; r public.sourcing_rounds%ROWTYPE; op public.operations%ROWTYPE;
  n integer; retry boolean:=false; previous_status text; previous_state text; previous_answered timestamptz;
  terminal_status boolean; anomaly text;
BEGIN
  IF p_twilio_call_sid IS NULL OR p_twilio_call_sid !~ '^CA[0-9A-Fa-f]{32}$'
    OR p_status IS NULL OR p_status NOT IN ('queued','initiated','ringing','in-progress','completed','busy','failed','no-answer','canceled')
    OR p_sequence IS NULL OR p_sequence<0 OR p_event_at IS NULL THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO c FROM public.calls WHERE id=p_call_id;
  IF NOT FOUND OR c.direction<>'outbound' OR c.persona<>'provider' OR c.quote_request_id IS NULL OR c.purpose IS NULL
    OR c.purpose NOT IN ('quote_request','renegotiation','booking_replacement') THEN
    RETURN jsonb_build_object('accepted',false,'retry_scheduled',false,'next_attempt',NULL);
  END IF;
  SELECT * INTO op FROM public.operations WHERE id=c.operation_id FOR UPDATE;
  SELECT * INTO c FROM public.calls WHERE id=p_call_id FOR UPDATE;
  SELECT * INTO r FROM public.sourcing_rounds WHERE id=(SELECT round_id FROM public.quote_requests WHERE id=c.quote_request_id) FOR UPDATE;
  SELECT * INTO q FROM public.quote_requests WHERE id=c.quote_request_id FOR UPDATE;
  IF c.twilio_call_sid IS NOT NULL AND c.twilio_call_sid IS DISTINCT FROM p_twilio_call_sid THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF;
  IF c.last_callback_sequence IS NOT NULL AND p_sequence<=c.last_callback_sequence THEN
    -- Arrival order must not erase positive answer evidence or permit a retry.
    -- Keep the monotonic status/sequence untouched, even for a delayed answer.
    IF p_status IN ('in-progress','completed') AND c.answered_at IS NULL THEN
      UPDATE public.calls SET answered_at=p_event_at WHERE id=c.id;
      UPDATE public.outbox SET status='processed',processed_at=coalesce(processed_at,clock_timestamp()),
        locked_until=NULL,last_error_code='late_answer_cancels_retry'
        WHERE quote_request_id=q.id AND job_type='contact_provider' AND status IN ('pending','processing')
          AND payload->>'attempt' IN ('2','3') AND (payload->>'attempt')::integer>c.outbound_attempt
          AND NOT EXISTS (SELECT 1 FROM public.calls next_call WHERE next_call.id::text=outbox.payload->>'call_id'
            AND next_call.dispatch_state IN ('dispatching','accepted','unknown'));
    END IF;
    RETURN jsonb_build_object('accepted',false,'retry_scheduled',false,'next_attempt',NULL);
  END IF;
  previous_status:=c.raw_twilio_status; previous_state:=c.dispatch_state; previous_answered:=c.answered_at;
  terminal_status:=previous_status IN ('completed','busy','failed','no-answer','canceled');
  IF terminal_status OR (previous_state='unknown' AND r.status<>'active') OR (previous_answered IS NOT NULL AND p_status='no-answer') THEN
    anomaly:=CASE WHEN previous_answered IS NOT NULL AND p_status='no-answer' THEN 'no_answer_after_answered' ELSE 'callback_after_terminal' END;
    UPDATE public.calls SET twilio_call_sid=coalesce(twilio_call_sid,p_twilio_call_sid),last_callback_sequence=p_sequence,last_callback_at=p_event_at,
      raw_twilio_status=CASE WHEN previous_state='unknown' AND NOT coalesce(terminal_status,false) THEN p_status ELSE raw_twilio_status END,
      ended_at=CASE WHEN p_status IN ('completed','busy','failed','no-answer','canceled') THEN coalesce(ended_at,p_event_at) ELSE ended_at END,
      answered_at=CASE WHEN p_status IN ('in-progress','completed') THEN coalesce(answered_at,p_event_at) ELSE answered_at END WHERE id=c.id;
    IF p_status IN ('in-progress','completed') THEN
      UPDATE public.outbox SET status='processed',processed_at=coalesce(processed_at,clock_timestamp()),
        locked_until=NULL,last_error_code='late_answer_cancels_retry'
        WHERE quote_request_id=q.id AND job_type='contact_provider' AND status IN ('pending','processing')
          AND (payload->>'attempt')::integer>c.outbound_attempt
          AND NOT EXISTS (SELECT 1 FROM public.calls next_call WHERE next_call.id::text=outbox.payload->>'call_id'
            AND next_call.dispatch_state IN ('dispatching','accepted','unknown'));
    END IF;
    UPDATE public.outbox SET last_error_code=anomaly WHERE payload->>'call_id'=c.id::text AND status IN ('processing','processed');
    RETURN jsonb_build_object('accepted',false,'retry_scheduled',false,'next_attempt',NULL);
  END IF;
  UPDATE public.calls SET twilio_call_sid=coalesce(twilio_call_sid,p_twilio_call_sid),raw_twilio_status=p_status,last_callback_sequence=p_sequence,last_callback_at=p_event_at,
    answered_at=CASE WHEN p_status IN ('in-progress','completed') THEN coalesce(answered_at,p_event_at) ELSE answered_at END,
    dispatch_state=CASE WHEN dispatch_state IN ('prepared','dispatching','unknown') THEN 'accepted' ELSE dispatch_state END,
    outcome=CASE WHEN outcome='active' AND p_status IN ('completed','busy','failed','no-answer','canceled') THEN
      CASE WHEN p_status='completed' THEN 'completed'::public.call_outcome ELSE 'failed'::public.call_outcome END ELSE outcome END,
    ended_at=CASE WHEN p_status IN ('completed','busy','failed','no-answer','canceled') THEN coalesce(ended_at,p_event_at) ELSE ended_at END WHERE id=c.id;
  IF q.id IS NOT NULL AND r.id IS NOT NULL THEN
    UPDATE public.sourcing_rounds SET first_dispatched_at=coalesce(first_dispatched_at,p_event_at) WHERE id=r.id;
    UPDATE public.quote_requests SET dispatched_at=coalesce(dispatched_at,p_event_at) WHERE id=q.id AND status IN ('queued','contacted');
  END IF;
  -- A signed callback already proves dispatch. Retire its delivery lease even
  -- if the process died before finish; retain the token for a late finish retry.
  UPDATE public.outbox SET status='processed',processed_at=coalesce(processed_at,clock_timestamp()),locked_until=NULL
    WHERE job_type='contact_provider' AND payload->>'call_id'=c.id::text AND status='processing';
  IF p_status='no-answer' AND c.outbound_attempt<3 AND previous_answered IS NULL
    AND (previous_status IS NULL OR previous_status NOT IN ('completed','busy','failed','no-answer','canceled'))
    AND q.id IS NOT NULL AND op.status IN ('sourcing','quotes_received') AND r.status='active'
    AND NOT op.mandate_confirmation_required AND q.expires_at>clock_timestamp()
    AND q.mandate_id=op.current_mandate_id AND q.status IN ('queued','contacted') AND q.provider_declined_at IS NULL
    AND EXISTS (SELECT 1 FROM public.providers p WHERE p.id=q.provider_id AND p.active)
    AND NOT EXISTS (SELECT 1 FROM public.outbox x WHERE x.quote_request_id=q.id AND x.job_type='contact_provider' AND (x.payload->>'attempt')::integer=c.outbound_attempt+1)
    AND NOT EXISTS (SELECT 1 FROM public.calls x WHERE x.quote_request_id=q.id AND x.outbound_attempt=c.outbound_attempt+1) THEN
    n:=c.outbound_attempt+1;
    INSERT INTO public.outbox(operation_id,quote_request_id,job_type,payload,idempotency_key,available_at)
      VALUES(q.operation_id,q.id,'contact_provider',jsonb_build_object('purpose',c.purpose,'attempt',n,'round_id',q.round_id),
        'contact-provider:'||q.id::text||':attempt:'||n,p_event_at+interval '60 seconds') ON CONFLICT (idempotency_key) DO NOTHING;
    retry:=true;
  END IF;
  RETURN jsonb_build_object('accepted',true,'retry_scheduled',retry,'next_attempt',CASE WHEN retry THEN n ELSE NULL END);
END; $$;

CREATE OR REPLACE FUNCTION public.advance_sourcing_round(p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE op public.operations%ROWTYPE; sr public.sourcing_rounds%ROWTYPE; pending boolean; live_calls boolean;
  valid_quote boolean; prepared jsonb; next_operation_status text;
BEGIN
  SELECT * INTO op FROM public.operations WHERE id=p_operation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('round_id',NULL,'status',NULL,'operation_status','missing','reason','operation_not_found'); END IF;
  -- Lock all scoped calls before the round/request rows. The operation lock also
  -- serializes a concurrent claim, cancellation, quote, mandate or adjudication.
  PERFORM 1 FROM public.calls c WHERE c.operation_id=op.id AND c.quote_request_id IN (
    SELECT qr.id FROM public.quote_requests qr JOIN public.sourcing_rounds r ON r.id=qr.round_id
      WHERE r.operation_id=op.id AND r.status='active') ORDER BY c.id FOR UPDATE;
  SELECT * INTO sr FROM public.sourcing_rounds WHERE operation_id=op.id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('round_id',NULL,'status',NULL,'operation_status',op.status,'reason','no_active_round'); END IF;
  PERFORM 1 FROM public.quote_requests WHERE round_id=sr.id ORDER BY id FOR UPDATE;
  IF op.status NOT IN ('sourcing','quotes_received') OR op.mandate_confirmation_required OR sr.mandate_id<>op.current_mandate_id THEN
    UPDATE public.sourcing_rounds SET status='superseded',closed_at=clock_timestamp() WHERE id=sr.id;
    UPDATE public.outbox SET status='processed',processed_at=clock_timestamp(),locked_until=NULL,
      payload=payload||jsonb_build_object('skipped_reason','round_scope_changed')
      WHERE job_type='contact_provider' AND status IN ('pending','processing')
        AND quote_request_id IN (SELECT id FROM public.quote_requests WHERE round_id=sr.id);
    RETURN jsonb_build_object('round_id',sr.id,'status','superseded','operation_status',op.status,'reason','round_scope_changed');
  END IF;
  IF EXISTS (SELECT 1 FROM public.calls c JOIN public.quote_requests qr ON qr.id=c.quote_request_id
    WHERE qr.round_id=sr.id AND c.dispatch_state IN ('dispatching','unknown') AND c.twilio_call_sid IS NULL
      AND c.dispatch_started_at<=clock_timestamp()-interval '2 minutes') THEN
    UPDATE public.calls SET dispatch_state='unknown',
      outcome=CASE WHEN outcome='active' THEN 'failed'::public.call_outcome ELSE outcome END
      WHERE quote_request_id IN (SELECT id FROM public.quote_requests WHERE round_id=sr.id)
        AND dispatch_state IN ('dispatching','unknown') AND twilio_call_sid IS NULL
        AND dispatch_started_at<=clock_timestamp()-interval '2 minutes';
    UPDATE public.outbox SET status='failed',last_error_code='dispatch_ambiguous',locked_until=NULL
      WHERE job_type='contact_provider' AND quote_request_id IN (SELECT id FROM public.quote_requests WHERE round_id=sr.id)
        AND status IN ('pending','processing');
    UPDATE public.sourcing_rounds SET status='exhausted',closed_at=clock_timestamp() WHERE id=sr.id;
    UPDATE public.operations SET status='needs_follow_up' WHERE id=op.id;
    RETURN jsonb_build_object('round_id',sr.id,'status','exhausted','operation_status','needs_follow_up','reason','dispatch_ambiguous_review');
  END IF;
  -- Invalidated requests cannot keep stale jobs alive forever; dispatched calls
  -- are left alone until real phone-terminal evidence arrives.
  UPDATE public.outbox ob SET status='processed',processed_at=clock_timestamp(),locked_until=NULL,
    payload=payload||jsonb_build_object('skipped_reason','request_unavailable')
    WHERE ob.job_type='contact_provider' AND ob.status IN ('pending','processing')
      AND EXISTS (SELECT 1 FROM public.quote_requests qr LEFT JOIN public.providers p ON p.id=qr.provider_id
        WHERE qr.id=ob.quote_request_id AND qr.round_id=sr.id AND (
          qr.status IN ('cancelled','expired','responded') OR qr.expires_at<=clock_timestamp() OR NOT p.active))
      AND NOT EXISTS (SELECT 1 FROM public.calls c WHERE c.id::text=ob.payload->>'call_id'
        AND c.dispatch_state IN ('dispatching','accepted','unknown'));
  SELECT EXISTS (SELECT 1 FROM public.calls c JOIN public.quote_requests qr ON qr.id=c.quote_request_id
    WHERE qr.round_id=sr.id AND c.dispatch_state IN ('dispatching','accepted','unknown')
      AND (c.raw_twilio_status IS NULL OR c.raw_twilio_status NOT IN ('completed','busy','failed','no-answer','canceled'))) INTO live_calls;
  SELECT EXISTS (SELECT 1 FROM public.outbox ob JOIN public.quote_requests qr ON qr.id=ob.quote_request_id
    WHERE qr.round_id=sr.id AND ob.job_type='contact_provider' AND ob.status IN ('pending','processing')) INTO pending;
  -- Share the adjudicator's current commercial eligibility, including expiry,
  -- currency, provider activity, pickup and supersession; no second price policy.
  prepared:=public.prepare_sourcing_review(op.id);
  valid_quote:=coalesce((prepared->>'ready')::boolean,false)
    OR prepared->>'reason'='comparing_proposals';
  IF live_calls OR pending OR valid_quote THEN
    RETURN jsonb_build_object('round_id',sr.id,'status',sr.status,'operation_status',op.status,
      'reason',CASE WHEN valid_quote THEN 'valid_quotes_pending_review' ELSE 'work_pending' END);
  END IF;
  -- A closed call with only a counteroffer is not pending conversation.
  UPDATE public.quote_requests SET status='expired' WHERE round_id=sr.id AND status IN ('pending','queued','contacted');
  IF sr.kind<>'replacement' THEN
    -- Keep the pre-existing initial/renegotiation policy: without eligible
    -- proposals it waits for follow-up, rather than cancelling its current Booking.
    RETURN jsonb_build_object('round_id',sr.id,'status',sr.status,'operation_status',op.status,'reason','waiting_for_valid_quote');
  END IF;
  UPDATE public.sourcing_rounds SET status='exhausted',closed_at=clock_timestamp() WHERE id=sr.id;
  UPDATE public.operations SET status='needs_follow_up' WHERE id=op.id;
  RETURN jsonb_build_object('round_id',sr.id,'status','exhausted','operation_status','needs_follow_up','reason','no_valid_quotes');
END; $$;

REVOKE ALL ON FUNCTION public.claim_next_provider_contact_v2() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.begin_provider_contact(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_provider_contact_v2(uuid,uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.record_provider_call_status(uuid,text,text,integer,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.advance_sourcing_round(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_provider_contact_v2() TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_provider_contact(uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_provider_contact_v2(uuid,uuid,uuid,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_provider_call_status(uuid,text,text,integer,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.advance_sourcing_round(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.claim_next_provider_contact() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_provider_contact(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_next_provider_contact() FROM service_role;
REVOKE ALL ON FUNCTION public.finish_provider_contact(uuid,uuid,text,text) FROM service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
