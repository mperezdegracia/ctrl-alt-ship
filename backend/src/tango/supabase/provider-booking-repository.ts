import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolCallScope } from "../../domain/call-flow";
import type { ProviderBookingRepository, ProviderBookingResult, ProviderBookingTarget, ProviderBookingToolName, ProviderBookingSelectionName, ProviderBookingSelectionResult } from "../../domain/provider-booking-service";
import type { ProviderInboundState } from "../../domain/provider-call-state";
import { ToolError, type ToolErrorCode } from "../../domain/tool-error";

const errors: Record<string, [ToolErrorCode, string]> = {
  not_authorized: ["not_authorized", "The provider or call is no longer authorized."],
  invalid_arguments: ["invalid_arguments", "Check the reference, reason and exact zoned pickup window. Unchanged windows are not a reschedule."],
  operation_reference_required: ["invalid_arguments", "Select the exact operation reference for this provider's confirmed booking."],
  operation_not_available: ["operation_not_available", "No confirmed booking for this operation is available to this provider."],
  intent_locked: ["intent_locked", "This call is locked to another operation or path."],
  invalid_transition: ["invalid_transition", "The booking or operation is no longer available for this change."],
  stale_operation: ["stale_operation", "The booking or operation changed after the last summary. Review refreshed terms and obtain new confirmation."],
  idempotency_conflict: ["idempotency_conflict", "This invocation ID already belongs to a different command."],
};
export class SupabaseProviderBookingRepository implements ProviderBookingRepository {
  constructor(private readonly client: SupabaseClient) {}
  async getState(scope: ToolCallScope): Promise<ProviderInboundState> {
    const { data, error } = await this.client.rpc("get_provider_tool_state", this.context(scope));
    if (error) this.rethrow(error);
    if (!data || data.flow !== "provider_inbound"
      || !["provider_inbound_entry", "provider_reschedule", "provider_cancel_booking", "provider_booking_escalation", "provider_unavailable", "terminal"].includes(data.profile)
      || !Array.isArray(data.bookings) || !("selectedBooking" in data) || !("commandTarget" in data)) {
      throw new Error("Invalid provider inbound tool state");
    }
    return data as ProviderInboundState;
  }
  async execute(scope: ToolCallScope, name: ProviderBookingToolName, id: string, args: object, target: ProviderBookingTarget | null): Promise<ProviderBookingResult> {
    const { data, error } = await this.client.rpc("execute_provider_booking_tool", {
      p_call_id: scope.callId, p_realtime_call_id: scope.realtimeCallId, p_provider_id: scope.counterpartyId,
      p_tool_name: name, p_tool_call_id: id, p_arguments: args, p_context: target,
    });
    if (error) {
      const safe = error.code === "P0001" ? errors[error.message] : undefined;
      if (safe) throw new ToolError(...safe);
      throw error;
    }
    if (!data) throw new Error("Missing provider booking result");
    return data as ProviderBookingResult;
  }
  async select(scope: ToolCallScope, name: ProviderBookingSelectionName, id: string, operationReference: string): Promise<ProviderBookingSelectionResult> {
    const { data, error } = await this.client.rpc("select_provider_booking", {
      ...this.context(scope), p_tool_call_id: id, p_tool_name: name,
      p_arguments: { operation_reference: operationReference },
    });
    if (error) this.rethrow(error);
    if (!data) throw new Error("Missing provider booking selection result");
    return data as ProviderBookingSelectionResult;
  }
  private context(scope: ToolCallScope) {
    return { p_call_id: scope.callId, p_realtime_call_id: scope.realtimeCallId, p_provider_id: scope.counterpartyId };
  }
  private rethrow(error: { code?: string; message: string }): never {
    const safe = error.code === "P0001" ? errors[error.message] : undefined;
    if (safe) throw new ToolError(...safe);
    throw error;
  }
}
