CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE operation_status AS ENUM (
  'draft', 'collecting_details', 'sourcing', 'quotes_received',
  'quote_selected', 'booking_pending', 'booking_confirmed',
  'notifications_sent', 'needs_follow_up', 'cancelled', 'failed'
);
CREATE TYPE call_persona AS ENUM ('client', 'provider');
CREATE TYPE call_direction AS ENUM ('inbound', 'outbound');
CREATE TYPE call_outcome AS ENUM ('active', 'completed', 'failed', 'transferred');
CREATE TYPE quote_request_status AS ENUM ('pending', 'queued', 'contacted', 'responded', 'expired', 'cancelled');
CREATE TYPE quote_verdict AS ENUM ('dentro', 'fuera', 'contraoferta');
CREATE TYPE quote_status AS ENUM ('received', 'withdrawn');
CREATE TYPE booking_status AS ENUM ('pending', 'confirmed', 'cancelled');
CREATE TYPE change_request_type AS ENUM ('reschedule', 'cancel');
CREATE TYPE change_request_verdict AS ENUM ('dentro', 'fuera');
CREATE TYPE change_request_status AS ENUM ('pending', 'applied', 'rejected', 'escalated');
CREATE TYPE escalation_status AS ENUM ('started', 'supervisor_joined', 'resolved', 'failed');
CREATE TYPE commitment_type AS ENUM ('quote', 'booking', 'reschedule', 'cancellation');
CREATE TYPE outbox_status AS ENUM ('pending', 'processing', 'processed', 'failed');

CREATE FUNCTION is_window(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RETURN jsonb_typeof(value) = 'object'
    AND value ? 'start_at'
    AND value ? 'end_at'
    AND (value->>'start_at')::timestamptz < (value->>'end_at')::timestamptz;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE FUNCTION are_windows(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  item jsonb;
BEGIN
  IF jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) = 0 THEN
    RETURN false;
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP
    IF NOT is_window(item) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE FUNCTION reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (btrim(name) <> ''),
  phone text NOT NULL UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  email text,
  authorized boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (btrim(name) <> ''),
  phone text NOT NULL UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  email text,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capabilities) = 'object'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION enforce_counterparty_phone_uniqueness()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  collision boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.phone, 0));
  IF TG_TABLE_NAME = 'contacts' THEN
    SELECT EXISTS (SELECT 1 FROM providers WHERE phone = NEW.phone) INTO collision;
  ELSE
    SELECT EXISTS (SELECT 1 FROM contacts WHERE phone = NEW.phone) INTO collision;
  END IF;
  IF collision THEN
    RAISE EXCEPTION 'phone % already belongs to another counterparty', NEW.phone
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER contacts_phone_unique_across_counterparties
BEFORE INSERT OR UPDATE OF phone ON contacts
FOR EACH ROW EXECUTE FUNCTION enforce_counterparty_phone_uniqueness();
CREATE TRIGGER providers_phone_unique_across_counterparties
BEFORE INSERT OR UPDATE OF phone ON providers
FOR EACH ROW EXECUTE FUNCTION enforce_counterparty_phone_uniqueness();
CREATE TRIGGER contacts_touch_updated_at
BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER providers_touch_updated_at
BEFORE UPDATE ON providers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts(id),
  current_mandate_id uuid,
  status operation_status NOT NULL DEFAULT 'draft',
  container_type text,
  gross_weight_kg numeric(12,3) CHECK (gross_weight_kg > 0),
  pickup_location text,
  delivery_location text,
  empty_return_depot text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES operations(id),
  contact_id uuid REFERENCES contacts(id),
  provider_id uuid REFERENCES providers(id),
  twilio_call_sid text NOT NULL UNIQUE,
  realtime_call_id text NOT NULL UNIQUE,
  persona call_persona NOT NULL,
  direction call_direction NOT NULL,
  outcome call_outcome NOT NULL DEFAULT 'active',
  recording_url text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((contact_id IS NOT NULL)::integer + (provider_id IS NOT NULL)::integer = 1),
  CHECK ((persona = 'client' AND contact_id IS NOT NULL) OR (persona = 'provider' AND provider_id IS NOT NULL)),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE FUNCTION validate_call_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  operation_contact uuid;
