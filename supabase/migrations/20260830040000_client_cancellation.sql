-- Client cancellation is terminal and logical. Email delivery AND enqueueing
-- are deliberately disabled. Existing mandates/quotes/commitments stay immutable.
BEGIN;

ALTER TABLE public.tool_command_receipts
  DROP CONSTRAINT tool_command_receipts_tool_name_check,
  ADD CONSTRAINT tool_command_receipts_tool_name_check CHECK (
    tool_name IN ('create_operation', 'update_operation', 'confirm_mandate', 'cancel_operation')
  );

-- A dedicated RPC avoids rewriting the existing create/update/mandate function.
-- Both RPCs serialize on the same call row and share the same receipt namespace.
CREATE FUNCTION public.execute_client_cancellation_tool(
  p_call_id uuid, p_realtime_call_id text, p_contact_id uuid,
  p_tool_call_id text, p_tool_name text, p_arguments jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  c public.calls%ROWTYPE;
  op public.operations%ROWTYPE;
  receipt public.tool_command_receipts%ROWTYPE;
  cancelled_booking public.bookings%ROWTYPE;
  cancelled_time timestamptz;
  result jsonb;
BEGIN
  IF p_tool_name IS DISTINCT FROM 'cancel_operation'
    OR p_tool_call_id IS NULL OR btrim(p_tool_call_id) = ''
    OR p_arguments IS NULL OR jsonb_typeof(p_arguments) <> 'object' THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO c FROM public.calls
  WHERE id = p_call_id AND realtime_call_id = p_realtime_call_id
    AND contact_id = p_contact_id AND persona = 'client' AND outcome = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM public.contacts WHERE id = p_contact_id AND active AND authorized FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'P0001'; END IF;

  -- Replays still work after cancellation hides every tool. Authorization is
  -- rechecked first; a reused ID with different arguments never changes data.
  SELECT * INTO receipt FROM public.tool_command_receipts
  WHERE call_id = c.id AND tool_call_id = p_tool_call_id;
  IF FOUND THEN
    IF receipt.tool_name <> p_tool_name OR receipt.arguments <> p_arguments THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN receipt.result;
  END IF;
  IF c.client_tools_completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001';
  END IF;
  IF c.operation_intent <> 'undecided' OR c.operation_id IS NOT NULL THEN
    RAISE EXCEPTION 'intent_locked' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_arguments)) <> 2
    OR NOT p_arguments ?& ARRAY['operation_reference', 'reason']
    OR jsonb_typeof(p_arguments->'operation_reference') <> 'string'
    OR (p_arguments->>'operation_reference') !~ '^OP-[0-9]{6,}$'
    OR jsonb_typeof(p_arguments->'reason') <> 'string'
    OR btrim(p_arguments->>'reason') = '' THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO op FROM public.operations
  WHERE reference = p_arguments->>'operation_reference' AND contact_id = p_contact_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation_not_available' USING ERRCODE = 'P0001'; END IF;
  IF op.status IN ('cancelled', 'failed') THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001';
  END IF;

  cancelled_time := clock_timestamp();
  UPDATE public.calls SET operation_id = op.id, operation_intent = 'cancel',
    client_tools_completed_at = cancelled_time WHERE id = c.id RETURNING * INTO c;
  UPDATE public.operations SET status = 'cancelled', mandate_confirmation_required = false
  WHERE id = op.id;

  -- Update status only: expired/superseded quotes must not prevent cancellation
  -- of an existing booking. Its historical terms and confirmation stay intact.
  FOR cancelled_booking IN
    UPDATE public.bookings SET status = 'cancelled', cancelled_at = cancelled_time
    WHERE operation_id = op.id AND status IN ('pending', 'confirmed') RETURNING *
  LOOP
    INSERT INTO public.events (type, operation_id, call_id, occurred_at, payload) VALUES (
      'booking.cancelled', op.id, c.id, cancelled_time,
      jsonb_build_object('booking_id', cancelled_booking.id, 'source', 'client',
        'reason', p_arguments->>'reason', 'operation_status', 'cancelled',
        'notification_email_queued', false)
    );
  END LOOP;

  UPDATE public.quote_requests SET status = 'cancelled'
  WHERE operation_id = op.id AND status IN ('pending', 'queued', 'contacted');
  UPDATE public.change_requests SET status = 'rejected', resolved_at = cancelled_time
  WHERE operation_id = op.id AND status IN ('pending', 'escalated');
  -- Retire queued sourcing work without pretending it contacted a provider.
  -- Already-running external work cannot be recalled by this transaction;
  -- dispatchers must recheck operation state immediately before contacting.
  UPDATE public.outbox SET status = 'processed', processed_at = cancelled_time,
    payload = payload || jsonb_build_object('skipped_reason', 'operation_cancelled')
  WHERE operation_id = op.id AND job_type = 'contact_provider' AND status = 'pending';

  INSERT INTO public.events (type, operation_id, call_id, occurred_at, payload) VALUES (
    'operation.cancelled', op.id, c.id, cancelled_time,
    jsonb_build_object('operation_reference', op.reference, 'reason', p_arguments->>'reason',
      'provider_email_queued', false)
  ), (
    'call.routed', op.id, c.id, cancelled_time,
    jsonb_build_object('direction', c.direction, 'persona', c.persona,
      'intent', c.operation_intent, 'counterparty_type', 'contact',
      'candidate_operation_references', jsonb_build_array(op.reference))
  );
  result := jsonb_build_object('operation_reference', op.reference, 'status', 'cancelled',
    'provider_email_queued', false, 'next_profile', 'terminal');
  INSERT INTO public.tool_command_receipts (call_id, tool_call_id, tool_name, arguments, result)
  VALUES (c.id, p_tool_call_id, p_tool_name, p_arguments, result);
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.execute_client_cancellation_tool(uuid, text, uuid, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.execute_client_cancellation_tool(uuid, text, uuid, text, text, jsonb)
  TO service_role;

COMMIT;
