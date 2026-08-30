import { OperationReadService, type OperationReadRepository, type ToolCallScope } from "../../domain/operation-read-service";
import { ListOpenOperationsTool, ListProviderOperationsTool } from "./list-operations-tool";
import { ClientOperationService, type ClientOperationRepository } from "../../domain/client-operation-service";
import { ConfirmMandateTool, CreateOperationTool, UpdateOperationTool } from "./client-operation-tool";
import { CallToolSession } from "./call-tool-session";

export class CallToolFactory {
  constructor(
    private readonly repository: OperationReadRepository,
    private readonly mutations?: ClientOperationRepository,
  ) {}

  create(scope: ToolCallScope): CallToolSession {
    const service = new OperationReadService(scope, this.repository);
    const clientService = scope.persona === "client" && this.mutations
      ? new ClientOperationService(scope, this.mutations) : undefined;
    return new CallToolSession([
      scope.persona === "client"
        ? new ListOpenOperationsTool(service)
        : new ListProviderOperationsTool(service),
      ...(clientService ? [new CreateOperationTool(clientService), new UpdateOperationTool(clientService), new ConfirmMandateTool(clientService)] : []),
    ], clientService);
  }
}
