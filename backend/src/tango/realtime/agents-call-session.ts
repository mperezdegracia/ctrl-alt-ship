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

function isHandoffReady(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && !Array.isArray(result)
    && ((result as Record<string, unknown>).handoff_ready === true
      // Isolated legacy harnesses still use the old in-memory tool. Runtime
      // escalation results only set handoff_ready after a durable recipient is resolved.
      || (result as Record<string, unknown>).supervisor_notified === true));
}

/** SDK SIP transport with diagnostics and an explicit empty-tools compatibility fix. */
class ObservedSIPTransport extends OpenAIRealtimeSIP {
  constructor(options: OpenAIRealtimeWebSocketOptions,
    private readonly observe: (event: RealtimeClientMessage) => RealtimeClientMessage,
    private readonly handoffConfirmed: () => boolean) {
    super(options);
  }

  override interrupt(cancelOngoingResponse = true): void {
    // The WebSocket SDK also interrupts locally on speech_started, even when
    // server interrupt_response is false. Protect both sides of the SIP call.
    if (!this.handoffConfirmed()) super.interrupt(cancelOngoingResponse);
  }

  override sendEvent(event: RealtimeClientMessage): void {
    super.sendEvent(this.observe(event));
  }

  override buildSessionPayload(config: Partial<RealtimeSessionConfig>): RealtimeSessionPayload {
    const payload = super.buildSessionPayload(config);
    // SDK 0.17 omits tools for []; omission leaves previous server tools active.
    if (config.tools?.length === 0) payload.tools = [];
    if (this.handoffConfirmed()) {
      payload.tools = [];
      payload.tool_choice = "none";
      payload.audio = { ...payload.audio, input: { ...payload.audio?.input,
        turn_detection: { type: "server_vad", create_response: false, interrupt_response: false },
      } };
    }
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
  private readonly evidenceByToolCall = new Map<string, string>();
  private latestCallerTranscriptSegmentId: string | undefined;
  private readonly factory = new RealtimeSessionFactory();
  private updateToolCallId = "sdk_connect";
  private escalationReady = false;
  private handoffConfirmed = false;

  constructor(
    private readonly decision: AcceptedRoutingDecision,
    private readonly tools: CallToolSession,
    private readonly logger: LogSink,
    private readonly hooks: Hooks = {},
    transportOptions: OpenAIRealtimeWebSocketOptions = {},
  ) {
    const initial = this.factory.create(decision, tools.definitions, tools.flowState, tools.providerFlowState);
    this.diagnostics = new RealtimeSessionDiagnostics(logger, initial, tools.profile);
    this.transport = new ObservedSIPTransport(transportOptions, (event) => {
      if (event.type !== "session.update" || !("tools" in event.session || "instructions" in event.session)) return event;
      const provider = tools.providerFlowState;
      const state = tools.flowState ?? (provider ? {
        profile: provider.profile, intent: provider.intent,
        operation: provider.flow === "provider_inbound" ? provider.selectedBooking?.operation ?? null : provider.operation,
      } : undefined);
      return this.diagnostics.prepareUpdate(event as SessionUpdateEvent, state, this.updateToolCallId);
    }, () => this.handoffConfirmed);
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
          input: {
            noiseReduction: initial.audio.input.noise_reduction,
            transcription: initial.audio.input.transcription,
            turnDetection: initial.audio.input.turn_detection,
          },
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
      this.logger.info("realtime.agent_tool_ended", {
        tool_name: invokedTool.name,
        escalation_ready: this.escalationReady,
      });
      if (invokedTool.name === "confirm_escalation" && this.escalationReady) {
        this.escalationReady = false;
        this.logger.info("escalation.farewell_requested");
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
        this.evidenceByToolCall.clear();
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
      this.transport.requestResponse({ instructions: this.initialGreetingInstruction() });
    } catch (error) {
      this.session.close();
      throw error;
    }
  }

  /** Associates the next provider quote command with its server-persisted caller utterance. */
  recordCallerTranscriptSegment(segmentId: string): void {
    this.latestCallerTranscriptSegmentId = segmentId;
  }

  private initialGreetingInstruction(): string {
    if (this.decision.outbound && this.decision.identity.persona === "provider") {
      return "Start this outbound call in English. First say briefly that this call is recorded and transcribed for operational purposes. Then say that you are Tango calling to request a price quote for the verified selected operation, including its route and pickup window. Do not say or imply the client price cap or any private mandate term. Ask whether they can quote it, then wait. Do not call tools in this greeting.";
    }
    return 'Start this call in English. Say: "Hi, this is Tango, your logistics assistant. This call is recorded and transcribed for operational purposes. How can I help you today?" Then wait for the caller. Do not call any tools in this greeting.';
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
    let evidenceSegmentId: string | undefined;
    if (name === "create_quote") {
      evidenceSegmentId = this.evidenceByToolCall.get(toolCallId) ?? this.latestCallerTranscriptSegmentId;
      if (evidenceSegmentId) this.evidenceByToolCall.set(toolCallId, evidenceSegmentId);
    }
    this.logger.info("tool.requested", {
      tool_name: name, tool_call_id: toolCallId, response_id: responseId,
      profile: this.tools.profile,
      advertised_tools: this.tools.definitions.map((definition) => definition.name),
      server_tools: this.diagnostics.serverTools,
      evidence_segment_present: Boolean(evidenceSegmentId),
    });
    let result: unknown;
    let succeeded = false;
    try {
      if (this.handoffConfirmed) {
        throw new ToolError("invalid_transition", "The caller already confirmed the live transfer. No further actions are available in Tango.");
      }
      result = await this.tools.execute(name, args, { toolCallId, evidenceSegmentId });
      succeeded = true;
      if (name !== "escalate") this.hooks.onProgress?.();
      this.logger.info("tool.completed", {
        tool_name: name, tool_call_id: toolCallId, result,
        profile_before: this.tools.profile,
      });
    } catch (error) {
      result = publicToolError(error);
      this.logger.error("tool.failed", {
        tool_name: name, tool_call_id: toolCallId,
        argument_fields: args && typeof args === "object" ? Object.keys(args) : [],
        profile: this.tools.profile, error, public_result: result,
      });
    }

    let refreshFailed = false;
    try { await this.tools.refresh(); } catch (error) {
      refreshFailed = true;
      // A mutation might already be committed. Keep its result, remove tools.
      this.logger.error("tool.profile_refresh_failed", {
        tool_name: name, tool_call_id: toolCallId, result, error,
      });
    }
    const escalation = succeeded && name === "confirm_escalation" && isHandoffReady(result) && Boolean(this.hooks.onEscalationReady);
    // The SDK may emit agent_tool_end while updateAgent is flushing the tool
    // result. Arm the one-shot callback before that await, not after it.
    this.escalationReady = escalation;
    if (escalation) this.handoffConfirmed = true;
    // While review is pending only its confirm/cancel controls are available.
    // Cancellation refreshes the original domain profile, never an old snapshot
    // of permissions or operational data.
    this.agent.tools = refreshFailed || this.handoffConfirmed ? [] : this.buildTools();
    this.agent.instructions = this.handoffConfirmed
      ? "The caller confirmed the live transfer. Say only the requested short farewell in the caller's language, then remain silent. Do not ask for confirmation again, offer to return to Tango, or claim a human has answered. The server will request the transfer after the farewell audio finishes."
      : refreshFailed
      ? "No further actions are available. Explain the actual tool result briefly in the caller's language and close the conversation. A successful write remains committed; do not claim it was rolled back or retry it. Do not claim a human transfer unless the result explicitly says handoff_ready."
      : this.tools.escalationPending
        ? `You are Tango. Continue in the caller's active language. A human review is pending. No operation changes are authorized in this step. Never reveal private client mandate limits or another provider's prices. Do not invent approvals or claim an out-of-mandate request was accepted.
Ask whether they want the human transfer now or prefer to go back and continue with Tango, then WAIT for their answer. Never call confirm_escalation in the same turn as escalate.
If the caller says "volver atrás", "seguir con vos", "cancel the transfer", changes their mind or asks to return, call cancel_escalation. This cancels only the handoff, never the shipment or booking. After success resume the previous flow using the preserved conversation and verified state; do not ask for already recorded information. Returning does not authorize requests outside the mandate.
Only after an explicit yes to the transfer call confirm_escalation. This commits the live transfer: the short farewell is protected from voice interruptions and no second confirmation is needed. Before confirmation the caller may still cancel and return to Tango. Never claim a human has answered merely because the transfer was confirmed.
If handoff_ready is false, explain that no live transfer is available: the review remains open for follow-up, or they may cancel it and continue with Tango. If cancellation fails, do not claim it succeeded.`
        : this.factory.create(this.decision, [], this.tools.flowState, this.tools.providerFlowState).instructions;
    this.updateToolCallId = toolCallId;
    try {
      // Same agent identity preserves the SDK's in-flight/replay bookkeeping.
      // Await local configuration before the SDK sends the result/next response.
      await this.session.updateAgent(this.agent);
    } catch (error) {
      this.escalationReady = false;
      this.logger.error("tool.session_update_failed", { tool_call_id: toolCallId, error });
      // Cannot safely continue with stale tools after a committed mutation.
      this.session.close();
      return backgroundResult(result);
    }
    return escalation ? backgroundResult(result) : result;
  }
}
