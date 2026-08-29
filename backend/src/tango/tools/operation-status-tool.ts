import { RealtimeTool } from "./realtime-tool";

type OperationStatusArguments = {
  operation_id: string;
};

export class OperationStatusTool extends RealtimeTool {
  readonly definition = {
    type: "function" as const,
    name: "get_operation_status",
    description: "Gets the current status and verified details of a logistics operation.",
    parameters: {
      type: "object" as const,
      properties: {
        operation_id: {
          type: "string",
          description: "Operation reference, for example OP-182.",
        },
      },
      required: ["operation_id"],
      additionalProperties: false as const,
    },
  };

  async execute(argumentsValue: unknown): Promise<unknown> {
    const argumentsObject = this.parseArguments(argumentsValue);

    // Mock until the operation tools are connected to Supabase.
    return {
      operation_id: argumentsObject.operation_id,
      container: "MSKU1234567",
      status: "NEGOTIATING",
      origin: "Puerto de Manzanillo",
      destination: "Guadalajara",
      pickup_date: "2026-09-03",
    };
  }

  private parseArguments(argumentsValue: unknown): OperationStatusArguments {
    if (
      typeof argumentsValue !== "object"
      || argumentsValue === null
      || !("operation_id" in argumentsValue)
      || typeof argumentsValue.operation_id !== "string"
      || argumentsValue.operation_id.trim() === ""
    ) {
      throw new Error("get_operation_status requires a non-empty operation_id");
    }

    return { operation_id: argumentsValue.operation_id };
  }
}
