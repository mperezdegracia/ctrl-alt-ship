-- SMS replaces booking-confirmation email. The durable outbox remains the
-- source of truth; Twilio acceptance is recorded with its Message SID.
BEGIN;

CREATE INDEX IF NOT EXISTS outbox_sms_claim_idx
  ON public.outbox (available_at, created_at)
  WHERE job_type = 'send_sms' AND status IN ('pending', 'processing');

CREATE OR REPLACE FUNCTION public.enqueue_booking_confirmation_sms(
  p_operation_id uuid,
  p_booking_id uuid,
  p_template text,
  p_recipient_type text,
  p_recipient_name text,
  p_recipient_phone text,
  p_recipient_phone_type text,
  p_payload jsonb,
  p_idempotency_key text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  queued_outbox_id uuid;
BEGIN
  INSERT INTO public.outbox (operation_id, job_type, payload, idempotency_key)
  VALUES (
    p_operation_id,
    'send_sms',
    p_payload || jsonb_build_object(
      'template', p_template,
      'recipient_type', p_recipient_type,
      'recipient_name', p_recipient_name,
      'recipient_phone', p_recipient_phone,
      'recipient_phone_type', p_recipient_phone_type,
      'booking_id', p_booking_id
    ),
    p_idempotency_key
  ) ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO queued_outbox_id;

  IF queued_outbox_id IS NOT NULL THEN
    INSERT INTO public.events (operation_id, type, payload)
    VALUES (
      p_operation_id,
      'sms.queued',
      jsonb_build_object(
        'outbox_id', queued_outbox_id,
        'template', p_template,
        'recipient_type', p_recipient_type,
        'deduplication_key', p_idempotency_key
      )
    );
    RETURN queued_outbox_id;
  END IF;

  SELECT id INTO queued_outbox_id FROM public.outbox WHERE idempotency_key = p_idempotency_key;
  RETURN queued_outbox_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.queue_booking_confirmation_sms(
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
  sms_payload jsonb;
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
    contact.phone AS client_phone,
    CASE WHEN contact.phone LIKE '+549%' THEN 'mobile' ELSE NULL END AS client_phone_type,
    provider.name AS provider_name,
    provider.phone AS provider_phone,
    CASE
      WHEN provider.capabilities->>'phone_type' IN ('mobile', 'landline')
        THEN provider.capabilities->>'phone_type'
      WHEN provider.phone LIKE '+549%' THEN 'mobile'
      ELSE NULL
    END AS provider_phone_type
  INTO booking_row
  FROM public.bookings AS booking
  JOIN public.operations AS operation ON operation.id = booking.operation_id
  JOIN public.quotes AS quote ON quote.id = booking.quote_id
  JOIN public.quote_requests AS quote_request ON quote_request.id = quote.quote_request_id
  JOIN public.contacts AS contact ON contact.id = operation.contact_id
  JOIN public.providers AS provider ON provider.id = quote_request.provider_id
  WHERE booking.id = p_booking_id
    AND operation.current_booking_id = booking.id
    AND booking.last_change_request_id IS NULL
    AND booking.status = 'confirmed'
  FOR SHARE OF booking;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_not_confirmed' USING ERRCODE = 'P0001';
  END IF;

  sms_payload := jsonb_build_object(
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

  client_outbox_id := public.enqueue_booking_confirmation_sms(
    booking_row.operation_id,
    booking_row.id,
    'booking_confirmation_client',
    'client',
    booking_row.client_name,
    booking_row.client_phone,
    booking_row.client_phone_type,
    sms_payload,
    'booking-confirmation-sms:' || booking_row.id || ':client'
  );
  provider_outbox_id := public.enqueue_booking_confirmation_sms(
    booking_row.operation_id,
    booking_row.id,
    'booking_confirmation_provider',
    'provider',
    booking_row.provider_name,
    booking_row.provider_phone,
    booking_row.provider_phone_type,
    sms_payload,
    'booking-confirmation-sms:' || booking_row.id || ':provider'
  );

  RETURN QUERY VALUES
    (client_outbox_id, 'client'::text),
    (provider_outbox_id, 'provider'::text);
END;
$$;

-- A booking becomes current only after the durable adjudication transition.
DROP TRIGGER IF EXISTS operations_enqueue_booking_confirmation ON public.operations;
CREATE OR REPLACE FUNCTION public.enqueue_booking_confirmation_sms_after_confirm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.current_booking_id IS NOT NULL
    AND NEW.current_booking_id IS DISTINCT FROM OLD.current_booking_id
    AND EXISTS (
      SELECT 1 FROM public.bookings AS booking
      WHERE booking.id = NEW.current_booking_id
        AND booking.last_change_request_id IS NULL
        AND booking.status = 'confirmed'
    ) THEN
    PERFORM public.queue_booking_confirmation_sms(NEW.current_booking_id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER operations_enqueue_booking_confirmation
AFTER UPDATE OF current_booking_id ON public.operations
FOR EACH ROW EXECUTE FUNCTION public.enqueue_booking_confirmation_sms_after_confirm();

CREATE OR REPLACE FUNCTION public.claim_sms_outbox(p_limit integer DEFAULT 10)
RETURNS TABLE(
  id uuid,
  operation_id uuid,
  payload jsonb,
  idempotency_key text,
  attempts integer,
  lock_token uuid
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'invalid_sms_outbox_limit' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT outbox.id
    FROM public.outbox AS outbox
    WHERE outbox.job_type = 'send_sms'
      AND (
        (outbox.status = 'pending' AND outbox.available_at <= clock_timestamp())
        OR (outbox.status = 'processing' AND outbox.locked_until <= clock_timestamp())
      )
    ORDER BY outbox.available_at, outbox.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE public.outbox AS outbox
    SET status = 'processing',
        attempts = outbox.attempts + 1,
        locked_until = clock_timestamp() + interval '2 minutes',
        lock_token = gen_random_uuid(),
        last_error_code = NULL
    FROM candidates
    WHERE outbox.id = candidates.id
    RETURNING outbox.id, outbox.operation_id, outbox.payload, outbox.idempotency_key,
      outbox.attempts, outbox.lock_token
  )
  SELECT claimed.id, claimed.operation_id, claimed.payload, claimed.idempotency_key,
    claimed.attempts, claimed.lock_token
  FROM claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_sms_outbox(
  p_outbox_id uuid,
  p_lock_token uuid,
  p_provider_message_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  completed_outbox public.outbox%ROWTYPE;
BEGIN
  UPDATE public.outbox
  SET status = 'processed',
      processed_at = clock_timestamp(),
      locked_until = NULL,
      lock_token = NULL,
      provider_message_id = p_provider_message_id
  WHERE id = p_outbox_id
    AND job_type = 'send_sms'
    AND status = 'processing'
    AND lock_token = p_lock_token
  RETURNING * INTO completed_outbox;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'sms_outbox_not_claimed' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.events (operation_id, type, payload)
  VALUES (
    completed_outbox.operation_id,
    'sms.sent',
    jsonb_build_object(
      'outbox_id', completed_outbox.id,
      'template', completed_outbox.payload->>'template',
      'recipient_type', completed_outbox.payload->>'recipient_type',
      'provider_message_id', p_provider_message_id
    )
  );

  PERFORM 1 FROM public.operations WHERE id = completed_outbox.operation_id FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM public.outbox
    WHERE operation_id = completed_outbox.operation_id
      AND job_type = 'send_sms'
      AND payload->>'booking_id' = completed_outbox.payload->>'booking_id'
      AND payload->>'template' IN ('booking_confirmation_client', 'booking_confirmation_provider')
      AND status <> 'processed'
  ) THEN
    UPDATE public.operations
    SET status = 'notifications_sent'
    WHERE id = completed_outbox.operation_id
      AND status = 'booking_confirmed';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_sms_outbox(
  p_outbox_id uuid,
  p_lock_token uuid,
  p_error_code text,
  p_retryable boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  failed_outbox public.outbox%ROWTYPE;
  should_retry boolean;
BEGIN
  SELECT * INTO failed_outbox
  FROM public.outbox
  WHERE id = p_outbox_id
    AND job_type = 'send_sms'
    AND status = 'processing'
    AND lock_token = p_lock_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'sms_outbox_not_claimed' USING ERRCODE = 'P0001';
  END IF;

  should_retry := p_retryable AND failed_outbox.attempts < 5;
  UPDATE public.outbox
  SET status = CASE WHEN should_retry THEN 'pending'::public.outbox_status ELSE 'failed'::public.outbox_status END,
      available_at = CASE
        WHEN should_retry THEN clock_timestamp() + make_interval(secs => least(3600, 30 * (2 ^ (failed_outbox.attempts - 1))::integer))
        ELSE available_at
      END,
      locked_until = NULL,
      lock_token = NULL,
      last_error_code = p_error_code
  WHERE id = failed_outbox.id;

  INSERT INTO public.events (operation_id, type, payload)
  VALUES (
    failed_outbox.operation_id,
    'sms.failed',
    jsonb_build_object(
      'outbox_id', failed_outbox.id,
      'template', failed_outbox.payload->>'template',
      'recipient_type', failed_outbox.payload->>'recipient_type',
      'error_code', p_error_code,
      'retryable', should_retry,
      'attempt', failed_outbox.attempts
    )
  );
END;
$$;

-- Current email retries cannot leave notifications stuck after the channel
-- change. Requeue only active jobs; historical terminal failures stay intact.
DO $$
DECLARE
  queued_booking_id uuid;
BEGIN
  FOR queued_booking_id IN
    SELECT DISTINCT (payload->>'booking_id')::uuid
    FROM public.outbox
    WHERE job_type = 'send_email'
      AND status IN ('pending', 'processing')
      AND payload->>'template' IN ('booking_confirmation_client', 'booking_confirmation_provider')
      AND payload->>'booking_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  LOOP
    PERFORM public.queue_booking_confirmation_sms(queued_booking_id);
  END LOOP;
END;
$$;

UPDATE public.outbox
SET status = 'failed',
    locked_until = NULL,
    lock_token = NULL,
    last_error_code = 'superseded_by_sms'
WHERE job_type = 'send_email'
  AND status IN ('pending', 'processing')
  AND payload->>'template' IN ('booking_confirmation_client', 'booking_confirmation_provider');

REVOKE EXECUTE ON FUNCTION public.enqueue_booking_confirmation_sms(uuid, uuid, text, text, text, text, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.queue_booking_confirmation_sms(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_sms_outbox(integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_sms_outbox(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_sms_outbox(uuid, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_booking_confirmation_sms(uuid, uuid, text, text, text, text, text, jsonb, text),
  public.queue_booking_confirmation_sms(uuid),
  public.claim_sms_outbox(integer),
  public.complete_sms_outbox(uuid, uuid, text),
  public.fail_sms_outbox(uuid, uuid, text, boolean)
  TO service_role;

COMMIT;
