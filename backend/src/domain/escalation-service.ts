import type { ToolCallScope } from "./operation-read-service";
import { ToolError } from "./tool-error";

const triggers = new Set([
  "explicit_human_request",
  "outside_mandate",
  "negotiation_stalled",
]);

export type EscalationRequest = Readonly<{
  operationReference?: string;
  trigger: "explicit_human_request" | "outside_mandate" | "negotiation_stalled";
  reason: string;
  summary: string;
  requestedAction: string;
}>;

export type CreatedEscalation = Readonly<{
  escalationId: string;
  operationReference: string;
  handoffStatus: "pending" | "not_configured";
  recipient: Readonly<{
    id: string;
    name: string;
    phone: string;
    role: "supervisor" | "operator";
  }> | null;
}>;

export interface EscalationRepository {
  create(scope: ToolCallScope, request: EscalationRequest, toolCallId: string): Promise<CreatedEscalation>;
  cancel(scope: ToolCallScope, escalationId: string): Promise<void>;
}

/** Persists an escalation before any telephony transfer begins. */
export class EscalationService {
  private readonly scope: ToolCallScope;

  constructor(scope: ToolCallScope, private readonly repository: EscalationRepository) {
    this.scope = Object.freeze({ ...scope });
  }

  async start(value: unknown, toolCallId: string): Promise<CreatedEscalation> {
    if (!toolCallId.trim()) this.invalid();
    const request = this.request(value);
    return this.repository.create(this.scope, request, toolCallId);
  }

  async cancel(escalationId: string): Promise<void> {
    await this.repository.cancel(this.scope, escalationId);
  }

  private request(value: unknown): EscalationRequest {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) this.invalid();
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => !["operation_reference", "trigger", "reason", "summary", "requested_action"].includes(key))) {
      this.invalid();
    }
    const operationReference = input.operation_reference;
    if (operationReference !== undefined && (typeof operationReference !== "string" || !/^OP-[0-9]{6,}$/.test(operationReference))) {
      this.invalid();
    }
    const trigger = input.trigger;
    if (typeof trigger !== "string" || !triggers.has(trigger)) this.invalid();
    const reason = this.text(input.reason, 500);
    const summary = this.text(input.summary, 2_000);
    const requestedAction = this.text(input.requested_action, 500);
    return {
      operationReference: operationReference as string | undefined,
      trigger: trigger as EscalationRequest["trigger"],
      reason,
      summary,
      requestedAction,
    };
  }

  private text(value: unknown, maximum: number): string {
    if (typeof value !== "string" || !value.trim() || value.length > maximum) this.invalid();
    return value.trim();
  }

  private invalid(): never {
    throw new ToolError("invalid_arguments", "Escalation requires the verified operation when known, a valid trigger, a concise reason, a factual handoff summary and the specific human decision requested.");
  }
}
