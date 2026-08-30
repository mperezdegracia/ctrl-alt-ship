import dotenv from "dotenv";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: resolve(__dirname, "../../.env") });

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Uso: npm run harness:provider-quote-call -- --to +54911XXXXXXX [--operation OP-900001] [--base-url http://localhost:3000]`);
  return value;
}

function argentinaMobileVariants(phone: string): string[] {
  if (!phone.startsWith("+54")) return [phone];
  if (phone.startsWith("+549")) return [phone, `+54${phone.slice(4)}`];
  return [phone, `+549${phone.slice(3)}`];
}

async function main(): Promise<void> {
  const to = argument("--to");
  const operationReference = process.argv.includes("--operation")
    ? argument("--operation")
    : process.env.SEED_OPERATION_REFERENCE ?? "OP-900001";
  const baseUrlIndex = process.argv.indexOf("--base-url");
  const baseUrl = (baseUrlIndex >= 0 ? process.argv[baseUrlIndex + 1] : "http://localhost:3000").replace(/\/$/, "");
  const token = process.env.OUTBOUND_CALLS_TOKEN;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!token || !url || !key) throw new Error("Faltan OUTBOUND_CALLS_TOKEN o credenciales Supabase en backend/.env");
  const database = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const provider = await database.from("providers").select("id,name,active")
    .in("phone", argentinaMobileVariants(to)).maybeSingle();
  if (provider.error) throw provider.error;
  if (!provider.data?.active) throw new Error(`No hay un proveedor activo autorizado con teléfono ${to}`);

  const operation = await database.from("operations")
    .select("id,reference,status,current_mandate_id,mandate_confirmation_required")
    .eq("reference", operationReference).maybeSingle();
  if (operation.error || !operation.data) throw operation.error ?? new Error(`No existe ${operationReference}`);
  if (!operation.data.current_mandate_id || operation.data.mandate_confirmation_required
    || !["sourcing", "quotes_received"].includes(operation.data.status)) {
    throw new Error(`${operationReference} debe tener un mandato vigente y estar en sourcing/quotes_received; no se altera el estado de una operación real desde este harness.`);
  }

  const existing = await database.from("quote_requests").select("id,status")
    .eq("operation_id", operation.data.id).eq("provider_id", provider.data.id)
    .eq("mandate_id", operation.data.current_mandate_id)
    .in("status", ["pending", "queued", "contacted"])
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (existing.error) throw existing.error;

  let quoteRequestId = existing.data?.id;
  if (!quoteRequestId) {
    const inserted = await database.from("quote_requests").insert({
      operation_id: operation.data.id,
      provider_id: provider.data.id,
      mandate_id: operation.data.current_mandate_id,
      contact_attempt: 1,
      status: "contacted",
      expires_at: "infinity",
      dispatched_at: new Date().toISOString(),
      idempotency_key: `harness:provider-quote:${operation.data.id}:${provider.data.id}:${operation.data.current_mandate_id}`,
    }).select("id").single();
    if (inserted.error || !inserted.data) throw inserted.error ?? new Error("No se pudo crear el quote request de prueba");
    quoteRequestId = inserted.data.id;
  }

  const response = await fetch(`${baseUrl}/calls/outbound`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ operation_id: operation.data.id, provider_id: provider.data.id, purpose: "quote_request" }),
  });
  const result = await response.text();
  if (!response.ok) throw new Error(`El endpoint devolvió ${response.status}: ${result}`);
  console.log(`Solicitud de quote ${quoteRequestId} preparada para ${provider.data.name} en ${operation.data.reference}: ${result}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
