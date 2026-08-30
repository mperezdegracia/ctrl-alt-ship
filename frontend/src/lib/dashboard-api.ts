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

async function request<T>(path: string, accessToken: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });

  if (!response.ok) {
    const responseBody = await response.json().catch(() => null) as { error?: string } | null;
    throw new DashboardApiError(response.status, responseBody?.error ?? "The operations API could not complete this request.");
  }
  return response.json() as Promise<T>;
}

export async function getDashboardOperations(accessToken: string): Promise<DashboardOperation[]> {
  const result = await request<{ operations: DashboardOperation[] }>("/api/dashboard/operations", accessToken);
  return result.operations;
}

export async function getDashboardOperation(
  reference: string,
  accessToken: string,
): Promise<DashboardOperationDossier> {
  const result = await request<{ operation: DashboardOperationDossier }>(
    `/api/dashboard/operations/${encodeURIComponent(reference)}`,
    accessToken,
  );
  return result.operation;
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
