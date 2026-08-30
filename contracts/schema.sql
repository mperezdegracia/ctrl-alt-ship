-- Reference for the resulting domain tables and invariants, not a deployment
-- entry point. Runtime RPCs, workers and grants live in supabase/migrations/.
-- Never execute this alongside migrations or against an existing database.
BEGIN;

-- Runtime RPC signatures are documented here as a snapshot only; definitions and
-- grants live in forward migrations. The provider flow uses:
-- get_provider_tool_state(uuid,text,uuid), get_provider_inbound_tool_state(uuid,text,uuid),
-- select_provider_booking(uuid,text,uuid,text,text,jsonb), record_provider_offer(uuid,text,uuid,text,jsonb),
-- execute_provider_quote_tool(uuid,text,uuid,text,text,jsonb,jsonb),
-- execute_provider_booking_tool(uuid,text,uuid,text,text,jsonb,jsonb),
-- claim_next_provider_contact_v2() -> jsonb, begin_provider_contact(uuid,uuid,uuid) -> jsonb,
-- finish_provider_contact_v2(uuid,uuid,uuid,text,text,text) -> jsonb,
-- record_provider_call_status(uuid,text,text,integer,timestamptz) -> jsonb,
-- advance_sourcing_round(uuid) -> jsonb, enqueue_replacement_sourcing(uuid,uuid) -> uuid.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE operation_status AS ENUM (
  'draft', 'collecting_details', 'sourcing', 'quotes_received',
  'quote_selected', 'booking_pending', 'booking_confirmed',
  'notifications_sent', 'needs_follow_up', 'cancelled', 'failed'
);
CREATE TYPE call_persona AS ENUM ('client', 'provider');
CREATE TYPE call_direction AS ENUM ('inbound', 'outbound');
CREATE TYPE call_outcome AS ENUM ('active', 'completed', 'failed', 'transferred');
CREATE TYPE client_operation_intent AS ENUM ('undecided', 'create', 'update', 'cancel');
CREATE TYPE provider_operation_intent AS ENUM (
  'undecided', 'quote', 'booking_confirmation', 'reschedule', 'cancel_booking', 'escalation'
);
CREATE TYPE quote_request_status AS ENUM ('pending', 'queued', 'contacted', 'responded', 'expired', 'cancelled');
CREATE TYPE quote_verdict AS ENUM ('dentro', 'fuera', 'contraoferta');
CREATE TYPE quote_status AS ENUM ('received', 'withdrawn');
CREATE TYPE booking_status AS ENUM ('pending', 'confirmed', 'cancelled');
CREATE TYPE change_request_type AS ENUM ('reschedule', 'cancel');
CREATE TYPE change_request_verdict AS ENUM ('dentro', 'fuera');
CREATE TYPE change_request_status AS ENUM ('pending', 'applied', 'rejected', 'escalated');
CREATE TYPE escalation_status AS ENUM ('started', 'supervisor_joined', 'resolved', 'failed');
CREATE TYPE outbox_status AS ENUM ('pending', 'processing', 'processed', 'failed');
CREATE TYPE sourcing_round_kind AS ENUM ('initial','renegotiation','replacement');
CREATE TYPE sourcing_round_status AS ENUM ('active','selected','exhausted','superseded');
CREATE TYPE domain_event_type AS ENUM (
  'call.rejected', 'call.routed', 'call.completed', 'call.failed', 'call.transferred',
  'operation.created', 'operation.updated', 'operation.corrected', 'operation.cancelled',
  'mandate.confirmed', 'sourcing.started', 'sourcing.dispatch_queued',
  'quote.requested', 'quote.received', 'quote.counteroffer_requested',
  'quote.offered',
  'quote.declined', 'quote.expired', 'quote.selected',
  'booking.pending', 'booking.confirmed', 'booking.declined',
  'booking.rescheduled', 'booking.reschedule_declined', 'booking.cancelled',
  'escalation.started', 'escalation.supervisor_joined',
  'escalation.resolved', 'escalation.failed', 'escalation.handoff_requested', 'escalation.handoff_failed',
  'email.queued', 'email.sent', 'email.failed'
);

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
  IF value IS NULL OR jsonb_typeof(value) <> 'object'
     OR NOT value ?& ARRAY[
       'container_type', 'gross_weight_kg', 'pickup_location',
       'delivery_location', 'empty_return_depot',
       'operational_constraints', 'cargo_notes'
     ]
     OR NOT (
       value->'container_type' = 'null'::jsonb
       OR (jsonb_typeof(value->'container_type') = 'string'
         AND btrim(value->>'container_type') <> '')
     )
     OR NOT (
       value->'gross_weight_kg' = 'null'::jsonb
       OR (jsonb_typeof(value->'gross_weight_kg') = 'number'
         AND (value->>'gross_weight_kg')::numeric > 0)
     )
     OR jsonb_typeof(value->'pickup_location') <> 'string'
     OR btrim(value->>'pickup_location') = ''
     OR jsonb_typeof(value->'delivery_location') <> 'string'
     OR btrim(value->>'delivery_location') = ''
     OR NOT (
       value->'empty_return_depot' = 'null'::jsonb
       OR (jsonb_typeof(value->'empty_return_depot') = 'string'
         AND btrim(value->>'empty_return_depot') <> '')
     )
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

