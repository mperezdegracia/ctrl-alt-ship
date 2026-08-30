-- Minimal carrier proposal: price only; server resolves the authorized route/window/currency.
-- Existing quotes and explicit terms are preserved, never nulled retroactively.
BEGIN;
ALTER TABLE public.quotes ALTER COLUMN payment_term_days DROP NOT NULL,
  ALTER COLUMN valid_until DROP NOT NULL, ALTER COLUMN conditions DROP NOT NULL,
  ALTER COLUMN conditions DROP DEFAULT;
ALTER TABLE public.bookings ALTER COLUMN payment_term_days DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.provider_quote_operation(op public.operations) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('operation_reference', op.reference,
    'container_type', op.container_type, 'gross_weight_kg', op.gross_weight_kg,
    'pickup_location', op.pickup_location, 'delivery_location', op.delivery_location,
    'empty_return_depot', op.empty_return_depot, 'operational_constraints', op.operational_constraints,
    'cargo_notes', op.cargo_notes, 'currency', m.currency,
    'pickup_window', (SELECT w FROM jsonb_array_elements(m.action_windows) w
      ORDER BY (w->>'start_at')::timestamptz, (w->>'end_at')::timestamptz LIMIT 1))
  FROM (SELECT 1) anchor LEFT JOIN public.mandates m ON m.id = op.current_mandate_id;
$$;

CREATE OR REPLACE FUNCTION public.execute_provider_quote_tool(
  p_call_id uuid, p_realtime_call_id text, p_provider_id uuid,
  p_tool_call_id text, p_tool_name text, p_arguments jsonb, p_context jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  c public.calls%ROWTYPE;
  op public.operations%ROWTYPE;
  qr public.quote_requests%ROWTYPE;
  mandate public.mandates%ROWTYPE;
  previous_quote public.quotes%ROWTYPE;
  new_quote public.quotes%ROWTYPE;
  receipt public.tool_command_receipts%ROWTYPE;
  result jsonb;
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
  SELECT * INTO c FROM public.calls WHERE id = p_call_id AND realtime_call_id = p_realtime_call_id
    AND provider_id = p_provider_id AND persona = 'provider' AND outcome = 'active' FOR UPDATE;
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
    OR p_arguments->>'operation_reference' !~ '^OP-[0-9]{6,}$') THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
  END IF;
  IF c.operation_id IS NULL AND NOT p_arguments ? 'operation_reference' THEN
    RAISE EXCEPTION 'operation_reference_required' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO op FROM public.operations o WHERE
    ((c.operation_id IS NOT NULL AND o.id = c.operation_id) OR (c.operation_id IS NULL AND o.reference = p_arguments->>'operation_reference'))
    AND EXISTS (SELECT 1 FROM public.quote_requests r WHERE r.operation_id = o.id AND r.provider_id = p_provider_id)
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation_not_available' USING ERRCODE = 'P0001'; END IF;
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
  SELECT * INTO qr FROM public.quote_requests WHERE id::text = p_context->>'quote_request_id'
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
    INSERT INTO public.events (type, operation_id, call_id, occurred_at, payload) VALUES (
      'quote.received', op.id, c.id, command_time, result || jsonb_build_object('quote_id', new_quote.id,
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
$$;

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
    WHERE qr.operation_id = op.id AND qr.mandate_id = m.id AND qr.status = 'responded' AND p.active
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

CREATE OR REPLACE FUNCTION public.validate_booking() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  q public.quotes%ROWTYPE;
  op public.operations%ROWTYPE;
  request_operation uuid;
BEGIN
  SELECT * INTO q FROM public.quotes WHERE id = NEW.quote_id;
  SELECT operation_id INTO request_operation FROM public.quote_requests WHERE id = q.quote_request_id;
  SELECT * INTO op FROM public.operations WHERE id = NEW.operation_id;
  -- An agreed booking may outlive its quote's expiry. Window-only changes
  -- require a freshly applied change request; do not weaken creation checks.
  IF TG_OP = 'UPDATE' AND OLD.status = 'confirmed' AND NEW.status = 'confirmed'
    AND NEW.last_change_request_id IS DISTINCT FROM OLD.last_change_request_id THEN
    IF NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.quote_id IS DISTINCT FROM OLD.quote_id
      OR NEW.confirmed_price IS DISTINCT FROM OLD.confirmed_price
      OR NEW.payment_term_days IS DISTINCT FROM OLD.payment_term_days
      OR NEW.payment_term_anchor IS DISTINCT FROM OLD.payment_term_anchor
      OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
      OR NEW.confirmation_reference IS DISTINCT FROM OLD.confirmation_reference
      OR request_operation IS DISTINCT FROM NEW.operation_id
      OR op.status NOT IN ('booking_confirmed', 'notifications_sent')
      OR q.verdict <> 'dentro' OR q.status <> 'received'
      OR EXISTS (SELECT 1 FROM public.quotes successor WHERE successor.supersedes_quote_id = q.id)
      OR op.mandate_confirmation_required OR q.evaluated_mandate_id IS DISTINCT FROM op.current_mandate_id
      OR NOT EXISTS (SELECT 1 FROM public.change_requests cr
        WHERE cr.id = NEW.last_change_request_id AND cr.booking_id = OLD.id AND cr.operation_id = OLD.operation_id
          AND cr.type = 'reschedule' AND cr.status = 'applied' AND cr.verdict = 'dentro'
          AND cr.evaluated_mandate_id = op.current_mandate_id AND cr.requested_at >= OLD.updated_at
          AND (cr.previous_pickup_window->>'start_at')::timestamptz = OLD.pickup_window_start
          AND (cr.previous_pickup_window->>'end_at')::timestamptz = OLD.pickup_window_end
          AND (cr.requested_pickup_window->>'start_at')::timestamptz = NEW.pickup_window_start
          AND (cr.requested_pickup_window->>'end_at')::timestamptz = NEW.pickup_window_end)
      OR NOT EXISTS (SELECT 1 FROM public.mandates m, jsonb_array_elements(m.action_windows) w
        WHERE m.id = op.current_mandate_id AND NEW.confirmed_price <= m.price_cap
          AND (NEW.payment_term_days >= m.minimum_payment_term_days OR (NEW.payment_term_days IS NULL AND m.minimum_payment_term_days = 0)) AND q.currency = m.currency
          AND NEW.pickup_window_start >= (w->>'start_at')::timestamptz
          AND NEW.pickup_window_end <= (w->>'end_at')::timestamptz) THEN
      RAISE EXCEPTION 'booking reschedule requires an approved window-only change' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF request_operation IS DISTINCT FROM NEW.operation_id OR q.verdict <> 'dentro' OR q.status <> 'received'
    OR (q.valid_until IS NOT NULL AND q.valid_until <= now()) OR q.evaluated_mandate_id IS DISTINCT FROM op.current_mandate_id
    OR EXISTS (SELECT 1 FROM public.quotes successor WHERE successor.supersedes_quote_id = q.id)
    OR NEW.pickup_window_start IS DISTINCT FROM (q.proposed_pickup_window->>'start_at')::timestamptz
    OR NEW.pickup_window_end IS DISTINCT FROM (q.proposed_pickup_window->>'end_at')::timestamptz
    OR NEW.payment_term_days IS DISTINCT FROM q.payment_term_days
    OR (NEW.confirmed_price IS NOT NULL AND NEW.confirmed_price NOT BETWEEN q.price_min AND q.price_max)
    OR NEW.last_change_request_id IS NOT NULL THEN
    RAISE EXCEPTION 'booking does not match an eligible current quote' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
