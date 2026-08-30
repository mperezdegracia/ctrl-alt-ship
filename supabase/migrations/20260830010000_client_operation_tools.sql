-- Client operation/mandate tools. Apply before enabling CLIENT_OPERATION_TOOLS_ENABLED.
-- Keep the existing PostgreSQL-generated UUID and OP reference defaults intact.
ALTER TABLE public.calls ADD COLUMN client_tools_completed_at timestamptz;
-- Historical mandates predate captured Realtime evidence; new tool-created
-- mandates always supply it. No draft mandate table is introduced.
ALTER TABLE public.mandates ADD COLUMN confirmation_evidence jsonb
  CHECK (confirmation_evidence IS NULL OR jsonb_typeof(confirmation_evidence) = 'object');

CREATE TABLE public.tool_command_receipts (
  call_id uuid NOT NULL REFERENCES public.calls(id),
  tool_call_id text NOT NULL CHECK (btrim(tool_call_id) <> ''),
  tool_name text NOT NULL CHECK (tool_name IN ('create_operation', 'update_operation', 'confirm_mandate')),
  arguments jsonb NOT NULL CHECK (jsonb_typeof(arguments) = 'object'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (call_id, tool_call_id)
);
ALTER TABLE public.tool_command_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tool_command_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.tool_command_receipts TO service_role;
REVOKE UPDATE, DELETE ON public.tool_command_receipts FROM service_role;
CREATE TRIGGER tool_command_receipts_append_only
BEFORE UPDATE OR DELETE ON public.tool_command_receipts
FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

CREATE FUNCTION public.operation_missing_fields(op public.operations)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN nullif(btrim(op.container_type), '') IS NULL THEN 'container_type' END,
    CASE WHEN op.gross_weight_kg IS NULL THEN 'gross_weight_kg' END,
    CASE WHEN nullif(btrim(op.pickup_location), '') IS NULL THEN 'pickup_location' END,
    CASE WHEN nullif(btrim(op.delivery_location), '') IS NULL THEN 'delivery_location' END,
    CASE WHEN nullif(btrim(op.empty_return_depot), '') IS NULL THEN 'empty_return_depot' END
  ], NULL);
$$;

CREATE FUNCTION public.client_operation_state(c public.calls)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
DECLARE
  op public.operations%ROWTYPE;
  missing text[];
  profile text;
BEGIN
  IF c.operation_id IS NULL THEN
    RETURN jsonb_build_object('profile', 'client_entry', 'intent', 'undecided', 'operation', NULL);
  END IF;
  SELECT * INTO op FROM public.operations WHERE id = c.operation_id AND contact_id = c.contact_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'P0001'; END IF;
  missing := public.operation_missing_fields(op);
  profile := CASE
    WHEN c.client_tools_completed_at IS NOT NULL OR op.status IN ('cancelled', 'failed') OR c.operation_intent = 'cancel' THEN 'terminal'
    WHEN cardinality(missing) = 0 AND (op.current_mandate_id IS NULL OR op.mandate_confirmation_required) THEN 'client_confirm'
    WHEN c.operation_intent = 'create' THEN 'client_create'
    ELSE 'client_update'
  END;
  RETURN jsonb_build_object(
    'profile', profile, 'intent', c.operation_intent, 'operationRevision', op.updated_at::text,
    'operation', jsonb_build_object(
      'operation_reference', op.reference, 'status', op.status,
      'container_type', op.container_type, 'gross_weight_kg', op.gross_weight_kg,
      'pickup_location', op.pickup_location, 'delivery_location', op.delivery_location,
      'empty_return_depot', op.empty_return_depot,
      'operational_constraints', op.operational_constraints, 'cargo_notes', op.cargo_notes,
      'missing_fields', missing, 'mandate_confirmation_required', op.mandate_confirmation_required
    )
  );
END;
$$;

CREATE FUNCTION public.get_client_operation_tool_state(
  p_call_id uuid, p_realtime_call_id text, p_contact_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE c public.calls%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.calls
  WHERE id = p_call_id AND realtime_call_id = p_realtime_call_id
    AND contact_id = p_contact_id AND persona = 'client' AND outcome = 'active';
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.contacts WHERE id = p_contact_id AND active AND authorized
  ) THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'P0001'; END IF;
  RETURN public.client_operation_state(c);
END;
$$;

