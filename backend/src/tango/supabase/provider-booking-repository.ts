import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolCallScope } from "../../domain/call-flow";
import type { ProviderBookingRepository, ProviderBookingToolName } from "../../domain/provider-booking-service";
import type {
  ProviderBooking,
  ProviderBookingResult,
  ProviderBookingSelectionName,
  ProviderBookingSelectionResult,
  ProviderBookingSummary,
  ProviderBookingTarget,
  ProviderInboundState,
  ProviderOperation,
  PickupWindow,
} from "../../domain/provider-call-state";
import { ToolError, type ToolErrorCode } from "../../domain/tool-error";

const errors: Record<string, [ToolErrorCode, string]> = {
  not_authorized: ["not_authorized", "The provider or call is no longer authorized."],
  invalid_arguments: ["invalid_arguments", "Check the reference, reason and ordered local pickup window. Send local clock times without an offset. Unchanged windows are not a reschedule."],
  pickup_timezone_unavailable: ["invalid_arguments", "The saved pickup windows do not have one verified UTC offset. Do not guess a timezone or claim the booking changed; explain that the pickup time needs clarification."],
  operation_reference_required: ["invalid_arguments", "Select the exact operation reference for this provider's confirmed booking."],
  operation_not_available: ["operation_not_available", "No confirmed booking for this operation is available to this provider."],
  intent_locked: ["intent_locked", "This call is locked to another operation or path."],
  invalid_transition: ["invalid_transition", "The booking or operation is no longer available for this change."],
  stale_operation: ["stale_operation", "The booking or operation changed after the last summary. Review refreshed terms and obtain new confirmation."],
  idempotency_conflict: ["idempotency_conflict", "This invocation ID already belongs to a different command."],
};

