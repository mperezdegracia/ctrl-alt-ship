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

export abstract class RealtimeTool {
  abstract readonly definition: RealtimeFunctionToolDefinition;

  abstract execute(argumentsValue: unknown): Promise<unknown>;
}

export class RealtimeToolRegistry {
  private readonly toolsByName: Map<string, RealtimeTool>;

  constructor(tools: RealtimeTool[]) {
    this.toolsByName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  }

  get definitions(): RealtimeFunctionToolDefinition[] {
    return Array.from(this.toolsByName.values(), (tool) => tool.definition);
  }

  async execute(name: string, argumentsValue: unknown): Promise<unknown> {
    const tool = this.toolsByName.get(name);
    if (!tool) {
      throw new Error(`Unknown realtime tool: ${name}`);
    }

    return tool.execute(argumentsValue);
  }
}
