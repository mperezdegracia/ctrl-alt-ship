import assert from "node:assert/strict";
import type WebSocket from "ws";
import type { ClientFlowState, ClientOperationRepository } from "../../src/domain/client-operation-service";
import { ToolError } from "../../src/domain/tool-error";
import type { AcceptedRoutingDecision } from "../../src/tango/agents/routing-instructions";
import { AgentsCallSession } from "../../src/tango/realtime/agents-call-session";
import { CallToolFactory } from "../../src/tango/tools/call-tool-factory";
import { MockEscalationTool } from "../../src/tango/tools/mock-escalation-tool";

class FakeSocket extends EventTarget {
  readyState = 1;
  sent: Array<Record<string, any>> = [];
  send(raw: string): void { this.sent.push(JSON.parse(raw)); }
  close(): void { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  receive(event: Record<string, unknown>): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ event_id: `evt-${++eventSequence}`, ...event }) }));
  }
  output(callId: string) { return this.sent.find((event) => event.item?.call_id === callId)?.item; }
}
let eventSequence = 0;
const decision: AcceptedRoutingDecision = {
  action: "accept", callId: "rtc-test", twilioCallSid: "CAfixture", callerPhone: "+541100000000",
  identity: { persona: "client", contactId: "trusted-client", name: "Lucas", phone: "+541100000000", email: null, authorized: true, active: true },
  operations: [],
};
const scope = { callId: "trusted-db-call", realtimeCallId: "rtc-test", counterpartyId: "trusted-client", persona: "client" as const };
const reads = { isAuthorized: async () => true, listForClient: async () => [], listForProvider: async () => [] };
const terms = { price_cap: 950000, currency: "ARS", minimum_payment_term_days: 30,
  action_windows: [{ start_at: "2026-09-01T10:00:00-03:00", end_at: "2026-09-01T14:00:00-03:00" }] };

async function until(predicate: () => unknown): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(predicate(), "SDK did not produce expected result");
}

function invoke(socket: FakeSocket, name: string, args: unknown, callId: string, responseId = `r-${callId}`, finish = true) {
  socket.receive({ type: "response.created", response: { id: responseId, status: "in_progress", output: [] } });
  const event = { type: "response.output_item.done", response_id: responseId, output_index: 0,
    item: { type: "function_call", id: `item-${callId}`, call_id: callId, name, arguments: JSON.stringify(args), status: "completed" } };
  socket.receive(event);
  if (finish) socket.receive({ type: "response.done", response: { id: responseId, status: "completed", output: [event.item] } });
  return event;
}

