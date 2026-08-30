-- DB-101 M1: persist authenticated call purpose and selected Booking identity.
BEGIN;

ALTER TABLE public.calls
  ADD COLUMN IF NOT EXISTS purpose text,
  ADD COLUMN IF NOT EXISTS selected_booking_id uuid REFERENCES public.bookings(id),
  ADD COLUMN IF NOT EXISTS quote_request_id uuid REFERENCES public.quote_requests(id);

ALTER TABLE public.calls DROP CONSTRAINT IF EXISTS calls_purpose_check;
ALTER TABLE public.calls ADD CONSTRAINT calls_purpose_check CHECK (
  purpose IS NULL OR purpose IN ('operation_management','booking_management',
    'quote_request','renegotiation','booking_replacement')
);
ALTER TABLE public.tool_command_receipts DROP CONSTRAINT IF EXISTS tool_command_receipts_tool_name_check;
ALTER TABLE public.tool_command_receipts ADD CONSTRAINT tool_command_receipts_tool_name_check CHECK (
  tool_name IN ('create_operation','update_operation','confirm_mandate','cancel_operation',
    'create_quote','decline_quote_request','reschedule_booking','cancel_booking',
    'record_provider_quote','select_booking_for_reschedule','select_booking_for_cancellation',
    'record_provider_offer','escalate')
);

CREATE INDEX IF NOT EXISTS calls_selected_booking_idx ON public.calls(selected_booking_id)
  WHERE selected_booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS calls_quote_request_idx ON public.calls(quote_request_id)
  WHERE quote_request_id IS NOT NULL;

ALTER FUNCTION public.get_provider_tool_state(uuid,text,uuid) RENAME TO get_provider_inbound_tool_state;
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
    WHERE receipt.call_id=c.id AND receipt.tool_name IN ('reschedule_booking','cancel_booking')
    ORDER BY receipt.created_at DESC LIMIT 1;
  RETURN jsonb_build_object('flow','provider_inbound',
    'profile',CASE WHEN c.outcome <> 'active' OR c.provider_tools_completed_at IS NOT NULL THEN 'terminal'
      WHEN c.selected_booking_id IS NOT NULL AND selected IS NULL THEN 'provider_unavailable'
      WHEN c.selected_booking_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.change_requests cr WHERE cr.source_call_id=c.id AND cr.status='escalated') THEN 'provider_booking_escalation'
      WHEN c.selected_booking_id IS NOT NULL THEN CASE c.provider_intent WHEN 'reschedule' THEN 'provider_reschedule' WHEN 'cancel_booking' THEN 'provider_cancel_booking' ELSE 'provider_booking_escalation' END
      WHEN coalesce(c.provider_intent,'undecided') NOT IN ('undecided','reschedule','cancel_booking') THEN 'provider_unavailable'
      ELSE 'provider_inbound_entry' END,
    'intent',coalesce(c.provider_intent,'undecided'),'bookings',coalesce(bookings,'[]'::jsonb),
    'selectedBooking',selected,'commandTarget',target,'lastResult',last_result);
END; $$;

