import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolCallScope } from "../../domain/operation-read-service";
import type { ProviderBookingRepository, ProviderBookingResult, ProviderBookingTarget, ProviderBookingToolName } from "../../domain/provider-booking-service";
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
}
