BEGIN;

-- Keep cancellation delivery on the same durable outbox as booking
-- confirmations. The function is deliberately generic because an operation
-- cancellation may not have a booking at all.
CREATE OR REPLACE FUNCTION public.enqueue_sms_outbox(
  p_operation_id uuid,
  p_booking_id uuid,
  p_template text,
  p_recipient_type text,
  p_recipient_name text,
  p_recipient_phone text,
  p_recipient_phone_type text,
  p_payload jsonb,
  p_idempotency_key text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  queued_outbox_id uuid;
BEGIN
  INSERT INTO public.outbox (operation_id, job_type, payload, idempotency_key)
  VALUES (
    p_operation_id,
    'send_sms',
    p_payload || jsonb_build_object(
      'template', p_template,
      'recipient_type', p_recipient_type,
      'recipient_name', p_recipient_name,
      'recipient_phone', p_recipient_phone,
      'recipient_phone_type', p_recipient_phone_type,
      'booking_id', p_booking_id
    ),
    p_idempotency_key
  ) ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO queued_outbox_id;

  IF queued_outbox_id IS NOT NULL THEN
    INSERT INTO public.events (operation_id, type, payload)
    VALUES (
      p_operation_id,
      'sms.queued',
      jsonb_build_object(
        'outbox_id', queued_outbox_id,
        'template', p_template,
        'recipient_type', p_recipient_type,
        'deduplication_key', p_idempotency_key
      )
    );
    RETURN queued_outbox_id;
  END IF;

  SELECT id INTO queued_outbox_id FROM public.outbox WHERE idempotency_key = p_idempotency_key;
  RETURN queued_outbox_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.execute_client_cancellation_tool(
  p_call_id uuid, p_realtime_call_id text, p_contact_id uuid,
  p_tool_call_id text, p_tool_name text, p_arguments jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  c public.calls%ROWTYPE;
  op public.operations%ROWTYPE;
  receipt public.tool_command_receipts%ROWTYPE;
  current_booking_id uuid;
  confirmed_booking record;
  has_confirmed_booking boolean := false;
  booking_context jsonb := '{}'::jsonb;
  client_name text;
  client_phone text;
  client_phone_type text;
  client_sms_outbox_id uuid;
  provider_sms_outbox_id uuid;
  cancellation_payload jsonb;
  cancelled_time timestamptz;
  result jsonb;
BEGIN
  IF p_tool_name IS DISTINCT FROM 'cancel_operation'
    OR p_tool_call_id IS NULL OR btrim(p_tool_call_id) = ''
    OR p_arguments IS NULL OR jsonb_typeof(p_arguments) <> 'object' THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1 FROM public.operations WHERE reference = p_arguments->>'operation_reference'
    AND contact_id = p_contact_id FOR UPDATE;
  SELECT * INTO c FROM public.calls
  WHERE id = p_call_id AND realtime_call_id = p_realtime_call_id
    AND contact_id = p_contact_id AND persona = 'client' AND outcome = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'P0001'; END IF;
  PERFORM 1 FROM public.contacts WHERE id = p_contact_id AND active AND authorized FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'P0001'; END IF;

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

  SELECT name, phone, CASE WHEN phone LIKE '+549%' THEN 'mobile' ELSE NULL END
  INTO client_name, client_phone, client_phone_type
  FROM public.contacts
  WHERE id = p_contact_id;

  -- The pointer is the authority for an active booking. Query its provider
  -- before clearing it, but only notify a provider when the booking had been
  -- confirmed; a pending booking is not a dispatch commitment.
  SELECT booking.id
  INTO current_booking_id
  FROM public.bookings AS booking
  WHERE booking.id = op.current_booking_id AND booking.operation_id = op.id
  FOR SHARE;

  SELECT
    booking.id,
    booking.confirmation_reference,
    booking.pickup_window_start,
    booking.pickup_window_end,
    provider.name AS provider_name,
    provider.phone AS provider_phone,
    CASE
      WHEN provider.capabilities->>'phone_type' IN ('mobile', 'landline')
        THEN provider.capabilities->>'phone_type'
      WHEN provider.phone LIKE '+549%' THEN 'mobile'
      ELSE NULL
    END AS provider_phone_type
  INTO confirmed_booking
  FROM public.bookings AS booking
  JOIN public.quotes AS quote ON quote.id = booking.quote_id
  JOIN public.quote_requests AS quote_request ON quote_request.id = quote.quote_request_id
  JOIN public.providers AS provider ON provider.id = quote_request.provider_id
  WHERE booking.id = op.current_booking_id
    AND booking.operation_id = op.id
    AND booking.status = 'confirmed'
  FOR SHARE OF booking;
  has_confirmed_booking := FOUND;

  IF has_confirmed_booking THEN
    booking_context := jsonb_build_object(
      'confirmation_reference', confirmed_booking.confirmation_reference,
      'pickup_window_start', confirmed_booking.pickup_window_start,
      'pickup_window_end', confirmed_booking.pickup_window_end,
      'container_type', op.container_type,
      'gross_weight_kg', op.gross_weight_kg,
      'pickup_location', op.pickup_location,
      'delivery_location', op.delivery_location,
      'client_name', client_name,
      'provider_name', confirmed_booking.provider_name
    );
  END IF;
  cancellation_payload := jsonb_build_object(
    'operation_reference', op.reference,
    'reason', p_arguments->>'reason',
    'booking', booking_context
  );

  cancelled_time := clock_timestamp();
  UPDATE public.calls SET operation_id = op.id, operation_intent = 'cancel',
    client_tools_completed_at = cancelled_time WHERE id = c.id RETURNING * INTO c;
  UPDATE public.operations SET status = 'cancelled', current_booking_id = NULL, mandate_confirmation_required = false
  WHERE id = op.id;

  client_sms_outbox_id := public.enqueue_sms_outbox(
    op.id,
    NULL,
    'operation_cancellation_client',
    'client',
    client_name,
    client_phone,
    client_phone_type,
    cancellation_payload,
    'operation-cancellation-sms:' || op.id || ':client'
  );

  IF has_confirmed_booking THEN
    provider_sms_outbox_id := public.enqueue_sms_outbox(
      op.id,
      confirmed_booking.id,
      'booking_cancellation_provider',
      'provider',
      confirmed_booking.provider_name,
      confirmed_booking.provider_phone,
      confirmed_booking.provider_phone_type,
      cancellation_payload,
      'booking-cancellation-sms:' || confirmed_booking.id || ':provider'
    );
  END IF;

  IF current_booking_id IS NOT NULL THEN
    INSERT INTO public.events (type, operation_id, call_id, occurred_at, payload) VALUES (
      'booking.cancelled', op.id, c.id, cancelled_time,
      jsonb_build_object('booking_id', current_booking_id, 'source', 'client',
        'reason', p_arguments->>'reason', 'operation_status', 'cancelled',
        'notification_sms_queued', provider_sms_outbox_id IS NOT NULL)
    );
  END IF;

  UPDATE public.quote_requests SET status = 'cancelled'
  WHERE operation_id = op.id AND status IN ('pending', 'queued', 'contacted');
  UPDATE public.change_requests SET status = 'rejected', resolved_at = cancelled_time
  WHERE operation_id = op.id AND status IN ('pending', 'escalated');
  UPDATE public.outbox SET status = 'processed', processed_at = cancelled_time,
    payload = payload || jsonb_build_object('skipped_reason', 'operation_cancelled')
  WHERE operation_id = op.id AND job_type = 'contact_provider' AND status = 'pending';

  INSERT INTO public.events (type, operation_id, call_id, occurred_at, payload) VALUES (
    'operation.cancelled', op.id, c.id, cancelled_time,
    jsonb_build_object('operation_reference', op.reference, 'reason', p_arguments->>'reason',
      'client_sms_queued', client_sms_outbox_id IS NOT NULL,
      'provider_sms_queued', provider_sms_outbox_id IS NOT NULL)
  ), (
    'call.routed', op.id, c.id, cancelled_time,
    jsonb_build_object('direction', c.direction, 'persona', c.persona,
      'intent', c.operation_intent, 'counterparty_type', 'contact',
      'candidate_operation_references', jsonb_build_array(op.reference))
  );
  result := jsonb_build_object('operation_reference', op.reference, 'status', 'cancelled',
    'client_sms_queued', client_sms_outbox_id IS NOT NULL,
    'provider_sms_queued', provider_sms_outbox_id IS NOT NULL,
    'next_profile', 'terminal');
  INSERT INTO public.tool_command_receipts (call_id, tool_call_id, tool_name, arguments, result)
  VALUES (c.id, p_tool_call_id, p_tool_name, p_arguments, result);
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_sms_outbox(uuid, uuid, text, text, text, text, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.execute_client_cancellation_tool(uuid, text, uuid, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_sms_outbox(uuid, uuid, text, text, text, text, text, jsonb, text),
  public.execute_client_cancellation_tool(uuid, text, uuid, text, text, jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
