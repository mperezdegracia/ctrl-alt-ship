import { ToolError } from "../../domain/tool-error";
import { RealtimeTool, type JsonSchema } from "./realtime-tool";

const triggers = new Set([
  "explicit_human_request",
  "outside_mandate",
  "negotiation_stalled",
]);

export type MockEscalationRequest = Readonly<{
  operationReference?: string;
  trigger: string;
  reason: string;
}>;

/** Temporary, provider-only bridge used to prove the live Twilio handoff. */
export class MockEscalationTool extends RealtimeTool {
  readonly definition = {
    type: "function" as const,
    name: "escalate",
    description: "Starts the live supervisor handoff for this provider call.",
    parameters: {
      type: "object",
      properties: {
        operation_reference: { type: "string", pattern: "^OP-[0-9]{6,}$" },
        trigger: { type: "string", enum: Array.from(triggers) },
        reason: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["trigger", "reason"],
      additionalProperties: false,
    } as JsonSchema,
  };

  constructor(private readonly begin: (request: MockEscalationRequest) => Promise<void>) { super(); }

  async execute(value: unknown): Promise<unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ToolError("invalid_arguments", "Escalation requires a trigger and concise reason.");
    }
    const argumentsValue = value as Record<string, unknown>;
    const trigger = argumentsValue.trigger;
    const reason = argumentsValue.reason;
    const operationReference = argumentsValue.operation_reference;
    if (typeof trigger !== "string" || !triggers.has(trigger)
      || typeof reason !== "string" || reason.trim().length === 0 || reason.length > 500
      || (operationReference !== undefined && (typeof operationReference !== "string" || !/^OP-[0-9]{6,}$/.test(operationReference)))) {
      throw new ToolError("invalid_arguments", "Escalation requires a valid trigger and concise reason.");
    }
    if (Object.keys(argumentsValue).some((key) => !["operation_reference", "trigger", "reason"].includes(key))) {
      throw new ToolError("invalid_arguments", "Escalation arguments contain an unsupported field.");
    }

    await this.begin({
      operationReference,
      trigger,
      reason: reason.trim(),
    });
    return { status: "started", supervisor_notified: true };
  }
}
