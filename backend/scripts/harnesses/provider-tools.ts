import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type WebSocket from "ws";
import { ProviderQuoteService, type ProviderFlowState, type ProviderQuoteResult } from "../../src/domain/provider-quote-service";
import { ToolError, publicToolError } from "../../src/domain/tool-error";
import { SupabaseProviderQuoteRepository } from "../../src/tango/supabase/provider-quote-repository";
import { CallToolFactory } from "../../src/tango/tools/call-tool-factory";
import { ProviderQuoteInstructions } from "../../src/tango/agents/provider-quote-instructions";
import { RealtimeSessionFactory } from "../../src/tango/realtime/realtime-session";
import { AgentsCallSession } from "../../src/tango/realtime/agents-call-session";
import type { AcceptedRoutingDecision } from "../../src/tango/agents/routing-instructions";

const scope = { callId: "private-call", realtimeCallId: "rtc-test", persona: "provider" as const, counterpartyId: "private-provider" };
const operation = { operation_reference: "OP-000123", container_type: "40_dry", gross_weight_kg: 24000,
  pickup_location: "Terminal 4", delivery_location: "Pilar", empty_return_depot: "Dock Sud", operational_constraints: [], cargo_notes: null };
const target = { operation_revision: "private-revision", mandate_id: "private-mandate", quote_request_id: "private-request", previous_quote_id: null };
const entry = (): ProviderFlowState => ({ profile: "provider_inbound_entry", intent: "undecided", operation: null,
  candidates: [operation], commandTargets: { "OP-000123": target }, lastQuote: null });
const proposal = { operation_reference: "OP-000123", price_range: { min: 1100000, max: 1200000, currency: "ARS" },
  proposed_pickup_window: { start_at: "2026-09-01T10:00:00-03:00", end_at: "2026-09-01T14:00:00-03:00" },
  payment_term_days: 30, valid_until: "2026-09-01T09:00:00-03:00", conditions: { notes: [] } };
const reads = { isAuthorized: async () => true, listForClient: async () => [], listForProvider: async () => [] };
const decision: AcceptedRoutingDecision = { action: "accept", callId: "rtc-test", twilioCallSid: "CAfixture", callerPhone: "+541100000000",
  identity: { persona: "provider", providerId: scope.counterpartyId, name: "Theo", phone: "+541100000000", email: null, active: true }, operations: [] };

