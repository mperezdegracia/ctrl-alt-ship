import { ToolError } from "./tool-error";

export type ToolCallScope = Readonly<{
  callId: string;
  realtimeCallId: string;
  persona: "client" | "provider";
  counterpartyId: string;
}>;

export type ClientOperationSummary = {
  operation_reference: string;
  operation_name: string;
  status: string;
  container_type: string | null;
  pickup_location: string | null;
  delivery_location: string | null;
  updated_at: string;
};

export type ProviderOperationSummary = {
  operation_reference: string;
  operation_name: string;
  relationship: "quote_requested" | "booking_pending" | "booking_confirmed";
  pickup_location: string;
  delivery_location: string;
  container_type: string;
};

export interface OperationReadRepository {
  isAuthorized(scope: ToolCallScope): Promise<boolean>;
  listForClient(contactId: string): Promise<ClientOperationSummary[]>;
  listForProvider(providerId: string): Promise<ProviderOperationSummary[]>;
}

export class OperationReadService {
  private readonly scope: ToolCallScope;

  constructor(scope: ToolCallScope, private readonly repository: OperationReadRepository) {
    this.scope = Object.freeze({ ...scope });
  }

  async listClientOperations(): Promise<{ operations: ClientOperationSummary[] }> {
    await this.authorize("client");
    return { operations: await this.repository.listForClient(this.scope.counterpartyId) };
  }

  async listProviderOperations(): Promise<{ operations: ProviderOperationSummary[] }> {
    await this.authorize("provider");
    return { operations: await this.repository.listForProvider(this.scope.counterpartyId) };
  }

  private async authorize(persona: ToolCallScope["persona"]): Promise<void> {
    if (this.scope.persona !== persona || !await this.repository.isAuthorized(this.scope)) {
      throw new ToolError("not_authorized", "This tool is not authorized for the current caller or call.");
    }
  }
}
