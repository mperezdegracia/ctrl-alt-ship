import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// This harness creates its OWN disposable database. No ports, mounts, external
// network, app configuration or remote Supabase credentials are used.
const legacyEvidence = process.argv.includes("--legacy-evidence");
const root = resolve(__dirname, "../../..");
const container = `ctrl-alt-ship-price-${randomUUID()}`;
function docker(args: string[], input?: string): string {
  const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`Docker command failed (${args[0]}): ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout;
}
function sql(input: string): string {
  return docker(["exec", "-i", container, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], input);
}
async function main(): Promise<void> {
  let created = false;
  try {
    docker(["run", "--pull=never", "--rm", "-d", "--network", "none", "--name", container,
      "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:16-alpine"]);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const probe = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres"], { encoding: "utf8", timeout: 5_000 });
      const process = spawnSync("docker", ["exec", container, "cat", "/proc/1/comm"], { encoding: "utf8", timeout: 5_000 });
      // The image briefly runs a bootstrap server, then restarts it. Wait until
      // the entrypoint has exec'd the final postgres process, not that bootstrap.
      if (probe.status === 0 && process.stdout.trim() === "postgres") { ready = true; break; }
      await delay(250);
    }
    assert(ready, "Disposable PostgreSQL did not become ready");
    sql("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
    const migrations = readdirSync(resolve(root, "supabase/migrations")).filter((name) => name.endsWith(".sql")).sort();
    const repairName = "20260830232500_preserve_quote_immutability.sql";
    for (const name of migrations) {
      if (legacyEvidence && name === repairName) continue;
      const path = legacyEvidence && name === "20260830232200_quote_transcript_evidence.sql"
        ? resolve(__dirname, "legacy-quote-evidence.sql") : resolve(root, "supabase/migrations", name);
      try { sql(readFileSync(path, "utf8")); }
      catch (error) { throw new Error(`Migration ${name}: ${error instanceof Error ? error.message : "failed"}`); }
    }
    console.log(`Applied ${migrations.length} migrations to disposable PostgreSQL 16.`);
    const regression = readFileSync(resolve(__dirname, "above-budget-quotes.sql"), "utf8");
    if (legacyEvidence) {
      sql(regression.slice(0, regression.indexOf("\nDO $$")) + `
DO $$
DECLARE f jsonb; message text;
BEGIN
  f := pg_temp.price_fixture('OP-991099');
  BEGIN
    PERFORM pg_temp.submit_price(f,'reproduce','{"price_range":{"min":1200,"max":1200}}');
    RAISE EXCEPTION 'Expected original create_quote failure';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    GET STACKED DIAGNOSTICS message = MESSAGE_TEXT;
    ASSERT message='quotes is append-only', message;
  END;
  ASSERT NOT EXISTS (SELECT 1 FROM public.quotes WHERE quote_request_id=(f->>'request')::uuid), 'failed quote did not roll back';
END;
$$;
ROLLBACK;`);
      console.log("Reproduced original 55000 quotes is append-only with staged caller evidence.");
      sql(readFileSync(resolve(root, "supabase/migrations", repairName), "utf8"));
    }
    sql(regression);
    console.log("Above-budget quote SQL passed: explicit acceptance, immutable revisions, transcript evidence, replay, booking provenance and unchanged mandate.");
  } finally {
    if (created) docker(["rm", "-f", container]);
  }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
