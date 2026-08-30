import { OperationReadService, type OperationReadRepository, type ToolCallScope } from "../../domain/operation-read-service";
import { ListOpenOperationsTool, ListProviderOperationsTool } from "./list-operations-tool";
import { ClientOperationService, type ClientOperationRepository } from "../../domain/client-operation-service";
import { CancelOperationTool, ConfirmMandateTool, CreateOperationTool, UpdateOperationTool } from "./client-operation-tool";
import { CallToolSession } from "./call-tool-session";
import type { RealtimeTool } from "./realtime-tool";
import { ProviderQuoteService, type ProviderQuoteRepository } from "../../domain/provider-quote-service";
import { CreateQuoteTool, DeclineQuoteRequestTool, RecordProviderOfferTool } from "./provider-quote-tool";
import { ProviderBookingService, type ProviderBookingRepository } from "../../domain/provider-booking-service";
import { CancelBookingTool, DeclineRescheduleAlternativesTool, RescheduleBookingTool, SelectBookingForCancellationTool, SelectBookingForRescheduleTool } from "./provider-booking-tool";
import type { StructuredLogger } from "../../observability/logger";

export class CallToolFactory {
  constructor(
    private readonly repository: OperationReadRepository,
    private readonly mutations?: ClientOperationRepository,
    private readonly providerMutations?: ProviderQuoteRepository,
    private readonly providerBookings?: ProviderBookingRepository,
    private readonly logger?: StructuredLogger,
  ) {}

  create(scope: ToolCallScope, escalationTool?: RealtimeTool, escalationControls: RealtimeTool[] = []): CallToolSession {
    if (scope.persona === "provider" && scope.direction === "inbound" && !this.providerBookings) {
      throw new Error("Provider inbound booking repository is not configured");
    }
    if (scope.persona === "provider" && scope.direction === "outbound" && !this.providerMutations) {
      throw new Error("Provider outbound quote repository is not configured");
    }
    const service = new OperationReadService(scope, this.repository);
    const clientService = scope.persona === "client" && this.mutations
      ? new ClientOperationService(scope, this.mutations) : undefined;
    const providerService = scope.persona === "provider" && scope.direction === "outbound" && this.providerMutations
      ? new ProviderQuoteService(scope, this.providerMutations) : undefined;
    const bookingService = scope.persona === "provider" && scope.direction === "inbound" && this.providerBookings
      ? new ProviderBookingService(scope, this.providerBookings) : undefined;
    const tools: RealtimeTool[] = [...escalationControls];
    if (scope.persona === "client") tools.push(new ListOpenOperationsTool(service));
    else if (bookingService) tools.push(new ListProviderOperationsTool(service, bookingService));
    if (clientService) tools.push(
      new CreateOperationTool(clientService), new UpdateOperationTool(clientService),
      new CancelOperationTool(clientService), new ConfirmMandateTool(clientService),
    );
    if (escalationTool) tools.push(escalationTool);
    if (providerService) tools.push(
      new CreateQuoteTool(providerService), new DeclineQuoteRequestTool(providerService), new RecordProviderOfferTool(providerService),
    );
    if (bookingService) tools.push(
      new RescheduleBookingTool(bookingService), new CancelBookingTool(bookingService),
      new DeclineRescheduleAlternativesTool(bookingService),
      new SelectBookingForRescheduleTool(bookingService), new SelectBookingForCancellationTool(bookingService),
    );
    return new CallToolSession(tools, clientService, providerService, bookingService, this.logger?.child({
      call_record_id: scope.callId, call_id: scope.realtimeCallId,
      persona: scope.persona, counterparty_id: scope.counterpartyId,
    }));
  }
}
