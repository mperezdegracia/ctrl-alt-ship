import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import OpenAI from "openai";
import type { RealtimeServerEvent } from "openai/resources/realtime/realtime";
import { OpenAIRealtimeGateway } from "../../src/tango/realtime/openai-realtime-gateway";

class FakeSocket extends EventEmitter {
  static instances: FakeSocket[] = [];
  readonly sent: string[] = [];
  failSend = false;
  constructor(readonly url: URL, readonly options: { headers: Record<string, string> }) {
    super();
    FakeSocket.instances.push(this);
  }
  send(value: string): void {
    if (this.failSend) throw new Error("simulated socket send failure");
    this.sent.push(value);
  }
  close(code: number, reason: string): void { this.emit("close", code, Buffer.from(reason)); }
}

async function main(): Promise<void> {
  const requests: Array<{ url: URL; body: unknown }> = [];
  let failureStatus: number | null = null;
  const client = new OpenAI({
    apiKey: "test-sdk-key", baseURL: "https://sdk.example.com/v1",
    fetch: async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-sdk-key");
      requests.push({ url, body: JSON.parse(String(init.body)) });
      if (failureStatus) return new Response(JSON.stringify({ error: { message: "simulated API failure", type: "api_error" } }), {
        status: failureStatus, headers: { "content-type": "application/json", "x-request-id": "req-failed" },
      });
      return new Response(null, { status: 200, headers: { "x-request-id": "req-ok" } });
    },
  });
  const gateway = new OpenAIRealtimeGateway(client);
  const configuration = { type: "realtime" as const, model: "gpt-realtime-2.1", instructions: "Test", tools: [] };
  assert.deepEqual(await gateway.accept("rtc_test/one", configuration), { status: 200, requestId: "req-ok" });
  assert.equal(requests[0].url.pathname, "/v1/realtime/calls/rtc_test%2Fone/accept");
  assert.deepEqual(requests[0].body, configuration);
  await gateway.reject("rtc_test/one");
  assert.equal(requests[1].url.pathname, "/v1/realtime/calls/rtc_test%2Fone/reject");
  assert.deepEqual(requests[1].body, { status_code: 603 });
  failureStatus = 500;
  const beforeFailure = requests.length;
  await assert.rejects(gateway.accept("rtc_failed", configuration), (error) =>
    error instanceof OpenAI.APIError && error.status === 500 && error.requestID === "req-failed");
  assert.equal(requests.length, beforeFailure + 1, "Do not silently retry call acceptance");
  failureStatus = 429;
  await assert.rejects(gateway.reject("rtc_failed"), (error) => error instanceof OpenAI.APIError && error.status === 429);
  assert.equal(requests.length, beforeFailure + 2, "Do not silently retry rejection");

  // Replace only the socket transport. The SDK's real URL construction,
  // authentication, event parser, typed emitter and serialization still execute.
  // No network socket is opened by this harness.
  const transport = require("ws") as { WebSocket: unknown };
  const original = transport.WebSocket;
  transport.WebSocket = FakeSocket;
  try {
    const realtime = gateway.connectSideband("rtc_sideband+test/1");
    const socket = FakeSocket.instances.at(-1)!;
    assert.ok(socket);
    assert.equal(realtime.socket, socket);
    assert.equal(socket.url.protocol, "wss:");
    assert.equal(socket.url.hostname, "sdk.example.com");
    assert.equal(socket.url.pathname, "/v1/realtime");
    assert.equal(socket.url.searchParams.get("call_id"), "rtc_sideband+test/1");
    assert.equal(socket.url.searchParams.has("model"), false);
    assert.equal(socket.options.headers.Authorization, "Bearer test-sdk-key");
    const events: RealtimeServerEvent[] = [];
    const errors: Error[] = [];
    let opened = false;
    let closed = false;
    realtime.on("event", (event) => events.push(event));
    realtime.on("error", (error) => errors.push(error));
    realtime.socket.on("open", () => { opened = true; });
    realtime.socket.on("close", () => { closed = true; });
    socket.emit("open");
    assert.equal(opened, true);
    const functionCall = { type: "response.function_call_arguments.done", call_id: "fn-original", name: "create_operation", arguments: "{}", event_id: "evt-test", response_id: "response-test", item_id: "item-test", output_index: 0 };
    socket.emit("message", Buffer.from(JSON.stringify(functionCall)));
    assert.deepEqual(events[0], functionCall);
    realtime.send({ type: "session.update", session: { type: "realtime", tools: [], instructions: "Updated flow" } });
    realtime.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "fn-original", output: JSON.stringify({ ok: true }) } });
    realtime.send({ type: "response.create" });
    assert.deepEqual(socket.sent.map((raw) => JSON.parse(raw).type), ["session.update", "conversation.item.create", "response.create"]);
    assert.equal(JSON.parse(socket.sent[1]).item.call_id, "fn-original");
    socket.emit("message", Buffer.from("invalid JSON"));
    assert.equal(errors.length, 1);
    socket.emit("message", Buffer.from(JSON.stringify({ type: "error", event_id: "evt-error", error: { type: "invalid_request_error", code: "invalid_value", message: "Test error" } })));
    assert.equal(errors.length, 2);
    socket.emit("error", new Error("Test transport error"));
    assert.equal(errors.length, 3);
    socket.failSend = true;
    realtime.send({ type: "response.create" });
    assert.equal(errors.length, 4);
    realtime.close();
    assert.equal(closed, true);
  } finally {
    transport.WebSocket = original;
  }
  console.log("Realtime SDK harness passed: accept/reject, no implicit retries, sideband events, tool outputs and errors; no real network calls.");
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
