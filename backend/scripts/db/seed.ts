import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { resolve } from "node:path";

dotenv.config({ path: resolve(__dirname, "../../.env") });

type SeedCounterparty = {
  role: "contact" | "provider";
  name: string;
  phone: string;
  email: string;
  capabilities?: Record<string, unknown>;
};

type ExistingCounterparty = {
  id: string;
  name: string;
  phone: string;
};

const E164_PHONE = /^\+[1-9][0-9]{7,14}$/;
const dryRun = process.argv.includes("--dry-run");

const demoOperation = {
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
  cargo_notes: "Palletized textile cargo. Demo price cap: ARS 950000.",
};

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Falta ${name} en el entorno`);
  }
  return value;
}

function environment(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

const counterparties: SeedCounterparty[] = [
  {
    role: "contact",
    name: "Lucas",
    phone: requiredEnvironment("SEED_CLIENT_PHONE"),
    email: environment("SEED_CLIENT_EMAIL", "lucasaffre@gmail.com"),
  },
  {
    role: "provider",
    name: "Transporte Sur",
    phone: requiredEnvironment("SEED_PROVIDER_1_PHONE"),
    email: environment("SEED_PROVIDER_1_EMAIL", "operaciones@transportesur.example.com"),
    capabilities: {
      service_areas: ["AMBA", "Buenos Aires"],
      equipment: ["40_dry"],
      responds_to_quotes: true,
    },
  },
  {
    role: "provider",
    name: "Logistica Ruta 3",
    phone: requiredEnvironment("SEED_PROVIDER_2_PHONE"),
    email: environment("SEED_PROVIDER_2_EMAIL", "trafico@logisticaruta3.example.com"),
    capabilities: {
      service_areas: ["AMBA", "Buenos Aires"],
      equipment: ["40_dry"],
      responds_to_quotes: true,
    },
  },
  {
    role: "provider",
    name: "Fletes del Plata",
    phone: requiredEnvironment("SEED_PROVIDER_3_PHONE"),
    email: environment("SEED_PROVIDER_3_EMAIL", "despacho@fletesdelplata.example.com"),
    capabilities: {
      service_areas: ["AMBA", "Buenos Aires"],
      equipment: ["40_dry"],
      responds_to_quotes: false,
      seed_scenario: "quote_timeout",
    },
  },
];

const judgePhone = process.env.SEED_JUDGE_PHONE?.trim();
if (judgePhone) {
  counterparties.push({
    role: "provider",
    name: environment("SEED_JUDGE_NAME", "Trial by Fire Judge"),
    phone: judgePhone,
    email: environment("SEED_JUDGE_EMAIL", "judge@example.com"),
    capabilities: {
      seed_scenario: "trial_by_fire",
      responds_to_quotes: true,
    },
  });
}

function validateCallerIds(fixtures: SeedCounterparty[]): void {
  const owners = new Map<string, SeedCounterparty>();

  for (const fixture of fixtures) {
    if (!E164_PHONE.test(fixture.phone)) {
      throw new Error(
        `${fixture.name}: caller ID invalido. Debe usar formato E.164, por ejemplo +5491100000001`,
      );
    }

    const existingOwner = owners.get(fixture.phone);
    if (existingOwner) {
      throw new Error(
        `Caller ID duplicado entre ${existingOwner.name} (${existingOwner.role}) y ${fixture.name} (${fixture.role})`,
      );
    }
    owners.set(fixture.phone, fixture);
  }
}

function maskedPhone(phone: string): string {
  return `${phone.slice(0, -4).replace(/[0-9]/g, "*")}${phone.slice(-4)}`;
}

function assertSafeExistingRows(
  fixtures: SeedCounterparty[],
  contacts: ExistingCounterparty[],
  providers: ExistingCounterparty[],
): void {
  const fixturesByPhone = new Map(fixtures.map((fixture) => [fixture.phone, fixture]));

  for (const row of contacts) {
    const fixture = fixturesByPhone.get(row.phone);
    if (!fixture) continue;
    if (fixture.role !== "contact") {
      throw new Error(`El caller ID de ${fixture.name} ya pertenece al cliente ${row.name}`);
    }
    if (fixture.name !== row.name) {
      throw new Error(`El caller ID de Lucas ya pertenece al contacto ${row.name}; no se sobrescribio`);
    }
  }

  for (const row of providers) {
    const fixture = fixturesByPhone.get(row.phone);
    if (!fixture) continue;
    if (fixture.role !== "provider") {
      throw new Error(`El caller ID del cliente ${fixture.name} ya pertenece al transportista ${row.name}`);
    }
    if (fixture.name !== row.name) {
      throw new Error(`El caller ID de ${fixture.name} ya pertenece al transportista ${row.name}; no se sobrescribio`);
    }
  }
}

async function main(): Promise<void> {
  validateCallerIds(counterparties);

  if (dryRun) {
    console.log("Seed valido (dry-run):");
    for (const fixture of counterparties) {
      console.log(`- ${fixture.role}: ${fixture.name} (${maskedPhone(fixture.phone)})`);
    }
    console.log(`- operation fixture: ${demoOperation.reference} (${demoOperation.companyName})`);
    return;
  }

  const supabase = createClient(
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

  const phones = counterparties.map((fixture) => fixture.phone);
  const [contactLookup, providerLookup] = await Promise.all([
    supabase.from("contacts").select("id,name,phone").in("phone", phones),
    supabase.from("providers").select("id,name,phone").in("phone", phones),
  ]);

  if (contactLookup.error) throw contactLookup.error;
  if (providerLookup.error) throw providerLookup.error;

  assertSafeExistingRows(
    counterparties,
    contactLookup.data as ExistingCounterparty[],
    providerLookup.data as ExistingCounterparty[],
  );

  const lucas = counterparties.find((fixture) => fixture.role === "contact");
  const providers = counterparties.filter((fixture) => fixture.role === "provider");
  if (!lucas) throw new Error("No se definio el contacto Lucas");

  const contactUpsert = await supabase
    .from("contacts")
    .upsert(
      {
        name: lucas.name,
        phone: lucas.phone,
        email: lucas.email,
        authorized: true,
        active: true,
      },
      { onConflict: "phone" },
    )
    .select("id,name,phone")
    .single();
  if (contactUpsert.error) throw contactUpsert.error;
  if (!contactUpsert.data) throw new Error("Supabase no devolvio el contacto creado");

  const providerUpsert = await supabase
    .from("providers")
    .upsert(
      providers.map((provider) => ({
        name: provider.name,
        phone: provider.phone,
        email: provider.email,
        capabilities: provider.capabilities,
        active: true,
      })),
      { onConflict: "phone" },
    )
    .select("id,name,phone");
  if (providerUpsert.error) throw providerUpsert.error;
  if (!providerUpsert.data) throw new Error("Supabase no devolvio los transportistas creados");

  const existingOperation = await supabase
    .from("operations")
    .select("id,reference,contact_id")
    .eq("reference", demoOperation.reference)
    .maybeSingle();
  if (existingOperation.error) throw existingOperation.error;
  if (existingOperation.data && existingOperation.data.contact_id !== contactUpsert.data.id) {
    throw new Error(
      `La referencia ${demoOperation.reference} ya pertenece a otro contacto; no se sobrescribio`,
    );
  }

  let operationReference = existingOperation.data?.reference;
  if (!operationReference) {
    const operationInsert = await supabase
      .from("operations")
      .insert({
        reference: demoOperation.reference,
        contact_id: contactUpsert.data.id,
        status: "collecting_details",
        container_type: demoOperation.container_type,
        gross_weight_kg: demoOperation.gross_weight_kg,
        pickup_location: demoOperation.pickup_location,
        delivery_location: demoOperation.delivery_location,
        empty_return_depot: demoOperation.empty_return_depot,
        operational_constraints: demoOperation.operational_constraints,
        cargo_notes: demoOperation.cargo_notes,
      })
      .select("id,reference")
      .single();
    if (operationInsert.error) throw operationInsert.error;
    if (!operationInsert.data) throw new Error("Supabase no devolvio la operacion de demo");
    operationReference = operationInsert.data.reference;
  }

  console.log(
    `Seed completo: ${contactUpsert.data.name}, ${providerUpsert.data.length} transportistas y operacion ${operationReference}.`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`No se pudo ejecutar el seed: ${message}`);
  process.exitCode = 1;
});