-- Human escalation recipients are outbound routing records. They are kept
-- independent from contacts and providers, which identify inbound callers.
CREATE TABLE handoff_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (btrim(name) <> ''),
  phone text NOT NULL UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  role text NOT NULL CHECK (role IN ('supervisor', 'operator')),
  active boolean NOT NULL DEFAULT true,
  priority smallint NOT NULL DEFAULT 100 CHECK (priority >= 1 AND priority <= 32767),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX handoff_recipients_active_priority_idx ON handoff_recipients(priority, updated_at, id) WHERE active;
CREATE TRIGGER handoff_recipients_touch_updated_at
BEFORE UPDATE ON handoff_recipients FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

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

CREATE SEQUENCE operation_reference_seq;

CREATE TABLE operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE
    DEFAULT ('OP-' || lpad(nextval('operation_reference_seq')::text, 6, '0'))
    CHECK (reference ~ '^OP-[0-9]{6,}$'),
  contact_id uuid NOT NULL REFERENCES contacts(id),
  current_mandate_id uuid,
  mandate_confirmation_required boolean NOT NULL DEFAULT false,
  status operation_status NOT NULL DEFAULT 'draft',
  container_type text,
  gross_weight_kg numeric(12,3) CHECK (gross_weight_kg > 0),
  pickup_location text,
  delivery_location text,
  empty_return_depot text,
  operational_constraints text[] NOT NULL DEFAULT '{}'::text[]
    CHECK (is_nonblank_text_array(operational_constraints)),
  cargo_notes text CHECK (cargo_notes IS NULL OR btrim(cargo_notes) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid REFERENCES operations(id),
  contact_id uuid REFERENCES contacts(id),
  provider_id uuid REFERENCES providers(id),
  purpose text CHECK (purpose IS NULL OR purpose IN ('operation_management','booking_management','quote_request','renegotiation','booking_replacement')),
  selected_booking_id uuid,
  quote_request_id uuid,
  outbound_attempt integer CHECK (outbound_attempt IS NULL OR outbound_attempt BETWEEN 1 AND 3),
  dispatch_state text CHECK (dispatch_state IS NULL OR dispatch_state IN ('prepared','dispatching','accepted','unknown','failed')),
  raw_twilio_status text,
  last_callback_sequence integer,
  last_callback_at timestamptz,
  answered_at timestamptz,
  dispatch_started_at timestamptz,
  operation_intent client_operation_intent,
  provider_intent provider_operation_intent,
  -- Outbound calls are persisted before Twilio/OpenAI attach their identifiers.
  twilio_call_sid text UNIQUE,
  realtime_call_id text UNIQUE,
  persona call_persona NOT NULL,
  direction call_direction NOT NULL,
  outcome call_outcome NOT NULL DEFAULT 'active',
  client_tools_completed_at timestamptz,
  provider_tools_completed_at timestamptz,
  recording_url text,
  recording_sid text UNIQUE,
  recording_status text NOT NULL DEFAULT 'pending'
    CHECK (recording_status IN ('pending', 'completed', 'absent', 'deleted', 'failed')),
  recording_completed_at timestamptz,
  evidence_expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((contact_id IS NOT NULL)::integer + (provider_id IS NOT NULL)::integer = 1),
  CHECK (
    (persona = 'client' AND contact_id IS NOT NULL
      AND operation_intent IS NOT NULL AND provider_intent IS NULL)
    OR (persona = 'provider' AND provider_id IS NOT NULL
      AND operation_intent IS NULL AND provider_intent IS NOT NULL)
  ),
  CHECK (
    operation_id IS NOT NULL
    OR (persona = 'client' AND direction = 'inbound' AND operation_intent = 'undecided')
    OR (persona = 'provider' AND direction = 'inbound' AND provider_intent = 'undecided')
  ),
  CHECK (
    persona <> 'client'
    OR (operation_intent = 'undecided') = (operation_id IS NULL)
  ),
  CHECK (
    persona <> 'provider'
    OR (provider_intent = 'undecided') = (operation_id IS NULL)
  ),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX calls_evidence_expiry_idx ON calls(evidence_expires_at)
  WHERE evidence_expires_at IS NOT NULL;

CREATE TABLE call_transcript_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL REFERENCES calls(id),
  speaker text NOT NULL CHECK (speaker IN ('caller', 'tango')),
  content text NOT NULL CHECK (btrim(content) <> '' AND char_length(content) <= 10000),
  realtime_item_id text,
  realtime_response_id text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (realtime_item_id IS NOT NULL OR realtime_response_id IS NOT NULL),
  UNIQUE (call_id, realtime_item_id),
  UNIQUE (call_id, realtime_response_id)
);
CREATE INDEX call_transcript_segments_call_recorded_idx ON call_transcript_segments(call_id, recorded_at, id);
CREATE TRIGGER call_transcript_segments_append_only
BEFORE UPDATE OR DELETE ON call_transcript_segments FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE FUNCTION validate_call_context()
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
CREATE TRIGGER calls_validate_context
BEFORE INSERT OR UPDATE ON calls FOR EACH ROW EXECUTE FUNCTION validate_call_context();

