import { ClientOperationService } from "../../domain/client-operation-service";
import { RealtimeTool, type JsonSchema, type ToolInvocation } from "./realtime-tool";

const operationFields: Record<string, unknown> = {
  pickup_location: { type: "string", minLength: 1 },
  delivery_location: { type: "string", minLength: 1 },
};

export class CreateOperationTool extends RealtimeTool {
  readonly definition = {
    type: "function" as const,
    name: "create_operation",
    description: "Creates a new draft operation for the authenticated client using only facts already stated in the conversation. Missing fields remain null and must never be invented.",
    parameters: { type: "object", properties: operationFields, required: [], additionalProperties: false } as JsonSchema,
  };

  constructor(private readonly service: ClientOperationService) { super(); }

  execute(args: unknown, invocation?: ToolInvocation): Promise<unknown> {
    return this.service.create(args, invocation?.toolCallId ?? "");
  }
}

export class UpdateOperationTool extends RealtimeTool {
  readonly definition = {
    type: "function" as const,
    name: "update_operation",
    description: "Updates the selected operation with facts explicitly provided by the authenticated client. At client entry, operation_reference selects and locks the operation; after selection it may be omitted.",
    parameters: {
      type: "object", properties: {
        operation_reference: { type: "string", pattern: "^OP-[0-9]{6,}$" },
        changes: { type: "object", properties: operationFields, minProperties: 1, additionalProperties: false },
      }, required: ["changes"], additionalProperties: false,
    } as JsonSchema,
  };

  constructor(private readonly service: ClientOperationService) { super(); }

  execute(args: unknown, invocation?: ToolInvocation): Promise<unknown> {
    return this.service.update(args, invocation?.toolCallId ?? "");
  }
}

export class CancelOperationTool extends RealtimeTool {
  readonly definition = {
    type: "function" as const,
    name: "cancel_operation",
    description: "Cancels an operation only after the authenticated client explicitly confirms the cancellation. This is a terminal logical cancellation, never a database delete. No email is sent or queued.",
    parameters: {
      type: "object", properties: {
        operation_reference: { type: "string", pattern: "^OP-[0-9]{6,}$" },
        reason: { type: "string", minLength: 1 },
      }, required: ["operation_reference", "reason"], additionalProperties: false,
    } as JsonSchema,
  };

  constructor(private readonly service: ClientOperationService) { super(); }

  execute(args: unknown, invocation?: ToolInvocation): Promise<unknown> {
    return this.service.cancel(args, invocation?.toolCallId ?? "");
  }
}

export class ConfirmMandateTool extends RealtimeTool {
  readonly definition = {
    type: "function" as const,
    name: "confirm_mandate",
    description: "Confirms the order and mandate after ONE combined verbal approval. First mandate: save origin/destination first, then provide price_cap, currency and action_windows. Updates inherit omitted terms; send only changes (or {}). Never ask for separate order, mandate and sourcing approvals.",
    parameters: {
      type: "object", properties: {
        price_cap: { type: "number", exclusiveMinimum: 0, maximum: 999999999999.99, multipleOf: 0.01 },
        currency: { type: "string", pattern: "^[A-Z]{3}$" },
        action_windows: { type: "array", minItems: 1, items: {
          type: "object", properties: {
            start_at: { type: "string", format: "date-time" }, end_at: { type: "string", format: "date-time" },
          }, required: ["start_at", "end_at"], additionalProperties: false,
        } },
      }, required: [], additionalProperties: false,
    } as JsonSchema,
  };

  constructor(private readonly service: ClientOperationService) { super(); }

  execute(args: unknown, invocation?: ToolInvocation): Promise<unknown> {
    return this.service.confirm(args, invocation?.toolCallId ?? "");
  }
}
