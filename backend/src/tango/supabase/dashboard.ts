import type { SupabaseClient } from "@supabase/supabase-js";

import { supabaseAdmin } from "../../config/supabase";

type JsonRecord = Record<string, unknown>;

type OperationRow = {
  id: string;
  reference: string;
  contact_id: string;
  current_mandate_id: string | null;
  status: string;
  container_type: string | null;
  gross_weight_kg: number | string | null;
  pickup_location: string | null;
  delivery_location: string | null;
  empty_return_depot: string | null;
  operational_constraints: string[] | null;
  cargo_notes: string | null;
  updated_at: string;
};

type ContactRow = { id: string; name: string };
type ProviderRow = { id: string; name: string };
type CallRow = {
  id: string;
  contact_id: string | null;
  provider_id: string | null;
  direction: "inbound" | "outbound";
  outcome: string;
  started_at: string;
  ended_at: string | null;
  recording_url: string | null;
  twilio_call_sid: string;
};

type EventRow = {
  id: string;
  type: string;
  payload: unknown;
  call_id: string | null;
  commitment_id: string | null;
  recording_checkpoint: number | string | null;
  occurred_at: string;
};

export type DashboardWindow = { startAt: string; endAt: string };

export type DashboardOperation = {
  reference: string;
  clientName: string;
  containerType: string | null;
  grossWeightKg: number | null;
  pickupLocation: string | null;
  deliveryLocation: string | null;
  emptyReturnDepot: string | null;
  operationalConstraints: string[];
  cargoNotes: string | null;
  status: string;
  updatedAt: string;
  nextStep: string;
  escalation: {
    counterpartyName: string | null;
    reason: string;
    startedAt: string;
  } | null;
};

export type DashboardPage<T> = {
  items: T[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
};

export type DashboardOperationsQuery = {
  page: number;
  perPage: number;
  search?: string;
  status?: string;
  attention?: boolean;
};

export type DashboardOperationDossier = DashboardOperation & {
  mandate: {
    version: number;
    priceCap: number;
    currency: string;
    paymentTermDays: number;
    actionWindows: DashboardWindow[];
    constraints: string[];
  } | null;
  booking: {
    reference: string | null;
    providerName: string | null;
    confirmedPrice: number | null;
    currency: string | null;
    pickupWindow: DashboardWindow;
    status: string;
  } | null;
  quotes: Array<{
    id: string;
    providerName: string;
    priceMin: number;
    priceMax: number;
    currency: string;
    verdict: string;
    status: string;
    validUntil: string;
    selected: boolean;
  }>;
  selectionReason: string | null;
  activeEscalation: {
    id: string;
    counterpartyName: string | null;
    reason: string;
    requestedPickupWindow: DashboardWindow | null;
    actionWindow: DashboardWindow | null;
    startedAt: string;
  } | null;
  commitments: Array<{
    id: string;
    kind: string;
    occurredAt: string;
    title: string;
    summary: string;
    call: {
      label: string;
      counterpartyName: string | null;
      direction: "inbound" | "outbound";
    };
    transcriptExcerpt: string;
    recordingCheckpoint: number;
    recordingUrl: string | null;
    supersedesCommitmentId: string | null;
  }>;
  trace: {
    lanes: Array<{
      id: string;
      label: string;
      description: string;
      kind: "operation" | "call";
    }>;
    nodes: Array<{
      id: string;
      laneId: string;
      kind: "event" | "call_started" | "call_ended";
      occurredAt: string;
      title: string;
      detail: string | null;
      branchDepth: number;
      recordingCheckpoint: number | null;
      sourceCall: {
        label: string;
        description: string;
        branchDepth: number;
      } | null;
      changes: Array<{
        label: string;
        before: string | null;
        after: string;
      }>;
    }>;
  };
};

const OPERATION_COLUMNS = [
  "id", "reference", "contact_id", "current_mandate_id", "status", "container_type",
  "gross_weight_kg", "pickup_location", "delivery_location", "empty_return_depot",
  "operational_constraints", "cargo_notes", "updated_at",
].join(",");

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function asNumber(value: number | string | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readWindows(value: unknown): DashboardWindow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const startAt = record.start_at;
    const endAt = record.end_at;
    return typeof startAt === "string" && typeof endAt === "string" ? [{ startAt, endAt }] : [];
  });
}

