-- Going back closes only the pending review. Keep operation/booking data and
-- the call's existing operation and intent locks; never grant new authority.
BEGIN;

CREATE OR REPLACE FUNCTION public.create_call_escalation(
  p_call_id uuid,
  p_realtime_call_id text,
  p_counterparty_id uuid,
  p_operation_reference text,
  p_trigger text,
  p_reason text,
  p_summary text,
  p_requested_action text,
  p_tool_call_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c public.calls%ROWTYPE;
  op public.operations%ROWTYPE;
  recipient public.handoff_recipients%ROWTYPE;
  receipt public.tool_command_receipts%ROWTYPE;
  escalation_id uuid;
  mandate_snapshot jsonb := 'null'::jsonb;
  booking_snapshot jsonb := 'null'::jsonb;
  arguments_value jsonb;
  result jsonb;
  normalized_reference text := nullif(btrim(coalesce(p_operation_reference, '')), '');
  handoff_state text;
BEGIN
  IF p_tool_call_id IS NULL OR btrim(p_tool_call_id) = ''
     OR p_realtime_call_id IS NULL OR btrim(p_realtime_call_id) = ''
     OR p_trigger NOT IN ('explicit_human_request', 'outside_mandate', 'negotiation_stalled')
     OR p_reason IS NULL OR btrim(p_reason) = '' OR char_length(p_reason) > 500
     OR p_summary IS NULL OR btrim(p_summary) = '' OR char_length(p_summary) > 2_000
     OR p_requested_action IS NULL OR btrim(p_requested_action) = '' OR char_length(p_requested_action) > 500
     OR (normalized_reference IS NOT NULL AND normalized_reference !~ '^OP-[0-9]{6,}$') THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
  END IF;

  arguments_value := jsonb_build_object(
    'operation_reference', normalized_reference,
    'trigger', p_trigger,
    'reason', btrim(p_reason),
    'summary', btrim(p_summary),
    'requested_action', btrim(p_requested_action)
  );
  -- Authorize scope before any replay, serializing with domain commands.
  SELECT * INTO c FROM public.calls WHERE id=p_call_id AND realtime_call_id=p_realtime_call_id
    AND ((persona='client' AND contact_id=p_counterparty_id) OR (persona='provider' AND provider_id=p_counterparty_id));
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE='P0001'; END IF;
  IF c.operation_id IS NOT NULL THEN
    PERFORM 1 FROM public.operations WHERE id=c.operation_id FOR UPDATE;
  ELSIF c.persona='client' THEN
    PERFORM 1 FROM public.operations WHERE reference=normalized_reference AND contact_id=p_counterparty_id FOR UPDATE;
  END IF;
  SELECT * INTO c FROM public.calls WHERE id=p_call_id AND realtime_call_id=p_realtime_call_id
    AND outcome='active'
    AND ((persona='client' AND contact_id=p_counterparty_id) OR (persona='provider' AND provider_id=p_counterparty_id)) FOR UPDATE;
  IF NOT FOUND OR (c.persona='provider' AND NOT EXISTS(SELECT 1 FROM public.providers WHERE id=p_counterparty_id AND active))
    OR (c.persona='client' AND NOT EXISTS(SELECT 1 FROM public.contacts WHERE id=p_counterparty_id AND active AND authorized)) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE='P0001';
  END IF;
  IF c.persona='provider' THEN
    IF c.direction='inbound' AND (c.purpose IS DISTINCT FROM 'booking_management'
      OR c.selected_booking_id IS NULL OR c.provider_intent NOT IN ('reschedule','cancel_booking')) THEN
      RAISE EXCEPTION 'operation_not_available' USING ERRCODE='P0001';
    END IF;
    IF c.operation_id IS NULL OR (c.direction='outbound' AND (c.purpose IS NULL
      OR c.purpose NOT IN ('quote_request','renegotiation','booking_replacement') OR c.quote_request_id IS NULL)) THEN
      RAISE EXCEPTION 'not_authorized' USING ERRCODE='P0001';
    END IF;
  END IF;
  SELECT * INTO receipt FROM public.tool_command_receipts
  WHERE call_id = p_call_id AND tool_call_id = p_tool_call_id;
  IF FOUND THEN
    IF receipt.tool_name = 'escalate' AND receipt.arguments = arguments_value THEN
      IF NOT EXISTS (SELECT 1 FROM public.escalations e
        WHERE e.id = (receipt.result->>'escalation_id')::uuid
          AND e.status = 'started' AND e.handoff_status IN ('pending', 'not_configured')) THEN
        RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001';
      END IF;
      RETURN receipt.result;
    END IF;
    RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'P0001';
  END IF;



  IF c.persona='provider' AND c.direction='inbound'
    AND NOT EXISTS(SELECT 1 FROM public.operations o JOIN public.bookings b ON b.id=o.current_booking_id
      JOIN public.quotes q ON q.id=b.quote_id JOIN public.quote_requests qr ON qr.id=q.quote_request_id
      WHERE o.id=c.operation_id AND b.id=c.selected_booking_id AND qr.provider_id=c.provider_id) THEN
    RAISE EXCEPTION 'stale_operation' USING ERRCODE='P0001';
  END IF;
  IF c.operation_id IS NOT NULL THEN
    SELECT * INTO op FROM public.operations WHERE id = c.operation_id FOR UPDATE;
    IF normalized_reference IS NOT NULL AND op.reference <> normalized_reference THEN
      RAISE EXCEPTION 'intent_locked' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF normalized_reference IS NULL THEN RAISE EXCEPTION 'operation_reference_required' USING ERRCODE = 'P0001'; END IF;
    IF c.persona = 'client' THEN
      SELECT * INTO op FROM public.operations
      WHERE reference = normalized_reference AND contact_id = p_counterparty_id
      FOR UPDATE;
    ELSE
      SELECT * INTO op FROM public.operations o
      WHERE o.reference = normalized_reference
        AND (EXISTS (SELECT 1 FROM public.quote_requests r WHERE r.operation_id = o.id AND r.provider_id = p_counterparty_id)
          OR EXISTS (
            SELECT 1 FROM public.bookings b
            JOIN public.quotes q ON q.id = b.quote_id
            JOIN public.quote_requests r ON r.id = q.quote_request_id
            WHERE b.operation_id = o.id AND b.id = o.current_booking_id AND r.provider_id = p_counterparty_id
          ))
      FOR UPDATE;
    END IF;
    IF NOT FOUND THEN RAISE EXCEPTION 'operation_not_available' USING ERRCODE = 'P0001'; END IF;
    IF c.persona = 'client' THEN
      UPDATE public.calls SET operation_id = op.id, operation_intent = 'update' WHERE id = c.id;
    ELSE
      UPDATE public.calls SET operation_id = op.id, provider_intent = 'escalation' WHERE id = c.id;
    END IF;
  END IF;

  SELECT jsonb_build_object(
    'version', m.version, 'price_cap', m.price_cap, 'currency', m.currency,
    'action_windows', m.action_windows, 'minimum_payment_term_days', m.minimum_payment_term_days
  ) INTO mandate_snapshot
  FROM public.mandates m WHERE m.id = op.current_mandate_id;
  mandate_snapshot := coalesce(mandate_snapshot, 'null'::jsonb);

  SELECT jsonb_build_object(
    'status', b.status, 'reference', b.confirmation_reference,
    'confirmed_price', b.confirmed_price, 'pickup_window_start', b.pickup_window_start,
    'pickup_window_end', b.pickup_window_end, 'provider_name', p.name
  ) INTO booking_snapshot
  FROM public.bookings b
  LEFT JOIN public.quotes q ON q.id = b.quote_id
  LEFT JOIN public.quote_requests r ON r.id = q.quote_request_id
  LEFT JOIN public.providers p ON p.id = r.provider_id
  WHERE b.operation_id = op.id AND b.id = op.current_booking_id
  ORDER BY b.created_at DESC LIMIT 1;
  booking_snapshot := coalesce(booking_snapshot, 'null'::jsonb);

  SELECT * INTO recipient FROM public.handoff_recipients
  WHERE active ORDER BY priority ASC, updated_at ASC, id ASC LIMIT 1;
  handoff_state := CASE WHEN recipient.id IS NULL THEN 'not_configured' ELSE 'pending' END;

  INSERT INTO public.escalations (
    operation_id, source_call_id, mandate_id, reason, trigger,
    handoff_recipient_id, handoff_status
  ) VALUES (
    op.id, c.id, op.current_mandate_id, btrim(p_reason), p_trigger,
    recipient.id, handoff_state
  ) RETURNING id INTO escalation_id;

  INSERT INTO public.escalation_contexts (
    escalation_id, agent_summary, requested_action, verified_snapshot
  ) VALUES (
    escalation_id, btrim(p_summary), btrim(p_requested_action), jsonb_build_object(
      'operation', jsonb_build_object(
        'reference', op.reference, 'status', op.status, 'container_type', op.container_type,
        'gross_weight_kg', op.gross_weight_kg, 'pickup_location', op.pickup_location,
        'delivery_location', op.delivery_location, 'empty_return_depot', op.empty_return_depot,
        'operational_constraints', op.operational_constraints, 'cargo_notes', op.cargo_notes
      ),
      'mandate', mandate_snapshot,
      'booking', booking_snapshot,
      'call', jsonb_build_object('persona', c.persona, 'direction', c.direction, 'started_at', c.started_at)
    )
  );

  INSERT INTO public.events (operation_id, call_id, type, payload)
  VALUES (op.id, c.id, 'escalation.started', jsonb_build_object(
    'escalation_id', escalation_id, 'trigger', p_trigger,
    'handoff_status', handoff_state, 'operation_reference', op.reference
  ));

  result := jsonb_build_object(
    'escalation_id', escalation_id,
    'operation_reference', op.reference,
    'handoff_status', handoff_state,
    'recipient_id', recipient.id,
    'recipient_name', recipient.name,
    'recipient_phone', recipient.phone,
    'recipient_role', recipient.role
  );
  INSERT INTO public.tool_command_receipts (call_id, tool_call_id, tool_name, arguments, result)
  VALUES (c.id, p_tool_call_id, 'escalate', arguments_value, result);
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_call_escalation(
  p_call_id uuid, p_realtime_call_id text, p_counterparty_id uuid, p_escalation_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c public.calls%ROWTYPE;
  e public.escalations%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.calls
    WHERE id = p_call_id AND realtime_call_id = p_realtime_call_id AND outcome = 'active'
      AND ((persona = 'client' AND contact_id = p_counterparty_id)
        OR (persona = 'provider' AND provider_id = p_counterparty_id)) FOR UPDATE;
  IF NOT FOUND OR (c.persona = 'client' AND NOT EXISTS (
      SELECT 1 FROM public.contacts WHERE id = p_counterparty_id AND active AND authorized))
    OR (c.persona = 'provider' AND NOT EXISTS (
      SELECT 1 FROM public.providers WHERE id = p_counterparty_id AND active)) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO e FROM public.escalations
    WHERE id = p_escalation_id AND source_call_id = c.id AND operation_id = c.operation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'P0001'; END IF;
  -- A retried cancellation must not duplicate evidence or affect a newer case.
  IF e.status = 'resolved' AND EXISTS (SELECT 1 FROM public.events
    WHERE call_id = c.id AND type = 'escalation.resolved'
      AND payload->>'escalation_id' = e.id::text AND payload->>'resolution' = 'cancelled') THEN
    RETURN;
  END IF;
  IF e.status <> 'started' OR e.handoff_status NOT IN ('pending', 'not_configured') THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.escalations SET status = 'resolved', resolved_at = now(),
    handoff_status_detail = 'Cancelled by the caller before transfer; continuing with Tango.' WHERE id = e.id;
  INSERT INTO public.events(operation_id, call_id, type, payload)
    VALUES(e.operation_id, c.id, 'escalation.resolved', jsonb_build_object(
      'escalation_id', e.id, 'resolution', 'cancelled', 'source', 'caller',
      'resumed_previous_flow', true));
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_call_escalation(uuid,text,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_call_escalation(uuid,text,uuid,uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
