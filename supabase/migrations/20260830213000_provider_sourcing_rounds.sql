-- DB-104..107: round-scoped sourcing, observations and immutable awards.
-- No dispatch is enqueued by historical backfill.
BEGIN;
CREATE TYPE public.sourcing_round_kind AS ENUM ('initial','renegotiation','replacement');
CREATE TYPE public.sourcing_round_status AS ENUM ('active','selected','exhausted','superseded');
CREATE TABLE public.sourcing_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES public.operations(id),
  mandate_id uuid NOT NULL REFERENCES public.mandates(id),
  kind public.sourcing_round_kind NOT NULL,
  source_booking_id uuid REFERENCES public.bookings(id),
  source_round_id uuid REFERENCES public.sourcing_rounds(id),
  status public.sourcing_round_status NOT NULL DEFAULT 'active',
  first_dispatched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  idempotency_key text NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  CHECK ((kind='replacement')=(source_booking_id IS NOT NULL)),
  CHECK ((status='active')=(closed_at IS NULL)),
  CHECK (closed_at IS NULL OR closed_at >= created_at)
);
CREATE UNIQUE INDEX sourcing_rounds_one_active_operation ON public.sourcing_rounds(operation_id) WHERE status='active';
CREATE UNIQUE INDEX sourcing_rounds_one_replacement_booking ON public.sourcing_rounds(source_booking_id) WHERE kind='replacement';
ALTER TABLE public.sourcing_rounds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sourcing_rounds FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.sourcing_rounds TO service_role;
ALTER TABLE public.quote_requests ADD COLUMN round_id uuid REFERENCES public.sourcing_rounds(id);
CREATE UNIQUE INDEX quote_requests_round_provider ON public.quote_requests(round_id,provider_id) WHERE round_id IS NOT NULL;
CREATE INDEX quote_requests_round_status ON public.quote_requests(round_id,status);

CREATE OR REPLACE FUNCTION public.validate_sourcing_round()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.mandates m WHERE m.id=NEW.mandate_id AND m.operation_id=NEW.operation_id)
    OR (NEW.source_booking_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.bookings b WHERE b.id=NEW.source_booking_id AND b.operation_id=NEW.operation_id))
    OR (NEW.source_round_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.sourcing_rounds r WHERE r.id=NEW.source_round_id AND r.operation_id=NEW.operation_id)) THEN
    RAISE EXCEPTION 'round scope mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.operation_id IS DISTINCT FROM OLD.operation_id
    OR NEW.mandate_id IS DISTINCT FROM OLD.mandate_id OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.source_booking_id IS DISTINCT FROM OLD.source_booking_id
    OR NEW.source_round_id IS DISTINCT FROM OLD.source_round_id
    OR (OLD.status<>'active' AND NEW.status IS DISTINCT FROM OLD.status)) THEN
    RAISE EXCEPTION 'round scope and terminal status are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER sourcing_rounds_validate BEFORE INSERT OR UPDATE ON public.sourcing_rounds
FOR EACH ROW EXECUTE FUNCTION public.validate_sourcing_round();

CREATE OR REPLACE FUNCTION public.validate_quote_request_round()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.round_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.sourcing_rounds r
    WHERE r.id=NEW.round_id AND r.operation_id=NEW.operation_id AND r.mandate_id=NEW.mandate_id) THEN
    RAISE EXCEPTION 'request round scope mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.round_id IS NOT NULL AND NEW.round_id IS DISTINCT FROM OLD.round_id THEN
    RAISE EXCEPTION 'request round is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER quote_requests_round_validate BEFORE INSERT OR UPDATE ON public.quote_requests
FOR EACH ROW EXECUTE FUNCTION public.validate_quote_request_round();

-- Historical attribution is deliberately conservative. One closed round per
-- request preserves repeated contacts without asserting they were one live round.
DO $$
DECLARE rq record; rid uuid;
BEGIN
  FOR rq IN SELECT q.* FROM public.quote_requests q JOIN public.mandates m
    ON m.id=q.mandate_id AND m.operation_id=q.operation_id WHERE q.round_id IS NULL
  LOOP
    INSERT INTO public.sourcing_rounds(operation_id,mandate_id,kind,status,created_at,closed_at,idempotency_key)
      VALUES(rq.operation_id,rq.mandate_id,'initial','superseded',rq.created_at,clock_timestamp(),
        'historical-request:'||rq.id) RETURNING id INTO rid;
    UPDATE public.quote_requests SET round_id=rid WHERE id=rq.id;
  END LOOP;
  -- Existing calls are not correlated by guessing the latest request.
END $$;

-- Old uncorrelated deliveries cannot be adopted as a new authenticated attempt.
-- Retiring them prevents old queue heads starving newly-created durable work.
UPDATE public.outbox ob SET status='processed',processed_at=clock_timestamp(),locked_until=NULL,
  payload=payload||jsonb_build_object('skipped_reason','historical_round_cutover')
  WHERE ob.job_type='contact_provider' AND ob.status IN ('pending','processing')
    AND NOT EXISTS (SELECT 1 FROM public.quote_requests qr JOIN public.sourcing_rounds r ON r.id=qr.round_id
      WHERE qr.id=ob.quote_request_id AND r.status='active');

-- Close superseded work, without editing historical quotes/bookings or making calls.
CREATE OR REPLACE FUNCTION public.close_stale_sourcing_rounds()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rid uuid;
BEGIN
  FOR rid IN SELECT id FROM public.sourcing_rounds WHERE operation_id=NEW.id AND status='active'
    AND (mandate_id IS DISTINCT FROM NEW.current_mandate_id OR NEW.mandate_confirmation_required
      OR NEW.status IN ('cancelled','failed')) FOR UPDATE
  LOOP
    UPDATE public.sourcing_rounds SET status='superseded',closed_at=clock_timestamp() WHERE id=rid;
    UPDATE public.quote_requests SET status='cancelled' WHERE round_id=rid
      AND status IN ('pending','queued','contacted','responded');
    UPDATE public.outbox SET status='processed',processed_at=clock_timestamp(),
      payload=payload||jsonb_build_object('skipped_reason','round_superseded'),locked_until=NULL
      WHERE quote_request_id IN (SELECT id FROM public.quote_requests WHERE round_id=rid)
        AND job_type='contact_provider' AND status IN ('pending','processing');
  END LOOP;
  RETURN NEW;
END; $$;
CREATE TRIGGER operations_close_stale_rounds AFTER UPDATE OF current_mandate_id,mandate_confirmation_required,status
ON public.operations FOR EACH ROW EXECUTE FUNCTION public.close_stale_sourcing_rounds();

