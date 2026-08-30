-- DB-100: make the Operation pointer the only Booking authority.
-- Forward-only follow-up to 20260830200000; no historical migration is edited.
BEGIN;

ALTER TABLE public.calls ALTER COLUMN operation_id DROP NOT NULL;

DROP INDEX IF EXISTS public.one_active_booking_per_operation;
DROP TRIGGER IF EXISTS bookings_sync_current_booking ON public.bookings;
DROP TRIGGER IF EXISTS bookings_touch_updated_at ON public.bookings;

CREATE OR REPLACE FUNCTION public.reject_booking_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'bookings are append-only' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS bookings_append_only ON public.bookings;
CREATE TRIGGER bookings_append_only
BEFORE UPDATE OR DELETE ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.reject_booking_mutation();

CREATE OR REPLACE FUNCTION public.validate_booking_evidence()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE first_recorded timestamptz; last_recorded timestamptz;
BEGIN
  IF NEW.source_call_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.calls c WHERE c.id = NEW.source_call_id
      AND c.operation_id = NEW.operation_id
  ) THEN RAISE EXCEPTION 'booking source call belongs to another operation' USING ERRCODE = '23514'; END IF;
  IF (NEW.evidence_start_segment_id IS NULL) <> (NEW.evidence_end_segment_id IS NULL) THEN
    RAISE EXCEPTION 'booking evidence range is incomplete' USING ERRCODE = '23514';
  END IF;
  IF NEW.evidence_start_segment_id IS NOT NULL THEN
    SELECT s.recorded_at INTO first_recorded FROM public.call_transcript_segments s
      WHERE s.id = NEW.evidence_start_segment_id AND s.call_id = NEW.source_call_id;
    SELECT s.recorded_at INTO last_recorded FROM public.call_transcript_segments s
      WHERE s.id = NEW.evidence_end_segment_id AND s.call_id = NEW.source_call_id;
    IF first_recorded IS NULL OR last_recorded IS NULL OR first_recorded > last_recorded
       OR (first_recorded = last_recorded AND NEW.evidence_start_segment_id <> NEW.evidence_end_segment_id) THEN
      RAISE EXCEPTION 'booking evidence range is not ordered' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
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
DROP TRIGGER IF EXISTS bookings_validate ON public.bookings;
CREATE TRIGGER bookings_validate
BEFORE INSERT OR UPDATE ON public.bookings FOR EACH ROW EXECUTE FUNCTION public.validate_booking();

CREATE OR REPLACE FUNCTION public.validate_operation_current_booking()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.current_booking_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.bookings b WHERE b.id = NEW.current_booking_id
      AND b.operation_id = NEW.id AND b.status IN ('pending','confirmed')
  ) THEN RAISE EXCEPTION 'current booking must belong to operation and be active' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS operations_current_booking_validate ON public.operations;
CREATE TRIGGER operations_current_booking_validate
BEFORE INSERT OR UPDATE OF current_booking_id ON public.operations
FOR EACH ROW EXECUTE FUNCTION public.validate_operation_current_booking();

CREATE OR REPLACE FUNCTION public.validate_call_context()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE operation_contact uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.operation_id IS NOT NULL
     AND NEW.operation_id IS DISTINCT FROM OLD.operation_id THEN
    RAISE EXCEPTION 'a call cannot switch operations after being linked' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.operation_intent IS DISTINCT FROM NEW.operation_intent
       AND OLD.operation_intent IS DISTINCT FROM 'undecided'::public.client_operation_intent THEN
      RAISE EXCEPTION 'client operation intent is already locked' USING ERRCODE = '23514';
    END IF;
    IF OLD.provider_intent IS DISTINCT FROM NEW.provider_intent
       AND OLD.provider_intent IS DISTINCT FROM 'undecided'::public.provider_operation_intent THEN
      RAISE EXCEPTION 'provider operation intent is already locked' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.contact_id IS NOT NULL AND NEW.operation_id IS NOT NULL THEN
    SELECT contact_id INTO operation_contact FROM public.operations WHERE id = NEW.operation_id;
    IF operation_contact IS DISTINCT FROM NEW.contact_id THEN
      RAISE EXCEPTION 'client call contact does not own operation' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_operation_scope_check;
