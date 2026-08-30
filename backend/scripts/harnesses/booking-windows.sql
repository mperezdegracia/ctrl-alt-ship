BEGIN;
-- Only fixture construction bypasses circular provenance. Commands run with
-- all normal authorization, immutable-booking and mandate validation triggers.
CREATE FUNCTION pg_temp.booking_fixture(ref text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  contact uuid := gen_random_uuid(); provider uuid := gen_random_uuid();
  op uuid := gen_random_uuid(); mandate uuid := gen_random_uuid();
  client_call uuid := gen_random_uuid(); provider_call uuid := gen_random_uuid();
  request uuid := gen_random_uuid(); quote uuid := gen_random_uuid(); booking uuid := gen_random_uuid();
  first_day text := (current_date + 10)::text; next_day text := (current_date + 11)::text;
  windows jsonb;
BEGIN
  windows := jsonb_build_array(
    jsonb_build_object('start_at',first_day||'T00:00:00-06:00','end_at',first_day||'T23:59:59-06:00'),
    jsonb_build_object('start_at',next_day||'T00:00:00-06:00','end_at',next_day||'T23:59:59-06:00'));
  SET LOCAL session_replication_role=replica;
  INSERT INTO public.contacts(id,name,phone,authorized) VALUES(contact,'Client','+5411'||right(ref,6),true);
  INSERT INTO public.providers(id,name,phone,capabilities) VALUES(provider,'Provider','+5422'||right(ref,6),'{}');
  INSERT INTO public.operations(id,reference,contact_id,status,pickup_location,delivery_location)
    VALUES(op,ref,contact,'notifications_sent','Pickup','Delivery');
  INSERT INTO public.calls(id,operation_id,contact_id,persona,direction,purpose,operation_intent,realtime_call_id)
    VALUES(client_call,op,contact,'client','inbound','operation_management','create','client-'||ref);
  INSERT INTO public.mandates(id,operation_id,version,operation_snapshot,price_cap,currency,action_windows,
    minimum_payment_term_days,confirmed_in_call_id,confirmed_at)
    VALUES(mandate,op,1,jsonb_build_object('container_type',NULL,'gross_weight_kg',NULL,
      'pickup_location','Pickup','delivery_location','Delivery','empty_return_depot',NULL,
      'operational_constraints','[]'::jsonb,'cargo_notes',NULL),1000,'USD',windows,0,client_call,now());
  INSERT INTO public.quote_requests(id,operation_id,provider_id,mandate_id,status,expires_at,idempotency_key)
    VALUES(request,op,provider,mandate,'responded',now()+interval '1 day','request-'||ref);
  INSERT INTO public.quotes(id,quote_request_id,evaluated_mandate_id,version,price_min,price_max,currency,
    proposed_pickup_window,payment_term_days,valid_until,verdict,status)
    VALUES(quote,request,mandate,1,900,900,'USD',windows->0,0,now()+interval '1 day','dentro','received');
  INSERT INTO public.bookings(id,operation_id,quote_id,status,pickup_window_start,pickup_window_end,
    payment_term_days,confirmed_price,confirmed_at,confirmation_reference)
    VALUES(booking,op,quote,'confirmed',(windows->0->>'start_at')::timestamptz,
      (windows->0->>'end_at')::timestamptz,0,900,now(),'original');
  UPDATE public.operations SET current_mandate_id=mandate,current_booking_id=booking WHERE id=op;
  INSERT INTO public.calls(id,provider_id,persona,direction,purpose,provider_intent,realtime_call_id)
    VALUES(provider_call,provider,'provider','inbound','booking_management','undecided','provider-'||ref);
  SET LOCAL session_replication_role=origin;
  PERFORM public.select_provider_booking(provider_call,'provider-'||ref,provider,'select',
    'select_booking_for_reschedule',jsonb_build_object('operation_reference',ref));
  RETURN jsonb_build_object('op',op,'mandate',mandate,'call',provider_call,'provider',provider,
    'booking',booking,'realtime','provider-'||ref,'day',next_day);
END;
$$;

CREATE FUNCTION pg_temp.reschedule(f jsonb, command text, args jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE state jsonb; result jsonb;
BEGIN
  SET LOCAL ROLE service_role;
  state := public.get_provider_tool_state((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid);
  result := public.execute_provider_booking_tool((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid,
    command,'reschedule_booking',args,state->'commandTarget');
  RESET ROLE;
  RETURN result;
END;
$$;

DO $$
DECLARE f jsonb; args jsonb; result jsonb; before_booking jsonb; before_mandate jsonb;
  successor public.bookings%ROWTYPE; message text;
BEGIN
  f := pg_temp.booking_fixture('OP-992001');
  before_booking := (SELECT to_jsonb(b) FROM public.bookings b WHERE id=(f->>'booking')::uuid);
  before_mandate := (SELECT to_jsonb(m) FROM public.mandates m WHERE id=(f->>'mandate')::uuid);
  ASSERT public.get_provider_tool_state((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid)
    ->'selectedBooking'->>'pickup_utc_offset'='-06:00';
  args := jsonb_build_object('reason','Any time the next day','proposed_pickup_local_window',
    jsonb_build_object('start_at',(f->>'day')||'T00:00:00','end_at',(f->>'day')||'T23:59:59'));
  result := pg_temp.reschedule(f,'local-full-day',args);
  ASSERT result->>'status'='applied', result::text;
  ASSERT result->'reason_code'='null'::jsonb;
  SELECT b.* INTO successor FROM public.bookings b JOIN public.operations o ON o.current_booking_id=b.id WHERE o.id=(f->>'op')::uuid;
  ASSERT successor.id<>(f->>'booking')::uuid;
  ASSERT successor.pickup_window_start=((f->>'day')||'T00:00:00-06:00')::timestamptz;
  ASSERT successor.pickup_window_end=((f->>'day')||'T23:59:59-06:00')::timestamptz, 'full day was narrowed';
  ASSERT successor.confirmed_price=900 AND successor.payment_term_days=0;
  ASSERT (SELECT to_jsonb(b)=before_booking FROM public.bookings b WHERE id=(f->>'booking')::uuid);
  ASSERT (SELECT to_jsonb(m)=before_mandate FROM public.mandates m WHERE id=(f->>'mandate')::uuid);
  ASSERT (SELECT count(*)=1 FROM public.change_requests WHERE source_call_id=(f->>'call')::uuid AND status='applied');
  ASSERT NOT EXISTS(SELECT 1 FROM public.escalations WHERE operation_id=(f->>'op')::uuid);
  ASSERT public.get_provider_tool_state((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid)->>'profile'='terminal';
  ASSERT pg_temp.reschedule(f,'local-full-day',args)=result, 'replay should not reinterpret local times';
  ASSERT (SELECT count(*)=2 FROM public.bookings WHERE operation_id=(f->>'op')::uuid), 'duplicate successor';

  -- Reproduce the original incident: -05:00 was guessed instead of stored -06:00.
  f := pg_temp.booking_fixture('OP-992002');
  args := jsonb_build_object('reason','Wrong guessed offset','proposed_pickup_window',
    jsonb_build_object('start_at',(f->>'day')||'T00:00:00-05:00','end_at',(f->>'day')||'T23:59:59-05:00'));
  result := pg_temp.reschedule(f,'old-wrong-offset',args);
  ASSERT result->>'status'='alternatives_available' AND result->>'reason_code'='outside_action_window', result::text;
  ASSERT (SELECT current_booking_id=(f->>'booking')::uuid FROM public.operations WHERE id=(f->>'op')::uuid);

  -- Outside local windows offers choices first, without expanding the mandate.
  f := pg_temp.booking_fixture('OP-992003');
  args := jsonb_build_object('reason','Outside day','proposed_pickup_local_window',
    jsonb_build_object('start_at',((f->>'day')::date+1)::text||'T00:00:00',
      'end_at',((f->>'day')::date+1)::text||'T23:59:59'));
  result := pg_temp.reschedule(f,'outside-day',args);
  ASSERT result->>'status'='alternatives_available' AND result->>'reason_code'='outside_action_window';
  ASSERT (SELECT count(*)=1 FROM public.bookings WHERE operation_id=(f->>'op')::uuid);
  ASSERT jsonb_array_length(result->'available_pickup_local_windows')=2;
  ASSERT result->'available_pickup_local_windows'->1->>'start_at'=(f->>'day')||'T00:00:00';
  ASSERT result->'available_pickup_local_windows'->1->>'end_at'=(f->>'day')||'T23:59:59';
  ASSERT NOT EXISTS (SELECT 1 FROM public.escalations WHERE operation_id=(f->>'op')::uuid);
  ASSERT (SELECT status='pending' FROM public.change_requests WHERE source_call_id=(f->>'call')::uuid);
  ASSERT public.get_provider_tool_state((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid)->>'profile'='provider_reschedule_alternatives';
  BEGIN
    PERFORM public.create_call_escalation((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid,'OP-992003',
      'outside_mandate','Skip options','Requested different day','Resolve pickup time','skip-options');
    RAISE EXCEPTION 'escalation bypassed alternatives';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
    ASSERT message='booking_alternatives_pending',message;
  END;
  -- Choosing one of the offered windows succeeds in the SAME call.
  args:=jsonb_build_object('reason','The second option works','proposed_pickup_local_window',result->'available_pickup_local_windows'->1);
  result:=pg_temp.reschedule(f,'choose-option',args);
  ASSERT result->>'status'='applied',result::text;
  ASSERT public.get_provider_tool_state((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid)->'lastResult'->>'status'='applied';
  ASSERT (SELECT count(*)=1 FROM public.change_requests WHERE source_call_id=(f->>'call')::uuid AND status='rejected');
  ASSERT (SELECT count(*)=1 FROM public.change_requests WHERE source_call_id=(f->>'call')::uuid AND status='applied');
  ASSERT NOT EXISTS (SELECT 1 FROM public.escalations WHERE operation_id=(f->>'op')::uuid);

  -- Refusing every option unlocks escalation without changing the booking.
  f:=pg_temp.booking_fixture('OP-992005');
  args:=jsonb_build_object('reason','Outside day','proposed_pickup_local_window',
    jsonb_build_object('start_at',((f->>'day')::date+1)::text||'T00:00:00','end_at',((f->>'day')::date+1)::text||'T23:59:59'));
  PERFORM pg_temp.reschedule(f,'outside-first',args);
  args:='{"reason":"None of the offered times work"}';
  result:=public.execute_provider_booking_tool((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid,
    'decline-options','decline_reschedule_alternatives',args,
    public.get_provider_tool_state((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid)->'commandTarget');
  ASSERT result->>'status'='requires_escalation' AND result->>'reason_code'='alternatives_declined';
  ASSERT public.execute_provider_booking_tool((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid,
    'decline-options','decline_reschedule_alternatives',args,NULL)=result;
  ASSERT public.get_provider_tool_state((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid)->>'profile'='provider_booking_escalation';
  ASSERT public.get_provider_tool_state((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid)->'lastResult'->>'reason_code'='alternatives_declined';
  ASSERT (SELECT current_booking_id=(f->>'booking')::uuid FROM public.operations WHERE id=(f->>'op')::uuid);
  result:=public.create_call_escalation((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid,'OP-992005',
    'outside_mandate','None of the offered times work','Requested different day and declined options','Resolve pickup time','escalate-after-refusal');
  ASSERT result->>'escalation_id' IS NOT NULL;
  ASSERT (SELECT count(*)=1 FROM public.escalations WHERE operation_id=(f->>'op')::uuid);

  -- Mixed local/zoned inputs and invalid local dates cannot mutate a booking.
  f := pg_temp.booking_fixture('OP-992004');
  args := jsonb_build_object('reason','Invalid date','proposed_pickup_local_window',
    jsonb_build_object('start_at','2099-02-30T00:00:00','end_at','2099-03-01T23:59:59'));
  BEGIN
    PERFORM pg_temp.reschedule(f,'invalid-date',args);
    RAISE EXCEPTION 'invalid date accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
    ASSERT message='invalid_arguments',message;
  END;
  BEGIN
    PERFORM pg_temp.reschedule(f,'mixed-input',args||jsonb_build_object('proposed_pickup_window',args->'proposed_pickup_local_window'));
    RAISE EXCEPTION 'mixed input accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
    ASSERT message='invalid_arguments',message;
  END;
  ASSERT NOT EXISTS(SELECT 1 FROM public.change_requests WHERE source_call_id=(f->>'call')::uuid);
  BEGIN
    PERFORM public.execute_provider_booking_tool((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid,
      'premature-refusal','decline_reschedule_alternatives','{"reason":"No options offered yet"}',
      public.get_provider_tool_state((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid)->'commandTarget');
    RAISE EXCEPTION 'refusal without alternatives accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
    ASSERT message='invalid_transition',message;
  END;
  ASSERT public.provider_booking_alternative_windows('[{"start_at":"2000-01-01T00:00:00-06:00","end_at":"2000-01-01T23:59:59-06:00"}]')='[]'::jsonb;
  ASSERT jsonb_array_length(public.provider_booking_alternative_windows(jsonb_build_array(jsonb_build_object(
    'start_at',to_char(statement_timestamp()-interval '1 hour','YYYY-MM-DD"T"HH24:MI:SS')||'+00:00',
    'end_at',to_char(statement_timestamp()+interval '1 hour','YYYY-MM-DD"T"HH24:MI:SS')||'+00:00'))))=1,
    'remaining portion of an ongoing window should be offered';
  ASSERT public.mandate_pickup_utc_offset('[{"start_at":"2099-09-03T00:00:00-06:00","end_at":"2099-09-03T23:59:59-05:00"}]') IS NULL;
  ASSERT public.mandate_pickup_utc_offset('[{"start_at":"2099-09-03T00:00:00Z","end_at":"2099-09-03T23:59:59+00:00"}]')='+00:00';
  ASSERT NOT has_function_privilege('authenticated','public.execute_provider_booking_tool_legacy(uuid,text,uuid,text,text,jsonb,jsonb)','EXECUTE');
  ASSERT NOT has_function_privilege('service_role','public.execute_provider_booking_tool_legacy(uuid,text,uuid,text,text,jsonb,jsonb)','EXECUTE');
END;
$$;
ROLLBACK;
