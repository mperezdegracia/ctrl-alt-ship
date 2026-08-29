CREATE TYPE client_operation_intent AS ENUM ('undecided', 'create', 'update', 'cancel');
CREATE TYPE provider_operation_intent AS ENUM (
  'undecided', 'quote', 'booking_confirmation', 'reschedule', 'cancel_booking', 'escalation'
);

CREATE FUNCTION is_nonblank_text_array(value text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT value IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(value) AS item
      WHERE item IS NULL OR btrim(item) = ''
    );
$$;

CREATE FUNCTION is_operation_snapshot(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  constraint_item jsonb;
BEGIN
  IF jsonb_typeof(value) <> 'object'
     OR NOT value ?& ARRAY[
       'container_type', 'gross_weight_kg', 'pickup_location',
       'delivery_location', 'empty_return_depot',
       'operational_constraints', 'cargo_notes'
     ]
     OR jsonb_typeof(value->'container_type') <> 'string'
     OR btrim(value->>'container_type') = ''
     OR jsonb_typeof(value->'gross_weight_kg') <> 'number'
     OR (value->>'gross_weight_kg')::numeric <= 0
     OR jsonb_typeof(value->'pickup_location') <> 'string'
     OR btrim(value->>'pickup_location') = ''
     OR jsonb_typeof(value->'delivery_location') <> 'string'
     OR btrim(value->>'delivery_location') = ''
     OR jsonb_typeof(value->'empty_return_depot') <> 'string'
     OR btrim(value->>'empty_return_depot') = ''
     OR jsonb_typeof(value->'operational_constraints') <> 'array'
     OR NOT (
       value->'cargo_notes' = 'null'::jsonb
       OR (
         jsonb_typeof(value->'cargo_notes') = 'string'
         AND btrim(value->>'cargo_notes') <> ''
       )
     ) THEN
    RETURN false;
  END IF;

  FOR constraint_item IN
    SELECT * FROM jsonb_array_elements(value->'operational_constraints')
  LOOP
    IF jsonb_typeof(constraint_item) <> 'string'
       OR btrim(constraint_item #>> '{}') = '' THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE SEQUENCE operation_reference_seq;

ALTER TABLE operations
  ADD COLUMN reference text
    DEFAULT ('OP-' || lpad(nextval('operation_reference_seq')::text, 6, '0')),
  ADD COLUMN mandate_confirmation_required boolean NOT NULL DEFAULT false,
  ADD COLUMN operational_constraints text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN cargo_notes text;

ALTER SEQUENCE operation_reference_seq OWNED BY operations.reference;

ALTER TABLE operations
  ALTER COLUMN reference SET NOT NULL,
  ADD CONSTRAINT operations_reference_key UNIQUE (reference),
  ADD CONSTRAINT operations_reference_format_check CHECK (reference ~ '^OP-[0-9]{6,}$'),
  ADD CONSTRAINT operations_operational_constraints_check
    CHECK (is_nonblank_text_array(operational_constraints)),
  ADD CONSTRAINT operations_cargo_notes_check
    CHECK (cargo_notes IS NULL OR btrim(cargo_notes) <> '');

ALTER TABLE calls
  ALTER COLUMN operation_id DROP NOT NULL,
  ADD COLUMN operation_intent client_operation_intent,
  ADD COLUMN provider_intent provider_operation_intent;

UPDATE calls
SET operation_intent = 'update'
WHERE persona = 'client';

UPDATE calls
SET provider_intent = 'quote'
WHERE persona = 'provider';

ALTER TABLE calls
  ADD CONSTRAINT calls_persona_intent_check CHECK (
    (persona = 'client' AND contact_id IS NOT NULL
      AND operation_intent IS NOT NULL AND provider_intent IS NULL)
    OR (persona = 'provider' AND provider_id IS NOT NULL
      AND operation_intent IS NULL AND provider_intent IS NOT NULL)
  ),
  ADD CONSTRAINT calls_operation_context_check CHECK (
    operation_id IS NOT NULL
    OR (persona = 'client' AND direction = 'inbound' AND operation_intent = 'undecided')
    OR (persona = 'provider' AND direction = 'inbound' AND provider_intent = 'undecided')
  ),
  ADD CONSTRAINT calls_client_intent_link_check CHECK (
    persona <> 'client'
    OR (operation_intent = 'undecided') = (operation_id IS NULL)
  ),
  ADD CONSTRAINT calls_provider_intent_link_check CHECK (
    persona <> 'provider'
    OR (provider_intent = 'undecided') = (operation_id IS NULL)
  );

CREATE OR REPLACE FUNCTION validate_call_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  operation_contact uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.operation_id IS NOT NULL AND NEW.operation_id IS DISTINCT FROM OLD.operation_id THEN
      RAISE EXCEPTION 'a call cannot switch operations after being linked' USING ERRCODE = '23514';
    END IF;
    IF OLD.operation_intent IS DISTINCT FROM NEW.operation_intent
       AND OLD.operation_intent IS DISTINCT FROM 'undecided'::client_operation_intent THEN
      RAISE EXCEPTION 'client operation intent is already locked' USING ERRCODE = '23514';
    END IF;
    IF OLD.provider_intent IS DISTINCT FROM NEW.provider_intent
       AND OLD.provider_intent IS DISTINCT FROM 'undecided'::provider_operation_intent THEN
      RAISE EXCEPTION 'provider operation intent is already locked' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.contact_id IS NOT NULL THEN
    IF NEW.operation_id IS NOT NULL THEN
      SELECT contact_id INTO operation_contact FROM operations WHERE id = NEW.operation_id;
    END IF;
    IF NEW.operation_id IS NOT NULL AND operation_contact IS DISTINCT FROM NEW.contact_id THEN
      RAISE EXCEPTION 'client call contact does not own operation' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE mandates
  ADD COLUMN operation_snapshot jsonb;

UPDATE mandates AS mandate
SET operation_snapshot = jsonb_build_object(
  'container_type', operation.container_type,
  'gross_weight_kg', operation.gross_weight_kg,
  'pickup_location', operation.pickup_location,
  'delivery_location', operation.delivery_location,
  'empty_return_depot', operation.empty_return_depot,
  'operational_constraints', to_jsonb(operation.operational_constraints),
  'cargo_notes', operation.cargo_notes
)
FROM operations AS operation
WHERE operation.id = mandate.operation_id;

ALTER TABLE mandates
  ALTER COLUMN operation_snapshot SET NOT NULL,
  ADD CONSTRAINT mandates_operation_snapshot_check
    CHECK (is_operation_snapshot(operation_snapshot));

CREATE OR REPLACE FUNCTION validate_operation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allowed boolean := false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.current_mandate_id IS NOT NULL
     AND (
       NEW.container_type IS DISTINCT FROM OLD.container_type
       OR NEW.gross_weight_kg IS DISTINCT FROM OLD.gross_weight_kg
       OR NEW.pickup_location IS DISTINCT FROM OLD.pickup_location
       OR NEW.delivery_location IS DISTINCT FROM OLD.delivery_location
       OR NEW.empty_return_depot IS DISTINCT FROM OLD.empty_return_depot
       OR NEW.operational_constraints IS DISTINCT FROM OLD.operational_constraints
       OR NEW.cargo_notes IS DISTINCT FROM OLD.cargo_notes
     ) THEN
    NEW.mandate_confirmation_required := true;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'draft' THEN NEW.status IN ('collecting_details', 'cancelled')
      WHEN 'collecting_details' THEN NEW.status IN ('sourcing', 'cancelled', 'failed')
      WHEN 'sourcing' THEN NEW.status IN ('quotes_received', 'needs_follow_up', 'cancelled', 'failed')
      WHEN 'quotes_received' THEN NEW.status IN ('quote_selected', 'sourcing', 'needs_follow_up', 'cancelled', 'failed')
      WHEN 'quote_selected' THEN NEW.status IN ('booking_pending', 'sourcing', 'needs_follow_up', 'cancelled', 'failed')
      WHEN 'booking_pending' THEN NEW.status IN ('booking_confirmed', 'sourcing', 'needs_follow_up', 'cancelled', 'failed')
      WHEN 'booking_confirmed' THEN NEW.status IN ('notifications_sent', 'sourcing', 'needs_follow_up', 'cancelled', 'failed')
      WHEN 'notifications_sent' THEN NEW.status IN ('sourcing', 'cancelled', 'failed')
      WHEN 'needs_follow_up' THEN NEW.status IN ('sourcing', 'cancelled', 'failed')
      ELSE false
    END;
    IF NOT allowed THEN
      RAISE EXCEPTION 'invalid operation transition: % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.status IN ('sourcing', 'quotes_received', 'quote_selected', 'booking_pending', 'booking_confirmed', 'notifications_sent', 'needs_follow_up')
     AND (NEW.current_mandate_id IS NULL OR nullif(btrim(NEW.container_type), '') IS NULL
       OR NEW.gross_weight_kg IS NULL OR nullif(btrim(NEW.pickup_location), '') IS NULL
       OR nullif(btrim(NEW.delivery_location), '') IS NULL OR nullif(btrim(NEW.empty_return_depot), '') IS NULL) THEN
    RAISE EXCEPTION 'operation is incomplete for status %', NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE quotes RENAME COLUMN price TO price_min;
ALTER TABLE quotes ADD COLUMN price_max numeric(14,2);
UPDATE quotes SET price_max = price_min;
ALTER TABLE quotes
  ALTER COLUMN price_max SET NOT NULL,
  ADD CONSTRAINT quotes_price_max_check CHECK (price_max >= price_min);

ALTER TABLE bookings ADD COLUMN confirmed_price numeric(14,2);

UPDATE bookings AS booking
SET confirmed_price = quote.price_max
FROM quotes AS quote
WHERE quote.id = booking.quote_id
  AND booking.status = 'confirmed';

ALTER TABLE bookings
  ADD CONSTRAINT bookings_confirmed_price_positive_check
    CHECK (confirmed_price > 0),
  ADD CONSTRAINT bookings_confirmed_price_status_check
    CHECK (confirmed_price IS NULL OR status IN ('confirmed', 'cancelled')),
  ADD CONSTRAINT bookings_confirmed_price_required_check
    CHECK (status <> 'confirmed' OR confirmed_price IS NOT NULL);

CREATE OR REPLACE FUNCTION validate_booking()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  q quotes%ROWTYPE;
  request_operation uuid;
  current_mandate uuid;
BEGIN
  SELECT * INTO q FROM quotes WHERE id = NEW.quote_id;
  SELECT operation_id INTO request_operation FROM quote_requests WHERE id = q.quote_request_id;
  SELECT current_mandate_id INTO current_mandate FROM operations WHERE id = NEW.operation_id;
  IF request_operation IS DISTINCT FROM NEW.operation_id OR q.verdict <> 'dentro' OR q.status <> 'received'
     OR q.valid_until <= now() OR q.evaluated_mandate_id IS DISTINCT FROM current_mandate
     OR EXISTS (SELECT 1 FROM quotes successor WHERE successor.supersedes_quote_id = q.id)
     OR NEW.pickup_window_start IS DISTINCT FROM (q.proposed_pickup_window->>'start_at')::timestamptz
     OR NEW.pickup_window_end IS DISTINCT FROM (q.proposed_pickup_window->>'end_at')::timestamptz
     OR NEW.payment_term_days IS DISTINCT FROM q.payment_term_days
     OR (NEW.confirmed_price IS NOT NULL AND NEW.confirmed_price NOT BETWEEN q.price_min AND q.price_max) THEN
    RAISE EXCEPTION 'booking does not match an eligible current quote' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER bookings_validate ON bookings;
CREATE TRIGGER bookings_validate
BEFORE INSERT OR UPDATE OF operation_id, quote_id, pickup_window_start, pickup_window_end,
  payment_term_days, confirmed_price
ON bookings FOR EACH ROW EXECUTE FUNCTION validate_booking();
