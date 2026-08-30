-- Only price_min/price_max can change after a provider's initial proposal.
-- No changes to the minimal client mandate or existing quote history.
BEGIN;

CREATE FUNCTION public.validate_price_only_quote_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE previous public.quotes%ROWTYPE;
BEGIN
  IF NEW.supersedes_quote_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO previous FROM public.quotes WHERE id = NEW.supersedes_quote_id;
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
BEFORE INSERT ON public.quotes FOR EACH ROW
EXECUTE FUNCTION public.validate_price_only_quote_revision();

CREATE OR REPLACE FUNCTION public.get_provider_quote_tool_state(p_call_id uuid, p_realtime_call_id text, p_provider_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  c public.calls%ROWTYPE;
  op public.operations%ROWTYPE;
  qr public.quote_requests%ROWTYPE;
  q public.quotes%ROWTYPE;
  candidates jsonb := '[]'::jsonb;
  targets jsonb := '{}'::jsonb;
  selected jsonb := NULL;
  last_quote jsonb := NULL;
  profile text;
BEGIN
  SELECT * INTO c FROM public.calls WHERE id = p_call_id AND realtime_call_id = p_realtime_call_id
    AND provider_id = p_provider_id AND persona = 'provider' AND outcome = 'active';
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.providers WHERE id = p_provider_id AND active) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'P0001';
  END IF;
  IF c.operation_id IS NOT NULL THEN
    SELECT * INTO op FROM public.operations o WHERE o.id = c.operation_id
      AND EXISTS (SELECT 1 FROM public.quote_requests r WHERE r.operation_id = o.id AND r.provider_id = p_provider_id);
    IF NOT FOUND THEN RAISE EXCEPTION 'operation_not_available' USING ERRCODE = 'P0001'; END IF;
    selected := public.provider_quote_operation(op);
  END IF;
  IF c.provider_tools_completed_at IS NOT NULL THEN
    profile := 'terminal';
  ELSIF c.provider_intent NOT IN ('undecided', 'quote') THEN
    profile := 'provider_unavailable';
  ELSE
    FOR op IN SELECT o.* FROM public.operations o
      WHERE (c.operation_id IS NULL OR o.id = c.operation_id)
        AND o.status IN ('sourcing', 'quotes_received') AND NOT o.mandate_confirmation_required
        AND o.current_mandate_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM public.quote_requests r WHERE r.operation_id = o.id AND r.provider_id = p_provider_id)
      ORDER BY o.reference LIMIT 50
    LOOP
      -- Latest actionable request for this provider/operation. A replacement
      -- mandate requires a new request, not reuse of the old one.
      SELECT r.* INTO qr FROM public.quote_requests r
      LEFT JOIN LATERAL (SELECT v.* FROM public.quotes v WHERE v.quote_request_id = r.id ORDER BY version DESC LIMIT 1) latest ON true
      WHERE r.operation_id = op.id AND r.provider_id = p_provider_id
        AND r.mandate_id = op.current_mandate_id AND r.expires_at > clock_timestamp()
        AND r.status IN ('pending', 'queued', 'contacted', 'responded')
        AND ((latest.id IS NULL AND r.status <> 'responded') OR
          (latest.verdict = 'contraoferta' AND latest.status = 'received' AND latest.evaluated_mandate_id = op.current_mandate_id))
      ORDER BY r.created_at DESC, r.id DESC LIMIT 1;
      IF NOT FOUND THEN CONTINUE; END IF;
      SELECT * INTO q FROM public.quotes WHERE quote_request_id = qr.id ORDER BY version DESC LIMIT 1;
      candidates := candidates || jsonb_build_array(public.provider_quote_operation(op));
      targets := targets || jsonb_build_object(op.reference, jsonb_build_object(
        'operation_revision', op.updated_at::text, 'quote_request_id', qr.id,
        'mandate_id', op.current_mandate_id, 'previous_quote_id', q.id));
      IF c.operation_id = op.id THEN
        last_quote := CASE WHEN q.id IS NULL THEN NULL ELSE jsonb_build_object(
          'quote_version', q.version, 'verdict', q.verdict,
          'price_range', jsonb_build_object('min', q.price_min, 'max', q.price_max, 'currency', q.currency),
          'fixed_terms', jsonb_build_object('proposed_pickup_window', q.proposed_pickup_window,
            'payment_term_days', q.payment_term_days, 'valid_until', q.valid_until, 'conditions', q.conditions),
          'negotiation_rounds_remaining', greatest(0, qr.negotiation_limit + 1 -
            (SELECT count(*) FROM public.quotes v WHERE v.quote_request_id = qr.id AND v.verdict = 'contraoferta'))) END;
      END IF;
    END LOOP;
    profile := CASE WHEN jsonb_array_length(candidates) = 0 THEN 'provider_unavailable'
      WHEN c.operation_id IS NULL THEN 'provider_inbound_entry' ELSE 'provider_quote' END;
  END IF;
  RETURN jsonb_build_object('profile', profile, 'intent', c.provider_intent,
    'operation', selected, 'candidates', candidates, 'commandTargets', targets, 'lastQuote', last_quote);
END;
$$;

REVOKE ALL ON FUNCTION public.validate_price_only_quote_revision() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_price_only_quote_revision() TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
