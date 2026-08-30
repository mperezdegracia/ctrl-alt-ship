import type { ClientFlowState, ClientOperationService } from "../../domain/client-operation-service";
import { ToolError } from "../../domain/tool-error";
import { RealtimeToolRegistry, type RealtimeTool, type ToolInvocation } from "./realtime-tool";

export class CallToolSession extends RealtimeToolRegistry {
  private ready: boolean;
  private state?: ClientFlowState;

  constructor(tools: RealtimeTool[], private readonly clientService?: ClientOperationService) {
    super(tools);
    this.ready = !clientService;
  }

  get flowState(): ClientFlowState | undefined { return this.state; }

  get definitions() {
    if (!this.ready) return [];
    const definitions = super.definitions;
    if (!this.clientService) return definitions;
    const names = this.state?.profile === "client_entry"
      ? ["list_open_operations", "create_operation", "update_operation"]
      : this.state?.profile === "terminal" ? []
        : this.state?.profile === "client_confirm" ? ["update_operation", "confirm_mandate"] : ["update_operation"];
    return definitions.filter((tool) => names.includes(tool.name));
  }

  async refresh(): Promise<void> {
    if (!this.clientService) return;
    this.ready = false;
    this.state = await this.clientService.getState();
    this.ready = true;
  }

  async execute(name: string, args: unknown, invocation?: ToolInvocation): Promise<unknown> {
    if (this.clientService && ["create_operation", "update_operation", "confirm_mandate"].includes(name)) {
      // The SQL transaction enforces current state, ownership and intent. It
      // also permits replay of a committed command whose tool is now hidden.
      return super.execute(name, args, invocation);
    }
    await this.refresh();
    if (!this.definitions.some((tool) => tool.name === name)) {
      throw new ToolError("tool_unavailable", "This tool is not available in the current flow.");
    }
    return super.execute(name, args, invocation);
  }
}
