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
  recording_url: string | null;
  twilio_call_sid: string;
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
  status: string;
  updatedAt: string;
  nextStep: string;
  escalation: {
    counterpartyName: string | null;
    reason: string;
    startedAt: string;
  } | null;
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
    .select("id,contact_id,provider_id,direction,recording_url,twilio_call_sid")
    .in("id", callIds);
  if (result.error) throw result.error;
  return new Map((result.data as CallRow[]).map((row) => [row.id, row]));
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
    .select("operation_id,change_request_id,source_call_id,reason,started_at")
    .in("operation_id", operationIds)
    .eq("status", "started")
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

  const [mandateResult, requestsResult, bookingResult, commitmentsResult, selectionResult, escalationMap] = await Promise.all([
    operation.current_mandate_id
      ? client.from("mandates").select("id,version,price_cap,currency,action_windows,minimum_payment_term_days").eq("id", operation.current_mandate_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    client.from("quote_requests").select("id,provider_id").eq("operation_id", operation.id),
    client.from("bookings").select("id,quote_id,status,confirmed_price,pickup_window_start,pickup_window_end,confirmation_reference,created_at").eq("operation_id", operation.id).in("status", ["pending", "confirmed"]).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    client.from("commitments").select("id,type,terms,call_id,transcript_excerpt,recording_checkpoint,occurred_at,supersedes_commitment_id").eq("operation_id", operation.id).order("occurred_at", { ascending: false }),
    client.from("events").select("payload").eq("operation_id", operation.id).eq("type", "quote.selected").order("occurred_at", { ascending: false }).limit(1).maybeSingle(),
    activeEscalationsFor([operation.id], client),
  ]);
  if (mandateResult.error) throw mandateResult.error;
  if (requestsResult.error) throw requestsResult.error;
  if (bookingResult.error) throw bookingResult.error;
  if (commitmentsResult.error) throw commitmentsResult.error;
  if (selectionResult.error) throw selectionResult.error;

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

  const calls = await callsFor([
    ...commitments.map((commitment) => commitment.call_id),
    ...(activeEscalation ? [activeEscalation.source_call_id] : []),
  ], client);
  const names = await namesFor(
    [operation.contact_id, ...[...calls.values()].flatMap((call) => call.contact_id ? [call.contact_id] : [])],
    [...requests.map((request) => request.provider_id), ...[...calls.values()].flatMap((call) => call.provider_id ? [call.provider_id] : [])],
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
  };
}
