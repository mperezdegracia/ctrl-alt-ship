-- Disposable PostgreSQL fixture. Every assertion rolls back with this transaction.
BEGIN;

DO $$
DECLARE
  contact_id uuid := '10000000-0000-4000-8000-000000000001';
  provider_id uuid := '20000000-0000-4000-8000-000000000001';
  op_id uuid := '30000000-0000-4000-8000-000000000001';
  mandate_id uuid := '40000000-0000-4000-8000-000000000001';
  request_id uuid := '50000000-0000-4000-8000-000000000001';
  quote_id uuid := '60000000-0000-4000-8000-000000000001';
  booking_id uuid := '70000000-0000-4000-8000-000000000001';
  round_id uuid := '80000000-0000-4000-8000-000000000001';
  inbound_id uuid := '90000000-0000-4000-8000-000000000001';
  fresh_id uuid := '90000000-0000-4000-8000-000000000002';
  expired_id uuid := '90000000-0000-4000-8000-000000000003';
  dual_id uuid := '90000000-0000-4000-8000-000000000004';
  late_id uuid := '90000000-0000-4000-8000-000000000005';
  no_audio_id uuid := '90000000-0000-4000-8000-000000000006';
  source_call_id uuid := '90000000-0000-4000-8000-000000000007';
  seg_id uuid := 'a0000000-0000-4000-8000-000000000001';
  recent_seg_id uuid := 'a0000000-0000-4000-8000-000000000002';
  fresh_seg_id uuid := 'a0000000-0000-4000-8000-000000000003';
  rec_completed text := 'RE' || repeat('1',32);
  rec_in_progress text := 'RE' || repeat('2',32);
  rec_late text := 'RE' || repeat('3',32);
  rec_dual_done text := 'RE' || repeat('4',32);
  rec_dual_live text := 'RE' || repeat('5',32);
  rec_no_audio text := 'RE' || repeat('6',32);
  ca_inbound text := 'CA' || repeat('1',32);
  ca_fresh text := 'CA' || repeat('2',32);
  ca_expired text := 'CA' || repeat('3',32);
  ca_dual text := 'CA' || repeat('4',32);
  ca_late text := 'CA' || repeat('5',32);
  ca_no_audio text := 'CA' || repeat('6',32);
  before_content text; before_booking jsonb; result jsonb; code text; claim jsonb;
  expect_count integer;
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.contacts(id,name,phone) VALUES(contact_id,'Fixture Client','+5491100000001');
  INSERT INTO public.providers(id,name,phone,capabilities) VALUES(provider_id,'Fixture Provider','+5491100000002','{}');
  INSERT INTO public.calls(id,operation_id,provider_id,persona,direction,provider_intent,purpose,outcome,twilio_call_sid,realtime_call_id)
    VALUES(inbound_id,NULL,provider_id,'provider','inbound','undecided',NULL,'active',ca_inbound,'fixture-inbound');
  INSERT INTO public.operations(id,reference,contact_id,status,current_mandate_id,pickup_location,delivery_location,container_type,gross_weight_kg)
    VALUES(op_id,'OP-900001',contact_id,'sourcing',mandate_id,'Terminal 4','Gonzalez Catan','40HC',1000);
  INSERT INTO public.calls(id,operation_id,provider_id,persona,direction,provider_intent,purpose,outcome,twilio_call_sid,realtime_call_id)
    VALUES(source_call_id,op_id,provider_id,'provider','outbound','quote','quote_request','completed','CA'||repeat('7',32),'fixture-source');
  INSERT INTO public.mandates(id,operation_id,version,operation_snapshot,price_cap,currency,action_windows,minimum_payment_term_days,confirmed_in_call_id,confirmed_at)
    VALUES(mandate_id,op_id,1,jsonb_build_object('reference','OP-900001','pickup_location','Terminal 4','delivery_location','Gonzalez Catan','empty_return_depot',NULL,'container_type','40HC','gross_weight_kg',1000,'operational_constraints',jsonb_build_array(),'cargo_notes',NULL),1000,'USD',jsonb_build_array(jsonb_build_object('start_at','2030-01-01T00:00:00Z','end_at','2030-01-02T00:00:00Z')),0,source_call_id,now());
  INSERT INTO public.sourcing_rounds(id,operation_id,mandate_id,kind,status,idempotency_key) VALUES(round_id,op_id,mandate_id,'initial','active','fixture-round');
  INSERT INTO public.quote_requests(id,operation_id,provider_id,mandate_id,status,expires_at,idempotency_key,round_id)
    VALUES(request_id,op_id,provider_id,mandate_id,'responded',now()+interval '1 hour','fixture-request',round_id);
  INSERT INTO public.quotes(id,quote_request_id,evaluated_mandate_id,version,price_min,price_max,currency,proposed_pickup_window,verdict,status,received_at)
    VALUES(quote_id,request_id,mandate_id,1,900,900,'USD',jsonb_build_object('start_at','2030-01-01T00:00:00Z','end_at','2030-01-01T01:00:00Z'),'dentro','received',now());
  INSERT INTO public.call_transcript_segments(id,call_id,speaker,content,realtime_item_id,recorded_at) VALUES(seg_id,source_call_id,'caller','booking evidence','booking-item',now());
  INSERT INTO public.bookings(id,operation_id,quote_id,status,pickup_window_start,pickup_window_end,confirmed_price,confirmed_at,source_call_id,evidence_start_segment_id,evidence_end_segment_id)
    VALUES(booking_id,op_id,quote_id,'confirmed','2030-01-01T00:00:00Z','2030-01-01T01:00:00Z',900,now(),source_call_id,seg_id,seg_id);
  UPDATE public.operations SET current_booking_id=booking_id WHERE id=op_id;
  INSERT INTO public.calls(id,operation_id,provider_id,persona,direction,provider_intent,purpose,outcome,twilio_call_sid,realtime_call_id,evidence_expires_at,recording_status,recording_sid,recording_completed_at)
    VALUES(fresh_id,op_id,provider_id,'provider','outbound','quote','quote_request','completed',ca_fresh,'fixture-fresh',now()+interval '1 day','pending',NULL,NULL);
  INSERT INTO public.calls(id,operation_id,provider_id,persona,direction,provider_intent,purpose,outcome,twilio_call_sid,realtime_call_id,evidence_expires_at,recording_status)
    VALUES(expired_id,op_id,provider_id,'provider','outbound','quote','quote_request','completed',ca_expired,'fixture-expired',now()-interval '1 day','completed');
  INSERT INTO public.calls(id,operation_id,provider_id,persona,direction,provider_intent,purpose,outcome,twilio_call_sid,realtime_call_id,evidence_expires_at,recording_status)
    VALUES(dual_id,op_id,provider_id,'provider','outbound','quote','quote_request','completed',ca_dual,'fixture-dual',now()-interval '1 day','deletion_pending');
  INSERT INTO public.calls(id,operation_id,provider_id,persona,direction,provider_intent,purpose,outcome,twilio_call_sid,realtime_call_id,evidence_expires_at,recording_status)
    VALUES(late_id,op_id,provider_id,'provider','outbound','quote','quote_request','completed',ca_late,'fixture-late',now()-interval '1 day','completed');
  INSERT INTO public.calls(id,operation_id,provider_id,persona,direction,provider_intent,purpose,outcome,twilio_call_sid,realtime_call_id,evidence_expires_at,recording_status)
    VALUES(no_audio_id,op_id,provider_id,'provider','outbound','quote','quote_request','completed',ca_no_audio,'fixture-no-audio',now()-interval '1 day','absent');
  SET LOCAL session_replication_role = origin;
  INSERT INTO public.call_transcript_segments(id,call_id,speaker,content,realtime_item_id,recorded_at) VALUES(fresh_seg_id,fresh_id,'caller','keep me','fresh-item',now());
  INSERT INTO public.call_transcript_segments(id,call_id,speaker,content,realtime_item_id,recorded_at) VALUES(recent_seg_id,expired_id,'caller','recent evidence','recent-item',now());
  INSERT INTO public.call_recordings(recording_sid,call_id,status) VALUES(rec_completed,expired_id,'completed'),(rec_in_progress,expired_id,'in-progress'),(rec_dual_done,dual_id,'completed'),(rec_dual_live,dual_id,'in-progress'),(rec_late,late_id,'completed'),(rec_no_audio,no_audio_id,'absent');
  before_content:=(SELECT content FROM public.call_transcript_segments WHERE id=fresh_seg_id);
  before_booking:=to_jsonb((SELECT b FROM public.bookings b WHERE b.id=booking_id));

  BEGIN UPDATE public.call_transcript_segments SET content='changed' WHERE id=fresh_seg_id; EXCEPTION WHEN OTHERS THEN code:=SQLSTATE; END;
  ASSERT code='55000','unexpired transcript content mutation must be rejected';
  code:=NULL;
  BEGIN UPDATE public.call_transcript_segments SET id='a0000000-0000-4000-8000-000000000009' WHERE id=fresh_seg_id; EXCEPTION WHEN OTHERS THEN code:=SQLSTATE; END;
  ASSERT code='55000','transcript id mutation must be rejected'; code:=NULL;
  BEGIN DELETE FROM public.call_transcript_segments WHERE id=fresh_seg_id; EXCEPTION WHEN OTHERS THEN code:=SQLSTATE; END;
  ASSERT code='55000','transcript delete must be rejected'; code:=NULL;
  BEGIN UPDATE public.call_transcript_segments SET content=NULL,content_deleted_at=now() WHERE id=fresh_seg_id; EXCEPTION WHEN OTHERS THEN code:=SQLSTATE; END;
  ASSERT code='55000','unexpired redaction must be rejected'; code:=NULL;
  PERFORM public.purge_expired_call_transcripts(ARRAY[fresh_id]);
  ASSERT (SELECT content FROM public.call_transcript_segments WHERE id=fresh_seg_id)=before_content,'unexpired purge changed transcript';
  PERFORM public.purge_expired_call_transcripts(ARRAY[expired_id]);
  ASSERT (SELECT content IS NULL AND content_deleted_at IS NOT NULL FROM public.call_transcript_segments WHERE id=recent_seg_id),'expired transcript was not tombstoned';
  ASSERT (SELECT transcript_purged_at IS NOT NULL FROM public.calls WHERE id=expired_id),'empty/expired marker missing';
  PERFORM public.record_call_transcript_segment(expired_id,'fixture-expired','caller','late text','late-item',NULL);
  ASSERT (SELECT content IS NULL AND content_deleted_at IS NOT NULL FROM public.call_transcript_segments WHERE call_id=expired_id AND realtime_item_id='late-item'),'late transcript was restored';
  BEGIN UPDATE public.call_transcript_segments SET content='restore' WHERE id=recent_seg_id; EXCEPTION WHEN OTHERS THEN code:=SQLSTATE; END;
  ASSERT code='55000','tombstone restore must be rejected'; code:=NULL;
  BEGIN DELETE FROM public.call_transcript_segments WHERE id=recent_seg_id; EXCEPTION WHEN OTHERS THEN code:=SQLSTATE; END;
  ASSERT code='55000','tombstone delete must be rejected'; code:=NULL;
  PERFORM set_config('app.evidence_purge','on',true);
  BEGIN UPDATE public.call_transcript_segments SET content='restore' WHERE id=recent_seg_id; EXCEPTION WHEN OTHERS THEN code:=SQLSTATE; END;
  ASSERT code='55000','purge GUC must not bypass tombstone guard'; code:=NULL;
  ASSERT to_jsonb((SELECT b FROM public.bookings b WHERE b.id=booking_id))=before_booking,'booking changed during retention';
  ASSERT (SELECT b.quote_id FROM public.bookings b WHERE b.id=booking_id)=quote_id,'booking FK no longer resolves';
  BEGIN UPDATE public.bookings SET confirmed_price=901 WHERE id=booking_id; EXCEPTION WHEN OTHERS THEN code:=SQLSTATE; END;
  ASSERT code='55000','booking update must be rejected'; code:=NULL;

  result:=public.record_call_recording_status(ca_expired,rec_completed,'in-progress');
  ASSERT (SELECT status FROM public.call_recordings WHERE recording_sid=rec_completed)='completed','completed recording downgraded';
  result:=public.record_call_recording_status(ca_expired,rec_completed,'absent');
  ASSERT (SELECT status FROM public.call_recordings WHERE recording_sid=rec_completed)='completed','completed recording downgraded to absent';
  BEGIN PERFORM public.record_call_recording_status(ca_fresh,rec_completed,'completed'); EXCEPTION WHEN OTHERS THEN code:=SQLSTATE; END;
  ASSERT code='23514','cross-call recording SID accepted'; code:=NULL;
  BEGIN PERFORM public.record_call_recording_status('CA'||repeat('9',32),rec_late,'completed'); EXCEPTION WHEN OTHERS THEN code:=SQLSTATE; END;
  ASSERT code='P0002','unknown callback call accepted'; code:=NULL;
  result:=public.record_call_recording_status(ca_late,'RE'||repeat('7',32),'completed');
  ASSERT (result->>'expired')::boolean,'late new SID not marked expired';
  ASSERT (SELECT status FROM public.call_recordings WHERE recording_sid='RE'||repeat('7',32))='completed','late SID missing';

  claim:=public.claim_call_evidence_retention(100);
  ASSERT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(claim) x WHERE x->>'call_id'=fresh_id::text),'unexpired call claimed';
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(claim) x WHERE x->>'call_id'=no_audio_id::text AND jsonb_typeof(x->'transcript_pending')='boolean' AND x->'recordings'='[]'::jsonb),'no-SID marker not claimable';
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(claim) x WHERE x->>'call_id'=dual_id::text AND (x->'recordings') @> jsonb_build_array(jsonb_build_object('recording_sid',rec_dual_done))),'completed dual SID not claimable';
  ASSERT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(claim) x WHERE x->>'call_id'=dual_id::text AND (x->'recordings') @> jsonb_build_array(jsonb_build_object('recording_sid',rec_dual_live))),'in-progress SID claimed';
  PERFORM public.complete_call_recording_deletion(dual_id,rec_dual_done,NULL);
  ASSERT (SELECT recording_status FROM public.calls WHERE id=dual_id)='deletion_pending','aggregate deleted with live SID';
  PERFORM public.complete_call_recording_deletion(late_id,'RE'||repeat('7',32),NULL);
  PERFORM public.complete_call_recording_deletion(late_id,'RE'||repeat('7',32),'late error');
  PERFORM public.complete_call_recording_deletion(late_id,rec_late,NULL);
  ASSERT (SELECT deleted_at IS NOT NULL AND deletion_error IS NULL FROM public.call_recordings WHERE recording_sid='RE'||repeat('7',32)),'deleted timestamp regressed';
  ASSERT (SELECT recording_status='deleted' FROM public.calls WHERE id=late_id),'late recording not deleted';

  ASSERT (SELECT has_function_privilege('service_role','public.claim_call_evidence_retention(integer)','EXECUTE')),'service role cannot claim';
  ASSERT NOT has_function_privilege('authenticated','public.claim_call_evidence_retention(integer)','EXECUTE'),'authenticated can claim';
  ASSERT NOT has_table_privilege('service_role','public.call_recordings','UPDATE'),'service role can update recordings directly';
END $$;

ROLLBACK;
