import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ClientOperationSummary,
  OperationReadRepository,
  ProviderOperationSummary,
  ToolCallScope,
} from "../../domain/operation-read-service";
import { listActiveOperationsForProvider, listOpenOperationsForContact } from "./erp";

export class SupabaseOperationReadRepository implements OperationReadRepository {
  constructor(private readonly client: SupabaseClient) {}

  async isAuthorized(scope: ToolCallScope): Promise<boolean> {
    const call = await this.client.from("calls")
      .select("id")
      .eq("id", scope.callId)
      .eq("realtime_call_id", scope.realtimeCallId)
      .eq("persona", scope.persona)
      .eq(scope.persona === "client" ? "contact_id" : "provider_id", scope.counterpartyId)
      .eq("outcome", "active")
      .maybeSingle();
    if (call.error) throw call.error;
    if (!call.data) return false;

    const identity = await this.client
      .from(scope.persona === "client" ? "contacts" : "providers")
      .select(scope.persona === "client" ? "active,authorized" : "active")
      .eq("id", scope.counterpartyId)
      .returns<Array<{ active: boolean; authorized?: boolean }>>()
      .maybeSingle();
    if (identity.error) throw identity.error;
    return identity.data?.active === true
      && (scope.persona === "provider" || identity.data?.authorized === true);
  }

  async listForClient(contactId: string): Promise<ClientOperationSummary[]> {
    const operations = await listOpenOperationsForContact(contactId, this.client);
    return operations.map((operation) => ({
      operation_reference: operation.reference,
      operation_name: operation.name,
      status: operation.status,
      container_type: operation.containerType,
      pickup_location: operation.pickupLocation,
      delivery_location: operation.deliveryLocation,
      updated_at: operation.updatedAt,
    }));
  }

  async listForProvider(providerId: string): Promise<ProviderOperationSummary[]> {
    const operations = await listActiveOperationsForProvider(providerId, this.client);
    return operations.map((operation) => {
      // A provider assignment requires complete operational details. Do not
      // fabricate strings when the stored row violates that contract.
      if (!operation.pickupLocation || !operation.deliveryLocation || !operation.containerType) {
        throw new Error("Provider operation is missing required operational details");
      }
      return {
        operation_reference: operation.reference,
        operation_name: operation.name,
        relationship: operation.relationship,
        pickup_location: operation.pickupLocation,
        delivery_location: operation.deliveryLocation,
        container_type: operation.containerType,
      };
    });
  }
}
