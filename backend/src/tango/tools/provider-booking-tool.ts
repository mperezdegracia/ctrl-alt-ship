import { ProviderBookingService } from "../../domain/provider-booking-service";
import { RealtimeTool, type JsonSchema, type ToolInvocation } from "./realtime-tool";

export class RescheduleBookingTool extends RealtimeTool {
  readonly definition = {
    type: "function" as const, name: "reschedule_booking",
    description: "Changes only the pickup window of the authenticated provider's confirmed booking after explicit confirmation, preserving price and terms. Outside the mandate it changes no booking and requires escalation. No email is sent or queued.",
    parameters: {
      type: "object", properties: {
        operation_reference: { type: "string", pattern: "^OP-[0-9]{6,}$" },
        proposed_pickup_window: { type: "object", properties: {
          start_at: { type: "string", format: "date-time" }, end_at: { type: "string", format: "date-time" },
        }, required: ["start_at", "end_at"], additionalProperties: false },
        reason: { type: "string", minLength: 1 },
      }, required: ["proposed_pickup_window", "reason"], additionalProperties: false,
    } as JsonSchema,
  };
  constructor(private readonly service: ProviderBookingService) { super(); }
  execute(args: unknown, invocation?: ToolInvocation): Promise<unknown> {
    return this.service.execute("reschedule_booking", args, invocation?.toolCallId ?? "");
  }
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
