import "dotenv/config";

import { createClient } from "@supabase/supabase-js";

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

  console.log(`Seed completo: ${contactUpsert.data.name} y ${providerUpsert.data.length} transportistas.`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`No se pudo ejecutar el seed: ${message}`);
  process.exitCode = 1;
});
