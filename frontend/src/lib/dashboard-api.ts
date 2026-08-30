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

export type DashboardPagination = {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
};

export type DashboardPage<T> = {
  items: T[];
  pagination: DashboardPagination;
};

export type DashboardHandoff = {
  id: string;
  operationReference: string;
  clientName: string;
  counterpartyName: string | null;
  reason: string;
  summary: string;
  requestedAction: string;
  handoffStatus: "pending" | "transfer_requested" | "transfer_failed" | "not_configured";
  handoffStatusDetail: string | null;
  recipient: { name: string; role: "supervisor" | "operator" } | null;
  status: "started" | "supervisor_joined";
  startedAt: string;
};

export type DashboardEscalation = DashboardHandoff & {
  operationStatus: string;
  trigger: string | null;
  status: "started" | "supervisor_joined" | "resolved" | "failed";
  resolvedAt: string | null;
};

export type DirectoryEntry = {
  id: string;
  kind: "contact" | "provider";
  name: string;
  phone: string;
  email: string | null;
  authorized: boolean | null;
  active: boolean;
  capabilities: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

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

export type SavedView = {
  id: string;
  scope: "operations" | "escalations";
  name: string;
  configuration: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
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
  } | null;
  quotes: Array<{
    id: string;
    providerName: string;
    priceMin: number;
    priceMax: number;
    currency: string;
    verdict: string;
    acceptedAboveBudget: boolean;
    status: string;
    validUntil: string | null;
    selected: boolean;
  }>;
  selectionReason: string | null;
  activeEscalation: {
    id: string;
    counterpartyName: string | null;
    reason: string;
    trigger: string | null;
    summary: string;
    requestedAction: string;
    handoffStatus: "pending" | "transfer_requested" | "transfer_failed" | "not_configured";
    handoffStatusDetail: string | null;
    recipient: { name: string; role: "supervisor" | "operator" } | null;
    requestedPickupWindow: DashboardWindow | null;
    actionWindow: DashboardWindow | null;
    startedAt: string;
    transcript: Array<{
      id: string;
      speaker: "caller" | "tango";
      content: string;
      recordedAt: string;
    }>;
  } | null;
  // The dashboard and API deploy independently. Keep this optional so an
  // already-deployed API can still render the durable dossier while it rolls
  // forward to the trace-capable response.
  trace?: {
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

export type DashboardCallEvidence = {
  reference: string; selectedCallId: string | null; matchWindowSeconds: number;
  calls: Array<{ id: string; counterpartyName: string; persona: string; direction: string;
    outcome: string; startedAt: string; endedAt: string | null }>;
  segments: Array<{ id: string; callId: string; speaker: "caller" | "tango"; content: string | null;
    recordedAt: string; contentDeletedAt: string | null }>;
  events: Array<{ id: string; callId: string | null; type: string; title: string; detail: string | null;
    occurredAt: string; match: { segmentId: string; offsetSeconds: number } | null }>;
};

export async function getDashboardCallEvidence(reference: string, accessToken: string, callId?: string): Promise<DashboardCallEvidence> {
  const result = await dashboardRequest<{ evidence: DashboardCallEvidence }>(
    `/api/dashboard/operations/${encodeURIComponent(reference)}/evidence${queryString({ call: callId })}`, accessToken,
  );
  return result.evidence;
}

export class DashboardApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function apiBaseUrl(): string {
  const value = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");
  if (!value) throw new DashboardApiError(500, "The operations API is not configured.");
  return value;
}

export async function dashboardRequest<T>(
  path: string,
  accessToken: string,
  options: { method?: "POST" | "PATCH" | "DELETE"; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
  });

  if (!response.ok) {
    const responseBody = await response.json().catch(() => null) as { error?: string } | null;
    throw new DashboardApiError(response.status, responseBody?.error ?? "The operations API could not complete this request.");
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function queryString(values: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

export async function getDashboardOperations(
  accessToken: string,
  options: { page?: number; perPage?: number; q?: string; status?: string; attention?: boolean } = {},
): Promise<DashboardPage<DashboardOperation>> {
  const result = await dashboardRequest<{ operations: DashboardOperation[]; pagination: DashboardPagination }>(
    `/api/dashboard/operations${queryString({ page: options.page, per_page: options.perPage, q: options.q, status: options.status, attention: options.attention })}`,
    accessToken,
  );
  return { items: result.operations, pagination: result.pagination };
}

export async function getDashboardOperation(
  reference: string,
  accessToken: string,
): Promise<DashboardOperationDossier> {
  const result = await dashboardRequest<{ operation: DashboardOperationDossier }>(
    `/api/dashboard/operations/${encodeURIComponent(reference)}`,
    accessToken,
  );
  return result.operation;
}

export async function getDashboardHandoffs(accessToken: string): Promise<DashboardHandoff[]> {
  const result = await dashboardRequest<{ handoffs: DashboardHandoff[] }>("/api/dashboard/handoffs", accessToken);
  return result.handoffs;
}

export async function getDashboardEscalations(
  accessToken: string,
  options: { page?: number; perPage?: number; q?: string; status?: string } = {},
): Promise<DashboardPage<DashboardEscalation>> {
  const result = await dashboardRequest<{ escalations: DashboardEscalation[]; pagination: DashboardPagination }>(
    `/api/dashboard/escalations${queryString({ page: options.page, per_page: options.perPage, q: options.q, status: options.status })}`,
    accessToken,
  );
  return { items: result.escalations, pagination: result.pagination };
}

export async function getDirectoryEntries(
  accessToken: string,
  kind: "contacts" | "providers",
  options: { page?: number; perPage?: number; q?: string; active?: boolean } = {},
): Promise<DashboardPage<DirectoryEntry>> {
  const result = await dashboardRequest<{ entries: DirectoryEntry[]; pagination: DashboardPagination }>(
    `/api/dashboard/directory/${kind}${queryString({ page: options.page, per_page: options.perPage, q: options.q, active: options.active })}`,
    accessToken,
  );
  return { items: result.entries, pagination: result.pagination };
}

export async function getHandoffRecipients(
  accessToken: string,
  options: { page?: number; perPage?: number; q?: string; active?: boolean } = {},
): Promise<DashboardPage<HandoffRecipient>> {
  const result = await dashboardRequest<{ recipients: HandoffRecipient[]; pagination: DashboardPagination }>(
    `/api/dashboard/handoff-recipients${queryString({ page: options.page, per_page: options.perPage, q: options.q, active: options.active })}`,
    accessToken,
  );
  return { items: result.recipients, pagination: result.pagination };
}

export async function getSavedViews(accessToken: string, scope: "operations" | "escalations"): Promise<SavedView[]> {
  const result = await dashboardRequest<{ views: SavedView[] }>(`/api/dashboard/saved-views${queryString({ scope })}`, accessToken);
  return result.views;
}

export function formatStatus(status: string): string {
  return status.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function formatMoney(value: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
}

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(value));
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function formatWindow(window: DashboardWindow | null): string {
  if (!window) return "Not recorded";
  const start = new Date(window.startAt);
  const end = new Date(window.endAt);
  const date = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short" }).format(start);
  const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${date} · ${time.format(start)}–${time.format(end)}`;
}
