-- Escalations are durable operational cases. The brief is agent-authored, while
-- the attached snapshot and transcript are server-captured evidence.
BEGIN;

CREATE TABLE public.handoff_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (btrim(name) <> ''),
  phone text NOT NULL UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  role text NOT NULL CHECK (role IN ('supervisor', 'operator')),
  active boolean NOT NULL DEFAULT true,
  priority smallint NOT NULL DEFAULT 100 CHECK (priority >= 1 AND priority <= 32_767),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX handoff_recipients_active_priority_idx
  ON public.handoff_recipients(priority, updated_at, id) WHERE active;
CREATE TRIGGER handoff_recipients_touch_updated_at
BEFORE UPDATE ON public.handoff_recipients FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- The demo starts with Theo as the active recipient. This is routing data, not
-- an inbound counterparty identity; it intentionally does not alter contacts or providers.
INSERT INTO public.handoff_recipients (name, phone, role, active, priority)
VALUES ('Theo', '+5491132555829', 'supervisor', true, 1)
ON CONFLICT (phone) DO NOTHING;

CREATE TABLE public.call_transcript_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL REFERENCES public.calls(id),
  speaker text NOT NULL CHECK (speaker IN ('caller', 'tango')),
  content text NOT NULL CHECK (btrim(content) <> '' AND char_length(content) <= 10_000),
  realtime_item_id text,
  realtime_response_id text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (realtime_item_id IS NOT NULL OR realtime_response_id IS NOT NULL),
  UNIQUE (call_id, realtime_item_id),
  UNIQUE (call_id, realtime_response_id)
);
CREATE INDEX call_transcript_segments_call_recorded_idx
  ON public.call_transcript_segments(call_id, recorded_at, id);
CREATE TRIGGER call_transcript_segments_append_only
BEFORE UPDATE OR DELETE ON public.call_transcript_segments
FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

ALTER TABLE public.escalations
  ALTER COLUMN mandate_id DROP NOT NULL,
  ADD COLUMN trigger text CHECK (trigger IS NULL OR trigger IN (
    'explicit_human_request', 'outside_mandate', 'negotiation_stalled'
  )),
  ADD COLUMN handoff_recipient_id uuid REFERENCES public.handoff_recipients(id),
  ADD COLUMN handoff_status text NOT NULL DEFAULT 'pending' CHECK (handoff_status IN (
    'pending', 'transfer_requested', 'transfer_failed', 'not_configured'
  )),
  ADD COLUMN handoff_status_detail text;

CREATE INDEX escalations_active_started_idx
  ON public.escalations(started_at DESC) WHERE status IN ('started', 'supervisor_joined');
CREATE UNIQUE INDEX escalations_one_active_source_call_idx
  ON public.escalations(source_call_id) WHERE status IN ('started', 'supervisor_joined');

