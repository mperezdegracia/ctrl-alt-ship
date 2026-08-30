import {
  backgroundResult, OpenAIRealtimeSIP, RealtimeAgent, RealtimeSession, tool,
  type FunctionTool, type OpenAIRealtimeWebSocketOptions, type RealtimeClientMessage,
  type RealtimeSessionOptions, type RealtimeSessionConfig, type RealtimeSessionPayload,
} from "@openai/agents/realtime";
import type { CallAcceptParams } from "openai/resources/realtime/calls";
import type { ToolInputParameters } from "@openai/agents";
import type { RealtimeServerEvent, SessionUpdateEvent } from "openai/resources/realtime/realtime";
import { publicToolError, ToolError } from "../../domain/tool-error";
import type { StructuredLogger } from "../../observability/logger";
import type { AcceptedRoutingDecision } from "../agents/routing-instructions";
import type { CallToolSession } from "../tools/call-tool-session";
import { RealtimeSessionFactory } from "./realtime-session";
import { RealtimeSessionDiagnostics } from "./realtime-session-diagnostics";

type LogSink = Pick<StructuredLogger, "info" | "warn" | "error" | "debug">;
type Hooks = {
  onProgress?: () => void;
  onEscalationReady?: () => void;
};

/** SDK SIP transport with diagnostics and an explicit empty-tools compatibility fix. */
class ObservedSIPTransport extends OpenAIRealtimeSIP {
  constructor(options: OpenAIRealtimeWebSocketOptions, private readonly observe: (event: RealtimeClientMessage) => RealtimeClientMessage) {
    super(options);
  }

  override sendEvent(event: RealtimeClientMessage): void {
    super.sendEvent(this.observe(event));
  }

  override buildSessionPayload(config: Partial<RealtimeSessionConfig>): RealtimeSessionPayload {
    const payload = super.buildSessionPayload(config);
    // SDK 0.17 omits tools for []; omission leaves previous server tools active.
    if (config.tools?.length === 0) payload.tools = [];
    return payload;
  }
}

/** One SDK session per authenticated SIP call. Domain permissions stay server-owned. */
export class AgentsCallSession {
  readonly session: RealtimeSession;
  readonly transport: OpenAIRealtimeSIP;
  private readonly agent: RealtimeAgent;
  private readonly options: Partial<RealtimeSessionOptions>;
  private readonly diagnostics: RealtimeSessionDiagnostics;
  private readonly sdkTools = new Map<string, FunctionTool<unknown, ToolInputParameters>>();
  private readonly responseByToolCall = new Map<string, string>();
  private readonly factory = new RealtimeSessionFactory();
  private updateToolCallId = "sdk_connect";
  private escalationReady = false;

  constructor(
    private readonly decision: AcceptedRoutingDecision,
    private readonly tools: CallToolSession,
    private readonly logger: LogSink,
    private readonly hooks: Hooks = {},
    transportOptions: OpenAIRealtimeWebSocketOptions = {},
  ) {
    const initial = this.factory.create(decision, tools.definitions, tools.flowState);
    this.diagnostics = new RealtimeSessionDiagnostics(logger, initial, tools.flowState?.profile ?? "read_only");
    this.transport = new ObservedSIPTransport(transportOptions, (event) => event.type === "session.update"
      && ("tools" in event.session || "instructions" in event.session)
      ? this.diagnostics.prepareUpdate(event as SessionUpdateEvent, tools.flowState, this.updateToolCallId)
      : event);
    this.agent = new RealtimeAgent({
      name: `Tango ${decision.identity.persona}`, voice: initial.audio.output.voice,
      instructions: initial.instructions, tools: this.buildTools(),
    });
    this.options = {
      model: initial.model,
      // Do not enable new external transcript tracing implicitly during a migration.
      tracingDisabled: true, historyStoreAudio: false,
      config: {
        outputModalities: initial.output_modalities, reasoning: initial.reasoning,
        audio: {
          input: { transcription: initial.audio.input.transcription, turnDetection: initial.audio.input.turn_detection },
          output: initial.audio.output,
        },
        toolChoice: "auto", parallelToolCalls: false,
      },
    };
    this.session = new RealtimeSession(this.agent, { ...this.options, transport: this.transport });
    this.session.on("transport_event", (event) => {
      // Observe configuration only; SDK owns tools, audio and history.
      const message = event as RealtimeServerEvent;
      if (message.type === "session.created" || message.type === "session.updated") this.diagnostics.observe(message);
      if ((message.type === "response.output_item.done" || message.type === "response.output_item.added")
        && message.item.type === "function_call" && message.item.call_id) {
        this.responseByToolCall.set(message.item.call_id, message.response_id);
        if (this.responseByToolCall.size > 128) this.responseByToolCall.delete(this.responseByToolCall.keys().next().value!);
      }
    });
    this.session.on("agent_tool_end", (_context, _agent, invokedTool) => {
      // backgroundResult makes the SDK send the result without an automatic
      // response; only then ask for the existing supervisor farewell.
      if (invokedTool.name === "escalate" && this.escalationReady) {
        this.escalationReady = false;
        this.hooks.onEscalationReady?.();
      }
    });
    this.session.on("history_updated", (history) => logger.debug("realtime.history_updated", { items: history.length }));
    this.session.on("audio_interrupted", () => logger.debug("audio.interrupted"));
    this.session.on("audio_stopped", () => logger.debug("audio.generation_stopped"));
    this.session.on("error", ({ error }) => logger.error("realtime.error", { error }));
    this.transport.on("connection_change", (status) => {
      logger.info(`realtime.sideband_${status}`);
      if (status === "disconnected") {
        this.responseByToolCall.clear();
      }
    });
  }