CREATE TABLE tool_command_receipts (
  call_id uuid NOT NULL REFERENCES calls(id),
  tool_call_id text NOT NULL CHECK (btrim(tool_call_id) <> ''),
  tool_name text NOT NULL CHECK (tool_name IN (
    'create_operation', 'update_operation', 'confirm_mandate', 'cancel_operation',
    'create_quote', 'decline_quote_request', 'reschedule_booking', 'cancel_booking',
    'record_provider_quote', -- Historical receipts; this legacy RPC is revoked.
    'select_booking_for_reschedule', 'select_booking_for_cancellation', 'record_provider_offer',
    'escalate'
  )),
  arguments jsonb NOT NULL CHECK (jsonb_typeof(arguments) = 'object'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (call_id, tool_call_id)
);
CREATE TRIGGER tool_command_receipts_append_only
BEFORE UPDATE OR DELETE ON tool_command_receipts FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TABLE mandates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES operations(id),
  version integer NOT NULL CHECK (version > 0),
  supersedes_mandate_id uuid UNIQUE REFERENCES mandates(id),
  operation_snapshot jsonb NOT NULL CHECK (is_operation_snapshot(operation_snapshot)),
  price_cap numeric(14,2) NOT NULL CHECK (price_cap > 0),
  currency char(3) NOT NULL CHECK (currency = upper(currency)),
  action_windows jsonb NOT NULL CHECK (are_windows(action_windows)),
  -- A zero floor means no minimum imposed by the client, not agreed immediate payment.
  minimum_payment_term_days integer NOT NULL CHECK (minimum_payment_term_days >= 0),
  payment_term_anchor text NOT NULL DEFAULT 'invoice_date' CHECK (payment_term_anchor = 'invoice_date'),
  confirmed_in_call_id uuid NOT NULL REFERENCES calls(id),
  confirmed_at timestamptz NOT NULL,
  -- Legacy audio evidence retained for history; new conversational mandates leave it NULL.
  confirmation_evidence jsonb CHECK (confirmation_evidence IS NULL OR jsonb_typeof(confirmation_evidence) = 'object'),
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
     AND (NEW.current_mandate_id IS NULL OR nullif(btrim(NEW.pickup_location), '') IS NULL
       OR nullif(btrim(NEW.delivery_location), '') IS NULL) THEN
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
  mandate_id uuid REFERENCES mandates(id),
  negotiation_limit smallint NOT NULL DEFAULT 3 CHECK (negotiation_limit BETWEEN 1 AND 10),
  provider_decline_reason text CHECK (provider_decline_reason IN (
    'no_capacity', 'unavailable_window', 'price_terms', 'route_unsupported', 'operational_constraints', 'other')),
  provider_declined_at timestamptz,
  contact_attempt integer NOT NULL DEFAULT 1 CHECK (contact_attempt > 0),
  status quote_request_status NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  dispatched_at timestamptz,
  idempotency_key text NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  round_id uuid,
  CHECK (expires_at > created_at),
  CHECK ((provider_decline_reason IS NULL AND provider_declined_at IS NULL)
    OR (provider_decline_reason IS NOT NULL AND provider_declined_at IS NOT NULL AND status = 'cancelled'))
);
CREATE FUNCTION bind_quote_request_mandate() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
      OR NEW.mandate_id IS DISTINCT FROM OLD.mandate_id THEN
      RAISE EXCEPTION 'quote request scope is immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.mandate_id IS NULL THEN
      SELECT current_mandate_id INTO NEW.mandate_id FROM public.operations WHERE id = NEW.operation_id;
    END IF;
    IF NEW.mandate_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.mandates
      WHERE id = NEW.mandate_id AND operation_id = NEW.operation_id) THEN
      RAISE EXCEPTION 'quote request requires a mandate for this operation' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quote_requests_bind_mandate BEFORE INSERT OR UPDATE ON quote_requests
