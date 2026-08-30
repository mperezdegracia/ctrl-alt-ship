import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClientCommandContext, ClientFlowState, ClientMutationResult, ClientOperationRepository, ClientToolName } from "../../domain/client-operation-service";
import type { ToolCallScope } from "../../domain/operation-read-service";
import { ToolError, type ToolErrorCode } from "../../domain/tool-error";

const publicErrors: Record<string, [ToolErrorCode, string]> = {
  not_authorized: ["not_authorized", "This call or caller is no longer authorized."],
  invalid_arguments: ["invalid_arguments", "The operation fields are invalid; review the tool schema."],
  intent_locked: ["intent_locked", "This call is already locked to another path or operation. Do not switch paths."],
  idempotency_conflict: ["idempotency_conflict", "This tool call was already used with different arguments; do not retry it with changed values."],
  operation_reference_required: ["invalid_arguments", "Choose an operation_reference from the client's available operations first."],
  operation_not_available: ["operation_not_available", "That operation is not available to this caller."],
  invalid_transition: ["invalid_transition", "The operation cannot be changed in its current state."],
  stale_operation: ["stale_operation", "The operation changed after the last summary. Read the refreshed details and obtain a new explicit confirmation."],
  // Compatibility with the old RPC during rollout; never loop asking for audio evidence.
  confirmation_not_ready: ["confirmation_not_ready", "Mandate confirmation is temporarily unavailable. Do not repeatedly retry or claim it succeeded."],
};

export class SupabaseClientOperationRepository implements ClientOperationRepository {
  constructor(private readonly client: SupabaseClient) {}

  async getState(scope: ToolCallScope): Promise<ClientFlowState> {
    const { data, error } = await this.client.rpc("get_client_operation_tool_state", this.context(scope));
    if (error) this.rethrow(error);
    if (!data || !["client_entry", "client_create", "client_update", "client_confirm", "terminal"].includes(data.profile)) {
      throw new Error("Invalid client flow state returned by database");
    }
    return data as ClientFlowState;
  }

  async execute(scope: ToolCallScope, toolName: ClientToolName, toolCallId: string, args: object, context?: ClientCommandContext): Promise<ClientMutationResult> {
    const rpc = toolName === "cancel_operation" ? "execute_client_cancellation_tool" : "execute_client_operation_tool";
    const { data, error } = await this.client.rpc(rpc, {
      ...this.context(scope), p_tool_call_id: toolCallId, p_tool_name: toolName, p_arguments: args,
      ...(context ? { p_context: context } : {}),
    });
    if (error) this.rethrow(error);
    if (!data) throw new Error("Missing client tool result");
    return data as ClientMutationResult;
  }

  private context(scope: ToolCallScope) {
    return { p_call_id: scope.callId, p_realtime_call_id: scope.realtimeCallId, p_contact_id: scope.counterpartyId };
  }

  private rethrow(error: { code?: string; message: string }): never {
    const safe = error.code === "P0001" ? publicErrors[error.message] : undefined;
    if (safe) throw new ToolError(...safe);
    if (error.code === "22003") throw new ToolError("invalid_arguments", "A numeric value exceeds the supported precision or range.");
    throw error;
  }
}
