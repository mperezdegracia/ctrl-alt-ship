import assert from "node:assert/strict";

import { RealtimeSessionFactory } from "../../src/tango/realtime/realtime-session";
import type {
  CounterpartyIdentity,
  OperationContext,
} from "../../src/tango/supabase/erp";
import {
  routeIncomingCall,
  type IncomingCallEvent,
} from "../../src/tango/telephony/inbound-routing";
import { CallToolFactory } from "../../src/tango/tools/call-tool-factory";

const lucasPhone = "+5491163723502";
const providerPhone = "+5491132555829";
const unknownPhone = "+5491199999999";

const operation: OperationContext = {
  id: "11111111-1111-4111-8111-111111111111",
  reference: "OP-900001",
  name: "Terminal 4 → González Catán",
  status: "booking_confirmed",
  containerType: "40_dry",
  pickupLocation: "Terminal 4, Puerto de Buenos Aires",
  deliveryLocation: "Deposito Textiles del Plata, Gonzalez Catan",
  updatedAt: "2026-08-30T00:00:00.000Z",
};

const identities = new Map<string, CounterpartyIdentity>([
  [
    lucasPhone,
    {
      persona: "client",
      contactId: "22222222-2222-4222-8222-222222222222",
      name: "Lucas",
      phone: lucasPhone,
      email: "lucasaffre@gmail.com",
      authorized: true,
      active: true,
    },
  ],
  [
    providerPhone,
    {
      persona: "provider",
      providerId: "33333333-3333-4333-8333-333333333333",
      name: "Theo",
      phone: providerPhone,
      email: "operaciones@transportesur.example.com",
      active: true,
    },
  ],
]);

function eventFor(phone: string, suffix: string): IncomingCallEvent {
  return {
    id: `evt_${suffix}`,
    type: "realtime.call.incoming",
    data: {
      call_id: `rtc_${suffix}`,
      sip_headers: [
        { name: "From", value: `<sip:${phone}@pstn.twilio.com:5060>;tag=test` },
        { name: "P-Asserted-Identity", value: `<sip:${phone}@203.0.113.10:5060>` },
        { name: "X-Twilio-CallSid", value: `CA${suffix.padEnd(32, "0")}` },
      ],
    },
  };
}

const dependencies = {
  async findIdentity(phone: string) {
    return identities.get(phone) ?? null;
  },
  async listClientOperations(contactId: string) {
    assert.equal(contactId, "22222222-2222-4222-8222-222222222222");
    return [operation];
  },
  async listProviderOperations(providerId: string) {
    assert.equal(providerId, "33333333-3333-4333-8333-333333333333");
    return [operation];
  },
};

async function main(): Promise<void> {
  const client = await routeIncomingCall(eventFor(lucasPhone, "client"), dependencies);
  assert.equal(client.action, "accept");
  if (client.action === "accept") {
    assert.equal(client.identity.persona, "client");
    assert.equal(client.operations[0]?.reference, "OP-900001");

    const session = new RealtimeSessionFactory().create(
      client,
      new CallToolFactory({
        isAuthorized: async () => true,
        listForClient: async () => [],
        listForProvider: async () => [],
      }).create({
        callId: "test-call", realtimeCallId: "rtc_client", persona: "client",
        counterpartyId: client.identity.persona === "client" ? client.identity.contactId : "",
      }).definitions,
    );
    assert.deepEqual(session.tools.map((tool) => tool.name), ["list_open_operations"]);
    assert.equal(session.model, "gpt-realtime-2.1");
    assert.equal(session.reasoning.effort, "low");
    assert.equal(session.audio.output.voice, "cedar");
    assert.equal(session.audio.output.speed, 1.05);
    assert.match(session.instructions, /# CREATE FLOW/);
    assert.match(session.instructions, /OP-900001 · Terminal 4 → González Catán/);
    assertLanguagePolicy(session);
    assert.doesNotMatch(session.instructions, new RegExp(lucasPhone.replace("+", "\\+")));
    assert.doesNotMatch(session.instructions, /lucasaffre@gmail\.com/);
  }

  const provider = await routeIncomingCall(eventFor(providerPhone, "provider"), dependencies);
  assert.equal(provider.action, "accept");
  if (provider.action === "accept") {
    assert.equal(provider.identity.persona, "provider");
    assert.equal(provider.operations[0]?.reference, "OP-900001");

    const session = new RealtimeSessionFactory().create(provider, []);
    assert.match(session.instructions, /# QUOTE AND NEGOTIATION FLOW/);
    assert.match(session.instructions, /Never reveal the client's price cap/);
    assert.doesNotMatch(session.instructions, new RegExp(providerPhone.replace("+", "\\+")));
    assert.doesNotMatch(session.instructions, /operaciones@transportesur\.example\.com/);

    assertLanguagePolicy(session);
  }

  const unknown = await routeIncomingCall(eventFor(unknownPhone, "unknown"), dependencies);
  assert.deepEqual(unknown, {
    action: "reject",
    callId: "rtc_unknown",
    callerPhone: unknownPhone,
    reason: "unknown_caller",
  });

  console.log("Inbound routing harness passed: client, provider and unknown caller.");
}

function assertLanguagePolicy(session: ReturnType<RealtimeSessionFactory["create"]>): void {
  assert.match(session.instructions, /Always respond in the caller's language/);
  assert.match(session.instructions, /Wait for the caller to speak before your first response/);
  assert.match(session.instructions, /switch immediately without requiring a separate language request/);
  assert.match(session.instructions, /Do not infer it from their phone number/);
  assert.doesNotMatch(session.instructions, /first spoken message must be in English|Continue in English unless|Begin the call now in English/);
  assert.deepEqual(session.audio.input.turn_detection, {
    type: "server_vad", create_response: true, interrupt_response: true,
  });
  assert.equal("language" in session.audio.input.transcription, false);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
