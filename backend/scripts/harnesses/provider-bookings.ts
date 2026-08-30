import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type WebSocket from "ws";
import type { ProviderFlowState } from "../../src/domain/provider-quote-service";
import { ProviderBookingService, type ProviderBookingResult } from "../../src/domain/provider-booking-service";
import { ToolError, publicToolError } from "../../src/domain/tool-error";
import { SupabaseProviderQuoteRepository } from "../../src/tango/supabase/provider-quote-repository";
import { SupabaseProviderBookingRepository } from "../../src/tango/supabase/provider-booking-repository";
import { CallToolFactory } from "../../src/tango/tools/call-tool-factory";
import { MockEscalationTool } from "../../src/tango/tools/mock-escalation-tool";
import { ProviderQuoteInstructions } from "../../src/tango/agents/provider-quote-instructions";
import { AgentsCallSession } from "../../src/tango/realtime/agents-call-session";
import type { AcceptedRoutingDecision } from "../../src/tango/agents/routing-instructions";

const scope = { callId: "private-call", realtimeCallId: "rtc-booking", persona: "provider" as const, counterpartyId: "private-provider" };
const operation = { operation_reference: "OP-000123", container_type: "40_dry", gross_weight_kg: 24000,
  pickup_location: "Terminal 4", delivery_location: "Pilar", empty_return_depot: "Dock Sud", operational_constraints: [], cargo_notes: null };
const window = { start_at: "2026-09-01T10:00:00-03:00", end_at: "2026-09-01T14:00:00-03:00" };
const revised = { start_at: "2026-09-01T11:00:00-03:00", end_at: "2026-09-01T13:00:00-03:00" };
const target = { operation_revision: "private-operation-revision", booking_revision: "private-booking-revision", booking_id: "private-booking", mandate_id: "private-mandate" };
const entry = (): ProviderFlowState => ({ profile: "provider_inbound_entry", intent: "undecided", operation: null,
  candidates: [], commandTargets: {}, lastQuote: null,
  bookingCandidates: [{ operation, pickup_window: window, confirmed_price: 850000, currency: "ARS", payment_term_days: 30, requires_reconfirmation: false }],
  bookingTargets: { "OP-000123": target } });
const reads = { isAuthorized: async () => true, listForClient: async () => [], listForProvider: async () => [] };
const decision: AcceptedRoutingDecision = { action: "accept", callId: scope.realtimeCallId, twilioCallSid: "CAfixture", callerPhone: "+541100000000",
  identity: { persona: "provider", providerId: scope.counterpartyId, name: "Theo", phone: "+541100000000", email: null, active: true }, operations: [] };

// Canned responses exercise real repository/service/SDK code, not PostgreSQL.
class RpcFixture {
  state = entry();
  requests: Array<{ name: string; args: Record<string, any> }> = [];
  result: ProviderBookingResult = { status: "applied", reason_code: null, commitment_created: false };
  error: { code: string; message: string } | null = null;
  failRead = false;
  private readonly client = createClient("https://fixture.example.com", "fixture-key", {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
      const name = String(input instanceof Request ? input.url : input).split("/").at(-1)!;
      const args = JSON.parse(String(init?.body));
      this.requests.push({ name, args });
      assert.ok(["get_provider_tool_state", "execute_provider_booking_tool"].includes(name));
      assert.equal(args.p_call_id, scope.callId); assert.equal(args.p_provider_id, scope.counterpartyId);
      assert.equal(args.p_realtime_call_id, scope.realtimeCallId);
      const error = this.error ?? (this.failRead && name === "get_provider_tool_state" ? { code: "XX000", message: "private error" } : null);
      return new Response(JSON.stringify(error ?? (name === "get_provider_tool_state" ? this.state : this.result)),
        { status: error ? 400 : 200, headers: { "Content-Type": "application/json" } });
    } },
  });
  readonly quotes = new SupabaseProviderQuoteRepository(this.client);
  readonly bookings = new SupabaseProviderBookingRepository(this.client);
  create() { return new CallToolFactory(reads, undefined, this.quotes, this.bookings).create(scope, new MockEscalationTool(async () => {})); }
}
class FakeSocket extends EventTarget {
  readyState = 1;
  sent: Array<Record<string, any>> = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  receive(event: object) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })); }
  output(id: string) { return this.sent.find((event) => event.item?.call_id === id)?.item; }
}
async function until(predicate: () => unknown) {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise<void>((done) => setImmediate(done));
  assert.ok(predicate());
}