CREATE OR REPLACE FUNCTION public.validate_escalation_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.calls WHERE id = NEW.source_call_id AND operation_id = NEW.operation_id)
     OR (NEW.mandate_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.mandates WHERE id = NEW.mandate_id AND operation_id = NEW.operation_id
     ))
     OR (NEW.change_request_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.change_requests WHERE id = NEW.change_request_id AND operation_id = NEW.operation_id
     )) THEN
    RAISE EXCEPTION 'escalation references another operation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE public.escalation_contexts (
  escalation_id uuid PRIMARY KEY REFERENCES public.escalations(id),
  agent_summary text NOT NULL CHECK (btrim(agent_summary) <> '' AND char_length(agent_summary) <= 2_000),
  requested_action text NOT NULL CHECK (btrim(requested_action) <> '' AND char_length(requested_action) <= 500),
  verified_snapshot jsonb NOT NULL CHECK (jsonb_typeof(verified_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER escalation_contexts_append_only
BEFORE UPDATE OR DELETE ON public.escalation_contexts
FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

-- Recipient changes have the same append-only operator audit properties as
-- directory changes without treating an internal recipient as an inbound contact.
ALTER TABLE public.operator_actions ADD COLUMN handoff_recipient_id uuid REFERENCES public.handoff_recipients(id);
DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.operator_actions'::regclass
      AND contype = 'c'
  LOOP
    EXECUTE format('ALTER TABLE public.operator_actions DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END;
$$;
ALTER TABLE public.operator_actions
  ADD CONSTRAINT operator_actions_action_check CHECK (action IN (
    'operation.corrected', 'escalation.resolved',
    'contact.created', 'contact.updated', 'contact.deactivated',
    'provider.created', 'provider.updated', 'provider.deactivated',
    'handoff_recipient.created', 'handoff_recipient.updated', 'handoff_recipient.deactivated'
  )),
  ADD CONSTRAINT operator_actions_note_check CHECK (
    btrim(coalesce(note, '')) <> '' OR action <> 'escalation.resolved'
  ),
  ADD CONSTRAINT operator_actions_subject_check CHECK (
    (operation_id IS NOT NULL)::integer + (escalation_id IS NOT NULL)::integer
      + (contact_id IS NOT NULL)::integer + (provider_id IS NOT NULL)::integer
      + (handoff_recipient_id IS NOT NULL)::integer >= 1
  );
CREATE INDEX operator_actions_handoff_recipient_occurred_idx
  ON public.operator_actions(handoff_recipient_id, occurred_at DESC);

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
SET search_path = public
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
  SELECT * INTO receipt FROM public.tool_command_receipts
  WHERE call_id = p_call_id AND tool_call_id = p_tool_call_id;
  IF FOUND THEN
    IF receipt.tool_name = 'escalate' AND receipt.arguments = arguments_value THEN
      RETURN receipt.result;
    END IF;
    RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO c
  FROM public.calls
  WHERE id = p_call_id AND realtime_call_id = p_realtime_call_id
    AND ((persona = 'client' AND contact_id = p_counterparty_id)
      OR (persona = 'provider' AND provider_id = p_counterparty_id))
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'P0001'; END IF;

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
            WHERE b.operation_id = o.id AND r.provider_id = p_counterparty_id
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
  WHERE b.operation_id = op.id AND b.status IN ('pending', 'confirmed')
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

CREATE OR REPLACE FUNCTION public.record_call_transcript_segment(
  p_call_id uuid,
  p_realtime_call_id text,
  p_speaker text,
  p_content text,
  p_realtime_item_id text DEFAULT NULL,
  p_realtime_response_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_speaker NOT IN ('caller', 'tango')
     OR p_content IS NULL OR btrim(p_content) = '' OR char_length(p_content) > 10_000
     OR (nullif(btrim(coalesce(p_realtime_item_id, '')), '') IS NULL
       AND nullif(btrim(coalesce(p_realtime_response_id, '')), '') IS NULL) THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM public.calls WHERE id = p_call_id AND realtime_call_id = p_realtime_call_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO public.call_transcript_segments (
    call_id, speaker, content, realtime_item_id, realtime_response_id
  ) VALUES (
    p_call_id, p_speaker, btrim(p_content), nullif(btrim(coalesce(p_realtime_item_id, '')), ''),
    nullif(btrim(coalesce(p_realtime_response_id, '')), '')
  ) ON CONFLICT DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_escalation_handoff(
  p_escalation_id uuid,
  p_source_call_id uuid,
  p_handoff_status text,
  p_detail text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE escalation public.escalations%ROWTYPE;
BEGIN
  IF p_handoff_status NOT IN ('transfer_requested', 'transfer_failed')
     OR (p_detail IS NOT NULL AND char_length(p_detail) > 500) THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO escalation FROM public.escalations
  WHERE id = p_escalation_id AND source_call_id = p_source_call_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'P0001'; END IF;
  IF escalation.handoff_status = p_handoff_status
     AND escalation.handoff_status_detail IS NOT DISTINCT FROM p_detail THEN
    RETURN;
  END IF;
  UPDATE public.escalations SET handoff_status = p_handoff_status, handoff_status_detail = p_detail
  WHERE id = escalation.id;
  IF p_handoff_status = 'transfer_requested' THEN
    UPDATE public.calls SET outcome = 'transferred' WHERE id = escalation.source_call_id AND outcome = 'active';
  END IF;
  INSERT INTO public.events (operation_id, call_id, type, payload)
  VALUES (
    escalation.operation_id, escalation.source_call_id,
    CASE WHEN p_handoff_status = 'transfer_requested'
      THEN 'escalation.handoff_requested'::public.domain_event_type
      ELSE 'escalation.handoff_failed'::public.domain_event_type END,
    jsonb_build_object('escalation_id', escalation.id, 'handoff_status', p_handoff_status,
      'detail', p_detail)
  );
END;
$$;

ALTER TABLE public.handoff_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_transcript_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.escalation_contexts ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON public.handoff_recipients, public.call_transcript_segments, public.escalation_contexts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.handoff_recipients, public.call_transcript_segments, public.escalation_contexts TO service_role;
REVOKE ALL ON FUNCTION public.create_call_escalation(uuid, text, uuid, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_call_transcript_segment(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_escalation_handoff(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_call_escalation(uuid, text, uuid, text, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_call_transcript_segment(uuid, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_escalation_handoff(uuid, uuid, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