  async initialConfiguration(): Promise<CallAcceptParams> {
    // Same SDK agent/options for calls.accept and connect: no second tool list.
    // The SDK payload allows additional audio formats; SIP validates its subset.
    const payload = await OpenAIRealtimeSIP.buildInitialConfig(this.agent, this.options);
    if (this.agent.tools.length === 0) payload.tools = [];
    return payload as CallAcceptParams;
  }

  async connect(callId: string, apiKey: string): Promise<void> {
    try {
      await this.session.connect({ callId, apiKey });
      this.transport.requestResponse({ instructions: 'Start this call in English. Say: "Hi, this is Tango, your logistics assistant. How can I help you today?" Then wait for the caller. Do not call any tools in this greeting.' });
    } catch (error) {
      this.session.close();
      throw error;
    }
  }

  private buildTools(): FunctionTool<unknown, ToolInputParameters>[] {
    return this.tools.definitions.map((definition) => {
      let wrapped = this.sdkTools.get(definition.name);
      if (!wrapped) {
        wrapped = tool({
          name: definition.name, description: definition.description,
          parameters: { ...definition.parameters, additionalProperties: true }, strict: false,
          // No needsApproval: the agent interprets verbal confirmation;
          // the atomic domain transaction validates data and state.
          execute: async (args, _context, details) => {
            const toolCallId = details?.toolCall?.callId;
            if (!toolCallId) throw new ToolError("invalid_arguments", "Missing server tool call identifier.");
            return this.execute(definition.name, args, toolCallId);
          },
          errorFunction: (_context, error) => JSON.stringify(publicToolError(error)),
        });
        // SDK 0.17's helper types couple strict:false to additionalProperties:true.
        // Restore our closed, partial-update schema before exposing the tool.
        // Domain/SQL validation rejects extra fields; the SDK parser remains non-strict.
        wrapped.parameters = definition.parameters;
        this.sdkTools.set(definition.name, wrapped);
      }
      return wrapped;
    });
  }

  private async execute(name: string, args: unknown, toolCallId: string): Promise<unknown> {
    const responseId = this.responseByToolCall.get(toolCallId) ?? "";
    this.logger.info("tool.requested", {
      tool_name: name, tool_call_id: toolCallId, response_id: responseId,
      profile: this.tools.flowState?.profile ?? "read_only",
      advertised_tools: this.tools.definitions.map((definition) => definition.name),
      server_tools: this.diagnostics.serverTools,
    });
    let result: unknown;
    let succeeded = false;
    try {
      result = await this.tools.execute(name, args, { toolCallId });
      succeeded = true;
      if (name !== "escalate") this.hooks.onProgress?.();
      this.logger.info("tool.completed", { tool_name: name, tool_call_id: toolCallId });
    } catch (error) {
      this.logger.error("tool.failed", { tool_name: name, tool_call_id: toolCallId, error });
      result = publicToolError(error);
    }

    try { await this.tools.refresh(); } catch (error) {
      // A mutation might already be committed. Keep its result, remove tools.
      this.logger.error("tool.profile_refresh_failed", { error });
    }
    const escalation = succeeded && name === "escalate" && Boolean(this.hooks.onEscalationReady);
    this.agent.tools = escalation ? [] : this.buildTools();
    this.agent.instructions = this.factory.create(this.decision, [], this.tools.flowState).instructions;
    this.updateToolCallId = toolCallId;
    try {
      // Same agent identity preserves the SDK's in-flight/replay bookkeeping.
      // Await local configuration before the SDK sends the result/next response.
      await this.session.updateAgent(this.agent);
    } catch (error) {
      this.logger.error("tool.session_update_failed", { tool_call_id: toolCallId, error });
      // Cannot safely continue with stale tools after a committed mutation.
      this.session.close();
      return backgroundResult(result);
    }
    this.escalationReady = escalation;
    return escalation ? backgroundResult(result) : result;
  }
}
