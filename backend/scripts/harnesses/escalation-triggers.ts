import assert from "node:assert/strict";

import { NegotiationStallTracker } from "../../src/tango/telephony/negotiation-stall-tracker";
import { MockEscalationTool } from "../../src/tango/tools/mock-escalation-tool";

async function main(): Promise<void> {
  const triggers: string[] = [];
  const tool = new MockEscalationTool(async (request) => { triggers.push(request.trigger); });

  await tool.execute({ trigger: "explicit_human_request", reason: "The provider asked for a person." });
  await tool.execute({ trigger: "outside_mandate", reason: "The requested pickup is outside the action window and has no alternative." });
  await assert.rejects(
    tool.execute({ trigger: "identity_concern", reason: "Not part of the trial trigger set." }),
    { code: "invalid_arguments" },
  );

  const stalled = new NegotiationStallTracker(3);
  assert.equal(stalled.recordCallerTurn(), false);
  assert.equal(stalled.recordCallerTurn(), false);
  assert.equal(stalled.recordCallerTurn(), true);
  stalled.recordProgress();
  assert.equal(stalled.recordCallerTurn(), false);

  assert.deepEqual(triggers, ["explicit_human_request", "outside_mandate"]);
  console.log("Escalation trigger harness passed.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
