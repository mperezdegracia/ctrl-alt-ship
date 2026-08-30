import { ProviderQuoteService } from "../../domain/provider-quote-service";
import { RealtimeTool, type JsonSchema, type ToolInvocation } from "./realtime-tool";

export class CreateQuoteTool extends RealtimeTool {
  readonly definition = {
    type: "function" as const, name: "create_quote",
    description: "Records a complete provider quote as an immutable version. The server evaluates it against the current mandate and never returns the client's price cap.",
    parameters: {
      type: "object", properties: {
        operation_reference: { type: "string", pattern: "^OP-[0-9]{6,}$" },
        price_range: { type: "object", properties: {
          min: { type: "number", exclusiveMinimum: 0 }, max: { type: "number", exclusiveMinimum: 0 },
          currency: { type: "string", pattern: "^[A-Z]{3}$" },
        }, required: ["min", "max", "currency"], additionalProperties: false },
        proposed_pickup_window: { type: "object", properties: {
          start_at: { type: "string", format: "date-time" }, end_at: { type: "string", format: "date-time" },
        }, required: ["start_at", "end_at"], additionalProperties: false },
        payment_term_days: { type: "integer", minimum: 0 },
        valid_until: { type: "string", format: "date-time" },
        conditions: { type: "object", properties: {
          notes: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
        }, required: ["notes"], additionalProperties: false },
      }, required: ["price_range", "proposed_pickup_window", "payment_term_days", "valid_until", "conditions"], additionalProperties: false,
    } as JsonSchema,
  };
  constructor(private readonly service: ProviderQuoteService) { super(); }
  execute(args: unknown, invocation?: ToolInvocation): Promise<unknown> {
    return this.service.execute("create_quote", args, invocation?.toolCallId ?? "");
  }
}

export class DeclineQuoteRequestTool extends RealtimeTool {
  readonly definition = {
    type: "function" as const, name: "decline_quote_request",
    description: "Records that the provider explicitly declined to quote. It creates no quote or commitment.",
    parameters: {
      type: "object", properties: {
        operation_reference: { type: "string", pattern: "^OP-[0-9]{6,}$" },
        reason: { type: "string", enum: ["no_capacity", "unavailable_window", "price_terms", "route_unsupported", "operational_constraints", "other"] },
        details: { type: "string", minLength: 1 },
      }, required: ["reason"], additionalProperties: false,
    } as JsonSchema,
  };
  constructor(private readonly service: ProviderQuoteService) { super(); }
  execute(args: unknown, invocation?: ToolInvocation): Promise<unknown> {
    return this.service.execute("decline_quote_request", args, invocation?.toolCallId ?? "");
  }
}
