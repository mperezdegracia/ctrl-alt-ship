import assert from "node:assert/strict";

import { EscalationService, type CreatedEscalation, type EscalationRepository, type EscalationRequest } from "../../src/domain/escalation-service";
import type { ToolCallScope } from "../../src/domain/operation-read-service";
import { EscalationTool } from "../../src/tango/tools/mock-escalation-tool";

class Repository implements EscalationRepository {
  requests: Array<{ scope: ToolCallScope; request: EscalationRequest; toolCallId: string }> = [];
  result: CreatedEscalation = {
    escalationId: "11111111-1111-4111-8111-111111111111",
    operationReference: "OP-900001",
    handoffStatus: "pending",
    recipient: { id: "22222222-2222-4222-8222-222222222222", name: "Theo", phone: "+5491132555829", role: "supervisor" },
  };

  async create(scope: ToolCallScope, request: EscalationRequest, toolCallId: string): Promise<CreatedEscalation> {
    this.requests.push({ scope, request, toolCallId });
    return this.result;
  }
}

async function main(): Promise<void> {
  const repository = new Repository();
  const clientScope: ToolCallScope = { callId: "call-client", realtimeCallId: "rtc-client", persona: "client", counterpartyId: "client-1", direction: "inbound", purpose: "operation_management" };
  const providerScope: ToolCallScope = { callId: "call-provider", realtimeCallId: "rtc-provider", persona: "provider", counterpartyId: "provider-1", direction: "inbound", purpose: "booking_management" };
  const request = {
    operation_reference: "OP-900001",
    trigger: "explicit_human_request",
    reason: "The caller asked to continue with an operator.",
    summary: "Caller is upset about the current pickup arrangement and wants a person to take over.",
    requested_action: "Confirm the feasible pickup plan and take ownership of the conversation.",
  };

  const clientService = new EscalationService(clientScope, repository);
  const providerService = new EscalationService(providerScope, repository);
  await clientService.start(request, "tool-client");
  await providerService.start({ ...request, trigger: "outside_mandate" }, "tool-provider");
  assert.deepEqual(repository.requests.map(({ scope }) => scope.persona), ["client", "provider"]);
  assert.equal(repository.requests[0]?.request.summary, request.summary);
  await assert.rejects(
    clientService.start({ ...request, requested_action: "", private_phone: "+5491132555829" }, "invalid"),
    { code: "invalid_arguments" },
  );

  let prepared: CreatedEscalation | undefined;
  const tool = new EscalationTool(clientService, async (escalation) => {
    prepared = escalation;
    return true;
  });
  const result = await tool.execute(request, { toolCallId: "tool-visible" });
  assert.equal(prepared?.recipient?.phone, "+5491132555829");
  assert.deepEqual(result, {
    status: "started",
    operation_reference: "OP-900001",
    handoff_ready: true,
    handoff_status: "pending",
  });
  assert.doesNotMatch(JSON.stringify(result), /5829|escalationId|recipient/i);

  repository.result = { ...repository.result, handoffStatus: "not_configured", recipient: null };
  const unconfigured = new EscalationTool(clientService, async () => {
    throw new Error("A missing recipient must not attempt a transfer");
  });
  assert.deepEqual(await unconfigured.execute(request, { toolCallId: "tool-unconfigured" }), {
    status: "started",
    operation_reference: "OP-900001",
    handoff_ready: false,
    handoff_status: "not_configured",
  });

  console.log("Durable escalation harness passed: client/provider coverage, brief validation, private recipient data and unconfigured fallback.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