BEGIN
  IF NEW.contact_id IS NOT NULL THEN
    SELECT contact_id INTO operation_contact FROM operations WHERE id = NEW.operation_id;
    IF operation_contact IS DISTINCT FROM NEW.contact_id THEN
      RAISE EXCEPTION 'client call contact does not own operation' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER calls_validate_context
BEFORE INSERT OR UPDATE ON calls FOR EACH ROW EXECUTE FUNCTION validate_call_context();

CREATE TABLE mandates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES operations(id),
  version integer NOT NULL CHECK (version > 0),
  supersedes_mandate_id uuid UNIQUE REFERENCES mandates(id),
  price_cap numeric(14,2) NOT NULL CHECK (price_cap > 0),
  currency char(3) NOT NULL CHECK (currency = upper(currency)),
  action_windows jsonb NOT NULL CHECK (are_windows(action_windows)),
  minimum_payment_term_days integer NOT NULL CHECK (minimum_payment_term_days >= 0),
  payment_term_anchor text NOT NULL DEFAULT 'invoice_date' CHECK (payment_term_anchor = 'invoice_date'),
  confirmed_in_call_id uuid NOT NULL REFERENCES calls(id),
  confirmed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id, version),
  UNIQUE (id, operation_id),
  CHECK (supersedes_mandate_id IS NULL OR supersedes_mandate_id <> id)
);

ALTER TABLE operations
  ADD CONSTRAINT operations_current_mandate_same_operation
  FOREIGN KEY (current_mandate_id, id)
  REFERENCES mandates(id, operation_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION validate_mandate_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  call_operation uuid;
  previous_operation uuid;
  previous_version integer;
BEGIN
  SELECT operation_id INTO call_operation FROM calls WHERE id = NEW.confirmed_in_call_id;
  IF call_operation IS DISTINCT FROM NEW.operation_id THEN
    RAISE EXCEPTION 'mandate confirmation call belongs to another operation' USING ERRCODE = '23514';
  END IF;
  IF NEW.supersedes_mandate_id IS NULL THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'first mandate version must be 1' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT operation_id, version INTO previous_operation, previous_version
    FROM mandates WHERE id = NEW.supersedes_mandate_id;
    IF previous_operation IS DISTINCT FROM NEW.operation_id OR NEW.version <> previous_version + 1 THEN
      RAISE EXCEPTION 'invalid mandate predecessor' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mandates_validate_context
BEFORE INSERT ON mandates FOR EACH ROW EXECUTE FUNCTION validate_mandate_context();
CREATE TRIGGER mandates_append_only
BEFORE UPDATE OR DELETE ON mandates FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE FUNCTION validate_operation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allowed boolean := false;
BEGIN
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
CREATE TRIGGER operations_validate
BEFORE INSERT OR UPDATE ON operations FOR EACH ROW EXECUTE FUNCTION validate_operation();
CREATE TRIGGER operations_touch_updated_at
BEFORE UPDATE ON operations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE quote_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES operations(id),
  provider_id uuid NOT NULL REFERENCES providers(id),
  contact_attempt integer NOT NULL DEFAULT 1 CHECK (contact_attempt > 0),
  status quote_request_status NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  idempotency_key text NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE TRIGGER quote_requests_touch_updated_at
BEFORE UPDATE ON quote_requests FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE INDEX quote_requests_operation_status_idx ON quote_requests(operation_id, status);

CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_request_id uuid NOT NULL REFERENCES quote_requests(id),
  evaluated_mandate_id uuid NOT NULL REFERENCES mandates(id),
  version integer NOT NULL CHECK (version > 0),
  supersedes_quote_id uuid UNIQUE REFERENCES quotes(id),
  price numeric(14,2) NOT NULL CHECK (price > 0),
  currency char(3) NOT NULL CHECK (currency = upper(currency)),
  proposed_pickup_window jsonb NOT NULL CHECK (is_window(proposed_pickup_window)),
  payment_term_days integer NOT NULL CHECK (payment_term_days >= 0),
  valid_until timestamptz NOT NULL,
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(conditions) = 'object'),
  verdict quote_verdict NOT NULL,
  status quote_status NOT NULL DEFAULT 'received',
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quote_request_id, version),
  CHECK (valid_until > received_at),
  CHECK (supersedes_quote_id IS NULL OR supersedes_quote_id <> id)
);