CREATE OR REPLACE FUNCTION public.get_provider_tool_state(
  p_call_id uuid,p_realtime_call_id text,p_provider_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE c public.calls%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.calls WHERE id=p_call_id AND realtime_call_id=p_realtime_call_id
    AND provider_id=p_provider_id AND persona='provider' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE='P0001'; END IF;
  IF c.direction='outbound' THEN
    RETURN jsonb_build_object('flow','provider_outbound','profile',CASE WHEN c.outcome <> 'active' THEN 'terminal' ELSE 'provider_unavailable' END,
      'intent','quote','operation',NULL,'commandTarget',NULL,'privatePriceLimit',NULL,'lastQuote',NULL,'lastOffer',NULL);
  END IF;
  RETURN public.get_provider_inbound_tool_state(p_call_id,p_realtime_call_id,p_provider_id);
END; $$;

CREATE OR REPLACE FUNCTION public.select_provider_booking(
  p_call_id uuid,p_realtime_call_id text,p_provider_id uuid,p_tool_call_id text,p_tool_name text,p_arguments jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE c public.calls%ROWTYPE; op public.operations%ROWTYPE; b public.bookings%ROWTYPE; r public.tool_command_receipts%ROWTYPE;
  intent public.provider_operation_intent; result jsonb;
BEGIN
  IF p_tool_name IS NULL OR p_tool_name NOT IN ('select_booking_for_reschedule','select_booking_for_cancellation') OR p_tool_call_id IS NULL OR btrim(p_tool_call_id) = '' OR p_arguments IS NULL
     OR jsonb_typeof(p_arguments)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(p_arguments))<>1
     OR p_arguments->>'operation_reference' IS NULL OR p_arguments->>'operation_reference' !~ '^OP-[0-9]{6,}$' THEN RAISE EXCEPTION 'invalid_arguments' USING ERRCODE='P0001'; END IF;
  SELECT * INTO c FROM public.calls WHERE id=p_call_id AND realtime_call_id=p_realtime_call_id AND provider_id=p_provider_id
    AND persona='provider' AND direction='inbound' AND purpose='booking_management' AND outcome='active';
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE='P0001'; END IF;
  intent:=CASE WHEN p_tool_name='select_booking_for_reschedule' THEN 'reschedule'::public.provider_operation_intent ELSE 'cancel_booking'::public.provider_operation_intent END;
  SELECT o.* INTO op FROM public.operations o WHERE o.reference=p_arguments->>'operation_reference' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation_not_available' USING ERRCODE='P0001'; END IF;
  SELECT * INTO c FROM public.calls WHERE id=p_call_id AND realtime_call_id=p_realtime_call_id
    AND provider_id=p_provider_id AND persona='provider' AND direction='inbound'
    AND purpose='booking_management' AND outcome='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE='P0001'; END IF;
  PERFORM 1 FROM public.providers WHERE id=p_provider_id AND active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE='P0001'; END IF;
  SELECT * INTO r FROM public.tool_command_receipts WHERE call_id=c.id AND tool_call_id=p_tool_call_id;
  IF FOUND THEN IF r.tool_name<>p_tool_name OR r.arguments<>p_arguments THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001'; END IF; RETURN r.result; END IF;
  IF c.provider_tools_completed_at IS NOT NULL THEN RAISE EXCEPTION 'invalid_transition' USING ERRCODE='P0001'; END IF;
  IF c.provider_intent NOT IN ('undecided',intent) THEN RAISE EXCEPTION 'intent_locked' USING ERRCODE='P0001'; END IF;
  SELECT bk.* INTO b FROM public.bookings bk JOIN public.quotes q ON q.id=bk.quote_id JOIN public.quote_requests qr ON qr.id=q.quote_request_id
    WHERE bk.id=op.current_booking_id AND bk.status='confirmed' AND qr.provider_id=p_provider_id FOR UPDATE OF bk;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation_not_available' USING ERRCODE='P0001'; END IF;
  IF c.selected_booking_id IS NOT NULL THEN
    IF c.selected_booking_id = b.id AND c.provider_intent = intent THEN
      result:=jsonb_build_object('status','selected','operation_reference',op.reference,'intent',intent);
      INSERT INTO public.tool_command_receipts(call_id,tool_call_id,tool_name,arguments,result) VALUES(c.id,p_tool_call_id,p_tool_name,p_arguments,result);
      RETURN result;
    END IF;
    RAISE EXCEPTION 'intent_locked' USING ERRCODE='P0001';
  END IF;
  UPDATE public.calls SET operation_id=op.id,selected_booking_id=b.id,provider_intent=intent WHERE id=c.id;
  result:=jsonb_build_object('status','selected','operation_reference',op.reference,'intent',intent);
  INSERT INTO public.tool_command_receipts(call_id,tool_call_id,tool_name,arguments,result) VALUES(c.id,p_tool_call_id,p_tool_name,p_arguments,result);
  RETURN result;
END; $$;

REVOKE ALL ON FUNCTION public.get_provider_inbound_tool_state(uuid,text,uuid),public.get_provider_tool_state(uuid,text,uuid),public.select_provider_booking(uuid,text,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_provider_inbound_tool_state(uuid,text,uuid),public.get_provider_tool_state(uuid,text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.guard_provider_escalation_selection()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE c public.calls%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.calls WHERE id=NEW.source_call_id;
  IF c.persona='provider' AND c.direction='inbound'
     AND (c.selected_booking_id IS NULL OR c.operation_id IS DISTINCT FROM NEW.operation_id
       OR NOT EXISTS (SELECT 1 FROM public.operations o WHERE o.id=NEW.operation_id AND o.current_booking_id=c.selected_booking_id)) THEN
    RAISE EXCEPTION 'operation_not_available' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS escalations_provider_selection_guard ON public.escalations;
CREATE TRIGGER escalations_provider_selection_guard
BEFORE INSERT ON public.escalations FOR EACH ROW EXECUTE FUNCTION public.guard_provider_escalation_selection();

-- Keep existing rows valid while making all newly-created Provider calls explicit.
CREATE OR REPLACE FUNCTION public.validate_call_flow_isolation()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.persona IS NOT NULL AND NEW.persona IS DISTINCT FROM OLD.persona THEN RAISE EXCEPTION 'call persona is immutable' USING ERRCODE='23514'; END IF;
    IF OLD.direction IS NOT NULL AND NEW.direction IS DISTINCT FROM OLD.direction THEN RAISE EXCEPTION 'call direction is immutable' USING ERRCODE='23514'; END IF;
    IF OLD.provider_id IS NOT NULL AND NEW.provider_id IS DISTINCT FROM OLD.provider_id THEN RAISE EXCEPTION 'call provider is immutable' USING ERRCODE='23514'; END IF;
    IF OLD.contact_id IS NOT NULL AND NEW.contact_id IS DISTINCT FROM OLD.contact_id THEN RAISE EXCEPTION 'call contact is immutable' USING ERRCODE='23514'; END IF;
    IF OLD.purpose IS NOT NULL AND NEW.purpose IS DISTINCT FROM OLD.purpose THEN RAISE EXCEPTION 'call purpose is immutable' USING ERRCODE='23514'; END IF;
    IF OLD.quote_request_id IS NOT NULL AND NEW.quote_request_id IS DISTINCT FROM OLD.quote_request_id THEN RAISE EXCEPTION 'call quote request is immutable' USING ERRCODE='23514'; END IF;
    IF OLD.purpose IS NULL AND NEW.purpose IS NOT NULL THEN RAISE EXCEPTION 'legacy call cannot be activated' USING ERRCODE='23514'; END IF;
    IF OLD.quote_request_id IS NULL AND NEW.quote_request_id IS NOT NULL THEN RAISE EXCEPTION 'legacy call cannot be activated' USING ERRCODE='23514'; END IF;
    IF OLD.selected_booking_id IS NOT NULL AND NEW.selected_booking_id IS DISTINCT FROM OLD.selected_booking_id THEN RAISE EXCEPTION 'selected booking is immutable' USING ERRCODE='23514'; END IF;
  END IF;
  IF TG_OP='INSERT' AND NEW.persona='provider' AND NEW.direction='inbound' AND NEW.purpose IS DISTINCT FROM 'booking_management' THEN
    RAISE EXCEPTION 'provider inbound purpose is required' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NEW.persona='provider' AND NEW.direction='outbound'
     AND (NEW.purpose IS NULL OR NEW.purpose NOT IN ('quote_request','renegotiation','booking_replacement') OR NEW.quote_request_id IS NULL) THEN
    RAISE EXCEPTION 'provider outbound correlation is required' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NEW.persona='client' AND NEW.direction='inbound' AND NEW.purpose IS DISTINCT FROM 'operation_management' THEN
    RAISE EXCEPTION 'client inbound purpose is required' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NEW.persona='provider' AND NEW.direction='outbound' AND NEW.purpose IS NULL THEN
    RAISE EXCEPTION 'provider outbound purpose is required' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NEW.persona='provider' AND NEW.direction='outbound' AND NEW.quote_request_id IS NULL THEN
    RAISE EXCEPTION 'provider outbound quote request is required' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NEW.persona='client' AND NEW.direction<>'inbound' THEN
    RAISE EXCEPTION 'unsupported client flow' USING ERRCODE='23514';
  END IF;
  IF NEW.selected_booking_id IS NOT NULL AND (NEW.persona<>'provider' OR NEW.direction<>'inbound'
    OR NEW.purpose IS DISTINCT FROM 'booking_management') THEN
    RAISE EXCEPTION 'selected booking requires provider inbound scope' USING ERRCODE='23514';
  END IF;
  IF NEW.selected_booking_id IS NOT NULL AND NEW.operation_id IS NULL THEN
    RAISE EXCEPTION 'selected booking requires operation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS calls_flow_isolation_validate ON public.calls;
CREATE TRIGGER calls_flow_isolation_validate
BEFORE INSERT OR UPDATE ON public.calls FOR EACH ROW
EXECUTE FUNCTION public.validate_call_flow_isolation();

ALTER FUNCTION public.execute_provider_quote_tool(uuid,text,uuid,text,text,jsonb,jsonb)
  RENAME TO execute_provider_quote_tool_legacy;
CREATE OR REPLACE FUNCTION public.execute_provider_quote_tool(
  p_call_id uuid,p_realtime_call_id text,p_provider_id uuid,
  p_tool_call_id text,p_tool_name text,p_arguments jsonb,p_context jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.calls%ROWTYPE; op public.operations%ROWTYPE; receipt public.tool_command_receipts%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.calls WHERE id=p_call_id AND realtime_call_id=p_realtime_call_id
    AND provider_id=p_provider_id AND persona='provider' AND direction='outbound' AND outcome='active' AND purpose IN ('quote_request','renegotiation','booking_replacement')
    AND quote_request_id IS NOT NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE='P0001'; END IF;
  SELECT * INTO receipt FROM public.tool_command_receipts WHERE call_id=c.id AND tool_call_id=p_tool_call_id;
  IF FOUND THEN
    IF receipt.tool_name IS DISTINCT FROM p_tool_name OR receipt.arguments IS DISTINCT FROM p_arguments THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='P0001';
    END IF;
    RETURN receipt.result;
  END IF;
  IF p_context IS NULL OR p_context->>'quote_request_id' IS DISTINCT FROM c.quote_request_id::text THEN
    RAISE EXCEPTION 'stale_operation' USING ERRCODE='P0001';
  END IF;
  RETURN public.execute_provider_quote_tool_legacy(
    p_call_id,p_realtime_call_id,p_provider_id,p_tool_call_id,p_tool_name,p_arguments,p_context);
END; $$;

-- Keep the immutable-command implementation private to this compatibility
-- boundary. The public wrapper authenticates the selected Booking first and
-- therefore cannot let a legacy argument select a different operation.
ALTER FUNCTION public.execute_provider_booking_tool(uuid,text,uuid,text,text,jsonb,jsonb)
  RENAME TO execute_provider_booking_tool_legacy;
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
     OR c.provider_intent IS DISTINCT FROM (CASE WHEN p_tool_name='reschedule_booking' THEN 'reschedule'::public.provider_operation_intent ELSE 'cancel_booking'::public.provider_operation_intent END) THEN
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
REVOKE ALL ON FUNCTION public.execute_provider_booking_tool(uuid,text,uuid,text,text,jsonb,jsonb),
  public.execute_provider_quote_tool(uuid,text,uuid,text,text,jsonb,jsonb),
  public.create_call_escalation(uuid,text,uuid,text,text,text,text,text,text)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.execute_provider_booking_tool_legacy(uuid,text,uuid,text,text,jsonb,jsonb),
  public.execute_provider_quote_tool_legacy(uuid,text,uuid,text,text,jsonb,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.execute_provider_booking_tool(uuid,text,uuid,text,text,jsonb,jsonb),
  public.execute_provider_quote_tool(uuid,text,uuid,text,text,jsonb,jsonb),
  public.create_call_escalation(uuid,text,uuid,text,text,text,text,text,text) TO service_role;

REVOKE ALL ON FUNCTION public.validate_call_flow_isolation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_call_flow_isolation() TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
