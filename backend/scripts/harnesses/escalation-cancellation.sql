BEGIN;
DO $$
DECLARE
  contact uuid := gen_random_uuid();
  other_contact uuid := gen_random_uuid();
  op uuid := gen_random_uuid();
  live_call uuid := gen_random_uuid();
  result jsonb;
  first_case uuid;
  next_case uuid;
  before_operation jsonb;
  before_call jsonb;
  error_message text;
BEGIN
  INSERT INTO public.contacts(id, name, phone, authorized)
    VALUES(contact, 'Client', '+5491100000011', true), (other_contact, 'Other', '+5491100000012', true);
  INSERT INTO public.operations(id, reference, contact_id, status, pickup_location, delivery_location)
    VALUES(op, 'OP-990001', contact, 'collecting_details', 'Terminal 4', 'Pilar');
  INSERT INTO public.calls(id, operation_id, contact_id, persona, direction, purpose,
    operation_intent, realtime_call_id, twilio_call_sid)
    VALUES(live_call, op, contact, 'client', 'inbound', 'operation_management', 'create', 'rtc-cancel', 'CA-cancel');
  before_operation := (SELECT to_jsonb(o) FROM public.operations o WHERE id = op);
  before_call := (SELECT to_jsonb(c) FROM public.calls c WHERE id = live_call);
  result := public.create_call_escalation(live_call, 'rtc-cancel', contact, 'OP-990001',
    'explicit_human_request', 'Asked for a person', 'Verified route Terminal 4 to Pilar', 'Continue intake', 'start-1');
  first_case := (result->>'escalation_id')::uuid;
  BEGIN
    PERFORM public.cancel_call_escalation(live_call, 'rtc-cancel', other_contact, first_case);
    RAISE EXCEPTION 'wrong contact accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN GET STACKED DIAGNOSTICS error_message = MESSAGE_TEXT;
    ASSERT error_message = 'not_authorized', error_message;
  END;
  BEGIN
    PERFORM public.cancel_call_escalation(live_call, 'wrong-realtime-id', contact, first_case);
    RAISE EXCEPTION 'wrong realtime call accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN GET STACKED DIAGNOSTICS error_message = MESSAGE_TEXT;
    ASSERT error_message = 'not_authorized', error_message;
  END;
  PERFORM public.cancel_call_escalation(live_call, 'rtc-cancel', contact, first_case);
  PERFORM public.cancel_call_escalation(live_call, 'rtc-cancel', contact, first_case);
  ASSERT (SELECT status = 'resolved' AND resolved_at IS NOT NULL FROM public.escalations WHERE id = first_case);
  ASSERT (SELECT count(*) = 1 FROM public.events WHERE call_id = live_call
    AND type = 'escalation.resolved' AND payload->>'resolution' = 'cancelled'), 'duplicate cancellation event';
  ASSERT (SELECT to_jsonb(o) = before_operation FROM public.operations o WHERE id = op), 'operation data changed';
  ASSERT (SELECT to_jsonb(c) = before_call FROM public.calls c WHERE id = live_call), 'call context changed';
  ASSERT (SELECT count(*) = 1 FROM public.escalation_contexts WHERE escalation_id = first_case), 'brief lost';
  BEGIN
    PERFORM public.create_call_escalation(live_call, 'rtc-cancel', contact, 'OP-990001',
      'explicit_human_request', 'Asked for a person', 'Verified route Terminal 4 to Pilar', 'Continue intake', 'start-1');
    RAISE EXCEPTION 'cancelled escalation rearmed';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN GET STACKED DIAGNOSTICS error_message = MESSAGE_TEXT;
    ASSERT error_message = 'invalid_transition', error_message;
  END;
  -- No configured recipient still supports going back.
  UPDATE public.handoff_recipients SET active = false;
  result := public.create_call_escalation(live_call, 'rtc-cancel', contact, 'OP-990001',
    'explicit_human_request', 'Asked again', 'Same saved context', 'Continue intake', 'start-2');
  next_case := (result->>'escalation_id')::uuid;
  ASSERT result->>'handoff_status' = 'not_configured';
  PERFORM public.cancel_call_escalation(live_call, 'rtc-cancel', contact, first_case);
  ASSERT (SELECT status = 'started' FROM public.escalations WHERE id = next_case), 'old replay closed new review';
  PERFORM public.cancel_call_escalation(live_call, 'rtc-cancel', contact, next_case);
  result := public.create_call_escalation(live_call, 'rtc-cancel', contact, 'OP-990001',
    'explicit_human_request', 'Asked again', 'Same saved context', 'Continue intake', 'start-3');
  next_case := (result->>'escalation_id')::uuid;
  UPDATE public.escalations SET handoff_status = 'transfer_requested' WHERE id = next_case;
  BEGIN
    PERFORM public.cancel_call_escalation(live_call, 'rtc-cancel', contact, next_case);
    RAISE EXCEPTION 'transfer cancellation accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN GET STACKED DIAGNOSTICS error_message = MESSAGE_TEXT;
    ASSERT error_message = 'invalid_transition', error_message;
  END;
  ASSERT (SELECT status = 'started' FROM public.escalations WHERE id = next_case);
  ASSERT NOT has_function_privilege('authenticated', 'public.cancel_call_escalation(uuid,text,uuid,uuid)', 'EXECUTE');
  ASSERT NOT has_function_privilege('anon', 'public.cancel_call_escalation(uuid,text,uuid,uuid)', 'EXECUTE');
  ASSERT has_function_privilege('service_role', 'public.cancel_call_escalation(uuid,text,uuid,uuid)', 'EXECUTE');
END;
$$;
ROLLBACK;
