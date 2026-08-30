-- Merge decisions: two providers, three counteroffers, compare before booking,
-- five minutes from first successful dispatch, wait indefinitely if none valid.
BEGIN;
ALTER TABLE public.quote_requests ADD COLUMN dispatched_at timestamptz;

-- Only automatic sourcing requests use an open-ended response deadline.
-- Quote.valid_until remains a separate, mandatory commercial expiry.
UPDATE public.quote_requests qr SET expires_at = 'infinity'::timestamptz,
  dispatched_at = (SELECT min(e.occurred_at) FROM public.events e
    WHERE e.type = 'quote.requested' AND e.payload->>'quote_request_id' = qr.id::text)
WHERE qr.idempotency_key LIKE 'mandate:%' AND qr.status IN ('queued', 'contacted', 'responded');

CREATE OR REPLACE FUNCTION public.enqueue_mandate_sourcing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE candidate record; op public.operations%ROWTYPE; request_id uuid; count_selected integer := 0;
BEGIN
  SELECT * INTO op FROM public.operations WHERE id = NEW.operation_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  FOR candidate IN SELECT id FROM public.providers WHERE active
    AND coalesce(capabilities->'equipment', '[]'::jsonb) ? coalesce(op.container_type, '')
    ORDER BY name, id LIMIT 2
  LOOP
    -- The AFTER INSERT trigger runs before confirm_mandate updates the operation
    -- pointer. Bind explicitly to NEW.id, never the previous current_mandate_id.
    INSERT INTO public.quote_requests (operation_id, provider_id, mandate_id, contact_attempt, status, expires_at, idempotency_key)
    VALUES (op.id, candidate.id, NEW.id, 1, 'queued', 'infinity'::timestamptz,
      'mandate:' || NEW.id::text || ':provider:' || candidate.id::text)
    ON CONFLICT (idempotency_key) DO NOTHING RETURNING id INTO request_id;
    IF request_id IS NOT NULL THEN
      count_selected := count_selected + 1;
      INSERT INTO public.outbox (operation_id, quote_request_id, job_type, payload, idempotency_key)
      VALUES (op.id, request_id, 'contact_provider',
        jsonb_build_object('purpose', CASE WHEN NEW.supersedes_mandate_id IS NULL THEN 'quote_request' ELSE 'renegotiation' END),
        'contact-provider:' || request_id::text);
    END IF;
  END LOOP;
  INSERT INTO public.events (type, operation_id, call_id, payload)
  VALUES ('sourcing.dispatch_queued', op.id, NEW.confirmed_in_call_id,
    jsonb_build_object('mandate_id', NEW.id, 'provider_count', count_selected));
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_next_provider_contact()
RETURNS TABLE(outbox_id uuid, operation_id uuid, quote_request_id uuid, provider_id uuid, provider_phone text, purpose text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE job public.outbox%ROWTYPE;
BEGIN
  SELECT * INTO job FROM public.outbox
    WHERE job_type = 'contact_provider' AND status = 'pending' AND available_at <= clock_timestamp()
    ORDER BY available_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.outbox SET status = 'processing', attempts = attempts + 1 WHERE id = job.id;
  RETURN QUERY SELECT job.id, job.operation_id, job.quote_request_id, qr.provider_id, p.phone,
    coalesce(job.payload->>'purpose', 'quote_request')
    FROM public.quote_requests qr JOIN public.providers p ON p.id = qr.provider_id
      JOIN public.operations o ON o.id = qr.operation_id
    WHERE qr.id = job.quote_request_id AND qr.status = 'queued' AND p.active
      AND qr.mandate_id = o.current_mandate_id AND NOT o.mandate_confirmation_required
      AND o.status IN ('sourcing', 'quotes_received');
  IF NOT FOUND THEN
    UPDATE public.outbox SET status = 'processed', processed_at = clock_timestamp(),
      payload = payload || jsonb_build_object('skipped_reason', 'request_no_longer_actionable') WHERE id = job.id;
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
    UPDATE public.quote_requests SET
      status = CASE WHEN status = 'queued' THEN 'contacted'::public.quote_request_status ELSE status END,
      dispatched_at = coalesce(dispatched_at, clock_timestamp()) WHERE id = job.quote_request_id;
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
  op public.operations%ROWTYPE; m public.mandates%ROWTYPE; winning public.quotes%ROWTYPE;
  source_call uuid; booking_id uuid; dispatched timestamptz; still_open boolean;
BEGIN
  SELECT * INTO op FROM public.operations WHERE id = p_operation_id FOR UPDATE;
  IF NOT FOUND OR op.status NOT IN ('sourcing', 'quotes_received') OR op.mandate_confirmation_required THEN
    RETURN jsonb_build_object('finalized', false);
  END IF;
  SELECT * INTO m FROM public.mandates WHERE id = op.current_mandate_id AND operation_id = op.id;
  IF NOT FOUND THEN RETURN jsonb_build_object('finalized', false); END IF;
  SELECT min(qr.dispatched_at) INTO dispatched FROM public.quote_requests qr
    WHERE qr.operation_id = op.id AND qr.mandate_id = m.id;
  IF dispatched IS NULL THEN RETURN jsonb_build_object('finalized', false, 'reason', 'awaiting_dispatch'); END IF;

  -- A counteroffer is a response but not a finished negotiation. Do not select
  -- early just because all requests have status=responded.
  SELECT EXISTS (SELECT 1 FROM public.quote_requests qr
    LEFT JOIN LATERAL (SELECT q.* FROM public.quotes q WHERE q.quote_request_id = qr.id ORDER BY version DESC LIMIT 1) latest ON true
    WHERE qr.operation_id = op.id AND qr.mandate_id = m.id
      AND qr.status IN ('pending', 'queued', 'contacted', 'responded')
      AND (latest.id IS NULL OR latest.verdict = 'contraoferta')) INTO still_open;
  IF still_open AND clock_timestamp() < dispatched + interval '5 minutes' THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'comparing_proposals');
  END IF;

  SELECT q.* INTO winning FROM public.quotes q
    JOIN public.quote_requests qr ON qr.id = q.quote_request_id
    JOIN public.providers p ON p.id = qr.provider_id
    WHERE qr.operation_id = op.id AND qr.mandate_id = m.id AND qr.status = 'responded' AND p.active
      AND q.verdict = 'dentro' AND q.status = 'received' AND q.evaluated_mandate_id = m.id
      AND q.valid_until > clock_timestamp() AND q.currency = m.currency
      AND coalesce(p.capabilities->'equipment', '[]'::jsonb) ? coalesce(op.container_type, '')
      AND q.price_max <= m.price_cap AND q.payment_term_days >= m.minimum_payment_term_days
      AND (q.proposed_pickup_window->>'start_at')::timestamptz > clock_timestamp()
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(m.action_windows) w
        WHERE (q.proposed_pickup_window->>'start_at')::timestamptz >= (w->>'start_at')::timestamptz
          AND (q.proposed_pickup_window->>'end_at')::timestamptz <= (w->>'end_at')::timestamptz)
      AND (q.conditions = '{}'::jsonb OR (jsonb_typeof(q.conditions->'notes') = 'array'
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
  SELECT e.call_id INTO source_call FROM public.events e
    WHERE e.type = 'quote.received' AND e.operation_id = op.id AND e.payload->>'quote_id' = winning.id::text
    ORDER BY e.occurred_at DESC LIMIT 1;
  UPDATE public.operations SET status = 'quotes_received' WHERE id = op.id AND status = 'sourcing';
  UPDATE public.operations SET status = 'quote_selected' WHERE id = op.id;
  UPDATE public.operations SET status = 'booking_pending' WHERE id = op.id;
  UPDATE public.bookings SET status = 'cancelled', cancelled_at = clock_timestamp()
    WHERE operation_id = op.id AND status IN ('pending', 'confirmed');
  -- Existing booking-confirmation trigger queues one email per recipient.
  INSERT INTO public.bookings (operation_id, quote_id, status, pickup_window_start, pickup_window_end,
    payment_term_days, confirmed_price, confirmation_reference, confirmed_at)
  VALUES (op.id, winning.id, 'confirmed',
    (winning.proposed_pickup_window->>'start_at')::timestamptz, (winning.proposed_pickup_window->>'end_at')::timestamptz,
    winning.payment_term_days, winning.price_max,
    'TANGO-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)), clock_timestamp())
  RETURNING id INTO booking_id;
  UPDATE public.operations SET status = 'booking_confirmed' WHERE id = op.id;
  UPDATE public.quote_requests SET status = 'cancelled'
    WHERE operation_id = op.id AND mandate_id = m.id AND id <> winning.quote_request_id
      AND status IN ('pending', 'queued', 'contacted', 'responded');
  UPDATE public.outbox SET status = 'processed', processed_at = clock_timestamp(),
    payload = payload || jsonb_build_object('skipped_reason', 'booking_selected')
    WHERE operation_id = op.id AND job_type = 'contact_provider' AND status = 'pending';
  -- No fabricated transcript_excerpt/checkpoint. Quote/event provenance is real;
  -- a recording-backed commitment can only be added when that evidence exists.
  INSERT INTO public.events (type, operation_id, call_id, payload) VALUES
    ('quote.selected', op.id, source_call, jsonb_build_object('quote_id', winning.id,
      'price_max', winning.price_max, 'currency', winning.currency, 'selection_rule',
      CASE WHEN winning.received_at > dispatched + interval '5 minutes'
        THEN 'first_valid_after_deadline' ELSE 'lowest_valid_price_max' END)),
    ('booking.confirmed', op.id, source_call, jsonb_build_object('booking_id', booking_id, 'quote_id', winning.id,
      'confirmed_price', winning.price_max, 'currency', winning.currency, 'pickup_window', winning.proposed_pickup_window,
      'payment_term_days', winning.payment_term_days, 'commitment_created', false));
  RETURN jsonb_build_object('finalized', true, 'selected', true, 'booking_id', booking_id, 'quote_id', winning.id);
END;
$$;
-- Old deployed clients must upgrade, not bypass the new round/ownership policy.
REVOKE EXECUTE ON FUNCTION public.record_provider_quote(uuid, text, uuid, text, jsonb) FROM service_role;
COMMIT;
