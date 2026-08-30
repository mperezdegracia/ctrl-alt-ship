import type { ClientFlowState, ClientOperationService } from "../../domain/client-operation-service";
import { ToolError } from "../../domain/tool-error";
import { RealtimeToolRegistry, type RealtimeTool, type ToolInvocation } from "./realtime-tool";
import type { ProviderFlowState, ProviderQuoteService } from "../../domain/provider-quote-service";

export class CallToolSession extends RealtimeToolRegistry {
  private ready: boolean;
  private state?: ClientFlowState;
  private providerState?: ProviderFlowState;

  constructor(tools: RealtimeTool[], private readonly clientService?: ClientOperationService, private readonly providerService?: ProviderQuoteService) {
    super(tools);
    this.ready = !clientService && !providerService;
  }

  get flowState(): ClientFlowState | undefined { return this.state; }
  get providerFlowState(): ProviderFlowState | undefined { return this.providerState; }
  get profile(): string { return this.state?.profile ?? this.providerState?.profile ?? "read_only"; }

  get definitions() {
    if (!this.ready) return [];
    const definitions = super.definitions;
    if (this.providerService) {
      const names = this.providerState?.profile === "terminal" ? []
        : this.providerState?.profile === "provider_booking_escalation" ? ["escalate"]
        : this.providerState?.profile === "provider_reschedule" ? ["reschedule_booking", "escalate"]
        : this.providerState?.profile === "provider_cancel_booking" ? ["cancel_booking", "escalate"]
        : this.providerState?.profile === "provider_quote" ? ["create_quote", "decline_quote_request", "escalate"]
        : this.providerState?.profile === "provider_inbound_entry" ? ["list_provider_operations", "escalate",
          ...(this.providerState.candidates.length ? ["create_quote", "decline_quote_request"] : []),
          ...(this.providerState.bookingCandidates?.length ? ["reschedule_booking", "cancel_booking"] : [])]
        : this.providerState?.operation ? ["escalate"] : ["list_provider_operations", "escalate"];
      return definitions.filter((tool) => names.includes(tool.name));
    }
    if (!this.clientService) return definitions;
    const names = this.state?.profile === "client_entry"
      ? ["list_open_operations", "create_operation", "update_operation", "cancel_operation"]
      : this.state?.profile === "terminal" ? []
        : this.state?.operation ? ["update_operation", "confirm_mandate"] : [];
    return definitions.filter((tool) => names.includes(tool.name));
  }

  async refresh(): Promise<void> {
    if (!this.clientService && !this.providerService) return;
    this.ready = false;
    if (this.clientService) this.state = await this.clientService.getState();
    if (this.providerService) this.providerState = await this.providerService.getState();
    this.ready = true;
  }

  async execute(name: string, args: unknown, invocation?: ToolInvocation): Promise<unknown> {
    if (this.providerService && ["create_quote", "decline_quote_request", "reschedule_booking", "cancel_booking"].includes(name)) {
      return super.execute(name, args, invocation);
    }
    if (this.clientService && ["create_operation", "update_operation", "confirm_mandate", "cancel_operation"].includes(name)) {
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
