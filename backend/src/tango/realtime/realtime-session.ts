import {
  RoutingInstructionsBuilder,
  type AcceptedRoutingDecision,
} from "../agents/routing-instructions";
import type { RealtimeFunctionToolDefinition } from "../tools/realtime-tool";
import type { ClientFlowState } from "../../domain/client-operation-service";
import type { SessionUpdateEvent } from "openai/resources/realtime/realtime";
import type { ProviderFlowState } from "../../domain/provider-quote-service";

export type RealtimeSessionConfiguration = {
  type: "realtime";
  model: "gpt-realtime-2.1";
  output_modalities: ["audio"];
  reasoning: { effort: "low" };
  audio: {
    input: {
      noise_reduction: { type: "far_field" };
      transcription: { model: "gpt-transcribe" };
      turn_detection: { type: "server_vad"; create_response: true; interrupt_response: true };
    };
    output: {
      voice: "cedar";
      speed: 1.2;
    };
  };
  instructions: string;
  tools: RealtimeFunctionToolDefinition[];
  tool_choice: "auto";
  parallel_tool_calls: false;
};

export class RealtimeSessionFactory {
  create(
    decision: AcceptedRoutingDecision,
    tools: RealtimeFunctionToolDefinition[],
    flowState?: ClientFlowState,
    providerState?: ProviderFlowState,
  ): RealtimeSessionConfiguration {
    return {
      type: "realtime",
      model: "gpt-realtime-2.1",
      output_modalities: ["audio"],
      reasoning: { effort: "low" },
      audio: {
        input: {
          noise_reduction: { type: "far_field" },
          transcription: { model: "gpt-transcribe" },
          turn_detection: { type: "server_vad", create_response: true, interrupt_response: true },
        },
        output: {
          voice: "cedar",
          speed: 1.2,
        },
      },
      instructions: new RoutingInstructionsBuilder(decision, flowState, providerState).build(),
      tools,
      tool_choice: "auto",
      parallel_tool_calls: false,
    };
  }

  createFlowUpdate(
    decision: AcceptedRoutingDecision,
    tools: RealtimeFunctionToolDefinition[],
    flowState?: ClientFlowState,
    providerState?: ProviderFlowState,
  ): SessionUpdateEvent {
    return {
      type: "session.update",
      session: {
        type: "realtime",
        tools,
        instructions: new RoutingInstructionsBuilder(decision, flowState, providerState).build(),
      },
    };
  }
}