const inboundProfiles = new Set([
  "provider_inbound_entry", "provider_reschedule", "provider_cancel_booking",
  "provider_reschedule_alternatives", "provider_booking_escalation", "provider_unavailable", "terminal",
]);

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid provider tool response");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Invalid provider tool response: ${field}`);
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`Invalid provider tool response: ${field}`);
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid provider tool response: ${field}`);
  return value;
}

function nullableFiniteNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  return finiteNumber(value, field);
}

function summaryWindow(value: unknown, field: string): { start_at: string | null; end_at: string | null } {
  const input = record(value);
  return {
    start_at: nullableString(input.start_at, `${field}.start_at`),
    end_at: nullableString(input.end_at, `${field}.end_at`),
  };
}

function strictWindow(value: unknown, field: string): PickupWindow {
  const input = record(value);
  return {
    start_at: stringValue(input.start_at, `${field}.start_at`),
    end_at: stringValue(input.end_at, `${field}.end_at`),
  };
}

function operation(value: unknown): ProviderOperation {
  const input = record(value);
  if (!Array.isArray(input.operational_constraints)
    || !input.operational_constraints.every((item) => typeof item === "string")) {
    throw new Error("Invalid provider tool response: operation.operational_constraints");
  }
  const result: ProviderOperation = {
    operation_reference: stringValue(input.operation_reference, "operation.operation_reference"),
    container_type: nullableString(input.container_type, "operation.container_type"),
    gross_weight_kg: nullableFiniteNumber(input.gross_weight_kg, "operation.gross_weight_kg"),
    pickup_location: stringValue(input.pickup_location, "operation.pickup_location"),
    delivery_location: stringValue(input.delivery_location, "operation.delivery_location"),
    empty_return_depot: nullableString(input.empty_return_depot, "operation.empty_return_depot"),
    operational_constraints: [...input.operational_constraints],
    cargo_notes: nullableString(input.cargo_notes, "operation.cargo_notes"),
  };
  if (Object.prototype.hasOwnProperty.call(input, "currency")) result.currency = nullableString(input.currency, "operation.currency");
  if (Object.prototype.hasOwnProperty.call(input, "pickup_window")) {
    result.pickup_window = input.pickup_window === null ? null : strictWindow(input.pickup_window, "operation.pickup_window");
  }
  return result;
}

function bookingSummary(value: unknown): ProviderBookingSummary {
  const input = record(value);
  const window = summaryWindow(input.pickup_window, "booking.pickup_window");
  return {
    operation_reference: stringValue(input.operation_reference, "booking.operation_reference"),
    pickup_location: nullableString(input.pickup_location, "booking.pickup_location"),
    delivery_location: nullableString(input.delivery_location, "booking.delivery_location"),
    pickup_window: window,
  };
}

function booking(value: unknown): ProviderBooking {
  const input = record(value);
  const window = strictWindow(input.pickup_window, "selectedBooking.pickup_window");
  const payment = nullableFiniteNumber(input.payment_term_days, "selectedBooking.payment_term_days");
  const requiresReconfirmation = input.requires_reconfirmation;
  if (typeof requiresReconfirmation !== "boolean") throw new Error("Invalid provider tool response: selectedBooking.requires_reconfirmation");
  return {
    operation: operation(input.operation), pickup_window: window,
    pickup_utc_offset: nullableString(input.pickup_utc_offset ?? null, "selectedBooking.pickup_utc_offset"),
    confirmed_price: finiteNumber(input.confirmed_price, "selectedBooking.confirmed_price"),
    currency: stringValue(input.currency, "selectedBooking.currency"),
    payment_term_days: payment,
    requires_reconfirmation: requiresReconfirmation,
  };
}

function target(value: unknown): ProviderBookingTarget {
  const input = record(value);
  return {
    booking_id: stringValue(input.booking_id, "commandTarget.booking_id"),
    operation_revision: stringValue(input.operation_revision, "commandTarget.operation_revision"),
    mandate_id: stringValue(input.mandate_id, "commandTarget.mandate_id"),
  };
}

function result(value: unknown): ProviderBookingResult {
  const input = record(value);
  if (input.status === "alternatives_available") {
    if (input.reason_code !== "outside_action_window" || input.commitment_created !== false
      || !Array.isArray(input.available_pickup_local_windows) || input.available_pickup_local_windows.length === 0) {
      throw new Error("Invalid provider booking alternatives");
    }
    return { status: "alternatives_available", reason_code: "outside_action_window", commitment_created: false,
      available_pickup_local_windows: input.available_pickup_local_windows.map((window) => strictWindow(window, "available_pickup_local_windows")) };
  }
  if (input.status === "applied" || input.status === "requires_escalation") {
    if (input.commitment_created !== false) throw new Error("Invalid provider booking result");
    return { status: input.status, reason_code: nullableString(input.reason_code, "result.reason_code"), commitment_created: false };
  }
  if (input.booking_status === "cancelled") {
    if ((input.operation_status !== "sourcing" && input.operation_status !== "needs_follow_up")
      || input.commitment_created !== false || input.client_email_queued !== false) throw new Error("Invalid provider booking result");
    return { booking_status: "cancelled", operation_status: input.operation_status, commitment_created: false, client_email_queued: false };
  }
  throw new Error("Invalid provider booking result");
}

function selection(value: unknown): ProviderBookingSelectionResult {
  const input = record(value);
  if (input.status !== "selected"
    || (input.intent !== "reschedule" && input.intent !== "cancel_booking")) throw new Error("Invalid provider booking selection result");
  return { status: "selected", operation_reference: stringValue(input.operation_reference, "selection.operation_reference"), intent: input.intent };
}

function isInboundProfile(value: string): value is ProviderInboundState["profile"] {
  return inboundProfiles.has(value);
}

function inboundState(value: unknown): ProviderInboundState {
  const input = record(value);
  if (input.flow !== "provider_inbound" || typeof input.profile !== "string" || !isInboundProfile(input.profile)
    || (input.intent !== "undecided" && input.intent !== "reschedule" && input.intent !== "cancel_booking")
    || !Array.isArray(input.bookings)) throw new Error("Invalid provider inbound tool state");
  if (!(input.selectedBooking === null || typeof input.selectedBooking === "object")) throw new Error("Invalid provider inbound tool state: selectedBooking");
  if (!(input.commandTarget === null || typeof input.commandTarget === "object")) throw new Error("Invalid provider inbound tool state: commandTarget");
  if (!(input.lastResult === null || typeof input.lastResult === "object")) throw new Error("Invalid provider inbound tool state: lastResult");
  const selectedBooking = input.selectedBooking === null ? null : booking(input.selectedBooking);
  const commandTarget = input.commandTarget === null ? null : target(input.commandTarget);
  const lastResult = input.lastResult === null ? null : result(input.lastResult);
  if (input.profile === "provider_reschedule_alternatives"
    && (!lastResult || !("status" in lastResult) || lastResult.status !== "alternatives_available")) {
    throw new Error("Missing provider booking alternatives");
  }
  if ((input.profile === "provider_reschedule" || input.profile === "provider_reschedule_alternatives" || input.profile === "provider_cancel_booking" || input.profile === "provider_booking_escalation")
    && (selectedBooking === null || commandTarget === null)) throw new Error("Invalid provider inbound tool state: selected booking required");
  return {
    flow: "provider_inbound", profile: input.profile,
    intent: input.intent, bookings: input.bookings.map(bookingSummary),
    selectedBooking, commandTarget,
    lastResult,
  };
}
export class SupabaseProviderBookingRepository implements ProviderBookingRepository {
  constructor(private readonly client: SupabaseClient) {}
  async getState(scope: ToolCallScope): Promise<ProviderInboundState> {
    this.assertInboundScope(scope);
    const { data, error } = await this.client.rpc("get_provider_tool_state", this.context(scope));
    if (error) this.rethrow(error);
    return inboundState(data);
  }
  async execute(scope: ToolCallScope, name: ProviderBookingToolName, id: string, args: object, target: ProviderBookingTarget | null): Promise<ProviderBookingResult> {
    this.assertInboundScope(scope);
    const { data, error } = await this.client.rpc("execute_provider_booking_tool", {
      p_call_id: scope.callId, p_realtime_call_id: scope.realtimeCallId, p_provider_id: scope.counterpartyId,
      p_tool_name: name, p_tool_call_id: id, p_arguments: args, p_context: target,
    });
    if (error) {
      const safe = error.code === "P0001" ? errors[error.message] : undefined;
      if (safe) throw new ToolError(...safe);
      throw error;
    }
    if (data === null || data === undefined) throw new Error("Missing provider booking result");
    return result(data);
  }
  async select(scope: ToolCallScope, name: ProviderBookingSelectionName, id: string, operationReference: string): Promise<ProviderBookingSelectionResult> {
    this.assertInboundScope(scope);
    const { data, error } = await this.client.rpc("select_provider_booking", {
      ...this.context(scope), p_tool_call_id: id, p_tool_name: name,
      p_arguments: { operation_reference: operationReference },
    });
    if (error) this.rethrow(error);
    if (data === null || data === undefined) throw new Error("Missing provider booking selection result");
    return selection(data);
  }
  private assertInboundScope(scope: ToolCallScope): void {
    if (scope.persona !== "provider" || scope.direction !== "inbound" || scope.purpose !== "booking_management") {
      throw new ToolError("not_authorized", "The provider or call is no longer authorized.");
    }
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
