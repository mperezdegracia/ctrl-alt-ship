import { ProviderQuoteService } from "../../domain/provider-quote-service";
import { RealtimeTool, type JsonSchema, type ToolInvocation } from "./realtime-tool";

export class CreateQuoteTool extends RealtimeTool {
  readonly definition = {
    type: "function" as const, name: "create_quote",
    description: "Records the actual price returned or maintained by the provider after a discount attempt. Try at most twice, counting the opening counteroffer; stop sooner if the provider is frustrated or refuses more bargaining. After final approval, accept_above_budget permits a price exception once attempts are exhausted, or earlier with negotiation_stopped_by_provider true. Within-budget quotes require final approval. Never simulate attempts, disclose private limits or promise selection.",
    parameters: {
      type: "object", properties: {
        operation_reference: { type: "string", pattern: "^OP-[0-9]{6,}$" },
        accept_above_budget: { type: "boolean", description: "True after explicit final approval, once attempts are exhausted or the provider stopped bargaining. Permits a price exception, not changes to fixed terms. Never infer approval from stating a price alone." },
        negotiation_stopped_by_provider: { type: "boolean", description: "With accept_above_budget true, records that the provider showed frustration or explicitly refused more bargaining (e.g. stop asking, final price). Allows early final approval without exhausting attempts. Do not infer consent from frustration." },
        price_range: { type: "object", properties: {
          min: { type: "number", exclusiveMinimum: 0 }, max: { type: "number", exclusiveMinimum: 0 },
        }, required: ["min", "max"], additionalProperties: false },
      }, required: ["price_range"], additionalProperties: false,
    } as JsonSchema,
  };
  constructor(private readonly service: ProviderQuoteService) { super(); }
  execute(args: unknown, invocation?: ToolInvocation): Promise<unknown> {
    return this.service.execute("create_quote", args, invocation?.toolCallId ?? "", invocation?.evidenceSegmentId);
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
