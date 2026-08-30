/** Direction and purpose are authenticated from the persisted call, never tool arguments. */
export type ProviderOutboundPurpose = "quote_request" | "renegotiation" | "booking_replacement";
export type CallIdentity = Readonly<{
  callId: string;
  realtimeCallId: string;
  counterpartyId: string;
}>;
export type ToolCallScope = CallIdentity & Readonly<
  | { persona: "client"; direction: "inbound"; purpose: "operation_management" }
  | { persona: "provider"; direction: "inbound"; purpose: "booking_management" }
  | { persona: "provider"; direction: "outbound"; purpose: ProviderOutboundPurpose }
>;
export type CallPurpose = ToolCallScope["purpose"];

export function isProviderOutboundPurpose(value: unknown): value is ProviderOutboundPurpose {
  return value === "quote_request" || value === "renegotiation" || value === "booking_replacement";
}