FOR EACH ROW EXECUTE FUNCTION bind_quote_request_mandate();
CREATE TRIGGER quote_requests_touch_updated_at
BEFORE UPDATE ON quote_requests FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE INDEX quote_requests_operation_status_idx ON quote_requests(operation_id, status);

CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_request_id uuid NOT NULL REFERENCES quote_requests(id),
  evaluated_mandate_id uuid NOT NULL REFERENCES mandates(id),
  version integer NOT NULL CHECK (version > 0),
  supersedes_quote_id uuid UNIQUE REFERENCES quotes(id),
  price_min numeric(14,2) NOT NULL CHECK (price_min > 0),
  price_max numeric(14,2) NOT NULL CHECK (price_max >= price_min),
  currency char(3) NOT NULL CHECK (currency = upper(currency)),
  proposed_pickup_window jsonb NOT NULL CHECK (is_window(proposed_pickup_window)),
  payment_term_days integer CHECK (payment_term_days >= 0),
  valid_until timestamptz,
  conditions jsonb CHECK (jsonb_typeof(conditions) = 'object'),
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

CREATE FUNCTION validate_price_only_quote_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE previous quotes%ROWTYPE;
BEGIN
  IF NEW.supersedes_quote_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO previous FROM quotes WHERE id = NEW.supersedes_quote_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001'; END IF;
  IF NEW.currency IS DISTINCT FROM previous.currency
    OR (NEW.proposed_pickup_window->>'start_at')::timestamptz IS DISTINCT FROM (previous.proposed_pickup_window->>'start_at')::timestamptz
    OR (NEW.proposed_pickup_window->>'end_at')::timestamptz IS DISTINCT FROM (previous.proposed_pickup_window->>'end_at')::timestamptz
    OR NEW.payment_term_days IS DISTINCT FROM previous.payment_term_days
    OR NEW.valid_until IS DISTINCT FROM previous.valid_until
    OR NEW.conditions IS DISTINCT FROM previous.conditions THEN
    RAISE EXCEPTION 'fixed_terms_conflict' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.price_min = previous.price_min AND NEW.price_max = previous.price_max THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quotes_price_only_revision
