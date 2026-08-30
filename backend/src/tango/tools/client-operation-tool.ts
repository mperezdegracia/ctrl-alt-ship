import { ClientOperationService } from "../../domain/client-operation-service";
import { RealtimeTool, type JsonSchema, type ToolInvocation } from "./realtime-tool";

const operationFields: Record<string, unknown> = {
  container_type: { type: "string", minLength: 1 },
  gross_weight_kg: { type: "number", exclusiveMinimum: 0, maximum: 999999999.999, multipleOf: 0.001 },
  pickup_location: { type: "string", minLength: 1 },
  delivery_location: { type: "string", minLength: 1 },
  empty_return_depot: { type: "string", minLength: 1 },
  operational_constraints: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
  cargo_notes: { type: "string", minLength: 1 },
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
        changes: { type: "object", properties: { ...operationFields, cargo_notes: { type: ["string", "null"] } }, minProperties: 1, additionalProperties: false },
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
    description: "Creates an immutable mandate immediately after ONE verbal approval of the combined order and terms; never request a separate mandate approval. First mandate: save shipment fields first, give a compact combined recap, then send all commercial terms. Updating an existing mandate: confirm only the combined changes and send changed commercial terms (or {}); the server inherits omitted terms and builds the full snapshot.",
    parameters: {
      type: "object", properties: {
        price_cap: { type: "number", exclusiveMinimum: 0, maximum: 999999999999.99, multipleOf: 0.01 },
        currency: { type: "string", pattern: "^[A-Z]{3}$" },
        action_windows: { type: "array", minItems: 1, items: {
          type: "object", properties: {
            start_at: { type: "string", format: "date-time" }, end_at: { type: "string", format: "date-time" },
          }, required: ["start_at", "end_at"], additionalProperties: false,
        } },
        minimum_payment_term_days: { type: "integer", minimum: 0, maximum: 2147483647 },
      }, required: [], additionalProperties: false,
    } as JsonSchema,
  };

  constructor(private readonly service: ClientOperationService) { super(); }

  execute(args: unknown, invocation?: ToolInvocation): Promise<unknown> {
    return this.service.confirm(args, invocation?.toolCallId ?? "");
  }
}
