import type { SupabaseClient } from "@supabase/supabase-js";

import type { CreatedEscalation, EscalationRepository, EscalationRequest } from "../../domain/escalation-service";
import type { ToolCallScope } from "../../domain/operation-read-service";
import { ToolError, type ToolErrorCode } from "../../domain/tool-error";

const errors: Record<string, [ToolErrorCode, string]> = {
  invalid_arguments: ["invalid_arguments", "The handoff brief is incomplete. State the exact issue, verified context and the decision the human must make."],
  not_authorized: ["not_authorized", "This call is no longer authorized to open an escalation."],
  operation_reference_required: ["invalid_arguments", "Choose the exact operation reference before escalating this call."],
  operation_not_available: ["operation_not_available", "That operation is not available in this call."],
  intent_locked: ["intent_locked", "This call is already linked to a different operation."],
  idempotency_conflict: ["idempotency_conflict", "This escalation request was already used with different details."],
};

type EscalationResult = {
  escalation_id: string;
  operation_reference: string;
  handoff_status: "pending" | "not_configured";
  recipient_id: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  recipient_role: "supervisor" | "operator" | null;
};

export class SupabaseEscalationRepository implements EscalationRepository {
  constructor(private readonly client: SupabaseClient) {}

  async create(scope: ToolCallScope, request: EscalationRequest, toolCallId: string): Promise<CreatedEscalation> {
    const { data, error } = await this.client.rpc("create_call_escalation", {
      p_call_id: scope.callId,
      p_realtime_call_id: scope.realtimeCallId,
      p_counterparty_id: scope.counterpartyId,
      p_operation_reference: request.operationReference ?? null,
      p_trigger: request.trigger,
      p_reason: request.reason,
      p_summary: request.summary,
      p_requested_action: request.requestedAction,
      p_tool_call_id: toolCallId,
    });
    if (error) this.rethrow(error);
    const result = data as EscalationResult | null;
    if (!result || typeof result.escalation_id !== "string" || typeof result.operation_reference !== "string"
      || (result.handoff_status !== "pending" && result.handoff_status !== "not_configured")) {
      throw new Error("Invalid escalation result");
    }
    const recipient = result.recipient_id && result.recipient_name && result.recipient_phone
      && (result.recipient_role === "supervisor" || result.recipient_role === "operator")
      ? { id: result.recipient_id, name: result.recipient_name, phone: result.recipient_phone, role: result.recipient_role }
      : null;
    return {
      escalationId: result.escalation_id,
      operationReference: result.operation_reference,
      handoffStatus: result.handoff_status,
      recipient,
    };
  }

  private rethrow(error: { code?: string; message: string }): never {
    const safe = error.code === "P0001" ? errors[error.message] : undefined;
    if (safe) throw new ToolError(...safe);
    throw error;
  }
}
