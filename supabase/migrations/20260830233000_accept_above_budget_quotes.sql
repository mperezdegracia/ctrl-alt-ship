-- An explicit final-price acceptance may exceed the mandate price cap.
-- Preserve the cap, the factual outside verdict and all other eligibility checks.
BEGIN;
ALTER TABLE public.quote_requests ALTER COLUMN negotiation_limit SET DEFAULT 2;
ALTER TABLE public.quotes ADD COLUMN accepted_above_budget boolean NOT NULL DEFAULT false;
ALTER TABLE public.quotes ADD COLUMN negotiation_stopped_by_provider boolean NOT NULL DEFAULT false
  CHECK (NOT negotiation_stopped_by_provider OR accepted_above_budget);
ALTER TABLE public.quotes ADD CONSTRAINT quotes_price_acceptance_verdict_check
  CHECK (NOT accepted_above_budget OR verdict = 'fuera');

CREATE OR REPLACE FUNCTION public.validate_quote_price_acceptance()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.accepted_above_budget AND NOT EXISTS (
    SELECT 1 FROM public.mandates m WHERE m.id=NEW.evaluated_mandate_id
      AND NEW.price_max > m.price_cap AND NEW.currency = m.currency
  ) THEN RAISE EXCEPTION 'invalid_arguments' USING ERRCODE='P0001'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quotes_validate_price_acceptance BEFORE INSERT ON public.quotes
FOR EACH ROW EXECUTE FUNCTION public.validate_quote_price_acceptance();

