import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { resolve } from "node:path";

dotenv.config({ path: resolve(__dirname, "../../.env") });

type SeedContact = {
  name: string;
  phone: string;
  email: string;
};

type SeedProvider = {
  seedKey: string;
  legacyName: string;
  name: string;
  phone: string;
  email: string;
  capabilities: Record<string, unknown>;
  quote?: {
    priceMin: number;
    priceMax: number;
    verdict: "dentro" | "contraoferta";
    conditions: Record<string, unknown>;
  };
};

type CounterpartyRow = {
  id: string;
  name: string;
  phone: string;
  capabilities?: Record<string, unknown>;
};

type OperationRow = {
  id: string;
  reference: string;
  contact_id: string;
  current_mandate_id: string | null;
  status: string;
  container_type: string;
  gross_weight_kg: number;
  pickup_location: string;
  delivery_location: string;
  empty_return_depot: string;
  operational_constraints: string[];
  cargo_notes: string | null;
};

type MandateRow = {
  id: string;
  price_cap: number;
  currency: string;
  action_windows: Array<{ start_at: string; end_at: string }>;
  minimum_payment_term_days: number;
};

type SeededProvider = SeedProvider & { id: string };

const E164_PHONE = /^\+[1-9][0-9]{7,14}$/;
const dryRun = process.argv.includes("--dry-run");

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta ${name} en el entorno`);
  return value;
}

function environment(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function maskedPhone(phone: string): string {
  return `${phone.slice(0, -4).replace(/[0-9]/g, "*")}${phone.slice(-4)}`;
}

class DemoSeed {
  private readonly contact: SeedContact = {
    name: "Lucas",
    phone: environment("SEED_CLIENT_PHONE", "+5491163723502"),
    email: environment("SEED_CLIENT_EMAIL", "lucasaffre@gmail.com"),
  };

  private readonly providers: SeedProvider[] = [
    {
      seedKey: "demo-provider-theo",
      legacyName: "Transporte Sur",
      name: environment("SEED_PROVIDER_1_NAME", "Theo"),
      phone: environment("SEED_PROVIDER_1_PHONE", "+5491132555829"),
      email: environment("SEED_PROVIDER_1_EMAIL", "operaciones@transportesur.example.com"),
      capabilities: {
        company_name: "Transporte Sur",
        service_areas: ["AMBA", "Buenos Aires"],
        equipment: ["40_dry"],
        responds_to_quotes: true,
        seed_scenario: "quote_inside_mandate",
      },
      quote: {
        priceMin: 850_000,
        priceMax: 900_000,
        verdict: "dentro",
        conditions: { includes_tolls: true, free_waiting_hours: 2 },
      },
    },
    {
      seedKey: "demo-provider-mateo",
      legacyName: "Logistica Ruta 3",
      name: environment("SEED_PROVIDER_2_NAME", "Mateo"),
      phone: environment("SEED_PROVIDER_2_PHONE", "+5491151365124"),
      email: environment("SEED_PROVIDER_2_EMAIL", "trafico@logisticaruta3.example.com"),
      capabilities: {
        company_name: "Logistica Ruta 3",
        service_areas: ["AMBA", "Buenos Aires"],
        equipment: ["40_dry"],
        responds_to_quotes: true,
        seed_scenario: "quote_counteroffer",
      },
      quote: {
        priceMin: 970_000,
        priceMax: 1_020_000,
        verdict: "contraoferta",
        conditions: { includes_tolls: true, free_waiting_hours: 1 },
      },
    },
    {
      seedKey: "demo-provider-paki",
      legacyName: "Fletes del Plata",
      name: environment("SEED_PROVIDER_3_NAME", "Paki"),
      phone: environment("SEED_PROVIDER_3_PHONE", "+5491163718087"),
      email: environment("SEED_PROVIDER_3_EMAIL", "despacho@fletesdelplata.example.com"),
      capabilities: {
        company_name: "Fletes del Plata",
        service_areas: ["AMBA", "Buenos Aires"],
        equipment: ["40_dry"],
        responds_to_quotes: false,
        seed_scenario: "quote_pending",
      },
    },
  ];

  private readonly operation = {
    reference: environment("SEED_OPERATION_REFERENCE", "OP-900001"),
    companyName: "Textiles del Plata",
    container_type: "40_dry",
    gross_weight_kg: 24_000,
    pickup_location: "Terminal 4, Puerto de Buenos Aires",
    delivery_location: "Deposito Textiles del Plata, Gonzalez Catan, Buenos Aires",
    empty_return_depot: "Deposito de vacios Dock Sud",
    operational_constraints: [
      "Delivery appointment required",
      "Non-refrigerated cargo",
      "Non-hazardous cargo",
    ],
    cargo_notes: "Palletized textile cargo.",
  };

  constructor(private readonly client: SupabaseClient | null) {
    const judgePhone = process.env.SEED_JUDGE_PHONE?.trim();
    if (judgePhone) {
      this.providers.push({
        seedKey: "trial-by-fire-judge",
        legacyName: "Trial by Fire Judge",
        name: environment("SEED_JUDGE_NAME", "Trial by Fire Judge"),
        phone: judgePhone,
        email: environment("SEED_JUDGE_EMAIL", "judge@example.com"),
        capabilities: {
          seed_scenario: "trial_by_fire",
          responds_to_quotes: true,
        },
      });
    }
  }

  async run(): Promise<void> {
    this.validateCallerIds();
    if (!this.client) {
      this.printDryRun();
      return;
    }

    const { contacts, providers } = await this.loadCounterparties();
    const contactId = await this.upsertContact(contacts, providers);
    const seededProviders = await this.upsertProviders(contacts, providers);
    const operation = await this.ensureOperation(contactId);
    const mandate = await this.ensureMandate(operation, contactId);
    await this.ensureQuoteScenarios(operation, mandate, seededProviders);

    console.log(
      `Seed completo: ${this.contact.name}, ${seededProviders.length} transportistas, `
      + `operacion ${operation.reference}, 3 pedidos y 2 cotizaciones de demo.`,
    );
  }

  private validateCallerIds(): void {
    const fixtures = [this.contact, ...this.providers];
    const owners = new Map<string, string>();

    for (const fixture of fixtures) {
      if (!E164_PHONE.test(fixture.phone)) {
        throw new Error(
          `${fixture.name}: caller ID invalido. Debe usar formato E.164, por ejemplo +5491100000001`,
        );
      }
      const owner = owners.get(fixture.phone);
      if (owner) throw new Error(`Caller ID duplicado entre ${owner} y ${fixture.name}`);
      owners.set(fixture.phone, fixture.name);
    }
  }

  private printDryRun(): void {
    console.log("Seed valido (dry-run):");
    console.log(`- contact: ${this.contact.name} (${maskedPhone(this.contact.phone)})`);
    for (const provider of this.providers) {
      const scenario = provider.quote ? provider.quote.verdict : "pending";
      console.log(`- provider: ${provider.name} (${maskedPhone(provider.phone)}), quote ${scenario}`);
    }
    console.log(`- operation fixture: ${this.operation.reference} (${this.operation.companyName})`);
  }

  private async loadCounterparties(): Promise<{
    contacts: CounterpartyRow[];
    providers: CounterpartyRow[];
  }> {
    const [contactResult, providerResult] = await Promise.all([
      this.db.from("contacts").select("id,name,phone"),
      this.db.from("providers").select("id,name,phone,capabilities"),
    ]);
    if (contactResult.error) throw contactResult.error;
    if (providerResult.error) throw providerResult.error;
    return {
      contacts: (contactResult.data ?? []) as CounterpartyRow[],
      providers: (providerResult.data ?? []) as CounterpartyRow[],
    };
  }

  private async upsertContact(
    contacts: CounterpartyRow[],
    providers: CounterpartyRow[],
  ): Promise<string> {
    const providerCollision = providers.find((provider) => provider.phone === this.contact.phone);
    if (providerCollision) {
      throw new Error(`El caller ID de Lucas ya pertenece al transportista ${providerCollision.name}`);
    }
    const phoneOwner = contacts.find((contact) => contact.phone === this.contact.phone);
    if (phoneOwner && phoneOwner.name !== this.contact.name) {
      throw new Error(`El caller ID de Lucas ya pertenece al contacto ${phoneOwner.name}`);
    }

    const result = await this.db.from("contacts").upsert({
      name: this.contact.name,
      phone: this.contact.phone,
      email: this.contact.email,
      authorized: true,
      active: true,
    }, { onConflict: "phone" }).select("id").single();
    if (result.error) throw result.error;
    if (!result.data) throw new Error("Supabase no devolvio el contacto Lucas");
    return result.data.id as string;
  }

  private async upsertProviders(
    contacts: CounterpartyRow[],
    existingProviders: CounterpartyRow[],
  ): Promise<SeededProvider[]> {
    const seeded: SeededProvider[] = [];

    for (const fixture of this.providers) {
      const contactCollision = contacts.find((contact) => contact.phone === fixture.phone);
      if (contactCollision) {
        throw new Error(`El caller ID de ${fixture.name} ya pertenece al contacto ${contactCollision.name}`);
      }

      const candidates = existingProviders.filter((provider) => {
        const seedKey = provider.capabilities?.seed_key;
        return seedKey === fixture.seedKey
          || provider.name === fixture.name
          || provider.name === fixture.legacyName;
      });
      const phoneOwner = existingProviders.find((provider) => provider.phone === fixture.phone);
      if (phoneOwner && !candidates.some((candidate) => candidate.id === phoneOwner.id)) {
        throw new Error(
          `El caller ID de ${fixture.name} ya pertenece al transportista ${phoneOwner.name}`,
        );
      }
      if (new Set(candidates.map((candidate) => candidate.id)).size > 1) {
        throw new Error(`Hay multiples registros previos para ${fixture.name}; no se modificaron`);
      }

      const payload = {
        name: fixture.name,
        phone: fixture.phone,
        email: fixture.email,
        capabilities: { ...fixture.capabilities, seed_key: fixture.seedKey },
        active: true,
      };
      const existing = candidates[0] ?? phoneOwner;
      const query = existing
        ? this.db.from("providers").update(payload).eq("id", existing.id)
        : this.db.from("providers").insert(payload);
      const result = await query.select("id").single();
      if (result.error) throw result.error;
      if (!result.data) throw new Error(`Supabase no devolvio el transportista ${fixture.name}`);
      seeded.push({ ...fixture, id: result.data.id as string });
    }

    return seeded;
  }

  private async ensureOperation(contactId: string): Promise<OperationRow> {
    const fields = "id,reference,contact_id,current_mandate_id,status,container_type,"
      + "gross_weight_kg,pickup_location,delivery_location,empty_return_depot,"
      + "operational_constraints,cargo_notes";
    const existing = await this.db.from("operations").select(fields)
      .eq("reference", this.operation.reference).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) {
      const operation = existing.data as unknown as OperationRow;
      if (operation.contact_id !== contactId) {
        throw new Error(`La referencia ${this.operation.reference} pertenece a otro contacto`);
      }
      return operation;
    }

    const inserted = await this.db.from("operations").insert({
      reference: this.operation.reference,
      contact_id: contactId,
      status: "collecting_details",
      container_type: this.operation.container_type,
      gross_weight_kg: this.operation.gross_weight_kg,
      pickup_location: this.operation.pickup_location,
      delivery_location: this.operation.delivery_location,
      empty_return_depot: this.operation.empty_return_depot,
      operational_constraints: this.operation.operational_constraints,
      cargo_notes: this.operation.cargo_notes,
    }).select(fields).single();
    if (inserted.error) throw inserted.error;
    if (!inserted.data) throw new Error("Supabase no devolvio la operacion de demo");
    return inserted.data as unknown as OperationRow;
  }

  private async ensureMandate(operation: OperationRow, contactId: string): Promise<MandateRow> {
    if (operation.current_mandate_id) {
      return this.getMandate(operation.current_mandate_id);
    }

    const existingMandate = await this.db.from("mandates")
      .select("id,price_cap,currency,action_windows,minimum_payment_term_days")
      .eq("operation_id", operation.id).eq("version", 1).maybeSingle();
    if (existingMandate.error) throw existingMandate.error;

    let mandate = existingMandate.data as MandateRow | null;
    if (!mandate) {
      const realtimeCallId = `seed-mandate-${operation.reference.toLowerCase()}`;
      const existingCall = await this.db.from("calls").select("id")
        .eq("realtime_call_id", realtimeCallId).maybeSingle();
      if (existingCall.error) throw existingCall.error;

      let callId = existingCall.data?.id as string | undefined;
      if (!callId) {
        const startedAt = new Date(Date.now() - 60_000).toISOString();
        const callInsert = await this.db.from("calls").insert({
          operation_id: operation.id,
          contact_id: contactId,
          provider_id: null,
          operation_intent: "create",
          provider_intent: null,
          twilio_call_sid: `seed-twilio-${operation.reference.toLowerCase()}`,
          realtime_call_id: realtimeCallId,
          persona: "client",
          direction: "inbound",
          outcome: "completed",
          started_at: startedAt,
          ended_at: new Date().toISOString(),
        }).select("id").single();
        if (callInsert.error) throw callInsert.error;
        callId = callInsert.data?.id as string | undefined;
      }
      if (!callId) throw new Error("Supabase no devolvio la llamada del mandato");

      const pickupStart = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      const pickupEnd = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
      const mandateInsert = await this.db.from("mandates").insert({
        operation_id: operation.id,
        version: 1,
        supersedes_mandate_id: null,
        operation_snapshot: {
          container_type: operation.container_type,
          gross_weight_kg: Number(operation.gross_weight_kg),
          pickup_location: operation.pickup_location,
          delivery_location: operation.delivery_location,
          empty_return_depot: operation.empty_return_depot,
          operational_constraints: operation.operational_constraints,
          cargo_notes: operation.cargo_notes,
        },
        price_cap: 950_000,
        currency: "ARS",
        action_windows: [{
          start_at: pickupStart.toISOString(),
          end_at: pickupEnd.toISOString(),
        }],
        minimum_payment_term_days: 30,
        confirmed_in_call_id: callId,
        confirmed_at: new Date().toISOString(),
      }).select("id,price_cap,currency,action_windows,minimum_payment_term_days").single();
      if (mandateInsert.error) throw mandateInsert.error;
      if (!mandateInsert.data) throw new Error("Supabase no devolvio el mandato de demo");
      mandate = mandateInsert.data as MandateRow;
    }

    if (operation.status === "draft") {
      const collecting = await this.db.from("operations").update({ status: "collecting_details" })
        .eq("id", operation.id);
      if (collecting.error) throw collecting.error;
      operation.status = "collecting_details";
    }
    const operationUpdate = await this.db.from("operations").update({
      current_mandate_id: mandate.id,
      mandate_confirmation_required: false,
      status: operation.status === "collecting_details" ? "sourcing" : operation.status,
    }).eq("id", operation.id);
    if (operationUpdate.error) throw operationUpdate.error;
    operation.current_mandate_id = mandate.id;
    if (operation.status === "collecting_details") operation.status = "sourcing";
    return mandate;
  }

  private async getMandate(mandateId: string): Promise<MandateRow> {
    const result = await this.db.from("mandates")
      .select("id,price_cap,currency,action_windows,minimum_payment_term_days")
      .eq("id", mandateId).single();
    if (result.error) throw result.error;
    return result.data as MandateRow;
  }

  private async ensureQuoteScenarios(
    operation: OperationRow,
    mandate: MandateRow,
    providers: SeededProvider[],
  ): Promise<void> {
    const window = mandate.action_windows[0];
    if (!window) throw new Error("El mandato de demo no tiene una ventana de accion");
    const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    let receivedQuotes = 0;

    for (const provider of providers.filter((item) => item.seedKey.startsWith("demo-provider-"))) {
      const idempotencyKey = `seed:${operation.reference}:${provider.seedKey}:quote-request:v1`;
      const existingRequest = await this.db.from("quote_requests")
        .select("id,operation_id,provider_id,status")
        .eq("idempotency_key", idempotencyKey).maybeSingle();
      if (existingRequest.error) throw existingRequest.error;

      let requestId = existingRequest.data?.id as string | undefined;
      if (existingRequest.data) {
        if (
          existingRequest.data.operation_id !== operation.id
          || existingRequest.data.provider_id !== provider.id
        ) {
          throw new Error(`El pedido estable de ${provider.name} apunta a otro contexto`);
        }
      } else {
        const requestInsert = await this.db.from("quote_requests").insert({
          operation_id: operation.id,
          provider_id: provider.id,
          contact_attempt: 1,
          status: provider.quote ? "responded" : "pending",
          expires_at: expiresAt,
          idempotency_key: idempotencyKey,
        }).select("id").single();
        if (requestInsert.error) throw requestInsert.error;
        requestId = requestInsert.data?.id as string | undefined;
      }
      if (!requestId) throw new Error(`Supabase no devolvio el pedido de ${provider.name}`);
      if (!provider.quote) continue;

      if (existingRequest.data?.status !== "responded") {
        const requestUpdate = await this.db.from("quote_requests")
          .update({ status: "responded" }).eq("id", requestId);
        if (requestUpdate.error) throw requestUpdate.error;
      }

      const existingQuote = await this.db.from("quotes").select("id")
        .eq("quote_request_id", requestId).eq("version", 1).maybeSingle();
      if (existingQuote.error) throw existingQuote.error;
      if (!existingQuote.data) {
        const quoteInsert = await this.db.from("quotes").insert({
          quote_request_id: requestId,
          evaluated_mandate_id: mandate.id,
          version: 1,
          supersedes_quote_id: null,
          price_min: provider.quote.priceMin,
          price_max: provider.quote.priceMax,
          currency: mandate.currency,
          proposed_pickup_window: window,
          payment_term_days: mandate.minimum_payment_term_days,
          valid_until: expiresAt,
          conditions: provider.quote.conditions,
          verdict: provider.quote.verdict,
          status: "received",
        });
        if (quoteInsert.error) throw quoteInsert.error;
      }
      receivedQuotes += 1;
    }

    if (receivedQuotes > 0 && operation.status === "sourcing") {
      const statusUpdate = await this.db.from("operations")
        .update({ status: "quotes_received" }).eq("id", operation.id);
      if (statusUpdate.error) throw statusUpdate.error;
      operation.status = "quotes_received";
    }
  }

  private get db(): SupabaseClient {
    if (!this.client) throw new Error("Supabase no esta disponible en dry-run");
    return this.client;
  }
}

async function main(): Promise<void> {
  const client = dryRun
    ? null
    : createClient(requiredEnvironment("SUPABASE_URL"), requiredEnvironment("SUPABASE_SECRET_KEY"), {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
          detectSessionInUrl: false,
        },
      });
  await new DemoSeed(client).run();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`No se pudo ejecutar el seed: ${message}`);
  process.exitCode = 1;
});
