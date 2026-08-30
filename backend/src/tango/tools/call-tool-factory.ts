import { OperationReadService, type OperationReadRepository, type ToolCallScope } from "../../domain/operation-read-service";
import { ListOpenOperationsTool, ListProviderOperationsTool } from "./list-operations-tool";
import { ClientOperationService, type ClientOperationRepository } from "../../domain/client-operation-service";
import { CancelOperationTool, ConfirmMandateTool, CreateOperationTool, UpdateOperationTool } from "./client-operation-tool";
import { CallToolSession } from "./call-tool-session";
import type { RealtimeTool } from "./realtime-tool";
import { ProviderQuoteService, type ProviderQuoteRepository } from "../../domain/provider-quote-service";
import { CreateQuoteTool, DeclineQuoteRequestTool } from "./provider-quote-tool";
import { ProviderBookingService, type ProviderBookingRepository } from "../../domain/provider-booking-service";
import { CancelBookingTool, RescheduleBookingTool } from "./provider-booking-tool";
import type { StructuredLogger } from "../../observability/logger";

export class CallToolFactory {
  constructor(
    private readonly repository: OperationReadRepository,
    private readonly mutations?: ClientOperationRepository,
    private readonly providerMutations?: ProviderQuoteRepository,
    private readonly providerBookings?: ProviderBookingRepository,
    private readonly logger?: StructuredLogger,
  ) {}

  create(scope: ToolCallScope, providerExtension?: RealtimeTool): CallToolSession {
    const service = new OperationReadService(scope, this.repository);
    const clientService = scope.persona === "client" && this.mutations
      ? new ClientOperationService(scope, this.mutations) : undefined;
    const providerService = scope.persona === "provider" && this.providerMutations
      ? new ProviderQuoteService(scope, this.providerMutations) : undefined;
    const bookingService = providerService && this.providerBookings
      ? new ProviderBookingService(scope, this.providerBookings, () => providerService.currentState) : undefined;
    return new CallToolSession([
      scope.persona === "client"
        ? new ListOpenOperationsTool(service)
        : new ListProviderOperationsTool(service),
      ...(clientService ? [new CreateOperationTool(clientService), new UpdateOperationTool(clientService), new CancelOperationTool(clientService), new ConfirmMandateTool(clientService)] : []),
      ...(scope.persona === "provider" && providerExtension ? [providerExtension] : []),
      ...(providerService ? [new CreateQuoteTool(providerService), new DeclineQuoteRequestTool(providerService)] : []),
      ...(bookingService ? [new RescheduleBookingTool(bookingService), new CancelBookingTool(bookingService)] : []),
    ], clientService, providerService, this.logger?.child({
      call_record_id: scope.callId, call_id: scope.realtimeCallId,
      persona: scope.persona, counterparty_id: scope.counterpartyId,
    }));
  }
}
