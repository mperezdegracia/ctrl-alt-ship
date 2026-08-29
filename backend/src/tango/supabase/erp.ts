import type { SupabaseClient } from "@supabase/supabase-js";

import { supabaseAdmin } from "../../config/supabase";

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
