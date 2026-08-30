export type ToolErrorCode = "invalid_arguments" | "not_authorized" | "tool_unavailable"
  | "intent_locked" | "idempotency_conflict" | "operation_not_available" | "invalid_transition"
  | "stale_operation" | "confirmation_not_ready" | "fixed_terms_conflict";

export class ToolError extends Error {
  constructor(readonly code: ToolErrorCode, message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export function publicToolError(error: unknown): object {
  if (error instanceof ToolError) {
    return { ok: false, code: error.code, error: error.message };
  }
  // Never pass database errors, SQL details, IDs or internal state to the model.
  return {
    ok: false,
    code: "temporarily_unavailable",
    error: "The requested operation could not be completed. Do not assume it succeeded.",
  };
}
