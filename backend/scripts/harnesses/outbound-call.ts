import dotenv from "dotenv";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: resolve(__dirname, "../../.env") });

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Uso: npm run harness:outbound -- --to +54911XXXXXXX [--base-url http://localhost:3000]`);
  return value;
}

function argentinaMobileVariants(phone: string): string[] {
  if (!phone.startsWith("+54")) return [phone];
  if (phone.startsWith("+549")) return [phone, `+54${phone.slice(4)}`];
  return [phone, `+549${phone.slice(3)}`];
}

async function main(): Promise<void> {
  const to = argument("--to");
  const baseUrlIndex = process.argv.indexOf("--base-url");
  const baseUrl = (baseUrlIndex >= 0 ? process.argv[baseUrlIndex + 1] : "http://localhost:3000").replace(/\/$/, "");
  const token = process.env.OUTBOUND_CALLS_TOKEN;
  if (!token) throw new Error("Falta OUTBOUND_CALLS_TOKEN en backend/.env");
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Falta configuración Supabase en backend/.env");
  const database = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const provider = await database.from("providers").select("id,name,active")
    .in("phone", argentinaMobileVariants(to)).maybeSingle();
  if (provider.error) throw provider.error;
  if (!provider.data?.active) throw new Error(`No hay un Proveedor activo autorizado con teléfono ${to}`);
  const operation = await database.from("operations").select("id,reference").eq("reference", process.env.SEED_OPERATION_REFERENCE ?? "OP-900001").maybeSingle();
  if (operation.error || !operation.data) throw operation.error ?? new Error("No se encontró la operación de prueba");
  const response = await fetch(`${baseUrl}/calls/outbound`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ operation_id: operation.data.id, provider_id: provider.data.id, purpose: "quote_request" }),
  });
  const result = await response.text();
  if (!response.ok) throw new Error(`El endpoint devolvió ${response.status}: ${result}`);
  console.log(`Llamada iniciada a ${provider.data.name} para ${operation.data.reference}: ${result}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
