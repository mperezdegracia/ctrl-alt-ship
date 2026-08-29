import {
  RoutingInstructionsBuilder,
  type AcceptedRoutingDecision,
} from "../agents/routing-instructions";
import type { RealtimeFunctionToolDefinition } from "../tools/realtime-tool";

export type RealtimeSessionConfiguration = {
  type: "realtime";
  model: "gpt-realtime-2.1";
  output_modalities: ["audio"];
  reasoning: { effort: "low" };
  audio: {
    input: {
      transcription: { model: "gpt-transcribe" };
    };
    output: {
      voice: "cedar";
      speed: 1.05;
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
  ): RealtimeSessionConfiguration {
    return {
      type: "realtime",
      model: "gpt-realtime-2.1",
      output_modalities: ["audio"],
      reasoning: { effort: "low" },
      audio: {
        input: {
          transcription: { model: "gpt-transcribe" },
        },
        output: {
          voice: "cedar",
          speed: 1.05,
        },
      },
      instructions: new RoutingInstructionsBuilder(decision).build(),
      tools,
      tool_choice: "auto",
      parallel_tool_calls: false,
    };
  }

  createInitialResponse(decision: AcceptedRoutingDecision): object {
    const greeting = new RoutingInstructionsBuilder(decision).getInitialGreeting();

    return {
      type: "response.create",
      response: {
        instructions: `Begin the call now in English. Use this natural greeting: "${greeting}" Then wait for the caller's response.`,
      },
    };
  }
}
