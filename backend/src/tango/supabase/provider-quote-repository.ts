import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ToolCallScope } from "../../domain/call-flow";
import type { ProviderCommandTarget, ProviderFlowState, ProviderOfferArguments, ProviderOfferResult, ProviderQuoteRepository, ProviderQuoteResult, ProviderQuoteToolName } from "../../domain/provider-quote-service";
import { ToolError, type ToolErrorCode } from "../../domain/tool-error";

const errors: Record<string, [ToolErrorCode, string]> = {
  not_authorized: ["not_authorized", "This provider or call is no longer authorized."],
  invalid_arguments: ["invalid_arguments", "Send only the price min/max, positive and ordered with at most two decimals. A counteroffer must change the price. Do not request payment terms, expiry or conditions."],
  operation_reference_required: ["invalid_arguments", "Choose the exact operation_reference from this provider's available quote requests."],
  operation_not_available: ["operation_not_available", "No available quote request for this operation and provider."],
  intent_locked: ["intent_locked", "This call is locked to another operation or path."],
  invalid_transition: ["invalid_transition", "This quote request is no longer open for a proposal."],
  idempotency_conflict: ["idempotency_conflict", "This invocation ID already belongs to a different command."],
  stale_operation: ["stale_operation", "The operation or quote request changed. Review the refreshed shipment and obtain fresh confirmation. Do not reuse an earlier yes."],
  fixed_terms_conflict: ["fixed_terms_conflict", "Only the numeric price is negotiable. Shipment, currency, pickup, payment, expiry and conditions stay fixed; do not exchange a lower price for changes to those terms. No quote was saved or round consumed. Offer human help for a requested non-price change; never infer or reveal client limits."],
};

export class SupabaseProviderQuoteRepository implements ProviderQuoteRepository {
  constructor(private readonly client: SupabaseClient) {}
  async getState(scope: ToolCallScope): Promise<ProviderFlowState> {
    const { data, error } = await this.client.rpc("get_provider_tool_state", this.context(scope));
    if (error) this.rethrow(error);
    return parseFlowState(data);
  }
  async recordOffer(scope: ToolCallScope, id: string, args: ProviderOfferArguments): Promise<ProviderOfferResult> {
    const { data, error } = await this.client.rpc("record_provider_offer", {
      ...this.context(scope), p_tool_call_id: id, p_arguments: args,
    });
    if (error) this.rethrow(error);
    if (!z.object({ status: z.literal("recorded") }).safeParse(data).success) throw new Error("Provider offer result unavailable");
    return { status: "recorded" };
  }
  async execute(scope: ToolCallScope, name: ProviderQuoteToolName, id: string, args: object,
    target: ProviderCommandTarget | null, evidenceSegmentId?: string): Promise<ProviderQuoteResult> {
    if (evidenceSegmentId) {
      const { error: evidenceError } = await this.client.rpc("stage_provider_quote_evidence", {
        ...this.context(scope), p_tool_call_id: id, p_segment_id: evidenceSegmentId,
      });
      if (evidenceError) this.rethrow(evidenceError);
    }
    const { data, error } = await this.client.rpc("execute_provider_quote_tool", {
      ...this.context(scope), p_tool_name: name, p_tool_call_id: id, p_arguments: args, p_context: target,
    });
    if (error) this.rethrow(error);
    return parseQuoteResult(data);
  }
  private context(scope: ToolCallScope) {
    return { p_call_id: scope.callId, p_realtime_call_id: scope.realtimeCallId, p_provider_id: scope.counterpartyId };
  }
  private rethrow(error: { code?: string; message: string }): never {
    const safe = error.code === "P0001" ? errors[error.message] : undefined;
    if (safe) throw new ToolError(...safe);
    if (["22003", "22007", "22008"].includes(error.code ?? "")) throw new ToolError("invalid_arguments", "A quote number or timestamp is invalid.");
    throw error;
  }
}

const pickupWindowSchema = z.object({ start_at: z.string(), end_at: z.string() });
const operationSchema = z.object({
  operation_reference: z.string(), container_type: z.string().nullable(), gross_weight_kg: z.number().nullable(),
  pickup_location: z.string(), delivery_location: z.string(), empty_return_depot: z.string().nullable(),
  operational_constraints: z.array(z.string()), cargo_notes: z.string().nullable(),
  currency: z.string().nullable().optional(), pickup_window: pickupWindowSchema.nullable().optional(),
});
const targetSchema = z.object({ operation_revision: z.string(), quote_request_id: z.string(), mandate_id: z.string(), round_id: z.string(), previous_quote_id: z.string().nullable() });
const lastQuoteSchema = z.object({
  quote_version: z.number().int(), verdict: z.string(),
  price_range: z.object({ min: z.number(), max: z.number(), currency: z.string() }),
  negotiation_rounds_remaining: z.number().int(),
  fixed_terms: z.object({ proposed_pickup_window: pickupWindowSchema, payment_term_days: z.number().int().nullable(), valid_until: z.string().nullable(), conditions: z.object({ notes: z.array(z.string()).default([]) }).nullable() }).optional(),
});
const lastOfferSchema = z.object({ price_range: z.object({ min: z.number(), max: z.number(), currency: z.string() }) });
const flowStateSchema = z.object({
  flow: z.literal("provider_outbound"), profile: z.enum(["provider_quote", "provider_unavailable", "terminal"]), intent: z.literal("quote"),
  operation: operationSchema.nullable(), commandTarget: targetSchema.nullable(),
  privatePriceLimit: z.object({ price_cap: z.number(), currency: z.string() }).nullable(),
  lastQuote: lastQuoteSchema.nullable(), lastOffer: lastOfferSchema.nullable(),
});
function parseFlowState(value: unknown): ProviderFlowState {
  const parsed = flowStateSchema.safeParse(value);
  if (!parsed.success || (parsed.data.profile === "provider_quote" && (parsed.data.operation === null || parsed.data.commandTarget === null || parsed.data.privatePriceLimit === null))) throw new Error("Provider state unavailable");
  return parsed.data;
}
function parseQuoteResult(value: unknown): ProviderQuoteResult {
  const declined = z.object({ status: z.literal("declined"), commitment_created: z.literal(false) }).safeParse(value);
  if (declined.success) return declined.data;
  const accepted = z.object({ operation_reference: z.string(), quote_version: z.number().int(), verdict: z.enum(["dentro", "contraoferta", "fuera"]), reason_codes: z.array(z.string()), negotiation_remaining: z.boolean(), negotiation_rounds_remaining: z.number().int() }).safeParse(value);
  if (!accepted.success) throw new Error("Provider quote result unavailable");
  return accepted.data;
}