ALTER TABLE public.events ADD CONSTRAINT events_operation_scope_check CHECK (
  operation_id IS NOT NULL OR type = 'call.rejected' OR (type = 'call.routed' AND call_id IS NOT NULL)
);
CREATE OR REPLACE FUNCTION public.validate_event_context()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.call_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.calls c WHERE c.id = NEW.call_id
      AND c.operation_id IS NOT DISTINCT FROM NEW.operation_id
  ) THEN RAISE EXCEPTION 'event references another operation' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.queue_booking_confirmation_emails(
  p_booking_id uuid
) RETURNS TABLE(outbox_id uuid, recipient_type text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  booking_row record;
  client_outbox_id uuid;
  provider_outbox_id uuid;
  email_payload jsonb;
BEGIN
  SELECT
    booking.id,
    booking.operation_id,
    booking.confirmed_price,
    booking.pickup_window_start,
    booking.pickup_window_end,
    booking.payment_term_days,
    booking.confirmation_reference,
    operation.reference AS operation_reference,
    operation.container_type,
    operation.gross_weight_kg,
    operation.pickup_location,
    operation.delivery_location,
    quote.currency,
    contact.name AS client_name,
    contact.email AS client_email,
    provider.name AS provider_name,
    provider.email AS provider_email
  INTO booking_row
  FROM public.bookings AS booking
  JOIN public.operations AS operation ON operation.id = booking.operation_id
  JOIN public.quotes AS quote ON quote.id = booking.quote_id
  JOIN public.quote_requests AS quote_request ON quote_request.id = quote.quote_request_id
  JOIN public.contacts AS contact ON contact.id = operation.contact_id
  JOIN public.providers AS provider ON provider.id = quote_request.provider_id
  WHERE booking.id = p_booking_id AND operation.current_booking_id = booking.id
    AND booking.last_change_request_id IS NULL AND booking.status = 'confirmed'
  FOR SHARE OF booking;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_not_confirmed' USING ERRCODE = 'P0001';
  END IF;

  email_payload := jsonb_build_object(
    'operation_reference', booking_row.operation_reference,
    'booking', jsonb_build_object(
      'confirmed_price', booking_row.confirmed_price,
      'currency', booking_row.currency,
      'pickup_window_start', booking_row.pickup_window_start,
      'pickup_window_end', booking_row.pickup_window_end,
      'payment_term_days', booking_row.payment_term_days,
      'confirmation_reference', booking_row.confirmation_reference,
      'container_type', booking_row.container_type,
      'gross_weight_kg', booking_row.gross_weight_kg,
      'pickup_location', booking_row.pickup_location,
      'delivery_location', booking_row.delivery_location,
      'client_name', booking_row.client_name,
      'provider_name', booking_row.provider_name
    )
  );

  client_outbox_id := public.enqueue_booking_confirmation_email(
    booking_row.operation_id,
    booking_row.id,
    'booking_confirmation_client',
    'client',
    booking_row.client_name,
    booking_row.client_email,
    email_payload,
    'booking-confirmation:' || booking_row.id || ':client'
  );
  provider_outbox_id := public.enqueue_booking_confirmation_email(
    booking_row.operation_id,
    booking_row.id,
    'booking_confirmation_provider',
    'provider',
    booking_row.provider_name,
    booking_row.provider_email,
    email_payload,
    'booking-confirmation:' || booking_row.id || ':provider'
  );

  RETURN QUERY VALUES
    (client_outbox_id, 'client'::text),
    (provider_outbox_id, 'provider'::text);
END;
$$;
-- Queue only when an adjudication becomes the current pointer. Inserting a
-- historical/window-only successor by itself never queues confirmation emails.
DROP TRIGGER IF EXISTS bookings_enqueue_confirmation_emails ON public.bookings;
CREATE OR REPLACE FUNCTION public.enqueue_booking_confirmation_emails_after_confirm()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.current_booking_id IS NOT NULL
    AND NEW.current_booking_id IS DISTINCT FROM OLD.current_booking_id
    AND EXISTS (SELECT 1 FROM public.bookings b WHERE b.id = NEW.current_booking_id
      AND b.last_change_request_id IS NULL AND b.status = 'confirmed') THEN
    PERFORM public.queue_booking_confirmation_emails(NEW.current_booking_id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER operations_enqueue_booking_confirmation
AFTER UPDATE OF current_booking_id ON public.operations
FOR EACH ROW EXECUTE FUNCTION public.enqueue_booking_confirmation_emails_after_confirm();

CREATE OR REPLACE FUNCTION public.finalize_operation_sourcing(p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  op public.operations%ROWTYPE; m public.mandates%ROWTYPE; winning public.quotes%ROWTYPE;
  source_call uuid; booking_id uuid; dispatched timestamptz;
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
    WHERE operation_id = op.id AND mandate_id = m.id AND id <> winning.quote_request_id
      AND status IN ('pending', 'queued', 'contacted', 'responded');
  UPDATE public.outbox SET status = 'processed', processed_at = clock_timestamp(),
    payload = payload || jsonb_build_object('skipped_reason', 'booking_selected')
    WHERE operation_id = op.id AND job_type = 'contact_provider' AND status = 'pending';
  -- No fabricated transcript_excerpt/checkpoint. Quote/event provenance is real;
  -- absent transcript evidence is left null.
  INSERT INTO public.events (type, operation_id, call_id, payload) VALUES
    ('quote.selected', op.id, source_call, jsonb_build_object('quote_id', winning.id,
      'price_max', winning.price_max, 'currency', winning.currency, 'judge_review_id', reviewed.id, 'selection_rule',
      CASE WHEN winning.received_at > dispatched + interval '5 minutes'
        THEN 'first_valid_after_deadline' ELSE 'lowest_valid_price_max' END)),
    ('booking.confirmed', op.id, source_call, jsonb_build_object('booking_id', booking_id, 'quote_id', winning.id,
      'confirmed_price', winning.price_max, 'currency', winning.currency, 'pickup_window', winning.proposed_pickup_window,
      'payment_term_days', winning.payment_term_days, 'commitment_created', false));
  RETURN jsonb_build_object('finalized', true, 'selected', true, 'judge_review_id', reviewed.id, 'booking_id', booking_id, 'quote_id', winning.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.execute_provider_booking_tool(
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
  successor_id uuid;
  scope_operation_id uuid;
  result jsonb;
BEGIN
  IF p_tool_name IS NULL OR p_tool_name NOT IN ('reschedule_booking', 'cancel_booking')
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
  requested_intent := CASE WHEN p_tool_name = 'reschedule_booking' THEN 'reschedule'::provider_operation_intent ELSE 'cancel_booking'::provider_operation_intent END;
  IF c.provider_intent <> requested_intent OR c.operation_id IS NULL THEN RAISE EXCEPTION 'intent_locked' USING ERRCODE = 'P0001'; END IF;
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
      OR q.currency <> m.currency OR coalesce(b.payment_term_days, 0) < m.minimum_payment_term_days
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

CREATE OR REPLACE FUNCTION public.execute_client_cancellation_tool(
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

  -- Lock the requested operation before the call, consistently with provider writers.
  PERFORM 1 FROM public.operations WHERE reference = p_arguments->>'operation_reference'
    AND contact_id = p_contact_id FOR UPDATE;
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
  UPDATE public.operations SET status = 'cancelled', current_booking_id = NULL, mandate_confirmation_required = false
  WHERE id = op.id;

  -- The observed pointer identifies the only current booking; history remains unchanged.
  FOR cancelled_booking IN
    SELECT * FROM public.bookings WHERE id = op.current_booking_id AND operation_id = op.id
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
REVOKE ALL ON FUNCTION public.execute_provider_booking_tool(uuid,text,uuid,text,text,jsonb,jsonb),
 public.execute_client_cancellation_tool(uuid,text,uuid,text,text,jsonb),
 public.finalize_operation_sourcing(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.execute_provider_booking_tool(uuid,text,uuid,text,text,jsonb,jsonb),
 public.execute_client_cancellation_tool(uuid,text,uuid,text,text,jsonb),
 public.finalize_operation_sourcing(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
