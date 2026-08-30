-- Durable sourcing: a mandate starts at most three compatible carrier contacts.
-- Calls are dispatched by the backend worker from the outbox; this migration
-- contains the commercial decisions so a model never chooses a winner.
BEGIN;

CREATE OR REPLACE FUNCTION public.enqueue_mandate_sourcing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  candidate record;
  op public.operations%ROWTYPE;
  request_id uuid;
  count_selected integer := 0;
BEGIN
  SELECT * INTO op FROM public.operations WHERE id = NEW.operation_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  -- Compatibility is intentionally deterministic for this MVP: active
  -- providers whose declared equipment includes the requested container.
  FOR candidate IN
    SELECT id FROM public.providers
    WHERE active
      AND coalesce(capabilities->'equipment', '[]'::jsonb) ? coalesce(op.container_type, '')
    ORDER BY name, id
    LIMIT 3
  LOOP
    INSERT INTO public.quote_requests (
      operation_id, provider_id, contact_attempt, status, expires_at, idempotency_key
    ) VALUES (
      op.id, candidate.id, 1, 'queued', clock_timestamp() + interval '5 minutes',
      'mandate:' || NEW.id::text || ':provider:' || candidate.id::text
    ) ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO request_id;
    IF request_id IS NOT NULL THEN
      count_selected := count_selected + 1;
      INSERT INTO public.outbox (operation_id, quote_request_id, job_type, payload, idempotency_key)
      VALUES (
        op.id, request_id, 'contact_provider',
        jsonb_build_object('purpose', CASE WHEN NEW.supersedes_mandate_id IS NULL THEN 'quote_request' ELSE 'renegotiation' END),
        'contact-provider:' || request_id::text
      );
    END IF;
  END LOOP;

  INSERT INTO public.events (type, operation_id, call_id, payload)
  VALUES ('sourcing.dispatch_queued', op.id, NEW.confirmed_in_call_id,
    jsonb_build_object('mandate_id', NEW.id, 'provider_count', count_selected));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mandates_enqueue_sourcing ON public.mandates;
CREATE TRIGGER mandates_enqueue_sourcing
AFTER INSERT ON public.mandates
FOR EACH ROW EXECUTE FUNCTION public.enqueue_mandate_sourcing();

