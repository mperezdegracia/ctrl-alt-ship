import { createHash, randomUUID } from "node:crypto";
import type { SessionCreatedEvent, SessionUpdatedEvent, SessionUpdateEvent } from "openai/resources/realtime/realtime";
type DiagnosticFlowState = { profile: string; intent?: string; operation: { operation_reference: string; missing_fields?: string[] } | null };

type LogSink = {
  info(event: string, fields: Record<string, unknown>): void;
  warn(event: string, fields: Record<string, unknown>): void;
};
type Configuration = { tools?: unknown; instructions?: unknown; audio?: { input?: { noise_reduction?: { type?: unknown } | null } } };
type Snapshot = { tools: string[] | null; instructions_sha256: string | null; noise_reduction_type: "far_field" | "near_field" | null };

/** Diagnostic only: never delays responses, changes tools or grants consent. */
export class RealtimeSessionDiagnostics {
  private sequence = 0;
  private expected: Snapshot;
  private profile: string;
  private latestUpdateEventId?: string;
  private received?: Snapshot;

  constructor(private readonly logger: LogSink, initial: Configuration, profile: string) {
    this.expected = this.snapshot(initial);
    this.profile = profile;
  }

  get serverTools(): string[] | null { return this.received?.tools ? [...this.received.tools] : null; }

  prepareUpdate(update: SessionUpdateEvent, state: DiagnosticFlowState | undefined, toolCallId: string): SessionUpdateEvent {
    this.sequence += 1;
    this.latestUpdateEventId = `session_update_${randomUUID()}`;
    this.expected = this.snapshot(update.session);
    this.profile = state?.profile ?? "read_only";
    this.logger.info("realtime.session_update_requested", {
      update_sequence: this.sequence, update_event_id: this.latestUpdateEventId,
      tool_call_id: toolCallId, profile: this.profile,
      operation_reference: state?.operation?.operation_reference,
      missing_fields: state?.operation?.missing_fields,
      ...this.expected,
    });
    return { ...update, event_id: this.latestUpdateEventId };
  }

  observe(event: SessionCreatedEvent | SessionUpdatedEvent): void {
    this.received = this.snapshot(event.session);
    const toolsMatch = this.received.tools === null || this.expected.tools === null
      ? null : JSON.stringify([...this.received.tools].sort()) === JSON.stringify([...this.expected.tools].sort());
    const instructionsMatch = this.received.instructions_sha256 === null || this.expected.instructions_sha256 === null
      ? null : this.received.instructions_sha256 === this.expected.instructions_sha256;
    const fields = {
      server_event_id: event.event_id,
      // session.updated does NOT echo the client event ID. Compare observed
      // configuration to the latest request; do not claim an exact ACK pairing.
      comparison_basis: "latest_requested_configuration",
      latest_update_sequence: this.sequence,
      latest_update_event_id: this.latestUpdateEventId,
      expected_profile: this.profile,
      expected_tools: this.expected.tools,
      received_tools: this.received.tools,
      tools_match: toolsMatch,
      instructions_match: instructionsMatch,
      received_instructions_sha256: this.received.instructions_sha256,
      received_noise_reduction_type: this.received.noise_reduction_type,
    };
    this.logger.info(event.type === "session.created" ? "realtime.session_created" : "realtime.session_updated", fields);
    if (toolsMatch === false || instructionsMatch === false) {
      this.logger.warn("realtime.session_configuration_mismatch", fields);
    }
  }

  private snapshot(value: unknown): Snapshot {
    const config: Configuration = value && typeof value === "object" ? value : {};
    const noiseReduction = config.audio?.input?.noise_reduction?.type;
    return {
      noise_reduction_type: noiseReduction === "far_field" || noiseReduction === "near_field" ? noiseReduction : null,
      // Whitelist names only. Never log schemas, MCP headers, arguments, or the
      // full session/instructions, which can contain personal/commercial data.
      tools: Array.isArray(config.tools) ? config.tools.map((tool: unknown) => {
        if (!tool || typeof tool !== "object") return "<unknown>";
        const value = tool as { type?: unknown; name?: unknown };
        return value.type === "function" && typeof value.name === "string" ? value.name : "<non-function>";
      }) : null,
      instructions_sha256: typeof config.instructions === "string"
        ? createHash("sha256").update(config.instructions).digest("hex") : null,
    };
  }
}
