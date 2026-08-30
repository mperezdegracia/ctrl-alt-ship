-- Agent can see the active mandate cap, but must never disclose it to the carrier.
-- Existing authorization and service-role-only RPC permissions are preserved.
BEGIN;

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
  private_price_limits jsonb := '{}'::jsonb;
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
      -- Internal agent context only. Do not add these limits to operation/read-tool DTOs.
      private_price_limits := private_price_limits || jsonb_build_object(op.reference,
        (SELECT jsonb_build_object('price_cap', m.price_cap, 'currency', m.currency)
          FROM public.mandates m WHERE m.id = op.current_mandate_id AND m.operation_id = op.id));
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
    'operation', selected, 'candidates', candidates, 'commandTargets', targets, 'lastQuote', last_quote,
    'privatePriceLimits', private_price_limits);
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
