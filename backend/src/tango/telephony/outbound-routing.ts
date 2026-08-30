import { supabaseAdmin } from "../../config/supabase";
import { isProviderOutboundPurpose } from "../../domain/call-flow";
import type { RoutingDecision } from "./inbound-routing";

export type OutboundRoutingDecision = Extract<RoutingDecision, { outbound: true }>;

export function extractOutboundCallRecordId(headers: Array<{ name: string; value: string }> = []): string | null {
  const matches = headers.filter((header) => header.name.toLowerCase() === "x-tango-call-id");
  if (!matches.length) return null;
  const value = matches[0].value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    || matches.some((header) => header.value.trim() !== value)) {
    throw new Error("Invalid outbound call correlation header");
  }
  return value;
}

export async function routeOutboundCall(callRecordId: string, callId: string, sipCallSid: string): Promise<OutboundRoutingDecision> {
  const call = await supabaseAdmin.from("calls")
    .select("id,operation_id,provider_id,purpose,quote_request_id,realtime_call_id,twilio_call_sid,outcome,ended_at,outbound_attempt,dispatch_state")
    .eq("id", callRecordId).eq("direction", "outbound").eq("persona", "provider").single();
  const c = call.data;
  if (call.error || !c?.operation_id || !c.provider_id || !c.quote_request_id
    || !isProviderOutboundPurpose(c.purpose) || c.outcome !== "active" || c.ended_at
    || ![1, 2, 3].includes(c.outbound_attempt)
    || !["dispatching", "accepted", "unknown"].includes(c.dispatch_state)
    || (c.realtime_call_id && c.realtime_call_id !== callId)) {
    throw call.error ?? new Error("Outbound call is not available");
  }
  const [provider, operation, request] = await Promise.all([
    supabaseAdmin.from("providers").select("id,name,phone,email,active").eq("id", c.provider_id).single(),
    supabaseAdmin.from("operations").select("id,current_mandate_id,status").eq("id", c.operation_id).single(),
    supabaseAdmin.from("quote_requests").select("id,operation_id,provider_id,round_id,mandate_id,status")
      .eq("id", c.quote_request_id).single(),
  ]);
  const p = provider.data, o = operation.data, r = request.data;
  if (provider.error || operation.error || request.error || !p?.active || !o || !r?.round_id
    || r.operation_id !== o.id || r.provider_id !== p.id || r.mandate_id !== o.current_mandate_id
    || !["pending", "queued", "contacted", "responded"].includes(r.status)
    || !["sourcing", "quotes_received"].includes(o.status)) {
    throw provider.error ?? operation.error ?? request.error ?? new Error("Outbound context unavailable");
  }
  const round = await supabaseAdmin.from("sourcing_rounds").select("id,operation_id,mandate_id,status")
    .eq("id", r.round_id).single();
  if (round.error || round.data?.status !== "active" || round.data.operation_id !== o.id
    || round.data.mandate_id !== o.current_mandate_id) throw round.error ?? new Error("Outbound round is closed");
  if (!c.realtime_call_id) {
    const linked = await supabaseAdmin.from("calls").update({ realtime_call_id: callId })
      .eq("id", callRecordId).is("realtime_call_id", null).eq("outcome", "active")
      .is("ended_at", null).select("realtime_call_id").maybeSingle();
    if (linked.error) throw linked.error;
    if (!linked.data) {
      const bound = await supabaseAdmin.from("calls").select("realtime_call_id,outcome,ended_at")
        .eq("id", callRecordId).single();
      if (bound.error || bound.data?.realtime_call_id !== callId || bound.data.outcome !== "active"
        || bound.data.ended_at) throw bound.error ?? new Error("Outbound call already bound");
    }
  }
  return { action: "accept", outbound: true, direction: "outbound", purpose: c.purpose,
    callRecordId, callId, quoteRequestId: r.id, roundId: r.round_id, attempt: c.outbound_attempt,
    twilioCallSid: c.twilio_call_sid ?? sipCallSid, callerPhone: p.phone,
    identity: { persona: "provider", providerId: p.id, name: p.name, phone: p.phone,
      email: p.email, active: p.active }, operations: [] };
}