BEFORE INSERT ON quotes FOR EACH ROW
EXECUTE FUNCTION validate_price_only_quote_revision();

CREATE TABLE sourcing_judge_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES operations(id),
  mandate_id uuid NOT NULL REFERENCES mandates(id),
  quote_id uuid NOT NULL REFERENCES quotes(id),
  input_hash text NOT NULL,
  input_context jsonb NOT NULL CHECK (jsonb_typeof(input_context) = 'object'),
  assessment text NOT NULL CHECK (assessment IN ('clear', 'review_required')),
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 2000),
  issues jsonb NOT NULL CHECK (jsonb_typeof(issues) = 'array'),
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (operation_id, input_hash),
  CHECK (assessment <> 'clear' OR issues = '[]'::jsonb)
);
ALTER TABLE sourcing_judge_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sourcing_judge_reviews FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON sourcing_judge_reviews TO service_role;
CREATE TRIGGER sourcing_judge_reviews_append_only
BEFORE UPDATE OR DELETE ON sourcing_judge_reviews
FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES operations(id),
  quote_id uuid NOT NULL REFERENCES quotes(id),
  status booking_status NOT NULL DEFAULT 'pending',
  pickup_window_start timestamptz NOT NULL,
  pickup_window_end timestamptz NOT NULL,
  payment_term_days integer CHECK (payment_term_days >= 0),
  payment_term_anchor text NOT NULL DEFAULT 'invoice_date' CHECK (payment_term_anchor = 'invoice_date'),
  confirmed_price numeric(14,2) CHECK (confirmed_price > 0),
  confirmation_reference text,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  last_change_request_id uuid,
  source_call_id uuid REFERENCES calls(id),
  evidence_start_segment_id uuid REFERENCES call_transcript_segments(id),
  evidence_end_segment_id uuid REFERENCES call_transcript_segments(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (pickup_window_start < pickup_window_end),
  CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL) OR status = 'cancelled'),
  CHECK (confirmed_price IS NULL OR status IN ('confirmed', 'cancelled')),
  CHECK (status <> 'confirmed' OR confirmed_price IS NOT NULL),
  CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL)
);
ALTER TABLE calls ADD CONSTRAINT calls_selected_booking_id_fkey
  FOREIGN KEY (selected_booking_id) REFERENCES bookings(id);
ALTER TABLE calls ADD CONSTRAINT calls_quote_request_id_fkey
  FOREIGN KEY (quote_request_id) REFERENCES quote_requests(id);
ALTER TABLE operations ADD COLUMN current_booking_id uuid REFERENCES bookings(id);
CREATE TABLE sourcing_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES operations(id),
  mandate_id uuid NOT NULL REFERENCES mandates(id),
  kind sourcing_round_kind NOT NULL,
  source_booking_id uuid REFERENCES bookings(id),
  source_round_id uuid REFERENCES sourcing_rounds(id),
  status sourcing_round_status NOT NULL DEFAULT 'active',
  first_dispatched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  idempotency_key text NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  CHECK ((kind='replacement')=(source_booking_id IS NOT NULL)),
  CHECK ((status='active')=(closed_at IS NULL)),
  CHECK (closed_at IS NULL OR closed_at >= created_at)
);
CREATE UNIQUE INDEX sourcing_rounds_one_active_operation ON sourcing_rounds(operation_id) WHERE status='active';
CREATE UNIQUE INDEX sourcing_rounds_one_replacement_booking ON sourcing_rounds(source_booking_id) WHERE kind='replacement';
CREATE UNIQUE INDEX calls_quote_request_attempt_unique
  ON calls(quote_request_id, outbound_attempt)
  WHERE quote_request_id IS NOT NULL AND outbound_attempt IS NOT NULL;
