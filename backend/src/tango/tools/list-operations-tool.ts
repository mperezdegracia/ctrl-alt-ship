import { OperationReadService } from "../../domain/operation-read-service";
import { ToolError } from "../../domain/tool-error";
import { RealtimeTool, type RealtimeFunctionToolDefinition } from "./realtime-tool";
import type { ProviderBookingService } from "../../domain/provider-booking-service";

abstract class ListOperationsTool extends RealtimeTool {
  constructor(protected readonly service: OperationReadService) {
    super();
  }

  async execute(argumentsValue: unknown): Promise<unknown> {
    if (typeof argumentsValue !== "object" || argumentsValue === null
      || Array.isArray(argumentsValue) || Object.keys(argumentsValue).length !== 0) {
      throw new ToolError("invalid_arguments", "This tool accepts only an empty object; caller identity is supplied by the server.");
    }
    return this.list();
  }

  protected abstract list(): Promise<unknown>;
}

export class ListOpenOperationsTool extends ListOperationsTool {
  readonly definition: RealtimeFunctionToolDefinition = {
    type: "function",
    name: "list_open_operations",
    description: "Lists only the authenticated client's open operations so the caller can identify one before updating or cancelling it.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  };

  protected list(): Promise<unknown> {
    return this.service.listClientOperations();
  }
}

export class ListProviderOperationsTool extends ListOperationsTool {
  readonly definition: RealtimeFunctionToolDefinition = {
    type: "function",
    name: "list_provider_operations",
    description: "Lists only the authenticated provider's currently confirmed Bookings for inbound intent selection.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  };

  constructor(service: OperationReadService, private readonly bookingService: ProviderBookingService) {
    super(service);
  }

  protected list(): Promise<unknown> {
    return this.bookingService.listBookings();
  }
}