CREATE FUNCTION validate_quote_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  request_operation uuid;
  mandate_operation uuid;
  previous_request uuid;
  previous_version integer;
BEGIN
  SELECT operation_id INTO request_operation FROM quote_requests WHERE id = NEW.quote_request_id;
  SELECT operation_id INTO mandate_operation FROM mandates WHERE id = NEW.evaluated_mandate_id;
  IF request_operation IS DISTINCT FROM mandate_operation THEN
    RAISE EXCEPTION 'quote request and mandate belong to different operations' USING ERRCODE = '23514';
  END IF;
  IF NEW.supersedes_quote_id IS NULL THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION 'first quote version must be 1' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT quote_request_id, version INTO previous_request, previous_version FROM quotes WHERE id = NEW.supersedes_quote_id;
    IF previous_request IS DISTINCT FROM NEW.quote_request_id OR NEW.version <> previous_version + 1 THEN
      RAISE EXCEPTION 'invalid quote predecessor' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quotes_validate_context
BEFORE INSERT ON quotes FOR EACH ROW EXECUTE FUNCTION validate_quote_context();
CREATE TRIGGER quotes_append_only
BEFORE UPDATE OR DELETE ON quotes FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE INDEX quotes_request_idx ON quotes(quote_request_id);

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES operations(id),
  quote_id uuid NOT NULL REFERENCES quotes(id),
  status booking_status NOT NULL DEFAULT 'pending',
  pickup_window_start timestamptz NOT NULL,
  pickup_window_end timestamptz NOT NULL,
  payment_term_days integer NOT NULL CHECK (payment_term_days >= 0),
  payment_term_anchor text NOT NULL DEFAULT 'invoice_date' CHECK (payment_term_anchor = 'invoice_date'),
  confirmation_reference text,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (pickup_window_start < pickup_window_end),
  CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL) OR status = 'cancelled'),
  CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL)
);
CREATE UNIQUE INDEX one_active_booking_per_operation
ON bookings(operation_id) WHERE status IN ('pending', 'confirmed');

CREATE FUNCTION validate_booking()
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
     OR NEW.payment_term_days IS DISTINCT FROM q.payment_term_days THEN
    RAISE EXCEPTION 'booking does not match an eligible current quote' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bookings_validate
BEFORE INSERT OR UPDATE OF operation_id, quote_id, pickup_window_start, pickup_window_end, payment_term_days
ON bookings FOR EACH ROW EXECUTE FUNCTION validate_booking();
CREATE TRIGGER bookings_touch_updated_at
BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES operations(id),
  booking_id uuid NOT NULL REFERENCES bookings(id),
  source_call_id uuid NOT NULL REFERENCES calls(id),
  requested_by_contact_id uuid REFERENCES contacts(id),
  requested_by_provider_id uuid REFERENCES providers(id),
  evaluated_mandate_id uuid NOT NULL REFERENCES mandates(id),
  type change_request_type NOT NULL,
  requested_pickup_window jsonb,
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  verdict change_request_verdict NOT NULL,
  status change_request_status NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((requested_by_contact_id IS NOT NULL)::integer + (requested_by_provider_id IS NOT NULL)::integer = 1),
  CHECK ((type = 'reschedule' AND requested_pickup_window IS NOT NULL AND is_window(requested_pickup_window))
      OR (type = 'cancel' AND requested_pickup_window IS NULL)),
  CHECK ((status IN ('applied', 'rejected') AND resolved_at IS NOT NULL) OR status IN ('pending', 'escalated'))
);

CREATE FUNCTION validate_change_request_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  booking_operation uuid;
  call_operation uuid;
  call_contact uuid;
  call_provider uuid;
  mandate_operation uuid;
  operation_contact uuid;
