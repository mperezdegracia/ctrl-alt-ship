import type { SupabaseClient } from "@supabase/supabase-js";

import { supabaseAdmin } from "../../config/supabase";
import { OperationName } from "../../domain/operation-name";

const E164_PHONE = /^\+[1-9][0-9]{7,14}$/;

type ContactRow = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  authorized: boolean;
  active: boolean;
};

export type Provider = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  capabilities: Record<string, unknown>;
};

export type OperationContext = {
  id: string;
  reference: string;
  name: string;
  status: string;
  containerType: string | null;
  pickupLocation: string | null;
  deliveryLocation: string | null;
  updatedAt: string;
};

export type ProviderOperationContext = OperationContext & {
  relationship: "quote_requested" | "booking_pending" | "booking_confirmed";
};

type OperationRow = {
  id: string;
  reference: string;
  status: string;
  container_type: string | null;
  pickup_location: string | null;
  delivery_location: string | null;
  updated_at: string;
};

export type CounterpartyIdentity =
  | {
      persona: "client";
      contactId: string;
      name: string;
      phone: string;
      email: string | null;
      authorized: boolean;
      active: boolean;
    }
  | {
      persona: "provider";
      providerId: string;
      name: string;
      phone: string;
      email: string | null;
      active: boolean;
    };

function normalizeCallerId(callerId: string): string {
  const normalized = callerId.trim();
  if (!E164_PHONE.test(normalized)) {
    throw new Error("callerId must use E.164 format");
  }
  return normalized;
}

export async function findCounterpartyByCallerId(
  callerId: string,
  client: SupabaseClient = supabaseAdmin,
): Promise<CounterpartyIdentity | null> {
  const phone = normalizeCallerId(callerId);
  const [contactResult, providerResult] = await Promise.all([
    client
      .from("contacts")
      .select("id,name,phone,email,authorized,active")
      .eq("phone", phone)
      .maybeSingle(),
    client
      .from("providers")
      .select("id,name,phone,email,active")
      .eq("phone", phone)
      .maybeSingle(),
  ]);

  if (contactResult.error) throw contactResult.error;
  if (providerResult.error) throw providerResult.error;
  if (contactResult.data && providerResult.data) {
    throw new Error(`Caller ID ${phone} belongs to both a contact and a provider`);
  }

  if (contactResult.data) {
    const contact = contactResult.data as ContactRow;
    return {
      persona: "client",
      contactId: contact.id,
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
      authorized: contact.authorized,
      active: contact.active,
    };
  }

  if (providerResult.data) {
    const provider = providerResult.data as Omit<Provider, "capabilities"> & { active: boolean };
    return {
      persona: "provider",
      providerId: provider.id,
      name: provider.name,
      phone: provider.phone,
      email: provider.email,
      active: provider.active,
    };
  }

  return null;
}

export async function listActiveProviders(
  client: SupabaseClient = supabaseAdmin,
): Promise<Provider[]> {
  const result = await client
    .from("providers")
    .select("id,name,phone,email,capabilities")
    .eq("active", true)
    .order("name");

  if (result.error) throw result.error;
  return (result.data ?? []) as Provider[];
}

function toOperationContext(row: OperationRow): OperationContext {
  return {
    id: row.id,
    reference: row.reference,
    name: OperationName.fromRoute(row.pickup_location, row.delivery_location),
    status: row.status,
    containerType: row.container_type,
    pickupLocation: row.pickup_location,
    deliveryLocation: row.delivery_location,
    updatedAt: row.updated_at,
  };
}

export async function listOpenOperationsForContact(
  contactId: string,
  client: SupabaseClient = supabaseAdmin,
): Promise<OperationContext[]> {
  const result = await client
    .from("operations")
    .select("id,reference,status,container_type,pickup_location,delivery_location,updated_at")
    .eq("contact_id", contactId)
    .not("status", "in", "(cancelled,failed)")
    .order("updated_at", { ascending: false });

  if (result.error) throw result.error;
  return ((result.data ?? []) as OperationRow[]).map(toOperationContext);
}

export async function listActiveOperationsForProvider(
  providerId: string,
  client: SupabaseClient = supabaseAdmin,
): Promise<ProviderOperationContext[]> {
  const requestResult = await client
    .from("quote_requests")
    .select("id,operation_id,status,expires_at")
    .eq("provider_id", providerId);
  if (requestResult.error) throw requestResult.error;

  const requests = (requestResult.data ?? []) as Array<{
    id: string;
    operation_id: string;
    status: string;
    expires_at: string;
  }>;
  const relationships = new Map<string, ProviderOperationContext["relationship"]>();
  const now = Date.now();
  for (const request of requests) {
    if (["pending", "queued", "contacted", "responded"].includes(request.status)
      && Date.parse(request.expires_at) > now) {
      relationships.set(request.operation_id, "quote_requested");
    }
  }

  // A confirmed booking remains active even after its original quote request
  // expires. Inspect bookings from all of this provider's requests.
  if (requests.length > 0) {
    const quoteResult = await client
      .from("quotes")
      .select("id")
      .in("quote_request_id", requests.map((request) => request.id));
    if (quoteResult.error) throw quoteResult.error;

    const quoteIds = (quoteResult.data ?? []).map((quote) => quote.id as string);
    if (quoteIds.length > 0) {
      const bookingResult = await client
        .from("bookings")
        .select("operation_id,status")
        .in("quote_id", quoteIds)
        .in("status", ["pending", "confirmed"]);
      if (bookingResult.error) throw bookingResult.error;
      for (const booking of bookingResult.data ?? []) {
        relationships.set(booking.operation_id as string,
          booking.status === "confirmed" ? "booking_confirmed" : "booking_pending");
      }
    }
  }

  if (relationships.size === 0) return [];

  const operationResult = await client
    .from("operations")
    .select("id,reference,status,container_type,pickup_location,delivery_location,updated_at")
    .in("id", [...relationships.keys()])
    .not("status", "in", "(cancelled,failed)")
    .order("updated_at", { ascending: false });
  if (operationResult.error) throw operationResult.error;

  return ((operationResult.data ?? []) as OperationRow[]).map((row) => ({
    ...toOperationContext(row),
    relationship: relationships.get(row.id)!,
  }));
}
