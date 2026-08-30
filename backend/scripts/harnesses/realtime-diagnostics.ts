import assert from "node:assert/strict";
import type { SessionUpdatedEvent, SessionUpdateEvent } from "openai/resources/realtime/realtime";
import { RealtimeSessionDiagnostics } from "../../src/tango/realtime/realtime-session-diagnostics";

const records: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
const logger = {
  info: (event: string, fields: Record<string, unknown>) => records.push({ level: "info", event, fields }),
  warn: (event: string, fields: Record<string, unknown>) => records.push({ level: "warn", event, fields }),
};
const tools = [{ type: "function" as const, name: "update_operation" }, { type: "function" as const, name: "confirm_mandate" }];
const instructions = "Private caller name and price cap: 950000";
const diagnostics = new RealtimeSessionDiagnostics(logger, { tools: [], instructions: "Initial" }, "client_entry");
const serverTools = () => diagnostics.serverTools;
assert.equal(serverTools(), null);
const update: SessionUpdateEvent = { type: "session.update", session: { type: "realtime", tools, instructions } };
const requested = diagnostics.prepareUpdate(update, { profile: "client_confirm", intent: "create", operation: null }, "tool-1");
assert.ok(requested.event_id);
assert.equal(update.event_id, undefined, "Diagnostics must not mutate caller input");
assert.equal(requested.session, update.session, "Never change tools or instructions");
assert.equal(records.at(-1)!.fields.profile, "client_confirm");
assert.deepEqual(records.at(-1)!.fields.tools, ["update_operation", "confirm_mandate"]);
const ack: SessionUpdatedEvent = { type: "session.updated", event_id: "server-1", session: { type: "realtime", tools: [...tools].reverse(), instructions } };
diagnostics.observe(ack);
assert.equal(records.at(-1)!.fields.tools_match, true);
assert.equal(records.at(-1)!.fields.instructions_match, true);
assert.deepEqual(serverTools(), ["confirm_mandate", "update_operation"]);
serverTools()!.pop();
assert.equal(serverTools()!.length, 2, "Do not expose mutable diagnostic state");

diagnostics.observe({ ...ack, session: { type: "realtime", tools: [tools[0]], instructions: "Old prompt" } });
assert.equal(records.at(-1)!.event, "realtime.session_configuration_mismatch");
assert.equal(records.at(-1)!.fields.tools_match, false);
assert.equal(records.at(-1)!.fields.instructions_match, false);
assert.deepEqual(records.at(-1)!.fields.received_tools, ["update_operation"]);

const terminal = diagnostics.prepareUpdate({ type: "session.update", session: { type: "realtime", tools: [], instructions: "Done" } },
  { profile: "terminal", intent: "create", operation: null }, "tool-2");
assert.notEqual(terminal.event_id, requested.event_id);
// A delayed server event may refer to an older update; don't label it as the ACK
// for our newest event_id, or assume that order proves request/response pairing.
diagnostics.observe(ack);
assert.equal(records.at(-1)!.fields.comparison_basis, "latest_requested_configuration");
assert.equal(records.at(-1)!.fields.latest_update_sequence, 2);
assert.equal(records.at(-1)!.fields.server_event_id, "server-1");
diagnostics.observe({ ...ack, session: terminal.session });
assert.equal(records.at(-1)!.fields.tools_match, true);
assert.deepEqual(diagnostics.serverTools, []);

diagnostics.observe({ ...ack, session: { type: "realtime" } });
assert.equal(records.at(-1)!.fields.tools_match, null, "Missing is unknown, not an empty tool list");
assert.equal(records.at(-1)!.fields.instructions_match, null);
const isolated = new RealtimeSessionDiagnostics(logger, { tools: [], instructions: "Initial" }, "client_entry");
assert.equal(isolated.serverTools, null);

const serialized = JSON.stringify(records);
assert.doesNotMatch(serialized, /Private caller|950000|Old prompt|Initial/);
assert.match(serialized, /instructions_sha256/);
console.log("Realtime diagnostics harness passed: requested/observed tools, mismatches, missing fields, isolation and private prompt redaction.");