// Canned RPC responses test the REAL TypeScript/repository/SDK boundaries, not SQL execution.
class RpcFixture {
  state = entry();
  requests: Array<{ name: string; args: Record<string, any> }> = [];
  result: ProviderQuoteResult = { operation_reference: "OP-000123", quote_version: 1, verdict: "contraoferta",
    reason_codes: ["price_outside_terms"], negotiation_remaining: true, negotiation_rounds_remaining: 3 };
  error: { code: string; message: string } | null = null;
  failRead = false;
  readonly repository = new SupabaseProviderQuoteRepository(createClient("https://fixture.example.com", "fixture", {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
      const name = String(input instanceof Request ? input.url : input).split("/").at(-1)!;
      const args = JSON.parse(String(init?.body));
      this.requests.push({ name, args });
      assert.ok(["get_provider_tool_state", "execute_provider_quote_tool"].includes(name));
      assert.equal(args.p_provider_id, scope.counterpartyId);
      assert.equal(args.p_call_id, scope.callId);
      assert.equal(args.p_realtime_call_id, scope.realtimeCallId);
      const error = this.error ?? (this.failRead && name === "get_provider_tool_state" ? { code: "XX000", message: "private-error" } : null);
      return new Response(JSON.stringify(error ?? (name === "get_provider_tool_state" ? this.state : this.result)),
        { status: error ? 400 : 200, headers: { "Content-Type": "application/json" } });
    } },
  }));
}
class FakeSocket extends EventTarget {
  readyState = 1;
  sent: Array<Record<string, any>> = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
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
  const tools = new CallToolFactory(reads, undefined, rpc.repository).create(scope);
  assert.equal(tools.definitions.length, 0);
  await tools.refresh();
  assert.deepEqual(tools.definitions.map((tool) => tool.name), ["list_provider_operations", "create_quote", "decline_quote_request"]);
  const contract = JSON.parse(readFileSync(resolve(__dirname, "../../../contracts/tools.schema.json"), "utf8"));
  for (const tool of tools.definitions) {
    const expected = contract.tools.find((item: { name: string }) => item.name === tool.name);
    assert.deepEqual(tool, { type: expected.type, name: expected.name, description: expected.description, parameters: expected.parameters });
  }
  const before = rpc.requests.length;
  for (const args of [null, [], {}, { ...proposal, provider_id: "other" }, { ...proposal, verdict: "dentro" },
    { ...proposal, operation_reference: "forged" }, { ...proposal, conditions: {} },
    { ...proposal, conditions: { notes: ["", ""] } }, { ...proposal, conditions: { notes: ["x", "x"] } },
    { ...proposal, price_range: { ...proposal.price_range, max: 1 } },
    { ...proposal, price_range: { ...proposal.price_range, min: 0 } },
    { ...proposal, price_range: { ...proposal.price_range, max: 1e12 } },
    { ...proposal, price_range: { ...proposal.price_range, min: 1.001 } },
    { ...proposal, price_range: { ...proposal.price_range, currency: "ars" } },
    { ...proposal, payment_term_days: 1.5 }, { ...proposal, payment_term_days: -1 },
    { ...proposal, valid_until: "2026-02-30T00:00:00Z" }, { ...proposal, valid_until: "2026-09-01T09:00:00" },
    { ...proposal, proposed_pickup_window: { start_at: proposal.proposed_pickup_window.end_at, end_at: proposal.proposed_pickup_window.start_at } },
    { ...proposal, conditions: { notes: [], surcharge: 100 } }]) {
    await assert.rejects(tools.execute("create_quote", args, { toolCallId: "invalid" }), (error) => error instanceof ToolError && error.code === "invalid_arguments");
  }
  for (const args of [{}, { reason: "guessed" }, { reason: "other", details: " " }, { reason: "no_capacity", request_id: "other" }]) {
    await assert.rejects(tools.execute("decline_quote_request", args, { toolCallId: "invalid" }), /documented quote fields/);
  }
  await assert.rejects(tools.execute("create_quote", proposal), /documented quote fields/);
  assert.equal(rpc.requests.length, before);
  assert.deepEqual(await tools.execute("create_quote", proposal, { toolCallId: "quote-1" }), rpc.result);
  assert.deepEqual(rpc.requests.at(-1)!.args.p_context, target);
  assert.deepEqual(rpc.requests.at(-1)!.args.p_arguments, proposal);
  assert.equal(rpc.requests.at(-1)!.args.p_tool_call_id, "quote-1");

