import type { ClientFlowState, ClientOperationService } from "../../domain/client-operation-service";
import { ToolError } from "../../domain/tool-error";
import { RealtimeToolRegistry, type RealtimeTool, type ToolInvocation } from "./realtime-tool";
import type { ProviderFlowState, ProviderQuoteService } from "../../domain/provider-quote-service";
import type { DiagnosticLogger } from "../../observability/state-transition-log";

export class CallToolSession extends RealtimeToolRegistry {
  private ready: boolean;
  private state?: ClientFlowState;
  private providerState?: ProviderFlowState;

  constructor(tools: RealtimeTool[], private readonly clientService?: ClientOperationService, private readonly providerService?: ProviderQuoteService, private readonly logger?: DiagnosticLogger) {
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
    const started = Date.now();
    const previousProfile = this.profile;
    this.logger?.info("tool.state_refresh_started", { profile: previousProfile });
    this.ready = false;
    try {
      if (this.clientService) this.state = await this.clientService.getState();
      if (this.providerService) this.providerState = await this.providerService.getState();
      this.ready = true;
      this.logger?.info("tool.state_refreshed", {
        duration_ms: Date.now() - started, previous_profile: previousProfile, profile: this.profile,
        intent: this.state?.intent ?? this.providerState?.intent,
        operation_reference: this.state?.operation?.operation_reference ?? this.providerState?.operation?.operation_reference,
        operation_status: this.state?.operation?.status,
        missing_fields: this.state?.operation?.missing_fields,
        mandate_confirmation_required: this.state?.operation?.mandate_confirmation_required,
        mandate_version: this.state?.currentMandate?.version,
        changed_fields: Object.keys(this.state?.operationChanges ?? {}),
        candidate_count: this.providerState?.candidates.length,
        booking_candidate_count: this.providerState?.bookingCandidates?.length,
        quote_verdict: this.providerState?.lastQuote?.verdict,
        negotiation_rounds_remaining: this.providerState?.lastQuote?.negotiation_rounds_remaining,
        tools: this.definitions.map((tool) => tool.name),
      });
    } catch (error) {
      this.logger?.error("tool.state_refresh_failed", { profile: previousProfile, duration_ms: Date.now() - started, error });
      throw error;
    }
  }

  async execute(name: string, args: unknown, invocation?: ToolInvocation): Promise<unknown> {
    const started = Date.now();
    const fields = { tool_name: name, tool_call_id: invocation?.toolCallId, profile: this.profile };
    this.logger?.info("tool.execution_started", { ...fields,
      argument_fields: args && typeof args === "object" ? Object.keys(args) : [],
    });
    try {
      const result = await this.executeInFlow(name, args, invocation);
      this.logger?.info("tool.execution_succeeded", { ...fields, duration_ms: Date.now() - started });
      return result;
    } catch (error) {
      this.logger?.error("tool.execution_failed", { ...fields, duration_ms: Date.now() - started, error });
      throw error;
    }
  }

  private async executeInFlow(name: string, args: unknown, invocation?: ToolInvocation): Promise<unknown> {
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
