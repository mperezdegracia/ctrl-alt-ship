-- Provider changes to confirmed bookings. No emails, new mandates or invented
-- audio evidence. Change requests/events are the audit trail in this rollout.
BEGIN;
ALTER TABLE public.change_requests ADD COLUMN previous_pickup_window jsonb
  CHECK (previous_pickup_window IS NULL OR public.is_window(previous_pickup_window));
ALTER TABLE public.bookings ADD COLUMN last_change_request_id uuid REFERENCES public.change_requests(id);
ALTER TABLE public.tool_command_receipts
  DROP CONSTRAINT tool_command_receipts_tool_name_check,
  ADD CONSTRAINT tool_command_receipts_tool_name_check CHECK (tool_name IN (
    'create_operation', 'update_operation', 'confirm_mandate', 'cancel_operation',
    'create_quote', 'decline_quote_request', 'reschedule_booking', 'cancel_booking'
  ));

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
          AND NEW.payment_term_days >= m.minimum_payment_term_days AND q.currency = m.currency
          AND NEW.pickup_window_start >= (w->>'start_at')::timestamptz
          AND NEW.pickup_window_end <= (w->>'end_at')::timestamptz) THEN
      RAISE EXCEPTION 'booking reschedule requires an approved window-only change' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF request_operation IS DISTINCT FROM NEW.operation_id OR q.verdict <> 'dentro' OR q.status <> 'received'
    OR q.valid_until <= now() OR q.evaluated_mandate_id IS DISTINCT FROM op.current_mandate_id
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
DROP TRIGGER bookings_validate ON public.bookings;
CREATE TRIGGER bookings_validate BEFORE INSERT OR UPDATE OF operation_id, quote_id,
  pickup_window_start, pickup_window_end, payment_term_days, confirmed_price, last_change_request_id
ON public.bookings FOR EACH ROW EXECUTE FUNCTION public.validate_booking();

