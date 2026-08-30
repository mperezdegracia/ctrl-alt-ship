-- First provider mutation tranche: quotes and explicit declines. No emails,
-- booking selection or fabricated recording evidence/commitments.
BEGIN;

ALTER TABLE public.calls ADD COLUMN provider_tools_completed_at timestamptz;
ALTER TABLE public.quote_requests
  ADD COLUMN mandate_id uuid REFERENCES public.mandates(id),
  ADD COLUMN negotiation_limit smallint NOT NULL DEFAULT 3 CHECK (negotiation_limit BETWEEN 1 AND 10),
  ADD COLUMN provider_decline_reason text CHECK (provider_decline_reason IN (
    'no_capacity', 'unavailable_window', 'price_terms', 'route_unsupported', 'operational_constraints', 'other')),
  ADD COLUMN provider_declined_at timestamptz,
  ADD CONSTRAINT quote_request_decline_consistent CHECK (
    (provider_decline_reason IS NULL AND provider_declined_at IS NULL)
    OR (provider_decline_reason IS NOT NULL AND provider_declined_at IS NOT NULL AND status = 'cancelled')
  );
-- Bind existing requests to their latest evaluated mandate where possible.
-- An old request must not silently authorize quoting a replacement mandate.
UPDATE public.quote_requests qr SET mandate_id = coalesce(
  (SELECT q.evaluated_mandate_id FROM public.quotes q WHERE q.quote_request_id = qr.id ORDER BY q.version DESC LIMIT 1),
  (SELECT o.current_mandate_id FROM public.operations o WHERE o.id = qr.operation_id)
);
CREATE FUNCTION public.bind_quote_request_mandate() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
      OR NEW.mandate_id IS DISTINCT FROM OLD.mandate_id THEN
      RAISE EXCEPTION 'quote request scope is immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.mandate_id IS NULL THEN
      SELECT current_mandate_id INTO NEW.mandate_id FROM public.operations WHERE id = NEW.operation_id;
    END IF;
    IF NEW.mandate_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.mandates
      WHERE id = NEW.mandate_id AND operation_id = NEW.operation_id) THEN
      RAISE EXCEPTION 'quote request requires a mandate for this operation' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quote_requests_bind_mandate BEFORE INSERT OR UPDATE ON public.quote_requests
FOR EACH ROW EXECUTE FUNCTION public.bind_quote_request_mandate();

ALTER TABLE public.tool_command_receipts
  DROP CONSTRAINT tool_command_receipts_tool_name_check,
  ADD CONSTRAINT tool_command_receipts_tool_name_check CHECK (tool_name IN (
    'create_operation', 'update_operation', 'confirm_mandate', 'cancel_operation', 'create_quote', 'decline_quote_request',
    'record_provider_quote' -- Preserve historical receipts from the previous runtime.
  ));

CREATE FUNCTION public.provider_quote_operation(op public.operations) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('operation_reference', op.reference,
    'container_type', op.container_type, 'gross_weight_kg', op.gross_weight_kg,
    'pickup_location', op.pickup_location, 'delivery_location', op.delivery_location,
    'empty_return_depot', op.empty_return_depot, 'operational_constraints', op.operational_constraints,
    'cargo_notes', op.cargo_notes);
$$;

