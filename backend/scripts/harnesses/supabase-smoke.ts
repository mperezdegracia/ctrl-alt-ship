import dotenv from "dotenv";
import { resolve } from "node:path";

dotenv.config({ path: resolve(__dirname, "../../.env") });

const requiredEnvironment = ["SUPABASE_URL", "SUPABASE_SECRET_KEY"] as const;

for (const name of requiredEnvironment) {
  if (!process.env[name]) {
    throw new Error(`Falta ${name} en backend/.env`);
  }
}

const supabaseUrl = process.env.SUPABASE_URL!.replace(/\/$/, "");
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY!;
const domainTables: Array<{ table: string; primaryKey: string }> = [
  { table: "contacts", primaryKey: "id" },
  { table: "providers", primaryKey: "id" },
  { table: "operations", primaryKey: "id" },
  { table: "calls", primaryKey: "id" },
  { table: "mandates", primaryKey: "id" },
  { table: "quote_requests", primaryKey: "id" },
  { table: "quotes", primaryKey: "id" },
  { table: "bookings", primaryKey: "id" },
  { table: "change_requests", primaryKey: "id" },
  { table: "escalations", primaryKey: "id" },
  { table: "handoff_recipients", primaryKey: "id" },
  { table: "call_transcript_segments", primaryKey: "id" },
  { table: "events", primaryKey: "id" },
  { table: "outbox", primaryKey: "id" },
  { table: "email_previews", primaryKey: "outbox_id" },
];

async function assertTableIsReachable({ table, primaryKey }: { table: string; primaryKey: string }) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/${table}?select=${primaryKey}&limit=1`,
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

async function assertEmailOutboxRpcIsExposed() {
  // p_limit=0 is rejected before the function claims a job, so this verifies
  // the PostgREST function signature without changing the shared database.
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/claim_email_outbox`, {
    method: "POST",
    headers: {
      apikey: supabaseSecretKey,
      Authorization: `Bearer ${supabaseSecretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_limit: 0 }),
  });
  const payload = await response.json().catch(() => null) as { code?: unknown; message?: unknown } | null;
  if (response.status !== 400 || payload?.code !== "22023" || payload.message !== "invalid_email_outbox_limit") {
    throw new Error(`claim_email_outbox: esperaba 22023 sin mutar datos; obtuvo ${response.status} ${JSON.stringify(payload)}`);
  }
  console.log("✓ claim_email_outbox RPC");
}

async function main() {
  await Promise.all(domainTables.map(assertTableIsReachable));
  await assertEmailOutboxRpcIsExposed();
  console.log(`Supabase smoke test OK (${domainTables.length} tablas).`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
