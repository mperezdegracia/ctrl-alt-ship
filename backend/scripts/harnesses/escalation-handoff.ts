import assert from "node:assert/strict";

import { TwilioGateway } from "../../src/tango/telephony/twilio-gateway";
import { EscalationHandoffCoordinator } from "../../src/tango/telephony/escalation-handoff-coordinator";
import { MockEscalationTool } from "../../src/tango/tools/mock-escalation-tool";

type RequestRecord = Readonly<{
  url: string;
  init: RequestInit;
}>;

const requests: RequestRecord[] = [];
const fetchStub: typeof fetch = async (url, init) => {
  requests.push({ url: String(url), init: init ?? {} });
  return new Response(JSON.stringify({ sid: "CF123", status: "queued" }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
};

async function main(): Promise<void> {
  const gateway = new TwilioGateway({
    accountSid: "AC123",
    authToken: "token",
    fromNumber: "+14155550100",
    publicBaseUrl: "https://tango.example.com",
    fetch: fetchStub,
  });

  await gateway.sendSupervisorSummary({
    to: "+5491100000000",
    body: "Escalation OP-900001: outside_mandate. Review: https://tango.example.com/dashboard/operations/OP-900001",
  });

  await gateway.moveCallToConference({
    callSid: "CA123",
    conferenceName: "escalation-esc-1",
    statusCallbackUrl: "https://tango.example.com/twilio/conference-events",
    recordingStatusCallbackUrl: "https://tango.example.com/twilio/recording-events",
  });

  await gateway.addSupervisor({
    conferenceName: "escalation-esc-1",
    to: "+5491100000000",
    statusCallbackUrl: "https://tango.example.com/twilio/participant-events",
  });

  assert.equal(requests.length, 3);
  assertTwilioRequest(requests[0]!, "/Messages.json", {
    To: "+5491100000000",
    From: "+14155550100",
  });
  assert.match(new URLSearchParams(String(requests[0]!.init.body)).get("Body") ?? "", /Escalation OP-900001/);

  assertTwilioRequest(requests[1]!, "/Calls/CA123.json");
  const conferenceTwiml = new URLSearchParams(String(requests[1]!.init.body)).get("Twiml");
  assert.match(conferenceTwiml ?? "", /<Conference/);
  assert.match(conferenceTwiml ?? "", /escalation-esc-1/);
  assert.match(conferenceTwiml ?? "", /startConferenceOnEnter="true"/);
  assert.match(conferenceTwiml ?? "", /record="record-from-start"/);

  assertTwilioRequest(requests[2]!, "/Conferences/escalation-esc-1/Participants.json", {
    To: "+5491100000000",
    From: "+14155550100",
  });
  const participant = new URLSearchParams(String(requests[2]!.init.body));
  assert.equal(participant.get("StartConferenceOnEnter"), "false");
  assert.equal(participant.get("EndConferenceOnExit"), "true");

  await verifyFarewellOrdering();
  await verifyMockEscalationTool();

  console.log("Escalation Twilio gateway harness passed.");
}

async function verifyMockEscalationTool(): Promise<void> {
  let requested: { trigger: string; reason: string; operationReference?: string } | undefined;
  const tool = new MockEscalationTool(async (request) => { requested = request; });
  const result = await tool.execute({
    operation_reference: "OP-900001",
    trigger: "outside_mandate",
    reason: "The requested pickup window is outside the mandate.",
  });

  assert.deepEqual(result, { status: "started", supervisor_notified: true });
  assert.deepEqual(requested, {
    operationReference: "OP-900001",
    trigger: "outside_mandate",
    reason: "The requested pickup window is outside the mandate.",
  });
}

async function verifyFarewellOrdering(): Promise<void> {
  const actions: string[] = [];
  const coordinator = new EscalationHandoffCoordinator({
    async sendSupervisorSummary() { actions.push("sms"); },
    async addSupervisor() { actions.push("dial-supervisor"); },
    async moveCallToConference() { actions.push("move-provider"); },
  });
  const handoff = {
    callSid: "CA123",
    conferenceName: "escalation-esc-1",
    supervisorPhone: "+5491100000000",
    summary: "Escalation OP-900001: outside_mandate.",
    conferenceStatusCallbackUrl: "https://tango.example.com/twilio/conference-events",
    participantStatusCallbackUrl: "https://tango.example.com/twilio/participant-events",
    recordingStatusCallbackUrl: "https://tango.example.com/twilio/recording-events",
  };

  await coordinator.prepare(handoff);
  assert.deepEqual(actions, ["sms", "dial-supervisor"]);
  coordinator.beginFarewell();
  assert.equal(coordinator.observeResponseCreated("resp-farewell"), true);
  assert.equal(coordinator.observeResponseCreated("resp-duplicate"), false);
  assert.equal(await coordinator.onAudioStopped("resp-other"), false);
  assert.equal(await coordinator.onAudioStopped("resp-farewell"), true);
  assert.equal(await coordinator.onAudioStopped("resp-farewell"), false);
  assert.deepEqual(actions, ["sms", "dial-supervisor", "move-provider"]);
}

function assertTwilioRequest(request: RequestRecord, path: string, expected: Record<string, string> = {}): void {
  assert.equal(request.init.method, "POST");
  assert.match(request.url, new RegExp(`${path.replace(/[.?]/g, "\\$&")}$`));
  assert.equal(new Headers(request.init.headers).get("authorization"), "Basic QUMxMjM6dG9rZW4=");
  assert.equal(new Headers(request.init.headers).get("content-type"), "application/x-www-form-urlencoded");
  const body = new URLSearchParams(String(request.init.body));
  for (const [key, value] of Object.entries(expected)) assert.equal(body.get(key), value);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