CREATE OR REPLACE FUNCTION public.enqueue_mandate_sourcing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE op public.operations%ROWTYPE; rid uuid; prior uuid; candidate record; request_id uuid; n integer:=0;
BEGIN
  SELECT * INTO op FROM public.operations WHERE id=NEW.operation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT id INTO rid FROM public.sourcing_rounds WHERE idempotency_key='mandate-round:'||NEW.id;
  IF FOUND THEN RETURN NEW; END IF;
  SELECT id INTO prior FROM public.sourcing_rounds WHERE operation_id=op.id AND status='active' FOR UPDATE;
  IF prior IS NOT NULL THEN
    UPDATE public.sourcing_rounds SET status='superseded',closed_at=clock_timestamp() WHERE id=prior;
    UPDATE public.quote_requests SET status='cancelled' WHERE round_id=prior
      AND status IN ('pending','queued','contacted','responded');
    UPDATE public.outbox SET status='processed',processed_at=clock_timestamp(),locked_until=NULL,
      payload=payload||jsonb_build_object('skipped_reason','mandate_superseded')
      WHERE quote_request_id IN (SELECT id FROM public.quote_requests WHERE round_id=prior)
        AND job_type='contact_provider' AND status IN ('pending','processing');
  END IF;
  INSERT INTO public.sourcing_rounds(operation_id,mandate_id,kind,source_round_id,idempotency_key)
    VALUES(op.id,NEW.id,CASE WHEN NEW.supersedes_mandate_id IS NULL
      THEN 'initial'::public.sourcing_round_kind ELSE 'renegotiation'::public.sourcing_round_kind END,
      prior,'mandate-round:'||NEW.id) RETURNING id INTO rid;
  FOR candidate IN SELECT id FROM public.providers WHERE active ORDER BY random() LIMIT 2 LOOP
    INSERT INTO public.quote_requests(operation_id,provider_id,mandate_id,round_id,contact_attempt,status,expires_at,idempotency_key)
      VALUES(op.id,candidate.id,NEW.id,rid,1,'queued','infinity',
        'mandate:'||NEW.id||':provider:'||candidate.id) RETURNING id INTO request_id;
    INSERT INTO public.outbox(operation_id,quote_request_id,job_type,payload,idempotency_key)
      VALUES(op.id,request_id,'contact_provider',jsonb_build_object('purpose',
        CASE WHEN NEW.supersedes_mandate_id IS NULL THEN 'quote_request' ELSE 'renegotiation' END,
        'round_id',rid,'attempt',1),'contact-provider:'||request_id||':attempt:1');
    n:=n+1;
  END LOOP;
  INSERT INTO public.events(type,operation_id,call_id,payload) VALUES('sourcing.dispatch_queued',op.id,
    NEW.confirmed_in_call_id,jsonb_build_object('mandate_id',NEW.id,'round_id',rid,'provider_count',n));
  RETURN NEW;
END; $$;
-- Replace the existing trigger function; do not add a second mandate INSERT trigger.

