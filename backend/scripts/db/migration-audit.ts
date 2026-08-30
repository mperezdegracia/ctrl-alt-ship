import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Migration = { file: string; sql: string };
export type MigrationLock = { baseline: string; migrations: Array<{ file: string; sha256: string }> };

/** Read-only static checks, deliberately independent of secrets and PostgreSQL. */
export class MigrationAudit {
  constructor(private readonly migrations: Migration[], private readonly lock: MigrationLock,
    private readonly schema: string, private readonly requiredRpcs: string[] = []) {}

  check(): string[] {
    const errors: string[] = [];
    const versions = new Set<string>();
    const byName = new Map(this.migrations.map((migration) => [migration.file, migration]));
    const lastLocked = this.lock.migrations.map((migration) => migration.file.slice(0, 14)).sort().at(-1) ?? "";
    for (const migration of this.migrations) {
      if (!/^\d{14}_[a-z0-9_]+\.sql$/.test(migration.file)) errors.push(`Invalid migration filename: ${migration.file}`);
      const version = migration.file.slice(0, 14);
      if (versions.has(version)) errors.push(`Duplicate version: ${version}`);
      versions.add(version);
      if (!this.lock.migrations.some((entry) => entry.file === migration.file) && version <= lastLocked) {
        errors.push(`New migration must follow ${lastLocked}: ${migration.file}`);
      }
    }
    for (const entry of this.lock.migrations) {
      const migration = byName.get(entry.file);
      if (!migration) errors.push(`Applied migration missing or renamed: ${entry.file}`);
      else if (createHash("sha256").update(migration.sql).digest("hex") !== entry.sha256) {
        errors.push(`Applied migration modified: ${entry.file}; add a forward migration instead`);
      }
    }
    const sql = [...this.migrations].sort((a, b) => a.file.localeCompare(b.file)).map((migration) => migration.sql).join("\n");
    const tables = (source: string) => {
      const result = new Set<string>();
      for (const match of source.matchAll(/\b(CREATE|DROP) TABLE (?:IF (?:NOT )?EXISTS )?(?:public\.)?(\w+)/gi)) {
        if (match[1].toUpperCase() === "CREATE") result.add(match[2]);
        else result.delete(match[2]);
      }
      return result;
    };
    const referenceTables = tables(this.schema);
    for (const table of tables(sql)) if (!referenceTables.has(table)) errors.push(`Reference schema missing table: ${table}`);
    for (const table of referenceTables) if (!tables(sql).has(table)) errors.push(`Reference table has no migration: ${table}`);
    const enumBody = (source: string) => source.match(/CREATE TYPE (?:public\.)?domain_event_type AS ENUM\s*\(([\s\S]*?)\);/i)?.[1] ?? "";
    const labels = (source: string) => [...source.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    const events = new Set(labels(enumBody(sql)));
    for (const match of sql.matchAll(/ALTER TYPE (?:public\.)?domain_event_type ADD VALUE (?:IF NOT EXISTS )?'([^']+)'/gi)) events.add(match[1]);
    const referenceEvents = new Set(labels(enumBody(this.schema)));
    for (const event of events) if (!referenceEvents.has(event)) errors.push(`Reference enum missing: ${event}`);
    for (const event of referenceEvents) if (!events.has(event)) errors.push(`Event not migrated: ${event}`);
    for (const match of sql.matchAll(/'((?:call|operation|mandate|sourcing|quote|booking|escalation|email|sms)\.[a-z_]+)'/g)) {
      if (!events.has(match[1])) errors.push(`Event used but not declared: ${match[1]}`);
    }
    const functions = new Set([...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?(\w+)\s*\(/gi)].map((match) => match[1]));
    for (const rpc of this.requiredRpcs) if (!functions.has(rpc)) errors.push(`Runtime RPC has no migration: ${rpc}`);
    return [...new Set(errors)];
  }
}

export function auditRepository(root: string): string[] {
  const read = (path: string) => readFileSync(resolve(root, path), "utf8");
  const migrations = readdirSync(resolve(root, "supabase/migrations")).filter((file) => file.endsWith(".sql"))
    .map((file) => ({ file, sql: read(`supabase/migrations/${file}`) }));
  const sources = ["backend/src/server.ts", ...readdirSync(resolve(root, "backend/src/tango/supabase"))
    .filter((file) => file.endsWith(".ts")).map((file) => `backend/src/tango/supabase/${file}`)];
  const rpcs = sources.flatMap((file) => [...read(file).matchAll(/\.rpc\("([a-z_]+)"/g)].map((match) => match[1]));
  // These dispatch through a variable in the client repository.
  rpcs.push("execute_client_operation_tool", "execute_client_cancellation_tool");
  return new MigrationAudit(migrations, JSON.parse(read("supabase/migrations.lock.json")), read("contracts/schema.sql"), rpcs).check();
}

if (require.main === module) {
  const errors = auditRepository(resolve(__dirname, "../../.."));
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log("Migration audit passed: immutable baseline, unique forward versions, tables, events and runtime RPC declarations. Static checks only.");
}
