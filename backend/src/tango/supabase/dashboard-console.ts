import type { SupabaseClient } from "@supabase/supabase-js";

import { supabaseAdmin } from "../../config/supabase";
import type { DashboardPage } from "./dashboard";

type JsonRecord = Record<string, unknown>;
type DirectoryKind = "contacts" | "providers";
type HandoffStatus = "pending" | "transfer_requested" | "transfer_failed" | "not_configured";

export class DashboardConsoleError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type DashboardEscalation = {
  id: string;
  operationReference: string;
  operationStatus: string;
  clientName: string;
  counterpartyName: string | null;
  reason: string;
  trigger: string | null;
  summary: string;
  requestedAction: string;
  handoffStatus: HandoffStatus;
  handoffStatusDetail: string | null;
  recipient: { name: string; role: "supervisor" | "operator" } | null;
  status: "started" | "supervisor_joined" | "resolved" | "failed";
  startedAt: string;
  resolvedAt: string | null;
};

export type DashboardHandoff = Pick<DashboardEscalation,
  "id" | "operationReference" | "clientName" | "counterpartyName" | "reason" | "summary" | "requestedAction"
  | "handoffStatus" | "handoffStatusDetail" | "recipient" | "status" | "startedAt">;

export type HandoffRecipient = {
  id: string;
  name: string;
  phone: string;
  role: "supervisor" | "operator";
  active: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
};

export type DirectoryEntry = {
  id: string;
  kind: "contact" | "provider";
  name: string;
  phone: string;
  email: string | null;
  authorized: boolean | null;
  active: boolean;
  capabilities: JsonRecord | null;
  createdAt: string;
  updatedAt: string;
};

export type SavedView = {
  id: string;
  scope: "operations" | "escalations";
  name: string;
  configuration: JsonRecord;
  createdAt: string;
  updatedAt: string;
};

type PageOptions = { page: number; perPage: number; search?: string };

function pageResult<T>(items: T[], page: number, perPage: number, total: number): DashboardPage<T> {
  return { items, page, perPage, total, totalPages: Math.max(1, Math.ceil(total / perPage)) };
}

function normalizedSearch(value: string | undefined): string {
  return (value ?? "").replace(/[^a-zA-Z0-9\s-]/g, " ").trim().replace(/\s+/g, " ");
}

function databaseError(error: unknown): never {
  const record = error && typeof error === "object" ? error as { code?: string; message?: string } : {};
  if (record.code === "23505") throw new DashboardConsoleError(409, "This phone number is already assigned to another record of this kind.");
  throw new DashboardConsoleError(500, record.message ?? "The operations record could not be updated.");
}

function snapshot(row: Record<string, unknown>, fields: string[]): JsonRecord {
  return Object.fromEntries(fields.map((field) => [field, row[field] ?? null]));
}

async function recordOperatorAction(
  input: {
    actorUserId: string;
    action: string;
    operationId?: string;
    escalationId?: string;
    contactId?: string;
    providerId?: string;
    handoffRecipientId?: string;
    beforeState?: JsonRecord;
    afterState?: JsonRecord;
    note?: string;
  },
  client: SupabaseClient,
): Promise<void> {
  const result = await client.from("operator_actions").insert({
    actor_user_id: input.actorUserId,
    action: input.action,
    operation_id: input.operationId ?? null,
    escalation_id: input.escalationId ?? null,
    contact_id: input.contactId ?? null,
    provider_id: input.providerId ?? null,
    handoff_recipient_id: input.handoffRecipientId ?? null,
    before_state: input.beforeState ?? {},
    after_state: input.afterState ?? {},
    note: input.note ?? null,
  });
  if (result.error) databaseError(result.error);
}