CREATE OR REPLACE FUNCTION public.enqueue_replacement_sourcing(p_booking_id uuid,p_source_call_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b public.bookings%ROWTYPE; op public.operations%ROWTYPE; m public.mandates%ROWTYPE;
  rid uuid; prior uuid; losing_provider uuid; fresh_provider uuid; candidate uuid; req uuid;
  n integer:=0; excluded uuid[];
BEGIN
  SELECT * INTO b FROM public.bookings WHERE id=p_booking_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation_not_available' USING ERRCODE='P0001'; END IF;
  SELECT * INTO op FROM public.operations WHERE id=b.operation_id FOR UPDATE;
  SELECT id INTO rid FROM public.sourcing_rounds WHERE source_booking_id=b.id AND kind='replacement';
  IF FOUND THEN RETURN rid; END IF;
  IF op.current_booking_id IS NOT NULL OR op.status<>'sourcing'
    OR NOT EXISTS (SELECT 1 FROM public.events e JOIN public.calls c ON c.id=e.call_id
      WHERE e.type='booking.cancelled' AND e.call_id=p_source_call_id AND e.operation_id=op.id
        AND e.payload->>'booking_id'=b.id::text AND e.payload->>'source'='provider'
        AND c.direction='inbound' AND c.selected_booking_id=b.id AND c.provider_intent='cancel_booking') THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO m FROM public.mandates WHERE id=op.current_mandate_id AND operation_id=op.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_transition' USING ERRCODE='P0001'; END IF;
  SELECT qr.round_id INTO prior FROM public.quotes q JOIN public.quote_requests qr ON qr.id=q.quote_request_id
    WHERE q.id=b.quote_id;
  UPDATE public.sourcing_rounds SET status='superseded',closed_at=clock_timestamp()
    WHERE operation_id=op.id AND status='active';
  UPDATE public.quote_requests SET status='cancelled' WHERE operation_id=op.id
    AND round_id IN (SELECT id FROM public.sourcing_rounds WHERE operation_id=op.id AND status='superseded')
    AND status IN ('pending','queued','contacted','responded');
  UPDATE public.outbox SET status='processed',processed_at=clock_timestamp(),locked_until=NULL,
    payload=payload||jsonb_build_object('skipped_reason','booking_cancelled')
    WHERE operation_id=op.id AND job_type='contact_provider' AND status IN ('pending','processing');
  INSERT INTO public.sourcing_rounds(operation_id,mandate_id,kind,source_booking_id,source_round_id,idempotency_key)
    VALUES(op.id,m.id,'replacement',b.id,prior,'replacement:'||b.id) RETURNING id INTO rid;
  -- Explicit refusals and every historical cancelling carrier remain excluded,
  -- independently of immutable booking.status or adjudication-cancelled requests.
  SELECT coalesce(array_agg(DISTINCT provider_id),'{}'::uuid[]) INTO excluded FROM (
    SELECT qr.provider_id FROM public.quotes q JOIN public.quote_requests qr ON qr.id=q.quote_request_id WHERE q.id=b.quote_id
    UNION SELECT qr.provider_id FROM public.quote_requests qr WHERE qr.operation_id=op.id AND qr.provider_decline_reason IS NOT NULL
    UNION SELECT qr.provider_id FROM public.events e
      JOIN public.bookings oldb ON oldb.id::text=e.payload->>'booking_id'
      JOIN public.quotes oldq ON oldq.id=oldb.quote_id JOIN public.quote_requests qr ON qr.id=oldq.quote_request_id
      WHERE e.operation_id=op.id AND e.type='booking.cancelled' AND e.payload->>'source'='provider'
  ) excluded_providers;
  IF NOT op.mandate_confirmation_required AND (SELECT (w->>'start_at')::timestamptz
    FROM jsonb_array_elements(m.action_windows) w
    ORDER BY (w->>'start_at')::timestamptz,(w->>'end_at')::timestamptz LIMIT 1)>clock_timestamp() THEN
    SELECT qr.provider_id INTO losing_provider FROM public.quotes q
      JOIN public.quote_requests qr ON qr.id=q.quote_request_id JOIN public.providers p ON p.id=qr.provider_id AND p.active
      WHERE qr.operation_id=op.id AND NOT (qr.provider_id=ANY(excluded))
        AND NOT EXISTS (SELECT 1 FROM public.bookings awarded WHERE awarded.quote_id=q.id)
        AND q.status='received' AND NOT EXISTS (SELECT 1 FROM public.quotes successor WHERE successor.supersedes_quote_id=q.id)
      ORDER BY q.price_max,q.received_at,q.id LIMIT 1;
    SELECT p.id INTO fresh_provider FROM public.providers p WHERE p.active AND NOT(p.id=ANY(excluded))
      AND NOT EXISTS (SELECT 1 FROM public.quote_requests qr WHERE qr.operation_id=op.id AND qr.provider_id=p.id)
      ORDER BY random() LIMIT 1;
    FOREACH candidate IN ARRAY ARRAY[losing_provider,fresh_provider] LOOP
      IF candidate IS NULL THEN CONTINUE; END IF;
      INSERT INTO public.quote_requests(operation_id,provider_id,mandate_id,round_id,contact_attempt,status,expires_at,idempotency_key)
        VALUES(op.id,candidate,m.id,rid,1,'queued','infinity','replacement-request:'||rid||':'||candidate)
        RETURNING id INTO req;
      INSERT INTO public.outbox(operation_id,quote_request_id,job_type,payload,idempotency_key)
        VALUES(op.id,req,'contact_provider',jsonb_build_object('purpose','booking_replacement','round_id',rid,'attempt',1),
          'contact-provider:'||req||':attempt:1');
      n:=n+1;
    END LOOP;
  END IF;
  IF n=0 THEN
    UPDATE public.sourcing_rounds SET status='exhausted',closed_at=clock_timestamp() WHERE id=rid;
    UPDATE public.operations SET status='needs_follow_up' WHERE id=op.id;
  END IF;
  INSERT INTO public.events(type,operation_id,call_id,payload) VALUES('sourcing.started',op.id,p_source_call_id,
    jsonb_build_object('operation_reference',op.reference,'round_id',rid,'mandate_version',m.version,
      'provider_count',n,'reason','provider_cancelled','operation_status',
      CASE WHEN n=0 THEN 'needs_follow_up' ELSE 'sourcing' END));
  RETURN rid;
END; $$;

CREATE OR REPLACE FUNCTION public.enqueue_replacement_after_booking_cancel()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.type='booking.cancelled' AND NEW.payload->>'source'='provider' THEN
    PERFORM public.enqueue_replacement_sourcing((NEW.payload->>'booking_id')::uuid,NEW.call_id);
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER events_enqueue_replacement AFTER INSERT ON public.events
FOR EACH ROW EXECUTE FUNCTION public.enqueue_replacement_after_booking_cancel();

CREATE OR REPLACE FUNCTION public.prepare_sourcing_review(p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  op public.operations%ROWTYPE; m public.mandates%ROWTYPE; winning public.quotes%ROWTYPE;
  sr public.sourcing_rounds%ROWTYPE;
  dispatched timestamptz; still_open boolean; review_context jsonb; eligible_quotes jsonb;
BEGIN
  SELECT * INTO op FROM public.operations WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND OR op.status NOT IN ('sourcing', 'quotes_received') OR op.mandate_confirmation_required THEN
    RETURN jsonb_build_object('finalized', false);
  END IF;
  SELECT * INTO m FROM public.mandates WHERE id = op.current_mandate_id AND operation_id = op.id;
  IF NOT FOUND THEN RETURN jsonb_build_object('finalized', false); END IF;
  SELECT * INTO sr FROM public.sourcing_rounds WHERE operation_id=op.id AND mandate_id=m.id
    AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('finalized',false,'reason','no_active_round'); END IF;
  dispatched := sr.first_dispatched_at;
  IF dispatched IS NULL THEN RETURN jsonb_build_object('finalized', false, 'reason', 'awaiting_dispatch'); END IF;

  -- A counteroffer is a response but not a finished negotiation. Do not select
  -- early just because all requests have status=responded.
  SELECT EXISTS (SELECT 1 FROM public.quote_requests qr
    LEFT JOIN LATERAL (SELECT q.* FROM public.quotes q WHERE q.quote_request_id = qr.id ORDER BY version DESC LIMIT 1) latest ON true
    WHERE qr.round_id = sr.id AND qr.operation_id = op.id AND qr.mandate_id = m.id
      AND qr.status IN ('pending', 'queued', 'contacted', 'responded')
      AND (latest.id IS NULL OR latest.verdict = 'contraoferta')) INTO still_open;
  IF still_open AND clock_timestamp() < dispatched + interval '5 minutes' THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'comparing_proposals');
  END IF;

  SELECT q.* INTO winning FROM public.quotes q
    JOIN public.quote_requests qr ON qr.id = q.quote_request_id
    JOIN public.providers p ON p.id = qr.provider_id
    WHERE qr.round_id = sr.id AND qr.operation_id = op.id AND qr.mandate_id = m.id AND qr.status = 'responded' AND p.active
      AND q.verdict = 'dentro' AND q.status = 'received' AND q.evaluated_mandate_id = m.id
      AND (q.valid_until IS NULL OR q.valid_until > clock_timestamp()) AND q.currency = m.currency
      AND (op.container_type IS NULL OR coalesce(p.capabilities->'equipment', '[]'::jsonb) ? op.container_type)
      AND q.price_max <= m.price_cap AND (q.payment_term_days >= m.minimum_payment_term_days OR (q.payment_term_days IS NULL AND m.minimum_payment_term_days = 0))
      AND (q.proposed_pickup_window->>'start_at')::timestamptz > clock_timestamp()
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.action_windows) w
        WHERE (q.proposed_pickup_window->>'start_at')::timestamptz >= (w->>'start_at')::timestamptz
          AND (q.proposed_pickup_window->>'end_at')::timestamptz <= (w->>'end_at')::timestamptz)
      AND (q.conditions IS NULL OR q.conditions = '{}'::jsonb OR (jsonb_typeof(q.conditions->'notes') = 'array'
        AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(q.conditions) k WHERE k <> 'notes')
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(q.conditions->'notes') = 'array' THEN q.conditions->'notes' ELSE '[]'::jsonb END) note
          WHERE NOT (note = ANY(op.operational_constraints)) AND note IS DISTINCT FROM op.cargo_notes)))
      AND NOT EXISTS (SELECT 1 FROM public.quotes successor WHERE successor.supersedes_quote_id = q.id)
    ORDER BY CASE WHEN q.received_at > dispatched + interval '5 minutes' THEN q.received_at ELSE dispatched END ASC,
      q.price_max ASC, q.received_at ASC, q.id ASC LIMIT 1;
  IF NOT FOUND THEN
    -- The five-minute comparison deadline does not expire outstanding requests.
    RETURN jsonb_build_object('finalized', false, 'reason', 'waiting_for_valid_quote');
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.price_max, q.received_at, q.id), '[]'::jsonb) INTO eligible_quotes FROM public.quotes q
    JOIN public.quote_requests qr ON qr.id = q.quote_request_id
    JOIN public.providers p ON p.id = qr.provider_id
    WHERE qr.round_id = sr.id AND qr.operation_id = op.id AND qr.mandate_id = m.id AND qr.status = 'responded' AND p.active
      AND q.verdict = 'dentro' AND q.status = 'received' AND q.evaluated_mandate_id = m.id
      AND (q.valid_until IS NULL OR q.valid_until > clock_timestamp()) AND q.currency = m.currency
      AND (op.container_type IS NULL OR coalesce(p.capabilities->'equipment', '[]'::jsonb) ? op.container_type)
      AND q.price_max <= m.price_cap AND (q.payment_term_days >= m.minimum_payment_term_days OR (q.payment_term_days IS NULL AND m.minimum_payment_term_days = 0))
      AND (q.proposed_pickup_window->>'start_at')::timestamptz > clock_timestamp()
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.action_windows) w
        WHERE (q.proposed_pickup_window->>'start_at')::timestamptz >= (w->>'start_at')::timestamptz
          AND (q.proposed_pickup_window->>'end_at')::timestamptz <= (w->>'end_at')::timestamptz)
      AND (q.conditions IS NULL OR q.conditions = '{}'::jsonb OR (jsonb_typeof(q.conditions->'notes') = 'array'
        AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(q.conditions) k WHERE k <> 'notes')
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(q.conditions->'notes') = 'array' THEN q.conditions->'notes' ELSE '[]'::jsonb END) note
          WHERE NOT (note = ANY(op.operational_constraints)) AND note IS DISTINCT FROM op.cargo_notes)))
      AND NOT EXISTS (SELECT 1 FROM public.quotes successor WHERE successor.supersedes_quote_id = q.id)