-- Compose the existing quote state with only this provider's confirmed bookings.
CREATE FUNCTION public.get_provider_tool_state(p_call_id uuid, p_realtime_call_id text, p_provider_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  state jsonb;
  c public.calls%ROWTYPE;
  op public.operations%ROWTYPE;
  b public.bookings%ROWTYPE;
  q public.quotes%ROWTYPE;
  candidates jsonb := '[]'::jsonb;
  targets jsonb := '{}'::jsonb;
  row record;
  profile text;
BEGIN
  state := public.get_provider_quote_tool_state(p_call_id, p_realtime_call_id, p_provider_id);
  SELECT * INTO c FROM public.calls WHERE id = p_call_id;
  profile := state->>'profile';
  IF c.provider_tools_completed_at IS NULL AND c.provider_intent IN ('undecided', 'reschedule', 'cancel_booking') THEN
    FOR row IN SELECT bk.id FROM public.bookings bk
      JOIN public.quotes qt ON qt.id = bk.quote_id
      JOIN public.quote_requests qr ON qr.id = qt.quote_request_id
      JOIN public.operations o ON o.id = bk.operation_id
      WHERE qr.provider_id = p_provider_id AND qr.operation_id = bk.operation_id
        AND bk.status = 'confirmed' AND o.status NOT IN ('draft', 'collecting_details', 'cancelled', 'failed')
        AND (c.operation_id IS NULL OR c.operation_id = bk.operation_id)
      ORDER BY o.reference LIMIT 50
    LOOP
      SELECT * INTO b FROM public.bookings WHERE id = row.id;
      SELECT * INTO op FROM public.operations WHERE id = b.operation_id;
      SELECT * INTO q FROM public.quotes WHERE id = b.quote_id;
      candidates := candidates || jsonb_build_array(jsonb_build_object(
        'operation', public.provider_quote_operation(op),
        'pickup_window', jsonb_build_object('start_at', b.pickup_window_start, 'end_at', b.pickup_window_end),
        'confirmed_price', b.confirmed_price, 'currency', q.currency, 'payment_term_days', b.payment_term_days,
        'requires_reconfirmation', op.mandate_confirmation_required OR q.evaluated_mandate_id IS DISTINCT FROM op.current_mandate_id));
      targets := targets || jsonb_build_object(op.reference, jsonb_build_object(
        'booking_id', b.id, 'booking_revision', b.updated_at::text,
        'operation_revision', op.updated_at::text, 'mandate_id', op.current_mandate_id));
    END LOOP;
    IF jsonb_array_length(candidates) > 0 THEN
      profile := CASE c.provider_intent WHEN 'undecided' THEN 'provider_inbound_entry'
        WHEN 'reschedule' THEN 'provider_reschedule' ELSE 'provider_cancel_booking' END;
    END IF;
    IF c.provider_intent = 'reschedule' AND EXISTS (SELECT 1 FROM public.change_requests cr
      WHERE cr.source_call_id = c.id AND cr.status = 'escalated' AND cr.type = 'reschedule') THEN
      profile := 'provider_booking_escalation';
    END IF;
  END IF;
  RETURN state || jsonb_build_object('profile', profile, 'bookingCandidates', candidates, 'bookingTargets', targets);
END;
$$;

CREATE FUNCTION public.execute_provider_booking_tool(
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
  item jsonb;
  start_time timestamptz;
  end_time timestamptz;
  command_time timestamptz;
  reason_code text := NULL;
  linked boolean := false;
  result jsonb;
BEGIN
  IF p_tool_name IS NULL OR p_tool_name NOT IN ('reschedule_booking', 'cancel_booking')
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
  requested_intent := CASE WHEN p_tool_name = 'reschedule_booking' THEN 'reschedule'::provider_operation_intent ELSE 'cancel_booking'::provider_operation_intent END;
  IF c.provider_intent NOT IN ('undecided', requested_intent) THEN RAISE EXCEPTION 'intent_locked' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM public.change_requests r WHERE r.source_call_id = c.id AND r.status = 'escalated') THEN
    RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001';
  END IF;
  IF NOT p_arguments ? 'reason' OR jsonb_typeof(p_arguments->'reason') <> 'string' OR btrim(p_arguments->>'reason') = ''
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_arguments) k WHERE k <> 'operation_reference' AND k <> 'reason'
      AND NOT (p_tool_name = 'reschedule_booking' AND k = 'proposed_pickup_window'))
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
      WHERE bk.operation_id = o.id AND qr.operation_id = o.id AND qr.provider_id = p_provider_id AND bk.status = 'confirmed')
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
    WHERE bk.operation_id = op.id AND qr.provider_id = p_provider_id AND bk.status = 'confirmed' FOR UPDATE OF bk;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation_not_available' USING ERRCODE = 'P0001'; END IF;
  IF p_context->>'booking_id' IS DISTINCT FROM b.id::text OR p_context->>'booking_revision' IS DISTINCT FROM b.updated_at::text
    OR p_context->>'operation_revision' IS DISTINCT FROM op.updated_at::text
    OR p_context->>'mandate_id' IS DISTINCT FROM op.current_mandate_id::text THEN
    RAISE EXCEPTION 'stale_operation' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO q FROM public.quotes WHERE id = b.quote_id;
  SELECT * INTO m FROM public.mandates WHERE id = op.current_mandate_id AND operation_id = op.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_transition' USING ERRCODE = 'P0001'; END IF;
  previous_window := jsonb_build_object('start_at', b.pickup_window_start, 'end_at', b.pickup_window_end);
  IF p_tool_name = 'reschedule_booking' THEN
    proposed := p_arguments->'proposed_pickup_window';
    IF proposed IS NULL OR jsonb_typeof(proposed) <> 'object' THEN RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001'; END IF;
    IF NOT proposed ?& ARRAY['start_at', 'end_at'] OR (SELECT count(*) FROM jsonb_object_keys(proposed)) <> 2 THEN
      RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
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
      OR q.currency <> m.currency OR b.payment_term_days < m.minimum_payment_term_days
      OR EXISTS (SELECT 1 FROM public.quotes successor WHERE successor.supersedes_quote_id = q.id) THEN
      reason_code := 'booking_terms_require_review';
    ELSIF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.action_windows) w
      WHERE start_time >= (w->>'start_at')::timestamptz AND end_time <= (w->>'end_at')::timestamptz) THEN
      reason_code := 'outside_action_window';
    END IF;
  END IF;

  command_time := clock_timestamp();
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
    CASE WHEN reason_code IS NULL THEN 'applied'::change_request_status ELSE 'escalated'::change_request_status END,
    command_time, CASE WHEN reason_code IS NULL THEN command_time ELSE NULL END) RETURNING * INTO cr;

  IF p_tool_name = 'cancel_booking' THEN
    UPDATE public.bookings SET status = 'cancelled', cancelled_at = command_time WHERE id = b.id;
    UPDATE public.operations SET status = 'sourcing' WHERE id = op.id;
    UPDATE public.quote_requests SET status = 'cancelled' WHERE id = q.quote_request_id;
    UPDATE public.change_requests SET status = 'rejected', resolved_at = command_time
      WHERE booking_id = b.id AND status IN ('pending', 'escalated');
    UPDATE public.outbox SET status = 'processed', processed_at = command_time,
      payload = payload || jsonb_build_object('skipped_reason', 'booking_cancelled')
      WHERE quote_request_id = q.quote_request_id AND job_type = 'contact_provider' AND status = 'pending';
    INSERT INTO public.events (type, operation_id, call_id, occurred_at, payload) VALUES (
      'booking.cancelled', op.id, c.id, command_time, jsonb_build_object('booking_id', b.id,
        'change_request_id', cr.id, 'source', 'provider', 'reason', p_arguments->>'reason',
        'operation_status', 'sourcing', 'notification_email_queued', false)), (
      'sourcing.started', op.id, c.id, command_time, jsonb_build_object('operation_reference', op.reference,
        'mandate_version', m.version, 'provider_count', 0, 'reason', 'provider_cancelled'));
    result := jsonb_build_object('booking_status', 'cancelled', 'operation_status', 'sourcing',
      'commitment_created', false, 'client_email_queued', false);
  ELSIF reason_code IS NULL THEN
    UPDATE public.bookings SET pickup_window_start = start_time, pickup_window_end = end_time,
      last_change_request_id = cr.id WHERE id = b.id;
    INSERT INTO public.events (type, operation_id, call_id, occurred_at, payload) VALUES (
      'booking.rescheduled', op.id, c.id, command_time, jsonb_build_object('booking_id', b.id,
        'change_request_id', cr.id, 'previous_window', previous_window, 'new_window', proposed,
        'reason', p_arguments->>'reason'));
    result := jsonb_build_object('status', 'applied', 'reason_code', NULL, 'commitment_created', false);
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
  INSERT INTO public.tool_command_receipts (call_id, tool_call_id, tool_name, arguments, result)
  VALUES (c.id, p_tool_call_id, p_tool_name, p_arguments, result);
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.get_provider_tool_state(uuid, text, uuid),
  public.execute_provider_booking_tool(uuid, text, uuid, text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_provider_tool_state(uuid, text, uuid),
  public.execute_provider_booking_tool(uuid, text, uuid, text, text, jsonb, jsonb) TO service_role;
COMMIT;