CREATE UNIQUE INDEX quote_requests_round_provider_unique
  ON quote_requests(round_id, provider_id)
  WHERE round_id IS NOT NULL;
ALTER TABLE sourcing_rounds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sourcing_rounds FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON sourcing_rounds TO service_role;
ALTER TABLE quote_requests ADD CONSTRAINT quote_requests_round_id_fkey FOREIGN KEY (round_id) REFERENCES sourcing_rounds(id);

CREATE OR REPLACE FUNCTION public.validate_sourcing_round()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.mandates m WHERE m.id=NEW.mandate_id AND m.operation_id=NEW.operation_id)
    OR (NEW.source_booking_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.bookings b WHERE b.id=NEW.source_booking_id AND b.operation_id=NEW.operation_id))
    OR (NEW.source_round_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.sourcing_rounds r WHERE r.id=NEW.source_round_id AND r.operation_id=NEW.operation_id)) THEN
    RAISE EXCEPTION 'round scope mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.operation_id IS DISTINCT FROM OLD.operation_id
    OR NEW.mandate_id IS DISTINCT FROM OLD.mandate_id OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.source_booking_id IS DISTINCT FROM OLD.source_booking_id
    OR NEW.source_round_id IS DISTINCT FROM OLD.source_round_id
    OR (OLD.status<>'active' AND NEW.status IS DISTINCT FROM OLD.status)) THEN
    RAISE EXCEPTION 'round scope and terminal status are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER sourcing_rounds_validate BEFORE INSERT OR UPDATE ON public.sourcing_rounds
FOR EACH ROW EXECUTE FUNCTION public.validate_sourcing_round();

CREATE OR REPLACE FUNCTION public.validate_quote_request_round()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.round_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.sourcing_rounds r
    WHERE r.id=NEW.round_id AND r.operation_id=NEW.operation_id AND r.mandate_id=NEW.mandate_id) THEN
    RAISE EXCEPTION 'request round scope mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.round_id IS NOT NULL AND NEW.round_id IS DISTINCT FROM OLD.round_id THEN
    RAISE EXCEPTION 'request round is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER quote_requests_round_validate BEFORE INSERT OR UPDATE ON public.quote_requests
FOR EACH ROW EXECUTE FUNCTION public.validate_quote_request_round();

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
DROP TRIGGER IF EXISTS bookings_validate ON bookings;
CREATE TRIGGER bookings_validate BEFORE INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION validate_booking();
CREATE TRIGGER bookings_append_only
BEFORE UPDATE OR DELETE ON bookings FOR EACH ROW EXECUTE FUNCTION reject_mutation();

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
CREATE TRIGGER bookings_validate_evidence BEFORE INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION validate_booking_evidence();

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
CREATE TRIGGER operations_current_booking_validate BEFORE INSERT OR UPDATE OF current_booking_id ON operations FOR EACH ROW EXECUTE FUNCTION validate_operation_current_booking();

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
  previous_pickup_window jsonb CHECK (previous_pickup_window IS NULL OR is_window(previous_pickup_window)),
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

ALTER TABLE bookings ADD CONSTRAINT bookings_last_change_request_id_fkey
FOREIGN KEY (last_change_request_id) REFERENCES change_requests(id);

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
  mandate_id uuid REFERENCES mandates(id),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  trigger text CHECK (trigger IS NULL OR trigger IN ('explicit_human_request', 'outside_mandate', 'negotiation_stalled')),
  status escalation_status NOT NULL DEFAULT 'started',
  conference_sid text UNIQUE,
  handoff_recipient_id uuid REFERENCES handoff_recipients(id),
  handoff_status text NOT NULL DEFAULT 'pending' CHECK (handoff_status IN ('pending', 'transfer_requested', 'transfer_failed', 'not_configured')),
  handoff_status_detail text,
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
     OR (NEW.mandate_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM mandates WHERE id = NEW.mandate_id AND operation_id = NEW.operation_id
     ))
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
CREATE INDEX escalations_active_started_idx ON escalations(started_at DESC) WHERE status IN ('started', 'supervisor_joined');
CREATE UNIQUE INDEX escalations_one_active_source_call_idx ON escalations(source_call_id) WHERE status IN ('started', 'supervisor_joined');