;
  review_context := jsonb_build_object(
    'policy_version', 'price-only-minimal-v2',
    'round_id', sr.id, 'operation_id', op.id, 'operation_revision', op.updated_at,
    'operation', public.provider_quote_operation(op),
    'mandate', jsonb_build_object('id', m.id, 'price_cap', m.price_cap,
      'currency', m.currency, 'action_windows', m.action_windows,
      'minimum_payment_term_days', m.minimum_payment_term_days),
    'selected_quote', to_jsonb(winning), 'eligible_quotes', eligible_quotes,
    'selection_rule', CASE WHEN winning.received_at > dispatched + interval '5 minutes'
      THEN 'first_valid_after_deadline' ELSE 'lowest_valid_price_max' END,
    'comparison_deadline', dispatched + interval '5 minutes');
  RETURN jsonb_build_object('ready', true, 'input_hash', md5(review_context::text),
    'context', review_context);
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_operation_sourcing(p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  op public.operations%ROWTYPE; m public.mandates%ROWTYPE; winning public.quotes%ROWTYPE;
  source_call uuid; booking_id uuid; dispatched timestamptz; active_round_id uuid;
  prepared jsonb; reviewed public.sourcing_judge_reviews%ROWTYPE;
BEGIN
  -- Recompute eligibility, ordering and expiry at commit time, under the operation lock.
  prepared := public.prepare_sourcing_review(p_operation_id);
  IF prepared->>'ready' IS DISTINCT FROM 'true' THEN RETURN prepared; END IF;
  SELECT * INTO reviewed FROM public.sourcing_judge_reviews
    WHERE operation_id = p_operation_id AND input_hash = prepared->>'input_hash'
      AND input_context = prepared->'context';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'awaiting_judge_review');
  END IF;
  -- The user chose automatic selection: historical review warnings do not veto
  -- an eligible current candidate. SQL still owns all hard limits and ranking.
  SELECT * INTO op FROM public.operations WHERE id = p_operation_id;
  active_round_id := (prepared->'context'->>'round_id')::uuid;
  SELECT * INTO m FROM public.mandates WHERE id = op.current_mandate_id;
  SELECT * INTO winning FROM public.quotes WHERE id = reviewed.quote_id;
  dispatched := (prepared->'context'->>'comparison_deadline')::timestamptz - interval '5 minutes';
  SELECT e.call_id INTO source_call FROM public.events e
    WHERE e.type = 'quote.received' AND e.operation_id = op.id AND e.payload->>'quote_id' = winning.id::text
    ORDER BY e.occurred_at DESC LIMIT 1;
  UPDATE public.operations SET status = 'quotes_received' WHERE id = op.id AND status = 'sourcing';
  UPDATE public.operations SET status = 'quote_selected' WHERE id = op.id;
  UPDATE public.operations SET status = 'booking_pending' WHERE id = op.id;
  -- Existing booking-confirmation trigger queues one email per recipient.
  INSERT INTO public.bookings (operation_id, quote_id, status, pickup_window_start, pickup_window_end,
    payment_term_days, confirmed_price, confirmation_reference, confirmed_at, source_call_id)
  VALUES (op.id, winning.id, 'confirmed',
    (winning.proposed_pickup_window->>'start_at')::timestamptz, (winning.proposed_pickup_window->>'end_at')::timestamptz,
    winning.payment_term_days, winning.price_max,
    'TANGO-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)), clock_timestamp(), source_call)
  RETURNING id INTO booking_id;
  UPDATE public.operations SET status = 'booking_confirmed', current_booking_id = booking_id WHERE id = op.id;
  UPDATE public.quote_requests SET status = 'cancelled'
    WHERE quote_requests.round_id = active_round_id AND id <> winning.quote_request_id
      AND status IN ('pending', 'queued', 'contacted', 'responded');
  UPDATE public.outbox SET status = 'processed', processed_at = clock_timestamp(),
    payload = payload || jsonb_build_object('skipped_reason', 'booking_selected')
    WHERE quote_request_id IN (SELECT id FROM public.quote_requests WHERE quote_requests.round_id = active_round_id)
      AND job_type = 'contact_provider' AND status IN ('pending','processing');
  UPDATE public.sourcing_rounds SET status='selected',closed_at=clock_timestamp() WHERE id=active_round_id;
  -- No fabricated transcript_excerpt/checkpoint. Quote/event provenance is real;
  -- absent transcript evidence is left null.
  INSERT INTO public.events (type, operation_id, call_id, payload) VALUES
    ('quote.selected', op.id, source_call, jsonb_build_object('quote_id', winning.id, 'round_id', active_round_id,
      'price_max', winning.price_max, 'currency', winning.currency, 'judge_review_id', reviewed.id, 'selection_rule',
      CASE WHEN winning.received_at > dispatched + interval '5 minutes'
        THEN 'first_valid_after_deadline' ELSE 'lowest_valid_price_max' END)),
    ('booking.confirmed', op.id, source_call, jsonb_build_object('booking_id', booking_id, 'quote_id', winning.id,
      'confirmed_price', winning.price_max, 'currency', winning.currency, 'pickup_window', winning.proposed_pickup_window,
      'payment_term_days', winning.payment_term_days, 'commitment_created', false));
  RETURN jsonb_build_object('finalized', true, 'selected', true, 'round_id', active_round_id, 'judge_review_id', reviewed.id, 'booking_id', booking_id, 'quote_id', winning.id);
END;
$$;
-- The existing record_sourcing_review recomputes prepare_sourcing_review under
-- the operation lock, so round_id in the context/hash invalidates stale reviews.
REVOKE ALL ON FUNCTION public.enqueue_replacement_sourcing(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.prepare_sourcing_review(uuid),public.finalize_operation_sourcing(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_sourcing_review(uuid),public.finalize_operation_sourcing(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.get_provider_tool_state(p_call_id uuid,p_realtime_call_id text,p_provider_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $
DECLARE c public.calls%ROWTYPE; op public.operations%ROWTYPE; qr public.quote_requests%ROWTYPE;
  sr public.sourcing_rounds%ROWTYPE; m public.mandates%ROWTYPE; q public.quotes%ROWTYPE;
  last_offer jsonb; result_profile text; authorized boolean;
BEGIN
  SELECT * INTO c FROM public.calls WHERE id=p_call_id AND realtime_call_id=p_realtime_call_id
    AND provider_id=p_provider_id AND persona='provider' AND outcome='active';
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.providers WHERE id=p_provider_id AND active) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE='P0001';
  END IF;
  IF c.direction='inbound' THEN RETURN public.get_provider_inbound_tool_state(p_call_id,p_realtime_call_id,p_provider_id); END IF;
  IF c.direction<>'outbound' OR c.purpose IS NULL OR c.purpose NOT IN ('quote_request','renegotiation','booking_replacement')
    OR c.operation_id IS NULL OR c.quote_request_id IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO op FROM public.operations WHERE id=c.operation_id;
  SELECT * INTO qr FROM public.quote_requests WHERE id=c.quote_request_id AND operation_id=op.id AND provider_id=p_provider_id;
  SELECT * INTO sr FROM public.sourcing_rounds WHERE id=qr.round_id AND operation_id=op.id;
  SELECT * INTO m FROM public.mandates WHERE id=op.current_mandate_id AND operation_id=op.id;
  SELECT * INTO q FROM public.quotes WHERE quote_request_id=qr.id ORDER BY version DESC LIMIT 1;
  SELECT jsonb_build_object('price_range',e.payload->'price_range') INTO last_offer FROM public.events e
    WHERE e.type='quote.offered' AND e.call_id=c.id AND e.payload->>'quote_request_id'=qr.id::text
    ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1;
  authorized:=coalesce(qr.id IS NOT NULL AND sr.id IS NOT NULL AND m.id IS NOT NULL
    AND qr.mandate_id=m.id AND sr.mandate_id=m.id AND sr.status='active'
    AND op.status IN ('sourcing','quotes_received') AND NOT op.mandate_confirmation_required
    AND qr.status IN ('pending','queued','contacted','responded') AND qr.expires_at>clock_timestamp()
    AND c.purpose=CASE sr.kind WHEN 'initial' THEN 'quote_request'
      WHEN 'renegotiation' THEN 'renegotiation' ELSE 'booking_replacement' END,false);
  result_profile:=CASE WHEN c.provider_tools_completed_at IS NOT NULL THEN 'terminal'
    WHEN authorized THEN 'provider_quote' ELSE 'provider_unavailable' END;
  RETURN jsonb_build_object('flow','provider_outbound','profile',result_profile,'intent','quote',
    'operation',CASE WHEN qr.id IS NOT NULL THEN public.provider_quote_operation(op) ELSE NULL END,
    'commandTarget',CASE WHEN authorized AND result_profile='provider_quote' THEN jsonb_build_object(
      'operation_revision',op.updated_at::text,'quote_request_id',qr.id,'mandate_id',m.id,'round_id',sr.id,'previous_quote_id',q.id) ELSE NULL END,
    'privatePriceLimit',CASE WHEN authorized AND result_profile='provider_quote' THEN jsonb_build_object('price_cap',m.price_cap,'currency',m.currency) ELSE NULL END,
    'lastQuote',CASE WHEN q.id IS NULL THEN NULL ELSE jsonb_build_object('quote_version',q.version,
      'verdict',q.verdict,'price_range',jsonb_build_object('min',q.price_min,'max',q.price_max,'currency',q.currency),
      'negotiation_rounds_remaining',greatest(0,qr.negotiation_limit-(SELECT count(*) FROM public.quotes z
        WHERE z.quote_request_id=qr.id AND z.verdict='contraoferta')),
      'fixed_terms',jsonb_build_object('proposed_pickup_window',q.proposed_pickup_window,'payment_term_days',q.payment_term_days,
        'valid_until',q.valid_until,'conditions',q.conditions)) END,'lastOffer',last_offer);
END; $;

CREATE OR REPLACE FUNCTION public.record_provider_offer(
  p_call_id uuid,p_realtime_call_id text,p_provider_id uuid,p_tool_call_id text,p_arguments jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $
DECLARE c public.calls%ROWTYPE; op public.operations%ROWTYPE; sr public.sourcing_rounds%ROWTYPE;
  qr public.quote_requests%ROWTYPE; m public.mandates%ROWTYPE; receipt public.tool_command_receipts%ROWTYPE;
  result jsonb; price jsonb; currency_value text; operation_id_value uuid;
BEGIN
  IF p_tool_call_id IS NULL OR btrim(p_tool_call_id)='' OR p_arguments IS NULL
    OR jsonb_typeof(p_arguments) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE='P0001';
  END IF;
  SELECT operation_id INTO operation_id_value FROM public.calls WHERE id=p_call_id
    AND realtime_call_id=p_realtime_call_id AND provider_id=p_provider_id;
  SELECT * INTO op FROM public.operations WHERE id=operation_id_value FOR UPDATE;
  SELECT * INTO c FROM public.calls WHERE id=p_call_id AND realtime_call_id=p_realtime_call_id
    AND provider_id=p_provider_id AND persona='provider' AND direction='outbound'
    AND purpose IN ('quote_request','renegotiation','booking_replacement') AND outcome='active'
    AND operation_id IS NOT NULL AND quote_request_id IS NOT NULL FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.providers WHERE id=p_provider_id AND active) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO receipt FROM public.tool_command_receipts WHERE call_id=c.id AND tool_call_id=p_tool_call_id;
  IF FOUND THEN
    IF receipt.tool_name IS DISTINCT FROM 'record_provider_offer' OR receipt.arguments IS DISTINCT FROM p_arguments THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';
    END IF;
    RETURN receipt.result;
  END IF;
  IF c.provider_tools_completed_at IS NOT NULL OR c.provider_intent<>'quote' THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO sr FROM public.sourcing_rounds WHERE id=(SELECT round_id FROM public.quote_requests
    WHERE id=c.quote_request_id) FOR UPDATE;
  SELECT * INTO qr FROM public.quote_requests WHERE id=c.quote_request_id FOR UPDATE;
  SELECT * INTO m FROM public.mandates WHERE id=op.current_mandate_id AND operation_id=op.id;
  IF m.id IS NULL OR qr.id IS NULL OR sr.id IS NULL OR op.id IS DISTINCT FROM c.operation_id
    OR qr.operation_id<>op.id OR qr.provider_id<>p_provider_id OR qr.mandate_id IS DISTINCT FROM m.id
    OR sr.operation_id<>op.id OR sr.mandate_id<>m.id OR sr.status<>'active'
    OR op.status NOT IN ('sourcing','quotes_received') OR op.mandate_confirmation_required
    OR qr.status NOT IN ('pending','queued','contacted','responded') OR qr.expires_at<=clock_timestamp()
    OR c.purpose IS DISTINCT FROM CASE sr.kind WHEN 'initial' THEN 'quote_request'
      WHEN 'renegotiation' THEN 'renegotiation' ELSE 'booking_replacement' END THEN
    RAISE EXCEPTION 'operation_not_available' USING ERRCODE='P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_arguments) k WHERE k NOT IN ('price_range','currency'))
    OR jsonb_typeof(p_arguments->'price_range') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE='P0001';
  END IF;
  price:=p_arguments->'price_range';
  IF (SELECT count(*) FROM jsonb_object_keys(price))<>2
    OR jsonb_typeof(price->'min') IS DISTINCT FROM 'number' OR jsonb_typeof(price->'max') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE='P0001';
  END IF;
  IF (price->>'min')::numeric<=0 OR (price->>'max')::numeric<(price->>'min')::numeric
    OR (price->>'max')::numeric>999999999999.99
    OR round((price->>'min')::numeric,2)<>(price->>'min')::numeric
    OR round((price->>'max')::numeric,2)<>(price->>'max')::numeric THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE='P0001';
  END IF;
  IF p_arguments ? 'currency' THEN
    IF jsonb_typeof(p_arguments->'currency') IS DISTINCT FROM 'string'
      OR btrim(p_arguments->>'currency')='' THEN RAISE EXCEPTION 'invalid_arguments' USING ERRCODE='P0001'; END IF;
    currency_value:=p_arguments->>'currency';
  ELSE currency_value:=m.currency;
  END IF;
  price:=price||jsonb_build_object('currency',currency_value);
  INSERT INTO public.events(type,operation_id,call_id,payload) VALUES('quote.offered',op.id,c.id,
    jsonb_build_object('provider_id',p_provider_id,'quote_request_id',qr.id,'round_id',sr.id,
      'price_range',price,'range_status',CASE WHEN currency_value<>m.currency THEN 'unassessed'
        WHEN (price->>'max')::numeric<=m.price_cap THEN 'within' ELSE 'outside' END,
      'speaker','provider','approval','not_requested_by_this_event'));
  result:=jsonb_build_object('status','recorded');
  INSERT INTO public.tool_command_receipts(call_id,tool_call_id,tool_name,arguments,result)
    VALUES(c.id,p_tool_call_id,'record_provider_offer',p_arguments,result);
  RETURN result;
END; $;

CREATE OR REPLACE FUNCTION public.execute_provider_quote_tool(
  p_call_id uuid, p_realtime_call_id text, p_provider_id uuid,
  p_tool_call_id text, p_tool_name text, p_arguments jsonb, p_context jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $
DECLARE
  c public.calls%ROWTYPE;
  op public.operations%ROWTYPE;
  qr public.quote_requests%ROWTYPE;
  mandate public.mandates%ROWTYPE;
  previous_quote public.quotes%ROWTYPE;
  new_quote public.quotes%ROWTYPE;
  receipt public.tool_command_receipts%ROWTYPE;
  result jsonb;
  sr public.sourcing_rounds%ROWTYPE;
  scope_operation_id uuid;
  offer_event_id uuid;
  price jsonb;
  proposed jsonb;
  item jsonb;
  start_time timestamptz;
  end_time timestamptz;
  expires timestamptz;
  command_time timestamptz;
  verdict public.quote_verdict;
  reason_codes text[];
  linked boolean := false;
  counteroffers_used integer;
  payment_days integer;
  quote_conditions jsonb;
BEGIN
  IF p_tool_name IS NULL OR p_tool_name NOT IN ('create_quote', 'decline_quote_request')
    OR p_tool_call_id IS NULL OR btrim(p_tool_call_id) = ''
    OR p_arguments IS NULL OR jsonb_typeof(p_arguments) <> 'object' THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
  END IF;
  SELECT operation_id INTO scope_operation_id FROM public.calls WHERE id=p_call_id
    AND realtime_call_id=p_realtime_call_id AND provider_id=p_provider_id AND persona='provider'
    AND direction='outbound' AND purpose IN ('quote_request','renegotiation','booking_replacement');
  IF scope_operation_id IS NOT NULL THEN
    SELECT * INTO op FROM public.operations WHERE id=scope_operation_id FOR UPDATE;
  END IF;
  SELECT * INTO c FROM public.calls WHERE id = p_call_id AND realtime_call_id = p_realtime_call_id
    AND provider_id = p_provider_id AND persona = 'provider' AND outcome = 'active'
    AND direction='outbound' AND purpose IN ('quote_request','renegotiation','booking_replacement')
    AND operation_id IS NOT NULL AND quote_request_id IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM public.providers WHERE id = p_provider_id AND active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO receipt FROM public.tool_command_receipts WHERE call_id = c.id AND tool_call_id = p_tool_call_id;
  IF FOUND THEN
    IF receipt.tool_name <> p_tool_name OR receipt.arguments <> p_arguments THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN receipt.result;
  END IF;
  IF c.provider_tools_completed_at IS NOT NULL THEN RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001'; END IF;
  IF c.provider_intent NOT IN ('undecided', 'quote') THEN RAISE EXCEPTION 'intent_locked' USING ERRCODE = 'P0001'; END IF;
  IF p_arguments ? 'operation_reference' AND (jsonb_typeof(p_arguments->'operation_reference') <> 'string'
    OR p_arguments->>'operation_reference' !~ '^OP-[0-9]{6,}
NOTIFY pgrst,'reload schema';
COMMIT;
) THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
  END IF;
  IF c.operation_id IS NULL AND NOT p_arguments ? 'operation_reference' THEN
    RAISE EXCEPTION 'operation_reference_required' USING ERRCODE = 'P0001';
  END IF;
  IF op.id IS DISTINCT FROM c.operation_id THEN RAISE EXCEPTION 'operation_not_available' USING ERRCODE='P0001'; END IF;
  IF p_arguments ? 'operation_reference' AND p_arguments->>'operation_reference' <> op.reference THEN
    RAISE EXCEPTION 'intent_locked' USING ERRCODE = 'P0001';
  END IF;
  IF op.status NOT IN ('sourcing', 'quotes_received') OR op.mandate_confirmation_required OR op.current_mandate_id IS NULL THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001';
  END IF;
  -- Context comes from the server state used by this call, never model args.
  IF p_context->>'operation_revision' IS DISTINCT FROM op.updated_at::text
    OR p_context->>'mandate_id' IS DISTINCT FROM op.current_mandate_id::text THEN
    RAISE EXCEPTION 'stale_operation' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO sr FROM public.sourcing_rounds WHERE id=(
    SELECT round_id FROM public.quote_requests WHERE id=c.quote_request_id) FOR UPDATE;
  IF NOT FOUND OR sr.status<>'active' OR sr.operation_id<>op.id OR sr.mandate_id<>op.current_mandate_id
    OR c.purpose IS DISTINCT FROM CASE sr.kind WHEN 'initial' THEN 'quote_request'
      WHEN 'renegotiation' THEN 'renegotiation' ELSE 'booking_replacement' END THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE='P0001';
  END IF;
  IF p_context->>'round_id' IS DISTINCT FROM sr.id::text
    OR p_context->>'quote_request_id' IS DISTINCT FROM c.quote_request_id::text THEN
    RAISE EXCEPTION 'stale_operation' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO qr FROM public.quote_requests WHERE id=c.quote_request_id AND round_id=sr.id
    AND operation_id = op.id AND provider_id = p_provider_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation_not_available' USING ERRCODE = 'P0001'; END IF;
  IF qr.mandate_id IS DISTINCT FROM op.current_mandate_id OR qr.expires_at <= clock_timestamp()
    OR qr.status NOT IN ('pending', 'queued', 'contacted', 'responded') THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO previous_quote FROM public.quotes WHERE quote_request_id = qr.id ORDER BY version DESC LIMIT 1;
  IF previous_quote.id::text IS DISTINCT FROM p_context->>'previous_quote_id' THEN
    RAISE EXCEPTION 'stale_operation' USING ERRCODE = 'P0001';
  END IF;
  IF (previous_quote.id IS NOT NULL AND (previous_quote.verdict <> 'contraoferta' OR previous_quote.status <> 'received'
      OR previous_quote.evaluated_mandate_id <> op.current_mandate_id))
    OR (previous_quote.id IS NULL AND qr.status = 'responded') THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO mandate FROM public.mandates WHERE id = op.current_mandate_id AND operation_id = op.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001'; END IF;

  IF p_tool_name = 'decline_quote_request' THEN
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_arguments) k WHERE k NOT IN ('operation_reference', 'reason', 'details'))
      OR NOT p_arguments ? 'reason' OR jsonb_typeof(p_arguments->'reason') <> 'string'
      OR p_arguments->>'reason' NOT IN ('no_capacity', 'unavailable_window', 'price_terms', 'route_unsupported', 'operational_constraints', 'other')
      OR (p_arguments ? 'details' AND (jsonb_typeof(p_arguments->'details') <> 'string' OR btrim(p_arguments->>'details') = '')) THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    -- Only the numeric price is model-supplied. Fixed context is server-owned.
    IF NOT p_arguments ? 'price_range'
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_arguments) k WHERE k NOT IN ('operation_reference', 'price_range'))
      OR jsonb_typeof(p_arguments->'price_range') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
    END IF;
    price := p_arguments->'price_range';
    IF NOT price ?& ARRAY['min', 'max'] OR (SELECT count(*) FROM jsonb_object_keys(price)) <> 2
      OR jsonb_typeof(price->'min') IS DISTINCT FROM 'number'
      OR jsonb_typeof(price->'max') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
    END IF;
    IF (price->>'min')::numeric <= 0 OR (price->>'max')::numeric < (price->>'min')::numeric
      OR (price->>'max')::numeric > 999999999999.99
      OR round((price->>'min')::numeric, 2) <> (price->>'min')::numeric
      OR round((price->>'max')::numeric, 2) <> (price->>'max')::numeric THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
    END IF;
    price := price || jsonb_build_object('currency', mandate.currency);
    IF previous_quote.id IS NOT NULL THEN
      proposed := previous_quote.proposed_pickup_window;
      payment_days := previous_quote.payment_term_days;
      expires := previous_quote.valid_until;
      quote_conditions := previous_quote.conditions;
    ELSE
      -- Pick the earliest complete window already authorized by the client.
      -- Never substitute another window mid-negotiation or invent payment/expiry.
      SELECT w INTO proposed FROM jsonb_array_elements(mandate.action_windows) w
        ORDER BY (w->>'start_at')::timestamptz, (w->>'end_at')::timestamptz LIMIT 1;
      payment_days := nullif(mandate.minimum_payment_term_days, 0);
      expires := NULL;
      quote_conditions := NULL;
    END IF;
    start_time := (proposed->>'start_at')::timestamptz;
    end_time := (proposed->>'end_at')::timestamptz;
    IF proposed IS NULL OR start_time <= clock_timestamp() OR start_time >= end_time
      OR (expires IS NOT NULL AND expires <= clock_timestamp()) THEN
      RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  command_time := clock_timestamp();
  IF qr.expires_at <= command_time THEN RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001'; END IF;
  IF c.operation_id IS NULL THEN
    UPDATE public.calls SET operation_id = op.id, provider_intent = 'quote' WHERE id = c.id RETURNING * INTO c;
    linked := true;
  END IF;
  IF p_tool_name = 'decline_quote_request' THEN
    UPDATE public.quote_requests SET status = 'cancelled', provider_decline_reason = p_arguments->>'reason',
      provider_declined_at = command_time WHERE id = qr.id;
    INSERT INTO public.events (type, operation_id, call_id, occurred_at, payload) VALUES (
      'quote.declined', op.id, c.id, command_time,
      jsonb_build_object('quote_request_id', qr.id, 'reason', p_arguments->>'reason')
        || CASE WHEN p_arguments ? 'details' THEN jsonb_build_object('details', p_arguments->>'details') ELSE '{}'::jsonb END);
    result := jsonb_build_object('status', 'declined', 'commitment_created', false);
  ELSE
    IF expires IS NOT NULL AND expires <= command_time THEN RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001'; END IF;
    SELECT count(*) INTO counteroffers_used FROM public.quotes prior
    WHERE prior.quote_request_id = qr.id AND prior.verdict = 'contraoferta';
    verdict := CASE WHEN (price->>'max')::numeric <= mandate.price_cap THEN 'dentro'::quote_verdict
      WHEN counteroffers_used < qr.negotiation_limit THEN 'contraoferta'::quote_verdict ELSE 'fuera'::quote_verdict END;
    reason_codes := CASE WHEN verdict = 'dentro' THEN ARRAY[]::text[] ELSE ARRAY['price_outside_terms'] END;
    -- Link the latest matching observation from this request/call; a different
    -- price/currency must create its own observation, in the same transaction.
    SELECT e.id INTO offer_event_id FROM public.events e WHERE e.call_id=c.id
      AND e.type='quote.offered' AND e.payload->>'quote_request_id'=qr.id::text
      AND e.payload->>'round_id'=sr.id::text AND e.payload->'price_range'=price
      ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1;
    IF offer_event_id IS NULL THEN
      offer_event_id:=gen_random_uuid();
      INSERT INTO public.events(id,type,operation_id,call_id,occurred_at,payload)
        VALUES(offer_event_id,'quote.offered',op.id,c.id,command_time,
          jsonb_build_object('provider_id',p_provider_id,'quote_request_id',qr.id,'round_id',sr.id,
            'price_range',price,'range_status',CASE WHEN (price->>'max')::numeric<=mandate.price_cap
              THEN 'within' ELSE 'outside' END,'speaker','provider','approval','not_requested_by_this_event'));
    END IF;
    INSERT INTO public.quotes (quote_request_id, evaluated_mandate_id, version, supersedes_quote_id,
      price_min, price_max, currency, proposed_pickup_window, payment_term_days, valid_until, conditions, verdict, received_at)
    VALUES (qr.id, mandate.id, coalesce(previous_quote.version, 0) + 1, previous_quote.id,
      (price->>'min')::numeric, (price->>'max')::numeric, price->>'currency', proposed,
      payment_days, expires, quote_conditions, verdict, command_time)
    RETURNING * INTO new_quote;
    UPDATE public.quote_requests SET status = 'responded' WHERE id = qr.id;
    IF verdict = 'dentro' AND op.status = 'sourcing' THEN
      UPDATE public.operations SET status = 'quotes_received' WHERE id = op.id;
    END IF;
    result := jsonb_build_object('operation_reference', op.reference, 'quote_version', new_quote.version,
      'verdict', verdict, 'reason_codes', reason_codes, 'negotiation_remaining', verdict = 'contraoferta',
      'negotiation_rounds_remaining', CASE WHEN verdict = 'contraoferta' THEN qr.negotiation_limit - counteroffers_used ELSE 0 END);
    INSERT INTO public.events (type, operation_id, call_id, occurred_at, schema_version, payload) VALUES (
      'quote.received', op.id, c.id, command_time, 2, result || jsonb_build_object('quote_id', new_quote.id,
        'round_id',sr.id,'offer_event_id',offer_event_id,
        'quote_request_id', qr.id, 'price_range', price, 'proposed_pickup_window', proposed,
        'payment_term_days', new_quote.payment_term_days, 'valid_until', expires));
    IF verdict = 'contraoferta' THEN
      INSERT INTO public.events (type, operation_id, call_id, occurred_at, payload) VALUES (
        'quote.counteroffer_requested', op.id, c.id, command_time, jsonb_build_object(
          'quote_id', new_quote.id, 'quote_version', new_quote.version, 'reason_codes', reason_codes,
          'negotiation_remaining', true, 'negotiation_rounds_remaining', qr.negotiation_limit - counteroffers_used));
    END IF;
  END IF;
  IF p_tool_name = 'decline_quote_request' OR verdict IN ('dentro', 'fuera') THEN
    UPDATE public.calls SET provider_tools_completed_at = command_time WHERE id = c.id;
  END IF;
  IF linked THEN
    INSERT INTO public.events (type, operation_id, call_id, occurred_at, payload) VALUES (
      'call.routed', op.id, c.id, command_time, jsonb_build_object('direction', c.direction,
        'persona', c.persona, 'intent', c.provider_intent, 'counterparty_type', 'provider',
        'candidate_operation_references', jsonb_build_array(op.reference)));
  END IF;
  INSERT INTO public.tool_command_receipts (call_id, tool_call_id, tool_name, arguments, result)
  VALUES (c.id, p_tool_call_id, p_tool_name, p_arguments, result);
  RETURN result;
END;
$;
REVOKE ALL ON FUNCTION public.get_provider_tool_state(uuid,text,uuid),
 public.record_provider_offer(uuid,text,uuid,text,jsonb),
 public.execute_provider_quote_tool(uuid,text,uuid,text,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_provider_tool_state(uuid,text,uuid),
 public.record_provider_offer(uuid,text,uuid,text,jsonb),
 public.execute_provider_quote_tool(uuid,text,uuid,text,text,jsonb,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.get_provider_quote_tool_state(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.validate_booking_award_round()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  -- An approved window-only successor keeps its historical quote; it is not
  -- a sourcing award and must not require that historical round to be active.
  IF NEW.last_change_request_id IS NOT NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.quotes q JOIN public.quote_requests qr ON qr.id=q.quote_request_id
    JOIN public.sourcing_rounds r ON r.id=qr.round_id JOIN public.operations o ON o.id=r.operation_id
    WHERE q.id=NEW.quote_id AND o.id=NEW.operation_id AND r.status='active'
      AND r.mandate_id=o.current_mandate_id AND qr.mandate_id=r.mandate_id AND qr.status='responded') THEN
    RAISE EXCEPTION 'booking award requires the current sourcing round' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bookings_validate_award_round BEFORE INSERT ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.validate_booking_award_round();

CREATE OR REPLACE FUNCTION public.validate_provider_escalation_round()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE c public.calls%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.calls WHERE id=NEW.source_call_id;
  IF c.persona='provider' AND c.direction='outbound' AND NOT EXISTS (
    SELECT 1 FROM public.quote_requests qr JOIN public.sourcing_rounds r ON r.id=qr.round_id
    JOIN public.operations o ON o.id=r.operation_id WHERE qr.id=c.quote_request_id
      AND qr.provider_id=c.provider_id AND o.id=c.operation_id AND o.id=NEW.operation_id
      AND r.status='active' AND r.mandate_id=o.current_mandate_id AND qr.mandate_id=r.mandate_id
      AND NOT o.mandate_confirmation_required AND o.status IN ('sourcing','quotes_received')
      AND c.purpose=CASE r.kind WHEN 'initial' THEN 'quote_request'
        WHEN 'renegotiation' THEN 'renegotiation' ELSE 'booking_replacement' END) THEN
    RAISE EXCEPTION 'operation_not_available' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER escalations_provider_round_guard BEFORE INSERT ON public.escalations
FOR EACH ROW EXECUTE FUNCTION public.validate_provider_escalation_round();

NOTIFY pgrst,'reload schema';
COMMIT;