export async function listDashboardEscalations(
  options: PageOptions & { status?: string },
  client: SupabaseClient = supabaseAdmin,
): Promise<DashboardPage<DashboardEscalation>> {
  const page = Math.max(1, options.page);
  const perPage = Math.min(Math.max(1, options.perPage), 100);
  const term = normalizedSearch(options.search);
  let operationIds: string[] = [];
  if (term) {
    const operationResult = await client.from("operations").select("id").ilike("reference", `%${term}%`).limit(250);
    if (operationResult.error) databaseError(operationResult.error);
    operationIds = (operationResult.data ?? []).map((row) => (row as { id: string }).id);
  }

  let query = client
    .from("escalations")
    .select("id,operation_id,source_call_id,reason,trigger,status,started_at,resolved_at,handoff_recipient_id,handoff_status,handoff_status_detail", { count: "exact" })
    .order("started_at", { ascending: false });
  if (options.status) {
    query = options.status === "active"
      ? query.in("status", ["started", "supervisor_joined"])
      : query.eq("status", options.status);
  }
  if (term) {
    const parts = [`reason.ilike.*${term}*`, ...operationIds.length > 0 ? [`operation_id.in.(${operationIds.join(",")})`] : []];
    query = query.or(parts.join(","));
  }
  const from = (page - 1) * perPage;
  const result = await query.range(from, from + perPage - 1);
  if (result.error) databaseError(result.error);

  const escalationRows = (result.data ?? []) as Array<{
    id: string; operation_id: string; source_call_id: string; reason: string; trigger: string | null; status: DashboardEscalation["status"];
    started_at: string; resolved_at: string | null; handoff_recipient_id: string | null; handoff_status: HandoffStatus;
    handoff_status_detail: string | null;
  }>;
  const operationIdsForRows = [...new Set(escalationRows.map((row) => row.operation_id))];
  const callIds = [...new Set(escalationRows.map((row) => row.source_call_id))];
  const recipientIds = [...new Set(escalationRows.flatMap((row) => row.handoff_recipient_id ? [row.handoff_recipient_id] : []))];
  const escalationIds = escalationRows.map((row) => row.id);
  const [operationsResult, callsResult, contextsResult, recipientsResult] = await Promise.all([
    operationIdsForRows.length > 0
      ? client.from("operations").select("id,reference,status,contact_id").in("id", operationIdsForRows)
      : Promise.resolve({ data: [], error: null }),
    callIds.length > 0
      ? client.from("calls").select("id,contact_id,provider_id").in("id", callIds)
      : Promise.resolve({ data: [], error: null }),
    escalationIds.length > 0
      ? client.from("escalation_contexts").select("escalation_id,agent_summary,requested_action").in("escalation_id", escalationIds)
      : Promise.resolve({ data: [], error: null }),
    recipientIds.length > 0
      ? client.from("handoff_recipients").select("id,name,role").in("id", recipientIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (operationsResult.error) databaseError(operationsResult.error);
  if (callsResult.error) databaseError(callsResult.error);
  if (contextsResult.error) databaseError(contextsResult.error);
  if (recipientsResult.error) databaseError(recipientsResult.error);

  const operations = (operationsResult.data ?? []) as Array<{ id: string; reference: string; status: string; contact_id: string }>;
  const calls = (callsResult.data ?? []) as Array<{ id: string; contact_id: string | null; provider_id: string | null }>;
  const contactIds = [...new Set([
    ...operations.map((row) => row.contact_id),
    ...calls.flatMap((row) => row.contact_id ? [row.contact_id] : []),
  ])];
  const providerIds = [...new Set(calls.flatMap((row) => row.provider_id ? [row.provider_id] : []))];
  const [contactsResult, providersResult] = await Promise.all([
    contactIds.length > 0 ? client.from("contacts").select("id,name").in("id", contactIds) : Promise.resolve({ data: [], error: null }),
    providerIds.length > 0 ? client.from("providers").select("id,name").in("id", providerIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (contactsResult.error) databaseError(contactsResult.error);
  if (providersResult.error) databaseError(providersResult.error);

  const operationsById = new Map(operations.map((row) => [row.id, row]));
  const callsById = new Map(calls.map((row) => [row.id, row]));
  const contactsById = new Map((contactsResult.data ?? []).map((row) => {
    const contact = row as { id: string; name: string };
    return [contact.id, contact.name];
  }));
  const providersById = new Map((providersResult.data ?? []).map((row) => {
    const provider = row as { id: string; name: string };
    return [provider.id, provider.name];
  }));
  const contextsByEscalationId = new Map((contextsResult.data ?? []).map((row) => {
    const context = row as { escalation_id: string; agent_summary: string; requested_action: string };
    return [context.escalation_id, context];
  }));
  const recipientsById = new Map((recipientsResult.data ?? []).map((row) => {
    const recipient = row as { id: string; name: string; role: "supervisor" | "operator" };
    return [recipient.id, recipient];
  }));

  return pageResult(escalationRows.flatMap((row) => {
    const operation = operationsById.get(row.operation_id);
    if (!operation) return [];
    const call = callsById.get(row.source_call_id);
    const counterpartyName = call?.provider_id
      ? providersById.get(call.provider_id) ?? null
      : call?.contact_id ? contactsById.get(call.contact_id) ?? null : null;
    const context = contextsByEscalationId.get(row.id);
    const recipient = row.handoff_recipient_id ? recipientsById.get(row.handoff_recipient_id) ?? null : null;
    return [{
      id: row.id,
      operationReference: operation.reference,
      operationStatus: operation.status,
      clientName: contactsById.get(operation.contact_id) ?? "Unknown client",
      counterpartyName,
      reason: row.reason,
      trigger: row.trigger,
      summary: context?.agent_summary ?? row.reason,
      requestedAction: context?.requested_action ?? "Human review is required.",
      handoffStatus: row.handoff_status,
      handoffStatusDetail: row.handoff_status_detail,
      recipient,
      status: row.status,
      startedAt: row.started_at,
      resolvedAt: row.resolved_at,
    }];
  }), page, perPage, result.count ?? 0);
}

export async function listDashboardHandoffs(
  client: SupabaseClient = supabaseAdmin,
): Promise<DashboardHandoff[]> {
  const page = await listDashboardEscalations({ page: 1, perPage: 25, status: "active" }, client);
  return page.items.map(({ id, operationReference, clientName, counterpartyName, reason, summary, requestedAction,
    handoffStatus, handoffStatusDetail, recipient, status, startedAt }) => ({
    id, operationReference, clientName, counterpartyName, reason, summary, requestedAction,
    handoffStatus, handoffStatusDetail, recipient, status, startedAt,
  }));
}

export type CorrectOperationInput = {
  reference: string;
  expectedUpdatedAt: string;
  fields: {
    containerType?: string;
    grossWeightKg?: number;
    pickupLocation?: string;
    deliveryLocation?: string;
    emptyReturnDepot?: string;
    operationalConstraints?: string[];
    cargoNotes?: string | null;
  };
  actorUserId: string;
};

const OPERATION_FIELD_MAP: Record<keyof CorrectOperationInput["fields"], string> = {
  containerType: "container_type",
  grossWeightKg: "gross_weight_kg",
  pickupLocation: "pickup_location",
  deliveryLocation: "delivery_location",
  emptyReturnDepot: "empty_return_depot",
  operationalConstraints: "operational_constraints",
  cargoNotes: "cargo_notes",
};

export async function correctDashboardOperation(
  input: CorrectOperationInput,
  client: SupabaseClient = supabaseAdmin,
): Promise<void> {
  const beforeResult = await client
    .from("operations")
    .select("id,current_mandate_id,status,updated_at,container_type,gross_weight_kg,pickup_location,delivery_location,empty_return_depot,operational_constraints,cargo_notes")
    .eq("reference", input.reference)
    .maybeSingle();
  if (beforeResult.error) databaseError(beforeResult.error);
  const before = beforeResult.data as Record<string, unknown> | null;
  if (!before) throw new DashboardConsoleError(404, "This operation no longer exists.");
  if (before.current_mandate_id) throw new DashboardConsoleError(409, "This operation is already authorized. Create a new mandate version instead of overwriting its details.");
  if (before.status === "cancelled" || before.status === "failed") throw new DashboardConsoleError(409, "Closed operations cannot be corrected.");
  if (before.updated_at !== input.expectedUpdatedAt) throw new DashboardConsoleError(409, "This operation changed while you were reviewing it. Refresh the record before saving.");

  const changes: JsonRecord = {};
  const beforeChanges: JsonRecord = {};
  for (const [key, value] of Object.entries(input.fields) as Array<[keyof CorrectOperationInput["fields"], unknown]>) {
    if (value === undefined) continue;
    const column = OPERATION_FIELD_MAP[key];
    if (JSON.stringify(before[column]) !== JSON.stringify(value)) {
      changes[column] = value;
      beforeChanges[column] = before[column] ?? null;
    }
  }
  if (Object.keys(changes).length === 0) return;

  const updateResult = await client
    .from("operations")
    .update(changes)
    .eq("id", before.id as string)
    .eq("updated_at", input.expectedUpdatedAt)
    .select("id")
    .maybeSingle();
  if (updateResult.error) databaseError(updateResult.error);
  if (!updateResult.data) throw new DashboardConsoleError(409, "This operation changed while you were reviewing it. Refresh the record before saving.");

  const eventResult = await client.from("events").insert({
    operation_id: before.id,
    type: "operation.corrected",
    payload: {
      operation_reference: input.reference,
      changes: Object.fromEntries(Object.keys(changes).map((field) => [field, {
        before: beforeChanges[field], after: changes[field],
      }])),
      mandate_confirmation_required: false,
      source: "dashboard_operator",
    },
  });
  if (eventResult.error) databaseError(eventResult.error);
  await recordOperatorAction({
    actorUserId: input.actorUserId,
    action: "operation.corrected",
    operationId: before.id as string,
    beforeState: beforeChanges,
    afterState: changes,
  }, client);
}

export async function resolveDashboardEscalation(
  input: { escalationId: string; resolution: "approved" | "rejected" | "follow_up"; note: string; actorUserId: string },
  client: SupabaseClient = supabaseAdmin,
): Promise<void> {
  const beforeResult = await client
    .from("escalations")
    .select("id,operation_id,source_call_id,status,reason")
    .eq("id", input.escalationId)
    .maybeSingle();
  if (beforeResult.error) databaseError(beforeResult.error);
  const before = beforeResult.data as { id: string; operation_id: string; source_call_id: string; status: string; reason: string } | null;
  if (!before) throw new DashboardConsoleError(404, "This escalation no longer exists.");
  if (before.status !== "started" && before.status !== "supervisor_joined") {
    throw new DashboardConsoleError(409, "This escalation has already been closed.");
  }
  const resolvedAt = new Date().toISOString();
  const updateResult = await client
    .from("escalations")
    .update({ status: "resolved", resolved_at: resolvedAt })
    .eq("id", before.id)
    .in("status", ["started", "supervisor_joined"])
    .select("id")
    .maybeSingle();
  if (updateResult.error) databaseError(updateResult.error);
  if (!updateResult.data) throw new DashboardConsoleError(409, "This escalation changed while you were reviewing it. Refresh the record before closing it.");

  const eventResult = await client.from("events").insert({
    operation_id: before.operation_id,
    call_id: before.source_call_id,
    type: "escalation.resolved",
    occurred_at: resolvedAt,
    payload: { escalation_id: before.id, resolution: input.resolution, source: "dashboard_operator" },
  });
  if (eventResult.error) databaseError(eventResult.error);
  await recordOperatorAction({
    actorUserId: input.actorUserId,
    action: "escalation.resolved",
    operationId: before.operation_id,
    escalationId: before.id,
    beforeState: { status: before.status, reason: before.reason },
    afterState: { status: "resolved", resolution: input.resolution },
    note: input.note,
  }, client);
}

function tableFor(kind: DirectoryKind): "contacts" | "providers" {
  return kind;
}

function directoryFields(kind: DirectoryKind): string {
  return kind === "contacts"
    ? "id,name,phone,email,authorized,active,created_at,updated_at"
    : "id,name,phone,email,capabilities,active,created_at,updated_at";
}

function toDirectoryEntry(kind: DirectoryKind, row: Record<string, unknown>): DirectoryEntry {
  return {
    id: row.id as string,
    kind: kind === "contacts" ? "contact" : "provider",
    name: row.name as string,
    phone: row.phone as string,
    email: typeof row.email === "string" ? row.email : null,
    authorized: kind === "contacts" ? Boolean(row.authorized) : null,
    active: Boolean(row.active),
    capabilities: kind === "providers" && row.capabilities && typeof row.capabilities === "object"
      ? row.capabilities as JsonRecord : null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function listDirectoryEntries(
  kind: DirectoryKind,
  options: PageOptions & { active?: boolean },
  client: SupabaseClient = supabaseAdmin,
): Promise<DashboardPage<DirectoryEntry>> {
  const page = Math.max(1, options.page);
  const perPage = Math.min(Math.max(1, options.perPage), 100);
  const term = normalizedSearch(options.search);
  let query = client.from(tableFor(kind)).select(directoryFields(kind), { count: "exact" }).order("name", { ascending: true });
  if (options.active !== undefined) query = query.eq("active", options.active);
  if (term) query = query.or(`name.ilike.*${term}*,phone.ilike.*${term}*,email.ilike.*${term}*`);
  const from = (page - 1) * perPage;
  const result = await query.range(from, from + perPage - 1);
  if (result.error) databaseError(result.error);
  return pageResult((result.data ?? []).map((row) => toDirectoryEntry(kind, row as unknown as Record<string, unknown>)), page, perPage, result.count ?? 0);
}

export type DirectoryWriteInput = {
  name?: string;
  phone?: string;
  email?: string | null;
  authorized?: boolean;
  active?: boolean;
  capabilities?: JsonRecord;
};

export async function createDirectoryEntry(
  kind: DirectoryKind,
  input: Required<Pick<DirectoryWriteInput, "name" | "phone">> & DirectoryWriteInput,
  actorUserId: string,
  client: SupabaseClient = supabaseAdmin,
): Promise<DirectoryEntry> {
  const values: JsonRecord = { name: input.name, phone: input.phone, email: input.email ?? null, active: true };
  if (kind === "contacts") values.authorized = input.authorized ?? true;
  if (kind === "providers") values.capabilities = input.capabilities ?? {};
  const result = await client.from(tableFor(kind)).insert(values).select(directoryFields(kind)).single();
  if (result.error) databaseError(result.error);
  const entry = toDirectoryEntry(kind, result.data as unknown as Record<string, unknown>);
  await recordOperatorAction({
    actorUserId,
    action: kind === "contacts" ? "contact.created" : "provider.created",
    contactId: kind === "contacts" ? entry.id : undefined,
    providerId: kind === "providers" ? entry.id : undefined,
    afterState: snapshot(result.data as unknown as Record<string, unknown>, ["name", "phone", "email", "authorized", "capabilities", "active"]),
  }, client);
  return entry;
}

export async function updateDirectoryEntry(
  kind: DirectoryKind,
  id: string,
  expectedUpdatedAt: string,
  input: DirectoryWriteInput,
  actorUserId: string,
  client: SupabaseClient = supabaseAdmin,
): Promise<DirectoryEntry> {
  const beforeResult = await client.from(tableFor(kind)).select(directoryFields(kind)).eq("id", id).maybeSingle();
  if (beforeResult.error) databaseError(beforeResult.error);
  const before = beforeResult.data as Record<string, unknown> | null;
  if (!before) throw new DashboardConsoleError(404, "This directory entry no longer exists.");
  if (before.updated_at !== expectedUpdatedAt) throw new DashboardConsoleError(409, "This directory entry changed while you were reviewing it. Refresh before saving.");

  const allowedFields = kind === "contacts"
    ? ["name", "phone", "email", "authorized", "active"]
    : ["name", "phone", "email", "capabilities", "active"];
  const changes = Object.fromEntries(Object.entries(input).filter(([key, value]) => allowedFields.includes(key) && value !== undefined));
  if (Object.keys(changes).length === 0) return toDirectoryEntry(kind, before);
  const result = await client.from(tableFor(kind)).update(changes).eq("id", id).eq("updated_at", expectedUpdatedAt)
    .select(directoryFields(kind)).maybeSingle();
  if (result.error) databaseError(result.error);
  if (!result.data) throw new DashboardConsoleError(409, "This directory entry changed while you were reviewing it. Refresh before saving.");
  const after = result.data as unknown as Record<string, unknown>;
  const deactivated = before.active === true && after.active === false;
  await recordOperatorAction({
    actorUserId,
    action: kind === "contacts"
      ? deactivated ? "contact.deactivated" : "contact.updated"
      : deactivated ? "provider.deactivated" : "provider.updated",
    contactId: kind === "contacts" ? id : undefined,
    providerId: kind === "providers" ? id : undefined,
    beforeState: snapshot(before, allowedFields),
    afterState: snapshot(after, allowedFields),
  }, client);
  return toDirectoryEntry(kind, after);
}

export type HandoffRecipientWriteInput = {
  name?: string;
  phone?: string;
  role?: "supervisor" | "operator";
  active?: boolean;
  priority?: number;
};

const HANDOFF_RECIPIENT_FIELDS = "id,name,phone,role,active,priority,created_at,updated_at";

function toHandoffRecipient(row: Record<string, unknown>): HandoffRecipient {
  return {
    id: row.id as string,
    name: row.name as string,
    phone: row.phone as string,
    role: row.role as HandoffRecipient["role"],
    active: Boolean(row.active),
    priority: Number(row.priority),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function listHandoffRecipients(
  options: PageOptions & { active?: boolean },
  client: SupabaseClient = supabaseAdmin,
): Promise<DashboardPage<HandoffRecipient>> {
  const page = Math.max(1, options.page);
  const perPage = Math.min(Math.max(1, options.perPage), 100);
  const term = normalizedSearch(options.search);
  let query = client.from("handoff_recipients").select(HANDOFF_RECIPIENT_FIELDS, { count: "exact" })
    .order("priority", { ascending: true }).order("name", { ascending: true });
  if (options.active !== undefined) query = query.eq("active", options.active);
  if (term) query = query.or(`name.ilike.*${term}*,phone.ilike.*${term}*,role.ilike.*${term}*`);
  const from = (page - 1) * perPage;
  const result = await query.range(from, from + perPage - 1);
  if (result.error) databaseError(result.error);
  return pageResult((result.data ?? []).map((row) => toHandoffRecipient(row as Record<string, unknown>)), page, perPage, result.count ?? 0);
}

export async function createHandoffRecipient(
  input: Required<Pick<HandoffRecipientWriteInput, "name" | "phone" | "role" | "priority">>,
  actorUserId: string,
  client: SupabaseClient = supabaseAdmin,
): Promise<HandoffRecipient> {
  const result = await client.from("handoff_recipients")
    .insert({ ...input, active: true }).select(HANDOFF_RECIPIENT_FIELDS).single();
  if (result.error) databaseError(result.error);
  const recipient = toHandoffRecipient(result.data as Record<string, unknown>);
  await recordOperatorAction({
    actorUserId,
    action: "handoff_recipient.created",
    handoffRecipientId: recipient.id,
    afterState: snapshot(result.data as Record<string, unknown>, ["name", "phone", "role", "active", "priority"]),
  }, client);
  return recipient;
}

export async function updateHandoffRecipient(
  id: string,
  expectedUpdatedAt: string,
  input: HandoffRecipientWriteInput,
  actorUserId: string,
  client: SupabaseClient = supabaseAdmin,
): Promise<HandoffRecipient> {
  const beforeResult = await client.from("handoff_recipients").select(HANDOFF_RECIPIENT_FIELDS).eq("id", id).maybeSingle();
  if (beforeResult.error) databaseError(beforeResult.error);
  const before = beforeResult.data as Record<string, unknown> | null;
  if (!before) throw new DashboardConsoleError(404, "This handoff recipient no longer exists.");
  if (before.updated_at !== expectedUpdatedAt) throw new DashboardConsoleError(409, "This handoff recipient changed while you were reviewing it. Refresh before saving.");
  const allowedFields = ["name", "phone", "role", "active", "priority"];
  const changes = Object.fromEntries(Object.entries(input).filter(([key, value]) => allowedFields.includes(key) && value !== undefined));
  if (Object.keys(changes).length === 0) return toHandoffRecipient(before);
  const result = await client.from("handoff_recipients").update(changes).eq("id", id).eq("updated_at", expectedUpdatedAt)
    .select(HANDOFF_RECIPIENT_FIELDS).maybeSingle();
  if (result.error) databaseError(result.error);
  if (!result.data) throw new DashboardConsoleError(409, "This handoff recipient changed while you were reviewing it. Refresh before saving.");
  const after = result.data as Record<string, unknown>;
  const deactivated = before.active === true && after.active === false;
  await recordOperatorAction({
    actorUserId,
    action: deactivated ? "handoff_recipient.deactivated" : "handoff_recipient.updated",
    handoffRecipientId: id,
    beforeState: snapshot(before, allowedFields),
    afterState: snapshot(after, allowedFields),
  }, client);
  return toHandoffRecipient(after);
}

export async function listSavedViews(
  userId: string,
  scope: "operations" | "escalations",
  client: SupabaseClient = supabaseAdmin,
): Promise<SavedView[]> {
  const result = await client.from("dashboard_saved_views")
    .select("id,scope,name,configuration,created_at,updated_at")
    .eq("user_id", userId).eq("scope", scope).order("name", { ascending: true });
  if (result.error) databaseError(result.error);
  return (result.data ?? []).map((row) => {
    const view = row as Record<string, unknown>;
    return {
      id: view.id as string, scope: view.scope as SavedView["scope"], name: view.name as string,
      configuration: view.configuration as JsonRecord, createdAt: view.created_at as string, updatedAt: view.updated_at as string,
    };
  });
}

export async function createSavedView(
  userId: string,
  input: { scope: "operations" | "escalations"; name: string; configuration: JsonRecord },
  client: SupabaseClient = supabaseAdmin,
): Promise<SavedView> {
  const result = await client.from("dashboard_saved_views").insert({ user_id: userId, ...input })
    .select("id,scope,name,configuration,created_at,updated_at").single();
  if (result.error) databaseError(result.error);
  const row = result.data as Record<string, unknown>;
  return { id: row.id as string, scope: row.scope as SavedView["scope"], name: row.name as string,
    configuration: row.configuration as JsonRecord, createdAt: row.created_at as string, updatedAt: row.updated_at as string };
}

export async function deleteSavedView(
  userId: string,
  id: string,
  client: SupabaseClient = supabaseAdmin,
): Promise<void> {
  const result = await client.from("dashboard_saved_views").delete().eq("id", id).eq("user_id", userId);
  if (result.error) databaseError(result.error);
}
