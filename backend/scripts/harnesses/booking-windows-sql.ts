import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// This harness creates its OWN disposable database. No ports, mounts, external
// network, app configuration or remote Supabase credentials are used.
const root = resolve(__dirname, "../../..");
const container = `ctrl-alt-ship-booking-window-${randomUUID()}`;
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
    for (const name of migrations) {
      try { sql(readFileSync(resolve(root, "supabase/migrations", name), "utf8")); }
      catch (error) { throw new Error(`Migration ${name}: ${error instanceof Error ? error.message : "failed"}`); }
    }
    console.log(`Applied ${migrations.length} migrations to disposable PostgreSQL 16.`);
    sql(readFileSync(resolve(__dirname, "booking-windows.sql"), "utf8"));
    console.log("Booking window SQL passed: local full-day conversion, alternatives before escalation, same-call selection, refusal, direct-escalation guard, replay and immutable data.");
  } finally {
    if (created) docker(["rm", "-f", container]);
  }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
