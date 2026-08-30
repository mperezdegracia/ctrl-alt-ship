import dotenv from "dotenv";
import { resolve } from "node:path";

dotenv.config({ path: resolve(__dirname, "../../.env") });

function deploymentUrl(): URL {
  const raw = process.env.PUBLIC_BASE_URL?.trim() || "https://ctrl-alt-ship.onrender.com";
  const base = new URL(raw);
  if (base.protocol !== "https:") throw new Error("PUBLIC_BASE_URL debe usar HTTPS para el demo");
  return new URL("/health", base);
}

async function main(): Promise<void> {
  const healthUrl = deploymentUrl();
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => null) as { status?: unknown } | null;

  if (!response.ok || body?.status !== "ok") {
    throw new Error(`El runtime de demo no esta listo: ${response.status} ${JSON.stringify(body)}`);
  }

  console.log(`Runtime deployment check OK: ${healthUrl.origin}/health`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
