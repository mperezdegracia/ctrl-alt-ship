import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

import type { ToolCallScope } from "../../src/domain/call-flow";
import { ProviderBookingService, type ProviderBookingResult } from "../../src/domain/provider-booking-service";
import type { ProviderInboundState } from "../../src/domain/provider-call-state";
import { ToolError, publicToolError } from "../../src/domain/tool-error";
import { SupabaseProviderBookingRepository } from "../../src/tango/supabase/provider-booking-repository";
import { CallToolFactory } from "../../src/tango/tools/call-tool-factory";
import { MockEscalationTool } from "../../src/tango/tools/mock-escalation-tool";

const scope: ToolCallScope = {
  callId: "private-call", realtimeCallId: "rtc-booking", persona: "provider", counterpartyId: "private-provider",
  direction: "inbound", purpose: "booking_management",
};
const operation = { operation_reference: "OP-000123", container_type: "40_dry", gross_weight_kg: 24000,
  pickup_location: "Terminal 4", delivery_location: "Pilar", empty_return_depot: "Dock Sud", operational_constraints: [], cargo_notes: null };
const window = { start_at: "2026-09-01T10:00:00-03:00", end_at: "2026-09-01T14:00:00-03:00" };
const revised = { start_at: "2026-09-01T11:00:00-03:00", end_at: "2026-09-01T13:00:00-03:00" };
const target = { operation_revision: "private-operation-revision", booking_id: "private-booking", mandate_id: "private-mandate" };
const selected = { operation, pickup_window: window, confirmed_price: 850000, currency: "ARS", payment_term_days: 30, requires_reconfirmation: false };
const entry = (): ProviderInboundState => ({
  flow: "provider_inbound", profile: "provider_inbound_entry", intent: "undecided",
  bookings: [{ operation_reference: operation.operation_reference, pickup_location: operation.pickup_location, delivery_location: operation.delivery_location, pickup_window: window }],
  selectedBooking: null, commandTarget: null, lastResult: null,
});
const rescheduleState = (): ProviderInboundState => ({ ...entry(), profile: "provider_reschedule", intent: "reschedule", selectedBooking: selected, commandTarget: target });

class RpcFixture {
  state = entry();
  requests: Array<{ name: string; args: Record<string, unknown> }> = [];
  result: ProviderBookingResult = { status: "applied", reason_code: null, commitment_created: false };
  error: { code: string; message: string } | null = null;
  readonly repository = new SupabaseProviderBookingRepository(createClient("https://fixture.example.com", "fixture", {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
      const name = String(input instanceof Request ? input.url : input).split("/").at(-1)!;
      const args = JSON.parse(String(init?.body)) as Record<string, unknown>;
      this.requests.push({ name, args });
      assert.ok(["get_provider_tool_state", "select_provider_booking", "execute_provider_booking_tool"].includes(name));
      const result = name === "get_provider_tool_state" ? this.state
        : name === "select_provider_booking" ? { status: "selected", operation_reference: operation.operation_reference, intent: args.p_tool_name === "select_booking_for_cancellation" ? "cancel_booking" : "reschedule" }
        : this.result;
      return new Response(JSON.stringify(this.error ?? result), { status: this.error ? 400 : 200, headers: { "Content-Type": "application/json" } });
    } },
  }));
  create() { return new CallToolFactory({ isAuthorized: async () => true, listForClient: async () => [], listForProvider: async () => [] }, undefined, undefined, this.repository)
    .create(scope, new MockEscalationTool(async () => {})); }
}

async function main(): Promise<void> {
  const rpc = new RpcFixture();
  const tools = rpc.create();
  assert.equal(tools.definitions.length, 0);
  await tools.refresh();
  assert.deepEqual(tools.definitions.map((tool) => tool.name), ["list_provider_operations", "select_booking_for_reschedule", "select_booking_for_cancellation"]);
  assert.deepEqual(await tools.execute("list_provider_operations", {}), { operations: entry().bookings });
  await assert.rejects(tools.execute("select_booking_for_reschedule", { operation_reference: "invalid" }, { toolCallId: "invalid" }), (error) => error instanceof ToolError && error.code === "invalid_arguments");
  assert.deepEqual(await tools.execute("select_booking_for_reschedule", { operation_reference: operation.operation_reference }, { toolCallId: "select-1" }),
    { status: "selected", operation_reference: operation.operation_reference, intent: "reschedule" });

  rpc.state = rescheduleState();
  await tools.refresh();
  assert.deepEqual(tools.definitions.map((tool) => tool.name), ["escalate", "reschedule_booking"]);
  const request = { operation_reference: operation.operation_reference, reason: "Driver availability", proposed_pickup_window: revised };
  for (const value of [null, {}, { ...request, booking_id: "forged" }, { ...request, proposed_pickup_window: { start_at: revised.end_at, end_at: revised.start_at } }]) {
    await assert.rejects(tools.execute("reschedule_booking", value, { toolCallId: "invalid" }), (error) => error instanceof ToolError && error.code === "invalid_arguments");
  }
  assert.deepEqual(await tools.execute("reschedule_booking", request, { toolCallId: "change-1" }), rpc.result);
  assert.deepEqual(rpc.requests.at(-1)?.args.p_context, target);

  rpc.state = { ...rescheduleState(), profile: "terminal", commandTarget: null, selectedBooking: null };
  await tools.refresh();
  assert.equal(tools.definitions.length, 0);
  assert.deepEqual(await tools.execute("reschedule_booking", request, { toolCallId: "replay" }), rpc.result);
  assert.equal(rpc.requests.at(-1)?.args.p_context, null);
  rpc.error = { code: "XX000", message: "secret mandate cap 999999" };
  await assert.rejects(tools.execute("cancel_booking", { reason: "Driver unavailable" }, { toolCallId: "failure" }), (error) => {
    assert.doesNotMatch(JSON.stringify(publicToolError(error)), /secret|999999/);
    return true;
  });

  const clientScope: ToolCallScope = { callId: "client", realtimeCallId: "client-rtc", counterpartyId: "client", persona: "client", direction: "inbound", purpose: "operation_management" };
  await assert.rejects(new ProviderBookingService(clientScope, rpc.repository).execute("cancel_booking", { reason: "forged" }, "forged"), /authenticated provider/);
  const commandSql = readFileSync(resolve(__dirname, "../../../supabase/migrations/20260830222000_immutable_booking_commands.sql"), "utf8");
  assert.match(commandSql, /CREATE OR REPLACE FUNCTION public\.execute_provider_booking_tool/);
  const selectionSql = readFileSync(resolve(__dirname, "../../../supabase/migrations/20260830223000_provider_call_flow_isolation.sql"), "utf8");
  assert.match(selectionSql, /select_provider_booking/);
  console.log("Provider booking harness passed: inbound selection, scoped mutation, replay and private-error handling. Mocked RPC only.");
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
