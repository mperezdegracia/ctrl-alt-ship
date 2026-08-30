BEGIN;
-- Fixture construction only bypasses circular provenance triggers. All command,
-- revision, selection and booking assertions run with the normal triggers.
CREATE FUNCTION pg_temp.price_fixture(ref text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  contact uuid := gen_random_uuid(); provider uuid := gen_random_uuid();
  op uuid := gen_random_uuid(); mandate uuid := gen_random_uuid();
  client_call uuid := gen_random_uuid(); provider_call uuid := gen_random_uuid();
  round_id uuid := gen_random_uuid(); request uuid := gen_random_uuid();
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.contacts(id,name,phone,authorized) VALUES(contact,'Client','+5411'||right(ref,6),true);
  INSERT INTO public.providers(id,name,phone,capabilities) VALUES(provider,'Provider','+5422'||right(ref,6),'{}');
  INSERT INTO public.operations(id,reference,contact_id,status,pickup_location,delivery_location)
    VALUES(op,ref,contact,'sourcing','Terminal 4','Pilar');
  INSERT INTO public.calls(id,operation_id,contact_id,persona,direction,purpose,operation_intent,realtime_call_id)
    VALUES(client_call,op,contact,'client','inbound','operation_management','create','client-'||ref);
  INSERT INTO public.mandates(id,operation_id,version,operation_snapshot,price_cap,currency,action_windows,
    minimum_payment_term_days,confirmed_in_call_id,confirmed_at)
    VALUES(mandate,op,1,jsonb_build_object('reference',ref,'pickup_location','Terminal 4','delivery_location','Pilar',
      'container_type',NULL,'gross_weight_kg',NULL,'empty_return_depot',NULL,'operational_constraints','[]'::jsonb,'cargo_notes',NULL),
      1000,'USD',jsonb_build_array(jsonb_build_object('start_at',now()+interval '1 day','end_at',now()+interval '2 days')),0,client_call,now());
  UPDATE public.operations SET current_mandate_id=mandate WHERE id=op;
  INSERT INTO public.sourcing_rounds(id,operation_id,mandate_id,kind,status,idempotency_key,first_dispatched_at)
    VALUES(round_id,op,mandate,'initial','active','round-'||ref,now()-interval '6 minutes');
  INSERT INTO public.quote_requests(id,operation_id,provider_id,mandate_id,round_id,status,expires_at,idempotency_key)
    VALUES(request,op,provider,mandate,round_id,'contacted',now()+interval '1 hour','request-'||ref);
  INSERT INTO public.calls(id,operation_id,provider_id,persona,direction,purpose,provider_intent,quote_request_id,realtime_call_id)
    VALUES(provider_call,op,provider,'provider','outbound','quote_request','quote',request,'provider-'||ref);
  SET LOCAL session_replication_role = origin;
  RETURN jsonb_build_object('op',op,'mandate',mandate,'call',provider_call,'provider',provider,'request',request,'realtime','provider-'||ref);
END;
$$;

CREATE FUNCTION pg_temp.submit_price(f jsonb, command text, args jsonb, with_evidence boolean DEFAULT true) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE state jsonb; segment uuid;
BEGIN
  IF with_evidence THEN
  INSERT INTO public.call_transcript_segments(call_id,speaker,content,realtime_item_id)
    VALUES((f->>'call')::uuid,'caller','Confirmo el precio ' || (args->'price_range'->>'max'),command)
    RETURNING id INTO segment;
  -- Staging is intentionally inaccessible directly to the backend role. Its
  -- authorized SECURITY DEFINER RPC must work with that role's permissions.
  SET LOCAL ROLE service_role;
  PERFORM public.stage_provider_quote_evidence((f->>'call')::uuid,f->>'realtime',
    (f->>'provider')::uuid,command,segment);
  RESET ROLE;
  END IF;
  state := public.get_provider_tool_state((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid);
  RETURN public.execute_provider_quote_tool((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid,
    command,'create_quote',args,state->'commandTarget');
END;
$$;

DO $$
DECLARE
  f jsonb; result jsonb; prepared jsonb; previous_quote uuid; accepted_quote uuid;
  args jsonb; original_mandate jsonb; original_quote jsonb; error_message text; i integer;
BEGIN
  f := pg_temp.price_fixture('OP-991001');
  original_mandate := (SELECT to_jsonb(m) FROM public.mandates m WHERE m.id=(f->>'mandate')::uuid);
  args := '{"price_range":{"min":1200,"max":1200}}';
  -- A price observation alone cannot be selected, even after the deadline.
  PERFORM public.record_provider_offer((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid,'offer',args);
  ASSERT NOT coalesce((public.prepare_sourcing_review((f->>'op')::uuid)->>'ready')::boolean,false);
  result := pg_temp.submit_price(f,'quote-1',args);
  ASSERT result->>'verdict'='contraoferta' AND result->>'accepted_above_budget'='false';
  ASSERT NOT coalesce((public.prepare_sourcing_review((f->>'op')::uuid)->>'ready')::boolean,false), 'unaccepted outside quote selected';
  previous_quote := (SELECT id FROM public.quotes WHERE quote_request_id=(f->>'request')::uuid);
  original_quote := (SELECT to_jsonb(q) FROM public.quotes q WHERE id=previous_quote);
  ASSERT result->>'negotiation_rounds_remaining'='1';
  BEGIN
    PERFORM pg_temp.submit_price(f,'too-early',args||'{"accept_above_budget":true}');
    RAISE EXCEPTION 'accepted above budget before two attempts';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN GET STACKED DIAGNOSTICS error_message = MESSAGE_TEXT;
    ASSERT error_message='negotiation_required', error_message;
  END;
  -- A provider can reaffirm the same price after each real discount request.
  result := pg_temp.submit_price(f,'second-attempt',args);

  ASSERT result->>'verdict'='fuera' AND result->>'negotiation_rounds_remaining'='0';
  ASSERT result->>'accepted_above_budget'='false';
  ASSERT NOT coalesce((public.prepare_sourcing_review((f->>'op')::uuid)->>'ready')::boolean,false);
  BEGIN
    PERFORM pg_temp.submit_price(f,'third-attempt',args);
    RAISE EXCEPTION 'third attempt allowed';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN GET STACKED DIAGNOSTICS error_message = MESSAGE_TEXT;
    ASSERT error_message='invalid_transition', error_message;
  END;
  BEGIN
    PERFORM pg_temp.submit_price(f,'bad-flag',args||'{"accept_above_budget":"true"}');
    RAISE EXCEPTION 'string approval accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN GET STACKED DIAGNOSTICS error_message = MESSAGE_TEXT;
    ASSERT error_message='invalid_arguments', error_message;
  END;
  BEGIN
    PERFORM pg_temp.submit_price(f,'changed-currency',args||'{"accept_above_budget":true,"currency":"ARS"}');
    RAISE EXCEPTION 'currency override accepted';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN GET STACKED DIAGNOSTICS error_message = MESSAGE_TEXT;
    ASSERT error_message='invalid_arguments', error_message;
  END;
  result := pg_temp.submit_price(f,'accept-final',args||'{"accept_above_budget":true}');
  ASSERT result->>'verdict'='fuera' AND result->>'accepted_above_budget'='true';
  ASSERT result->>'negotiation_remaining'='false';
  ASSERT (SELECT count(*)=3 FROM public.quotes WHERE quote_request_id=(f->>'request')::uuid);
  ASSERT (SELECT NOT accepted_above_budget AND verdict='contraoferta' FROM public.quotes WHERE id=previous_quote), 'old quote mutated';
  accepted_quote := (SELECT id FROM public.quotes WHERE quote_request_id=(f->>'request')::uuid AND accepted_above_budget);
  ASSERT (SELECT to_jsonb(q)=original_quote FROM public.quotes q WHERE id=previous_quote), 'prior quote changed';
  ASSERT (SELECT count(*)=3 FROM public.quote_transcript_evidence e JOIN public.quotes q ON q.id=e.quote_id
    WHERE q.quote_request_id=(f->>'request')::uuid), 'evidence missing from quote revisions';
  ASSERT (SELECT s.realtime_item_id='accept-final' FROM public.quote_transcript_evidence e
    JOIN public.call_transcript_segments s ON s.id=e.evidence_start_segment_id WHERE e.quote_id=accepted_quote),
    'final approval evidence attached to wrong quote';
  BEGIN
    UPDATE public.quotes SET price_min=price_min WHERE id=previous_quote;
    RAISE EXCEPTION 'quote update protection removed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    DELETE FROM public.quotes WHERE id=previous_quote;
    RAISE EXCEPTION 'quote deletion protection removed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    UPDATE public.quote_transcript_evidence SET source_call_id=source_call_id WHERE quote_id=accepted_quote;
    RAISE EXCEPTION 'evidence update protection removed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  -- SQL replay works even when the completed call no longer has a command target.
  ASSERT public.execute_provider_quote_tool((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid,
    'accept-final','create_quote',args||'{"accept_above_budget":true}',NULL)=result;
  ASSERT public.get_provider_tool_state((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid)->>'profile'='terminal';
  prepared := public.prepare_sourcing_review((f->>'op')::uuid);
  ASSERT prepared->>'ready'='true', prepared::text;
  ASSERT prepared->'context'->'selected_quote'->>'id'=accepted_quote::text;
  ASSERT prepared->'context'->'selected_quote'->>'accepted_above_budget'='true';
  -- Snapshot invalidation still blocks acceptance against another mandate.
  PERFORM public.record_sourcing_review((f->>'op')::uuid,prepared->>'input_hash',
    '{"assessment":"clear","summary":"Fixture review","issues":[]}', 'fixture');
  result := public.finalize_operation_sourcing((f->>'op')::uuid);
  ASSERT result->>'finalized'='true', result::text;
  ASSERT (SELECT status='booking_confirmed' FROM public.operations WHERE id=(f->>'op')::uuid);
  ASSERT (SELECT confirmed_price=1200 AND quote_id=accepted_quote FROM public.bookings WHERE id=(result->>'booking_id')::uuid);
  ASSERT (SELECT b.evidence_start_segment_id=e.evidence_start_segment_id
      AND b.evidence_end_segment_id=e.evidence_end_segment_id AND b.source_call_id=e.source_call_id
    FROM public.bookings b JOIN public.quote_transcript_evidence e ON e.quote_id=b.quote_id
    WHERE b.id=(result->>'booking_id')::uuid), 'booking lost quote evidence';
  ASSERT (SELECT count(*)=3 FROM public.quotes WHERE quote_request_id=(f->>'request')::uuid), 'replay inserted duplicate';
  ASSERT (SELECT to_jsonb(m)=original_mandate FROM public.mandates m WHERE id=(f->>'mandate')::uuid), 'mandate altered';
  ASSERT EXISTS (SELECT 1 FROM public.events WHERE operation_id=(f->>'op')::uuid AND type='booking.confirmed'
    AND payload->>'accepted_above_budget'='true'), 'missing acceptance audit';

  -- Bargaining can exhaust its revisions without preventing explicit acceptance.
  f := pg_temp.price_fixture('OP-991002');
  FOR i IN 0..1 LOOP
    args := jsonb_build_object('price_range',jsonb_build_object('min',1400-i*10,'max',1400-i*10));
    result := pg_temp.submit_price(f,'revision-'||i,args);
  END LOOP;
  ASSERT result->>'verdict'='fuera' AND result->>'accepted_above_budget'='false';
  ASSERT NOT coalesce((public.prepare_sourcing_review((f->>'op')::uuid)->>'ready')::boolean,false);
  -- Reproduce the previous version's terminal marker for this same rejected quote.
  UPDATE public.calls SET provider_tools_completed_at=now() WHERE id=(f->>'call')::uuid;
  ASSERT public.get_provider_tool_state((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid)->>'profile'='provider_quote';
  result := pg_temp.submit_price(f,'accept-after-rounds',args||'{"accept_above_budget":true}');
  ASSERT result->>'accepted_above_budget'='true';
  ASSERT public.prepare_sourcing_review((f->>'op')::uuid)->>'ready'='true';

  -- Frustration/refusal to keep bargaining allows an explicit early acceptance.
  f := pg_temp.price_fixture('OP-991005');
  args := '{"price_range":{"min":1200,"max":1200}}';
  result := pg_temp.submit_price(f,'first-attempt',args);
  ASSERT result->>'negotiation_rounds_remaining'='1';
  BEGIN
    PERFORM pg_temp.submit_price(f,'frustration-is-not-consent',args||'{"negotiation_stopped_by_provider":true}');
    RAISE EXCEPTION 'frustration implicitly approved the price';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN GET STACKED DIAGNOSTICS error_message = MESSAGE_TEXT;
    ASSERT error_message='invalid_arguments', error_message;
  END;
  result := pg_temp.submit_price(f,'confirmed-final-after-stop',args||'{"accept_above_budget":true,"negotiation_stopped_by_provider":true}');
  ASSERT result->>'accepted_above_budget'='true' AND result->>'negotiation_stopped_by_provider'='true';
  ASSERT EXISTS (SELECT 1 FROM public.quotes WHERE quote_request_id=(f->>'request')::uuid
    AND accepted_above_budget AND negotiation_stopped_by_provider);
  ASSERT public.prepare_sourcing_review((f->>'op')::uuid)->>'ready'='true';

  -- Within-budget quotes keep the ordinary path; a flag does not change their classification.
  f := pg_temp.price_fixture('OP-991003');
  result := pg_temp.submit_price(f,'within','{"price_range":{"min":900,"max":900},"accept_above_budget":true}',false);
  ASSERT result->>'verdict'='dentro' AND result->>'accepted_above_budget'='false';
  ASSERT NOT EXISTS (SELECT 1 FROM public.quote_transcript_evidence e JOIN public.quotes q ON q.id=e.quote_id
    WHERE q.quote_request_id=(f->>'request')::uuid), 'missing evidence must not be fabricated';
  ASSERT public.prepare_sourcing_review((f->>'op')::uuid)->>'ready'='true';

  -- A fresh acceptance is scoped to the live call, current operation and mandate.
  f := pg_temp.price_fixture('OP-991004');
  prepared := public.get_provider_tool_state((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid);
  BEGIN
    PERFORM public.execute_provider_quote_tool((f->>'call')::uuid,f->>'realtime',gen_random_uuid(),
      'wrong-owner','create_quote','{"price_range":{"min":1200,"max":1200},"accept_above_budget":true}',prepared->'commandTarget');
    RAISE EXCEPTION 'other provider accepted quote';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN GET STACKED DIAGNOSTICS error_message = MESSAGE_TEXT;
    ASSERT error_message='not_authorized', error_message;
  END;
  BEGIN
    PERFORM public.execute_provider_quote_tool((f->>'call')::uuid,f->>'realtime',(f->>'provider')::uuid,
      'stale','create_quote','{"price_range":{"min":1200,"max":1200},"accept_above_budget":true}',
      (prepared->'commandTarget')||'{"operation_revision":"old"}');
    RAISE EXCEPTION 'stale acceptance allowed';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN GET STACKED DIAGNOSTICS error_message = MESSAGE_TEXT;
    ASSERT error_message='stale_operation', error_message;
  END;
  ASSERT NOT EXISTS (SELECT 1 FROM public.quotes WHERE quote_request_id=(f->>'request')::uuid);
END;
$$;
ROLLBACK;
