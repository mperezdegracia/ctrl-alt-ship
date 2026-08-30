import assert from "node:assert/strict";
import OpenAI from "openai";

import { OpenAIRealtimeGateway } from "../../src/tango/realtime/openai-realtime-gateway";
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
  const logs: Array<{ level: "info" | "error"; event: string; fields: Record<string, unknown> }> = [];
  const gateway = new TwilioGateway({
    accountSid: "AC123",
    authToken: "token",
    fromNumber: "+14155550100",
    logger: {
      info: (event, fields) => logs.push({ level: "info", event, fields }),
      error: (event, fields) => logs.push({ level: "error", event, fields }),
    },
    fetch: fetchStub,
  });

  await gateway.transferCallToSupervisor({
    callSid: "CA123",
    to: "+5491100000000",
  });

  assert.equal(requests.length, 1);
  assertTwilioRequest(requests[0]!, "/Calls/CA123.json");
  const transferTwiml = new URLSearchParams(String(requests[0]!.init.body)).get("Twiml");
  assert.match(transferTwiml ?? "", /<Dial callerId="\+14155550100">/);
  assert.match(transferTwiml ?? "", /<Number>\+5491100000000<\/Number>/);
  assert.deepEqual(logs.map((entry) => [entry.level, entry.event, entry.fields.operation]), [
    ["info", "twilio.request_started", "transfer.dial_supervisor"],
    ["info", "twilio.request_succeeded", "transfer.dial_supervisor"],
  ]);

  await verifyConferenceGateway();
  await verifyFailureLogging();
  await verifyOpenAISipRefer();

  await verifyFarewellOrdering();
  await verifyMockEscalationTool();

  console.log("Escalation handoff harness passed.");
}

async function verifyOpenAISipRefer(): Promise<void> {
  let request: { callId: string; targetUri: string; options: unknown } | undefined;
  const client = {
    realtime: {
      calls: {
        refer: (callId: string, body: { target_uri: string }, options: unknown) => {
          request = { callId, targetUri: body.target_uri, options };
          return {
            withResponse: async () => ({
              response: new Response(null, { status: 200 }),
              request_id: "req_sip_refer",
            }),
          };
        },
      },
    },
  } as unknown as OpenAI;
  const gateway = new OpenAIRealtimeGateway(client);

  assert.deepEqual(
    await gateway.refer("rtc_123", "tel:+5491100000000"),
    { status: 200, requestId: "req_sip_refer" },
  );
  assert.deepEqual(request, {
    callId: "rtc_123",
    targetUri: "tel:+5491100000000",
    options: { maxRetries: 0, timeout: 10_000 },
  });
}

async function verifyConferenceGateway(): Promise<void> {
  const conferenceRequests: RequestRecord[] = [];
  const gateway = new TwilioGateway({
    accountSid: "AC123",
    authToken: "token",
    fromNumber: "+14155550100",
    fetch: async (url, init) => {
      conferenceRequests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ sid: "CF123", status: "queued" }), { status: 201 });
    },
  });

  await gateway.moveCallToConference({ callSid: "CA123", conferenceName: "escalation-esc-1" });
  await gateway.callSupervisorToConference({ conferenceName: "escalation-esc-1", to: "+5491100000000" });

  assert.equal(conferenceRequests.length, 2);
  assertTwilioRequest(conferenceRequests[0]!, "/Calls/CA123.json");
  assertTwilioRequest(conferenceRequests[1]!, "/Calls.json", {
    To: "+5491100000000",
    From: "+14155550100",
  });
  const callerTwiml = new URLSearchParams(String(conferenceRequests[0]!.init.body)).get("Twiml");
  const supervisorTwiml = new URLSearchParams(String(conferenceRequests[1]!.init.body)).get("Twiml");
  assert.equal(callerTwiml, "<Response><Dial><Conference>escalation-esc-1</Conference></Dial></Response>");
  assert.equal(supervisorTwiml, callerTwiml);
}

async function verifyFailureLogging(): Promise<void> {
  const logs: Array<{ level: "info" | "error"; event: string; fields: Record<string, unknown> }> = [];
  const gateway = new TwilioGateway({
    accountSid: "AC123",
    authToken: "token",
    fromNumber: "+14155550100",
    logger: {
      info: (event, fields) => logs.push({ level: "info", event, fields }),
      error: (event, fields) => logs.push({ level: "error", event, fields }),
    },
    fetch: async () => new Response(JSON.stringify({ code: 21211 }), { status: 400 }),
  });

  await assert.rejects(
    gateway.transferCallToSupervisor({ callSid: "CA123", to: "+5491100000000" }),
    /Twilio transfer\.dial_supervisor failed with status 400 \(code 21211\)/,
  );
  assert.deepEqual(logs, [
    {
      level: "info",
      event: "twilio.request_started",
      fields: {
        operation: "transfer.dial_supervisor",
        call_sid_suffix: "CA123",
        destination_phone_suffix: "0000",
      },
    },
    {
      level: "error",
      event: "twilio.request_failed",
      fields: {
        operation: "transfer.dial_supervisor",
        call_sid_suffix: "CA123",
        destination_phone_suffix: "0000",
        failure_kind: "http",
        http_status: 400,
        twilio_error_code: 21211,
      },
    },
  ]);
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
    async refer(realtimeCallId, targetUri) {
      actions.push(`${realtimeCallId}:${targetUri}`);
      return { status: 200, requestId: "req_sip_refer" };
    },
  });
  const handoff = {
    realtimeCallId: "rtc_123",
    supervisorTargetUri: "tel:+5491100000000",
  };

  await coordinator.prepare(handoff);
  assert.deepEqual(actions, []);
  coordinator.beginFarewell();
  assert.equal(coordinator.observeResponseCreated("resp-farewell"), true);
  assert.equal(coordinator.observeResponseCreated("resp-duplicate"), false);
  assert.equal(await coordinator.onAudioStopped("resp-other"), undefined);
  assert.deepEqual(await coordinator.onAudioStopped("resp-farewell"), {
    status: 200,
    requestId: "req_sip_refer",
    targetUri: "tel:+5491100000000",
  });
  assert.equal(await coordinator.onAudioStopped("resp-farewell"), undefined);
  assert.deepEqual(actions, ["rtc_123:tel:+5491100000000"]);
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
