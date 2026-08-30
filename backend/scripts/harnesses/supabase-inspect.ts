import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { resolve } from "node:path";

dotenv.config({ path: resolve(__dirname, "../../.env") });

const TABLES = [
  "contacts",
  "providers",
  "operations",
  "calls",
  "mandates",
  "quote_requests",
  "quotes",
  "bookings",
  "change_requests",
  "escalations",
  "handoff_recipients",
  "call_transcript_segments",
  "events",
  "outbox",
] as const;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta ${name} en backend/.env`);
  return value;
}

function maskedPhone(phone: string): string {
  return `${phone.slice(0, -4).replace(/[0-9]/g, "*")}${phone.slice(-4)}`;
}

export class SupabaseInspector {
  constructor(private readonly client: SupabaseClient) {}

  async inspect(): Promise<void> {
    const counts = await this.loadCounts();
    const [contacts, providers, operations, mandates, requests, quotes, bookings, events] =
      await Promise.all([
        this.read("contacts", "id,name,phone,authorized,active"),
        this.read("providers", "id,name,phone,active,capabilities"),
        this.read(
          "operations",
          "id,reference,contact_id,current_mandate_id,status,container_type,pickup_location,delivery_location",
        ),
        this.read(
          "mandates",
          "id,operation_id,version,price_cap,currency,action_windows,minimum_payment_term_days",
        ),
        this.read("quote_requests", "id,operation_id,provider_id,status,expires_at"),
        this.read(
          "quotes",
          "id,quote_request_id,version,price_min,price_max,currency,verdict,status,valid_until",
        ),
        this.read("bookings", "operation_id,status,confirmed_price,pickup_window_start,pickup_window_end"),
        this.read("events", "type"),
      ]);

    const operationById = new Map(operations.map((row) => [row.id, row.reference]));
    const providerById = new Map(providers.map((row) => [row.id, row.name]));
    const requestById = new Map(requests.map((row) => [row.id, row]));
    const mandateById = new Map(mandates.map((row) => [row.id, row]));
    const eventCounts = events.reduce<Record<string, number>>((result, row) => {
      const type = String(row.type);
      result[type] = (result[type] ?? 0) + 1;
      return result;
    }, {});

    console.log(JSON.stringify({
      counts,
      contacts: contacts.map((row) => ({
        name: row.name,
        phone: maskedPhone(String(row.phone)),
        authorized: row.authorized,
        active: row.active,
      })),
      providers: providers.map((row) => ({
        name: row.name,
        phone: maskedPhone(String(row.phone)),
        active: row.active,
        seed_scenario: row.capabilities?.seed_scenario ?? null,
      })),
      operations: operations.map((row) => ({
        reference: row.reference,
        status: row.status,
        container_type: row.container_type,
        pickup_location: row.pickup_location,
        delivery_location: row.delivery_location,
        mandate_version: mandateById.get(row.current_mandate_id)?.version ?? null,
      })),
      mandates: mandates.map((row) => ({
        operation: operationById.get(row.operation_id) ?? "unknown",
        version: row.version,
        price_cap: row.price_cap,
        currency: row.currency,
        action_windows: row.action_windows,
        minimum_payment_term_days: row.minimum_payment_term_days,
      })),
      quote_requests: requests.map((row) => ({
        operation: operationById.get(row.operation_id) ?? "unknown",
        provider: providerById.get(row.provider_id) ?? "unknown",
        status: row.status,
        expires_at: row.expires_at,
      })),
      quotes: quotes.map((row) => {
        const request = requestById.get(row.quote_request_id);
        return {
          operation: request ? operationById.get(request.operation_id) ?? "unknown" : "unknown",
          provider: request ? providerById.get(request.provider_id) ?? "unknown" : "unknown",
          version: row.version,
          price_range: [row.price_min, row.price_max],
          currency: row.currency,
          verdict: row.verdict,
          status: row.status,
          valid_until: row.valid_until,
        };
      }),
      bookings: bookings.map((row) => ({
        operation: operationById.get(row.operation_id) ?? "unknown",
        status: row.status,
        confirmed_price: row.confirmed_price,
        pickup_window: [row.pickup_window_start, row.pickup_window_end],
      })),
      events_by_type: eventCounts,
    }, null, 2));
  }

  private async loadCounts(): Promise<Record<string, number>> {
    const entries = await Promise.all(TABLES.map(async (table) => {
      const result = await this.client.from(table).select("id", { count: "exact", head: true });
      if (result.error) throw result.error;
      return [table, result.count ?? 0] as const;
    }));
    return Object.fromEntries(entries);
  }

  private async read(table: string, columns: string): Promise<any[]> {
    const result = await this.client.from(table).select(columns).limit(1_000);
    if (result.error) throw result.error;
    return result.data ?? [];
  }
}

async function main(): Promise<void> {
  const client = createClient(
    requiredEnvironment("SUPABASE_URL"),
    requiredEnvironment("SUPABASE_SECRET_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    },
  );
  await new SupabaseInspector(client).inspect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