BEGIN
  SELECT operation_id INTO booking_operation FROM bookings WHERE id = NEW.booking_id;
  SELECT operation_id, contact_id, provider_id INTO call_operation, call_contact, call_provider FROM calls WHERE id = NEW.source_call_id;
  SELECT operation_id INTO mandate_operation FROM mandates WHERE id = NEW.evaluated_mandate_id;
  SELECT contact_id INTO operation_contact FROM operations WHERE id = NEW.operation_id;
  IF booking_operation IS DISTINCT FROM NEW.operation_id OR call_operation IS DISTINCT FROM NEW.operation_id
     OR mandate_operation IS DISTINCT FROM NEW.operation_id THEN
    RAISE EXCEPTION 'change request references another operation' USING ERRCODE = '23514';
  END IF;
  IF NEW.requested_by_contact_id IS NOT NULL AND
     (NEW.requested_by_contact_id IS DISTINCT FROM operation_contact OR NEW.requested_by_contact_id IS DISTINCT FROM call_contact) THEN
    RAISE EXCEPTION 'invalid client requester' USING ERRCODE = '23514';
  END IF;
  IF NEW.requested_by_provider_id IS NOT NULL AND NEW.requested_by_provider_id IS DISTINCT FROM call_provider THEN
    RAISE EXCEPTION 'invalid provider requester' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER change_requests_validate_context
BEFORE INSERT OR UPDATE ON change_requests FOR EACH ROW EXECUTE FUNCTION validate_change_request_context();
CREATE TRIGGER change_requests_touch_updated_at
BEFORE UPDATE ON change_requests FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE escalations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES operations(id),
  change_request_id uuid REFERENCES change_requests(id),
  source_call_id uuid NOT NULL REFERENCES calls(id),
  mandate_id uuid NOT NULL REFERENCES mandates(id),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  status escalation_status NOT NULL DEFAULT 'started',
  conference_sid text UNIQUE,
  started_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (resolved_at IS NULL OR resolved_at >= started_at)
);

CREATE FUNCTION validate_escalation_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM calls WHERE id = NEW.source_call_id AND operation_id = NEW.operation_id)
     OR NOT EXISTS (SELECT 1 FROM mandates WHERE id = NEW.mandate_id AND operation_id = NEW.operation_id)
     OR (NEW.change_request_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM change_requests WHERE id = NEW.change_request_id AND operation_id = NEW.operation_id
     )) THEN
    RAISE EXCEPTION 'escalation references another operation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER escalations_validate_context
BEFORE INSERT OR UPDATE ON escalations FOR EACH ROW EXECUTE FUNCTION validate_escalation_context();
CREATE TRIGGER escalations_touch_updated_at
BEFORE UPDATE ON escalations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES operations(id),
  quote_id uuid REFERENCES quotes(id),
  booking_id uuid REFERENCES bookings(id),
  mandate_id uuid NOT NULL REFERENCES mandates(id),
  call_id uuid NOT NULL REFERENCES calls(id),
  change_request_id uuid REFERENCES change_requests(id),
  supersedes_commitment_id uuid UNIQUE REFERENCES commitments(id),
  type commitment_type NOT NULL,
  terms jsonb NOT NULL CHECK (jsonb_typeof(terms) = 'object' AND terms <> '{}'::jsonb),
  transcript_excerpt text NOT NULL CHECK (btrim(transcript_excerpt) <> ''),
  recording_checkpoint numeric(12,3) NOT NULL CHECK (recording_checkpoint >= 0),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (supersedes_commitment_id IS NULL OR supersedes_commitment_id <> id)
);

