import { supabaseAdmin } from "../../config/supabase";
import type { CounterpartyIdentity, OperationContext } from "../supabase/erp";

export type OutboundRoutingDecision = {
  action: "accept";
  outbound: true;
  callRecordId: string;
  callId: string;
  twilioCallSid: string;
  callerPhone: string;
  identity: CounterpartyIdentity;
  operations: OperationContext[];
};

export function extractOutboundCallRecordId(headers: Array<{ name: string; value: string }> = []): string | null {
  return headers.find((header) => header.name.toLowerCase() === "x-tango-call-id")?.value.trim() || null;
}

export async function routeOutboundCall(callRecordId: string, callId: string, sipCallSid: string): Promise<OutboundRoutingDecision> {
  const call = await supabaseAdmin.from("calls").select("id,operation_id,provider_id").eq("id", callRecordId).eq("direction", "outbound").single();
  if (call.error || !call.data?.operation_id || !call.data.provider_id) throw call.error ?? new Error("Unknown outbound call");
  const [provider, operation] = await Promise.all([
    supabaseAdmin.from("providers").select("id,name,phone,email,active").eq("id", call.data.provider_id).single(),
    supabaseAdmin.from("operations").select("id,reference,status,container_type,pickup_location,delivery_location,updated_at").eq("id", call.data.operation_id).single(),
  ]);
  if (provider.error || operation.error || !provider.data || !operation.data) throw provider.error ?? operation.error ?? new Error("Outbound context unavailable");
  await supabaseAdmin.from("calls").update({ realtime_call_id: callId }).eq("id", callRecordId);
  return { action: "accept", outbound: true, callRecordId, callId, twilioCallSid: sipCallSid, callerPhone: provider.data.phone, identity: { persona: "provider", providerId: provider.data.id, name: provider.data.name, phone: provider.data.phone, email: provider.data.email, active: provider.data.active }, operations: [{ id: operation.data.id, reference: operation.data.reference, name: operation.data.reference, status: operation.data.status, containerType: operation.data.container_type, pickupLocation: operation.data.pickup_location, deliveryLocation: operation.data.delivery_location, updatedAt: operation.data.updated_at }] };
}
