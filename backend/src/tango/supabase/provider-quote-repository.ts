import type { SupabaseClient } from "@supabase/supabase-js";

import type { ProviderQuoteArgs, ProviderQuoteRepository } from "../../domain/provider-quote-service";
import type { ToolCallScope } from "../../domain/operation-read-service";
import { ToolError, type ToolErrorCode } from "../../domain/tool-error";

const errors: Record<string, [ToolErrorCode, string]> = {
  not_authorized: ["not_authorized", "This call is not authorized to record a quote."],
  invalid_arguments: ["invalid_arguments", "The quote fields are invalid or its validity time has passed."],
  invalid_transition: ["invalid_transition", "There is no active quote request for this call."],
};

export class SupabaseProviderQuoteRepository implements ProviderQuoteRepository {
  constructor(private readonly client: SupabaseClient) {}

  async record(scope: ToolCallScope, toolCallId: string, args: ProviderQuoteArgs): Promise<unknown> {
    const { data, error } = await this.client.rpc("record_provider_quote", {
      p_call_id: scope.callId, p_realtime_call_id: scope.realtimeCallId,
      p_provider_id: scope.counterpartyId, p_tool_call_id: toolCallId, p_arguments: args,
    });
    if (error) {
      const mapped = error.code === "P0001" ? errors[error.message] : undefined;
      if (mapped) throw new ToolError(...mapped);
      throw error;
    }
    return data;
  }
}