CREATE OR REPLACE FUNCTION public.validate_price_only_quote_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE previous public.quotes%ROWTYPE;
BEGIN
  IF NEW.supersedes_quote_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO previous FROM public.quotes WHERE id = NEW.supersedes_quote_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001'; END IF;
  IF NEW.currency IS DISTINCT FROM previous.currency
    OR (NEW.proposed_pickup_window->>'start_at')::timestamptz IS DISTINCT FROM (previous.proposed_pickup_window->>'start_at')::timestamptz
    OR (NEW.proposed_pickup_window->>'end_at')::timestamptz IS DISTINCT FROM (previous.proposed_pickup_window->>'end_at')::timestamptz
    OR NEW.payment_term_days IS DISTINCT FROM previous.payment_term_days
    OR NEW.valid_until IS DISTINCT FROM previous.valid_until
    OR NEW.conditions IS DISTINCT FROM previous.conditions THEN
    RAISE EXCEPTION 'fixed_terms_conflict' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.price_min = previous.price_min AND NEW.price_max = previous.price_max
    AND NOT (NEW.accepted_above_budget AND NOT previous.accepted_above_budget)
    AND NOT (previous.verdict = 'contraoferta' AND NOT previous.accepted_above_budget
      AND NEW.verdict IN ('contraoferta', 'fuera') AND NOT NEW.accepted_above_budget) THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION public.get_provider_tool_state(p_call_id uuid,p_realtime_call_id text,p_provider_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
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
  result_profile:=CASE WHEN c.provider_tools_completed_at IS NOT NULL
    AND NOT coalesce(q.verdict='fuera' AND NOT q.accepted_above_budget AND q.status='received', false) THEN 'terminal'
    WHEN authorized THEN 'provider_quote' ELSE 'provider_unavailable' END;
  RETURN jsonb_build_object('flow','provider_outbound','profile',result_profile,'intent','quote',
    'operation',CASE WHEN qr.id IS NOT NULL THEN public.provider_quote_operation(op) ELSE NULL END,
    'commandTarget',CASE WHEN authorized AND result_profile='provider_quote' THEN jsonb_build_object(
      'operation_revision',op.updated_at::text,'quote_request_id',qr.id,'mandate_id',m.id,'round_id',sr.id,'previous_quote_id',q.id) ELSE NULL END,
    'privatePriceLimit',CASE WHEN authorized AND result_profile='provider_quote' THEN jsonb_build_object('price_cap',m.price_cap,'currency',m.currency) ELSE NULL END,
    'lastQuote',CASE WHEN q.id IS NULL THEN NULL ELSE jsonb_build_object('quote_version',q.version,
      'verdict',q.verdict,'accepted_above_budget',q.accepted_above_budget,'negotiation_stopped_by_provider',q.negotiation_stopped_by_provider,'price_range',jsonb_build_object('min',q.price_min,'max',q.price_max,'currency',q.currency),
      'negotiation_rounds_remaining',CASE WHEN q.accepted_above_budget OR q.verdict='dentro' THEN 0
        ELSE greatest(0,least(2,qr.negotiation_limit)-(SELECT count(*) FROM public.quotes z
          WHERE z.quote_request_id=qr.id AND z.evaluated_mandate_id=m.id
            AND z.price_max>m.price_cap AND NOT z.accepted_above_budget)) END,
      'fixed_terms',jsonb_build_object('proposed_pickup_window',q.proposed_pickup_window,'payment_term_days',q.payment_term_days,
        'valid_until',q.valid_until,'conditions',q.conditions)) END,'lastOffer',last_offer);
END; $$;

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
  accept_above_budget boolean := false;
  accepted_above_budget boolean := false;
  stopped_by_provider boolean := false;
BEGIN
  IF p_tool_name IS NULL OR p_tool_name NOT IN ('create_quote', 'decline_quote_request')
    OR p_tool_call_id IS NULL OR btrim(p_tool_call_id) = ''
    OR p_arguments IS NULL OR jsonb_typeof(p_arguments) <> 'object' THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
  END IF;
  IF p_arguments ? 'accept_above_budget' AND (p_tool_name <> 'create_quote'
    OR jsonb_typeof(p_arguments->'accept_above_budget') IS DISTINCT FROM 'boolean') THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
  END IF;
  accept_above_budget := coalesce((p_arguments->>'accept_above_budget')::boolean, false);
  IF p_arguments ? 'negotiation_stopped_by_provider' AND (p_tool_name <> 'create_quote'
    OR jsonb_typeof(p_arguments->'negotiation_stopped_by_provider') IS DISTINCT FROM 'boolean') THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
  END IF;
  stopped_by_provider := coalesce((p_arguments->>'negotiation_stopped_by_provider')::boolean, false);
  IF stopped_by_provider AND NOT accept_above_budget THEN
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
  -- Old calls may have ended bargaining with a rejected price. The current
  -- unaccepted outside quote can still be explicitly accepted or declined.
  IF c.provider_tools_completed_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.quotes q WHERE q.quote_request_id=c.quote_request_id
      AND q.verdict='fuera' AND NOT q.accepted_above_budget AND q.status='received'
      AND NOT EXISTS (SELECT 1 FROM public.quotes next_q WHERE next_q.supersedes_quote_id=q.id)
  ) THEN RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001'; END IF;
  IF c.provider_intent NOT IN ('undecided', 'quote') THEN RAISE EXCEPTION 'intent_locked' USING ERRCODE = 'P0001'; END IF;
  IF p_arguments ? 'operation_reference' AND (jsonb_typeof(p_arguments->'operation_reference') <> 'string'
    OR p_arguments->>'operation_reference' !~ '^OP-[0-9]{6,}$') THEN
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
    OR c.purpose IS DISTINCT FROM (CASE sr.kind WHEN 'initial' THEN 'quote_request'
      WHEN 'renegotiation' THEN 'renegotiation' ELSE 'booking_replacement' END) THEN
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
  IF (previous_quote.id IS NOT NULL AND ((previous_quote.verdict <> 'contraoferta' AND NOT (previous_quote.verdict = 'fuera'
        AND NOT previous_quote.accepted_above_budget AND (accept_above_budget OR p_tool_name = 'decline_quote_request'
          OR CASE WHEN p_tool_name = 'create_quote' AND jsonb_typeof(p_arguments->'price_range'->'max') = 'number'
            THEN (p_arguments->'price_range'->>'max')::numeric <= (SELECT m.price_cap FROM public.mandates m WHERE m.id=op.current_mandate_id)
            ELSE false END)))
      OR previous_quote.status <> 'received'
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
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_arguments) k WHERE k NOT IN ('operation_reference', 'price_range', 'accept_above_budget', 'negotiation_stopped_by_provider'))
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
    WHERE prior.quote_request_id = qr.id AND prior.evaluated_mandate_id = mandate.id
      AND prior.price_max > mandate.price_cap AND NOT prior.accepted_above_budget;
    IF accept_above_budget AND (price->>'max')::numeric > mandate.price_cap
      AND counteroffers_used < least(2,qr.negotiation_limit) AND NOT stopped_by_provider THEN
      RAISE EXCEPTION 'negotiation_required' USING ERRCODE = 'P0001';
    END IF;
    accepted_above_budget := accept_above_budget AND (price->>'max')::numeric > mandate.price_cap;
    verdict := CASE WHEN (price->>'max')::numeric <= mandate.price_cap THEN 'dentro'::quote_verdict
      WHEN accepted_above_budget THEN 'fuera'::quote_verdict
      WHEN counteroffers_used + 1 < least(2,qr.negotiation_limit) THEN 'contraoferta'::quote_verdict ELSE 'fuera'::quote_verdict END;
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
      price_min, price_max, currency, proposed_pickup_window, payment_term_days, valid_until, conditions, verdict, received_at, accepted_above_budget, negotiation_stopped_by_provider)
    VALUES (qr.id, mandate.id, coalesce(previous_quote.version, 0) + 1, previous_quote.id,
      (price->>'min')::numeric, (price->>'max')::numeric, price->>'currency', proposed,
      payment_days, expires, quote_conditions, verdict, command_time, accepted_above_budget, accepted_above_budget AND stopped_by_provider)
    RETURNING * INTO new_quote;
    UPDATE public.quote_requests SET status = 'responded' WHERE id = qr.id;
    IF (verdict = 'dentro' OR accepted_above_budget) AND op.status = 'sourcing' THEN
      UPDATE public.operations SET status = 'quotes_received' WHERE id = op.id;
    END IF;
    result := jsonb_build_object('operation_reference', op.reference, 'quote_version', new_quote.version,
      'verdict', verdict, 'accepted_above_budget', accepted_above_budget, 'negotiation_stopped_by_provider', accepted_above_budget AND stopped_by_provider, 'reason_codes', reason_codes, 'negotiation_remaining', verdict = 'contraoferta',
      'negotiation_rounds_remaining', CASE WHEN verdict = 'contraoferta' THEN least(2,qr.negotiation_limit) - counteroffers_used - 1 ELSE 0 END);
    INSERT INTO public.events (type, operation_id, call_id, occurred_at, schema_version, payload) VALUES (
      'quote.received', op.id, c.id, command_time, 2, result || jsonb_build_object('quote_id', new_quote.id,
        'round_id',sr.id,'offer_event_id',offer_event_id,
        'quote_request_id', qr.id, 'price_range', price, 'proposed_pickup_window', proposed,
        'payment_term_days', new_quote.payment_term_days, 'valid_until', expires));
    IF verdict = 'contraoferta' THEN
      INSERT INTO public.events (type, operation_id, call_id, occurred_at, payload) VALUES (
        'quote.counteroffer_requested', op.id, c.id, command_time, jsonb_build_object(
          'quote_id', new_quote.id, 'quote_version', new_quote.version, 'reason_codes', reason_codes,
          'negotiation_remaining', true, 'negotiation_rounds_remaining', least(2,qr.negotiation_limit) - counteroffers_used - 1));
    END IF;
  END IF;
  IF p_tool_name = 'decline_quote_request' OR verdict = 'dentro' OR accepted_above_budget THEN
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
      AND (q.verdict = 'dentro' OR (q.verdict = 'fuera' AND q.accepted_above_budget)) AND q.status = 'received' AND q.evaluated_mandate_id = m.id
      AND (q.valid_until IS NULL OR q.valid_until > clock_timestamp()) AND q.currency = m.currency
      AND (op.container_type IS NULL OR coalesce(p.capabilities->'equipment', '[]'::jsonb) ? op.container_type)
      AND (q.price_max <= m.price_cap OR q.accepted_above_budget) AND (q.payment_term_days >= m.minimum_payment_term_days OR (q.payment_term_days IS NULL AND m.minimum_payment_term_days = 0))
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
      AND (q.verdict = 'dentro' OR (q.verdict = 'fuera' AND q.accepted_above_budget)) AND q.status = 'received' AND q.evaluated_mandate_id = m.id
      AND (q.valid_until IS NULL OR q.valid_until > clock_timestamp()) AND q.currency = m.currency
      AND (op.container_type IS NULL OR coalesce(p.capabilities->'equipment', '[]'::jsonb) ? op.container_type)
      AND (q.price_max <= m.price_cap OR q.accepted_above_budget) AND (q.payment_term_days >= m.minimum_payment_term_days OR (q.payment_term_days IS NULL AND m.minimum_payment_term_days = 0))
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
    'policy_version', 'two-attempt-price-acceptance-v1',
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
      'price_max', winning.price_max, 'currency', winning.currency, 'accepted_above_budget', winning.accepted_above_budget, 'negotiation_stopped_by_provider', winning.negotiation_stopped_by_provider, 'judge_review_id', reviewed.id, 'selection_rule',
      CASE WHEN winning.received_at > dispatched + interval '5 minutes'
        THEN 'first_valid_after_deadline' ELSE 'lowest_valid_price_max' END)),
    ('booking.confirmed', op.id, source_call, jsonb_build_object('booking_id', booking_id, 'quote_id', winning.id,
      'confirmed_price', winning.price_max, 'currency', winning.currency, 'accepted_above_budget', winning.accepted_above_budget, 'negotiation_stopped_by_provider', winning.negotiation_stopped_by_provider, 'pickup_window', winning.proposed_pickup_window,
      'payment_term_days', winning.payment_term_days, 'commitment_created', false));
  RETURN jsonb_build_object('finalized', true, 'selected', true, 'round_id', active_round_id, 'judge_review_id', reviewed.id, 'booking_id', booking_id, 'quote_id', winning.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_booking() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  q public.quotes%ROWTYPE;
  op public.operations%ROWTYPE;
  request_operation uuid;
  previous public.bookings%ROWTYPE;
BEGIN
  SELECT * INTO q FROM public.quotes WHERE id = NEW.quote_id;
  SELECT operation_id INTO request_operation FROM public.quote_requests WHERE id = q.quote_request_id;
  SELECT * INTO op FROM public.operations WHERE id = NEW.operation_id FOR UPDATE;
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'bookings are append-only' USING ERRCODE = '55000'; END IF;
  SELECT * INTO previous FROM public.bookings WHERE id = op.current_booking_id;
  -- An agreed booking may outlive its quote's expiry. Window-only changes
  -- require a freshly applied change request; do not weaken creation checks.
  IF NEW.last_change_request_id IS NOT NULL THEN
    IF previous.id IS NULL OR previous.status <> 'confirmed' OR NEW.status <> 'confirmed' THEN
      RAISE EXCEPTION 'booking reschedule requires the current booking' USING ERRCODE = '23514';
    END IF;
    IF NEW.operation_id IS DISTINCT FROM previous.operation_id OR NEW.quote_id IS DISTINCT FROM previous.quote_id
      OR NEW.confirmed_price IS DISTINCT FROM previous.confirmed_price
      OR NEW.payment_term_days IS DISTINCT FROM previous.payment_term_days
      OR NEW.payment_term_anchor IS DISTINCT FROM previous.payment_term_anchor
      OR NEW.confirmed_at IS DISTINCT FROM previous.confirmed_at
      OR NEW.confirmation_reference IS DISTINCT FROM previous.confirmation_reference
      OR request_operation IS DISTINCT FROM NEW.operation_id
      OR op.status NOT IN ('booking_confirmed', 'notifications_sent')
      OR q.verdict <> 'dentro' OR q.status <> 'received'
      OR EXISTS (SELECT 1 FROM public.quotes successor WHERE successor.supersedes_quote_id = q.id)
      OR op.mandate_confirmation_required OR q.evaluated_mandate_id IS DISTINCT FROM op.current_mandate_id
      OR NOT EXISTS (SELECT 1 FROM public.change_requests cr
        WHERE cr.id = NEW.last_change_request_id AND cr.booking_id = previous.id AND cr.operation_id = previous.operation_id
          AND cr.source_call_id IS NOT DISTINCT FROM NEW.source_call_id
          AND cr.type = 'reschedule' AND cr.status = 'applied' AND cr.verdict = 'dentro'
          AND cr.evaluated_mandate_id = op.current_mandate_id AND cr.requested_at >= previous.updated_at
          AND (cr.previous_pickup_window->>'start_at')::timestamptz = previous.pickup_window_start
          AND (cr.previous_pickup_window->>'end_at')::timestamptz = previous.pickup_window_end
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
  IF request_operation IS DISTINCT FROM NEW.operation_id
    OR (q.verdict <> 'dentro' AND NOT (q.verdict = 'fuera' AND q.accepted_above_budget)) OR q.status <> 'received'
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

REVOKE ALL ON FUNCTION public.validate_quote_price_acceptance() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_quote_price_acceptance() TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
