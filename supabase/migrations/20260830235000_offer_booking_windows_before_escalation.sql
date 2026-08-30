-- Offer valid pickup options before human review for schedule conflicts.
BEGIN;
ALTER TABLE public.tool_command_receipts DROP CONSTRAINT tool_command_receipts_tool_name_check;
ALTER TABLE public.tool_command_receipts ADD CONSTRAINT tool_command_receipts_tool_name_check CHECK (
  tool_name IN ('create_operation','update_operation','confirm_mandate','cancel_operation',
    'create_quote','decline_quote_request','reschedule_booking','cancel_booking',
    'record_provider_quote','select_booking_for_reschedule','select_booking_for_cancellation',
    'record_provider_offer','escalate','decline_reschedule_alternatives')
);

CREATE OR REPLACE FUNCTION public.provider_booking_alternative_windows(windows jsonb)
RETURNS jsonb LANGUAGE sql STABLE STRICT SET search_path=public,pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'start_at',to_char(start_time AT TIME ZONE utc_offset::interval,'YYYY-MM-DD"T"HH24:MI:SS'),
    'end_at',to_char(end_time AT TIME ZONE utc_offset::interval,'YYYY-MM-DD"T"HH24:MI:SS')
  ) ORDER BY start_time),'[]'::jsonb)
  FROM (
    SELECT greatest((w->>'start_at')::timestamptz,statement_timestamp()+interval '1 minute') start_time,
      (w->>'end_at')::timestamptz end_time,public.mandate_pickup_utc_offset(windows) utc_offset
    FROM jsonb_array_elements(windows) w
  ) options WHERE start_time<end_time AND utc_offset IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.provider_booking_alternative_windows(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.provider_booking_alternative_windows(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.get_provider_inbound_tool_state(
  p_call_id uuid,p_realtime_call_id text,p_provider_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE c public.calls%ROWTYPE; op public.operations%ROWTYPE; b public.bookings%ROWTYPE;
  bookings jsonb:='[]'::jsonb; selected jsonb; target jsonb; last_result jsonb;
BEGIN
  SELECT * INTO c FROM public.calls WHERE id=p_call_id AND realtime_call_id=p_realtime_call_id
    AND provider_id=p_provider_id AND persona='provider' AND direction='inbound'
    AND purpose='booking_management' AND outcome='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE='P0001'; END IF;
  PERFORM 1 FROM public.providers WHERE id=p_provider_id AND active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE='P0001'; END IF;
  IF c.direction='inbound' AND c.purpose='booking_management' AND c.selected_booking_id IS NOT NULL THEN
    SELECT o.* INTO op FROM public.operations o WHERE o.id=c.operation_id;
    SELECT bk.* INTO b FROM public.bookings bk JOIN public.quotes q ON q.id=bk.quote_id
      JOIN public.quote_requests qr ON qr.id=q.quote_request_id
      WHERE bk.id=c.selected_booking_id AND bk.id=op.current_booking_id AND qr.provider_id=p_provider_id;
    IF FOUND THEN
      selected:=jsonb_build_object('operation',public.provider_quote_operation(op),
        'pickup_window',jsonb_build_object('start_at',b.pickup_window_start,'end_at',b.pickup_window_end),'confirmed_price',b.confirmed_price,
        'pickup_utc_offset',(SELECT public.mandate_pickup_utc_offset(m.action_windows)
          FROM public.mandates m WHERE m.id=op.current_mandate_id AND m.operation_id=op.id),
        'currency',(SELECT q.currency FROM public.quotes q WHERE q.id=b.quote_id),'payment_term_days',b.payment_term_days,
        'requires_reconfirmation',op.mandate_confirmation_required OR EXISTS (
          SELECT 1 FROM public.quotes q WHERE q.id=b.quote_id
            AND q.evaluated_mandate_id IS DISTINCT FROM op.current_mandate_id));
      target:=jsonb_build_object('booking_id',b.id,'operation_revision',op.updated_at::text,'mandate_id',op.current_mandate_id);
    END IF;
  ELSIF c.direction='inbound' AND c.purpose='booking_management' AND c.operation_id IS NULL THEN
    SELECT jsonb_agg(jsonb_build_object('operation_reference',o.reference,'pickup_location',o.pickup_location,'delivery_location',o.delivery_location,
      'pickup_window',jsonb_build_object('start_at',bk.pickup_window_start,'end_at',bk.pickup_window_end))
      ORDER BY o.reference) INTO bookings
    FROM public.operations o JOIN public.bookings bk ON bk.id=o.current_booking_id
    JOIN public.quotes q ON q.id=bk.quote_id JOIN public.quote_requests qr ON qr.id=q.quote_request_id
    WHERE qr.provider_id=p_provider_id AND bk.status='confirmed'
      AND o.status NOT IN ('draft','collecting_details','cancelled','failed');
  END IF;
  SELECT receipt.result INTO last_result
    FROM public.tool_command_receipts receipt
    WHERE receipt.call_id=c.id AND receipt.tool_name IN ('reschedule_booking','cancel_booking','decline_reschedule_alternatives')
    ORDER BY receipt.created_at DESC LIMIT 1;
  IF last_result->>'status'='alternatives_available' THEN
    IF EXISTS (SELECT 1 FROM public.change_requests cr WHERE cr.source_call_id=c.id
      AND cr.status='pending' AND cr.booking_id=b.id AND cr.evaluated_mandate_id=op.current_mandate_id) THEN
      last_result:=last_result || jsonb_build_object('available_pickup_local_windows',
        (SELECT public.provider_booking_alternative_windows(m.action_windows) FROM public.mandates m WHERE m.id=op.current_mandate_id));
      IF jsonb_array_length(last_result->'available_pickup_local_windows')=0 THEN
        last_result:=jsonb_build_object('status','requires_escalation','reason_code','no_available_pickup_windows','commitment_created',false);
      END IF;
    ELSE
      last_result:=NULL; -- New mandate/booking invalidates previously offered windows.
    END IF;
  END IF;
  RETURN jsonb_build_object('flow','provider_inbound',
    'profile',CASE WHEN c.outcome <> 'active' OR c.provider_tools_completed_at IS NOT NULL THEN 'terminal'
      WHEN c.selected_booking_id IS NOT NULL AND selected IS NULL THEN 'provider_unavailable'
      WHEN c.selected_booking_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.change_requests cr WHERE cr.source_call_id=c.id AND cr.status='escalated') THEN 'provider_booking_escalation'
      WHEN last_result->>'status'='alternatives_available' THEN 'provider_reschedule_alternatives'
      WHEN last_result->>'reason_code'='no_available_pickup_windows' THEN 'provider_booking_escalation'
      WHEN c.selected_booking_id IS NOT NULL THEN CASE c.provider_intent WHEN 'reschedule' THEN 'provider_reschedule' WHEN 'cancel_booking' THEN 'provider_cancel_booking' ELSE 'provider_booking_escalation' END
      WHEN coalesce(c.provider_intent,'undecided') NOT IN ('undecided','reschedule','cancel_booking') THEN 'provider_unavailable'
      ELSE 'provider_inbound_entry' END,
    'intent',coalesce(c.provider_intent,'undecided'),'bookings',coalesce(bookings,'[]'::jsonb),
    'selectedBooking',selected,'commandTarget',target,'lastResult',last_result);
END; $$;


CREATE OR REPLACE FUNCTION public.execute_provider_booking_tool_legacy(
  p_call_id uuid, p_realtime_call_id text, p_provider_id uuid,
  p_tool_call_id text, p_tool_name text, p_arguments jsonb, p_context jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  c public.calls%ROWTYPE;
  op public.operations%ROWTYPE;
  b public.bookings%ROWTYPE;
  q public.quotes%ROWTYPE;
  m public.mandates%ROWTYPE;
  cr public.change_requests%ROWTYPE;
  receipt public.tool_command_receipts%ROWTYPE;
  requested_intent public.provider_operation_intent;
  proposed jsonb;
  previous_window jsonb;
  pickup_offset text;
  local_window boolean;
  alternatives jsonb := '[]'::jsonb;
  item jsonb;
  start_time timestamptz;
  end_time timestamptz;
  command_time timestamptz;
  reason_code text := NULL;
  linked boolean := false;
  successor_id uuid;
  scope_operation_id uuid;
  result jsonb;
BEGIN
  IF p_tool_name IS NULL OR p_tool_name NOT IN ('reschedule_booking', 'cancel_booking', 'decline_reschedule_alternatives')
    OR p_tool_call_id IS NULL OR btrim(p_tool_call_id) = ''
    OR p_arguments IS NULL OR jsonb_typeof(p_arguments) <> 'object' THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
  END IF;
  SELECT operation_id INTO scope_operation_id FROM public.calls WHERE id = p_call_id
    AND realtime_call_id = p_realtime_call_id AND provider_id = p_provider_id AND persona = 'provider' AND direction = 'inbound';
  IF scope_operation_id IS NOT NULL THEN PERFORM 1 FROM public.operations WHERE id = scope_operation_id FOR UPDATE; END IF;
  SELECT * INTO c FROM public.calls WHERE id = p_call_id AND realtime_call_id = p_realtime_call_id
    AND provider_id = p_provider_id AND persona = 'provider' AND direction = 'inbound' AND outcome = 'active' FOR UPDATE;
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
  requested_intent := CASE WHEN p_tool_name IN ('reschedule_booking','decline_reschedule_alternatives') THEN 'reschedule'::provider_operation_intent ELSE 'cancel_booking'::provider_operation_intent END;
  IF c.provider_intent <> requested_intent OR c.operation_id IS NULL THEN RAISE EXCEPTION 'intent_locked' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM public.change_requests r WHERE r.source_call_id = c.id AND r.status = 'escalated') THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001';
  END IF;
  IF NOT p_arguments ? 'reason' OR jsonb_typeof(p_arguments->'reason') <> 'string' OR btrim(p_arguments->>'reason') = ''
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_arguments) k WHERE k <> 'operation_reference' AND k <> 'reason'
      AND NOT (p_tool_name = 'reschedule_booking' AND k IN ('proposed_pickup_window', 'proposed_pickup_local_window')))
    OR (p_arguments ? 'operation_reference' AND (jsonb_typeof(p_arguments->'operation_reference') <> 'string'
      OR p_arguments->>'operation_reference' !~ '^OP-[0-9]{6,}$')) THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
  END IF;
  IF c.operation_id IS NULL AND NOT p_arguments ? 'operation_reference' THEN
    RAISE EXCEPTION 'operation_reference_required' USING ERRCODE = 'P0001';
  END IF;
  -- Match ownership through the booking's actual quote request; a caller cannot
  -- cancel another carrier's booking merely by having quoted the same operation.
  SELECT * INTO op FROM public.operations o WHERE
    ((c.operation_id IS NOT NULL AND o.id = c.operation_id) OR (c.operation_id IS NULL AND o.reference = p_arguments->>'operation_reference'))
    AND EXISTS (SELECT 1 FROM public.bookings bk JOIN public.quotes qt ON qt.id = bk.quote_id
      JOIN public.quote_requests qr ON qr.id = qt.quote_request_id
      WHERE bk.operation_id = o.id AND qr.operation_id = o.id AND qr.provider_id = p_provider_id AND bk.id = o.current_booking_id)
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation_not_available' USING ERRCODE = 'P0001'; END IF;
  IF p_arguments ? 'operation_reference' AND p_arguments->>'operation_reference' <> op.reference THEN
    RAISE EXCEPTION 'intent_locked' USING ERRCODE = 'P0001';
  END IF;
  IF op.status IN ('draft', 'collecting_details', 'cancelled', 'failed') OR op.current_mandate_id IS NULL THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001';
  END IF;
  SELECT bk.* INTO b FROM public.bookings bk JOIN public.quotes qt ON qt.id = bk.quote_id
    JOIN public.quote_requests qr ON qr.id = qt.quote_request_id
    WHERE bk.operation_id = op.id AND qr.provider_id = p_provider_id AND bk.id = op.current_booking_id FOR UPDATE OF bk;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation_not_available' USING ERRCODE = 'P0001'; END IF;
  IF p_context->>'booking_id' IS DISTINCT FROM b.id::text
    OR p_context->>'operation_revision' IS DISTINCT FROM op.updated_at::text
    OR p_context->>'mandate_id' IS DISTINCT FROM op.current_mandate_id::text THEN
    RAISE EXCEPTION 'stale_operation' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO q FROM public.quotes WHERE id = b.quote_id;
  SELECT * INTO m FROM public.mandates WHERE id = op.current_mandate_id AND operation_id = op.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001'; END IF;
  previous_window := jsonb_build_object('start_at', b.pickup_window_start, 'end_at', b.pickup_window_end);
  IF p_tool_name='decline_reschedule_alternatives' THEN
    UPDATE public.change_requests SET status='escalated'
      WHERE source_call_id=c.id AND booking_id=b.id AND evaluated_mandate_id=m.id
        AND type='reschedule' AND status='pending';
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid_transition' USING ERRCODE='P0001'; END IF;
    result:=jsonb_build_object('status','requires_escalation','reason_code','alternatives_declined','commitment_created',false);
    INSERT INTO public.tool_command_receipts(call_id,tool_call_id,tool_name,arguments,result,created_at)
      VALUES(c.id,p_tool_call_id,p_tool_name,p_arguments,result,clock_timestamp());
    RETURN result;
  END IF;
  IF p_tool_name = 'reschedule_booking' THEN
    local_window := p_arguments ? 'proposed_pickup_local_window';
    IF local_window = (p_arguments ? 'proposed_pickup_window') THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
    END IF;
    proposed := CASE WHEN local_window THEN p_arguments->'proposed_pickup_local_window'
      ELSE p_arguments->'proposed_pickup_window' END;
    IF proposed IS NULL OR jsonb_typeof(proposed) <> 'object' THEN RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001'; END IF;
    IF NOT proposed ?& ARRAY['start_at', 'end_at'] OR (SELECT count(*) FROM jsonb_object_keys(proposed)) <> 2 THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
    END IF;
    IF local_window THEN
      pickup_offset := public.mandate_pickup_utc_offset(m.action_windows);
      IF pickup_offset IS NULL THEN
        RAISE EXCEPTION 'pickup_timezone_unavailable' USING ERRCODE = 'P0001';
      END IF;
      FOR item IN SELECT value FROM jsonb_each(proposed) LOOP
        IF jsonb_typeof(item) <> 'string' OR (item #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?$' THEN
          RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
        END IF;
      END LOOP;
      -- Preserve local clock times verbatim; only the server supplies the offset.
      -- Store original arguments in the receipt so retries never reinterpret them.
      proposed := jsonb_build_object('start_at', (proposed->>'start_at') || pickup_offset,
        'end_at', (proposed->>'end_at') || pickup_offset);
    END IF;
    FOR item IN SELECT value FROM jsonb_each(proposed) LOOP
      IF jsonb_typeof(item) <> 'string' OR (item #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
        RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
    BEGIN
      start_time := (proposed->>'start_at')::timestamptz; end_time := (proposed->>'end_at')::timestamptz;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
    END;
    IF start_time >= end_time OR start_time <= clock_timestamp()
      OR (start_time = b.pickup_window_start AND end_time = b.pickup_window_end) THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
    END IF;
    IF op.mandate_confirmation_required OR q.evaluated_mandate_id <> m.id THEN
      reason_code := 'mandate_reconfirmation_required';
    ELSIF op.status NOT IN ('booking_confirmed', 'notifications_sent') OR b.confirmed_price > m.price_cap
      OR q.verdict <> 'dentro' OR q.status <> 'received'
      OR q.currency <> m.currency OR coalesce(b.payment_term_days, 0) < m.minimum_payment_term_days
      OR EXISTS (SELECT 1 FROM public.quotes successor WHERE successor.supersedes_quote_id = q.id) THEN
      reason_code := 'booking_terms_require_review';
    ELSIF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.action_windows) w
      WHERE start_time >= (w->>'start_at')::timestamptz AND end_time <= (w->>'end_at')::timestamptz) THEN
      reason_code := 'outside_action_window';
    END IF;
  END IF;

  command_time := clock_timestamp();
  IF reason_code='outside_action_window' THEN
    alternatives:=public.provider_booking_alternative_windows(m.action_windows);
  END IF;
  -- A corrected proposal supersedes the previous proposal, never the booking.
  UPDATE public.change_requests SET status='rejected',resolved_at=command_time
    WHERE source_call_id=c.id AND type='reschedule' AND status='pending';
  IF c.operation_id IS NULL THEN
    UPDATE public.calls SET operation_id = op.id, provider_intent = requested_intent WHERE id = c.id RETURNING * INTO c;
    linked := true;
  END IF;
  INSERT INTO public.change_requests (operation_id, booking_id, source_call_id, requested_by_provider_id,
    evaluated_mandate_id, type, previous_pickup_window, requested_pickup_window, reason, verdict, status, requested_at, resolved_at)
  VALUES (op.id, b.id, c.id, p_provider_id, m.id,
    CASE WHEN p_tool_name = 'reschedule_booking' THEN 'reschedule'::change_request_type ELSE 'cancel'::change_request_type END,
    previous_window, proposed, p_arguments->>'reason',
    CASE WHEN reason_code IS NULL THEN 'dentro'::change_request_verdict ELSE 'fuera'::change_request_verdict END,
    CASE WHEN reason_code IS NULL THEN 'applied'::change_request_status
      WHEN jsonb_array_length(alternatives)>0 THEN 'pending'::change_request_status
      ELSE 'escalated'::change_request_status END,
    command_time, CASE WHEN reason_code IS NULL THEN command_time ELSE NULL END) RETURNING * INTO cr;

  IF p_tool_name = 'cancel_booking' THEN
    UPDATE public.operations SET current_booking_id = NULL, status = 'sourcing'
      WHERE id = op.id AND current_booking_id = b.id;
    UPDATE public.quote_requests SET status = 'cancelled' WHERE id = q.quote_request_id;
    UPDATE public.change_requests SET status = 'rejected', resolved_at = command_time
      WHERE booking_id = b.id AND status IN ('pending', 'escalated');
    UPDATE public.outbox SET status = 'processed', processed_at = command_time,
      payload = payload || jsonb_build_object('skipped_reason', 'booking_cancelled')
      WHERE quote_request_id = q.quote_request_id AND job_type = 'contact_provider' AND status = 'pending';
    INSERT INTO public.events (type, operation_id, call_id, occurred_at, payload) VALUES (
      'booking.cancelled', op.id, c.id, command_time, jsonb_build_object('booking_id', b.id,
        'change_request_id', cr.id, 'source', 'provider', 'reason', p_arguments->>'reason',
        'operation_status', 'sourcing', 'notification_email_queued', false));
    result := jsonb_build_object('booking_status', 'cancelled', 'operation_status',
      (SELECT status FROM public.operations WHERE id = op.id),
      'commitment_created', false, 'client_email_queued', false);
  ELSIF reason_code IS NULL THEN
    INSERT INTO public.bookings(operation_id, quote_id, status, pickup_window_start, pickup_window_end,
      payment_term_days, payment_term_anchor, confirmed_price, confirmation_reference, confirmed_at,
      last_change_request_id, source_call_id)
    VALUES (op.id, b.quote_id, 'confirmed', start_time, end_time, b.payment_term_days,
      b.payment_term_anchor, b.confirmed_price, b.confirmation_reference, b.confirmed_at, cr.id, c.id)
    RETURNING id INTO successor_id;
    UPDATE public.operations SET current_booking_id = successor_id WHERE id = op.id AND current_booking_id = b.id;
    INSERT INTO public.events (type, operation_id, call_id, occurred_at, schema_version, payload) VALUES (
      'booking.rescheduled', op.id, c.id, command_time, 2, jsonb_build_object('booking_id', successor_id, 'previous_booking_id', b.id,
        'change_request_id', cr.id, 'previous_window', previous_window, 'new_window', proposed,
        'reason', p_arguments->>'reason'));
    result := jsonb_build_object('status', 'applied', 'reason_code', NULL, 'commitment_created', false);
  ELSIF jsonb_array_length(alternatives)>0 THEN
    result:=jsonb_build_object('status','alternatives_available','reason_code','outside_action_window',
      'available_pickup_local_windows',alternatives,'commitment_created',false);
  ELSE
    -- Recording a request is not applying it, and not proof of a human handoff.
    result := jsonb_build_object('status', 'requires_escalation', 'reason_code', reason_code, 'commitment_created', false);
  END IF;
  IF reason_code IS NULL THEN UPDATE public.calls SET provider_tools_completed_at = command_time WHERE id = c.id; END IF;
  IF linked THEN
    INSERT INTO public.events (type, operation_id, call_id, occurred_at, payload) VALUES (
      'call.routed', op.id, c.id, command_time, jsonb_build_object('direction', c.direction,
        'persona', c.persona, 'intent', c.provider_intent, 'counterparty_type', 'provider',
        'candidate_operation_references', jsonb_build_array(op.reference)));
  END IF;
  INSERT INTO public.tool_command_receipts (call_id, tool_call_id, tool_name, arguments, result, created_at)
  VALUES (c.id, p_tool_call_id, p_tool_name, p_arguments, result, clock_timestamp());
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.execute_provider_booking_tool(
  p_call_id uuid, p_realtime_call_id text, p_provider_id uuid,
  p_tool_call_id text, p_tool_name text, p_arguments jsonb, p_context jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.calls%ROWTYPE; op public.operations%ROWTYPE; receipt public.tool_command_receipts%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.calls WHERE id=p_call_id AND realtime_call_id=p_realtime_call_id
    AND provider_id=p_provider_id AND persona='provider' AND direction='inbound' AND outcome='active';
  IF NOT FOUND OR c.purpose IS DISTINCT FROM 'booking_management' THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE='P0001';
  END IF;
  IF c.operation_id IS NOT NULL THEN
    SELECT * INTO op FROM public.operations WHERE id=c.operation_id FOR UPDATE;
  END IF;
  SELECT * INTO c FROM public.calls WHERE id=p_call_id AND realtime_call_id=p_realtime_call_id
    AND provider_id=p_provider_id AND persona='provider' AND direction='inbound'
    AND purpose='booking_management' AND outcome='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE='P0001'; END IF;
  PERFORM 1 FROM public.providers WHERE id=p_provider_id AND active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE='P0001'; END IF;
  SELECT * INTO receipt FROM public.tool_command_receipts WHERE call_id=c.id AND tool_call_id=p_tool_call_id;
  IF FOUND THEN
    IF receipt.tool_name IS DISTINCT FROM p_tool_name OR receipt.arguments IS DISTINCT FROM p_arguments THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';
    END IF;
    RETURN receipt.result;
  END IF;
  IF c.selected_booking_id IS NULL OR c.operation_id IS NULL
     OR c.provider_intent IS DISTINCT FROM (CASE WHEN p_tool_name IN ('reschedule_booking','decline_reschedule_alternatives') THEN 'reschedule'::public.provider_operation_intent ELSE 'cancel_booking'::public.provider_operation_intent END) THEN
    RAISE EXCEPTION 'intent_locked' USING ERRCODE='P0001';
  END IF;
  IF p_context IS NULL OR p_context->>'booking_id' IS DISTINCT FROM c.selected_booking_id::text THEN
    RAISE EXCEPTION 'stale_operation' USING ERRCODE='P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.operations WHERE id=c.operation_id AND current_booking_id=c.selected_booking_id) THEN
    RAISE EXCEPTION 'stale_operation' USING ERRCODE='P0001';
  END IF;
  RETURN public.execute_provider_booking_tool_legacy(
    p_call_id,p_realtime_call_id,p_provider_id,p_tool_call_id,p_tool_name,p_arguments,p_context);
END; $$;

-- Stale/direct escalation calls cannot bypass a pending alternatives step.
CREATE OR REPLACE FUNCTION public.guard_booking_alternatives_escalation()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.change_requests cr JOIN public.operations o ON o.id=cr.operation_id
    JOIN public.mandates m ON m.id=o.current_mandate_id
    WHERE cr.source_call_id=NEW.source_call_id AND cr.operation_id=NEW.operation_id
      AND cr.type='reschedule' AND cr.status='pending' AND cr.booking_id=o.current_booking_id
      AND cr.evaluated_mandate_id=m.id AND jsonb_array_length(public.provider_booking_alternative_windows(m.action_windows))>0) THEN
    RAISE EXCEPTION 'booking_alternatives_pending' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER escalations_require_booking_alternatives
BEFORE INSERT ON public.escalations FOR EACH ROW EXECUTE FUNCTION public.guard_booking_alternatives_escalation();
REVOKE ALL ON FUNCTION public.guard_booking_alternatives_escalation() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.execute_provider_booking_tool_legacy(uuid,text,uuid,text,text,jsonb,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
