import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { ClientFlowState, ClientMutationResult } from "../../src/domain/client-operation-service";
import type { ToolCallScope } from "../../src/domain/operation-read-service";
import { publicToolError, ToolError } from "../../src/domain/tool-error";
import { SupabaseClientOperationRepository } from "../../src/tango/supabase/client-operation-repository";
import { CallToolFactory } from "../../src/tango/tools/call-tool-factory";
import { RealtimeSessionFactory } from "../../src/tango/realtime/realtime-session";
import type { AcceptedRoutingDecision } from "../../src/tango/agents/routing-instructions";

const initialState = (): ClientFlowState => ({ profile: "client_entry", intent: "undecided", operation: null });
const selectedState = (complete = false): ClientFlowState => ({
  operationRevision: "2026-08-29 12:00:00.123456+00",
  profile: complete ? "client_confirm" : "client_create", intent: "create",
  operation: {
    operation_reference: "OP-000123", status: "collecting_details",
    container_type: "40_dry", gross_weight_kg: complete ? 24000 : null,
    pickup_location: "Terminal 4", delivery_location: complete ? "Pilar" : null,
    empty_return_depot: complete ? "Dock Sud" : null, operational_constraints: [], cargo_notes: null,
    missing_fields: complete ? [] : ["gross_weight_kg", "delivery_location", "empty_return_depot"],
    mandate_confirmation_required: false,
  },
});

// Canned RPC responses exercise the real service/repository/session boundaries.
// This harness does NOT execute SQL or prove PostgreSQL transactions/concurrency.
class RpcFixture {
  state = initialState();
  requests: Array<{ method: string; args: Record<string, unknown> }> = [];
  results: ClientMutationResult[] = [];
  error: { code: string; message: string } | null = null;
  failState = false;
  readonly repository = new SupabaseClientOperationRepository(createClient("https://rpc.example.com", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = url.pathname.split("/").at(-1)!;
      assert.equal(init?.method, "POST");
      const args = JSON.parse(String(init.body));
      this.requests.push({ method, args });
      const stateRead = method === "get_client_operation_tool_state";
      assert.ok(stateRead || method === "execute_client_operation_tool" || method === "execute_client_cancellation_tool");
      if (!stateRead) assert.equal(method, args.p_tool_name === "cancel_operation" ? "execute_client_cancellation_tool" : "execute_client_operation_tool");
      const error = this.error ?? (stateRead && this.failState ? { code: "XX000", message: "private SQL secret" } : null);
      if (error) return new Response(JSON.stringify(error), { status: 400 });
      const result = stateRead ? this.state : this.results.shift();
      assert.ok(result, "Missing canned mutation result");
      return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
    } },
  }));
}

const scope: ToolCallScope = { callId: "db-call", realtimeCallId: "rtc-live", persona: "client", counterpartyId: "db-client" };
const reads = { isAuthorized: async () => true, listForClient: async () => [], listForProvider: async () => [] };
const decision: AcceptedRoutingDecision = {
  action: "accept", callId: "rtc-live", twilioCallSid: "CAtest", callerPhone: "+541100000000",
  identity: { persona: "client", contactId: "db-client", name: "Test", phone: "+541100000000", email: null, authorized: true, active: true },
  operations: [],
};

function mutationResult(profile: "client_create" | "client_update" | "client_confirm" = "client_create"): Extract<ClientMutationResult, { missing_fields: string[] }> {
  return { operation_reference: "OP-000123", status: "collecting_details", missing_fields: ["gross_weight_kg"], next_profile: profile };
}

