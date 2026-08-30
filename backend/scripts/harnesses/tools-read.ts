import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ToolCallScope } from "../../src/domain/call-flow";
import { OperationName } from "../../src/domain/operation-name";
import type { OperationReadRepository } from "../../src/domain/operation-read-service";
import { ToolError } from "../../src/domain/tool-error";
import { CallToolFactory } from "../../src/tango/tools/call-tool-factory";

const clientA: ToolCallScope = {
  callId: "call-a", realtimeCallId: "rtc-a", persona: "client", counterpartyId: "a",
  direction: "inbound", purpose: "operation_management",
};
const clientB: ToolCallScope = { ...clientA, callId: "call-b", realtimeCallId: "rtc-b", counterpartyId: "b" };

class Reads implements OperationReadRepository {
  authorized = new Set(["call-a", "call-b"]);
  async isAuthorized(scope: ToolCallScope): Promise<boolean> {
    return this.authorized.has(scope.callId) && scope.callId === `call-${scope.counterpartyId}`;
  }
  async listForClient(contactId: string) {
    if (contactId === "a") return [{ operation_reference: "OP-000001", operation_name: OperationName.fromRoute("Terminal 4", "Deposito"),
      status: "collecting_details", container_type: "40_dry", pickup_location: "Terminal 4", delivery_location: "Deposito", updated_at: "2026-08-29T00:00:00Z" }];
    if (contactId === "b") return [{ operation_reference: "OP-000002", operation_name: OperationName.fromRoute("Pilar", "Escobar"),
      status: "sourcing", container_type: "20_dry", pickup_location: "Pilar", delivery_location: "Escobar", updated_at: "2026-08-29T00:00:00Z" }];
    return [];
  }
  async listForProvider() { return []; }
}

async function main(): Promise<void> {
  assert.equal(OperationName.fromRoute(" Terminal 4\n", " González Catán "), "Terminal 4 → González Catán");
  assert.equal(OperationName.fromRoute(null, null), "Origen pendiente → Destino pendiente");
  const reads = new Reads();
  const factory = new CallToolFactory(reads);
  const aTools = factory.create(clientA);
  const bTools = factory.create(clientB);
  assert.deepEqual(aTools.definitions.map((tool) => tool.name), ["list_open_operations"]);
  assert.deepEqual((await aTools.execute("list_open_operations", {}) as { operations: Array<{ operation_reference: string }> }).operations.map((row) => row.operation_reference), ["OP-000001"]);
  assert.deepEqual((await bTools.execute("list_open_operations", {}) as { operations: Array<{ operation_reference: string }> }).operations.map((row) => row.operation_reference), ["OP-000002"]);
  for (const value of [null, [], "a", { contact_id: "b" }]) {
    await assert.rejects(aTools.execute("list_open_operations", value), (error) => error instanceof ToolError && error.code === "invalid_arguments");
  }
  await assert.rejects(aTools.execute("list_provider_operations", {}), /not available/);

  const contract = JSON.parse(readFileSync(resolve(__dirname, "../../../contracts/tools.schema.json"), "utf8"));
  const definition = aTools.definitions[0]!;
  const expected = contract.tools.find((item: { name: string }) => item.name === definition.name);
  assert.deepEqual(definition, { type: expected.type, name: expected.name, description: expected.description, parameters: expected.parameters });

  reads.authorized.delete(clientA.callId);
  await assert.rejects(aTools.execute("list_open_operations", {}), /not authorized/);
  reads.authorized.add(clientA.callId);
  await assert.rejects(factory.create({ ...clientA, counterpartyId: "b" }).execute("list_open_operations", {}), /not authorized/);
  console.log("Read tools harness passed: client contract, call isolation, authorization and safe operation projections.");
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