async function main() {
  const rpc = new RpcFixture();
  const tools = rpc.create();
  const names = () => tools.definitions.map((tool) => tool.name);
  assert.deepEqual(names(), []);
  await tools.refresh();
  assert.deepEqual(names(), ["list_provider_operations", "escalate", "reschedule_booking", "cancel_booking"]);
  const contract = JSON.parse(readFileSync(resolve(__dirname, "../../../contracts/tools.schema.json"), "utf8"));
  for (const name of ["reschedule_booking", "cancel_booking"]) {
    const expected = contract.tools.find((tool: { name: string }) => tool.name === name);
    assert.deepEqual(tools.definitions.find((tool) => tool.name === name), {
      type: expected.type, name: expected.name, description: expected.description, parameters: expected.parameters,
    });
  }
  const base = { operation_reference: "OP-000123", reason: "Driver availability" };
  const reschedule = { ...base, proposed_pickup_window: revised };
  const before = rpc.requests.length;
  for (const name of ["reschedule_booking", "cancel_booking"]) {
    for (const args of [null, [], {}, { ...base, reason: " " }, { ...base, booking_id: "forged" },
      { ...base, operation_reference: "uuid" }, { ...base, price_cap: 1 }, { ...base, confirmed_price: 1 },
      { ...base, provider_id: "other" }, { ...base, confirmation: true }]) {
      await assert.rejects(tools.execute(name, args, { toolCallId: "invalid" }), (error) => error instanceof ToolError && error.code === "invalid_arguments");
    }
  }
  for (const proposed of [null, {}, [], { ...revised, timezone: "guess" }, { start_at: revised.end_at, end_at: revised.start_at },
    { start_at: "2026-02-30T00:00:00Z", end_at: "2026-03-02T00:00:00Z" }, { start_at: "2026-09-01T10:00:00", end_at: revised.end_at }]) {
    await assert.rejects(tools.execute("reschedule_booking", { ...base, proposed_pickup_window: proposed }, { toolCallId: "invalid" }), /Do not supply IDs/);
  }
  await assert.rejects(tools.execute("cancel_booking", reschedule, { toolCallId: "invalid" }), /Do not supply IDs/);
  await assert.rejects(tools.execute("cancel_booking", base), /Do not supply IDs/);
  assert.equal(rpc.requests.length, before);
  assert.deepEqual(await tools.execute("reschedule_booking", reschedule, { toolCallId: "change-1" }), rpc.result);
  assert.deepEqual(rpc.requests.at(-1)!.args.p_context, target);
  assert.deepEqual(rpc.requests.at(-1)!.args.p_arguments, reschedule);
  assert.equal(rpc.requests.at(-1)!.args.p_tool_call_id, "change-1");
  rpc.state = { ...entry(), profile: "terminal", intent: "reschedule", operation, bookingTargets: {}, bookingCandidates: [] };
  await tools.refresh();
  assert.deepEqual(names(), []);
  assert.deepEqual(await tools.execute("reschedule_booking", reschedule, { toolCallId: "change-1" }), rpc.result);
  assert.equal(rpc.requests.at(-1)!.args.p_context, null, "Replay after terminal must still reach SQL");
  assert.match(new ProviderQuoteInstructions(rpc.state).build(), /Only the confirmed booking's pickup window changed/);
  for (const code of ["not_authorized", "invalid_transition", "intent_locked", "operation_not_available", "stale_operation", "idempotency_conflict"]) {
    rpc.error = { code: "P0001", message: code };
    await assert.rejects(tools.execute("cancel_booking", base, { toolCallId: "blocked" }), (error) => error instanceof ToolError && error.code === code);
  }
  rpc.error = { code: "XX000", message: "secret mandate cap 9999999" };
  await assert.rejects(tools.execute("cancel_booking", base, { toolCallId: "blocked" }), (error) => {
    assert.doesNotMatch(JSON.stringify(publicToolError(error)), /secret|9999999/); return true;
  });
  rpc.error = null;
  rpc.state = { ...entry(), profile: "provider_booking_escalation", intent: "reschedule", operation };
  await tools.refresh();
  assert.deepEqual(names(), ["escalate"]);
  const instructions = new ProviderQuoteInstructions(rpc.state);
  assert.match(instructions.build(), /NOT applied/);
  assert.match(instructions.build(), /Only the available escalate tool/);
  assert.doesNotMatch(instructions.context(), /private-booking|private-provider|private-mandate|bookingTargets/);
  assert.match(new ProviderQuoteInstructions(entry()).build(), /do not reread unchanged price/);
  assert.match(new ProviderQuoteInstructions(entry()).build(), /do not ask the caller to confirm the timezone/);
  rpc.state = { ...entry(), profile: "provider_reschedule", intent: "reschedule", operation };
  await tools.refresh();
  assert.deepEqual(names(), ["escalate", "reschedule_booking"]);
  const resumed = rpc.create();
  await resumed.refresh();
  assert.equal(resumed.profile, "provider_reschedule");
  rpc.failRead = true;
  await assert.rejects(tools.refresh());
  assert.deepEqual(names(), []);
  rpc.failRead = false;
  const client = new CallToolFactory(reads, undefined, rpc.quotes, rpc.bookings).create({ ...scope, persona: "client" });
  await assert.rejects(client.execute("cancel_booking", base), /not available/);
  await assert.rejects(new ProviderBookingService({ ...scope, persona: "client" }, rpc.bookings, entry).execute("cancel_booking", base, "forged"), /authenticated provider/);

  // Real SDK round trips, fake socket/RPC: applied/declined mutation evidence is
  // NOT synthesized here. Outside-window result removes every mutation tool.
  for (const scenario of ["apply", "outside", "cancel"] as const) {
    rpc.state = entry();
    const sdkTools = rpc.create(); await sdkTools.refresh();
    const socket = new FakeSocket(); const noLog = () => {};
    const call = new AgentsCallSession(decision, sdkTools, { info: noLog, warn: noLog, error: noLog, debug: noLog }, {}, {
      skipOpenEventListeners: true, createWebSocket: async () => socket as unknown as WebSocket,
    });
    let approvals = 0; call.session.on("tool_approval_requested", () => approvals++);
    await call.connect(scope.realtimeCallId, "fixture-key");
    assert.ok(socket.sent.some((event) => event.type === "session.update"
      && /Do not ask the caller to confirm the timezone/.test(event.session.instructions ?? "")));
    rpc.result = scenario === "cancel" ? { booking_status: "cancelled", operation_status: "sourcing", commitment_created: false, client_email_queued: false }
      : { status: scenario === "outside" ? "requires_escalation" : "applied", reason_code: scenario === "outside" ? "outside_action_window" : null, commitment_created: false };
    rpc.state = { ...entry(), profile: scenario === "outside" ? "provider_booking_escalation" : "terminal",
      intent: scenario === "cancel" ? "cancel_booking" : "reschedule", operation };
    const item = { type: "function_call", id: `item-${scenario}`, call_id: scenario,
      name: scenario === "cancel" ? "cancel_booking" : "reschedule_booking", arguments: JSON.stringify(scenario === "cancel" ? base : reschedule), status: "completed" };
    socket.receive({ type: "response.created", event_id: `c-${scenario}`, response: { id: `r-${scenario}`, status: "in_progress", output: [] } });
    socket.receive({ type: "response.output_item.done", event_id: `i-${scenario}`, response_id: `r-${scenario}`, output_index: 0, item });
    socket.receive({ type: "response.done", event_id: `d-${scenario}`, response: { id: `r-${scenario}`, status: "completed", output: [item] } });
    await until(() => socket.output(scenario));
    assert.deepEqual(JSON.parse(socket.output(scenario).output), rpc.result);
    const update = socket.sent.filter((event) => event.type === "session.update" && "tools" in event.session).at(-1)!;
    assert.deepEqual(update.session.tools.map((tool: { name: string }) => tool.name), scenario === "outside" ? ["escalate"] : []);
    assert.ok(socket.sent.indexOf(update) < socket.sent.findIndex((event) => event.item?.call_id === scenario));
    assert.equal(approvals, 0); call.session.close();
  }
  // Static SQL regressions only; no PostgreSQL execution or concurrency proof.
  const sql = readFileSync(resolve(__dirname, "../../../supabase/migrations/20260830080000_provider_booking_changes.sql"), "utf8");
  const transaction = sql.slice(sql.indexOf("CREATE FUNCTION public.execute_provider_booking_tool"));
  assert.match(transaction, /persona = 'provider' AND outcome = 'active' FOR UPDATE/);
  assert.match(transaction, /qr.provider_id = p_provider_id AND bk.status = 'confirmed'/);
  assert.match(transaction, /p_context->>'booking_revision' IS DISTINCT FROM b.updated_at::text/);
  assert.ok(transaction.indexOf("RETURN receipt.result") < transaction.indexOf("IF c.provider_tools_completed_at"));
  assert.match(transaction, /UPDATE public.bookings SET pickup_window_start = start_time, pickup_window_end = end_time/);
  assert.doesNotMatch(transaction, /SET confirmed_price|INSERT INTO public\.(mandates|commitments|outbox)|DELETE FROM|email\.queued/);
  assert.match(transaction, /UPDATE public.operations SET status = 'sourcing'/);
  assert.match(transaction, /'client_email_queued', false/);
  assert.match(sql, /NEW.confirmed_price IS DISTINCT FROM OLD.confirmed_price/);
  assert.match(sql, /cr.previous_pickup_window/);
  assert.match(sql, /last_change_request_id/);
  console.log("Provider booking harness passed: validation, ownership context, replay, profiles, changed-only prompts, SDK reschedule/escalation/cancel and no notifications. Mocked RPC/socket; SQL checked statically, not executed.");
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
