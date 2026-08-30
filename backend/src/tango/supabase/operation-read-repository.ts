import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ClientOperationSummary,
  OperationReadRepository,
  ProviderOperationSummary,
  ToolCallScope,
} from "../../domain/operation-read-service";
import { listOpenOperationsForContact } from "./erp";

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

  async listForProvider(scope: ToolCallScope): Promise<ProviderOperationSummary[]> {
    if (scope.persona !== "provider" || scope.direction !== "inbound" || scope.purpose !== "booking_management") {
      throw new Error("Provider booking listing requires an inbound booking-management scope");
    }
    const { data, error } = await this.client.rpc("get_provider_tool_state", {
      p_call_id: scope.callId,
      p_realtime_call_id: scope.realtimeCallId,
      p_provider_id: scope.counterpartyId,
    });
    if (error) throw error;
    if (!data || data.flow !== "provider_inbound" || !Array.isArray(data.bookings)
      || !["provider_inbound_entry", "provider_reschedule", "provider_cancel_booking", "provider_booking_escalation", "provider_unavailable", "terminal"].includes(data.profile)) {
      throw new Error("Invalid provider inbound booking state");
    }
    return data.bookings as ProviderOperationSummary[];
  }
}