async function main(): Promise<void> {
  const rpc = new RpcFixture();
  const session = new CallToolFactory(reads, rpc.repository).create(scope);
  const names = () => session.definitions.map((tool) => tool.name);
  assert.deepEqual(names(), [], "No tools before persisted flow state loads");
  await session.refresh();
  assert.deepEqual(names(), ["list_open_operations", "create_operation", "update_operation", "cancel_operation"]);
  const contracts = JSON.parse(readFileSync(resolve(__dirname, "../../../contracts/tools.schema.json"), "utf8"));
  // Static migration regression only; this does not execute/validate PostgreSQL.
  const migration = readFileSync(resolve(__dirname, "../../../supabase/migrations/20260830020000_conversational_mandate_confirmation.sql"), "utf8");
  assert.doesNotMatch(migration, /p_context->'evidence'|RAISE EXCEPTION 'confirmation_not_ready'/);
  assert.match(migration, /expected_operation_revision/);
  assert.match(migration, /cardinality\(public.operation_missing_fields\(op\)\) <> 0/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /idempotency_conflict/);
  assert.match(migration, /client_tools_completed_at/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public.execute_client_operation_tool.*TO service_role/);
  const incrementalMigration = readFileSync(resolve(__dirname, "../../../supabase/migrations/20260830030000_incremental_mandate_confirmation.sql"), "utf8");
  assert.match(incrementalMigration, /IF c.operation_intent = 'update' THEN/);
  assert.match(incrementalMigration, /\) \|\| p_arguments;/);
  assert.match(incrementalMigration, /'action_windows', previous_mandate.action_windows/);
  assert.match(incrementalMigration, /mandate_terms->>'price_cap'/);
  assert.match(incrementalMigration, /VALUES \(c.id, p_tool_call_id, p_tool_name, p_arguments, result\)/);
  assert.match(incrementalMigration, /'operationChanges', changed_fields/);
  for (const definition of session.definitions) {
    const contract = contracts.tools.find((tool: { name: string }) => tool.name === definition.name);
    assert.deepEqual(definition, { type: contract.type, name: contract.name, description: contract.description, parameters: contract.parameters });
  }

  const countBeforeInvalid = rpc.requests.length;
  for (const args of [null, [], 4, { id: "fake" }, { contact_id: "other" }, { name: "fake" }, { reference: "OP-999999" },
    { price_cap: 10 }, { cargo_notes: null }, { container_type: " " }, { gross_weight_kg: 0 },
    { gross_weight_kg: NaN }, { gross_weight_kg: Infinity }, { gross_weight_kg: 0.0001 }, { gross_weight_kg: 1e12 },
    { operational_constraints: ["a", "a"] }, { operational_constraints: [null] }, { operational_constraints: "a" }]) {
    await assert.rejects(session.execute("create_operation", args, { toolCallId: "fn-invalid" }), (error) => error instanceof ToolError && error.code === "invalid_arguments");
  }
  for (const args of [{}, { changes: {} }, { changes: { currency: "ARS" } }, { operation_reference: "random-uuid", changes: { cargo_notes: "x" } },
    { changes: { pickup_location: null } }, { changes: { cargo_notes: "" } }, { changes: [], call_id: "other" }]) {
    await assert.rejects(session.execute("update_operation", args, { toolCallId: "fn-invalid" }), /documented operation fields/);
  }
  await assert.rejects(session.execute("create_operation", {}), /documented operation fields/);
  assert.equal(rpc.requests.length, countBeforeInvalid, "Invalid input must not reach Supabase");

  rpc.results.push(mutationResult());
  const created = await session.execute("create_operation", { container_type: "40_dry" }, { toolCallId: "fn-create" });
  const request = rpc.requests.at(-1)!;
  assert.deepEqual(request.args, {
    p_call_id: scope.callId, p_realtime_call_id: scope.realtimeCallId, p_contact_id: scope.counterpartyId,
    p_tool_call_id: "fn-create", p_tool_name: "create_operation", p_arguments: { container_type: "40_dry" },
  });
  assert.equal((created as ClientMutationResult).operation_reference, "OP-000123");
  rpc.state = selectedState();
  await session.refresh();
  assert.deepEqual(names(), ["update_operation", "confirm_mandate"], "Mandate tool visible even with missing operational fields");
  const factory = new RealtimeSessionFactory();
  let update = factory.createFlowUpdate(decision, session.definitions, session.flowState) as { type: string; session: { instructions: string; tools: unknown[] } };
  assert.equal(update.type, "session.update");
  assert.match(update.session.instructions, /call is locked to the create path/);
  assert.match(update.session.instructions, /OP-000123/);
  assert.doesNotMatch(update.session.instructions, /# UPDATE FLOW|# CANCEL FLOW|Initial intent: undecided/);
  assert.doesNotMatch(JSON.stringify(update), /db-call|db-client|rtc-live/);

  // A replay must still reach the transaction using the ORIGINAL tool call ID,
  // even though create_operation is no longer advertised in the active profile.
  rpc.results.push(mutationResult());
  assert.deepEqual(await session.execute("create_operation", { container_type: "40_dry" }, { toolCallId: "fn-create" }), created);
  assert.equal(rpc.requests.at(-1)!.args.p_tool_call_id, "fn-create");
  rpc.error = { code: "P0001", message: "intent_locked" };
  await assert.rejects(session.execute("create_operation", {}, { toolCallId: "fn-another" }), (error) => error instanceof ToolError && error.code === "intent_locked");
  rpc.error = { code: "P0001", message: "idempotency_conflict" };
  await assert.rejects(session.execute("create_operation", {}, { toolCallId: "fn-create" }), (error) => error instanceof ToolError && error.code === "idempotency_conflict");
  rpc.error = null;
  await assert.rejects(session.execute("list_open_operations", {}), /not available/);

  rpc.results.push({ ...mutationResult("client_confirm"), missing_fields: [], mandate_confirmation_required: false });
  await session.execute("update_operation", { changes: { gross_weight_kg: 24000, delivery_location: "Pilar", empty_return_depot: "Dock Sud", cargo_notes: null } }, { toolCallId: "fn-update" });
  rpc.state = selectedState(true);
  await session.refresh();
  assert.equal(session.flowState?.profile, "client_confirm");
  assert.deepEqual(names(), ["update_operation", "confirm_mandate"]);
  const definition = session.definitions.find((tool) => tool.name === "confirm_mandate")!;
  const contract = contracts.tools.find((tool: { name: string }) => tool.name === "confirm_mandate");
  assert.deepEqual(definition, { type: contract.type, name: contract.name, description: contract.description, parameters: contract.parameters });
  update = factory.createFlowUpdate(decision, session.definitions, session.flowState) as typeof update;
  assert.match(update.session.instructions, /# MANDATE CONFIRMATION/);
  assert.match(update.session.instructions, /Never confirm in the same turn/);
  assert.doesNotMatch(update.session.instructions, /operationRevision|2026-08-29 12:00:00/);

  const terms = { price_cap: 950000.25, currency: "ARS",
    action_windows: [{ start_at: "2026-09-01T10:00:00-03:00", end_at: "2026-09-01T14:00:00-03:00" }],
    minimum_payment_term_days: 30 };
  const invalidCount = rpc.requests.length;
  for (const args of [{}, { ...terms, price_cap: 0 }, { ...terms, price_cap: 1.001 }, { ...terms, price_cap: 1e12 },
    { ...terms, currency: "ars" }, { ...terms, minimum_payment_term_days: 1.5 }, { ...terms, minimum_payment_term_days: -1 },
    { ...terms, minimum_payment_term_days: 2147483648 }, { ...terms, action_windows: [] },
    { ...terms, action_windows: [{ start_at: "2026-02-30T10:00:00Z", end_at: "2026-03-02T10:00:00Z" }] },
    { ...terms, action_windows: [{ start_at: "2026-09-01T10:00:00", end_at: "2026-09-01T14:00:00" }] },
    { ...terms, action_windows: [{ start_at: "2026-09-01T10:00:00Z", end_at: "2026-09-01T10:00:00Z" }] },
    { ...terms, action_windows: [{ ...terms.action_windows[0], timezone: "guessed" }] },
    { ...terms, confirmed: true }, { ...terms, operation_id: "forged" }, { ...terms, evidence: { caller_transcript: "yes" } }]) {
    await assert.rejects(session.execute("confirm_mandate", args, { toolCallId: "bad-confirm" }), (error) => error instanceof ToolError && error.code === "invalid_arguments");
  }
  assert.equal(rpc.requests.length, invalidCount);
  const confirmed: ClientMutationResult = { operation_reference: "OP-000123", mandate_version: 1, status: "sourcing", next_profile: "terminal" };
  rpc.results.push(confirmed);
  assert.deepEqual(await session.execute("confirm_mandate", terms, { toolCallId: "fn-confirm" }), confirmed);
  assert.deepEqual(rpc.requests.at(-1)!.args, {
    p_call_id: scope.callId, p_realtime_call_id: scope.realtimeCallId, p_contact_id: scope.counterpartyId,
    p_tool_call_id: "fn-confirm", p_tool_name: "confirm_mandate", p_arguments: terms,
    p_context: { expected_operation_revision: rpc.state.operationRevision },
  });
  rpc.state = { ...rpc.state, profile: "terminal" };
  await session.refresh();
  assert.deepEqual(names(), []);
  rpc.results.push(confirmed);
  assert.deepEqual(await session.execute("confirm_mandate", terms, { toolCallId: "fn-confirm" }), confirmed,
    "Replay goes to durable SQL receipt even with a hidden tool");
  for (const code of ["confirmation_not_ready", "stale_operation", "invalid_transition", "idempotency_conflict"]) {
    rpc.error = { code: "P0001", message: code };
    await assert.rejects(session.execute("confirm_mandate", terms, { toolCallId: "fn-new-confirm" }),
      (error) => error instanceof ToolError && error.code === code);
  }
  rpc.error = null;

  rpc.state = { ...selectedState(true), intent: "update" };
  rpc.state.operation!.mandate_confirmation_required = true;
  await session.refresh();
  update = factory.createFlowUpdate(decision, session.definitions, session.flowState) as typeof update;
  assert.match(update.session.instructions, /# UPDATE FLOW/);
  assert.doesNotMatch(update.session.instructions, /# CREATE FLOW|# CANCEL FLOW/);
  assert.match(update.session.instructions, /Read back the COMPLETE/, "Update without a prior mandate still requires full terms and summary");
  await assert.rejects(session.execute("confirm_mandate", {}, { toolCallId: "no-prior-mandate" }), /first mandate/);

  rpc.state.currentMandate = { ...terms, version: 1 };
  rpc.state.operationChanges = { delivery_location: { before: "Pilar", after: "Escobar" } };
  await session.refresh();
  update = factory.createFlowUpdate(decision, session.definitions, session.flowState) as typeof update;
  assert.match(update.session.instructions, /# MANDATE UPDATE CONFIRMATION/);
  assert.match(update.session.instructions, /Do not ask the caller to repeat or reconfirm unchanged/);
  assert.match(update.session.instructions, /call it with \{\}/);
  assert.match(update.session.instructions, /ONE short confirmation covering the entire set of shipment and mandate changes/);
  assert.match(update.session.instructions, /ALL and ONLY changed commercial fields in ONE call/);
  assert.match(update.session.instructions, /Do not ask for a second mandate confirmation/);
  assert.match(update.session.instructions, /only when confirm_mandate returns success with the new mandate_version/);
  assert.match(update.session.instructions, /do not put them in shipment fields or lose them when update_operation returns/);
  assert.match(update.session.instructions, /Pilar.*Escobar/);
  assert.doesNotMatch(update.session.instructions, /Read back the COMPLETE|repeat the complete summary/);
  rpc.results.push({ ...confirmed, mandate_version: 2 });
  assert.equal((await session.execute("confirm_mandate", {}, { toolCallId: "only-destination" }) as { mandate_version: number }).mandate_version, 2);
  assert.deepEqual(rpc.requests.at(-1)!.args.p_arguments, {}, "SQL must inherit unchanged terms, not values reconstructed by the model/service");
  assert.deepEqual(rpc.requests.at(-1)!.args.p_context, { expected_operation_revision: rpc.state.operationRevision });
  rpc.results.push({ ...confirmed, mandate_version: 2 });
  await session.execute("confirm_mandate", { price_cap: 900000 }, { toolCallId: "changed-cap" });
  assert.deepEqual(rpc.requests.at(-1)!.args.p_arguments, { price_cap: 900000 });
  const combinedTerms = { ...terms, price_cap: 1000000, minimum_payment_term_days: 45 };
  rpc.results.push({ ...confirmed, mandate_version: 2 });
  await session.execute("confirm_mandate", combinedTerms, { toolCallId: "all-changed-terms" });
  assert.deepEqual(rpc.requests.at(-1)!.args.p_arguments, combinedTerms, "One mandate invocation accepts all commercial changes together");
  const requestsBeforeBadPatch = rpc.requests.length;
  for (const patch of [{ price_cap: null }, { minimum_payment_term_days: null }, { action_windows: [] }, { currency: null }, { operation_id: "forged" }]) {
    await assert.rejects(session.execute("confirm_mandate", patch, { toolCallId: "bad-patch" }), /first mandate/);
  }
  assert.equal(rpc.requests.length, requestsBeforeBadPatch);
  const providerDecision: AcceptedRoutingDecision = { ...decision, identity: {
    persona: "provider", providerId: "provider-1", name: "Provider", phone: "+541100000001", email: null, active: true,
  } };
  assert.doesNotMatch(factory.create(providerDecision, [], rpc.state).instructions, /Current mandate commercial terms|950000.25|minimum_payment_term_days/);
  rpc.state = { ...rpc.state, profile: "terminal" };
  await session.refresh();
  assert.deepEqual(names(), []);
  assert.match(factory.create(decision, session.definitions, session.flowState).instructions, /# CLIENT FLOW COMPLETE/);

  // Cancellation is available only at entry, uses trusted context and shares
  // the durable receipt key. SQL behavior below is mocked, not executed.
  rpc.state = initialState();
  await session.refresh();
  const cancelArgs = { operation_reference: "OP-000123", reason: "El cliente ya no necesita el traslado" };
  const beforeInvalidCancel = rpc.requests.length;
  for (const args of [null, [], {}, { operation_reference: "OP-000123" }, { reason: "test" },
    { ...cancelArgs, operation_reference: "uuid" }, { ...cancelArgs, operation_reference: 123 },
    { ...cancelArgs, reason: " \t" }, { ...cancelArgs, reason: null },
    { ...cancelArgs, operation_id: "forged" }, { ...cancelArgs, contact_id: "other" },
    { ...cancelArgs, send_email: true }, { ...cancelArgs, confirmed: true }]) {
    await assert.rejects(session.execute("cancel_operation", args, { toolCallId: "bad-cancel" }),
      (error) => error instanceof ToolError && error.code === "invalid_arguments");
  }
  await assert.rejects(session.execute("cancel_operation", cancelArgs), (error) => error instanceof ToolError && error.code === "invalid_arguments");
  assert.equal(rpc.requests.length, beforeInvalidCancel);
  const cancelPrompt = factory.create(decision, session.definitions, session.flowState).instructions;
  assert.match(cancelPrompt, /WAIT for the caller's next turn/);
  assert.match(cancelPrompt, /No email is sent or queued/);
  assert.match(cancelPrompt, /If they decline, do not call cancel_operation/);
  assert.match(cancelPrompt, /do not seek provider approval/);
  const cancelled: ClientMutationResult = { operation_reference: "OP-000123", status: "cancelled", provider_email_queued: false, next_profile: "terminal" };
  rpc.results.push(cancelled);
  assert.deepEqual(await session.execute("cancel_operation", cancelArgs, { toolCallId: "fn-cancel" }), cancelled);
  assert.deepEqual(rpc.requests.at(-1), { method: "execute_client_cancellation_tool", args: {
    p_call_id: scope.callId, p_realtime_call_id: scope.realtimeCallId, p_contact_id: scope.counterpartyId,
    p_tool_call_id: "fn-cancel", p_tool_name: "cancel_operation", p_arguments: cancelArgs,
  } });
  rpc.state = { ...selectedState(), intent: "cancel", profile: "terminal" };
  rpc.state.operation!.status = "cancelled";
  await session.refresh();
  assert.deepEqual(names(), []);
  const terminalPrompt = factory.create(decision, session.definitions, session.flowState).instructions;
  assert.match(terminalPrompt, /No email was sent or queued and the carrier has not been notified/);
  assert.doesNotMatch(terminalPrompt, /# CREATE FLOW|# UPDATE FLOW|# CANCEL FLOW|# MANDATE CONFIRMATION/);
  rpc.results.push(cancelled);
  assert.deepEqual(await session.execute("cancel_operation", cancelArgs, { toolCallId: "fn-cancel" }), cancelled);
  for (const code of ["intent_locked", "invalid_transition", "not_authorized", "operation_not_available", "idempotency_conflict"]) {
    rpc.error = { code: "P0001", message: code };
    await assert.rejects(session.execute("cancel_operation", cancelArgs, { toolCallId: "fn-cancel" }),
      (error) => error instanceof ToolError && error.code === code);
  }
  rpc.error = null;
  const cancelMigration = readFileSync(resolve(__dirname, "../../../supabase/migrations/20260830040000_client_cancellation.sql"), "utf8");
  assert.match(cancelMigration, /persona = 'client' AND outcome = 'active'\s+FOR UPDATE/);
  assert.match(cancelMigration, /active AND authorized FOR SHARE/);
  assert.match(cancelMigration, /contact_id = p_contact_id\s+FOR UPDATE/);
  assert.match(cancelMigration, /c.operation_intent <> 'undecided' OR c.operation_id IS NOT NULL/);
  assert.match(cancelMigration, /IF op.status IN \('cancelled', 'failed'\)/);
  assert.ok(cancelMigration.indexOf("RETURN receipt.result") < cancelMigration.indexOf("IF c.client_tools_completed_at"));
  assert.match(cancelMigration, /UPDATE public.bookings SET status = 'cancelled', cancelled_at = cancelled_time/);
  assert.match(cancelMigration, /'notification_email_queued', false/);
  assert.match(cancelMigration, /'provider_email_queued', false/);
  assert.match(cancelMigration, /'operation.cancelled'/);
  assert.match(cancelMigration, /'booking.cancelled'/);
  assert.match(cancelMigration, /skipped_reason/);
  assert.match(cancelMigration, /GRANT EXECUTE ON FUNCTION public.execute_client_cancellation_tool[\s\S]*TO service_role/);
  assert.doesNotMatch(cancelMigration, /INSERT INTO public\.(outbox|mandates|commitments)|DELETE FROM|email\.queued|email\.sent/);

  rpc.failState = true;
  await assert.rejects(session.refresh());
  assert.deepEqual(names(), [], "State failures must remove tools");
  rpc.failState = false;
  const provider = new CallToolFactory(reads, rpc.repository).create({ ...scope, persona: "provider" });
  assert.deepEqual(provider.definitions.map((tool) => tool.name), ["list_provider_operations"]);
  await assert.rejects(provider.execute("create_operation", {}, { toolCallId: "provider-attempt" }), /not available/);
  await assert.rejects(provider.execute("confirm_mandate", terms, { toolCallId: "provider-attempt" }), /not available/);
  await assert.rejects(provider.execute("cancel_operation", cancelArgs, { toolCallId: "provider-attempt" }), /not available/);
  const disabled = new CallToolFactory(reads).create(scope);
  assert.deepEqual(disabled.definitions.map((tool) => tool.name), ["list_open_operations"]);
  await assert.rejects(disabled.execute("confirm_mandate", terms, { toolCallId: "disabled-attempt" }), /not available/);
  await assert.rejects(disabled.execute("cancel_operation", cancelArgs, { toolCallId: "disabled-attempt" }), /not available/);

  for (const code of ["not_authorized", "invalid_arguments", "operation_reference_required", "operation_not_available", "invalid_transition"]) {
    rpc.error = { code: "P0001", message: code };
    await assert.rejects(session.execute("update_operation", { changes: { cargo_notes: "test" } }, { toolCallId: `error-${code}` }), (error) => error instanceof ToolError);
  }
  rpc.error = { code: "XX000", message: "private SQL price_cap=950000" };
  await assert.rejects(session.execute("create_operation", {}, { toolCallId: "private-error" }), (error) => {
    assert.doesNotMatch(JSON.stringify(publicToolError(error)), /SQL|price_cap|950000/);
    return true;
  });
  console.log("Client tools harness passed: validation, RPC context/idempotency keys, error mapping, profiles and prompts (mocked RPC; no PostgreSQL).");
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
