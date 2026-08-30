import { ProviderBookingService, type ProviderBookingSelectionName } from "../../domain/provider-booking-service";
import { ToolError } from "../../domain/tool-error";
import { RealtimeTool, type JsonSchema, type RealtimeFunctionToolDefinition, type ToolInvocation } from "./realtime-tool";

export class RescheduleBookingTool extends RealtimeTool {
  readonly definition = {
    type: "function" as const, name: "reschedule_booking",
    description: "Changes only the pickup window of the authenticated provider's confirmed booking after explicit confirmation. Send local clock times without UTC conversion; the server uses the saved pickup offset. Inside the mandate it applies directly. Outside the allowed schedule it leaves the booking unchanged and returns available local windows: offer those FIRST and wait for the caller. Do not immediately escalate. No email is sent or queued.",
    parameters: {
      type: "object", properties: {
        operation_reference: { type: "string", pattern: "^OP-[0-9]{6,}$" },
        proposed_pickup_local_window: { type: "object", properties: {
          start_at: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$" },
          end_at: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$" },
        }, required: ["start_at", "end_at"], additionalProperties: false },
        reason: { type: "string", minLength: 1 },
      }, required: ["proposed_pickup_local_window", "reason"], additionalProperties: false,
    } as JsonSchema,
  };
  constructor(private readonly service: ProviderBookingService) { super(); }
  execute(args: unknown, invocation?: ToolInvocation): Promise<unknown> {
    return this.service.execute("reschedule_booking", args, invocation?.toolCallId ?? "");
  }
}

export class DeclineRescheduleAlternativesTool extends RealtimeTool {
  readonly definition = {
    type: "function" as const, name: "decline_reschedule_alternatives",
    description: "Only AFTER reading the server's available pickup windows and hearing in a later caller turn that NONE work, record that refusal to enable human escalation. Never call in the same turn as offering the windows, for silence, an unclear response or acceptance of a window. Does not cancel or modify the booking or transfer the call.",
    parameters: {
      type: "object", properties: {
        operation_reference: { type: "string", pattern: "^OP-[0-9]{6,}$" },
        reason: { type: "string", minLength: 1 },
      }, required: ["reason"], additionalProperties: false,
    } as JsonSchema,
  };
  constructor(private readonly service: ProviderBookingService) { super(); }
  execute(args: unknown, invocation?: ToolInvocation): Promise<unknown> {
    return this.service.execute("decline_reschedule_alternatives", args, invocation?.toolCallId ?? "");
  }
}
abstract class SelectBookingTool extends RealtimeTool {
  constructor(protected readonly service: ProviderBookingService, private readonly selection: ProviderBookingSelectionName) { super(); }
  protected definitionFor(name: string, description: string): RealtimeFunctionToolDefinition { return {
    type: "function" as const, name, description,
    parameters: { type: "object" as const, properties: { operation_reference: { type: "string" as const, pattern: "^OP-[0-9]{6,}$" } }, required: ["operation_reference"], additionalProperties: false },
  }; }
  execute(args: unknown, invocation?: ToolInvocation): Promise<unknown> {
    if (!args || typeof args !== "object" || Array.isArray(args)
      || Object.keys(args).length !== 1 || !("operation_reference" in args)) {
      throw new ToolError("invalid_arguments", "Supply only the exact operation_reference for this booking.");
    }
    const reference = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>).operation_reference : undefined;
    return this.service.select(this.selection, reference, invocation?.toolCallId ?? "");
  }
}
export class SelectBookingForRescheduleTool extends SelectBookingTool {
  readonly definition = this.definitionFor("select_booking_for_reschedule", "Selects the provider's exact confirmed booking before rescheduling it.");
  constructor(service: ProviderBookingService) { super(service, "select_booking_for_reschedule"); }
}
export class SelectBookingForCancellationTool extends SelectBookingTool {
  readonly definition = this.definitionFor("select_booking_for_cancellation", "Selects the provider's exact confirmed booking before cancelling it.");
  constructor(service: ProviderBookingService) { super(service, "select_booking_for_cancellation"); }
}
export class CancelBookingTool extends RealtimeTool {
  readonly definition = {
    type: "function" as const, name: "cancel_booking",
    description: "Cancels only the authenticated provider's confirmed booking after explicit verbal confirmation, preserves history and returns the operation to sourcing. Does not cancel the client's operation or send or queue email.",
    parameters: {
      type: "object", properties: {
        operation_reference: { type: "string", pattern: "^OP-[0-9]{6,}$" }, reason: { type: "string", minLength: 1 },
      }, required: ["reason"], additionalProperties: false,
    } as JsonSchema,
  };
  constructor(private readonly service: ProviderBookingService) { super(); }
  execute(args: unknown, invocation?: ToolInvocation): Promise<unknown> {
    return this.service.execute("cancel_booking", args, invocation?.toolCallId ?? "");
  }
}