CREATE OR REPLACE FUNCTION public.claim_next_provider_contact()
RETURNS TABLE(outbox_id uuid, operation_id uuid, quote_request_id uuid, provider_id uuid, provider_phone text, purpose text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE job public.outbox%ROWTYPE;
BEGIN
  SELECT * INTO job FROM public.outbox
  WHERE job_type = 'contact_provider' AND status = 'pending' AND available_at <= clock_timestamp()
  ORDER BY available_at, created_at
  FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.outbox SET status = 'processing', attempts = attempts + 1 WHERE id = job.id;
  RETURN QUERY
    SELECT job.id, job.operation_id, job.quote_request_id, qr.provider_id, p.phone,
      coalesce(job.payload->>'purpose', 'quote_request')
    FROM public.quote_requests qr JOIN public.providers p ON p.id = qr.provider_id
    WHERE qr.id = job.quote_request_id AND qr.status = 'queued' AND p.active;
  IF NOT FOUND THEN
    UPDATE public.outbox SET status = 'processed', processed_at = clock_timestamp() WHERE id = job.id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_provider_contact(
  p_outbox_id uuid, p_call_id uuid, p_twilio_call_sid text, p_error text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE job public.outbox%ROWTYPE;
BEGIN
  SELECT * INTO job FROM public.outbox WHERE id = p_outbox_id FOR UPDATE;
  IF NOT FOUND OR job.status <> 'processing' THEN RETURN; END IF;
  IF p_twilio_call_sid IS NOT NULL THEN
    UPDATE public.outbox SET status = 'processed', processed_at = clock_timestamp() WHERE id = job.id;
    UPDATE public.quote_requests SET status = 'contacted' WHERE id = job.quote_request_id AND status = 'queued';
    INSERT INTO public.events (type, operation_id, call_id, payload)
    VALUES ('quote.requested', job.operation_id, p_call_id, jsonb_build_object('quote_request_id', job.quote_request_id));
  ELSIF job.attempts < 3 THEN
    UPDATE public.outbox SET status = 'pending', available_at = clock_timestamp() + interval '1 minute' WHERE id = job.id;
  ELSE
    UPDATE public.outbox SET status = 'failed' WHERE id = job.id;
    UPDATE public.quote_requests SET status = 'expired' WHERE id = job.quote_request_id AND status = 'queued';
    INSERT INTO public.events (type, operation_id, payload)
    VALUES ('quote.expired', job.operation_id, jsonb_build_object('quote_request_id', job.quote_request_id, 'reason', coalesce(p_error, 'contact_failed')));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_operation_sourcing(p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  op public.operations%ROWTYPE;
  winning public.quotes%ROWTYPE;
  source_call uuid;
  booking_id uuid;
  still_open boolean;
BEGIN
  SELECT * INTO op FROM public.operations WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND OR op.status <> 'sourcing' THEN RETURN jsonb_build_object('finalized', false); END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.quote_requests qr
    WHERE qr.operation_id = op.id AND qr.status IN ('queued', 'contacted')
      AND (qr.expires_at > clock_timestamp() OR (clock_timestamp() <= qr.expires_at + interval '2 minutes' AND EXISTS (
        SELECT 1 FROM public.calls c WHERE c.operation_id = op.id AND c.provider_id = qr.provider_id
          AND c.direction = 'outbound' AND c.outcome = 'active' AND c.started_at < qr.expires_at + interval '2 minutes'
      )))
  ) INTO still_open;
  IF still_open THEN RETURN jsonb_build_object('finalized', false); END IF;
  UPDATE public.quote_requests SET status = 'expired'
  WHERE operation_id = op.id AND status IN ('queued', 'contacted') AND expires_at <= clock_timestamp();

  SELECT q.* INTO winning
  FROM public.quotes q JOIN public.quote_requests qr ON qr.id = q.quote_request_id
  WHERE qr.operation_id = op.id AND q.verdict = 'dentro' AND q.status = 'received'
    AND q.evaluated_mandate_id = op.current_mandate_id AND q.valid_until > clock_timestamp()
    AND NOT EXISTS (SELECT 1 FROM public.quotes successor WHERE successor.supersedes_quote_id = q.id)
  ORDER BY q.price_max ASC, q.received_at ASC, q.id ASC LIMIT 1;
  IF NOT FOUND THEN
    UPDATE public.operations SET status = 'needs_follow_up' WHERE id = op.id;
    RETURN jsonb_build_object('finalized', true, 'selected', false);
  END IF;

  SELECT c.id INTO source_call FROM public.calls c JOIN public.quote_requests qr ON qr.provider_id = c.provider_id
  WHERE qr.id = winning.quote_request_id AND c.operation_id = op.id AND c.direction = 'outbound'
  ORDER BY c.started_at DESC LIMIT 1;
  UPDATE public.operations SET status = 'quotes_received' WHERE id = op.id;
  UPDATE public.operations SET status = 'quote_selected' WHERE id = op.id;
  UPDATE public.operations SET status = 'booking_pending' WHERE id = op.id;
  UPDATE public.bookings SET status = 'cancelled', cancelled_at = clock_timestamp()
  WHERE operation_id = op.id AND status IN ('pending', 'confirmed');
  INSERT INTO public.bookings (
    operation_id, quote_id, status, pickup_window_start, pickup_window_end,
    payment_term_days, confirmed_price, confirmation_reference, confirmed_at
  ) VALUES (
    op.id, winning.id, 'confirmed',
    (winning.proposed_pickup_window->>'start_at')::timestamptz,
    (winning.proposed_pickup_window->>'end_at')::timestamptz,
    winning.payment_term_days, winning.price_max,
    'TANGO-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)), clock_timestamp()
  ) RETURNING id INTO booking_id;
  UPDATE public.operations SET status = 'booking_confirmed' WHERE id = op.id;
  IF source_call IS NOT NULL THEN
    INSERT INTO public.commitments (operation_id, quote_id, booking_id, mandate_id, call_id, type, terms, transcript_excerpt, recording_checkpoint, occurred_at)
    VALUES (op.id, winning.id, booking_id, op.current_mandate_id, source_call, 'booking',
      jsonb_build_object('price', winning.price_max, 'currency', winning.currency),
      'Provider approved the quote during the recorded call.', 0, clock_timestamp());
  END IF;
  INSERT INTO public.events (type, operation_id, call_id, payload) VALUES
    ('quote.selected', op.id, source_call, jsonb_build_object('quote_id', winning.id, 'selection_rule', 'lowest_price_max')),
    ('booking.confirmed', op.id, source_call, jsonb_build_object('booking_id', booking_id, 'quote_id', winning.id));
  RETURN jsonb_build_object('finalized', true, 'selected', true, 'booking_id', booking_id, 'quote_id', winning.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_provider_quote(
  p_call_id uuid, p_realtime_call_id text, p_provider_id uuid, p_tool_call_id text, p_arguments jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  c public.calls%ROWTYPE; qr public.quote_requests%ROWTYPE; op public.operations%ROWTYPE; m public.mandates%ROWTYPE;
  previous public.quotes%ROWTYPE; inserted public.quotes%ROWTYPE; verdict public.quote_verdict; valid boolean;
  quote_window jsonb; now_time timestamptz := clock_timestamp(); result jsonb;
BEGIN
  IF p_tool_call_id IS NULL OR btrim(p_tool_call_id) = '' OR jsonb_typeof(p_arguments) <> 'object'
    OR NOT p_arguments ?& ARRAY['price_min','price_max','currency','pickup_window','payment_term_days','valid_until','conditions'] THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO c FROM public.calls WHERE id = p_call_id AND realtime_call_id = p_realtime_call_id
    AND provider_id = p_provider_id AND persona = 'provider' AND outcome = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'P0001'; END IF;
  SELECT receipt.result INTO result FROM public.tool_command_receipts receipt
  WHERE receipt.call_id = c.id AND receipt.tool_call_id = p_tool_call_id;
  IF FOUND THEN RETURN result; END IF;
  SELECT qr.* INTO qr FROM public.quote_requests qr WHERE qr.operation_id = c.operation_id AND qr.provider_id = p_provider_id
    AND qr.status IN ('queued','contacted') ORDER BY qr.created_at DESC FOR UPDATE LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO op FROM public.operations WHERE id = c.operation_id FOR UPDATE;
  SELECT * INTO m FROM public.mandates WHERE id = op.current_mandate_id;
  quote_window := p_arguments->'pickup_window';
  IF jsonb_typeof(p_arguments->'price_min') <> 'number' OR jsonb_typeof(p_arguments->'price_max') <> 'number'
    OR (p_arguments->>'price_min')::numeric <= 0 OR (p_arguments->>'price_max')::numeric < (p_arguments->>'price_min')::numeric
    OR jsonb_typeof(p_arguments->'currency') <> 'string' OR (p_arguments->>'currency') !~ '^[A-Z]{3}$'
    OR jsonb_typeof(quote_window) <> 'object' OR NOT quote_window ?& ARRAY['start_at','end_at']
    OR jsonb_typeof(p_arguments->'payment_term_days') <> 'number' OR (p_arguments->>'payment_term_days')::numeric < 0
    OR jsonb_typeof(p_arguments->'conditions') <> 'object' OR (p_arguments->>'valid_until')::timestamptz <= now_time THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO previous FROM public.quotes WHERE quote_request_id = qr.id ORDER BY version DESC LIMIT 1;
  valid := p_arguments->>'currency' = m.currency
    AND (p_arguments->>'price_max')::numeric <= m.price_cap
    AND (p_arguments->>'payment_term_days')::integer >= m.minimum_payment_term_days
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.action_windows) w
      WHERE (quote_window->>'start_at')::timestamptz >= (w->>'start_at')::timestamptz
        AND (quote_window->>'end_at')::timestamptz <= (w->>'end_at')::timestamptz);
  verdict := CASE WHEN valid THEN 'dentro'::public.quote_verdict
    WHEN previous.id IS NULL THEN 'contraoferta'::public.quote_verdict ELSE 'fuera'::public.quote_verdict END;
  INSERT INTO public.quotes (quote_request_id, evaluated_mandate_id, version, supersedes_quote_id, price_min, price_max, currency, proposed_pickup_window, payment_term_days, valid_until, conditions, verdict)
  VALUES (qr.id, m.id, coalesce(previous.version, 0) + 1, previous.id,
    (p_arguments->>'price_min')::numeric, (p_arguments->>'price_max')::numeric, p_arguments->>'currency', quote_window,
    (p_arguments->>'payment_term_days')::integer, (p_arguments->>'valid_until')::timestamptz, p_arguments->'conditions', verdict)
  RETURNING * INTO inserted;
  IF verdict <> 'contraoferta' THEN UPDATE public.quote_requests SET status = 'responded' WHERE id = qr.id; END IF;
  INSERT INTO public.events (type, operation_id, call_id, payload) VALUES
    ('quote.received', op.id, c.id, jsonb_build_object('quote_id', inserted.id, 'verdict', verdict));
  result := jsonb_build_object('quote_recorded', true, 'verdict', verdict,
    'next_step', CASE WHEN verdict = 'dentro' THEN 'quote_accepted' WHEN verdict = 'contraoferta' THEN 'request_one_revised_quote_without_disclosing_the_mandate' ELSE 'quote_declined' END);
  INSERT INTO public.tool_command_receipts (call_id, tool_call_id, tool_name, arguments, result)
  VALUES (c.id, p_tool_call_id, 'record_provider_quote', p_arguments, result);
  PERFORM public.finalize_operation_sourcing(op.id);
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_provider_contact() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_provider_contact(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_operation_sourcing(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_provider_quote(uuid, text, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_provider_contact(), public.finish_provider_contact(uuid, uuid, text, text), public.finalize_operation_sourcing(uuid), public.record_provider_quote(uuid, text, uuid, text, jsonb) TO service_role;
COMMIT;