CREATE FUNCTION public.get_provider_quote_tool_state(p_call_id uuid, p_realtime_call_id text, p_provider_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  c public.calls%ROWTYPE;
  op public.operations%ROWTYPE;
  qr public.quote_requests%ROWTYPE;
  q public.quotes%ROWTYPE;
  candidates jsonb := '[]'::jsonb;
  targets jsonb := '{}'::jsonb;
  selected jsonb := NULL;
  last_quote jsonb := NULL;
  profile text;
BEGIN
  SELECT * INTO c FROM public.calls WHERE id = p_call_id AND realtime_call_id = p_realtime_call_id
    AND provider_id = p_provider_id AND persona = 'provider' AND outcome = 'active';
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.providers WHERE id = p_provider_id AND active) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'P0001';
  END IF;
  IF c.operation_id IS NOT NULL THEN
    SELECT * INTO op FROM public.operations o WHERE o.id = c.operation_id
      AND EXISTS (SELECT 1 FROM public.quote_requests r WHERE r.operation_id = o.id AND r.provider_id = p_provider_id);
    IF NOT FOUND THEN RAISE EXCEPTION 'operation_not_available' USING ERRCODE = 'P0001'; END IF;
    selected := public.provider_quote_operation(op);
  END IF;
  IF c.provider_tools_completed_at IS NOT NULL THEN
    profile := 'terminal';
  ELSIF c.provider_intent NOT IN ('undecided', 'quote') THEN
    profile := 'provider_unavailable';
  ELSE
    FOR op IN SELECT o.* FROM public.operations o
      WHERE (c.operation_id IS NULL OR o.id = c.operation_id)
        AND o.status IN ('sourcing', 'quotes_received') AND NOT o.mandate_confirmation_required
        AND o.current_mandate_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM public.quote_requests r WHERE r.operation_id = o.id AND r.provider_id = p_provider_id)
      ORDER BY o.reference LIMIT 50
    LOOP
      -- Latest actionable request for this provider/operation. A replacement
      -- mandate requires a new request, not reuse of the old one.
      SELECT r.* INTO qr FROM public.quote_requests r
      LEFT JOIN LATERAL (SELECT v.* FROM public.quotes v WHERE v.quote_request_id = r.id ORDER BY version DESC LIMIT 1) latest ON true
      WHERE r.operation_id = op.id AND r.provider_id = p_provider_id
        AND r.mandate_id = op.current_mandate_id AND r.expires_at > clock_timestamp()
        AND r.status IN ('pending', 'queued', 'contacted', 'responded')
        AND ((latest.id IS NULL AND r.status <> 'responded') OR
          (latest.verdict = 'contraoferta' AND latest.status = 'received' AND latest.evaluated_mandate_id = op.current_mandate_id))
      ORDER BY r.created_at DESC, r.id DESC LIMIT 1;
      IF NOT FOUND THEN CONTINUE; END IF;
      SELECT * INTO q FROM public.quotes WHERE quote_request_id = qr.id ORDER BY version DESC LIMIT 1;
      candidates := candidates || jsonb_build_array(public.provider_quote_operation(op));
      targets := targets || jsonb_build_object(op.reference, jsonb_build_object(
        'operation_revision', op.updated_at::text, 'quote_request_id', qr.id,
        'mandate_id', op.current_mandate_id, 'previous_quote_id', q.id));
      IF c.operation_id = op.id THEN
        last_quote := CASE WHEN q.id IS NULL THEN NULL ELSE jsonb_build_object(
          'quote_version', q.version, 'verdict', q.verdict,
          'price_range', jsonb_build_object('min', q.price_min, 'max', q.price_max, 'currency', q.currency),
          'negotiation_rounds_remaining', greatest(0, qr.negotiation_limit + 1 -
            (SELECT count(*) FROM public.quotes v WHERE v.quote_request_id = qr.id AND v.verdict = 'contraoferta'))) END;
      END IF;
    END LOOP;
    profile := CASE WHEN jsonb_array_length(candidates) = 0 THEN 'provider_unavailable'
      WHEN c.operation_id IS NULL THEN 'provider_inbound_entry' ELSE 'provider_quote' END;
  END IF;
  RETURN jsonb_build_object('profile', profile, 'intent', c.provider_intent,
    'operation', selected, 'candidates', candidates, 'commandTargets', targets, 'lastQuote', last_quote);
END;
$$;

