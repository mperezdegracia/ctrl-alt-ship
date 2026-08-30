import type { CreatedEscalation, EscalationService } from "../../domain/escalation-service";
import { ToolError } from "../../domain/tool-error";
import { RealtimeTool, type JsonSchema } from "./realtime-tool";

export type EscalationHandoffPreparation = (escalation: CreatedEscalation) => Promise<boolean>;

/** Opens a durable case before attempting the optional live voice transfer. */
export class EscalationTool extends RealtimeTool {
  readonly definition = {
    type: "function" as const,
    name: "escalate",
    description: "Creates a durable human-review case and, when a recipient is configured, starts the live voice handoff.",
    parameters: {
      type: "object",
      properties: {
        operation_reference: { type: "string", pattern: "^OP-[0-9]{6,}$" },
        trigger: { type: "string", enum: ["explicit_human_request", "outside_mandate", "negotiation_stalled"] },
        reason: { type: "string", minLength: 1, maxLength: 500 },
        summary: { type: "string", minLength: 1, maxLength: 2_000 },
        requested_action: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["trigger", "reason", "summary", "requested_action"],
      additionalProperties: false,
    } as JsonSchema,
  };

  constructor(private readonly service: EscalationService, private readonly prepareHandoff: EscalationHandoffPreparation) { super(); }

  async execute(value: unknown, invocation?: { toolCallId: string }): Promise<unknown> {
    const escalation = await this.service.start(value, invocation?.toolCallId ?? "");
    const handoffReady = escalation.recipient ? await this.prepareHandoff(escalation) : false;
    return {
      status: "started",
      operation_reference: escalation.operationReference,
      handoff_ready: handoffReady,
      handoff_status: escalation.handoffStatus,
    };
  }
}

/** Test-only legacy bridge retained for isolated Realtime SDK harnesses. */
export type MockEscalationRequest = Readonly<{
  operationReference?: string;
  trigger: string;
  reason: string;
}>;

export class MockEscalationTool extends RealtimeTool {
  readonly definition = {
    type: "function" as const,
    name: "escalate",
    description: "Starts a mock live supervisor handoff.",
    parameters: {
      type: "object",
      properties: {
        operation_reference: { type: "string", pattern: "^OP-[0-9]{6,}$" },
        trigger: { type: "string", enum: ["explicit_human_request", "outside_mandate", "negotiation_stalled"] },
        reason: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["trigger", "reason"],
      additionalProperties: false,
    } as JsonSchema,
  };

  constructor(private readonly begin: (request: MockEscalationRequest) => Promise<void>) { super(); }

  async execute(value: unknown): Promise<unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ToolError("invalid_arguments", "Escalation requires a trigger and concise reason.");
    }
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => !["operation_reference", "trigger", "reason"].includes(key))
      || typeof input.trigger !== "string" || !["explicit_human_request", "outside_mandate", "negotiation_stalled"].includes(input.trigger)
      || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 500
      || (input.operation_reference !== undefined && (typeof input.operation_reference !== "string" || !/^OP-[0-9]{6,}$/.test(input.operation_reference)))) {
      throw new ToolError("invalid_arguments", "Escalation requires a valid trigger and concise reason.");
    }
    await this.begin({ operationReference: input.operation_reference as string | undefined, trigger: input.trigger, reason: input.reason.trim() });
    return { status: "started", supervisor_notified: true };
  }
}
