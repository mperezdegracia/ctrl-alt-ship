import assert from "node:assert/strict";
import OpenAI from "openai";
import { OpenAIRealtimeGateway } from "../../src/tango/realtime/openai-realtime-gateway";

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

  console.log("OpenAI REST SDK harness passed: accept/reject, request IDs and no implicit retries; no network calls.");
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