async function main(): Promise<void> {
  let state: ClientFlowState = { profile: "client_entry", intent: "undecided", operation: null };
  const commands: Array<{ name: string; id: string; context: unknown }> = [];
  let failRefresh = false;
  const repository: ClientOperationRepository = {
    getState: async () => { if (failRefresh) throw new Error("private DB failure"); return structuredClone(state); },
    execute: async (trusted, name, id, args, context) => {
      assert.deepEqual(trusted, scope);
      commands.push({ name, id, context });
      if (name === "create_operation") state = {
        profile: "client_create", intent: "create", operationRevision: "revision-1", operation: {
          operation_reference: "OP-000123", status: "collecting_details", container_type: "40_dry",
          gross_weight_kg: null, pickup_location: null, delivery_location: null, empty_return_depot: null,
          cargo_notes: null, operational_constraints: [], missing_fields: ["gross_weight_kg"], mandate_confirmation_required: false,
        },
      };
      if (name === "update_operation") {
        state.profile = "client_confirm";
        state.operationRevision = "revision-2";
        state.operation!.missing_fields = [];
      }
      if (name === "confirm_mandate") {
        assert.deepEqual(args, terms);
        if (state.operation!.missing_fields.length) throw new ToolError("invalid_transition", "Complete missing operation fields first.");
        assert.deepEqual(context, { expected_operation_revision: "revision-2" });
        state.profile = "terminal";
        return { operation_reference: "OP-000123", status: "sourcing", mandate_version: 1, next_profile: "terminal" };
      }
      return { operation_reference: "OP-000123", status: "collecting_details", missing_fields: state.operation!.missing_fields,
        next_profile: state.profile as "client_create" | "client_confirm" };
    },
  };
  const toolSession = new CallToolFactory(reads, repository).create(scope);
  await toolSession.refresh();
  const socket = new FakeSocket();
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const record = (event: string, fields?: Record<string, unknown>) => {
    logs.push({ event, fields });
    if (event === "realtime.error") console.error(fields?.error);
  };
  const logger = { info: record, warn: record, error: record, debug: record };
  let connectedUrl = "";
  const call = new AgentsCallSession(decision, toolSession, logger, {}, {
    skipOpenEventListeners: true,
    createWebSocket: async ({ url, apiKey }) => {
      connectedUrl = url; assert.equal(apiKey, "fixture-key");
      return socket as unknown as WebSocket;
    },
  });
  let approvals = 0;
  call.session.on("tool_approval_requested", () => { approvals++; });
  const initial = await call.initialConfiguration();
  assert.equal(initial.model, "gpt-realtime-2.1");
  assert.equal(initial.audio?.output?.voice, "cedar");
  assert.equal(initial.parallel_tool_calls, false);
  assert.deepEqual(initial.reasoning, { effort: "low" });
  assert.deepEqual(initial.tools?.map((tool) => "name" in tool ? tool.name : "mcp"), ["list_open_operations", "create_operation", "update_operation"]);
  const createDefinition = initial.tools?.find((tool) => "name" in tool && tool.name === "create_operation");
  assert.ok(createDefinition && "parameters" in createDefinition);
  assert.deepEqual(createDefinition.parameters, toolSession.definitions.find((tool) => tool.name === "create_operation")?.parameters);
  await call.connect("rtc-test", "fixture-key");
  assert.equal(new URL(connectedUrl).searchParams.get("call_id"), "rtc-test");
  assert.equal(new URL(connectedUrl).searchParams.has("model"), false);
  assert.equal(socket.sent.filter((event) => event.type === "response.create").length, 1, "Greet first in English");
  assert.match(socket.sent.find((event) => event.type === "response.create")?.response.instructions, /Start this call in English/);
  assert.deepEqual(socket.sent.find((event) => event.type === "session.update")?.session, initial);

  const first = invoke(socket, "create_operation", { container_type: "40_dry" }, "original-create", "r-original-create", false);
  await until(() => socket.output("original-create"));
  assert.equal(commands[0].id, "original-create");
  let update = socket.sent.filter((event) => event.type === "session.update" && "tools" in event.session).at(-1)!;
  assert.deepEqual(update.session.tools.map((tool: { name: string }) => tool.name), ["update_operation", "confirm_mandate"]);
  assert.match(update.session.instructions, /First complete every missing operational field/);
  const outputIndex = socket.sent.findIndex((event) => event.item?.call_id === "original-create");
  assert.ok(socket.sent.indexOf(update) < outputIndex, "Update tools before sending result and continuing");
  socket.receive(first);
  await until(() => socket.sent.filter((event) => event.item?.call_id === "original-create").length === 2);
  assert.equal(commands.length, 1, "SDK replays original result without re-executing a hidden tool");
  socket.receive({ type: "response.done", response: { id: "r-original-create", status: "completed", output: [first.item] } });

  invoke(socket, "confirm_mandate", terms, "too-early");
  await until(() => socket.output("too-early"));
  assert.equal(JSON.parse(socket.output("too-early").output).code, "invalid_transition");
  invoke(socket, "update_operation", { changes: { gross_weight_kg: 24000 } }, "original-update");
  await until(() => socket.output("original-update"));
  invoke(socket, "confirm_mandate", terms, "original-confirm");
  await until(() => socket.output("original-confirm"));
  assert.equal(JSON.parse(socket.output("original-confirm").output).mandate_version, 1);
  assert.equal(approvals, 0, "No needsApproval or audio tracking required");
  update = socket.sent.filter((event) => event.type === "session.update" && "tools" in event.session).at(-1)!;
  assert.deepEqual(update.session.tools, []);
  assert.ok(call.session.history.length > 0, "SDK maintains history");
  assert.ok(logs.some((entry) => entry.event === "tool.completed"));
  assert.equal(logs.filter((entry) => entry.event === "realtime.error").length, 0, JSON.stringify(logs));
  call.session.close();

  // Provider scope and live escalation keep using the same SDK loop. The SDK
  // must send the result before a single supervisor farewell, without auto reply.
  const providerDecision: AcceptedRoutingDecision = { ...decision,
    identity: { persona: "provider", providerId: "provider-1", name: "Theo", phone: "+541100000001", email: null, active: true } };
  const providerTools = new CallToolFactory(reads).create({ ...scope, persona: "provider", counterpartyId: "provider-1" }, new MockEscalationTool(async () => {}));
  const providerSocket = new FakeSocket();
  let farewells = 0;
  const provider = new AgentsCallSession(providerDecision, providerTools, logger, { onEscalationReady: () => {
    assert.ok(providerSocket.output("escalation"));
    farewells++;
    provider.transport.requestResponse({ instructions: "Supervisor farewell" });
  } }, { skipOpenEventListeners: true, createWebSocket: async () => providerSocket as unknown as WebSocket });
  assert.deepEqual((await provider.initialConfiguration()).tools?.map((tool) => tool.type === "function" ? tool.name : "mcp"), ["list_provider_operations", "escalate"]);
  await provider.connect("rtc-provider", "fixture-key");
  invoke(providerSocket, "escalate", { reason: "Please contact supervisor", trigger: "explicit_human_request" }, "escalation");
  await until(() => providerSocket.output("escalation"));
  assert.equal(farewells, 1, providerSocket.output("escalation").output);
  assert.equal(providerSocket.sent.filter((event) => event.type === "response.create").length, 2, "Greeting plus exactly one farewell");
  provider.session.close();

  // A committed command must retain its success result if reloading the next
  // profile fails, while all server-side tools are explicitly removed.
  state = { profile: "client_entry", intent: "undecided", operation: null };
  const failingTools = new CallToolFactory(reads, repository).create(scope);
  await failingTools.refresh();
  const failureSocket = new FakeSocket();
  const failingCall = new AgentsCallSession(decision, failingTools, logger, {}, {
    skipOpenEventListeners: true, createWebSocket: async () => failureSocket as unknown as WebSocket,
  });
  await failingCall.connect("rtc-test", "fixture-key");
  failRefresh = true;
  invoke(failureSocket, "create_operation", {}, "committed-before-refresh-failure");
  await until(() => failureSocket.output("committed-before-refresh-failure"));
  assert.equal(JSON.parse(failureSocket.output("committed-before-refresh-failure").output).operation_reference, "OP-000123");
  assert.deepEqual(failureSocket.sent.filter((event) => event.type === "session.update" && "tools" in event.session).at(-1)!.session.tools, []);
  assert.ok(logs.some((entry) => entry.event === "tool.profile_refresh_failed"));
  failingCall.session.close();
  failRefresh = false;
  console.log("Agents Realtime harness passed: SIP, SDK tools/results/history/replay, dynamic mandate visibility, no approvals/evidence, terminal state and escalation. Mocked repository/socket; no PostgreSQL or live calls.");
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