CREATE FUNCTION public.execute_provider_quote_tool(
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
    IF NOT p_arguments ?& ARRAY['price_range', 'proposed_pickup_window', 'payment_term_days', 'valid_until', 'conditions']
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_arguments) k WHERE k NOT IN (
        'operation_reference', 'price_range', 'proposed_pickup_window', 'payment_term_days', 'valid_until', 'conditions'))
      OR jsonb_typeof(p_arguments->'price_range') <> 'object'
      OR jsonb_typeof(p_arguments->'proposed_pickup_window') <> 'object'
      OR jsonb_typeof(p_arguments->'conditions') <> 'object'
      OR jsonb_typeof(p_arguments->'payment_term_days') <> 'number' THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
    END IF;
    price := p_arguments->'price_range'; proposed := p_arguments->'proposed_pickup_window';
    IF NOT price ?& ARRAY['min', 'max', 'currency'] OR (SELECT count(*) FROM jsonb_object_keys(price)) <> 3
      OR jsonb_typeof(price->'min') <> 'number' OR jsonb_typeof(price->'max') <> 'number'
      OR jsonb_typeof(price->'currency') <> 'string' OR price->>'currency' !~ '^[A-Z]{3}$'
      OR NOT proposed ?& ARRAY['start_at', 'end_at'] OR (SELECT count(*) FROM jsonb_object_keys(proposed)) <> 2
      OR (SELECT count(*) FROM jsonb_object_keys(p_arguments->'conditions')) <> 1
      OR jsonb_typeof(p_arguments->'conditions'->'notes') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
    END IF;
    IF (price->>'min')::numeric <= 0 OR (price->>'max')::numeric < (price->>'min')::numeric
      OR (price->>'max')::numeric > 999999999999.99
      OR round((price->>'min')::numeric, 2) <> (price->>'min')::numeric
      OR round((price->>'max')::numeric, 2) <> (price->>'max')::numeric
      OR (p_arguments->>'payment_term_days')::numeric < 0 OR (p_arguments->>'payment_term_days')::numeric > 2147483647
      OR trunc((p_arguments->>'payment_term_days')::numeric) <> (p_arguments->>'payment_term_days')::numeric THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(jsonb_build_array(proposed->'start_at', proposed->'end_at', p_arguments->'valid_until')) LOOP
      IF jsonb_typeof(item) <> 'string' OR (item #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
        RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
    BEGIN
      start_time := (proposed->>'start_at')::timestamptz;
      end_time := (proposed->>'end_at')::timestamptz;
      expires := (p_arguments->>'valid_until')::timestamptz;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
    END;
    IF start_time >= end_time OR expires <= clock_timestamp() THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_arguments->'conditions'->'notes') note
      WHERE jsonb_typeof(note) <> 'string' OR btrim(note #>> '{}') = '')
      OR (SELECT count(*) <> count(DISTINCT note) FROM jsonb_array_elements(p_arguments->'conditions'->'notes') note) THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
    END IF;
    -- Conservative fixed-condition policy: new free-text conditions cannot be
    -- deterministically declared compatible. Clarify/escalate without consuming
    -- the price negotiation round; never silently drop a provider condition.
    IF price->>'currency' <> mandate.currency
      OR (p_arguments->>'payment_term_days')::numeric < mandate.minimum_payment_term_days
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(mandate.action_windows) w
        WHERE start_time >= (w->>'start_at')::timestamptz AND end_time <= (w->>'end_at')::timestamptz)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_arguments->'conditions'->'notes') note
        WHERE NOT (note = ANY(op.operational_constraints)) AND note IS DISTINCT FROM op.cargo_notes) THEN
      RAISE EXCEPTION 'fixed_terms_conflict' USING ERRCODE = 'P0001';
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
    IF expires <= command_time THEN RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001'; END IF;
    SELECT count(*) INTO counteroffers_used FROM public.quotes prior
    WHERE prior.quote_request_id = qr.id AND prior.verdict = 'contraoferta';
    verdict := CASE WHEN (price->>'max')::numeric <= mandate.price_cap THEN 'dentro'::quote_verdict
      WHEN counteroffers_used < qr.negotiation_limit THEN 'contraoferta'::quote_verdict ELSE 'fuera'::quote_verdict END;
    reason_codes := CASE WHEN verdict = 'dentro' THEN ARRAY[]::text[] ELSE ARRAY['price_outside_terms'] END;
    INSERT INTO public.quotes (quote_request_id, evaluated_mandate_id, version, supersedes_quote_id,
      price_min, price_max, currency, proposed_pickup_window, payment_term_days, valid_until, conditions, verdict, received_at)
    VALUES (qr.id, mandate.id, coalesce(previous_quote.version, 0) + 1, previous_quote.id,
      (price->>'min')::numeric, (price->>'max')::numeric, price->>'currency', proposed,
      (p_arguments->>'payment_term_days')::numeric::integer, expires, p_arguments->'conditions', verdict, command_time)
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

REVOKE ALL ON FUNCTION public.bind_quote_request_mandate(), public.provider_quote_operation(public.operations),
  public.get_provider_quote_tool_state(uuid, text, uuid),
  public.execute_provider_quote_tool(uuid, text, uuid, text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_quote_request_mandate(), public.provider_quote_operation(public.operations),
  public.get_provider_quote_tool_state(uuid, text, uuid),
  public.execute_provider_quote_tool(uuid, text, uuid, text, text, jsonb, jsonb) TO service_role;
COMMIT;