function readWindow(value: unknown): DashboardWindow | null {
  return readWindows([value])[0] ?? null;
}

function nextStep(status: string, hasActiveEscalation: boolean): string {
  if (hasActiveEscalation) return "Review active escalation";
  switch (status) {
    case "collecting_details": return "Collect missing shipment details";
    case "sourcing": return "Request provider quotes";
    case "quotes_received": return "Select a valid quote";
    case "quote_selected": return "Request booking confirmation";
    case "booking_pending": return "Await provider confirmation";
    case "booking_confirmed": return "Send booking confirmations";
    case "notifications_sent": return "Monitor confirmed pickup";
    case "needs_follow_up": return "Review required follow-up";
    default: return "Review operation";
  }
}

function commitmentTitle(kind: string): string {
  const titles: Record<string, string> = {
    quote: "Quote accepted",
    booking: "Booking confirmed",
    reschedule: "Pickup rescheduled",
    cancellation: "Booking cancelled",
  };
  return titles[kind] ?? "Commitment recorded";
}

function commitmentSummary(kind: string, termsValue: unknown): string {
  const terms = asRecord(termsValue);
  const price = terms.confirmed_price ?? terms.price ?? terms.price_max;
  const currency = terms.currency;
  const pickup = asRecord(terms.pickup_window);
  const startAt = pickup.start_at;

  const priceText = (typeof price === "number" || typeof price === "string") && typeof currency === "string"
    ? `${currency} ${price}`
    : null;
  const pickupText = typeof startAt === "string" ? `pickup from ${startAt}` : null;
  const details = [priceText, pickupText].filter((value): value is string => Boolean(value));
  if (details.length > 0) return details.join(" · ");

  return `${commitmentTitle(kind)} recorded by the operation service.`;
}

