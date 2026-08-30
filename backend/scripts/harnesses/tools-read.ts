import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

import { OperationReadService, type ToolCallScope } from "../../src/domain/operation-read-service";
import { OperationName } from "../../src/domain/operation-name";
import { publicToolError, ToolError } from "../../src/domain/tool-error";
import { SupabaseOperationReadRepository } from "../../src/tango/supabase/operation-read-repository";
import { CallToolFactory } from "../../src/tango/tools/call-tool-factory";
import { ListProviderOperationsTool } from "../../src/tango/tools/list-operations-tool";

type Row = Record<string, unknown>;

// In-memory PostgREST transport. Exercises real repository filters and column
// projections without PostgreSQL, network calls, or mutations in Supabase.
class DatabaseFixture {
  readonly tables: Record<string, Row[]> = {
    contacts: [], providers: [], calls: [], operations: [], quote_requests: [], quotes: [], bookings: [],
  };
  readonly requests: string[] = [];
  failingTable: string | null = null;
  readonly client = createClient("https://tools.example.com", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      assert.equal(init?.method, "GET");
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const table = url.pathname.split("/").at(-1)!;
      assert.ok(table in this.tables);
      this.requests.push(table);
      if (table === this.failingTable) {
        return new Response(JSON.stringify({ message: "private database details price_cap=SECRET" }), { status: 400 });
      }
      let rows = [...this.tables[table]];
      for (const [column, filter] of url.searchParams) {
        if (["select", "order"].includes(column)) continue;
        if (filter.startsWith("eq.")) rows = rows.filter((row) => String(row[column]) === filter.slice(3));
        else if (filter.startsWith("in.(")) {
          const values = filter.slice(4, -1).split(",");
          rows = rows.filter((row) => values.includes(String(row[column])));
        } else if (filter.startsWith("not.in.(")) {
          const values = filter.slice(8, -1).split(",");
          rows = rows.filter((row) => !values.includes(String(row[column])));
        } else assert.fail(`Unhandled query filter: ${column} ${filter}`);
      }
      const selected = url.searchParams.get("select")!.split(",");
      assert.ok(!selected.includes("*"));
      const projected = rows.map((row) => Object.fromEntries(selected.map((key) => [key, row[key]])));
      return new Response(JSON.stringify(projected), { headers: { "Content-Type": "application/json" } });
    } },
  });
  readonly repository = new SupabaseOperationReadRepository(this.client);
  readonly factory = new CallToolFactory(this.repository);

  caller(persona: ToolCallScope["persona"], id: string): ToolCallScope {
    this.tables[persona === "client" ? "contacts" : "providers"].push({ id, active: true, authorized: true });
    const scope = { persona, callId: `call-${id}`, realtimeCallId: `rtc-${id}`, counterpartyId: id };
    this.tables.calls.push({ id: scope.callId, realtime_call_id: scope.realtimeCallId, persona,
      contact_id: persona === "client" ? id : null, provider_id: persona === "provider" ? id : null, outcome: "active" });
    return scope;
  }

  operation(id: string, contactId: string, status = "sourcing"): Row {
    const row = { id, reference: `OP-${id.padStart(6, "0")}`, contact_id: contactId, status,
      container_type: "40_dry", pickup_location: "Terminal 4", delivery_location: "Deposito",
      updated_at: "2026-08-29T00:00:00Z", price_cap: 950000, email: "private@example.com" };
    this.tables.operations.push(row);
    return row;
  }

  request(id: string, operationId: string, providerId: string, status = "pending", expiresAt = "2099-01-01T00:00:00Z") {
    this.tables.quote_requests.push({ id, operation_id: operationId, provider_id: providerId, status, expires_at: expiresAt });
  }

  booking(id: string, requestId: string, operationId: string, status: string) {
    this.tables.quotes.push({ id: `quote-${id}`, quote_request_id: requestId, price_cap: 950000 });
    this.tables.bookings.push({ id, quote_id: `quote-${id}`, operation_id: operationId, status });
  }
}

