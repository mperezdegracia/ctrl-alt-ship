import assert from "node:assert/strict";
import type WebSocket from "ws";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolCallScope } from "../../src/domain/call-flow";
import { ProviderQuoteService } from "../../src/domain/provider-quote-service";
import type { AcceptedRoutingDecision } from "../../src/tango/agents/routing-instructions";
import { AgentsCallSession } from "../../src/tango/realtime/agents-call-session";
import { SupabaseProviderQuoteRepository } from "../../src/tango/supabase/provider-quote-repository";
import { CallToolFactory } from "../../src/tango/tools/call-tool-factory";

class FakeSocket extends EventTarget {
  readyState = 1;
  sequence = 0;
  sent: Array<Record<string, any>> = [];
  send(raw: string): void { this.sent.push(JSON.parse(raw)); }
  close(): void { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  receive(event: Record<string, unknown>): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ event_id: `evt-${++this.sequence}`, ...event }) }));
  }
}

async function main(): Promise<void> {
  const scope: ToolCallScope = { persona: "provider", direction: "outbound", purpose: "quote_request",
    callId: "call-provider", realtimeCallId: "rtc-provider", counterpartyId: "provider" };
  let accepted = false;
  const executions: Record<string, unknown>[] = [];
  const result = { operation_reference: "OP-991001", quote_version: 3, verdict: "fuera",
    reason_codes: ["price_outside_terms"], negotiation_remaining: false, negotiation_rounds_remaining: 0,
    accepted_above_budget: true };
  const database = { rpc: async (name: string, args: Record<string, unknown>) => {
    if (name === "execute_provider_quote_tool") {
      executions.push(args);
      accepted = true;
      return { data: result, error: null };
    }
    assert.equal(name, "get_provider_tool_state");
    return { data: {
      flow: "provider_outbound", profile: accepted ? "terminal" : "provider_quote", intent: "quote",
      operation: { operation_reference: "OP-991001", container_type: null, gross_weight_kg: null,
        pickup_location: "Terminal 4", delivery_location: "Pilar", empty_return_depot: null,
        operational_constraints: [], cargo_notes: null, currency: "USD",
        pickup_window: { start_at: "2030-01-01T10:00:00Z", end_at: "2030-01-01T12:00:00Z" } },
      commandTarget: accepted ? null : { operation_revision: "revision", quote_request_id: "request", mandate_id: "mandate", round_id: "round", previous_quote_id: "first-quote" },
      privatePriceLimit: accepted ? null : { price_cap: 1000, currency: "USD" },
      lastQuote: { quote_version: accepted ? 3 : 2, verdict: "fuera",
        price_range: { min: 1200, max: 1200, currency: "USD" }, negotiation_rounds_remaining: 0,
        accepted_above_budget: accepted },
      lastOffer: null,
    }, error: null };
  } } as unknown as SupabaseClient;
  const repository = new SupabaseProviderQuoteRepository(database);
  const service = new ProviderQuoteService(scope, repository);
  for (const flag of [null, "true", 1, {}]) {
    await assert.rejects(service.execute("create_quote", { price_range: { min: 1200, max: 1200 }, accept_above_budget: flag }, "invalid"), { code: "invalid_arguments" });
    await assert.rejects(service.execute("create_quote", { price_range: { min: 1200, max: 1200 }, accept_above_budget: true, negotiation_stopped_by_provider: flag }, "invalid-stop"), { code: "invalid_arguments" });
  }
  await assert.rejects(service.execute("create_quote", { price_range: { min: 1200, max: 1200 }, negotiation_stopped_by_provider: true }, "stop-without-approval"), { code: "invalid_arguments" });
  await assert.rejects(service.execute("create_quote", { price_range: { min: 1200, max: 1200 }, accept_above_budget: true, currency: "ARS" }, "fixed-terms"), { code: "invalid_arguments" });
  await assert.rejects(service.recordOffer({ price_range: { min: 1200, max: 1200 }, accept_above_budget: true }, "observation"), { code: "invalid_arguments" });
  assert.equal(executions.length, 0, "Invalid approvals must not reach persistence");

  const reads = { isAuthorized: async () => true, listForClient: async () => [], listForProvider: async () => [] };
  const tools = new CallToolFactory(reads, undefined, repository).create(scope);
  await tools.refresh();
  const decision: AcceptedRoutingDecision = {
    action: "accept", outbound: true, direction: "outbound", purpose: "quote_request", callId: "rtc-provider",
    twilioCallSid: "CAfixture", callerPhone: "+541100000000", callRecordId: "call-provider",
    quoteRequestId: "request", roundId: "round", attempt: 1,
    identity: { persona: "provider", providerId: "provider", name: "Provider", phone: "+541100000000", email: null, active: true }, operations: [],
  };
  const socket = new FakeSocket();
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const call = new AgentsCallSession(decision, tools, logger, {}, {
    skipOpenEventListeners: true, createWebSocket: async () => socket as unknown as WebSocket,
  });
  const initial = await call.initialConfiguration();
  const quoteTool = initial.tools?.find((tool) => tool.type === "function" && tool.name === "create_quote");
  assert.ok(quoteTool && "parameters" in quoteTool);
  assert.ok((quoteTool.parameters as { properties: Record<string, unknown> }).properties.accept_above_budget);
  assert.match(initial.instructions!, /Do not demand a third discount/);
  await call.connect("rtc-provider", "fixture-key");
  const args = { price_range: { min: 1200, max: 1200 }, accept_above_budget: true };
  const item = { type: "function_call", id: "item-accept", call_id: "accept-quote", name: "create_quote", arguments: JSON.stringify(args), status: "completed" };
  socket.receive({ type: "response.created", response: { id: "response-accept", status: "in_progress", output: [] } });
  socket.receive({ type: "response.output_item.done", response_id: "response-accept", output_index: 0, item });
  socket.receive({ type: "response.done", response: { id: "response-accept", status: "completed", output: [item] } });
  for (let i = 0; i < 200 && !socket.sent.some((event) => event.item?.call_id === "accept-quote"); i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const output = socket.sent.find((event) => event.item?.call_id === "accept-quote");
  assert.ok(output, "SDK did not return the acceptance result");
  assert.deepEqual(JSON.parse(output.item.output), result, "The parser must preserve the explicit exception despite verdict fuera");
  assert.deepEqual(executions[0].p_arguments, args);
  assert.equal(executions[0].p_provider_id, "provider");
  assert.equal(tools.providerFlowState?.flow, "provider_outbound");
  assert.equal(tools.providerFlowState?.flow === "provider_outbound" && tools.providerFlowState.lastQuote?.accepted_above_budget, true);
  const updated = socket.sent.filter((event) => event.type === "session.update" && "tools" in event.session).at(-1)!;
  assert.deepEqual(updated.session.tools, [], "Accepted final price must stop forced bargaining");
  assert.ok(socket.sent.indexOf(updated) < socket.sent.indexOf(output));
  assert.match(updated.session.instructions, /saved quote is NOT proof/i);
  call.session.close();
  console.log("Above-budget quote SDK passed: explicit argument validation, safe scope, outside acceptance result, preserved context and terminal tools. Mocked database/socket; no live calls.");
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
