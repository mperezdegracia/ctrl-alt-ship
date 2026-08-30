-- Bounded LLM review: SQL still owns timing, eligibility and winner selection.
-- Forward-only; requires minimal_operation_intake. No new mandate fields.
BEGIN;

CREATE TABLE public.sourcing_judge_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES public.operations(id),
  mandate_id uuid NOT NULL REFERENCES public.mandates(id),
  quote_id uuid NOT NULL REFERENCES public.quotes(id),
  input_hash text NOT NULL,
  input_context jsonb NOT NULL CHECK (jsonb_typeof(input_context) = 'object'),
  assessment text NOT NULL CHECK (assessment IN ('clear', 'review_required')),
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 2000),
  issues jsonb NOT NULL CHECK (jsonb_typeof(issues) = 'array'),
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (operation_id, input_hash),
  CHECK (assessment <> 'clear' OR issues = '[]'::jsonb)
);
ALTER TABLE public.sourcing_judge_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sourcing_judge_reviews FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.sourcing_judge_reviews TO service_role;
CREATE TRIGGER sourcing_judge_reviews_append_only
BEFORE UPDATE OR DELETE ON public.sourcing_judge_reviews
FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

CREATE OR REPLACE FUNCTION public.prepare_sourcing_review(p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  op public.operations%ROWTYPE; m public.mandates%ROWTYPE; winning public.quotes%ROWTYPE;
  dispatched timestamptz; still_open boolean; review_context jsonb; eligible_quotes jsonb;
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
      AND (op.container_type IS NULL OR coalesce(p.capabilities->'equipment', '[]'::jsonb) ? op.container_type)
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
  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.price_max, q.received_at, q.id), '[]'::jsonb) INTO eligible_quotes FROM public.quotes q
    JOIN public.quote_requests qr ON qr.id = q.quote_request_id
    JOIN public.providers p ON p.id = qr.provider_id
    WHERE qr.operation_id = op.id AND qr.mandate_id = m.id AND qr.status = 'responded' AND p.active
      AND q.verdict = 'dentro' AND q.status = 'received' AND q.evaluated_mandate_id = m.id
      AND q.valid_until > clock_timestamp() AND q.currency = m.currency
      AND (op.container_type IS NULL OR coalesce(p.capabilities->'equipment', '[]'::jsonb) ? op.container_type)
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
;
  review_context := jsonb_build_object(
    'policy_version', 'minimal-mandate-v1',
    'operation_id', op.id, 'operation_revision', op.updated_at,
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

CREATE FUNCTION public.record_sourcing_review(
  p_operation_id uuid, p_input_hash text, p_review jsonb, p_model text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE prepared jsonb; review_context jsonb; review_id uuid;
BEGIN
  -- prepare locks the operation; no model/network call runs inside this transaction.
  prepared := public.prepare_sourcing_review(p_operation_id);
  IF prepared->>'ready' IS DISTINCT FROM 'true'
    OR prepared->>'input_hash' IS DISTINCT FROM p_input_hash THEN
    RETURN jsonb_build_object('saved', false, 'reason', 'stale_review');
  END IF;
  IF p_review IS NULL OR jsonb_typeof(p_review) IS DISTINCT FROM 'object'
    OR NOT p_review ?& ARRAY['assessment', 'summary', 'issues']
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_review) k WHERE k NOT IN ('assessment', 'summary', 'issues'))
    OR jsonb_typeof(p_review->'assessment') IS DISTINCT FROM 'string'
    OR p_review->>'assessment' NOT IN ('clear', 'review_required')
    OR jsonb_typeof(p_review->'summary') IS DISTINCT FROM 'string'
    OR length(btrim(p_review->>'summary')) NOT BETWEEN 1 AND 2000
    OR jsonb_typeof(p_review->'issues') IS DISTINCT FROM 'array'
    OR p_model IS NULL OR length(btrim(p_model)) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid_sourcing_review' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_review->'issues') > 10
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_review->'issues') issue
      WHERE jsonb_typeof(issue) <> 'string' OR length(btrim(issue #>> '{}')) NOT BETWEEN 1 AND 1000)
    OR (p_review->>'assessment' = 'clear' AND p_review->'issues' <> '[]'::jsonb)
    OR (p_review->>'assessment' = 'review_required' AND p_review->'issues' = '[]'::jsonb) THEN
    RAISE EXCEPTION 'invalid_sourcing_review' USING ERRCODE = '22023';
  END IF;
  review_context := prepared->'context';
  INSERT INTO public.sourcing_judge_reviews (
    operation_id, mandate_id, quote_id, input_hash, input_context, assessment, summary, issues, model)
  VALUES (p_operation_id, (review_context->'mandate'->>'id')::uuid,
    (review_context->'selected_quote'->>'id')::uuid, p_input_hash, review_context,
    p_review->>'assessment', p_review->>'summary', p_review->'issues', p_model)
  ON CONFLICT (operation_id, input_hash) DO NOTHING RETURNING id INTO review_id;
  IF review_id IS NULL THEN
    SELECT id INTO review_id FROM public.sourcing_judge_reviews
    WHERE operation_id = p_operation_id AND input_hash = p_input_hash;
  END IF;
  RETURN jsonb_build_object('saved', true, 'review_id', review_id);
END;
$$;

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
  IF reviewed.assessment <> 'clear' THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'judge_review_required', 'review_id', reviewed.id);
  END IF;
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

REVOKE ALL ON FUNCTION public.prepare_sourcing_review(uuid),
  public.record_sourcing_review(uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_sourcing_review(uuid),
  public.record_sourcing_review(uuid, text, jsonb, text) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
