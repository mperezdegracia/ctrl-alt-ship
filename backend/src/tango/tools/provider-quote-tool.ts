import { ProviderQuoteService } from "../../domain/provider-quote-service";
import { RealtimeTool, type JsonSchema, type ToolInvocation } from "./realtime-tool";

export class CreateQuoteTool extends RealtimeTool {
  readonly definition = {
    type: "function" as const, name: "create_quote",
    description: "Records only the provider's price for the verified job after one brief verbal approval. For a fixed amount use equal min/max. Currency and pickup come from verified context; do not ask for or send payment, expiry or conditions. Counteroffers change only price. The server evaluates against the private mandate.",
    parameters: {
      type: "object", properties: {
        operation_reference: { type: "string", pattern: "^OP-[0-9]{6,}$" },
        price_range: { type: "object", properties: {
          min: { type: "number", exclusiveMinimum: 0 }, max: { type: "number", exclusiveMinimum: 0 },
        }, required: ["min", "max"], additionalProperties: false },
      }, required: ["price_range"], additionalProperties: false,
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

export class RecordProviderOfferTool extends RealtimeTool {
  readonly definition = {
    type: "function" as const, name: "record_provider_offer",
    description: "Records the provider's observed price before negotiation; it does not approve or book the quote.",
    parameters: {
      type: "object", properties: {
        price_range: { type: "object", properties: { min: { type: "number", exclusiveMinimum: 0 }, max: { type: "number", exclusiveMinimum: 0 } }, required: ["min", "max"], additionalProperties: false },
        currency: { type: "string", minLength: 1 },
      }, required: ["price_range"], additionalProperties: false,
    } as JsonSchema,
  };
  constructor(private readonly service: ProviderQuoteService) { super(); }
  execute(args: unknown, invocation?: ToolInvocation): Promise<unknown> {
    return this.service.recordOffer(args, invocation?.toolCallId ?? "");
  }
}
