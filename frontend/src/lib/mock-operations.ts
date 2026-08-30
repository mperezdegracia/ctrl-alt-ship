export type OperationStatus =
  | "Sourcing"
  | "Quotes received"
  | "Booking pending"
  | "Booking confirmed"
  | "Needs follow-up";

export type Operation = {
  reference: string;
  client: string;
  container: string;
  containerType: string;
  weight: string;
  origin: string;
  destination: string;
  emptyReturn: string;
  status: OperationStatus;
  nextStep: string;
  updated: string;
  isEscalated?: boolean;
};

export type CommitmentKind = "Mandate" | "Quote selection" | "Booking" | "Reschedule" | "Escalation";

export type Commitment = {
  id: string;
  kind: CommitmentKind;
  occurredAt: string;
  timestamp: string;
  title: string;
  summary: string;
  call: {
    label: string;
    counterparty: string;
    direction: "Inbound" | "Outbound";
  };
  transcriptExcerpt: string;
  checkpoint: string;
  supersedes?: string;
  recording: {
    status: "ready" | "pending";
    url?: string;
  };
};

export type OperationDossier = Operation & {
  mandate: {
    version: string;
    priceCap: string;
    paymentTerm: string;
    actionWindow: string;
    constraints: string;
  };
  escalation: {
    counterparty: string;
    requested: string;
    authorized: string;
    startedAt: string;
  };
  booking: {
    reference: string;
    provider: string;
    confirmedPrice: string;
    pickup: string;
    previousPickup: string;
  };
  quotes: Array<{
    provider: string;
    price: string;
    verdict: string;
    selected?: boolean;
  }>;
  selectionReason: string;
  commitments: Commitment[];
};

export const operations: Operation[] = [
  {
    reference: "OP-900024",
    client: "Textiles del Plata",
    container: "MSKU 482019-6",
    containerType: "40' Dry",
    weight: "24,000 kg",
    origin: "Terminal 4, Buenos Aires",
    destination: "González Catán, Buenos Aires",
    emptyReturn: "Dock Sud empty depot",
    status: "Needs follow-up",
    nextStep: "Review live reschedule request",
    updated: "2 min ago",
    isEscalated: true,
  },
  {
    reference: "OP-900021",
    client: "Río Norte Imports",
    container: "TCLU 613804-2",
    containerType: "40' HC",
    weight: "21,600 kg",
    origin: "Exolgan Terminal",
    destination: "Pilar, Buenos Aires",
    emptyReturn: "Zárate empty depot",
    status: "Booking pending",
    nextStep: "Await provider confirmation",
    updated: "8 min ago",
  },
  {
    reference: "OP-900018",
    client: "Andes Paper Co.",
    container: "FSCU 721903-8",
    containerType: "20' Dry",
    weight: "16,400 kg",
    origin: "Terminal 4, Buenos Aires",
    destination: "Tigre, Buenos Aires",
    emptyReturn: "Dock Sud empty depot",
    status: "Quotes received",
    nextStep: "Select compliant quote",
    updated: "17 min ago",
  },
  {
    reference: "OP-900015",
    client: "Casa Brava",
    container: "OOLU 384205-1",
    containerType: "40' Dry",
    weight: "22,900 kg",
    origin: "TRP Terminal",
    destination: "San Martín, Buenos Aires",
    emptyReturn: "Avellaneda empty depot",
    status: "Sourcing",
    nextStep: "2 providers being contacted",
    updated: "24 min ago",
  },
  {
    reference: "OP-900011",
    client: "Litoral Foods",
    container: "CAIU 948201-7",
    containerType: "40' HC",
    weight: "19,750 kg",
    origin: "Terminal 4, Buenos Aires",
    destination: "Moreno, Buenos Aires",
    emptyReturn: "Dock Sud empty depot",
    status: "Booking confirmed",
    nextStep: "Pickup window opens at 14:00",
    updated: "32 min ago",
  },
  {
    reference: "OP-900008",
    client: "Pampero Home",
    container: "SEGU 105729-4",
    containerType: "20' Dry",
    weight: "12,200 kg",
    origin: "Exolgan Terminal",
    destination: "Quilmes, Buenos Aires",
    emptyReturn: "Zárate empty depot",
    status: "Sourcing",
    nextStep: "Quote request sent to 3 providers",
    updated: "41 min ago",
  },
];

