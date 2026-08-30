-- Automatic selection without a judge-driven human-review state.
-- Context matching, deterministic eligibility and price ordering remain enforced.
BEGIN;

CREATE OR REPLACE FUNCTION public.finalize_operation_sourcing(p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  op public.operations%ROWTYPE; m public.mandates%ROWTYPE; winning public.quotes%ROWTYPE;
  source_call uuid; booking_id uuid; dispatched timestamptz;
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
  SELECT * INTO m FROM public.mandates WHERE id = op.current_mandate_id;
  SELECT * INTO winning FROM public.quotes WHERE id = reviewed.quote_id;
  dispatched := (prepared->'context'->>'comparison_deadline')::timestamptz - interval '5 minutes';
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
      'price_max', winning.price_max, 'currency', winning.currency, 'judge_review_id', reviewed.id, 'selection_rule',
      CASE WHEN winning.received_at > dispatched + interval '5 minutes'
        THEN 'first_valid_after_deadline' ELSE 'lowest_valid_price_max' END)),
    ('booking.confirmed', op.id, source_call, jsonb_build_object('booking_id', booking_id, 'quote_id', winning.id,
      'confirmed_price', winning.price_max, 'currency', winning.currency, 'pickup_window', winning.proposed_pickup_window,
      'payment_term_days', winning.payment_term_days, 'commitment_created', false));
  RETURN jsonb_build_object('finalized', true, 'selected', true, 'judge_review_id', reviewed.id, 'booking_id', booking_id, 'quote_id', winning.id);
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
