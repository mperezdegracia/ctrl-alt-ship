import { ProviderQuoteService } from "../../domain/provider-quote-service";
import { RealtimeTool, type JsonSchema, type ToolInvocation } from "./realtime-tool";

export class RecordProviderQuoteTool extends RealtimeTool {
  readonly definition = {
    type: "function" as const,
    name: "record_provider_quote",
    description: "Records the provider's complete quote only after the provider explicitly confirms the read-back. The server evaluates it against the client mandate and may authorize one counteroffer without exposing that mandate.",
    parameters: {
      type: "object", properties: {
        price_min: { type: "number", exclusiveMinimum: 0, multipleOf: 0.01 },
        price_max: { type: "number", exclusiveMinimum: 0, multipleOf: 0.01 },
        currency: { type: "string", pattern: "^[A-Z]{3}$" },
        pickup_window: { type: "object", properties: { start_at: { type: "string", format: "date-time" }, end_at: { type: "string", format: "date-time" } }, required: ["start_at", "end_at"], additionalProperties: false },
        payment_term_days: { type: "integer", minimum: 0 },
        valid_until: { type: "string", format: "date-time" },
        conditions: { type: "object", additionalProperties: true },
      }, required: ["price_min", "price_max", "currency", "pickup_window", "payment_term_days", "valid_until", "conditions"], additionalProperties: false,
    } as JsonSchema,
  };

  constructor(private readonly service: ProviderQuoteService) { super(); }
  execute(args: unknown, invocation?: ToolInvocation): Promise<unknown> { return this.service.record(args, invocation?.toolCallId ?? ""); }
}
