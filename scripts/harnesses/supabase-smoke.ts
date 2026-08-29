import dotenv from "dotenv";
import { resolve } from "node:path";

dotenv.config({ path: resolve(__dirname, "../../backend/.env") });

const requiredEnvironment = ["SUPABASE_URL", "SUPABASE_SECRET_KEY"] as const;

for (const name of requiredEnvironment) {
  if (!process.env[name]) {
    throw new Error(`Falta ${name} en backend/.env`);
  }
}

const supabaseUrl = process.env.SUPABASE_URL!.replace(/\/$/, "");
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY!;
const domainTables = [
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
  "commitments",
  "events",
  "outbox",
];

async function assertTableIsReachable(table: string) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/${table}?select=id&limit=1`,
    {
      headers: {
        apikey: supabaseSecretKey,
        Authorization: `Bearer ${supabaseSecretKey}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      `${table}: Supabase respondió ${response.status} ${await response.text()}`
    );
  }

  console.log(`✓ ${table}`);
}

async function main() {
  await Promise.all(domainTables.map(assertTableIsReachable));
  console.log(`Supabase smoke test OK (${domainTables.length} tablas).`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
