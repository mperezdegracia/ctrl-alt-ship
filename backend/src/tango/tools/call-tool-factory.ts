import { OperationReadService, type OperationReadRepository, type ToolCallScope } from "../../domain/operation-read-service";
import { ListOpenOperationsTool, ListProviderOperationsTool } from "./list-operations-tool";
import { ClientOperationService, type ClientOperationRepository } from "../../domain/client-operation-service";
import { CancelOperationTool, ConfirmMandateTool, CreateOperationTool, UpdateOperationTool } from "./client-operation-tool";
import { CallToolSession } from "./call-tool-session";
import type { RealtimeTool } from "./realtime-tool";
import { ProviderQuoteService, type ProviderQuoteRepository } from "../../domain/provider-quote-service";
import { CreateQuoteTool, DeclineQuoteRequestTool, RecordProviderOfferTool } from "./provider-quote-tool";
import { ProviderBookingService, type ProviderBookingRepository } from "../../domain/provider-booking-service";
import { CancelBookingTool, RescheduleBookingTool, SelectBookingForCancellationTool, SelectBookingForRescheduleTool } from "./provider-booking-tool";
import type { StructuredLogger } from "../../observability/logger";

export class CallToolFactory {
  constructor(
    private readonly repository: OperationReadRepository,
    private readonly mutations?: ClientOperationRepository,
    private readonly providerMutations?: ProviderQuoteRepository,
    private readonly providerBookings?: ProviderBookingRepository,
    private readonly logger?: StructuredLogger,
  ) {}

  create(scope: ToolCallScope, escalationTool?: RealtimeTool): CallToolSession {
    const service = new OperationReadService(scope, this.repository);
    const clientService = scope.persona === "client" && this.mutations
      ? new ClientOperationService(scope, this.mutations) : undefined;
    const providerService = scope.persona === "provider" && scope.direction === "outbound" && this.providerMutations
      ? new ProviderQuoteService(scope, this.providerMutations) : undefined;
    const bookingService = scope.persona === "provider" && scope.direction === "inbound" && this.providerBookings
      ? new ProviderBookingService(scope, this.providerBookings) : undefined;
    return new CallToolSession([
      ...(scope.persona === "client" ? [new ListOpenOperationsTool(service)]
        : bookingService ? [new ListProviderOperationsTool(service, bookingService)] : []),
      ...(clientService ? [new CreateOperationTool(clientService), new UpdateOperationTool(clientService), new CancelOperationTool(clientService), new ConfirmMandateTool(clientService)] : []),
      ...(escalationTool ? [escalationTool] : []),
      ...(providerService ? [new CreateQuoteTool(providerService), new DeclineQuoteRequestTool(providerService), new RecordProviderOfferTool(providerService)] : []),
      ...(bookingService ? [new RescheduleBookingTool(bookingService), new CancelBookingTool(bookingService), new SelectBookingForRescheduleTool(bookingService), new SelectBookingForCancellationTool(bookingService)] : []),
    ], clientService, providerService, bookingService, this.logger?.child({
      call_record_id: scope.callId, call_id: scope.realtimeCallId,
      persona: scope.persona, counterparty_id: scope.counterpartyId,
    }));
  }
}
