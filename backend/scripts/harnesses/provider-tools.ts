import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

import type { ToolCallScope } from "../../src/domain/call-flow";
import { ProviderQuoteService, type ProviderFlowState, type ProviderQuoteResult } from "../../src/domain/provider-quote-service";
import { ToolError, publicToolError } from "../../src/domain/tool-error";
import { ProviderQuoteInstructions } from "../../src/tango/agents/provider-quote-instructions";
import { SupabaseProviderQuoteRepository } from "../../src/tango/supabase/provider-quote-repository";
import { CallToolFactory } from "../../src/tango/tools/call-tool-factory";
import type { AcceptedRoutingDecision } from "../../src/tango/agents/routing-instructions";

const scope: ToolCallScope = {
  callId: "private-call", realtimeCallId: "rtc-test", persona: "provider", counterpartyId: "private-provider",
  direction: "outbound", purpose: "quote_request",
};
const operation = {
  operation_reference: "OP-000123", container_type: "40_dry", gross_weight_kg: 24000,
  pickup_location: "Terminal 4", delivery_location: "Pilar", empty_return_depot: "Dock Sud",
  operational_constraints: [], cargo_notes: null, currency: "ARS",
  pickup_window: { start_at: "2026-09-01T10:00:00-03:00", end_at: "2026-09-01T14:00:00-03:00" },
};
const target = {
  operation_revision: "private-revision", mandate_id: "private-mandate", quote_request_id: "private-request",
  round_id: "private-round", previous_quote_id: null,
};
const active = (): ProviderFlowState => ({
  flow: "provider_outbound", profile: "provider_quote", intent: "quote", operation, commandTarget: target,
  privatePriceLimit: { price_cap: 1_300_000, currency: "ARS" }, lastQuote: null, lastOffer: null,
});
const quote = { operation_reference: "OP-000123", price_range: { min: 1_100_000, max: 1_200_000 } };
const reads = { isAuthorized: async () => true, listForClient: async () => [], listForProvider: async () => [] };
const decision: AcceptedRoutingDecision = {
  action: "accept", outbound: true, direction: "outbound", purpose: "quote_request",
  callId: scope.realtimeCallId, callRecordId: scope.callId, quoteRequestId: target.quote_request_id,
  roundId: target.round_id, attempt: 1, twilioCallSid: "CAfixture", callerPhone: "+541100000000",
  identity: { persona: "provider", providerId: scope.counterpartyId, name: "Theo", phone: "+541100000000", email: null, active: true },
  operations: [],
};

class RpcFixture {
  state = active();
  requests: Array<{ name: string; args: Record<string, unknown> }> = [];
  result: ProviderQuoteResult = { operation_reference: "OP-000123", quote_version: 1, verdict: "contraoferta",
    reason_codes: ["price_outside_terms"], negotiation_remaining: true, negotiation_rounds_remaining: 3 };
  error: { code: string; message: string } | null = null;
  readonly repository = new SupabaseProviderQuoteRepository(createClient("https://fixture.example.com", "fixture", {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
      const name = String(input instanceof Request ? input.url : input).split("/").at(-1)!;
      const args = JSON.parse(String(init?.body)) as Record<string, unknown>;
      this.requests.push({ name, args });
      assert.ok(["get_provider_tool_state", "record_provider_offer", "stage_provider_quote_evidence", "execute_provider_quote_tool"].includes(name));
      const result = name === "get_provider_tool_state" ? this.state
        : name === "record_provider_offer" ? { status: "recorded" } : this.result;
      return new Response(JSON.stringify(this.error ?? result), { status: this.error ? 400 : 200, headers: { "Content-Type": "application/json" } });
    } },
  }));
}

async function main(): Promise<void> {
  const rpc = new RpcFixture();
  const tools = new CallToolFactory(reads, undefined, rpc.repository).create(scope);
  assert.equal(tools.definitions.length, 0);
  await tools.refresh();
  assert.deepEqual(tools.definitions.map((tool) => tool.name), ["create_quote", "decline_quote_request", "record_provider_offer"]);

  const contracts = JSON.parse(readFileSync(resolve(__dirname, "../../../contracts/tools.schema.json"), "utf8"));
  for (const definition of tools.definitions) {
    const expected = contracts.tools.find((item: { name: string }) => item.name === definition.name);
    assert.deepEqual(definition, { type: expected.type, name: expected.name, description: expected.description, parameters: expected.parameters });
  }
  for (const value of [null, [], {}, { ...quote, price_range: { min: 0, max: 10 } }, { ...quote, currency: "ARS" }]) {
    await assert.rejects(tools.execute("create_quote", value, { toolCallId: "invalid" }), (error) => error instanceof ToolError && error.code === "invalid_arguments");
  }
  assert.deepEqual(await tools.execute("record_provider_offer", { price_range: quote.price_range, currency: "ARS" }, { toolCallId: "offer-1" }), { status: "recorded" });
  assert.deepEqual(await tools.execute("create_quote", quote, { toolCallId: "quote-1", evidenceSegmentId: "segment-1" }), rpc.result);
  assert.deepEqual(rpc.requests.at(-1)?.args.p_context, target);
  assert.ok(rpc.requests.some((request) => request.name === "stage_provider_quote_evidence"));

  rpc.state = {
    ...active(), lastQuote: { quote_version: 1, verdict: "contraoferta", price_range: { ...quote.price_range, currency: "ARS" },
      negotiation_rounds_remaining: 3 },
  };
  await tools.refresh();
  const prompt = new ProviderQuoteInstructions(rpc.state);
  assert.match(prompt.build(), /PRICE DISCOVERY/);
  assert.doesNotMatch(prompt.context(), /private-mandate|private-request|private-revision/);
  assert.doesNotMatch(prompt.context(), /1_300_000/);

  rpc.state = { ...active(), profile: "terminal", operation: null, commandTarget: null, privatePriceLimit: null };
  await tools.refresh();
  assert.equal(tools.definitions.length, 0);
  assert.deepEqual(await tools.execute("create_quote", quote, { toolCallId: "quote-replay" }), rpc.result);
  assert.equal(rpc.requests.at(-1)?.args.p_context, null);
  rpc.error = { code: "XX000", message: "private mandate cap 999999" };
  await assert.rejects(tools.execute("create_quote", quote, { toolCallId: "failure" }), (error) => {
    assert.doesNotMatch(JSON.stringify(publicToolError(error)), /private|999999|mandate/);
    return true;
  });

  const clientScope: ToolCallScope = { callId: "client", realtimeCallId: "client-rtc", counterpartyId: "client", persona: "client", direction: "inbound", purpose: "operation_management" };
  await assert.rejects(new ProviderQuoteService(clientScope, rpc.repository).execute("create_quote", quote, "forged"), /authenticated provider/);

  const evidenceMigration = readFileSync(resolve(__dirname, "../../../supabase/migrations/20260830232200_quote_transcript_evidence.sql"), "utf8");
  const evidencePermissionsMigration = readFileSync(resolve(__dirname, "../../../supabase/migrations/20260830232400_fix_quote_evidence_staging_permissions.sql"), "utf8");
  assert.match(evidenceMigration, /quote_transcript_evidence/);
  assert.match(evidenceMigration, /bookings_assign_quote_evidence/);
  assert.match(evidencePermissionsMigration, /stage_provider_quote_evidence[\s\S]*SECURITY DEFINER/);
  console.log("Provider quote harness passed: outbound scope, trusted context, offer recording, quote replay, prompt isolation and evidence staging. Mocked RPC only.");
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
