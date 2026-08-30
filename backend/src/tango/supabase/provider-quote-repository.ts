import type { SupabaseClient } from "@supabase/supabase-js";
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
    if (!data || data.flow !== "provider_outbound"
      || !["provider_quote", "provider_unavailable", "terminal"].includes(data.profile)
      || data.intent !== "quote" || !("operation" in data) || !("commandTarget" in data)) throw new Error("Invalid provider outbound tool state");
    return data as ProviderFlowState;
  }
  async recordOffer(scope: ToolCallScope, id: string, args: ProviderOfferArguments): Promise<ProviderOfferResult> {
    const { data, error } = await this.client.rpc("record_provider_offer", {
      ...this.context(scope), p_tool_call_id: id, p_arguments: args,
    });
    if (error) this.rethrow(error);
    if (!data) throw new Error("Missing provider offer result");
    return data as ProviderOfferResult;
  }
  async execute(scope: ToolCallScope, name: ProviderQuoteToolName, id: string, args: object, target: ProviderCommandTarget | null): Promise<ProviderQuoteResult> {
    const { data, error } = await this.client.rpc("execute_provider_quote_tool", {
      ...this.context(scope), p_tool_name: name, p_tool_call_id: id, p_arguments: args, p_context: target,
    });
    if (error) this.rethrow(error);
    if (!data) throw new Error("Missing provider quote result");
    return data as ProviderQuoteResult;
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