CREATE FUNCTION validate_commitment_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  q_verdict quote_verdict;
  q_operation uuid;
  b_operation uuid;
  b_quote uuid;
  c_operation uuid;
  c_type change_request_type;
  previous_operation uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM mandates WHERE id = NEW.mandate_id AND operation_id = NEW.operation_id)
     OR NOT EXISTS (SELECT 1 FROM calls WHERE id = NEW.call_id AND operation_id = NEW.operation_id) THEN
    RAISE EXCEPTION 'commitment mandate or call belongs to another operation' USING ERRCODE = '23514';
  END IF;
  IF NEW.quote_id IS NOT NULL THEN
    SELECT q.verdict, qr.operation_id INTO q_verdict, q_operation
    FROM quotes q JOIN quote_requests qr ON qr.id = q.quote_request_id WHERE q.id = NEW.quote_id;
  END IF;
  IF NEW.booking_id IS NOT NULL THEN
    SELECT operation_id, quote_id INTO b_operation, b_quote FROM bookings WHERE id = NEW.booking_id;
  END IF;
  IF NEW.change_request_id IS NOT NULL THEN
    SELECT operation_id, type INTO c_operation, c_type FROM change_requests WHERE id = NEW.change_request_id;
  END IF;
  IF NEW.supersedes_commitment_id IS NOT NULL THEN
    SELECT operation_id INTO previous_operation FROM commitments WHERE id = NEW.supersedes_commitment_id;
  END IF;
  IF coalesce(q_operation, NEW.operation_id) IS DISTINCT FROM NEW.operation_id
     OR coalesce(b_operation, NEW.operation_id) IS DISTINCT FROM NEW.operation_id
     OR coalesce(c_operation, NEW.operation_id) IS DISTINCT FROM NEW.operation_id
     OR coalesce(previous_operation, NEW.operation_id) IS DISTINCT FROM NEW.operation_id THEN
    RAISE EXCEPTION 'commitment references another operation' USING ERRCODE = '23514';
  END IF;
  IF NEW.type = 'quote' AND NOT (NEW.quote_id IS NOT NULL AND q_verdict = 'dentro'
      AND NEW.booking_id IS NULL AND NEW.change_request_id IS NULL AND NEW.supersedes_commitment_id IS NULL) THEN
    RAISE EXCEPTION 'invalid quote commitment' USING ERRCODE = '23514';
  ELSIF NEW.type = 'booking' AND NOT (NEW.booking_id IS NOT NULL AND NEW.quote_id = b_quote AND NEW.change_request_id IS NULL) THEN
    RAISE EXCEPTION 'invalid booking commitment' USING ERRCODE = '23514';
  ELSIF NEW.type = 'reschedule' AND NOT (NEW.booking_id IS NOT NULL AND c_type = 'reschedule' AND NEW.supersedes_commitment_id IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid reschedule commitment' USING ERRCODE = '23514';
  ELSIF NEW.type = 'cancellation' AND NOT (NEW.booking_id IS NOT NULL AND c_type = 'cancel' AND NEW.supersedes_commitment_id IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid cancellation commitment' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER commitments_validate_context
BEFORE INSERT ON commitments FOR EACH ROW EXECUTE FUNCTION validate_commitment_context();
CREATE TRIGGER commitments_append_only
BEFORE UPDATE OR DELETE ON commitments FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE INDEX commitments_operation_occurred_idx ON commitments(operation_id, occurred_at);

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES operations(id),
  call_id uuid REFERENCES calls(id),
  commitment_id uuid REFERENCES commitments(id),
  type text NOT NULL CHECK (btrim(type) <> ''),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  recording_checkpoint numeric(12,3) CHECK (recording_checkpoint >= 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION validate_event_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.call_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM calls WHERE id = NEW.call_id AND operation_id = NEW.operation_id))
     OR (NEW.commitment_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM commitments WHERE id = NEW.commitment_id AND operation_id = NEW.operation_id
     )) THEN
    RAISE EXCEPTION 'event references another operation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER events_validate_context
BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION validate_event_context();
CREATE TRIGGER events_append_only
BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE INDEX events_operation_occurred_idx ON events(operation_id, occurred_at);

CREATE TABLE outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES operations(id),
  quote_request_id uuid REFERENCES quote_requests(id),
  job_type text NOT NULL CHECK (btrim(job_type) <> ''),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  status outbox_status NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  idempotency_key text NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  available_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (job_type <> 'contact_provider' OR quote_request_id IS NOT NULL),
  CHECK ((status = 'processed' AND processed_at IS NOT NULL) OR (status <> 'processed' AND processed_at IS NULL))
);

CREATE FUNCTION validate_outbox_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.quote_request_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM quote_requests WHERE id = NEW.quote_request_id AND operation_id = NEW.operation_id
  ) THEN
    RAISE EXCEPTION 'outbox quote request belongs to another operation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER outbox_validate_context
BEFORE INSERT OR UPDATE ON outbox FOR EACH ROW EXECUTE FUNCTION validate_outbox_context();
CREATE TRIGGER outbox_touch_updated_at
BEFORE UPDATE ON outbox FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE INDEX outbox_pending_idx ON outbox(status, available_at) WHERE status = 'pending';