async function main(): Promise<void> {
  assert.equal(OperationName.fromRoute(" Terminal 4\n", " González Catán "), "Terminal 4 → González Catán");
  assert.equal(OperationName.fromRoute(null, null), "Origen pendiente → Destino pendiente");
  assert.equal(OperationName.fromRoute("  ", "Pilar"), "Origen pendiente → Pilar");
  const db = new DatabaseFixture();
  const clientA = db.caller("client", "a");
  const clientB = db.caller("client", "b");
  const provider = db.caller("provider", "p");
  const providerOther = db.caller("provider", "other");
  db.operation("1", "a", "collecting_details");
  db.operation("2", "b");
  db.operation("3", "a", "cancelled");
  db.operation("4", "a", "failed");
  const aTools = db.factory.create(clientA);
  const bTools = db.factory.create(clientB);
  const pTools = db.factory.create(provider);
  assert.deepEqual(aTools.definitions.map((tool) => tool.name), ["list_open_operations"]);
  assert.deepEqual(pTools.definitions.map((tool) => tool.name), ["list_provider_operations"]);
  const a = await aTools.execute("list_open_operations", {}) as { operations: Row[] };
  const b = await bTools.execute("list_open_operations", {}) as { operations: Row[] };
  assert.deepEqual(a.operations.map((op) => op.operation_reference), ["OP-000001"]);
  assert.equal(a.operations[0].operation_name, "Terminal 4 → Deposito");
  assert.deepEqual(b.operations.map((op) => op.operation_reference), ["OP-000002"]);
  const empty = db.caller("client", "empty");
  assert.deepEqual(await db.factory.create(empty).execute("list_open_operations", {}), { operations: [] });

  const contracts = JSON.parse(readFileSync(resolve(__dirname, "../../../contracts/tools.schema.json"), "utf8"));
  for (const definition of [...aTools.definitions, ...pTools.definitions]) {
    const contract = contracts.tools.find((tool: { name: string }) => tool.name === definition.name);
    assert.deepEqual(definition, { type: contract.type, name: contract.name, description: contract.description, parameters: contract.parameters });
  }

  for (const args of [null, [], "a", 1, { contact_id: "b" }, { provider_id: "other" }, { call_id: "call-b" }, { operation_reference: "OP-000002" }]) {
    for (const [registry, name] of [[aTools, "list_open_operations"], [pTools, "list_provider_operations"]] as const) {
      await assert.rejects(registry.execute(name, args), (error) => error instanceof ToolError && error.code === "invalid_arguments");
    }
  }
  await assert.rejects(aTools.execute("list_provider_operations", {}), /not available/);
  await assert.rejects(aTools.execute("get_operation_status", {}), /not available/);
  await assert.rejects(new ListProviderOperationsTool(new OperationReadService(clientA, db.repository)).execute({}), /not authorized/);

  db.tables.contacts[0].authorized = false;
  await assert.rejects(aTools.execute("list_open_operations", {}), /not authorized/);
  db.tables.contacts[0].authorized = true;
  db.tables.contacts[0].active = false;
  await assert.rejects(aTools.execute("list_open_operations", {}), /not authorized/);
  db.tables.contacts[0].active = true;
  db.tables.calls[0].outcome = "completed";
  await assert.rejects(aTools.execute("list_open_operations", {}), /not authorized/);
  db.tables.calls[0].outcome = "active";
  await assert.rejects(db.factory.create({ ...clientA, counterpartyId: "b" }).execute("list_open_operations", {}), /not authorized/);
  await assert.rejects(db.factory.create({ ...clientA, realtimeCallId: "rtc-other" }).execute("list_open_operations", {}), /not authorized/);

  // An active booking survives expiration/cancellation of its old request.
  db.request("r1", "1", "p");
  db.request("r2", "2", "p", "expired", "2020-01-01T00:00:00Z");
  db.booking("confirmed", "r2", "2", "confirmed");
  db.request("r3", "3", "p");
  db.request("r4", "4", "p");
  db.operation("5", "b");
  db.request("r5", "5", "other");
  db.booking("other", "r5", "5", "confirmed");
  db.operation("6", "b");
  db.request("r6", "6", "p", "pending", "2020-01-01T00:00:00Z");
  db.operation("7", "b");
  db.request("r7", "7", "p", "cancelled");
  db.booking("pending", "r7", "7", "pending");
  db.operation("8", "b");
  db.request("r8", "8", "p", "expired", "2020-01-01T00:00:00Z");
  db.booking("cancelled", "r8", "8", "cancelled");
  const p = await pTools.execute("list_provider_operations", {}) as { operations: Row[] };
  assert.equal(p.operations[0].operation_name, "Terminal 4 → Deposito");
  assert.deepEqual(p.operations.map((op) => [op.operation_reference, op.relationship]), [
    ["OP-000001", "quote_requested"], ["OP-000002", "booking_confirmed"], ["OP-000007", "booking_pending"],
  ]);
  const other = await db.factory.create(providerOther).execute("list_provider_operations", {}) as { operations: Row[] };
  assert.deepEqual(other.operations.map((op) => op.operation_reference), ["OP-000005"]);
  for (const result of [a, b, p, other]) {
    assert.doesNotMatch(JSON.stringify(result), /price_cap|950000|contact_id|provider_id|quote_id|email|private@|"id"/);
  }
  db.tables.providers[0].active = false;
  await assert.rejects(pTools.execute("list_provider_operations", {}), /not authorized/);
  db.tables.providers[0].active = true;
  db.tables.operations[0].pickup_location = null;
  await assert.rejects(pTools.execute("list_provider_operations", {}), /missing required/);
  // Client drafts may legitimately be incomplete; never invent defaults.
  const draft = await aTools.execute("list_open_operations", {}) as { operations: Row[] };
  assert.equal(draft.operations[0].pickup_location, null);
  assert.equal(draft.operations[0].operation_name, "Origen pendiente → Deposito");
  assert.equal(draft.operations[0].operation_reference, "OP-000001");
  db.failingTable = "operations";
  await assert.rejects(aTools.execute("list_open_operations", {}), (error) => {
    assert.doesNotMatch(JSON.stringify(publicToolError(error)), /private|price_cap|SECRET/);
    return true;
  });
  assert.ok(db.requests.length > 0);
  console.log("Read tools harness passed: contracts, call isolation, live authorization, provider relationships and safe outputs.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
