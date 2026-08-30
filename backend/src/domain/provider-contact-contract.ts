import type { ProviderOutboundPurpose } from "./call-flow";

export type ProviderAttempt = 1 | 2 | 3;
export type ProviderDispatchState = "prepared" | "dispatching" | "accepted" | "unknown" | "failed";
export type SourcingRoundStatus = "active" | "selected" | "exhausted" | "superseded";
export type ProviderCallStatus = "queued" | "initiated" | "ringing" | "in-progress"
  | "completed" | "busy" | "failed" | "no-answer" | "canceled";
export type ClaimedProviderContact = {
  outbox_id: string; call_id: string; lock_token: string;
  operation_id: string; round_id: string; quote_request_id: string; provider_id: string;
  provider_phone: string; purpose: ProviderOutboundPurpose; attempt: ProviderAttempt;
};
export type BeginProviderContactArguments = {
  p_outbox_id: string; p_call_id: string; p_lock_token: string;
};
export type BeginProviderContactResult = { should_dial: boolean };
export type FinishProviderContactArguments = BeginProviderContactArguments & {
  p_twilio_call_sid: string | null; p_error: string | null;
  p_error_kind: "definite" | "ambiguous" | null;
};
export type FinishProviderContactResult = { dispatch_state: ProviderDispatchState; persisted: boolean };
export type RecordProviderCallStatusArguments = {
  p_call_id: string; p_twilio_call_sid: string; p_status: ProviderCallStatus;
  p_sequence: number; p_event_at: string;
};
export type RecordProviderCallStatusResult = {
  accepted: boolean; retry_scheduled: boolean; next_attempt: ProviderAttempt | null;
};
export type AdvanceSourcingRoundResult = {
  round_id: string | null; status: SourcingRoundStatus | null;
  operation_status: string; reason: string;
};
export const PROVIDER_CONTACT_RPCS = {
  claim: "claim_next_provider_contact_v2",
  begin: "begin_provider_contact",
  finish: "finish_provider_contact_v2",
  status: "record_provider_call_status",
  advance: "advance_sourcing_round",
} as const;
