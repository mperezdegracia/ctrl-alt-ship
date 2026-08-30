import { ToolError } from "../../domain/tool-error";

export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
};

export type RealtimeFunctionToolDefinition = {
  type: "function";
  name: string;
  description: string;
  parameters: JsonSchema;
};

export type ToolInvocation = Readonly<{ toolCallId: string }>;

export abstract class RealtimeTool {
  abstract readonly definition: RealtimeFunctionToolDefinition;

  abstract execute(argumentsValue: unknown, invocation?: ToolInvocation): Promise<unknown>;
}

export class RealtimeToolRegistry {
  private readonly toolsByName: Map<string, RealtimeTool>;

  constructor(tools: RealtimeTool[]) {
    this.toolsByName = new Map(tools.map((tool) => [tool.definition.name, tool]));
    if (this.toolsByName.size !== tools.length) {
      throw new Error("Duplicate realtime tool definition");
    }
  }

  get definitions(): RealtimeFunctionToolDefinition[] {
    return Array.from(this.toolsByName.values(), (tool) => tool.definition);
  }

  async execute(name: string, argumentsValue: unknown, invocation?: ToolInvocation): Promise<unknown> {
    const tool = this.toolsByName.get(name);
    if (!tool) {
      throw new ToolError("tool_unavailable", "This tool is not available for the current call.");
    }

    return tool.execute(argumentsValue, invocation);
  }
}