const operationDossiers: Record<string, OperationDossier> = {
  "OP-900024": {
    ...operations[0],
    mandate: {
      version: "v3",
      priceCap: "ARS 950,000",
      paymentTerm: "30 days from invoice date",
      actionWindow: "Tue 02 Sep · 08:00–14:00",
      constraints: "Delivery appointment required · Non-hazardous cargo",
    },
    escalation: {
      counterparty: "Transporte Sur",
      requested: "Tue 02 Sep · 16:00–18:00",
      authorized: "Tue 02 Sep · 08:00–14:00",
      startedAt: "14:40 ART · 2 min ago",
    },
    booking: {
      reference: "BK-49218",
      provider: "Transporte Sur",
      confirmedPrice: "ARS 908,000",
      pickup: "Tue 02 Sep · 10:00–12:00",
      previousPickup: "Mon 01 Sep · 10:00–12:00",
    },
    quotes: [
      { provider: "Transporte Sur", price: "ARS 908,000", verdict: "Within mandate", selected: true },
      { provider: "Logística Ruta 3", price: "ARS 932,000", verdict: "Within mandate" },
      { provider: "Fletes del Plata", price: "—", verdict: "Request expired" },
    ],
    selectionReason: "Lowest complete quote still valid under Mandate v3; payment term and pickup conditions matched the operation.",
    commitments: [
      {
        id: "CMT-204",
        kind: "Escalation",
        occurredAt: "2026-09-02T14:40:00-03:00",
        timestamp: "14:40",
        title: "Escalation started",
        summary: "The provider requested a pickup outside the current Action Window.",
        call: { label: "CALL-0048", counterparty: "Transporte Sur", direction: "Inbound" },
        transcriptExcerpt: "“I can only move the truck to four this afternoon.” Tango verified that the requested window was outside the mandate and paused the change for supervisor review.",
        checkpoint: "08:14",
        recording: { status: "pending" },
      },
      {
        id: "CMT-203",
        kind: "Reschedule",
        occurredAt: "2026-09-02T12:04:00-03:00",
        timestamp: "12:04",
        title: "Pickup rescheduled",
        summary: "The pickup moved to Tue 02 Sep, 10:00–12:00 within the mandate.",
        call: { label: "CALL-0043", counterparty: "Transporte Sur", direction: "Inbound" },
        transcriptExcerpt: "“Tuesday between ten and noon works for us.” Tango repeated the new window, confirmed it remained authorised, and recorded the replacement commitment.",
        checkpoint: "06:32",
        supersedes: "CMT-202 · Booking confirmed",
        recording: { status: "pending" },
      },
      {
        id: "CMT-202",
        kind: "Booking",
        occurredAt: "2026-09-01T11:18:00-03:00",
        timestamp: "11:18",
        title: "Booking confirmed",
        summary: "Transporte Sur accepted the original Mon 01 Sep, 10:00–12:00 pickup.",
        call: { label: "CALL-0039", counterparty: "Transporte Sur", direction: "Outbound" },
        transcriptExcerpt: "“Yes, we confirm the pickup at ARS 908,000 for Monday morning.” The provider accepted the exact price and collection window selected by the server.",
        checkpoint: "05:42",
        recording: { status: "pending" },
      },
      {
        id: "CMT-201",
        kind: "Quote selection",
        occurredAt: "2026-09-01T10:54:00-03:00",
        timestamp: "10:54",
        title: "Quote selected",
        summary: "Transporte Sur was selected as the lowest valid provider response.",
        call: { label: "Server decision", counterparty: "Mandate v3", direction: "Outbound" },
        transcriptExcerpt: "The server compared the valid provider responses and selected Transporte Sur under the active mandate. No caller supplied or altered this decision.",
        checkpoint: "03:17",
        recording: { status: "pending" },
      },
      {
        id: "CMT-200",
        kind: "Mandate",
        occurredAt: "2026-09-01T10:12:00-03:00",
        timestamp: "10:12",
        title: "Mandate confirmed",
        summary: "The client confirmed price cap, payment term and Action Window.",
        call: { label: "CALL-0034", counterparty: "Carlos · Textiles del Plata", direction: "Inbound" },
        transcriptExcerpt: "“Confirmed: up to ARS 950,000, thirty days from invoice, and the Tuesday morning action window.” Tango recorded the mandate before contacting providers.",
        checkpoint: "01:08",
        recording: { status: "pending" },
      },
    ],
  },
};

export const escalatedOperation = operations[0];

// Planned API boundary. Keep mock data as the rendering source until Express exposes
// authenticated GET /api/dashboard/operations and /api/dashboard/operations/:reference.
export async function getOpenOperations(): Promise<Operation[]> {
  return operations;
}

export async function getOperation(reference: string): Promise<Operation | undefined> {
  return operations.find((operation) => operation.reference === reference);
}

export async function getOperationDossier(reference: string): Promise<OperationDossier | undefined> {
  return operationDossiers[reference];
}
