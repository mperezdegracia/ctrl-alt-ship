-- Initial sourcing needs the route, not a full dispatch sheet.
-- Runs after the existing 20260830120000 dashboard migration.
-- Unknown weight/empty return remain NULL; do not fabricate logistics facts.
BEGIN;

CREATE OR REPLACE FUNCTION public.operation_missing_fields(op public.operations)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN nullif(btrim(op.pickup_location), '') IS NULL THEN 'pickup_location' END,
    CASE WHEN nullif(btrim(op.delivery_location), '') IS NULL THEN 'delivery_location' END
  ], NULL);
$$;

CREATE OR REPLACE FUNCTION public.is_operation_snapshot(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE constraint_item jsonb;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'object'
     OR NOT value ?& ARRAY[
       'container_type', 'gross_weight_kg', 'pickup_location',
       'delivery_location', 'empty_return_depot',
       'operational_constraints', 'cargo_notes'
     ]
     OR NOT (
       value->'container_type' = 'null'::jsonb
       OR (jsonb_typeof(value->'container_type') = 'string'
         AND btrim(value->>'container_type') <> '')
     )
     OR NOT (
       value->'gross_weight_kg' = 'null'::jsonb
       OR (jsonb_typeof(value->'gross_weight_kg') = 'number'
         AND (value->>'gross_weight_kg')::numeric > 0)
     )
     OR jsonb_typeof(value->'pickup_location') <> 'string'
     OR btrim(value->>'pickup_location') = ''
     OR jsonb_typeof(value->'delivery_location') <> 'string'
     OR btrim(value->>'delivery_location') = ''
     OR NOT (
       value->'empty_return_depot' = 'null'::jsonb
       OR (jsonb_typeof(value->'empty_return_depot') = 'string'
         AND btrim(value->>'empty_return_depot') <> '')
     )
     OR jsonb_typeof(value->'operational_constraints') <> 'array'
     OR NOT (
       value->'cargo_notes' = 'null'::jsonb
       OR (jsonb_typeof(value->'cargo_notes') = 'string'
         AND btrim(value->>'cargo_notes') <> '')
     ) THEN
    RETURN false;
  END IF;
  FOR constraint_item IN SELECT * FROM jsonb_array_elements(value->'operational_constraints') LOOP
    IF jsonb_typeof(constraint_item) <> 'string' OR btrim(constraint_item #>> '{}') = '' THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION validate_operation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allowed boolean := false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.current_mandate_id IS NOT NULL
     AND (
       NEW.container_type IS DISTINCT FROM OLD.container_type
       OR NEW.gross_weight_kg IS DISTINCT FROM OLD.gross_weight_kg
       OR NEW.pickup_location IS DISTINCT FROM OLD.pickup_location
       OR NEW.delivery_location IS DISTINCT FROM OLD.delivery_location
       OR NEW.empty_return_depot IS DISTINCT FROM OLD.empty_return_depot
       OR NEW.operational_constraints IS DISTINCT FROM OLD.operational_constraints
       OR NEW.cargo_notes IS DISTINCT FROM OLD.cargo_notes
     ) THEN
    NEW.mandate_confirmation_required := true;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'draft' THEN NEW.status IN ('collecting_details', 'cancelled')
      WHEN 'collecting_details' THEN NEW.status IN ('sourcing', 'cancelled', 'failed')
      WHEN 'sourcing' THEN NEW.status IN ('quotes_received', 'needs_follow_up', 'cancelled', 'failed')
      WHEN 'quotes_received' THEN NEW.status IN ('quote_selected', 'sourcing', 'needs_follow_up', 'cancelled', 'failed')
      WHEN 'quote_selected' THEN NEW.status IN ('booking_pending', 'sourcing', 'needs_follow_up', 'cancelled', 'failed')
      WHEN 'booking_pending' THEN NEW.status IN ('booking_confirmed', 'sourcing', 'needs_follow_up', 'cancelled', 'failed')
      WHEN 'booking_confirmed' THEN NEW.status IN ('notifications_sent', 'sourcing', 'needs_follow_up', 'cancelled', 'failed')
      WHEN 'notifications_sent' THEN NEW.status IN ('sourcing', 'cancelled', 'failed')
      WHEN 'needs_follow_up' THEN NEW.status IN ('sourcing', 'cancelled', 'failed')
      ELSE false
    END;
    IF NOT allowed THEN
      RAISE EXCEPTION 'invalid operation transition: % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status IN ('sourcing', 'quotes_received', 'quote_selected', 'booking_pending', 'booking_confirmed', 'notifications_sent', 'needs_follow_up')
     AND (NEW.current_mandate_id IS NULL OR nullif(btrim(NEW.pickup_location), '') IS NULL
       OR nullif(btrim(NEW.delivery_location), '') IS NULL) THEN
    RAISE EXCEPTION 'operation is incomplete for status %', NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.execute_client_operation_tool(
  p_call_id uuid, p_realtime_call_id text, p_contact_id uuid,
  p_tool_call_id text, p_tool_name text, p_arguments jsonb, p_context jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  c public.calls%ROWTYPE;
  op public.operations%ROWTYPE;
  previous_op jsonb;
  receipt public.tool_command_receipts%ROWTYPE;
  fields jsonb;
  changes jsonb := '{}'::jsonb;
  key text;
  val jsonb;
  allowed text[] := ARRAY['container_type', 'gross_weight_kg', 'pickup_location',
    'delivery_location', 'empty_return_depot', 'operational_constraints', 'cargo_notes'];
  missing text[];
  linked boolean := false;
  state jsonb;
  result jsonb;
  previous_mandate public.mandates%ROWTYPE;
  new_mandate public.mandates%ROWTYPE;
  action_window jsonb;
  snapshot jsonb;
  confirmed_time timestamptz;
  mandate_terms jsonb;
BEGIN
  IF p_tool_name IS NULL OR p_tool_name NOT IN ('create_operation', 'update_operation', 'confirm_mandate')
     OR p_tool_call_id IS NULL OR btrim(p_tool_call_id) = ''
     OR p_arguments IS NULL OR jsonb_typeof(p_arguments) <> 'object' THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
  END IF;

  -- Serialize commands within a call, including competing first mutations.
  SELECT * INTO c FROM public.calls
  WHERE id = p_call_id AND realtime_call_id = p_realtime_call_id
    AND contact_id = p_contact_id AND persona = 'client' AND outcome = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM public.contacts WHERE id = p_contact_id AND active AND authorized FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'P0001'; END IF;

  -- Replay a committed response before checking the now-locked intent.
  SELECT * INTO receipt FROM public.tool_command_receipts
  WHERE call_id = p_call_id AND tool_call_id = p_tool_call_id;
  IF FOUND THEN
    IF receipt.tool_name <> p_tool_name OR receipt.arguments <> p_arguments THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN receipt.result;
  END IF;

  IF c.client_tools_completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001';
  END IF;

  IF p_tool_name = 'confirm_mandate' THEN
    IF c.operation_id IS NULL OR c.operation_intent NOT IN ('create', 'update') THEN
      RAISE EXCEPTION 'intent_locked' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO op FROM public.operations
    WHERE id = c.operation_id AND contact_id = p_contact_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'operation_not_available' USING ERRCODE = 'P0001'; END IF;
    IF op.status IN ('draft', 'cancelled', 'failed')
      OR cardinality(public.operation_missing_fields(op)) <> 0
      OR (op.current_mandate_id IS NOT NULL AND NOT op.mandate_confirmation_required) THEN
      RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001';
    END IF;
    -- This revision came from the server state used for the spoken summary,
    -- not a model argument. Serialize against other calls and reject stale consent.
    IF p_context->>'expected_operation_revision' IS DISTINCT FROM op.updated_at::text THEN
      RAISE EXCEPTION 'stale_operation' USING ERRCODE = 'P0001';
    END IF;
    -- Only updates with a real current mandate may inherit omitted terms.
    -- Keep p_arguments intact: the idempotency receipt must store the original patch.
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_arguments) AS supplied(key)
      WHERE supplied.key NOT IN ('price_cap', 'currency', 'action_windows', 'minimum_payment_term_days')) THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
    END IF;
    -- No client payment limit means a zero lower bound, not an agreed payment term.
    -- Keep p_arguments untouched for replay; updates still inherit the existing mandate.
    mandate_terms := jsonb_build_object('minimum_payment_term_days', 0) || p_arguments;
    IF op.current_mandate_id IS NOT NULL THEN
      SELECT * INTO previous_mandate FROM public.mandates
        WHERE id = op.current_mandate_id AND operation_id = op.id;
      IF NOT FOUND THEN RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001'; END IF;
      IF c.operation_intent = 'update' THEN
        mandate_terms := jsonb_build_object(
          'price_cap', previous_mandate.price_cap, 'currency', previous_mandate.currency,
          'action_windows', previous_mandate.action_windows,
          'minimum_payment_term_days', previous_mandate.minimum_payment_term_days
        ) || p_arguments;
      END IF;
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(mandate_terms)) <> 4
      OR NOT mandate_terms ?& ARRAY['price_cap', 'currency', 'action_windows', 'minimum_payment_term_days']
      OR jsonb_typeof(mandate_terms->'price_cap') <> 'number'
      OR jsonb_typeof(mandate_terms->'currency') <> 'string'
      OR (mandate_terms->>'currency') !~ '^[A-Z]{3}$'
      OR jsonb_typeof(mandate_terms->'minimum_payment_term_days') <> 'number'
      OR jsonb_typeof(mandate_terms->'action_windows') <> 'array' THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
    END IF;
    IF (mandate_terms->>'price_cap')::numeric <= 0
      OR (mandate_terms->>'price_cap')::numeric > 999999999999.99
      OR round((mandate_terms->>'price_cap')::numeric, 2) <> (mandate_terms->>'price_cap')::numeric
      OR (mandate_terms->>'minimum_payment_term_days')::numeric < 0
      OR (mandate_terms->>'minimum_payment_term_days')::numeric > 2147483647
      OR trunc((mandate_terms->>'minimum_payment_term_days')::numeric) <> (mandate_terms->>'minimum_payment_term_days')::numeric
      OR jsonb_array_length(mandate_terms->'action_windows') = 0 THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
    END IF;
    FOR action_window IN SELECT * FROM jsonb_array_elements(mandate_terms->'action_windows') LOOP
      IF jsonb_typeof(action_window) <> 'object' THEN
        RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
      END IF;
      IF (SELECT count(*) FROM jsonb_object_keys(action_window)) <> 2
        OR NOT action_window ?& ARRAY['start_at', 'end_at'] THEN
        RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
      END IF;
      FOR key, val IN SELECT * FROM jsonb_each(action_window) LOOP
        IF jsonb_typeof(val) <> 'string'
          OR (val #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
          RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
        END IF;
      END LOOP;
      BEGIN
        IF (action_window->>'start_at')::timestamptz >= (action_window->>'end_at')::timestamptz THEN
          RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
        END IF;
      EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
      END;
    END LOOP;

    -- Conversational consent is interpreted by the agent. No audio evidence gate.
    snapshot := jsonb_build_object(
      'container_type', op.container_type, 'gross_weight_kg', op.gross_weight_kg,
      'pickup_location', op.pickup_location, 'delivery_location', op.delivery_location,
      'empty_return_depot', op.empty_return_depot, 'operational_constraints', op.operational_constraints,
      'cargo_notes', op.cargo_notes
    );
    confirmed_time := clock_timestamp();
    INSERT INTO public.mandates (
      operation_id, version, supersedes_mandate_id, price_cap, currency, action_windows,
      minimum_payment_term_days, confirmed_in_call_id, confirmed_at, operation_snapshot
    ) VALUES (
      op.id, coalesce(previous_mandate.version, 0) + 1, previous_mandate.id,
      (mandate_terms->>'price_cap')::numeric, mandate_terms->>'currency', mandate_terms->'action_windows',
      (mandate_terms->>'minimum_payment_term_days')::numeric::integer, c.id, confirmed_time, snapshot
    ) RETURNING * INTO new_mandate;
    UPDATE public.operations SET current_mandate_id = new_mandate.id,
      mandate_confirmation_required = false, status = 'sourcing'
    WHERE id = op.id RETURNING * INTO op;
    UPDATE public.calls SET client_tools_completed_at = confirmed_time WHERE id = c.id;
    INSERT INTO public.events (type, operation_id, call_id, occurred_at, payload) VALUES (
      'mandate.confirmed', op.id, c.id, confirmed_time,
      jsonb_build_object('operation_reference', op.reference, 'mandate_id', new_mandate.id,
        'mandate_version', new_mandate.version)
      || CASE WHEN previous_mandate.id IS NULL THEN '{}'::jsonb
        ELSE jsonb_build_object('supersedes_version', previous_mandate.version) END
    );
    -- Enter the sourcing state. Dispatch/selection workers are a separate tranche;
    -- no provider is contacted and no historical booking is silently overwritten.
    INSERT INTO public.events (type, operation_id, call_id, occurred_at, payload) VALUES (
      'sourcing.started', op.id, c.id, confirmed_time, jsonb_build_object('operation_reference', op.reference,
        'mandate_version', new_mandate.version, 'provider_count', 0,
        'reason', CASE WHEN previous_mandate.id IS NULL THEN 'initial' ELSE 'mandate_changed' END)
    );
    result := jsonb_build_object('operation_reference', op.reference, 'mandate_version', new_mandate.version,
      'status', op.status, 'next_profile', 'terminal');
    INSERT INTO public.tool_command_receipts (call_id, tool_call_id, tool_name, arguments, result)
    VALUES (c.id, p_tool_call_id, p_tool_name, p_arguments, result);
    RETURN result;
  END IF;

  IF p_tool_name = 'create_operation' THEN
    IF c.operation_intent <> 'undecided' OR c.operation_id IS NOT NULL THEN
      RAISE EXCEPTION 'intent_locked' USING ERRCODE = 'P0001';
    END IF;
    fields := p_arguments;
  ELSE
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_arguments) AS keys(k)
      WHERE k NOT IN ('operation_reference', 'changes'))
      OR NOT p_arguments ? 'changes'
      OR jsonb_typeof(p_arguments->'changes') <> 'object'
      OR p_arguments->'changes' = '{}'::jsonb THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
    END IF;
    IF p_arguments ? 'operation_reference' AND (
      jsonb_typeof(p_arguments->'operation_reference') <> 'string'
      OR (p_arguments->>'operation_reference') !~ '^OP-[0-9]{6,}$'
    ) THEN RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001'; END IF;
    IF c.operation_intent NOT IN ('undecided', 'create', 'update') THEN
      RAISE EXCEPTION 'intent_locked' USING ERRCODE = 'P0001';
    END IF;
    fields := p_arguments->'changes';
  END IF;

  -- Validate again at the transaction boundary, even for direct service RPCs.
  FOR key, val IN SELECT * FROM jsonb_each(fields) LOOP
    IF NOT key = ANY(allowed) THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
    ELSIF key = 'gross_weight_kg' THEN
      IF jsonb_typeof(val) <> 'number' THEN
        RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
      END IF;
      IF (val #>> '{}')::numeric <= 0
        OR (val #>> '{}')::numeric > 999999999.999
        OR round((val #>> '{}')::numeric, 3) <> (val #>> '{}')::numeric THEN
        RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
      END IF;
    ELSIF key = 'operational_constraints' THEN
      IF jsonb_typeof(val) <> 'array' THEN
        RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
      END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(val) AS items(item)
        WHERE jsonb_typeof(item) <> 'string' OR btrim(item #>> '{}') = '')
        OR (SELECT count(*) <> count(DISTINCT item) FROM jsonb_array_elements(val) AS items(item)) THEN
        RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
      END IF;
    ELSIF key = 'cargo_notes' AND val = 'null'::jsonb AND p_tool_name = 'update_operation' THEN
      NULL;
    ELSIF jsonb_typeof(val) <> 'string' OR btrim(val #>> '{}') = '' THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  IF p_tool_name = 'create_operation' THEN
    -- Defaults generate BOTH identifiers. Never accept either from the model.
    INSERT INTO public.operations (
      contact_id, status, container_type, gross_weight_kg, pickup_location,
      delivery_location, empty_return_depot, operational_constraints, cargo_notes
    ) VALUES (
      p_contact_id, 'collecting_details', fields->>'container_type',
      (fields->>'gross_weight_kg')::numeric, fields->>'pickup_location',
      fields->>'delivery_location', fields->>'empty_return_depot',
      ARRAY(SELECT jsonb_array_elements_text(coalesce(fields->'operational_constraints', '[]'::jsonb))),
      fields->>'cargo_notes'
    ) RETURNING * INTO op;
    UPDATE public.calls SET operation_id = op.id, operation_intent = 'create'
    WHERE id = c.id RETURNING * INTO c;
    linked := true;
  ELSE
    IF c.operation_id IS NULL AND NOT p_arguments ? 'operation_reference' THEN
      RAISE EXCEPTION 'operation_reference_required' USING ERRCODE = 'P0001';
    END IF;
    -- Lock the operation as well: two different calls must not lose updates.
    SELECT * INTO op FROM public.operations
    WHERE contact_id = p_contact_id
      AND ((c.operation_id IS NOT NULL AND id = c.operation_id)
        OR (c.operation_id IS NULL AND reference = p_arguments->>'operation_reference'))
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'operation_not_available' USING ERRCODE = 'P0001'; END IF;
    IF p_arguments ? 'operation_reference' AND p_arguments->>'operation_reference' <> op.reference THEN
      RAISE EXCEPTION 'intent_locked' USING ERRCODE = 'P0001';
    END IF;
    IF op.status IN ('cancelled', 'failed') THEN
      RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001';
    END IF;
    previous_op := to_jsonb(op);
    FOR key, val IN SELECT * FROM jsonb_each(fields) LOOP
      IF previous_op->key IS DISTINCT FROM val THEN
        changes := changes || jsonb_build_object(key, jsonb_build_object('before', previous_op->key, 'after', val));
      END IF;
    END LOOP;
    IF op.status = 'draft' THEN
      changes := changes || jsonb_build_object('status', jsonb_build_object('before', 'draft', 'after', 'collecting_details'));
    END IF;
    IF c.operation_id IS NULL THEN
      UPDATE public.calls SET operation_id = op.id, operation_intent = 'update'
      WHERE id = c.id RETURNING * INTO c;
      linked := true;
    END IF;
    IF changes <> '{}'::jsonb OR op.status = 'draft' THEN
      UPDATE public.operations SET
        status = CASE WHEN op.status = 'draft' THEN 'collecting_details'::operation_status ELSE op.status END,
        container_type = CASE WHEN fields ? 'container_type' THEN fields->>'container_type' ELSE op.container_type END,
        gross_weight_kg = CASE WHEN fields ? 'gross_weight_kg' THEN (fields->>'gross_weight_kg')::numeric ELSE op.gross_weight_kg END,
        pickup_location = CASE WHEN fields ? 'pickup_location' THEN fields->>'pickup_location' ELSE op.pickup_location END,
        delivery_location = CASE WHEN fields ? 'delivery_location' THEN fields->>'delivery_location' ELSE op.delivery_location END,
        empty_return_depot = CASE WHEN fields ? 'empty_return_depot' THEN fields->>'empty_return_depot' ELSE op.empty_return_depot END,
        operational_constraints = CASE WHEN fields ? 'operational_constraints'
          THEN ARRAY(SELECT jsonb_array_elements_text(fields->'operational_constraints')) ELSE op.operational_constraints END,
        cargo_notes = CASE WHEN fields ? 'cargo_notes' THEN fields->>'cargo_notes' ELSE op.cargo_notes END
      WHERE id = op.id RETURNING * INTO op;
      -- Existing validate_operation trigger marks mandate_confirmation_required
      -- when any operative term of a mandated operation changes.
    END IF;
  END IF;

  missing := public.operation_missing_fields(op);
  state := public.client_operation_state(c);
  IF p_tool_name = 'create_operation' THEN
    result := jsonb_build_object('operation_reference', op.reference, 'status', op.status,
      'missing_fields', missing, 'next_profile', state->>'profile');
    INSERT INTO public.events (type, operation_id, call_id, payload) VALUES (
      'operation.created', op.id, c.id, jsonb_build_object(
        'operation_reference', op.reference, 'status', op.status,
        'provided_fields', ARRAY(SELECT jsonb_object_keys(fields)), 'missing_fields', missing)
    );
  ELSE
    result := jsonb_build_object('operation_reference', op.reference, 'status', op.status,
      'missing_fields', missing, 'mandate_confirmation_required', op.mandate_confirmation_required,
      'next_profile', state->>'profile');
    IF changes <> '{}'::jsonb THEN
      INSERT INTO public.events (type, operation_id, call_id, payload) VALUES (
        'operation.updated', op.id, c.id, jsonb_build_object('operation_reference', op.reference,
          'changes', changes, 'mandate_confirmation_required', op.mandate_confirmation_required)
      );
    END IF;
  END IF;
  IF linked THEN
    INSERT INTO public.events (type, operation_id, call_id, payload) VALUES (
      'call.routed', op.id, c.id, jsonb_build_object('direction', c.direction,
        'persona', c.persona, 'intent', c.operation_intent, 'counterparty_type', 'contact',
        'candidate_operation_references', jsonb_build_array(op.reference))
    );
  END IF;
  INSERT INTO public.tool_command_receipts (call_id, tool_call_id, tool_name, arguments, result)
  VALUES (c.id, p_tool_call_id, p_tool_name, p_arguments, result);
  RETURN result;
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


-- Existing tables/rows, mandate immutability, RPC grants and commercial limits
-- are preserved. This migration does not enqueue or place any calls itself.
NOTIFY pgrst, 'reload schema';
COMMIT;