CREATE FUNCTION public.execute_client_operation_tool(
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
  evidence jsonb;
  action_window jsonb;
  snapshot jsonb;
  confirmed_time timestamptz;
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
    IF (SELECT count(*) FROM jsonb_object_keys(p_arguments)) <> 4
      OR NOT p_arguments ?& ARRAY['price_cap', 'currency', 'action_windows', 'minimum_payment_term_days']
      OR jsonb_typeof(p_arguments->'price_cap') <> 'number'
      OR jsonb_typeof(p_arguments->'currency') <> 'string'
      OR (p_arguments->>'currency') !~ '^[A-Z]{3}$'
      OR jsonb_typeof(p_arguments->'minimum_payment_term_days') <> 'number'
      OR jsonb_typeof(p_arguments->'action_windows') <> 'array' THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
    END IF;
    IF (p_arguments->>'price_cap')::numeric <= 0
      OR (p_arguments->>'price_cap')::numeric > 999999999999.99
      OR round((p_arguments->>'price_cap')::numeric, 2) <> (p_arguments->>'price_cap')::numeric
      OR (p_arguments->>'minimum_payment_term_days')::numeric < 0
      OR (p_arguments->>'minimum_payment_term_days')::numeric > 2147483647
      OR trunc((p_arguments->>'minimum_payment_term_days')::numeric) <> (p_arguments->>'minimum_payment_term_days')::numeric
      OR jsonb_array_length(p_arguments->'action_windows') = 0 THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
    END IF;
    FOR action_window IN SELECT * FROM jsonb_array_elements(p_arguments->'action_windows') LOOP
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

    -- Trusted sideband context only. Check completeness, never infer consent
    -- from keywords: interpreting the user's explicit approval is the agent's job.
    evidence := p_context->'evidence';
    IF evidence IS NULL OR jsonb_typeof(evidence) <> 'object' THEN
      RAISE EXCEPTION 'confirmation_not_ready' USING ERRCODE = 'P0001';
    END IF;
    FOREACH key IN ARRAY ARRAY['summary_item_id', 'summary_response_id', 'summary_transcript',
      'caller_item_id', 'caller_event_id', 'caller_transcript'] LOOP
      IF NOT evidence ? key OR jsonb_typeof(evidence->key) <> 'string'
        OR btrim(evidence->>key) = '' THEN
        RAISE EXCEPTION 'confirmation_not_ready' USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
    IF NOT evidence ? 'input_audio_end_ms' OR jsonb_typeof(evidence->'input_audio_end_ms') <> 'number' THEN
      RAISE EXCEPTION 'confirmation_not_ready' USING ERRCODE = 'P0001';
    END IF;
    IF (evidence->>'input_audio_end_ms')::numeric < 0
      OR trunc((evidence->>'input_audio_end_ms')::numeric) <> (evidence->>'input_audio_end_ms')::numeric THEN
      RAISE EXCEPTION 'confirmation_not_ready' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM public.mandates
      WHERE confirmed_in_call_id = c.id AND confirmation_evidence->>'caller_item_id' = evidence->>'caller_item_id') THEN
      RAISE EXCEPTION 'confirmation_not_ready' USING ERRCODE = 'P0001';
    END IF;
    IF op.current_mandate_id IS NOT NULL THEN
      SELECT * INTO previous_mandate FROM public.mandates WHERE id = op.current_mandate_id;
    END IF;
    snapshot := jsonb_build_object(
      'container_type', op.container_type, 'gross_weight_kg', op.gross_weight_kg,
      'pickup_location', op.pickup_location, 'delivery_location', op.delivery_location,
      'empty_return_depot', op.empty_return_depot, 'operational_constraints', op.operational_constraints,
      'cargo_notes', op.cargo_notes
    );
    confirmed_time := clock_timestamp();
    INSERT INTO public.mandates (
      operation_id, version, supersedes_mandate_id, price_cap, currency, action_windows,
      minimum_payment_term_days, confirmed_in_call_id, confirmed_at, operation_snapshot, confirmation_evidence
    ) VALUES (
      op.id, coalesce(previous_mandate.version, 0) + 1, previous_mandate.id,
      (p_arguments->>'price_cap')::numeric, p_arguments->>'currency', p_arguments->'action_windows',
      (p_arguments->>'minimum_payment_term_days')::numeric::integer, c.id, confirmed_time, snapshot, evidence
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

REVOKE ALL ON FUNCTION public.operation_missing_fields(public.operations) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.client_operation_state(public.calls) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_client_operation_tool_state(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.execute_client_operation_tool(uuid, text, uuid, text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.operation_missing_fields(public.operations) TO service_role;
GRANT EXECUTE ON FUNCTION public.client_operation_state(public.calls) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_client_operation_tool_state(uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.execute_client_operation_tool(uuid, text, uuid, text, text, jsonb, jsonb) TO service_role;