CREATE TABLE escalation_contexts (
  escalation_id uuid PRIMARY KEY REFERENCES escalations(id),
  agent_summary text NOT NULL CHECK (btrim(agent_summary) <> '' AND char_length(agent_summary) <= 2000),
  requested_action text NOT NULL CHECK (btrim(requested_action) <> '' AND char_length(requested_action) <= 500),
  verified_snapshot jsonb NOT NULL CHECK (jsonb_typeof(verified_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER escalation_contexts_append_only
BEFORE UPDATE OR DELETE ON escalation_contexts FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid REFERENCES operations(id),
  call_id uuid REFERENCES calls(id),
  type domain_event_type NOT NULL,
  schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  recording_checkpoint numeric(12,3) CHECK (recording_checkpoint >= 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    operation_id IS NOT NULL
    OR type = 'call.rejected'
    OR (type = 'call.routed' AND call_id IS NOT NULL)
  ),
  CHECK (recording_checkpoint IS NULL OR call_id IS NOT NULL)
);

CREATE FUNCTION validate_event_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.call_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM calls
       WHERE id = NEW.call_id AND operation_id IS NOT DISTINCT FROM NEW.operation_id
     ))
     THEN
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
  locked_until timestamptz,
  lock_token uuid,
  last_error_code text,
  provider_message_id text,
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
CREATE INDEX outbox_email_claim_idx ON outbox(available_at, created_at)
WHERE job_type = 'send_email' AND status IN ('pending', 'processing');

CREATE TABLE email_previews (
  outbox_id uuid PRIMARY KEY REFERENCES outbox(id),
  subject text NOT NULL CHECK (btrim(subject) <> ''),
  text_body text NOT NULL CHECK (btrim(text_body) <> ''),
  html_body text NOT NULL CHECK (btrim(html_body) <> ''),
  rendered_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER email_previews_append_only
BEFORE UPDATE OR DELETE ON email_previews FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TABLE operator_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN (
    'operation.corrected', 'escalation.resolved',
    'contact.created', 'contact.updated', 'contact.deactivated',
    'provider.created', 'provider.updated', 'provider.deactivated',
    'handoff_recipient.created', 'handoff_recipient.updated', 'handoff_recipient.deactivated'
  )),
  operation_id uuid REFERENCES operations(id),
  escalation_id uuid REFERENCES escalations(id),
  contact_id uuid REFERENCES contacts(id),
  provider_id uuid REFERENCES providers(id),
  handoff_recipient_id uuid REFERENCES handoff_recipients(id),
  before_state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(before_state) = 'object'),
  after_state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(after_state) = 'object'),
  note text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (btrim(coalesce(note, '')) <> '' OR action <> 'escalation.resolved'),
  CHECK ((operation_id IS NOT NULL)::integer + (escalation_id IS NOT NULL)::integer
    + (contact_id IS NOT NULL)::integer + (provider_id IS NOT NULL)::integer
    + (handoff_recipient_id IS NOT NULL)::integer >= 1)
);
CREATE INDEX operator_actions_operation_occurred_idx ON operator_actions(operation_id, occurred_at DESC);
CREATE INDEX operator_actions_escalation_occurred_idx ON operator_actions(escalation_id, occurred_at DESC);
CREATE INDEX operator_actions_handoff_recipient_occurred_idx ON operator_actions(handoff_recipient_id, occurred_at DESC);
CREATE TRIGGER operator_actions_append_only
BEFORE UPDATE OR DELETE ON operator_actions FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TABLE dashboard_saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('operations', 'escalations')),
  name text NOT NULL CHECK (btrim(name) <> ''),
  configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope, name)
);
CREATE TRIGGER dashboard_saved_views_touch_updated_at
BEFORE UPDATE ON dashboard_saved_views FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMIT;
