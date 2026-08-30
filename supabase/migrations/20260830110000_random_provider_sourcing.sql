-- Demo policy: contact up to two distinct active providers chosen at random.
-- Equipment compatibility no longer filters who receives a quote request.
-- Existing requests and booking/quote eligibility rules are unchanged.
BEGIN;

CREATE OR REPLACE FUNCTION public.enqueue_mandate_sourcing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE candidate record; op public.operations%ROWTYPE; request_id uuid; count_selected integer := 0;
BEGIN
  SELECT * INTO op FROM public.operations WHERE id = NEW.operation_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  FOR candidate IN SELECT id FROM public.providers WHERE active
    ORDER BY random() LIMIT 2
  LOOP
    -- Persist the random selection once per inserted mandate. The worker retries
    -- the same requests rather than choosing different providers on each retry.
    INSERT INTO public.quote_requests (operation_id, provider_id, mandate_id, contact_attempt, status, expires_at, idempotency_key)
    VALUES (op.id, candidate.id, NEW.id, 1, 'queued', 'infinity'::timestamptz,
      'mandate:' || NEW.id::text || ':provider:' || candidate.id::text)
    ON CONFLICT (idempotency_key) DO NOTHING RETURNING id INTO request_id;
    IF request_id IS NOT NULL THEN
      count_selected := count_selected + 1;
      INSERT INTO public.outbox (operation_id, quote_request_id, job_type, payload, idempotency_key)
      VALUES (op.id, request_id, 'contact_provider',
        jsonb_build_object('purpose', CASE WHEN NEW.supersedes_mandate_id IS NULL THEN 'quote_request' ELSE 'renegotiation' END),
        'contact-provider:' || request_id::text);
    END IF;
  END LOOP;
  INSERT INTO public.events (type, operation_id, call_id, payload)
  VALUES ('sourcing.dispatch_queued', op.id, NEW.confirmed_in_call_id,
    jsonb_build_object('mandate_id', NEW.id, 'provider_count', count_selected));
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
