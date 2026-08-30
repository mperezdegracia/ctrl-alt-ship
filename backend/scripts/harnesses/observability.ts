import assert from "node:assert/strict";
import { StateTransitionLog } from "../../src/observability/state-transition-log";
import { CallToolSession } from "../../src/tango/tools/call-tool-session";
import { ClientOperationService, type ClientFlowState } from "../../src/domain/client-operation-service";
import { EscalationHandoffCoordinator } from "../../src/tango/telephony/escalation-handoff-coordinator";

async function main(): Promise<void> {
  const records: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const logger = {
    info: (event: string, fields?: Record<string, unknown>) => { records.push({ event, fields }); },
    error: (event: string, fields?: Record<string, unknown>) => { records.push({ event, fields }); },
  };
  let now = 0;
  const polling = new StateTransitionLog(logger, () => now);
  polling.observe("op", "decision", { reason: "waiting" });
  polling.observe("op", "decision", { reason: "waiting" });
  assert.equal(records.length, 1);
  now = 60_000;
  polling.observe("op", "decision", { reason: "waiting" });
  polling.observe("op", "decision", { reason: "booked" });
  assert.equal(records.length, 3);
  polling.retain([]);
  polling.observe("op", "decision", { reason: "booked" });
  assert.equal(records.length, 4);

  const state: ClientFlowState = { profile: "client_entry", intent: "undecided", operation: null };
  let fail = false;
  const service = new ClientOperationService({ persona: "client", callId: "call", realtimeCallId: "rtc", counterpartyId: "client", direction: "inbound", purpose: "operation_management" }, {
    getState: async () => { if (fail) throw new Error("fixture failure"); return state; },
    execute: async () => { throw new Error("Not expected"); },
  });
  const session = new CallToolSession([], service, undefined, undefined, logger);
  await session.refresh();
  assert.equal(records.at(-1)?.event, "tool.state_refreshed");
  assert.equal(records.at(-1)?.fields?.profile, "client_entry");
  fail = true;
  await assert.rejects(session.refresh(), /fixture failure/);
  assert.equal(records.at(-1)?.event, "tool.state_refresh_failed");
  assert.deepEqual(session.definitions, []);
  await assert.rejects(session.execute("create_operation", { notes: "private text" }, { toolCallId: "tc" }));
  assert.equal(records.at(-1)?.event, "tool.execution_failed");
  assert.ok(!JSON.stringify(records).includes("private text"));

  const transfer = new EscalationHandoffCoordinator({ refer: async () => ({ status: 200, requestId: "req" }) }, logger);
  await transfer.prepare({ realtimeCallId: "rtc", supervisorTargetUri: "tel:+5491132555829" });
  transfer.beginFarewell();
  transfer.observeResponseCreated("farewell");
  await transfer.onAudioStopped("unrelated");
  assert.equal(transfer.referAccepted, false);
  await transfer.onAudioStopped("farewell");
  assert.equal(transfer.referAccepted, true);
  assert.equal(records.at(-1)?.fields?.human_answer_confirmed, false);
  assert.ok(!JSON.stringify(records).includes("+5491132555829"));
  console.log("Observability harness passed: polling deduplication, state/command failures and transfer acceptance without claiming human answer. No network.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