  rpc.state = { ...entry(), profile: "provider_quote", intent: "quote", operation,
    lastQuote: { quote_version: 1, verdict: "contraoferta", price_range: proposal.price_range, negotiation_rounds_remaining: 3 } };
  await tools.refresh();
  assert.deepEqual(tools.definitions.map((tool) => tool.name), ["create_quote", "decline_quote_request"]);
  await assert.rejects(tools.execute("list_provider_operations", {}), /not available/);
  const prompt = new RealtimeSessionFactory().create(decision, tools.definitions, undefined, rpc.state).instructions;
  assert.match(prompt, /You are Tango/);
  assert.doesNotMatch(prompt, /Volta|private-mandate|private-provider|private-request|private-revision|commandTargets/);
  assert.match(prompt, /Never reveal or use another carrier's quotes/);
  assert.match(prompt, /three revised proposals/);
  assert.match(prompt, /WAIT for the next caller turn/);
  assert.match(prompt, /never pushy or deceptive/);
  assert.match(prompt, /quote is NOT|NOT that it won/);
  const hostile = { ...rpc.state, secret: "secret-cap-999999", lastQuote: { ...rpc.state.lastQuote!, price_cap: "secret-cap-999999" },
    operation: { ...operation, contact_id: "private-contact" } };
  assert.doesNotMatch(new ProviderQuoteInstructions(hostile).context(), /secret-cap|private-contact|private-mandate/);
  // Reconnect restores the per-request round context rather than creating a fresh negotiation.
  const resumed = new CallToolFactory(reads, undefined, rpc.repository).create(scope);
  await resumed.refresh();
  assert.equal(resumed.providerFlowState?.lastQuote?.negotiation_rounds_remaining, 3);
  assert.equal(resumed.profile, "provider_quote");
  for (const [version, rounds] of [[2, 2], [3, 1], [4, 0]]) {
    rpc.result = { operation_reference: "OP-000123", quote_version: version, verdict: rounds ? "contraoferta" : "fuera",
      negotiation_remaining: Boolean(rounds), negotiation_rounds_remaining: rounds, reason_codes: ["price_outside_terms"] };
    assert.deepEqual(await tools.execute("create_quote", proposal, { toolCallId: `quote-${version}` }), rpc.result);
  }
  rpc.state = { ...rpc.state, profile: "terminal", commandTargets: {} };
  await tools.refresh();
  assert.equal(tools.definitions.length, 0);
  assert.deepEqual(await tools.execute("create_quote", proposal, { toolCallId: "quote-4" }), rpc.result, "Replay still reaches durable receipt");
  assert.equal(rpc.requests.at(-1)!.args.p_context, null);
  for (const code of ["not_authorized", "invalid_transition", "intent_locked", "operation_not_available", "stale_operation", "fixed_terms_conflict", "idempotency_conflict"]) {
    rpc.error = { code: "P0001", message: code };
    await assert.rejects(tools.execute("create_quote", proposal, { toolCallId: "failure" }), (error) => error instanceof ToolError && error.code === code);
  }
  rpc.error = { code: "XX000", message: "private mandate cap 999999" };
  await assert.rejects(tools.execute("create_quote", proposal, { toolCallId: "failure" }), (error) => {
    assert.doesNotMatch(JSON.stringify(publicToolError(error)), /private|999999|mandate/); return true;
  });
  rpc.error = null;
  rpc.state = { ...entry(), profile: "provider_unavailable", candidates: [], commandTargets: {} };
  await tools.refresh();
  assert.deepEqual(tools.definitions.map((tool) => tool.name), ["list_provider_operations"]);
  rpc.state = { ...rpc.state, intent: "quote", operation };
  await tools.refresh();
  assert.equal(tools.definitions.length, 0, "A bound unavailable/outbound request must not offer other operations");
  rpc.state = { ...entry(), profile: "provider_quote", intent: "quote", operation };
  await tools.refresh();
  rpc.result = { operation_reference: "OP-000123", quote_version: 2, verdict: "dentro",
    negotiation_remaining: false, negotiation_rounds_remaining: 0, reason_codes: [] };
  assert.deepEqual(await tools.execute("create_quote", proposal, { toolCallId: "accepted" }), rpc.result);
  rpc.state = { ...rpc.state, profile: "terminal" };
  await tools.refresh();
  assert.equal(tools.definitions.length, 0);
  rpc.failRead = true;
  await assert.rejects(tools.refresh());
  assert.equal(tools.definitions.length, 0);
  rpc.failRead = false;
  const disabled = new CallToolFactory(reads).create(scope);
  await assert.rejects(disabled.execute("create_quote", proposal), /not available/);
  const client = new CallToolFactory(reads, undefined, rpc.repository).create({ ...scope, persona: "client" });
  await assert.rejects(client.execute("create_quote", proposal), /not available/);
  await assert.rejects(new ProviderQuoteService({ ...scope, persona: "client" }, rpc.repository).execute("create_quote", proposal, "forged"), /authenticated provider/);

  // Same real SDK loop as production, simulated transport and RPC. Confirm
  // dynamic quote-only profile, terminal tools:[], and no approval requirement.
  rpc.state = entry();
  rpc.result = { operation_reference: "OP-000123", quote_version: 1, verdict: "contraoferta",
    reason_codes: ["price_outside_terms"], negotiation_remaining: true, negotiation_rounds_remaining: 3 };
  const sdkTools = new CallToolFactory(reads, undefined, rpc.repository).create(scope);
  await sdkTools.refresh();
  const socket = new FakeSocket();
  const logs: string[] = [];
  const log = (event: string) => { logs.push(event); };
  const call = new AgentsCallSession(decision, sdkTools, { info: log, warn: log, error: log, debug: log }, {}, {
    skipOpenEventListeners: true, createWebSocket: async () => socket as unknown as WebSocket,
  });
  let approvals = 0;
  call.session.on("tool_approval_requested", () => approvals++);
  await call.connect("rtc-test", "fixture-key");
  const invoke = (name: string, args: object, id: string) => {
    socket.receive({ type: "response.created", event_id: `e-${id}`, response: { id: `r-${id}`, status: "in_progress", output: [] } });
    const item = { type: "function_call", id: `item-${id}`, call_id: id, name, arguments: JSON.stringify(args), status: "completed" };
    socket.receive({ type: "response.output_item.done", event_id: `d-${id}`, response_id: `r-${id}`, output_index: 0, item });
    socket.receive({ type: "response.done", event_id: `f-${id}`, response: { id: `r-${id}`, status: "completed", output: [item] } });
  };
  rpc.state = { ...entry(), profile: "provider_quote", intent: "quote", operation };
  invoke("create_quote", proposal, "sdk-first");
  await until(() => socket.output("sdk-first"));
  assert.equal(JSON.parse(socket.output("sdk-first").output).negotiation_rounds_remaining, 3);
  assert.deepEqual(socket.sent.filter((event) => event.type === "session.update" && "tools" in event.session).at(-1)!.session.tools.map((tool: { name: string }) => tool.name), ["create_quote", "decline_quote_request"]);
  rpc.result = { status: "declined", commitment_created: false };
  rpc.state = { ...rpc.state, profile: "terminal", commandTargets: {} };
  invoke("decline_quote_request", { reason: "price_terms" }, "sdk-decline");
  await until(() => socket.output("sdk-decline"));
  assert.deepEqual(JSON.parse(socket.output("sdk-decline").output), rpc.result);
  const lastUpdate = socket.sent.filter((event) => event.type === "session.update" && "tools" in event.session).at(-1)!;
  assert.deepEqual(lastUpdate.session.tools, []);
  assert.ok(socket.sent.indexOf(lastUpdate) < socket.sent.findIndex((event) => event.item?.call_id === "sdk-decline"));
  assert.equal(approvals, 0);
  assert.ok(logs.includes("tool.completed"));
  call.session.close();

  // Static guards only. These assertions do NOT execute PostgreSQL/evaluation.
  const sql = readFileSync(resolve(__dirname, "../../../supabase/migrations/20260830070000_provider_quote_tools.sql"), "utf8");
  assert.match(sql, /negotiation_limit smallint NOT NULL DEFAULT 3/);
  assert.match(sql, /counteroffers_used < qr.negotiation_limit/);
  assert.match(sql, /WHERE prior.quote_request_id = qr.id AND prior.verdict = 'contraoferta'/);
  assert.match(sql, /persona = 'provider' AND outcome = 'active' FOR UPDATE/);
  assert.match(sql, /id = p_provider_id AND active FOR SHARE/);
  assert.match(sql, /qr.mandate_id IS DISTINCT FROM op.current_mandate_id/);
  assert.match(sql, /previous_quote.id::text IS DISTINCT FROM p_context->>'previous_quote_id'/);
  const transaction = sql.slice(sql.indexOf("CREATE FUNCTION public.execute_provider_quote_tool"));
  assert.ok(transaction.indexOf("RETURN receipt.result") < transaction.indexOf("IF c.provider_tools_completed_at"));
  assert.ok(sql.indexOf("RAISE EXCEPTION 'fixed_terms_conflict'") < sql.indexOf("INSERT INTO public.quotes"));
  assert.match(sql, /'dentro'::quote_verdict/);
  assert.match(sql, /'contraoferta'::quote_verdict ELSE 'fuera'::quote_verdict/);
  assert.doesNotMatch(sql, /INSERT INTO public\.(bookings|commitments|outbox)|email\.queued|provider_competing_quote|marketAlternatives/);
  const server = readFileSync(resolve(__dirname, "../../src/server.ts"), "utf8");
  assert.match(server, /new SupabaseProviderQuoteRepository\(supabaseAdmin\),/);
  assert.match(server, /provider_quote_tools_enabled: true/);
  assert.doesNotMatch(server, /environment\.PROVIDER_QUOTE_TOOLS_ENABLED|NegotiationStallTracker|stalledEscalationPending/);
  console.log("Provider harness passed: validation, trusted RPC context, profiles, multi-round response handling, Tango prompt isolation, reconnect, SDK quote/decline and terminal state. Mocked RPC/socket and static SQL checks; no PostgreSQL, real calls or emails.");
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