async function namesFor(
  contactIds: string[],
  providerIds: string[],
  client: SupabaseClient,
): Promise<{ contacts: Map<string, string>; providers: Map<string, string> }> {
  const [contactResult, providerResult] = await Promise.all([
    contactIds.length > 0
      ? client.from("contacts").select("id,name").in("id", contactIds)
      : Promise.resolve({ data: [], error: null }),
    providerIds.length > 0
      ? client.from("providers").select("id,name").in("id", providerIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (contactResult.error) throw contactResult.error;
  if (providerResult.error) throw providerResult.error;

  return {
    contacts: new Map((contactResult.data as ContactRow[]).map((row) => [row.id, row.name])),
    providers: new Map((providerResult.data as ProviderRow[]).map((row) => [row.id, row.name])),
  };
}

async function callsFor(
  callIds: string[],
  client: SupabaseClient,
): Promise<Map<string, CallRow>> {
  if (callIds.length === 0) return new Map();
  const result = await client
    .from("calls")
    .select("id,contact_id,provider_id,direction,outcome,started_at,ended_at,recording_url,twilio_call_sid")
    .in("id", callIds);
  if (result.error) throw result.error;
  return new Map((result.data as CallRow[]).map((row) => [row.id, row]));
}

const CALL_LIFECYCLE_EVENTS = new Set(["call.routed", "call.completed", "call.failed"]);
const OPERATION_STATE_EVENTS = new Set([
  "operation.created", "operation.updated", "operation.cancelled", "mandate.confirmed", "sourcing.started",
  "quote.selected", "booking.pending", "booking.confirmed", "booking.declined", "booking.rescheduled",
  "booking.reschedule_declined", "booking.cancelled", "escalation.started", "escalation.supervisor_joined",
  "escalation.resolved", "escalation.failed", "email.queued", "email.sent", "email.failed",
]);

function traceEventTitle(type: string): string {
  const titles: Record<string, string> = {
    "operation.created": "Operation created",
    "operation.updated": "Operation updated",
    "operation.cancelled": "Operation cancelled",
    "mandate.confirmed": "Mandate confirmed",
    "sourcing.started": "Provider sourcing started",
    "quote.requested": "Quote request issued",
    "quote.received": "Quote received",
    "quote.counteroffer_requested": "Counteroffer requested",
    "quote.declined": "Quote declined",
    "quote.expired": "Quote request expired",
    "quote.selected": "Quote selected",
    "booking.pending": "Booking confirmation requested",
    "booking.confirmed": "Booking confirmed",
    "booking.declined": "Booking declined",
    "booking.rescheduled": "Booking rescheduled",
    "booking.reschedule_declined": "Reschedule declined",
    "booking.cancelled": "Booking cancelled",
    "escalation.started": "Supervisor escalation started",
    "escalation.supervisor_joined": "Supervisor joined",
    "escalation.resolved": "Escalation resolved",
    "escalation.failed": "Escalation follow-up required",
    "email.queued": "Confirmation queued",
    "email.sent": "Confirmation sent",
    "email.failed": "Confirmation delivery failed",
    "call.transferred": "Call transferred",
  };
  return titles[type] ?? type.replaceAll(".", " ").replaceAll("_", " ");
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function traceFieldValue(field: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (field === "gross_weight_kg") {
    const number = asNumber(typeof value === "number" || typeof value === "string" ? value : null);
    return number === null ? null : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(number)} kg`;
  }
  if (field === "operational_constraints" && Array.isArray(value)) {
    return `${value.length} condition${value.length === 1 ? "" : "s"}`;
  }
  if (field === "cargo_notes" && typeof value === "string") return value;
  if (typeof value === "string" || typeof value === "number") return String(value);
  return null;
}

function traceChanges(payloadValue: unknown): DashboardOperationDossier["trace"]["nodes"][number]["changes"] {
  const changes = asRecord(asRecord(payloadValue).changes);
  const labels: Record<string, string> = {
    container_type: "Container",
    gross_weight_kg: "Gross weight",
    pickup_location: "Pickup",
    delivery_location: "Delivery",
    empty_return_depot: "Empty return",
    operational_constraints: "Conditions",
    cargo_notes: "Cargo notes",
  };
  return Object.entries(changes).flatMap(([field, changeValue]) => {
    const change = asRecord(changeValue);
    const after = traceFieldValue(field, change.after);
    if (!after) return [];
    return [{
      label: labels[field] ?? humanize(field),
      before: traceFieldValue(field, change.before),
      after,
    }];
  });
}

function traceEventDetail(type: string, payloadValue: unknown): string | null {
  const payload = asRecord(payloadValue);
  if (type === "operation.created") {
    const missingFields = Array.isArray(payload.missing_fields) ? payload.missing_fields.length : null;
    const status = typeof payload.status === "string" ? humanize(payload.status) : null;
    if (status && missingFields !== null) return `${status} · ${missingFields} detail${missingFields === 1 ? "" : "s"} still required`;
    return status;
  }
  if (type === "operation.updated") {
    const changeCount = Object.keys(asRecord(payload.changes)).length;
    return changeCount > 0 ? `${changeCount} field${changeCount === 1 ? "" : "s"} changed` : null;
  }
  if (type === "mandate.confirmed" && typeof payload.mandate_version === "number") {
    return `Mandate v${payload.mandate_version}`;
  }
  if (typeof payload.reason === "string" && payload.reason.trim()) return payload.reason;
  if (typeof payload.selection_reason === "string" && payload.selection_reason.trim()) return payload.selection_reason;
  if (typeof payload.provider_count === "number") {
    return `${payload.provider_count} provider${payload.provider_count === 1 ? "" : "s"} in scope`;
  }
  return null;
}

function callLaneLabel(
  call: CallRow,
  names: { contacts: Map<string, string>; providers: Map<string, string> },
): string {
  return counterpartyName(call, names) ?? "Counterparty not recorded";
}

function toOperationTrace(
  calls: CallRow[],
  events: EventRow[],
  names: { contacts: Map<string, string>; providers: Map<string, string> },
): DashboardOperationDossier["trace"] {
  const orderedCalls = [...calls].sort((left, right) => left.started_at.localeCompare(right.started_at));
  const lanes: DashboardOperationDossier["trace"]["lanes"] = [
    { id: "operation", label: "Operation state", description: "Persists after every call", kind: "operation" },
    ...orderedCalls.map((call) => ({
      id: `call:${call.id}`,
      label: `Call with ${callLaneLabel(call, names)}`,
      description: `${call.direction === "outbound" ? "Outbound" : "Inbound"} call`,
      kind: "call" as const,
    })),
  ];
  const laneIndexById = new Map(lanes.map((lane, index) => [lane.id, index]));

  const nodes: DashboardOperationDossier["trace"]["nodes"] = [
    ...orderedCalls.flatMap((call) => {
      const laneId = `call:${call.id}`;
      const branchDepth = laneIndexById.get(laneId) ?? 0;
      const counterparty = callLaneLabel(call, names);
      const started = {
        id: `${call.id}:started`,
        laneId,
        kind: "call_started" as const,
        occurredAt: call.started_at,
        title: `${call.direction === "outbound" ? "Outbound" : "Inbound"} call started`,
        detail: counterparty === "Counterparty not recorded" ? null : counterparty,
        branchDepth,
        recordingCheckpoint: null,
        sourceCall: null,
        changes: [],
      };
      const ended = call.ended_at ? [{
        id: `${call.id}:ended`,
        laneId,
        kind: "call_ended" as const,
        occurredAt: call.ended_at,
        title: "Call ended",
        detail: call.outcome.replaceAll("_", " "),
        branchDepth,
        recordingCheckpoint: null,
        sourceCall: null,
        changes: [],
      }] : [];
      return [started, ...ended];
    }),
    ...events
      .filter((event) => !CALL_LIFECYCLE_EVENTS.has(event.type))
      .map((event) => {
        const callLaneId = event.call_id ? `call:${event.call_id}` : null;
        const laneId = !OPERATION_STATE_EVENTS.has(event.type) && callLaneId && laneIndexById.has(callLaneId)
          ? callLaneId
          : "operation";
        const sourceCall = laneId === "operation" && callLaneId && laneIndexById.has(callLaneId)
          ? calls.find((call) => `call:${call.id}` === callLaneId)
          : undefined;
        const sourceCallDepth = sourceCall ? laneIndexById.get(callLaneId ?? "") ?? 0 : 0;
        return {
          id: event.id,
          laneId,
          kind: "event" as const,
          occurredAt: event.occurred_at,
          title: traceEventTitle(event.type),
          detail: traceEventDetail(event.type, event.payload),
          branchDepth: laneIndexById.get(laneId) ?? 0,
          recordingCheckpoint: asNumber(event.recording_checkpoint),
          sourceCall: sourceCall ? {
            label: callLaneLabel(sourceCall, names),
            description: `${sourceCall.direction === "outbound" ? "Outbound" : "Inbound"} call`,
            branchDepth: sourceCallDepth,
          } : null,
          changes: event.type === "operation.updated" ? traceChanges(event.payload) : [],
        };
      }),
  ].sort((left, right) => {
    const timeOrder = left.occurredAt.localeCompare(right.occurredAt);
    if (timeOrder !== 0) return timeOrder;
    const kindOrder = { call_started: 0, event: 1, call_ended: 2 } as const;
    return kindOrder[left.kind] - kindOrder[right.kind];
  });

  return { lanes, nodes };
}

function counterpartyName(
  call: CallRow | undefined,
  names: { contacts: Map<string, string>; providers: Map<string, string> },
): string | null {
  if (!call) return null;
  if (call.provider_id) return names.providers.get(call.provider_id) ?? null;
  if (call.contact_id) return names.contacts.get(call.contact_id) ?? null;
  return null;
}

type EscalationRow = {
  id: string;
  operation_id: string;
  change_request_id: string | null;
  source_call_id: string;
  reason: string;
  started_at: string;
};

async function activeEscalationsFor(
  operationIds: string[],
  client: SupabaseClient,
): Promise<Map<string, EscalationRow>> {
  if (operationIds.length === 0) return new Map();
  const result = await client
    .from("escalations")
    .select("id,operation_id,change_request_id,source_call_id,reason,started_at")
    .in("operation_id", operationIds)
    .in("status", ["started", "supervisor_joined"])
    .order("started_at", { ascending: false });
  if (result.error) throw result.error;

  const latestByOperation = new Map<string, EscalationRow>();
  for (const escalation of result.data as EscalationRow[]) {
    if (!latestByOperation.has(escalation.operation_id)) {
      latestByOperation.set(escalation.operation_id, escalation);
    }
  }
  return latestByOperation;
}

async function toDashboardOperations(
  operations: OperationRow[],
  client: SupabaseClient,
): Promise<DashboardOperation[]> {
  const escalations = await activeEscalationsFor(operations.map((operation) => operation.id), client);
  const calls = await callsFor([...escalations.values()].map((escalation) => escalation.source_call_id), client);
  const names = await namesFor(
    operations.map((operation) => operation.contact_id),
    [...calls.values()].flatMap((call) => call.provider_id ? [call.provider_id] : []),
    client,
  );

  return operations.map((operation) => {
    const escalation = escalations.get(operation.id);
    return {
      reference: operation.reference,
      clientName: names.contacts.get(operation.contact_id) ?? "Unknown client",
      containerType: operation.container_type,
      grossWeightKg: asNumber(operation.gross_weight_kg),
      pickupLocation: operation.pickup_location,
      deliveryLocation: operation.delivery_location,
      emptyReturnDepot: operation.empty_return_depot,
      operationalConstraints: operation.operational_constraints ?? [],
      cargoNotes: operation.cargo_notes,
      status: operation.status,
      updatedAt: operation.updated_at,
      nextStep: nextStep(operation.status, Boolean(escalation)),
      escalation: escalation ? {
        counterpartyName: counterpartyName(calls.get(escalation.source_call_id), names),
        reason: escalation.reason,
        startedAt: escalation.started_at,
      } : null,
    };
  });
}

export async function listDashboardOperations(
  client: SupabaseClient = supabaseAdmin,
): Promise<DashboardOperation[]> {
  const result = await client
    .from("operations")
    .select(OPERATION_COLUMNS)
    .not("status", "in", "(cancelled,failed)")
    .order("updated_at", { ascending: false });
  if (result.error) throw result.error;
  return toDashboardOperations((result.data ?? []) as unknown as OperationRow[], client);
}

function searchTerm(value: string): string {
  return value.replace(/[^a-zA-Z0-9\s-]/g, " ").trim().replace(/\s+/g, " ");
}

/**
 * Server-filtered register data. Pagination happens before the dashboard
 * projection so growing operation lists never depend on browser filtering.
 */
export async function listDashboardOperationsPage(
  options: DashboardOperationsQuery,
  client: SupabaseClient = supabaseAdmin,
): Promise<DashboardPage<DashboardOperation>> {
  const page = Math.max(1, options.page);
  const perPage = Math.min(Math.max(1, options.perPage), 100);
  let contactIds: string[] = [];
  const term = options.search ? searchTerm(options.search) : "";

  if (term) {
    const contactsResult = await client
      .from("contacts")
      .select("id")
      .ilike("name", `%${term}%`)
      .limit(250);
    if (contactsResult.error) throw contactsResult.error;
    contactIds = (contactsResult.data ?? []).map((row) => (row as { id: string }).id);
  }

  let attentionOperationIds: string[] = [];
  if (options.attention) {
    const escalationResult = await client
      .from("escalations")
      .select("operation_id")
      .in("status", ["started", "supervisor_joined"]);
    if (escalationResult.error) throw escalationResult.error;
    attentionOperationIds = [...new Set((escalationResult.data ?? [])
      .map((row) => (row as { operation_id: string }).operation_id))];
  }

  let query = client
    .from("operations")
    .select(OPERATION_COLUMNS, { count: "exact" })
    .not("status", "in", "(cancelled,failed)")
    .order("updated_at", { ascending: false });

  if (options.status) query = query.eq("status", options.status);
  if (options.attention) {
    const attentionFilter = attentionOperationIds.length > 0
      ? `status.eq.needs_follow_up,id.in.(${attentionOperationIds.join(",")})`
      : "status.eq.needs_follow_up";
    query = query.or(attentionFilter);
  }
  if (term) {
    const terms = [
      `reference.ilike.*${term}*`,
      `pickup_location.ilike.*${term}*`,
      `delivery_location.ilike.*${term}*`,
      ...contactIds.length > 0 ? [`contact_id.in.(${contactIds.join(",")})`] : [],
    ];
    query = query.or(terms.join(","));
  }

  const from = (page - 1) * perPage;
  const result = await query.range(from, from + perPage - 1);
  if (result.error) throw result.error;
  const total = result.count ?? 0;
  return {
    items: await toDashboardOperations((result.data ?? []) as unknown as OperationRow[], client),
    page,
    perPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  };
}

/** A durable cursor for the live operations register. */
export async function getDashboardRevision(
  client: SupabaseClient = supabaseAdmin,
): Promise<string> {
  const [operationResult, eventResult, operatorActionResult] = await Promise.all([
    client
      .from("operations")
      .select("id,updated_at")
      .not("status", "in", "(cancelled,failed)")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    client
      .from("events")
      .select("id,occurred_at")
      .not("operation_id", "is", null)
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    client
      .from("operator_actions")
      .select("id,occurred_at")
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (operationResult.error) throw operationResult.error;
  if (eventResult.error) throw eventResult.error;
  if (operatorActionResult.error) throw operatorActionResult.error;

  const operation = operationResult.data as { id: string; updated_at: string } | null;
  const latestEvent = eventResult.data as { id: string; occurred_at: string } | null;
  const latestOperatorAction = operatorActionResult.data as { id: string; occurred_at: string } | null;
  return [
    operation ? `${operation.id}:${operation.updated_at}` : "no-active-operations",
    latestEvent ? `${latestEvent.id}:${latestEvent.occurred_at}` : "no-operation-events",
    latestOperatorAction ? `${latestOperatorAction.id}:${latestOperatorAction.occurred_at}` : "no-operator-actions",
  ].join("|");
}

/**
 * A durable cursor for the dashboard event stream. It intentionally contains
 * no operational data: the notification tells the browser to reread the
 * dossier through the usual authenticated route.
 */
export async function getDashboardOperationRevision(
  reference: string,
  client: SupabaseClient = supabaseAdmin,
): Promise<string | null> {
  const operationResult = await client
    .from("operations")
    .select("id,updated_at")
    .eq("reference", reference)
    .maybeSingle();
  if (operationResult.error) throw operationResult.error;
  if (!operationResult.data) return null;

  const operation = operationResult.data as { id: string; updated_at: string };
  const [eventResult, callsResult] = await Promise.all([
    client
      .from("events")
      .select("id,occurred_at")
      .eq("operation_id", operation.id)
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    client
      .from("calls")
      .select("id,started_at,ended_at,outcome")
      .eq("operation_id", operation.id)
      .order("started_at", { ascending: false }),
  ]);
  if (eventResult.error) throw eventResult.error;
  if (callsResult.error) throw callsResult.error;

  const latestEvent = eventResult.data as { id: string; occurred_at: string } | null;
  const callRevision = (callsResult.data ?? [])
    .map((call) => {
      const typedCall = call as { id: string; started_at: string; ended_at: string | null; outcome: string };
      return `${typedCall.id}:${typedCall.started_at}:${typedCall.ended_at ?? "active"}:${typedCall.outcome}`;
    })
    .join(",");

  return [
    operation.updated_at,
    latestEvent ? `${latestEvent.id}:${latestEvent.occurred_at}` : "no-events",
    callRevision,
  ].join("|");
}

export async function getDashboardOperationDossier(
  reference: string,
  client: SupabaseClient = supabaseAdmin,
): Promise<DashboardOperationDossier | null> {
  const operationResult = await client
    .from("operations")
    .select(OPERATION_COLUMNS)
    .eq("reference", reference)
    .maybeSingle();
  if (operationResult.error) throw operationResult.error;
  if (!operationResult.data) return null;

  const operation = operationResult.data as unknown as OperationRow;
  const [operationView] = await toDashboardOperations([operation], client);
  if (!operationView) return null;

  const [mandateResult, requestsResult, bookingResult, commitmentsResult, selectionResult, escalationMap, operationCallsResult, eventsResult] = await Promise.all([
    operation.current_mandate_id
      ? client.from("mandates").select("id,version,price_cap,currency,action_windows,minimum_payment_term_days").eq("id", operation.current_mandate_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    client.from("quote_requests").select("id,provider_id").eq("operation_id", operation.id),
    client.from("bookings").select("id,quote_id,status,confirmed_price,pickup_window_start,pickup_window_end,confirmation_reference,created_at").eq("operation_id", operation.id).in("status", ["pending", "confirmed"]).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    client.from("commitments").select("id,type,terms,call_id,transcript_excerpt,recording_checkpoint,occurred_at,supersedes_commitment_id").eq("operation_id", operation.id).order("occurred_at", { ascending: false }),
    client.from("events").select("payload").eq("operation_id", operation.id).eq("type", "quote.selected").order("occurred_at", { ascending: false }).limit(1).maybeSingle(),
    activeEscalationsFor([operation.id], client),
    client.from("calls").select("id,contact_id,provider_id,direction,outcome,started_at,ended_at,recording_url,twilio_call_sid").eq("operation_id", operation.id).order("started_at", { ascending: true }),
    client.from("events").select("id,type,payload,call_id,commitment_id,recording_checkpoint,occurred_at").eq("operation_id", operation.id).order("occurred_at", { ascending: true }),
  ]);
  if (mandateResult.error) throw mandateResult.error;
  if (requestsResult.error) throw requestsResult.error;
  if (bookingResult.error) throw bookingResult.error;
  if (commitmentsResult.error) throw commitmentsResult.error;
  if (selectionResult.error) throw selectionResult.error;
  if (operationCallsResult.error) throw operationCallsResult.error;
  if (eventsResult.error) throw eventsResult.error;

  const requests = (requestsResult.data ?? []) as Array<{ id: string; provider_id: string }>;
  const quoteResult = requests.length > 0
    ? await client.from("quotes").select("id,quote_request_id,price_min,price_max,currency,verdict,status,valid_until").in("quote_request_id", requests.map((request) => request.id)).order("received_at", { ascending: false })
    : { data: [], error: null };
  if (quoteResult.error) throw quoteResult.error;

  const requestProvider = new Map(requests.map((request) => [request.id, request.provider_id]));
  const quotes = quoteResult.data as Array<{
    id: string; quote_request_id: string; price_min: number | string; price_max: number | string; currency: string;
    verdict: string; status: string; valid_until: string;
  }>;
  const commitments = (commitmentsResult.data ?? []) as Array<{
    id: string; type: string; terms: unknown; call_id: string; transcript_excerpt: string; recording_checkpoint: number | string;
    occurred_at: string; supersedes_commitment_id: string | null;
  }>;
  const booking = bookingResult.data as {
    id: string; quote_id: string; status: string; confirmed_price: number | string | null; pickup_window_start: string;
    pickup_window_end: string; confirmation_reference: string | null;
  } | null;
  const activeEscalation = escalationMap.get(operation.id) ?? null;
  const changeRequestResult = activeEscalation?.change_request_id
    ? await client.from("change_requests").select("requested_pickup_window").eq("id", activeEscalation.change_request_id).maybeSingle()
    : { data: null, error: null };
  if (changeRequestResult.error) throw changeRequestResult.error;

  const operationCalls = (operationCallsResult.data ?? []) as CallRow[];
  const calls = new Map(operationCalls.map((call) => [call.id, call]));
  const events = (eventsResult.data ?? []) as EventRow[];
  const names = await namesFor(
    [operation.contact_id, ...operationCalls.flatMap((call) => call.contact_id ? [call.contact_id] : [])],
    [...requests.map((request) => request.provider_id), ...operationCalls.flatMap((call) => call.provider_id ? [call.provider_id] : [])],
    client,
  );
  const mandate = mandateResult.data as {
    id: string; version: number; price_cap: number | string; currency: string; action_windows: unknown; minimum_payment_term_days: number;
  } | null;
  const mandateWindows = mandate ? readWindows(mandate.action_windows) : [];
  const selectionPayload = asRecord(selectionResult.data?.payload);
  const selectionReason = typeof selectionPayload.reason === "string"
    ? selectionPayload.reason
    : typeof selectionPayload.selection_reason === "string"
      ? selectionPayload.selection_reason
      : null;

  return {
    ...operationView,
    mandate: mandate ? {
      version: mandate.version,
      priceCap: asNumber(mandate.price_cap) ?? 0,
      currency: mandate.currency,
      paymentTermDays: mandate.minimum_payment_term_days,
      actionWindows: mandateWindows,
      constraints: operation.operational_constraints ?? [],
    } : null,
    booking: booking ? {
      reference: booking.confirmation_reference,
      providerName: (() => {
        const quote = quotes.find((item) => item.id === booking.quote_id);
        return quote ? names.providers.get(requestProvider.get(quote.quote_request_id) ?? "") ?? null : null;
      })(),
      confirmedPrice: asNumber(booking.confirmed_price),
      currency: quotes.find((item) => item.id === booking.quote_id)?.currency ?? null,
      pickupWindow: { startAt: booking.pickup_window_start, endAt: booking.pickup_window_end },
      status: booking.status,
    } : null,
    quotes: quotes.map((quote) => ({
      id: quote.id,
      providerName: names.providers.get(requestProvider.get(quote.quote_request_id) ?? "") ?? "Unknown provider",
      priceMin: asNumber(quote.price_min) ?? 0,
      priceMax: asNumber(quote.price_max) ?? 0,
      currency: quote.currency,
      verdict: quote.verdict,
      status: quote.status,
      validUntil: quote.valid_until,
      selected: quote.id === booking?.quote_id,
    })),
    selectionReason,
    activeEscalation: activeEscalation ? {
      id: activeEscalation.id,
      counterpartyName: counterpartyName(calls.get(activeEscalation.source_call_id), names),
      reason: activeEscalation.reason,
      requestedPickupWindow: readWindow(changeRequestResult.data?.requested_pickup_window),
      actionWindow: mandateWindows[0] ?? null,
      startedAt: activeEscalation.started_at,
    } : null,
    commitments: commitments.map((commitment) => {
      const call = calls.get(commitment.call_id);
      return {
        id: commitment.id,
        kind: commitment.type,
        occurredAt: commitment.occurred_at,
        title: commitmentTitle(commitment.type),
        summary: commitmentSummary(commitment.type, commitment.terms),
        call: {
          label: call?.twilio_call_sid ?? "Call reference unavailable",
          counterpartyName: counterpartyName(call, names),
          direction: call?.direction ?? "inbound",
        },
        transcriptExcerpt: commitment.transcript_excerpt,
        recordingCheckpoint: asNumber(commitment.recording_checkpoint) ?? 0,
        recordingUrl: call?.recording_url ?? null,
        supersedesCommitmentId: commitment.supersedes_commitment_id,
      };
    }),
    trace: toOperationTrace(operationCalls, events, names),
  };
}
