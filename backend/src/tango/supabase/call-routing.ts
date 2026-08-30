import type { SupabaseClient } from "@supabase/supabase-js";

import { supabaseAdmin } from "../../config/supabase";
import type { RoutingDecision } from "../telephony/inbound-routing";

type AcceptedDecision = Extract<RoutingDecision, { action: "accept" }>;
type RejectedDecision = Extract<RoutingDecision, { action: "reject" }>;

export async function persistRejectedCall(
  decision: RejectedDecision,
  client: SupabaseClient = supabaseAdmin,
): Promise<void> {
  const result = await client.from("events").insert({
    operation_id: null,
    call_id: null,
    commitment_id: null,
    type: "call.rejected",
    schema_version: 1,
    payload: {
      direction: "inbound",
      caller_phone: decision.callerPhone,
      reason: decision.reason,
    },
  });
  if (result.error) throw result.error;
}

export async function persistRoutedCall(
  decision: AcceptedDecision,
  client: SupabaseClient = supabaseAdmin,
): Promise<string> {
  const existing = await client
    .from("calls")
    .select("id,operation_id,direction")
    .eq("realtime_call_id", decision.callId)
    .maybeSingle();
  if (existing.error) throw existing.error;

  let callId = existing.data?.id as string | undefined;
  let operationId = existing.data?.operation_id as string | null | undefined;
  let direction = existing.data?.direction as "inbound" | "outbound" | undefined;
  if (!callId) {
    const callInsert = await client
      .from("calls")
      .insert({
        operation_id: null,
        contact_id: decision.identity.persona === "client" ? decision.identity.contactId : null,
        provider_id: decision.identity.persona === "provider" ? decision.identity.providerId : null,
        operation_intent: decision.identity.persona === "client" ? "undecided" : null,
        provider_intent: decision.identity.persona === "provider" ? "undecided" : null,
        twilio_call_sid: decision.twilioCallSid,
        realtime_call_id: decision.callId,
        persona: decision.identity.persona,
        direction: "inbound",
        outcome: "active",
      })
      .select("id")
      .single();
    if (callInsert.error) throw callInsert.error;
    if (!callInsert.data) throw new Error("Supabase did not return the routed call");
    callId = callInsert.data.id as string;
    operationId = null;
    direction = "inbound";
  }

  const routedEvent = await client
    .from("events")
    .select("id")
    .eq("call_id", callId)
    .eq("type", "call.routed")
    .limit(1)
    .maybeSingle();
  if (routedEvent.error) throw routedEvent.error;

  if (!routedEvent.data) {
    const eventInsert = await client.from("events").insert({
      operation_id: operationId ?? null,
      call_id: callId,
      commitment_id: null,
      type: "call.routed",
      schema_version: 1,
      payload: {
        direction: direction ?? "inbound",
        persona: decision.identity.persona,
        intent: "undecided",
        counterparty_type: decision.identity.persona === "client" ? "contact" : "provider",
        candidate_operation_references: decision.operations.map((operation) => operation.reference),
      },
    });
    if (eventInsert.error) throw eventInsert.error;
  }

  return callId;
}
