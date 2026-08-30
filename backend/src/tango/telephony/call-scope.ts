import type { ToolCallScope } from "../../domain/call-flow";
import { isProviderOutboundPurpose } from "../../domain/call-flow";
import type { RoutingDecision } from "./inbound-routing";

type AcceptedRoutingDecision = Extract<RoutingDecision, { action: "accept" }>;

/** Builds the immutable tool scope from the persisted routing decision. */
export function resolveCallScope(
  decision: AcceptedRoutingDecision,
  persistedCallId: string,
): ToolCallScope {
  if (!persistedCallId || typeof persistedCallId !== "string") {
    throw new Error("A persisted call ID is required to build tool scope");
  }
  if (decision.outbound === true) {
    if (decision.direction !== "outbound" || !isProviderOutboundPurpose(decision.purpose)
      || decision.callRecordId !== persistedCallId || decision.identity.persona !== "provider") {
      throw new Error("Outbound routing decision does not match the persisted call");
    }
    return Object.freeze({
      callId: persistedCallId,
      realtimeCallId: decision.callId,
      counterpartyId: decision.identity.providerId,
      persona: "provider",
      direction: "outbound",
      purpose: decision.purpose,
    });
  }
  if (decision.outbound !== false || decision.direction !== "inbound") {
    throw new Error("Inbound routing decision has no explicit inbound direction");
  }
  if (decision.identity.persona === "client") {
    if (decision.purpose !== "operation_management") {
      throw new Error("Client routing decision has an invalid purpose");
    }
    return Object.freeze({
      callId: persistedCallId,
      realtimeCallId: decision.callId,
      counterpartyId: decision.identity.contactId,
      persona: "client",
      direction: "inbound",
      purpose: "operation_management",
    });
  }
  if (decision.identity.persona !== "provider" || decision.purpose !== "booking_management") {
    throw new Error("Provider inbound routing decision has an invalid purpose");
  }
  return Object.freeze({
    callId: persistedCallId,
    realtimeCallId: decision.callId,
    counterpartyId: decision.identity.providerId,
    persona: "provider",
    direction: "inbound",
    purpose: "booking_management",
  });
}
