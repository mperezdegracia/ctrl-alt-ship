import type {
  CounterpartyIdentity,
  OperationContext,
} from "../supabase/erp";
import type { ProviderOutboundPurpose } from "../../domain/call-flow";

export type SipHeader = { name: string; value: string };

export type IncomingCallEvent = {
  id?: string;
  type: "realtime.call.incoming";
  data: {
    call_id: string;
    sip_headers?: SipHeader[];
  };
};

export type RejectionReason =
  | "unknown_caller"
  | "inactive_contact"
  | "unauthorized_contact";

export type RoutingDecision =
  | {
      action: "reject";
      callId: string;
      callerPhone: string;
      reason: RejectionReason;
    }
  | ({
      action: "accept";
      callId: string;
      twilioCallSid: string;
      callerPhone: string;
      identity: CounterpartyIdentity;
      operations: OperationContext[];
    } & (
      | { outbound: false; direction: "inbound"; purpose: "operation_management" | "booking_management" }
      | { outbound: true; direction: "outbound"; purpose: ProviderOutboundPurpose;
          callRecordId: string; quoteRequestId: string; roundId: string; attempt: number }
    ));

export type RoutingDependencies = {
  findIdentity(callerPhone: string): Promise<CounterpartyIdentity | null>;
  listClientOperations(contactId: string): Promise<OperationContext[]>;
  listProviderOperations(providerId: string): Promise<OperationContext[]>;
};

function findHeader(headers: SipHeader[], name: string): string | undefined {
  return headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value;
}

function extractE164FromSipValue(value: string | undefined): string | null {
  if (!value) return null;
  return value.match(/sip:(\+[1-9][0-9]{7,14})(?=[@;>])/i)?.[1] ?? null;
}

export function extractCallerPhone(headers: SipHeader[] = []): string | null {
  for (const name of ["P-Asserted-Identity", "From", "Contact"]) {
    const phone = extractE164FromSipValue(findHeader(headers, name));
    if (phone) return phone;
  }
  return null;
}

export function extractTwilioCallSid(headers: SipHeader[] = []): string | null {
  return findHeader(headers, "X-Twilio-CallSid")?.trim() || null;
}

export async function routeIncomingCall(
  event: IncomingCallEvent,
  dependencies: RoutingDependencies,
): Promise<RoutingDecision> {
  const headers = event.data.sip_headers ?? [];
  const callerPhone = extractCallerPhone(headers);
  if (!callerPhone) {
    throw new Error("Incoming SIP call has no valid E.164 caller ID");
  }

  const identity = await dependencies.findIdentity(callerPhone);
  if (!identity) {
    return { action: "reject", callId: event.data.call_id, callerPhone, reason: "unknown_caller" };
  }

  if (!identity.active) {
    return {
      action: "reject",
      callId: event.data.call_id,
      callerPhone,
      reason: identity.persona === "client" ? "inactive_contact" : "unknown_caller",
    };
  }
  if (identity.persona === "client" && !identity.authorized) {
    return {
      action: "reject",
      callId: event.data.call_id,
      callerPhone,
      reason: "unauthorized_contact",
    };
  }

  const twilioCallSid = extractTwilioCallSid(headers);
  if (!twilioCallSid) {
    throw new Error("Incoming SIP call has no X-Twilio-CallSid header");
  }

  const operations = identity.persona === "client"
    ? await dependencies.listClientOperations(identity.contactId)
    : []; // Provider context is loaded exactly once by its authorized state reader.

  return {
    action: "accept",
    outbound: false,
    direction: "inbound",
    purpose: identity.persona === "client" ? "operation_management" : "booking_management",
    callId: event.data.call_id,
    twilioCallSid,
    callerPhone,
    identity,
    operations,
  };
}
